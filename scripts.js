const { ipcRenderer } = require("electron");

const SESSIONS_KEY = "justtimer.sessions.v1";
const TASKS_KEY = "justtimer.tasks.v1";
const ACTIVE_SESSION_KEY = "justtimer.activeSession.v1";
const SESSION_TYPES_KEY = "justtimer.sessionTypes.v1";
const DEFAULT_DURATION_SECS = 50 * 60;

const SKY_PHASES = [
  { h: 0, colors: ["rgba(10,10,26,0.92)", "rgba(13,27,62,0.92)", "rgba(26,26,46,0.92)"] },
  { h: 5, colors: ["rgba(26,5,51,0.92)", "rgba(160,50,90,0.92)", "rgba(244,132,95,0.92)"] },
  { h: 7, colors: ["rgba(135,206,235,0.92)", "rgba(184,224,255,0.92)", "rgba(252,227,138,0.92)"] },
  { h: 12, colors: ["rgba(30,120,200,0.92)", "rgba(79,163,224,0.92)", "rgba(135,206,235,0.92)"] },
  { h: 17, colors: ["rgba(244,132,95,0.92)", "rgba(247,178,103,0.92)", "rgba(255,209,102,0.92)"] },
  { h: 20, colors: ["rgba(26,5,51,0.92)", "rgba(44,22,84,0.92)", "rgba(13,27,62,0.92)"] },
  { h: 24, colors: ["rgba(10,10,26,0.92)", "rgba(13,27,62,0.92)", "rgba(26,26,46,0.92)"] },
];

let durationSecs = DEFAULT_DURATION_SECS;
let startAt = null;
let endAt = null;
let timerRunning = false;
let waiting = false;
let timerJob = null;
let waitJob = null;
let selectedQuarter = null;
let activePendingSessionId = null;
let reviewEnergy = 5;
let breakActive = false;
let activeBreakStart = null;
let breakSegments = [];
let waitWarnPlayed = false;
let timerWarnPlayed = false;
const soundCache = new Map();

function $(id) {
  return document.getElementById(id);
}

function playSound(name) {
  try {
    if (!soundCache.has(name)) {
      soundCache.set(name, new Audio(`sonidos/${name}.wav`));
    }
    const audio = soundCache.get(name);
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } catch {
    // Audio should never interrupt the timer flow.
  }
}

function readSessions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSessions(sessions) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

function readTasks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TASKS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeTasks(tasks) {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
}

function readSessionTypes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_TYPES_KEY) || "null");
    return Array.isArray(parsed) && parsed.length ? parsed : ["trabajo", "estudio", "personal"];
  } catch {
    return ["trabajo", "estudio", "personal"];
  }
}

function writeSessionTypes(types) {
  const clean = [...new Set(types.map(type => type.trim()).filter(Boolean))];
  localStorage.setItem(SESSION_TYPES_KEY, JSON.stringify(clean.length ? clean : ["trabajo"]));
}

function writeActiveSession(value) {
  if (!value) {
    localStorage.removeItem(ACTIVE_SESSION_KEY);
    return;
  }
  localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(value));
}

function getElapsedSecs(now = Date.now()) {
  if (!startAt) return 0;
  return Math.max(0, Math.floor((now - startAt.getTime()) / 1000));
}

function closeOpenBreak(now = new Date()) {
  if (!breakActive || !activeBreakStart) return;
  breakSegments.push({
    startAt: activeBreakStart.toISOString(),
    endedAt: now.toISOString(),
    durationSecs: Math.max(0, Math.floor((now - activeBreakStart) / 1000)),
  });
  breakActive = false;
  activeBreakStart = null;
  document.body.classList.remove("break-mode");
  $("breakBtn")?.classList.remove("active");
}

function getBreakTotalSecs() {
  const closed = breakSegments.reduce((total, segment) => total + (Number(segment.durationSecs) || 0), 0);
  const open = breakActive && activeBreakStart ? Math.max(0, Math.floor((Date.now() - activeBreakStart) / 1000)) : 0;
  return closed + open;
}

function resetBreakState() {
  breakActive = false;
  activeBreakStart = null;
  breakSegments = [];
  document.body.classList.remove("break-mode");
  $("breakBtn")?.classList.remove("active");
}

