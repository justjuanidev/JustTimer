const http = require("http");
const crypto = require("crypto");
const { shell } = require("electron");

const SCOPES = "https://www.googleapis.com/auth/calendar.readonly";

function base64url(buffer) {
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error_description || body.error?.message || `Google respondio ${response.status}`);
  return body;
}

class GoogleCalendar {
  constructor(filePath, onChanged) {
    this.filePath = filePath;
    this.onChanged = onChanged;
    this.state = {};
    try { this.state = JSON.parse(require("fs").readFileSync(filePath, "utf8")); } catch {}
  }

  save() {
    require("fs").mkdirSync(require("path").dirname(this.filePath), { recursive: true });
    require("fs").writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  status() {
    return { configured: Boolean(this.state.clientId && this.state.clientSecret), connected: Boolean(this.state.refreshToken), email: this.state.email || "" };
  }

  configure(credentials = {}) {
    const clientId = String(credentials.clientId || "").trim();
    const clientSecret = String(credentials.clientSecret || "").trim();
    if (!clientId.endsWith(".apps.googleusercontent.com")) throw new Error("El Client ID de Google no es valido");
    if (!clientSecret) throw new Error("Falta el Client secret de Google");
    if (clientId !== this.state.clientId || clientSecret !== this.state.clientSecret) this.state = { clientId, clientSecret };
    this.save();
    return this.status();
  }

  async connect() {
    if (!this.state.clientId || !this.state.clientSecret) throw new Error("Primero guarda el Client ID y el Client secret de Google");
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
    const authResult = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (!url.searchParams.get("code")) return;
        const port = server.address().port;
        res.end("JustTimer ya esta conectado. Podes cerrar esta pestana.");
        server.close();
        resolve({ code: url.searchParams.get("code"), redirectUri: `http://127.0.0.1:${port}` });
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const redirectUri = `http://127.0.0.1:${server.address().port}`;
        const params = new URLSearchParams({ client_id: this.state.clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPES, access_type: "offline", prompt: "consent", code_challenge: challenge, code_challenge_method: "S256" });
        shell.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${params}`).catch(reject);
      });
      setTimeout(() => { server.close(); reject(new Error("Se agoto el tiempo para conectar Google")); }, 180000).unref();
    });
    const token = await requestJson("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.state.clientId, client_secret: this.state.clientSecret, code: authResult.code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: authResult.redirectUri }) });
    this.state.refreshToken = token.refresh_token;
    this.state.accessToken = token.access_token;
    this.state.expiresAt = Date.now() + token.expires_in * 1000;
    this.save();
    return this.status();
  }

  async accessToken() {
    if (this.state.accessToken && this.state.expiresAt > Date.now() + 60000) return this.state.accessToken;
    if (!this.state.refreshToken) throw new Error("Google Calendar no esta conectado");
    const token = await requestJson("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.state.clientId, client_secret: this.state.clientSecret, refresh_token: this.state.refreshToken, grant_type: "refresh_token" }) });
    this.state.accessToken = token.access_token;
    this.state.expiresAt = Date.now() + token.expires_in * 1000;
    this.save();
    return token.access_token;
  }

  async events(timeMin, timeMax) {
    const token = await this.accessToken();
    const headers = { authorization: `Bearer ${token}` };
    const calendarList = await requestJson("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250", { headers });
    const focusmateCalendars = (calendarList.items || []).filter(calendar => /focusmate/i.test(`${calendar.summary || ""} ${calendar.summaryOverride || ""}`));
    const targets = focusmateCalendars.length ? focusmateCalendars : [{ id: "primary", summary: "Principal", filterEvents: true }];
    const params = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "2500" });
    const groups = await Promise.all(targets.map(async calendar => {
      const data = await requestJson(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events?${params}`, { headers });
      return (data.items || [])
        .filter(event => event.status !== "cancelled" && (!calendar.filterEvents || /focusmate/i.test(`${event.summary || ""} ${event.description || ""}`)))
        .map(event => ({ id: `${calendar.id}:${event.id}`, googleCalendarId: calendar.id, calendarName: calendar.summary || "Focusmate", title: event.summary || "Focusmate", startAt: event.start?.dateTime, endAt: event.end?.dateTime, htmlLink: event.htmlLink }))
        .filter(event => event.startAt && event.endAt);
    }));
    return groups.flat();
  }

  disconnect() { this.state = { clientId: this.state.clientId, clientSecret: this.state.clientSecret }; this.save(); return this.status(); }
}

module.exports = GoogleCalendar;
