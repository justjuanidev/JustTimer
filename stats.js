const { ipcRenderer } = require("electron");

const SESSIONS_KEY = "justtimer.sessions.v1";
const PROJECTS_KEY = "justtimer.projects.v1";
const WORK_CHANNELS_KEY = "justtimer.workChannels.v1";
let currentPeriod = "week";

function $(id) { return document.getElementById(id); }

function readSessions() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function readProjects() {
  try { const value = JSON.parse(localStorage.getItem(PROJECTS_KEY) || "[]"); return Array.isArray(value) ? value : []; } catch { return []; }
}

function readWorkChannels() {
  let channels = [];
  try { const value = JSON.parse(localStorage.getItem(WORK_CHANNELS_KEY) || "[]"); channels = Array.isArray(value) ? value : []; } catch {}
  [{ id: "personal", name: "JustJuani" }, { id: "work", name: "Laburo" }, { id: "routine", name: "Personal", hiddenFromVideos: true }].forEach(item => { if (!channels.some(channel => channel.id === item.id)) channels.push(item); });
  return channels;
}

function sessionChannelId(session) {
  if (session.workArea) return session.workArea;
  const project = readProjects().find(item => item.id === session.projectId);
  return project?.workChannelId || project?.mode || "personal";
}

function completedSessions() {
  return readSessions().filter(session => {
    const start = new Date(session.startAt);
    return session.status === "done" && sessionChannelId(session) !== "routine" && session.workAreaName !== "Personal" && !Number.isNaN(start.getTime());
  }).sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
}

function startOfDay(date = new Date()) {
  const copy = new Date(date); copy.setHours(0, 0, 0, 0); return copy;
}

function startOfWeek(date = new Date()) {
  const copy = startOfDay(date); copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7)); return copy;
}

function startOfMonth(date = new Date()) { return new Date(date.getFullYear(), date.getMonth(), 1); }
function startOfYear(date = new Date()) { return new Date(date.getFullYear(), 0, 1); }
function isSameDate(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function pad(value) { return String(value).padStart(2, "0"); }
function durationHours(session) { return Math.max(0, Number(session.durationSecs) || 0) / 3600; }
function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }

function periodStart(period, now = new Date()) {
  if (period === "day") return startOfDay(now);
  if (period === "week") return startOfWeek(now);
  if (period === "month") return startOfMonth(now);
  if (period === "year") return startOfYear(now);
  return null;
}

function sessionsForPeriod(period) {
  const start = periodStart(period);
  return completedSessions().filter(session => !start || new Date(session.startAt) >= start);
}

function rangeLabel(period) {
  const now = new Date();
  const dateOptions = { day: "2-digit", month: "short" };
  if (period === "day") return `Hoy · ${now.toLocaleDateString("es-AR", { ...dateOptions, year: "numeric" })}`;
  if (period === "week") {
    const first = startOfWeek(now), last = new Date(first); last.setDate(last.getDate() + 6);
    return `${first.toLocaleDateString("es-AR", dateOptions)} – ${last.toLocaleDateString("es-AR", { ...dateOptions, year: "numeric" })}`;
  }
  if (period === "month") return now.toLocaleDateString("es-AR", { month: "long", year: "numeric" });
  if (period === "year") return String(now.getFullYear());
  return "Todas las sesiones terminadas";
}

function bucketConfig(period) {
  const now = new Date();
  if (period === "day") return Array.from({ length: 24 }, (_, hour) => ({ key: String(hour), label: `${pad(hour)}h`, start: new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour) }));
  if (period === "week") {
    const first = startOfWeek(now);
    return Array.from({ length: 7 }, (_, index) => { const date = new Date(first); date.setDate(date.getDate() + index); return { key: date.toDateString(), label: date.toLocaleDateString("es-AR", { weekday: "short" }).replace(".", ""), start: date }; });
  }
  if (period === "month") {
    const first = startOfMonth(now), total = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return Array.from({ length: total }, (_, index) => { const date = new Date(first); date.setDate(index + 1); return { key: date.toDateString(), label: String(index + 1), start: date }; });
  }
  const count = period === "year" ? 12 : 12;
  const first = new Date(now.getFullYear(), now.getMonth() - count + 1, 1);
  return Array.from({ length: count }, (_, index) => { const date = new Date(first.getFullYear(), first.getMonth() + index, 1); return { key: `${date.getFullYear()}-${date.getMonth()}`, label: date.toLocaleDateString("es-AR", { month: "short" }).replace(".", ""), start: date }; });
}