function updateSession(id, patch) {
  const sessions = readSessions().map(session =>
    session.id === id ? { ...session, ...patch } : session
  );
  writeSessions(sessions);
}

function getCurrentHour() {
  const now = new Date();
  return now.getHours() + now.getMinutes() / 60;
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function lerpRgba(c1, c2, t) {
  const parse = value => value.match(/[\d.]+/g).map(Number);
  const [r1, g1, b1, a1] = parse(c1);
  const [r2, g2, b2, a2] = parse(c2);
  return `rgba(${lerp(r1, r2, t)},${lerp(g1, g2, t)},${lerp(b1, b2, t)},${a1 + (a2 - a1) * t})`;
}

function updateSkyGradient() {
  const h = getCurrentHour();
  let prev = SKY_PHASES[0];
  let next = SKY_PHASES.at(-1);

  for (let i = 0; i < SKY_PHASES.length - 1; i += 1) {
    if (h >= SKY_PHASES[i].h && h < SKY_PHASES[i + 1].h) {
      prev = SKY_PHASES[i];
      next = SKY_PHASES[i + 1];
      break;
    }
  }

  const t = (h - prev.h) / (next.h - prev.h);
  const [top, mid, bot] = [0, 1, 2].map(i => lerpRgba(prev.colors[i], next.colors[i], t));
  document.documentElement.style.setProperty("--sky-top", top);
  document.documentElement.style.setProperty("--sky-mid", mid);
  document.documentElement.style.setProperty("--sky-bot", bot);
}

function fmtHour(date) {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function fmtCountdown(secs) {
  const safeSecs = Math.max(0, Math.floor(secs));
  const h = Math.floor(safeSecs / 3600);
  const m = Math.floor((safeSecs % 3600) / 60);
  const s = safeSecs % 60;
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function nextQuarters(n = 6) {
  const now = new Date();
  const base = new Date(now);
  base.setSeconds(0, 0);
  // Start from the previous half-hour so user can see ~30min back
  const currentQuarter = Math.floor(now.getMinutes() / 15);
  const startQuarter = Math.max(0, currentQuarter - 1);
  base.setMinutes(startQuarter * 15);

  const results = [];
  for (let i = 0; i < n; i += 1) {
    results.push(new Date(base.getTime() + i * 15 * 60 * 1000));
  }
  return results;
}

function showError(msg) {
  const el = $("errorMsg");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 3000);
}

function clearError() {
  $("errorMsg").classList.add("hidden");
}

let _lastSentHeight = 0;
const DRAG_BAR_H = 28;

function sendHeight(force = false) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const activePanel = document.querySelector(".panel:not(.hidden)");
      if (!activePanel) return;
      const panelRect = activePanel.getBoundingClientRect();
      const style = getComputedStyle(activePanel);
      const paddingBottom = parseFloat(style.paddingBottom) || 0;
      const visibleChildren = [...activePanel.children].filter(child => !child.classList.contains("hidden"));
      const bottom = visibleChildren.reduce((max, child) => {
        const rect = child.getBoundingClientRect();
        return Math.max(max, rect.bottom - panelRect.top);
      }, 0);
      const total = Math.ceil(activePanel.offsetTop + bottom + paddingBottom);
      if (force || total !== _lastSentHeight) {
        _lastSentHeight = total;
        ipcRenderer.send("resize", total);
      }
    });
  });
}

function resizeWindow() {
  _lastSentHeight = 0;
  sendHeight(true);
  setTimeout(() => sendHeight(true), 80);
  setTimeout(() => sendHeight(true), 220);
}

function initResizeObserver() {
  const mo = new MutationObserver(() => {
    requestAnimationFrame(() => requestAnimationFrame(sendHeight));
  });
  mo.observe($("panelSetup"), {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });

  const ro = new ResizeObserver(() => {
    requestAnimationFrame(() => requestAnimationFrame(sendHeight));
  });
  ["panelSetup", "panelWait", "panelTimer", "panelReview"].forEach(id => ro.observe($(id)));
}

function showPanel(id) {
  ["panelSetup", "panelWait", "panelTimer", "panelReview"].forEach(panelId => {
    $(panelId).classList.toggle("hidden", panelId !== id);
  });
  resizeWindow();
}

function buildQuarterButtons() {
  const grid = $("quarterGrid");
  grid.innerHTML = "";
  const now = new Date();

  nextQuarters(7).forEach(time => {
    const btn = document.createElement("button");
    btn.className = "quarter-btn" + (time <= now ? " past" : "");
    btn.textContent = fmtHour(time);
    btn.addEventListener("click", () => selectQuarter(time, btn));
    grid.appendChild(btn);
  });

  // Add Planificar as the 8th slot in the grid
  const planBtn = document.createElement("button");
  planBtn.className = "quarter-btn planificar-inline-btn";
  planBtn.id = "planificarBtnGrid";
  planBtn.title = "Planificar sesión futura";
  planBtn.textContent = "＋";
  planBtn.addEventListener("click", () => ipcRenderer.send("open-calendar"));
  grid.appendChild(planBtn);
}

function selectQuarter(time, btn) {
  selectedQuarter = time;
  document.querySelectorAll(".quarter-btn").forEach(item => item.classList.remove("selected"));
  btn.classList.add("selected");
  clearError();
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function getPendingSessions() {
  const now = Date.now();
  return readSessions()
    .filter(session => session.status === "pending" && new Date(session.startAt).getTime() + session.durationSecs * 1000 > now)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
}

function updateSessionSummary() {
  const today = new Date();
  const pending = getPendingSessions();
  const todayCount = pending.filter(session => isSameDay(new Date(session.startAt), today)).length;
  $("sessionSummary").textContent = todayCount === 1
    ? "Tienes 1 sesion hoy"
    : todayCount > 1
      ? `Tienes ${todayCount} sesiones hoy`
      : "";

  renderNextSession(pending[0]);
  renderPendingSessions(pending);
  resizeWindow();
}

function renderNextSession(session) {
  const card = $("nextSessionCard");
  if (!session) {
    card.classList.add("hidden");
    $("nextCountdown").textContent = "--:--";
    return;
  }
  const start = new Date(session.startAt);
  const delta = (start - Date.now()) / 1000;
  card.classList.toggle("hidden", delta <= 0);
  $("nextCountdown").textContent = fmtCountdown(delta);
}

function renderPendingSessions(pending) {
  const list = $("pendingSessions");
  list.innerHTML = "";

  if (!pending.length) {
    list.classList.add("hidden");
    resizeWindow();
    return;
  }

  list.classList.remove("hidden");
  const title = document.createElement("div");
  title.className = "pending-title";
  title.textContent = "Sesiones pendientes";
  list.appendChild(title);

  pending.slice(0, 4).forEach(session => {
    const start = new Date(session.startAt);
    const row = document.createElement("div");
    row.className = "pending-row";
    row.innerHTML = `
      <span>${fmtHour(start)} · ${Math.round(session.durationSecs / 60)} min</span>
      <button type="button" data-id="${session.id}" title="Cancelar">&times;</button>
    `;
    list.appendChild(row);
  });
  resizeWindow();
}

function autoStartPendingSessions() {
  if (timerRunning || waiting) return;

  const due = getPendingSessions().find(session => new Date(session.startAt) <= new Date());
  if (!due) return;

  activePendingSessionId = due.id;
  updateSession(due.id, { status: "running" });
  durationSecs = due.durationSecs;
  startAt = new Date(due.startAt);
  schedule(startAt);
}

function startSelectedNow() {
  if (!durationSecs) {
    showError("Primero elegi la duracion");
    return;
  }
  schedule(selectedQuarter || new Date());
}

function createRunningSession(startDt) {
  const sessions = readSessions();
  const session = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    startAt: startDt.toISOString(),
    durationSecs,
    label: "",
    status: "running",
    tasks: [],
    notes: "",
    energy: null,
    breakSegments: [],
    breakTotalSecs: 0,
    createdAt: new Date().toISOString(),
  };
  sessions.push(session);
  writeSessions(sessions);
  activePendingSessionId = session.id;
}

function markSessionRunning() {
  if (!activePendingSessionId) return;
  writeActiveSession({
    sessionId: activePendingSessionId,
    startAt: startAt.toISOString(),
    durationSecs,
    breakSegments,
    breakActive,
    activeBreakStart: activeBreakStart ? activeBreakStart.toISOString() : null,
  });
  updateSession(activePendingSessionId, {
    status: "running",
    tasks: readTasks(),
    breakSegments,
    breakTotalSecs: getBreakTotalSecs(),
  });
}