function bucketKey(date, period) {
  if (period === "day") return String(date.getHours());
  if (["week", "month"].includes(period)) return date.toDateString();
  return `${date.getFullYear()}-${date.getMonth()}`;
}

function makeSeries(sessions, period) {
  const items = bucketConfig(period).map(bucket => ({ ...bucket, sessions: 0, hours: 0, energy: [], durations: [0, 0, 0] }));
  const byKey = new Map(items.map(item => [item.key, item]));
  sessions.forEach(session => {
    const item = byKey.get(bucketKey(new Date(session.startAt), period));
    if (!item) return;
    item.sessions += 1; item.hours += durationHours(session);
    const minutes = (Number(session.durationSecs) || 0) / 60;
    item.durations[minutes <= 37 ? 0 : minutes <= 62 ? 1 : 2] += 1;
    if (Number(session.energy) >= 1 && Number(session.energy) <= 10) item.energy.push(Number(session.energy));
  });
  return items;
}

function svgShell(content, width = 720, height = 225) {
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Gráfico">${content}</svg>`;
}

function renderVolumeChart(series) {
  const width = 720, height = 225, left = 34, right = 12, top = 18, bottom = 37, chartH = height - top - bottom, chartW = width - left - right;
  const max = Math.max(1, ...series.map(item => item.sessions));
  const step = chartW / series.length;
  let marks = "";
  for (let line = 0; line <= 4; line += 1) { const y = top + chartH * (line / 4); marks += `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" class="chart-gridline"/>`; }
  const bars = series.map((item, index) => {
    const x = left + index * step + step * .2, barW = Math.max(3, step * .6);
    const label = (series.length <= 12 || index % Math.ceil(series.length / 12) === 0) ? `<text x="${left + index * step + step / 2}" y="${height - 13}" class="chart-label">${item.label}</text>` : "";
    let y = top + chartH;
    const stacks = item.durations.map((count, durationIndex) => { const h = count / max * chartH; y -= h; return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="2" class="chart-duration-${durationIndex}"><title>${item.label}: ${count} sesiones</title></rect>`; }).join("");
    const total = item.sessions ? `<text x="${x + barW / 2}" y="${Math.max(12, y - 5)}" class="chart-count">${item.sessions}</text>` : "";
    return `${stacks}${total}${label}`;
  }).join("");
  $("volumeChart").innerHTML = `<div class="chart-legend"><span><i class="legend-25"></i>25 min</span><span><i class="legend-50"></i>50 min</span><span><i class="legend-75"></i>75+ min</span></div>${svgShell(marks + bars, width, height)}`;
}

function renderHourChart(sessions) {
  const counts = Array.from({ length: 24 }, () => 0); sessions.forEach(session => counts[new Date(session.startAt).getHours()] += 1);
  const max = Math.max(1, ...counts), width = 440, height = 225, left = 20, right = 8, top = 18, bottom = 36, chartH = height - top - bottom, step = (width - left - right) / 24;
  const bars = counts.map((count, hour) => {
    const barH = count / max * chartH, x = left + hour * step + 1;
    const label = hour % 3 === 0 ? `<text x="${x + step / 2}" y="${height - 13}" class="chart-label">${pad(hour)}</text>` : "";
    return `<rect x="${x}" y="${top + chartH - barH}" width="${Math.max(2, step - 3)}" height="${barH}" rx="2" class="chart-bar-hours"><title>${pad(hour)}:00 · ${count} sesiones</title></rect>${label}`;
  }).join("");
  $("hourChart").innerHTML = svgShell(`<line x1="${left}" y1="${top + chartH}" x2="${width - right}" y2="${top + chartH}" class="chart-gridline"/>${bars}`, width, height);
}

function renderEnergyChart(sessions) {
  const counts = Array.from({ length: 10 }, () => 0);
  sessions.forEach(session => { const energy = Math.round(Number(session.energy)); if (energy >= 1 && energy <= 10) counts[energy - 1] += 1; });
  const width = 720, height = 225, left = 34, right = 12, top = 20, bottom = 35, chartH = height - top - bottom, step = (width - left - right) / 10, max = Math.max(1, ...counts);
  let grid = ""; for (let line = 0; line <= 4; line += 1) { const y = top + chartH * line / 4; grid += `<line x1="${left}" y1="${y}" x2="${width-right}" y2="${y}" class="chart-gridline"/>`; }
  const bars = counts.map((count, index) => { const h = count / max * chartH, x = left + index * step + step * .18; return `<rect x="${x}" y="${top + chartH - h}" width="${step * .64}" height="${h}" rx="4" class="energy-count-bar"><title>Energía ${index + 1}: ${count} sesiones</title></rect>${count ? `<text x="${x + step * .32}" y="${top + chartH - h - 5}" class="chart-count">${count}</text>` : ""}<text x="${x + step * .32}" y="${height - 12}" class="chart-label">${index + 1}</text>`; }).join("");
  $("energyChart").innerHTML = svgShell(grid + bars, width, height);
}

function renderKpis(sessions) {
  const hours = sessions.reduce((sum, session) => sum + durationHours(session), 0);
  const energy = average(sessions.map(session => Number(session.energy)).filter(value => value >= 1 && value <= 10));
  const avgDuration = sessions.length ? hours * 60 / sessions.length : 0;
  const cards = [["Sesiones", sessions.length], ["Horas enfocadas", hours.toFixed(1)], ["Duración media", `${Math.round(avgDuration)} min`], ["Energía media", energy ? `${energy.toFixed(1)} / 10` : "Sin datos"]];
  $("kpiGrid").innerHTML = cards.map(([label, value]) => `<article class="stats-kpi"><span>${label}</span><strong>${value}</strong></article>`).join("");
}

function renderEnergyScales() {
  const options = [["Día", "day"], ["Semana", "week"], ["Mes", "month"], ["Año", "year"]];
  $("energyScaleGrid").innerHTML = options.map(([label, period]) => {
    const values = sessionsForPeriod(period).map(session => Number(session.energy)).filter(value => value >= 1 && value <= 10);
    const value = average(values);
    return `<div class="energy-scale"><span>${label}</span><strong>${value === null ? "—" : `${value.toFixed(1)} / 10`}</strong><small>${values.length ? `${values.length} sesiones con energía` : "sin registros"}</small></div>`;
  }).join("");
}

function renderTags() {
  const groups = new Map();
  completedSessions().forEach(session => {
    const label = String(session.label || "Sin etiqueta").trim() || "Sin etiqueta";
    const group = groups.get(label) || { label, count: 0, hours: 0 };
    group.count += 1; group.hours += durationHours(session); groups.set(label, group);
  });
  const items = [...groups.values()].sort((a, b) => b.hours - a.hours);
  const max = Math.max(1, ...items.map(item => item.hours));
  $("tagList").innerHTML = items.length ? items.map(item => `<div class="tag-row"><div class="tag-row-heading"><strong>${escapeHtml(item.label)}</strong><span>${item.count} sesiones · ${item.hours.toFixed(1)} h</span></div><div class="tag-track"><i style="width:${item.hours / max * 100}%"></i></div></div>`).join("") : `<div class="chart-empty">Todavía no hay sesiones terminadas.</div>`;
}

function renderProjectStats() {
  const projectMap = new Map(readProjects().map(project => [project.id, project]));
  const groups = new Map();
  completedSessions().forEach(session => {
    const project = projectMap.get(session.projectId);
    const area = session.workArea || project?.workChannelId || project?.mode || "personal";
    const areaLabel = readWorkChannels().find(channel => channel.id === area)?.name || (area === "work" ? "Laburo" : "JustJuani");
    const videoLabel = project?.title || session.projectName || "General del canal";
    const key = session.projectId || `${area}:general`;
    const label = `${areaLabel} · ${videoLabel}`;
    const item = groups.get(key) || { label, sessions: 0, hours: 0 };
    item.sessions += 1; item.hours += durationHours(session); groups.set(key, item);
  });
  const items = [...groups.values()].sort((a, b) => b.hours - a.hours), max = Math.max(1, ...items.map(item => item.hours));
  $("projectStatsList").innerHTML = items.length ? items.map(item => `<div class="tag-row"><div class="tag-row-heading"><strong>${escapeHtml(item.label)}</strong><span>${item.sessions} sesiones · ${item.hours.toFixed(1)} h</span></div><div class="tag-track project-stat-track"><i style="width:${item.hours / max * 100}%"></i></div></div>`).join("") : `<div class="chart-empty">Aún no hay sesiones registradas.</div>`;
}

function escapeHtml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }

function renderStats() {
  const sessions = sessionsForPeriod(currentPeriod), series = makeSeries(sessions, currentPeriod);
  $("rangeLabel").textContent = rangeLabel(currentPeriod);
  renderKpis(sessions); renderVolumeChart(series); renderHourChart(sessions); renderEnergyChart(sessions); renderEnergyScales(); renderProjectStats();
}

function showToast(message) { const toast = $("statsToast"); toast.textContent = message; toast.classList.remove("hidden"); setTimeout(() => toast.classList.add("hidden"), 3200); }

function exportAnalytics() {
  const all = completedSessions();
  const payload = {
    format: "justtimer-analytics",
    version: 1,
    description: "Datos de sesiones de JustTimer en JSON legible para personas e IA. Las duraciones están expresadas en segundos y las fechas en ISO 8601.",
    exportedAt: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    summary: { completedSessions: all.length, totalFocusHours: Number(all.reduce((sum, session) => sum + durationHours(session), 0).toFixed(2)), averageEnergy: average(all.map(session => Number(session.energy)).filter(value => value >= 1 && value <= 10)) },
    sessions: all.map(session => ({ id: session.id, startedAt: session.startAt, endedAt: session.endedAt || null, completedAt: session.completedAt || null, durationSeconds: Number(session.durationSecs) || 0, label: session.label || null, workArea: session.workArea || null, workAreaName: session.workAreaName || null, projectId: session.projectId || null, projectName: session.projectName || null, energy: Number(session.energy) || null, notes: session.notes || null, breakSeconds: Number(session.breakTotalSecs) || 0, cancelledEarly: Boolean(session.cancelledEarly), tasks: Array.isArray(session.tasks) ? session.tasks.map(task => ({ text: task.text || "", completed: Boolean(task.done), notes: task.notes || null })) : [] })),
  };
  ipcRenderer.invoke("export-analytics", payload).then(result => { if (result?.saved) showToast("Analítica exportada como JSON."); }).catch(() => showToast("No se pudo exportar el archivo."));
}

document.querySelectorAll(".period-btn").forEach(button => button.addEventListener("click", () => { currentPeriod = button.dataset.period; document.querySelectorAll(".period-btn").forEach(item => item.classList.toggle("active", item === button)); renderStats(); }));
$("exportBtn").addEventListener("click", exportAnalytics);
$("closeBtn").addEventListener("click", () => ipcRenderer.send("close-current-window"));
ipcRenderer.on("sessions-updated", renderStats);
window.addEventListener("focus", renderStats);
renderStats();