function schedule(startDt) {
  if (!durationSecs) {
    showError("Primero elegi la duracion");
    return;
  }

  clearTimeout(waitJob);
  clearTimeout(timerJob);
  waitWarnPlayed = false;
  timerWarnPlayed = false;

  const now = new Date();
  endAt = new Date(startDt.getTime() + durationSecs * 1000);

  if (startDt <= now) {
    const elapsed = Math.max(0, (now - startDt) / 1000);
    if (elapsed >= durationSecs) {
      if (activePendingSessionId) updateSession(activePendingSessionId, { status: "done" });
      return;
    }
    startAt = startDt;
    startTimer(durationSecs - elapsed);
    return;
  }

  startAt = startDt;
  waiting = true;
  $("waitInfo").textContent = `${Math.round(durationSecs / 60)} min · ${fmtHour(startDt)}`;
  showPanel("panelWait");
  tickWait();
}

function tickWait() {
  if (!waiting) return;

  const delta = (startAt - new Date()) / 1000;
  if (delta <= 0) {
    waiting = false;
    startTimer(durationSecs);
    return;
  }

  const label = $("waitLabel");
  label.textContent = fmtCountdown(delta);
  label.style.color = delta <= 60 ? "#ff4444" : "white";
  if (delta <= 60 && !waitWarnPlayed) {
    waitWarnPlayed = true;
    playSound("sound_warn");
  }
  waitJob = setTimeout(tickWait, 1000);
}

function startTimer(remaining) {
  clearTimeout(timerJob);
  if (!activePendingSessionId) {
    resetBreakState();
    createRunningSession(startAt || new Date());
  }
  markSessionRunning();
  endAt = new Date(Date.now() + remaining * 1000);
  timerRunning = true;
  waiting = false;
  timerWarnPlayed = false;
  playSound("start");
  showPanel("panelTimer");
  tickTimer();
}

function tickTimer() {
  if (!timerRunning) return;

  const remaining = Math.max(0, (endAt - Date.now()) / 1000);
  $("timerLabel").textContent = fmtCountdown(remaining);
  $("timerLabel").style.color = remaining <= 60 ? "#ff4444" : "white";
  $("progressFill").style.width = `${((durationSecs - remaining) / durationSecs) * 100}%`;
  if (remaining <= 60 && !timerWarnPlayed) {
    timerWarnPlayed = true;
    playSound("sound_warn");
  }
  if (activePendingSessionId) {
    updateSession(activePendingSessionId, {
      breakSegments,
      breakTotalSecs: getBreakTotalSecs(),
      tasks: readTasks(),
    });
  }

  if (remaining <= 0) {
    timerRunning = false;
    $("timerLabel").textContent = "00:00";
    $("progressFill").style.width = "100%";
    playSound("end");
    openReviewPanel();
    return;
  }

  timerJob = setTimeout(tickTimer, 500);
}

function goToSetup() {
  timerRunning = false;
  waiting = false;
  activePendingSessionId = null;
  writeActiveSession(null);
  resetBreakState();
  clearTimeout(timerJob);
  clearTimeout(waitJob);
  buildQuarterButtons();
  updateSessionSummary();
  showPanel("panelSetup");
}

function energyLabel(value) {
  if (value <= 2) return "muy baja";
  if (value <= 4) return "baja";
  if (value <= 6) return "normal";
  if (value <= 8) return "alta";
  return "muy alta";
}

function setEnergy(value) {
  reviewEnergy = value;
  document.querySelectorAll(".energy-btn").forEach(btn => {
    btn.classList.toggle("selected", Number(btn.dataset.energy) === value);
  });
  $("energyReadout").textContent = `${value} / 10 - ${energyLabel(value)}`;
}

function buildEnergyButtons() {
  const row = $("energyRow");
  row.innerHTML = "";
  for (let value = 1; value <= 10; value += 1) {
    const btn = document.createElement("button");
    btn.className = "energy-btn";
    btn.dataset.energy = String(value);
    btn.textContent = String(value);
    btn.addEventListener("click", () => setEnergy(value));
    row.appendChild(btn);
  }
  setEnergy(reviewEnergy);
}

function openReviewPanel() {
  closeOpenBreak();
  renderSessionTypeSelect();
  renderReviewTasks();
  $("reviewNotes").value = "";
  reviewEnergy = 5;
  buildEnergyButtons();
  showPanel("panelReview");
}

function renderSessionTypeSelect(selected = "") {
  const select = $("reviewType");
  const types = readSessionTypes();
  select.innerHTML = "";
  types.forEach(type => {
    const option = document.createElement("option");
    option.value = type;
    option.textContent = type;
    select.appendChild(option);
  });
  select.value = selected && types.includes(selected) ? selected : types[0] || "trabajo";
}

function renderReviewTasks() {
  const list = $("reviewTaskList");
  const tasks = readTasks().filter(task => !task.deleted);
  list.innerHTML = "";

  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "review-task-row";
    empty.textContent = "Sin tareas para registrar";
    list.appendChild(empty);
    return;
  }

  tasks.forEach(task => {
    const row = document.createElement("label");
    row.className = "review-task-row";
    row.dataset.taskId = task.id;
    row.innerHTML = `
      <input type="checkbox" ${task.done ? "checked" : ""} />
      <span></span>
      <textarea class="review-task-note" rows="2" placeholder="nota de tarea"></textarea>
    `;
    row.querySelector("span").textContent = task.text;
    row.querySelector("textarea").value = task.notes || "";
    list.appendChild(row);
  });
}

function collectReviewTasks() {
  const rows = [...document.querySelectorAll(".review-task-row[data-task-id]")];
  if (!rows.length) return readTasks();
  const nowIso = new Date().toISOString();
  const elapsedSecs = Math.min(durationSecs, getElapsedSecs());
  const elapsedMin = Math.floor(elapsedSecs / 60);
  const byId = new Map(rows.map(row => [
    row.dataset.taskId,
    {
      done: row.querySelector("input").checked,
      notes: row.querySelector("textarea").value.trim(),
    },
  ]));

  return readTasks().map(task => {
    const update = byId.get(task.id);
    if (!update) return task;
    const changedToDone = update.done && !task.done;
    const next = {
      ...task,
      done: update.done,
      notes: update.notes,
    };
    if (changedToDone) {
      next.completedAt = nowIso;
      next.completedPostSession = true;
      next.completionElapsedSecs = elapsedSecs;
      next.completionElapsedMin = elapsedMin;
      next.completionRemainingSecs = 0;
      next.completionRemainingMin = 0;
    }
    if (!update.done) {
      delete next.completedPostSession;
    }
    return next;
  });
}

function finishSession({ skip = false } = {}) {
  closeOpenBreak();
  const reviewedTasks = skip ? readTasks() : collectReviewTasks();
  if (activePendingSessionId) {
    updateSession(activePendingSessionId, {
      status: "done",
      completedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      label: skip ? "" : $("reviewType").value,
      notes: skip ? "" : $("reviewNotes").value.trim(),
      energy: skip ? null : reviewEnergy,
      tasks: reviewedTasks,
      breakSegments,
      breakTotalSecs: getBreakTotalSecs(),
    });
  }
  activePendingSessionId = null;
  writeActiveSession(null);
  writeTasks([]);
  resetBreakState();
  buildQuarterButtons();
  updateSessionSummary();
  ipcRenderer.send("session-created");
  showPanel("panelSetup");
}

document.querySelectorAll(".dur-btn[data-mins]").forEach(btn => {
  btn.addEventListener("click", () => {
    durationSecs = parseInt(btn.dataset.mins, 10) * 60;
    document.querySelectorAll(".dur-btn").forEach(item => item.classList.remove("selected"));
    btn.classList.add("selected");
    clearError();
    $("customDurRow").classList.add("hidden");
  });
});

$("customDurBtn").addEventListener("click", () => {
  $("customDurRow").classList.toggle("hidden");
  if (!$("customDurRow").classList.contains("hidden")) $("customDurInput").focus();
});

function applyCustomDur() {
  const val = parseInt($("customDurInput").value, 10);
  if (!val || val <= 0) return;
  durationSecs = val * 60;
  document.querySelectorAll(".dur-btn").forEach(btn => btn.classList.remove("selected"));
  $("customDurRow").classList.add("hidden");
  $("customDurInput").value = "";
  clearError();
}

$("customDurOk").addEventListener("click", applyCustomDur);
$("customDurInput").addEventListener("keydown", event => {
  if (event.key === "Enter") applyCustomDur();
});

$("startNowBtn").addEventListener("click", startSelectedNow);

$("waitCancelBtn").addEventListener("click", () => {
  waiting = false;
  clearTimeout(waitJob);
  buildQuarterButtons();
  showPanel("panelSetup");
});

function toggleBreak() {
  if (!timerRunning) return;
  if (breakActive) {
    closeOpenBreak();
  } else {
    breakActive = true;
    activeBreakStart = new Date();
    document.body.classList.add("break-mode");
    $("breakBtn").classList.add("active");
  }
  markSessionRunning();
}

function cancelRunningSessionToHome() {
  if (!timerRunning && !waiting) {
    goToSetup();
    return;
  }
  if (!window.confirm("Cancelar sesion?")) return;

  const now = new Date();
  const elapsedSecs = timerRunning ? Math.max(1, Math.min(durationSecs, getElapsedSecs(now.getTime()))) : 0;
  closeOpenBreak(now);
  clearTimeout(timerJob);
  clearTimeout(waitJob);

  if (activePendingSessionId) {
    updateSession(activePendingSessionId, {
      status: "done",
      completedAt: now.toISOString(),
      endedAt: now.toISOString(),
      durationSecs: elapsedSecs,
      tasks: readTasks(),
      breakSegments,
      breakTotalSecs: getBreakTotalSecs(),
      cancelledEarly: true,
      originalDurationSecs: durationSecs,
    });
    ipcRenderer.send("session-created");
  }

  timerRunning = false;
  waiting = false;
  activePendingSessionId = null;
  writeActiveSession(null);
  writeTasks([]);
  resetBreakState();
  buildQuarterButtons();
  updateSessionSummary();
  showPanel("panelSetup");
}

$("breakBtn").addEventListener("click", toggleBreak);
$("homeBtn").addEventListener("click", cancelRunningSessionToHome);
$("saveReviewBtn").addEventListener("click", () => finishSession());
$("skipReviewBtn").addEventListener("click", () => finishSession({ skip: true }));
$("addTypeBtn").addEventListener("click", () => {
  $("customTypeRow").classList.toggle("hidden");
  if (!$("customTypeRow").classList.contains("hidden")) $("customTypeInput").focus();
});
$("saveTypeBtn").addEventListener("click", () => {
  const value = $("customTypeInput").value.trim();
  if (!value) return;
  writeSessionTypes([...readSessionTypes(), value]);
  $("customTypeInput").value = "";
  $("customTypeRow").classList.add("hidden");
  renderSessionTypeSelect(value);
});
$("customTypeInput").addEventListener("keydown", event => {
  if (event.key === "Enter") $("saveTypeBtn").click();
});
$("deleteTypeBtn").addEventListener("click", () => {
  const current = $("reviewType").value;
  const next = readSessionTypes().filter(type => type !== current);
  writeSessionTypes(next);
  renderSessionTypeSelect(next[0]);
});

function openCalendar() {
  ipcRenderer.send("open-calendar");
}

function openTasks() {
  ipcRenderer.send("open-tasks");
}

function openHabits() {
  ipcRenderer.send("open-habits");
}

$("calBtn").addEventListener("click", openCalendar);
$("tasksSetupBtn").addEventListener("click", openTasks);
$("habitsBtn").addEventListener("click", openHabits);
$("calTimerBtn").addEventListener("click", openCalendar);
$("tasksTimerBtn").addEventListener("click", openTasks);

$("pendingSessions").addEventListener("click", event => {
  const button = event.target.closest("button[data-id]");
  if (!button) return;
  updateSession(button.dataset.id, { status: "cancelled" });
  updateSessionSummary();
  resizeWindow();
});

$("closeBtn").addEventListener("click", () => ipcRenderer.send("close-app"));

ipcRenderer.on("sessions-updated", updateSessionSummary);
window.addEventListener("focus", updateSessionSummary);

updateSkyGradient();
setInterval(updateSkyGradient, 60_000);
setInterval(() => {
  updateSessionSummary();
  autoStartPendingSessions();
}, 1000);

buildQuarterButtons();
document.querySelector('.dur-btn[data-mins="50"]')?.classList.add("selected");
updateSessionSummary();
showPanel("panelSetup");
initResizeObserver();
