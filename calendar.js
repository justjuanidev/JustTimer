const { ipcRenderer } = require("electron");

const SESSIONS_KEY = "justtimer.sessions.v1";
const DAY_TASKS_KEY = "justtimer.dayTasks.v1";
const PROJECTS_KEY = "justtimer.projects.v1";
const WORK_CHANNELS_KEY = "justtimer.workChannels.v1";
const PROJECT_CHANNELS_KEY = "justtimer.projectChannels.v1";
const DAYS = ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"];
const SLOT_HEIGHT = 28;
const GOOGLE_SYNC_KEY = "justtimer.googleCalendarSync.v1";
const CHANNEL_GOALS_KEY = "justtimer.channelGoals.v1";
const OPEN_PROJECT_KEY = "justtimer.openProjectId.v1";

let weekStart = startOfWeek(new Date());
let selectedStart = null;
let selectedSessionId = null;
let selectedHistoryDay = null; // "YYYY-MM-DD" of the day whose task history is shown
let visibleDays = 7;
let didAutoScroll = false;
let registerMode = false;
let taskPlannerOpen = false;
let editingGoalChannelId = null;
const expandedPlannerTaskIds = new Set();

function $(id) {
  return document.getElementById(id);
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

function readChannelGoals() {
  try { const value = JSON.parse(localStorage.getItem(CHANNEL_GOALS_KEY) || "{}"); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}

function goalAvatar(channel) {
  return channel.avatarUrl ? `<img src="${escapeAttr(channel.avatarUrl)}" alt="" />` : `<span>${channel.id === "routine" ? "J" : escapeHtml((channel.name || "J").slice(0, 1).toUpperCase())}</span>`;
}

function statsInRange(channelId, start, end, allSessions = readSessions(), projectMap = null) {
  const sessions = allSessions.filter(session => {
    const area = session.workArea || projectWorkChannel(projectMap?.get(session.projectId));
    return session.status === "done" && area === channelId && new Date(session.startAt) >= start && new Date(session.startAt) < end;
  });
  return { sessions: sessions.length, minutes: sessions.reduce((sum, session) => sum + Math.round((Number(session.durationSecs) || 0) / 60), 0) };
}

function renderChannelGoals() {
  const box = $("channelGoals"), goals = readChannelGoals(), today = new Date(), sessions = readSessions(), projectMap = new Map(readProjects().map(project => [project.id, project]));
  const dayStart = new Date(today); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = addDays(dayStart, 1), week = startOfWeek(today), weekEnd = addDays(week, 7);
  box.innerHTML = readWorkChannels().filter(channel => channel.id !== "routine").map(channel => {
    const target = goals[channel.id] || { dailyMinutes: 75, weeklyMinutes: 375 };
    const daily = statsInRange(channel.id, dayStart, dayEnd, sessions, projectMap), weekly = statsInRange(channel.id, week, weekEnd, sessions, projectMap);
    return `<button class="channel-goal-card" data-channel-goal="${escapeAttr(channel.id)}" title="Ver progreso semanal de ${escapeAttr(channel.name)}"><span class="goal-avatar">${goalAvatar(channel)}</span><span class="goal-copy"><strong>${escapeHtml(channel.name)}</strong><small><b>Hoy</b> ${daily.minutes}/${target.dailyMinutes} min · ${daily.sessions} sesiones</small><small><b>Semana</b> ${weekly.minutes}/${target.weeklyMinutes} min · ${weekly.sessions} sesiones</small></span></button>`;
  }).join("");
  box.querySelectorAll("[data-channel-goal]").forEach(button => button.addEventListener("click", () => openChannelStats(button.dataset.channelGoal)));
}

function openChannelStats(channelId) {
  const channel = workChannelInfo(channelId), week = startOfWeek(new Date()), weekEnd = addDays(week, 7), goals = readChannelGoals();
  const target = goals[channelId] || { dailyMinutes: 75, weeklyMinutes: 375 }, projects = readProjects(), projectMap = new Map(projects.map(project => [project.id, project]));
  const sessions = readSessions().filter(session => session.status === "done" && inferredWorkArea(session) === channelId && new Date(session.startAt) >= week && new Date(session.startAt) < weekEnd);
  const completedTasks = readDayTasks().filter(task => task.done && task.completedAt && new Date(task.completedAt) >= week && new Date(task.completedAt) < weekEnd && projectWorkChannel(projectMap.get(task.projectId)) === channelId);
  const minutes = sessions.reduce((sum, session) => sum + (Number(session.durationSecs) || 0) / 60, 0), breakMinutes = sessions.reduce((sum, session) => sum + (Number(session.breakTotalSecs) || 0) / 60, 0);
  const energy = sessions.map(session => Number(session.energy)).filter(value => value >= 1 && value <= 10), averageEnergy = energy.length ? energy.reduce((sum, value) => sum + value, 0) / energy.length : null;
  const projectRows = new Map();
  sessions.forEach(session => { const name = projectMap.get(session.projectId)?.title || session.projectName || "Trabajo general"; const row = projectRows.get(name) || { minutes:0, sessions:0 }; row.minutes += (Number(session.durationSecs) || 0) / 60; row.sessions += 1; projectRows.set(name, row); });
  const dialog = $("channelStatsDialog");
  $("channelStatsDialogContent").innerHTML = `<div class="session-dialog-head"><div><span>${fmtDate(week)} – ${fmtDate(addDays(weekEnd,-1))}</span><h2>${escapeHtml(channel.name)} · esta semana</h2></div><button class="side-close" id="closeChannelStats" type="button">×</button></div><div class="channel-week-kpis"><div><strong>${(minutes / 60).toFixed(1)} h</strong><span>enfoque</span></div><div><strong>${sessions.length}</strong><span>sesiones</span></div><div><strong>${completedTasks.length}</strong><span>tareas hechas</span></div><div><strong>${averageEnergy === null ? "—" : averageEnergy.toFixed(1)}</strong><span>energía media</span></div></div><section class="session-dialog-section channel-goal-summary"><h3>Objetivo semanal</h3><p>${Math.round(minutes)} de ${target.weeklyMinutes} minutos · ${Math.round(minutes / Math.max(1,target.weeklyMinutes) * 100)}%</p><button class="tool-btn" id="editChannelGoal" type="button">Modificar objetivos</button></section><section class="session-dialog-section"><h3>Distribución por video/proyecto</h3>${projectRows.size ? [...projectRows].sort((a,b)=>b[1].minutes-a[1].minutes).map(([name,row]) => `<div class="channel-project-stat"><strong>${escapeHtml(name)}</strong><span>${(row.minutes/60).toFixed(1)} h · ${row.sessions} sesiones</span></div>`).join("") : "<p>Todavía no hay sesiones terminadas esta semana.</p>"}</section><p class="channel-break-summary">Breaks registrados: ${Math.round(breakMinutes)} min</p>`;
  $("closeChannelStats").addEventListener("click", () => dialog.close());
  $("editChannelGoal").addEventListener("click", () => { dialog.close(); editChannelGoal(channelId); });
  dialog.showModal();
}

function editChannelGoal(channelId) {
  const goals = readChannelGoals(), current = goals[channelId] || { dailyMinutes: 75, weeklyMinutes: 375 };
  editingGoalChannelId = channelId;
  $("goalChannelName").textContent = workAreaLabel(channelId);
  $("goalDailyMinutes").value = current.dailyMinutes;
  $("goalWeeklyMinutes").value = current.weeklyMinutes;
  $("goalDialog").showModal();
}

async function syncGoogleCalendar(showFeedback = true) {
  const rangeStart = addDays(startOfWeek(new Date()), -28), rangeEnd = addDays(rangeStart, 120);
  try {
    const events = await ipcRenderer.invoke("google-calendar-sync", { timeMin: rangeStart.toISOString(), timeMax: rangeEnd.toISOString() });
    const eventIds = new Set(events.map(event => event.id));
    const sessions = readSessions().filter(session => session.source !== "google-focusmate" || new Date(session.startAt) < rangeStart || new Date(session.startAt) >= rangeEnd || eventIds.has(session.googleEventId));
    events.forEach(event => {
      const start = new Date(event.startAt), end = new Date(event.endAt), index = sessions.findIndex(session => session.googleEventId === event.id), current = sessions[index];
      const imported = { ...(current || {}), id: current?.id || `google-${event.id}`, googleEventId: event.id, source: "google-focusmate", label: event.title, startAt: start.toISOString(), durationSecs: Math.max(60, Math.round((end - start) / 1000)), status: current?.status === "done" ? "done" : "pending", tasks: current?.tasks || [], importedAt: new Date().toISOString() };
      if (index >= 0) sessions[index] = imported; else sessions.push(imported);
    });
    writeSessions(sessions); localStorage.setItem(GOOGLE_SYNC_KEY, new Date().toISOString()); ipcRenderer.send("session-created");
    renderCalendar();
    if (showFeedback) showMsg(`${events.length} sesiones de Focusmate sincronizadas`);
  } catch (error) { if (showFeedback) showMsg(error.message || "No se pudo sincronizar"); }
}

async function refreshGoogleStatus() {
  const status = await ipcRenderer.invoke("google-calendar-status");
  $("googleStatus").textContent = status.connected ? "Conectado · listo para sincronizar" : status.configured ? "Client ID guardado · falta conectar" : "Todavia no configurado";
}

function readProjects() {
  return readJsonArray(PROJECTS_KEY);
}

function readWorkChannels() {
  const channels = readJsonArray(WORK_CHANNELS_KEY);
  [{ id: "personal", name: "JustJuani", order: 0 }, { id: "work", name: "Laburo", order: 1 }, { id: "routine", name: "Personal", order: 999, hiddenFromVideos: true }].forEach(item => { if (!channels.some(channel => channel.id === item.id)) channels.push(item); });
  return channels.sort((a, b) => (a.order || 0) - (b.order || 0));
}
function workAreaLabel(value) { return readWorkChannels().find(channel => channel.id === value)?.name || (value === "work" ? "Laburo" : "JustJuani"); }
function workChannelInfo(value) { return readWorkChannels().find(channel => channel.id === value) || readWorkChannels()[0]; }
function projectWorkChannel(project) { return project?.workChannelId || project?.mode || "personal"; }
function inferredWorkArea(session) {
  if (session.workArea) return session.workArea;
  return projectWorkChannel(readProjects().find(project => project.id === session.projectId));
}
function fillWorkAreaSelect(select, selected = "personal") {
  if (!select) return;
  select.innerHTML = readWorkChannels().map(channel => `<option value="${escapeAttr(channel.id)}">${escapeHtml(channel.name)}</option>`).join("");
  select.value = readWorkChannels().some(channel => channel.id === selected) ? selected : "personal";
}
function fillVideoSelect(select, area, selectedId = "") {
  if (!select) return;
  const videos = readProjects().filter(project => !project.archived && projectWorkChannel(project) === area);
  select.innerHTML = `<option value="">Trabajo general de ${workAreaLabel(area)}</option>${videos.map(project => `<option value="${escapeAttr(project.id)}">${escapeHtml(project.title)}</option>`).join("")}`;
  select.value = videos.some(project => project.id === selectedId) ? selectedId : "";
}

function readJsonArray(key) {
  try { const parsed = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function readDayTasks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DAY_TASKS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function sameDayKey(isoValue, key) {
  if (!isoValue) return false;
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return false;
  return dateKey(date) === key;
}

function startOfWeek(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  const day = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - day);
  return copy;
}

function addDays(date, amount) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + amount);
  return copy;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function fmtDate(date) {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
}

function fmtHour(date) {
  return `${date.getHours()}:${pad(date.getMinutes())}`;
}

function formatDateTime(value) {
  if (!value) return "sin dato";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "sin dato";
  return `${fmtDate(date)} ${fmtHour(date)}`;
}

function fmtDuration(secs) {
  const safeSecs = Math.max(0, Math.floor(Number(secs) || 0));
  const minutes = Math.floor(safeSecs / 60);
  const seconds = safeSecs % 60;
  return `${minutes}m ${pad(seconds)}s`;
}

function toDateTimeLocal(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDateTimeLocal(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function showMsg(message) {
  const msg = $("calendarMsg");
  msg.textContent = message;
  msg.classList.remove("hidden");
  setTimeout(() => msg.classList.add("hidden"), 2400);
}

function getDurationMinutes() {
  const custom = parseInt($("customDuration").value, 10);
  if (custom > 0) return custom;
  return parseInt($("durationSelect").value, 10);
}

function getVisibleDays() {
  return Array.from({ length: visibleDays }, (_, index) => addDays(weekStart, index));
}

function energyClass(energy) {
  if (!energy) return "";
  if (energy <= 4) return "energy-low";
  if (energy <= 6) return "energy-mid";
  return "energy-high";
}

function sessionPreview(session, start, channel = null) {
  const workChannel = channel || workChannelInfo(inferredWorkArea(session));
  const initial = workChannel.id === "routine" ? "J" : escapeHtml((workChannel.name || "C").slice(0, 1).toUpperCase());
  const avatar = workChannel.avatarUrl ? `<img src="${escapeAttr(workChannel.avatarUrl)}" alt="" />` : `<span>${initial}</span>`;
  const energy = session.energy ? String(session.energy) : "–";
  const taskCount = Array.isArray(session.tasks) && session.tasks.length ? `<small>${session.tasks.filter(task => task.done).length}/${session.tasks.length} tareas</small>` : "";
  return `<div class="session-chip-head"><b>${fmtHour(start)}</b><span class="energy-tag" title="Nivel de energía">⚡ ${energy}</span></div><div class="session-channel-row"><span class="session-avatar">${avatar}</span><strong>${escapeHtml(workChannel.name)}</strong></div>${session.projectName ? `<div class="session-video">${escapeHtml(session.projectName)}</div>` : ""}${taskCount}`;
}

function renderCalendar() {
  const grid = $("calendarGrid");
  const days = getVisibleDays();
  $("weekLabel").textContent = `${fmtDate(days[0])} - ${fmtDate(days.at(-1))}/${days.at(-1).getFullYear()}`;
  const oldScroll = grid.querySelector(".calendar-scroll")?.scrollTop;
  const now = new Date(), calendarHeight = 96 * SLOT_HEIGHT;
  const visibleKeys = new Set(days.map(dateKey));
  const byDay = new Map(days.map(day => [dateKey(day), []])), milestoneByDay = new Map(days.map(day => [dateKey(day), []])), channelMap = new Map(readWorkChannels().map(channel => [channel.id, channel])), projectMap = new Map(readProjects().map(project => [project.id, project]));
  readSessions().filter(session => session.status !== "cancelled").forEach(session => {
    const start = new Date(session.startAt), key = dateKey(start);
    if (!Number.isNaN(start.getTime()) && visibleKeys.has(key)) byDay.get(key).push({ session, start });
  });
  projectMap.forEach(project => {
    if (project.archived) return;
    if (project.startDate && visibleKeys.has(project.startDate)) milestoneByDay.get(project.startDate).push({ project, kind:"start" });
    if (project.dueDate && visibleKeys.has(project.dueDate)) milestoneByDay.get(project.dueDate).push({ project, kind:"due" });
  });
  const milestoneHeight = Math.max(32, Math.max(0, ...[...milestoneByDay.values()].map(items => items.length)) * 24 + 6);
  const milestoneCell = day => (milestoneByDay.get(dateKey(day)) || []).map(({ project, kind }) => `<button class="project-milestone ${kind}" data-project-id="${escapeAttr(project.id)}" title="Abrir ${escapeAttr(project.title)}"><b>${kind === "start" ? "▶" : "◆"}</b><span>${kind === "start" ? "Inicio" : "Límite"} · ${escapeHtml(project.title)}</span></button>`).join("");
  grid.innerHTML = `<div class="calendar-scroll"><div class="calendar-week-content" style="--day-count:${days.length}"><div class="calendar-head-row"><div></div>${days.map(day => `<div class="cal-day-head">${DAYS[day.getDay() === 0 ? 6 : day.getDay() - 1]} ${day.getDate()}</div>`).join("")}</div><div class="calendar-milestone-row" style="height:${milestoneHeight}px"><div class="milestone-label">Proyectos</div>${days.map(day => `<div class="milestone-day">${milestoneCell(day)}</div>`).join("")}</div><div class="calendar-canvas"><div class="calendar-time-axis">${Array.from({ length: 24 }, (_, hour) => `<span class="calendar-time-label" style="top:${hour * 4 * SLOT_HEIGHT}px">${hour}:00</span>`).join("")}</div>${days.map(day => `<div class="calendar-day-column" data-calendar-day="${dateKey(day)}"></div>`).join("")}</div></div></div>`;
  grid.querySelectorAll(".project-milestone").forEach(button => button.addEventListener("click", () => {
    localStorage.setItem(OPEN_PROJECT_KEY, button.dataset.projectId);
    ipcRenderer.send("open-day-tasks");
  }));
  days.forEach(day => {
    const column = grid.querySelector(`[data-calendar-day="${dateKey(day)}"]`);
    (byDay.get(dateKey(day)) || []).sort((a, b) => a.start - b.start).forEach(({ session, start }) => {
      const chip = document.createElement("button");
      const minutes = start.getHours() * 60 + start.getMinutes();
      chip.type = "button";
      const area = session.workArea || projectWorkChannel(projectMap.get(session.projectId));
      chip.className = `session-chip area-${area} ${energyClass(session.energy)} ${selectedSessionId === session.id ? "session-selected" : ""}`;
      chip.style.top = `${minutes / 15 * SLOT_HEIGHT + 2}px`;
      chip.style.height = `${Math.max(24, (Number(session.durationSecs) || 900) / 900 * SLOT_HEIGHT - 4)}px`;
      chip.innerHTML = sessionPreview(session, start, channelMap.get(area) || { id:area, name:workAreaLabel(area) });
      chip.addEventListener("click", event => {
        event.stopPropagation(); selectedSessionId = session.id;
        const end = start.getTime() + (Number(session.durationSecs) || 0) * 1000;
        if (session.status === "done" || end <= Date.now()) openSessionDialog(session);
        else openFutureSessionDialog(session);
      });
      column.appendChild(chip);
    });
    if (dateKey(day) === dateKey(now)) {
      const line = document.createElement("i"); line.className = "calendar-now-line";
      line.style.top = `${(now.getHours() * 60 + now.getMinutes()) / 15 * SLOT_HEIGHT}px`; column.appendChild(line);
    }
  });
  const scroll = grid.querySelector(".calendar-scroll");
  if (Number.isFinite(oldScroll)) scroll.scrollTop = oldScroll;
  else if (!didAutoScroll) { scroll.scrollTop = Math.max(0, (now.getHours() * 4 - 4) * SLOT_HEIGHT); didAutoScroll = true; }
  renderChannelGoals();
}

function cell(className, text) {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}

function dayHistoryTaskMarkup(task, kind) {
  const note = task.notes ? `<div class="side-task-note">${escapeHtml(task.notes)}</div>` : "";
  const timeLabel = kind === "done"
    ? fmtHour(new Date(task.completedAt))
    : fmtHour(new Date(task.deletedAt));
  const statusTag = kind === "done" ? "[x] completada" : "[eliminada]";
  return `
    <div class="side-task ${kind === "done" ? "done" : "deleted"}">
      <div>${statusTag} ${timeLabel} · ${escapeHtml(task.text)}</div>
      ${note}
    </div>
  `;
}

function renderDayHistory(panel, key) {
  const dayTasks = readDayTasks();
  const doneThatDay = dayTasks.filter(task => sameDayKey(task.completedAt, key));
  const deletedThatDay = dayTasks.filter(task => sameDayKey(task.deletedAt, key) && !sameDayKey(task.completedAt, key));

  const [year, month, day] = key.split("-").map(Number);
  const label = `${pad(day)}/${pad(month)}/${year}`;

  panel.innerHTML = `
    <div class="side-title">Historial del dia</div>
    <div class="side-meta">${label}</div>
    <div class="side-section">Tareas completadas</div>
    ${doneThatDay.length ? doneThatDay.map(task => dayHistoryTaskMarkup(task, "done")).join("") : `<div class="side-copy">(ninguna)</div>`}
    <div class="side-section">Tareas eliminadas</div>
    ${deletedThatDay.length ? deletedThatDay.map(task => dayHistoryTaskMarkup(task, "deleted")).join("") : `<div class="side-copy">(ninguna)</div>`}
  `;
}

function openSessionDialog(session) {
  const dialog = $("sessionDialog"), start = new Date(session.startAt);
  const tasks = (session.tasks || []).filter(task => !task.deleted);
  const completed = tasks.filter(task => task.done), pending = tasks.filter(task => !task.done);
  const breaks = Array.isArray(session.breakSegments) ? session.breakSegments : [];
  $("sessionDialogContent").innerHTML = `
    <div class="session-dialog-head"><div><span>${fmtDate(start)} · ${fmtHour(start)} · ${Math.round((session.durationSecs || 0) / 60)} min</span><h2>Registro de sesión</h2></div><button class="side-close" id="closeSessionDialog" type="button">×</button></div>
    <div class="session-dialog-summary"><span>⚡ ${session.energy ? `${session.energy}/10` : "Sin energía"}</span><span>${escapeHtml(session.projectName || workAreaLabel(inferredWorkArea(session)))}</span></div>
    <div class="session-dialog-assignment"><select class="tool-select" id="popupWorkArea"></select><select class="tool-select" id="popupProject"></select><button class="tool-btn" id="savePopupAssignment" type="button">Guardar asignación</button></div>
    <section class="session-dialog-section"><h3>Notas</h3><p>${escapeHtml(session.notes || "Sin notas para esta sesión.")}</p></section>
    <div class="session-dialog-columns"><section class="session-dialog-section"><h3>Completadas</h3>${completed.length ? completed.map(task => `<div class="dialog-task done"><b>✓</b><span>${escapeHtml(task.text)}<small>${fmtDuration(task.focusedSecs || 0)}${task.completedAt ? ` · ${formatDateTime(task.completedAt)}` : ""}</small></span></div>`).join("") : '<p>Ninguna.</p>'}</section><section class="session-dialog-section"><h3>Pendientes</h3>${pending.length ? pending.map(task => `<div class="dialog-task"><b>○</b><span>${escapeHtml(task.text)}<small>${fmtDuration(task.focusedSecs || 0)}</small></span></div>`).join("") : '<p>Ninguna.</p>'}</section></div>
    <section class="session-dialog-section"><h3>Breaks</h3><p>${breaks.length ? breaks.map(item => `${formatDateTime(item.startAt)} · ${fmtDuration(item.durationSecs)}`).join("<br>") : "No tomaste breaks."}</p></section>
    <div class="session-dialog-danger"><button class="tool-btn danger" id="deletePopupSession" type="button">Borrar sesión</button></div>`;
  fillWorkAreaSelect($("popupWorkArea"), inferredWorkArea(session));
  fillVideoSelect($("popupProject"), $("popupWorkArea").value, session.projectId || "");
  $("popupWorkArea").addEventListener("change", event => fillVideoSelect($("popupProject"), event.target.value));
  $("closeSessionDialog").addEventListener("click", () => dialog.close());
  $("savePopupAssignment").addEventListener("click", () => {
    const workArea = $("popupWorkArea").value, projectId = $("popupProject").value || null;
    const project = readProjects().find(item => item.id === projectId);
    writeSessions(readSessions().map(item => item.id === session.id ? { ...item, workArea, workAreaName: workAreaLabel(workArea), projectId, projectName: project?.title || null } : item));
    ipcRenderer.send("session-created"); dialog.close(); renderCalendar(); renderChannelGoals();
  });
  $("deletePopupSession").addEventListener("click", () => {
    if (!window.confirm(`¿Seguro que querés borrar la sesión del ${fmtDate(start)} a las ${fmtHour(start)}?`)) return;
    deleteSessionAndCleanup(session.id); dialog.close(); showMsg("Sesión borrada");
  });
  dialog.showModal();
}

function openFutureSessionDialog(session) {
  const dialog = $("sessionDialog"), start = new Date(session.startAt);
  const tasks = (session.tasks || []).filter(task => !task.deleted);
  $("sessionDialogContent").innerHTML = `
    <div class="session-dialog-head"><div><span>${fmtDate(start)} · ${fmtHour(start)} · ${Math.round((session.durationSecs || 0) / 60)} min</span><h2>Planificar sesión</h2></div><button class="side-close" id="closeFutureDialog" type="button">×</button></div>
    <p class="future-session-help">Elegí el canal o video. También podés asignarle tareas desde la lista.</p>
    <div class="session-dialog-assignment"><select class="tool-select" id="futureWorkArea"></select><select class="tool-select" id="futureProject"></select><button class="tool-btn primary" id="saveFutureAssignment" type="button">Guardar</button></div>
    <section class="session-dialog-section"><h3>Tareas asignadas</h3>${tasks.length ? tasks.map(task => `<div class="dialog-task"><b>${task.done ? "✓" : "○"}</b><span>${escapeHtml(task.text)}<small>${fmtDuration(task.focusedSecs || 0)}</small></span></div>`).join("") : "<p>Todavía no tiene tareas.</p>"}</section>`;
  fillWorkAreaSelect($("futureWorkArea"), inferredWorkArea(session));
  fillVideoSelect($("futureProject"), $("futureWorkArea").value, session.projectId || "");
  $("futureWorkArea").addEventListener("change", event => fillVideoSelect($("futureProject"), event.target.value));
  $("closeFutureDialog").addEventListener("click", () => dialog.close());
  $("saveFutureAssignment").addEventListener("click", () => {
    const workArea = $("futureWorkArea").value, projectId = $("futureProject").value || null;
    const project = readProjects().find(item => item.id === projectId);
    writeSessions(readSessions().map(item => item.id === session.id ? { ...item, workArea, workAreaName: workAreaLabel(workArea), projectId, projectName: project?.title || null } : item));
    ipcRenderer.send("session-created"); dialog.close(); renderCalendar();
  });
  dialog.showModal();
}

function deleteSessionAndCleanup(sessionId) {
  writeSessions(readSessions().filter(item => item.id !== sessionId));
  const tasks = readDayTasks().map(task => {
    const sessionIds = (task.sessionIds || []).filter(id => id !== sessionId);
    const sessionFocus = { ...(task.sessionFocus || {}) }; delete sessionFocus[sessionId];
    return { ...task, sessionIds, sessionCount: sessionIds.length, sessionFocus, focusedSecs: Object.values(sessionFocus).reduce((sum, value) => sum + (Number(value) || 0), 0) };
  });
  localStorage.setItem(DAY_TASKS_KEY, JSON.stringify(tasks));
  selectedSessionId = null; ipcRenderer.send("session-created"); renderTaskPlanner(); renderCalendar();
}

function renderSidePanel() {
  const panel = $("sessionSidePanel");
  const session = readSessions().find(item => item.id === selectedSessionId);

  if (!session || taskPlannerOpen) {
    panel.classList.add("hidden");
    $("calendarLayout").classList.remove("panel-open");
    panel.innerHTML = "";
    $("calendarLayout").classList.toggle("panel-open", taskPlannerOpen);
    return;
  }

  panel.classList.remove("hidden");
  $("calendarLayout").classList.add("panel-open");

  const start = new Date(session.startAt);
  const tasks = Array.isArray(session.tasks) ? session.tasks : [];
  panel.innerHTML = `
    <div class="side-panel-head"><div class="side-title">Editar sesión</div><button class="side-close" id="closeSidePanel" type="button">×</button></div>
    <form class="side-edit-form" id="sideEditForm">
      <div class="side-edit-grid">
        <input class="tool-input" id="sideStart" type="datetime-local" value="${toDateTimeLocal(start)}" />
        <input class="tool-input" id="sideDuration" type="number" min="1" max="480" value="${Math.max(1, Math.round((session.durationSecs || 0) / 60))}" />
      </div>
      <div class="side-edit-grid">
        <select class="tool-select" id="sideWorkArea"></select>
        <select class="tool-select" id="sideProject"></select>
      </div>
      <div class="side-edit-grid">
        <select class="tool-select" id="sideStatus">
          <option value="pending">pendiente</option>
          <option value="running">en curso</option>
          <option value="done">terminada</option>
        </select>
        <select class="tool-select" id="sideEnergy">
          <option value="">energia</option>
          ${Array.from({ length: 10 }, (_, index) => `<option value="${index + 1}">${index + 1}/10</option>`).join("")}
        </select>
      </div>
      <textarea class="tool-textarea" id="sideNotes" rows="5" placeholder="Notas / comentarios">${escapeHtml(session.notes || "")}</textarea>
      <div class="side-section">Tareas planificadas para esta sesión</div>
      <div id="sideTasks">
        ${tasks.length ? tasks.map(taskEditMarkup).join("") : `<div class="side-copy">(sin tareas)</div>`}
      </div>
      <button class="tool-btn" id="addSideTaskBtn" type="button">Agregar tarea</button>
      <div class="side-section">Breaks</div>
      <div class="side-copy">Total: ${fmtDuration(session.breakTotalSecs || 0)}</div>
      ${Array.isArray(session.breakSegments) && session.breakSegments.length
        ? session.breakSegments.map(segment => `<div class="side-copy">${escapeHtml(formatDateTime(segment.startAt))} - ${fmtDuration(segment.durationSecs)}</div>`).join("")
        : `<div class="side-copy">(sin breaks)</div>`}
      <div class="side-copy">Creada: ${escapeHtml(formatDateTime(session.createdAt))}</div>
      <div class="side-copy">Cerrada: ${escapeHtml(formatDateTime(session.completedAt || session.endedAt))}</div>
      <button class="tool-btn primary" id="saveSessionEditBtn" type="submit">Guardar cambios</button>
    </form>
    <button class="tool-btn danger side-delete-btn" id="deleteSessionBtn">Borrar sesion</button>
  `;
  $("sideStatus").value = session.status || "done";
  $("sideEnergy").value = session.energy ? String(session.energy) : "";
  fillWorkAreaSelect($("sideWorkArea"), inferredWorkArea(session));
  fillVideoSelect($("sideProject"), $("sideWorkArea").value, session.projectId || "");
  $("closeSidePanel").addEventListener("click", () => { selectedSessionId = null; renderSidePanel(); renderCalendar(); });
  $("sideWorkArea").addEventListener("change", event => fillVideoSelect($("sideProject"), event.target.value));
  $("sideEditForm").addEventListener("submit", event => {
    event.preventDefault();
    saveSessionEdits(session.id);
  });
  $("addSideTaskBtn").addEventListener("click", addSideTaskRow);
  $("deleteSessionBtn").addEventListener("click", () => deleteSession(session.id));
  return;

  const doneTasks = (session.tasks || []).filter(task => task.done && !task.deleted);
  const pendingTasks = (session.tasks || []).filter(task => !task.done && !task.deleted);
  const deletedTasks = (session.tasks || []).filter(task => task.deleted);
  const statusLabel = {
    pending: "pendiente",
    running: "en curso",
    done: "terminada",
  }[session.status] || session.status || "sin estado";

  panel.innerHTML = `
    <div class="side-title">${escapeHtml(session.label || "Sesion sin etiqueta")}</div>
    <div class="side-meta">${fmtDate(start)} ${fmtHour(start)} - ${Math.round(session.durationSecs / 60)} min</div>
    <div class="side-pill-row">
      <span class="side-pill">${statusLabel}</span>
      <span class="side-pill ${energyClass(session.energy)}">energia ${session.energy ? `${session.energy}/10` : "sin dato"}</span>
    </div>
    <div class="side-section">Notas / comentarios</div>
    <div class="side-copy">${escapeHtml(session.notes || "(sin notas)")}</div>
    <div class="side-section">Tareas completadas</div>
    ${doneTasks.length ? doneTasks.map(taskMarkup).join("") : `<div class="side-copy">(ninguna)</div>`}
    <div class="side-section">Tareas pendientes</div>
    ${pendingTasks.length ? pendingTasks.map(taskMarkup).join("") : `<div class="side-copy">(ninguna)</div>`}
    <div class="side-section">Tareas eliminadas</div>
    ${deletedTasks.length ? deletedTasks.map(taskMarkup).join("") : `<div class="side-copy">(ninguna)</div>`}
    <div class="side-section">Datos</div>
    <div class="side-copy">Creada: ${escapeHtml(formatDateTime(session.createdAt))}</div>
    <div class="side-copy">Cerrada: ${escapeHtml(formatDateTime(session.completedAt || session.endedAt))}</div>
    <button class="tool-btn danger side-delete-btn" id="deleteSessionBtn">Borrar sesion</button>
  `;

  $("deleteSessionBtn").addEventListener("click", () => deleteSession(session.id));
}

function taskEditMarkup(task) {
  const id = task.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `
    <div class="side-task-edit" data-task-id="${escapeAttr(id)}">
      <input type="checkbox" ${task.done ? "checked" : ""} />
      <input class="tool-input side-task-text" type="text" value="${escapeAttr(task.text || "")}" placeholder="Tarea" />
      <select class="tool-select side-task-priority">
        <option value="high" ${task.priority === "high" ? "selected" : ""}>Urgente</option>
        <option value="medium" ${!task.priority || task.priority === "medium" ? "selected" : ""}>Normal</option>
        <option value="low" ${task.priority === "low" ? "selected" : ""}>Baja</option>
      </select>
      <textarea class="tool-textarea side-task-notes" rows="2" placeholder="Notas de tarea">${escapeHtml(task.notes || "")}</textarea>
    </div>
  `;
}

function renderTaskPlanner() {
  const panel = $("taskPlannerPanel");
  $("taskPlannerBtn")?.classList.toggle("active", taskPlannerOpen);
  panel.classList.toggle("hidden", !taskPlannerOpen);
  if (!taskPlannerOpen) { panel.innerHTML = ""; $("calendarLayout").classList.remove("panel-open"); return; }
  $("calendarLayout").classList.add("panel-open");
  const sessions = readSessions(), assignmentsByTask = new Map();
  sessions.filter(session => session.status !== "cancelled").forEach(session => (session.tasks || []).forEach(task => { const id = task.projectTaskId || task.movedFromDayTaskId; if (!id) return; if (!assignmentsByTask.has(id)) assignmentsByTask.set(id, []); assignmentsByTask.get(id).push(session); }));
  assignmentsByTask.forEach(items => items.sort((a,b) => new Date(a.startAt)-new Date(b.startAt)));
  const projects = readProjects().filter(project => !project.archived);
  const projectMap = new Map(projects.map(project => [project.id, project]));
  const sectionMap = new Map(readJsonArray(PROJECT_CHANNELS_KEY).map(section => [section.id, section]));
  const allItems = readDayTasks().filter(task => !task.deleted && !task.done && projectMap.has(task.projectId)).sort((a, b) => String(a.dueDate || "9999-99-99").localeCompare(String(b.dueDate || "9999-99-99")));
  const items = allItems.filter(task => !task.parentTaskId);
  const groups = readWorkChannels().map(channel => {
    const channelTasks = items.filter(task => projectWorkChannel(projectMap.get(task.projectId)) === channel.id);
    if (!channelTasks.length) return "";
    const projectIds = [...new Set(channelTasks.map(task => task.projectId))];
    return `<section class="planner-channel"><header><span class="goal-avatar">${goalAvatar(channel)}</span><div><strong>${escapeHtml(channel.name)}</strong><small>${channelTasks.length} pendientes</small></div></header>${projectIds.map(projectId => {
      const project = projectMap.get(projectId), section = sectionMap.get(project.channelId);
      const projectTasks = channelTasks.filter(task => task.projectId === projectId);
      return `<div class="planner-project"><div class="planner-project-title"><small>${escapeHtml(section?.name || "Videos")}</small><strong>${escapeHtml(project.title)}</strong></div>${projectTasks.map(task => {
        const assigned = assignmentsByTask.get(task.id) || [];
        const due = taskDueInfo(task.dueDate);
        const subtasks = allItems.filter(item => item.parentTaskId === task.id), expanded = expandedPlannerTaskIds.has(task.id);
        return `<div class="planner-task-group">${plannerTaskMarkup(task, assigned, due, `<button class="planner-subtask-toggle ${expanded ? "expanded" : ""}" data-toggle-planner-subtasks="${escapeAttr(task.id)}" title="Subtareas">${expanded ? "▾" : "▸"}<small>${subtasks.length || "+"}</small></button>`)}<div class="planner-subtasks ${expanded ? "expanded" : ""}">${subtasks.map(subtask => plannerTaskMarkup(subtask, assignmentsByTask.get(subtask.id) || [], taskDueInfo(subtask.dueDate), "", true)).join("")}<form class="planner-subtask-add" data-calendar-add-subtask="${escapeAttr(task.id)}"><input maxlength="160" placeholder="Agregar subtarea"/><button type="submit">+</button></form></div></div>`;
      }).join("")}</div>`;
    }).join("")}</section>`;
  }).join("");
  panel.innerHTML = `<div class="side-panel-head"><div class="side-title">Tareas de proyectos</div><button class="side-close" id="closeTaskPlanner" type="button">×</button></div><div class="planner-task-list">${groups || '<div class="planner-empty">No hay tareas pendientes en proyectos activos.</div>'}</div>`;
  $("closeTaskPlanner").addEventListener("click", () => { taskPlannerOpen = false; renderTaskPlanner(); });
  panel.querySelectorAll("[data-assign-task]").forEach(button => button.addEventListener("click", () => openTaskSessionChooser(button.dataset.assignTask)));
  panel.querySelectorAll("[data-complete-task]").forEach(button => button.addEventListener("click", () => completeProjectTask(button.dataset.completeTask)));
  panel.querySelectorAll("[data-toggle-planner-subtasks]").forEach(button => button.addEventListener("click", () => { const id=button.dataset.togglePlannerSubtasks; expandedPlannerTaskIds.has(id) ? expandedPlannerTaskIds.delete(id) : expandedPlannerTaskIds.add(id); renderTaskPlanner(); }));
  panel.querySelectorAll("[data-calendar-add-subtask]").forEach(form => form.addEventListener("submit", event => addCalendarSubtask(event, form.dataset.calendarAddSubtask)));
}

function plannerTaskMarkup(task, assigned, due, toggle = "", isSubtask = false) {
  const worked = Number(task.focusedSecs) > 0 ? ` · ${fmtDuration(task.focusedSecs)} trabajados` : "";
  return `<article class="planner-task ${isSubtask ? "planner-subtask" : ""} ${due.className}"><button class="planner-check" data-complete-task="${escapeAttr(task.id)}" title="Completar tarea">✓</button>${toggle}<div><strong>${escapeHtml(task.text)}</strong><small>${due.label}${worked}</small>${assigned.length ? `<span class="task-session-chips">${assigned.map(item => `<i>${escapeHtml(relativeSessionLabel(item))}</i>`).join("")}</span>` : ""}</div><button class="tool-btn" data-assign-task="${escapeAttr(task.id)}">+ Sesión</button></article>`;
}

function addCalendarSubtask(event, parentId) {
  event.preventDefault(); const input=event.currentTarget.querySelector("input"), text=input.value.trim(), parent=readDayTasks().find(task=>task.id===parentId); if(!text||!parent)return;
  const all=readDayTasks(); all.push({ id:`${Date.now()}-${Math.random().toString(16).slice(2)}`, parentTaskId:parent.id, text, done:false, notes:"", priority:parent.priority||"medium", deleted:false, category:parent.category||"inbox", dueDate:parent.dueDate||null, mode:projectWorkChannel(readProjects().find(project=>project.id===parent.projectId)), projectId:parent.projectId, focusedSecs:0, sessionIds:[], createdAt:new Date().toISOString() });
  localStorage.setItem(DAY_TASKS_KEY,JSON.stringify(all)); expandedPlannerTaskIds.add(parentId); ipcRenderer.send("data-changed"); renderTaskPlanner();
}

function assignedSessionsForTask(taskId, sessions = readSessions()) {
  return sessions.filter(session => session.status !== "cancelled" && (session.tasks || []).some(task => (task.projectTaskId || task.movedFromDayTaskId) === taskId)).sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
}

function relativeSessionLabel(session) {
  const date = new Date(session.startAt), today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(date); target.setHours(0, 0, 0, 0);
  const days = Math.round((target - today) / 86400000);
  const prefix = days === 0 ? "Hoy" : days === 1 ? "Mañana" : days === -1 ? "Ayer" : fmtDate(date);
  return `${prefix} ${fmtHour(date)}`;
}

function taskDueInfo(value) {
  if (!value) return { label: "Sin fecha", className: "" };
  const due = new Date(`${value}T00:00:00`); if (Number.isNaN(due.getTime())) return { label: "Sin fecha", className: "" };
  const today = new Date(); today.setHours(0, 0, 0, 0); const diff = Math.round((due - today) / 86400000);
  if (diff === 0) return { label: "Hoy", className: "due-today" };
  if (diff === 1) return { label: "Mañana", className: "" };
  if (diff === -1) return { label: "Ayer", className: "due-overdue" };
  return { label: fmtDate(due), className: diff < 0 ? "due-overdue" : "" };
}

function openTaskSessionChooser(taskId) {
  const task = readDayTasks().find(item => item.id === taskId); if (!task) return;
  const assignedIds = new Set(assignedSessionsForTask(taskId).map(session => session.id));
  const sessions = readSessions().filter(session => session.status !== "cancelled" && new Date(session.startAt).getTime() + (Number(session.durationSecs) || 0) * 1000 > Date.now()).sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  const dialog = $("taskSessionDialog");
  $("taskSessionDialogContent").innerHTML = `<div class="session-dialog-head"><div><span>Asignar tarea</span><h2>${escapeHtml(task.text)}</h2></div><button class="side-close" id="closeTaskSessionDialog" type="button">×</button></div><p class="future-session-help">Podés elegir más de una sesión.</p><div class="task-session-options">${sessions.length ? sessions.map(session => `<label><input type="checkbox" data-session-choice="${escapeAttr(session.id)}" ${assignedIds.has(session.id) ? "checked" : ""}><span><strong>${escapeHtml(relativeSessionLabel(session))} · ${Math.round((session.durationSecs || 0) / 60)} min</strong><small>${escapeHtml(session.projectName || workAreaLabel(inferredWorkArea(session)))}</small></span></label>`).join("") : "<p>No hay sesiones futuras disponibles.</p>"}</div><div class="dialog-actions"><button class="tool-btn primary" id="saveTaskSessions" type="button">Guardar asignaciones</button></div>`;
  $("closeTaskSessionDialog").addEventListener("click", () => dialog.close());
  $("saveTaskSessions").addEventListener("click", () => {
    const chosen = new Set([...dialog.querySelectorAll("[data-session-choice]:checked")].map(input => input.dataset.sessionChoice));
    setTaskSessionAssignments(taskId, chosen); dialog.close();
  });
  dialog.showModal();
}

function setTaskSessionAssignments(taskId, chosenIds) {
  const task = readDayTasks().find(item => item.id === taskId); if (!task) return;
  const project = readProjects().find(item => item.id === task.projectId), workArea = projectWorkChannel(project);
  const currentSessions = readSessions();
  const historicalIds = new Set(assignedSessionsForTask(taskId, currentSessions).filter(session => session.status === "done" || new Date(session.startAt).getTime() + (Number(session.durationSecs) || 0) * 1000 <= Date.now()).map(session => session.id));
  const finalIds = new Set([...historicalIds, ...chosenIds]);
  const sessions = currentSessions.map(session => {
    if (historicalIds.has(session.id)) return session;
    let tasks = (session.tasks || []).filter(item => (item.projectTaskId || item.movedFromDayTaskId) !== taskId);
    if (finalIds.has(session.id)) tasks.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, projectTaskId: task.id, movedFromDayTaskId: task.id, text: task.text, notes: task.notes || "", priority: task.priority || "medium", done: false, deleted: false, focusedSecs: Number(task.sessionFocus?.[session.id]) || 0, importedAt: new Date().toISOString() });
    return finalIds.has(session.id) ? { ...session, tasks, workArea, workAreaName: workAreaLabel(workArea), projectId: project?.id || null, projectName: project?.title || null } : { ...session, tasks };
  });
  writeSessions(sessions);
  const sessionFocus = { ...(task.sessionFocus || {}) }; Object.keys(sessionFocus).forEach(id => { if (!finalIds.has(id)) delete sessionFocus[id]; });
  localStorage.setItem(DAY_TASKS_KEY, JSON.stringify(readDayTasks().map(item => item.id === taskId ? { ...item, sessionIds: [...finalIds], sessionCount: finalIds.size, sessionFocus, focusedSecs: Object.values(sessionFocus).reduce((sum, value) => sum + (Number(value) || 0), 0) } : item)));
  ipcRenderer.send("session-created"); renderTaskPlanner(); renderCalendar();
}

function completeProjectTask(taskId) {
  const completedAt = new Date().toISOString();
  localStorage.setItem(DAY_TASKS_KEY, JSON.stringify(readDayTasks().map(task => task.id === taskId ? { ...task, done: true, completedAt } : task)));
  writeSessions(readSessions().map(session => ({ ...session, tasks: (session.tasks || []).map(task => (task.projectTaskId || task.movedFromDayTaskId) === taskId ? { ...task, done: true, completedAt } : task) })));
  ipcRenderer.send("session-created"); renderTaskPlanner(); renderCalendar();
}

function assignProjectTaskToSession(taskId) {
  const task = readDayTasks().find(item => item.id === taskId), session = readSessions().find(item => item.id === selectedSessionId);
  if (!task || !session) return;
  const tasks = Array.isArray(session.tasks) ? [...session.tasks] : [];
  if (tasks.some(item => (item.projectTaskId || item.movedFromDayTaskId) === task.id)) return;
  tasks.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, projectTaskId: task.id, movedFromDayTaskId: task.id, text: task.text, notes: task.notes || "", priority: task.priority || "medium", done: false, deleted: false, focusedSecs: 0, importedAt: new Date().toISOString() });
  writeSessions(readSessions().map(item => item.id === session.id ? { ...item, tasks } : item));
  const sessionIds = [...new Set([...(task.sessionIds || []), session.id])];
  localStorage.setItem(DAY_TASKS_KEY, JSON.stringify(readDayTasks().map(item => item.id === task.id ? { ...item, sessionIds, sessionCount: sessionIds.length } : item)));
  ipcRenderer.send("session-created"); renderTaskPlanner(); renderCalendar();
}

function syncProjectTasksFromCalendarSession(session) {
  if (!session) return;
  const linked = new Map((session.tasks || []).filter(task => task.projectTaskId || task.movedFromDayTaskId).map(task => [task.projectTaskId || task.movedFromDayTaskId, task]));
  if (!linked.size) return;
  const updated = readDayTasks().map(projectTask => {
    const task = linked.get(projectTask.id); if (!task) return projectTask;
    const sessionFocus = { ...(projectTask.sessionFocus || {}), [session.id]: Number(task.focusedSecs) || 0 };
    const sessionIds = [...new Set([...(projectTask.sessionIds || []), session.id])];
    return { ...projectTask, done: Boolean(task.done || projectTask.done), completedAt: task.done ? (task.completedAt || projectTask.completedAt || new Date().toISOString()) : projectTask.completedAt, sessionFocus, sessionIds, sessionCount: sessionIds.length, focusedSecs: Object.values(sessionFocus).reduce((sum, value) => sum + (Number(value) || 0), 0) };
  });
  localStorage.setItem(DAY_TASKS_KEY, JSON.stringify(updated));
}

function addSideTaskRow() {
  const list = $("sideTasks");
  if (list.querySelector(".side-copy")) list.innerHTML = "";
  const wrapper = document.createElement("div");
  wrapper.innerHTML = taskEditMarkup({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, text: "", notes: "", done: false });
  list.appendChild(wrapper.firstElementChild);
}

function saveSessionEdits(id) {
  const start = fromDateTimeLocal($("sideStart").value);
  const durationMinutes = parseInt($("sideDuration").value, 10);
  if (!start || !durationMinutes || durationMinutes <= 0) {
    showMsg("Revisa fecha y duracion");
    return;
  }

  const nowIso = new Date().toISOString();
  const sessions = readSessions().map(session => {
    if (session.id !== id) return session;
    const tasks = [...document.querySelectorAll(".side-task-edit")].map(row => {
      const original = (session.tasks || []).find(task => task.id === row.dataset.taskId) || {};
      const done = row.querySelector("input[type='checkbox']").checked;
      const task = {
        ...original,
        id: row.dataset.taskId,
        text: row.querySelector(".side-task-text").value.trim(),
        notes: row.querySelector(".side-task-notes").value.trim(),
        priority: row.querySelector(".side-task-priority").value,
        done,
      };
      if (done) task.completedAt = original.completedAt || nowIso;
      if (!done) delete task.completedAt;
      return task;
    }).filter(task => task.text);

    const status = $("sideStatus").value;
    const workArea = $("sideWorkArea").value || "personal";
    const projectId = $("sideProject").value || null;
    const project = readProjects().find(item => item.id === projectId);
    const fallbackEnd = new Date(start.getTime() + durationMinutes * 60_000).toISOString();
    return {
      ...session,
      label: "",
      startAt: start.toISOString(),
      durationSecs: durationMinutes * 60,
      status,
      notes: $("sideNotes").value.trim(),
      energy: $("sideEnergy").value ? Number($("sideEnergy").value) : null,
      workArea,
      workAreaName: workAreaLabel(workArea),
      projectId,
      projectName: project?.title || null,
      tasks,
      completedAt: status === "done" ? (session.completedAt || nowIso) : session.completedAt,
      endedAt: status === "done" ? (session.endedAt || fallbackEnd) : session.endedAt,
    };
  });

  writeSessions(sessions);
  syncProjectTasksFromCalendarSession(sessions.find(session => session.id === id));
  ipcRenderer.send("session-created");
  showMsg("Sesion actualizada");
  renderSidePanel();
  renderCalendar();
}

function taskMarkup(task) {
  const note = task.notes ? `<div class="side-task-note">${escapeHtml(task.notes)}</div>` : "";
  const completion = task.done && Number.isFinite(task.completionElapsedMin)
    ? `<div class="side-task-note">completada min ${task.completionElapsedMin} · quedaban ${task.completionRemainingMin} min</div>`
    : "";
  const deleted = task.deleted && Number.isFinite(task.deletedElapsedMin)
    ? `<div class="side-task-note">eliminada min ${task.deletedElapsedMin} · quedaban ${task.deletedRemainingMin} min</div>`
    : "";
  return `
    <div class="side-task ${task.done ? "done" : ""} ${task.deleted ? "deleted" : ""}">
      <div>${task.done ? "[x]" : "[ ]"} ${escapeHtml(task.text)}</div>
      ${completion}
      ${deleted}
      ${note}
    </div>
  `;
}

function deleteSession(id) {
  const session = readSessions().find(item => item.id === id);
  const label = session ? `${fmtDate(new Date(session.startAt))} ${fmtHour(new Date(session.startAt))}` : "";
  if (!window.confirm(`Borrar esta sesion ${label}?`)) return;

  deleteSessionAndCleanup(id);
  showMsg("Sesion borrada");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function saveSession() {
  if (!selectedStart) {
    showMsg("Elegi un horario en el calendario");
    return;
  }

  if (selectedStart < new Date() && !registerMode) {
    showMsg("La sesion tiene que ser futura");
    return;
  }

  const durationMinutes = getDurationMinutes();
  if (!durationMinutes || durationMinutes <= 0) {
    showMsg("Duracion invalida");
    return;
  }

  const sessions = readSessions();
  const workArea = $("calendarWorkArea").value || "personal";
  const projectId = $("calendarVideo").value || null;
  const project = readProjects().find(item => item.id === projectId);
  const isPastRecord = registerMode || selectedStart < new Date();
  const endedAt = new Date(selectedStart.getTime() + durationMinutes * 60_000);
  const createdSession = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    startAt: selectedStart.toISOString(),
    durationSecs: durationMinutes * 60,
    label: "",
    workArea,
    workAreaName: workAreaLabel(workArea),
    projectId,
    projectName: project?.title || null,
    status: isPastRecord ? "done" : "pending",
    tasks: [],
    notes: "",
    energy: null,
    completedAt: isPastRecord ? new Date().toISOString() : null,
    endedAt: isPastRecord ? endedAt.toISOString() : null,
    manualRecord: isPastRecord,
    createdAt: new Date().toISOString(),
  };
  sessions.push(createdSession);
  writeSessions(sessions);
  ipcRenderer.send("session-created");
  showMsg(isPastRecord ? "Sesion registrada" : `Sesion creada para ${fmtHour(selectedStart)}`);
  selectedStart = null;
  selectedSessionId = isPastRecord ? createdSession.id : null;
  renderSidePanel();
  renderCalendar();
}

function moveRange(direction) {
  weekStart = addDays(weekStart, direction * visibleDays);
  selectedStart = null;
  selectedSessionId = null;
  selectedHistoryDay = null;
  didAutoScroll = false;
  renderCalendar();
}

function goToday() {
  weekStart = visibleDays === 3 ? new Date() : startOfWeek(new Date());
  weekStart.setHours(0, 0, 0, 0);
  selectedStart = null;
  selectedSessionId = null;
  selectedHistoryDay = null;
  didAutoScroll = false;
  renderSidePanel();
  renderCalendar();
}

function setVisibleDays(count) {
  visibleDays = count;
  $("weekViewBtn").classList.toggle("active", count === 7);
  $("threeDayViewBtn").classList.toggle("active", count === 3);
  goToday();
}

function toggleRegisterMode() {
  registerMode = !registerMode;
  document.body.classList.toggle("register-mode", registerMode);
  $("registerModeBtn").classList.toggle("active", registerMode);
  $("saveBtn").textContent = registerMode ? "Registrar sesion" : "Crear sesion";
  renderCalendar();
}

$("prevWeekBtn").addEventListener("click", () => moveRange(-1));
$("nextWeekBtn").addEventListener("click", () => moveRange(1));
$("taskPlannerBtn").addEventListener("click", () => { taskPlannerOpen = !taskPlannerOpen; $("taskPlannerBtn").classList.toggle("active", taskPlannerOpen); renderTaskPlanner(); });
$("calendarStatsBtn").addEventListener("click", () => ipcRenderer.send("open-stats"));
$("googleCalendarBtn").addEventListener("click", () => { $("googleDialog").showModal(); refreshGoogleStatus(); });
$("saveGoogleClientBtn").addEventListener("click", async () => { try { await ipcRenderer.invoke("google-calendar-configure", { clientId: $("googleClientId").value, clientSecret: $("googleClientSecret").value }); await refreshGoogleStatus(); } catch (error) { $("googleStatus").textContent = error.message; } });
$("connectGoogleBtn").addEventListener("click", async () => { try { $("googleStatus").textContent = "Abriendo Google..."; await ipcRenderer.invoke("google-calendar-connect"); await refreshGoogleStatus(); await syncGoogleCalendar(); } catch (error) { $("googleStatus").textContent = error.message; } });
$("syncGoogleBtn").addEventListener("click", () => syncGoogleCalendar());
$("goalForm").addEventListener("submit", event => {
  event.preventDefault();
  const daily = Number($("goalDailyMinutes").value), weekly = Number($("goalWeeklyMinutes").value);
  if (!editingGoalChannelId || !Number.isFinite(daily) || daily <= 0 || !Number.isFinite(weekly) || weekly <= 0) return;
  const goals = readChannelGoals(); goals[editingGoalChannelId] = { dailyMinutes: Math.round(daily), weeklyMinutes: Math.round(weekly) };
  localStorage.setItem(CHANNEL_GOALS_KEY, JSON.stringify(goals)); ipcRenderer.send("data-changed"); $("goalDialog").close(); renderChannelGoals();
});
$("closeBtn").addEventListener("click", () => ipcRenderer.send("close-current-window"));
window.addEventListener("focus", renderCalendar);
window.addEventListener("storage", event => { if ([PROJECTS_KEY, SESSIONS_KEY, WORK_CHANNELS_KEY].includes(event.key)) renderCalendar(); });

renderTaskPlanner();
renderCalendar();
ipcRenderer.invoke("google-calendar-status").then(status => { if (status.connected) syncGoogleCalendar(false); });
setInterval(() => {
  const now = new Date();
  const currentVisible = getVisibleDays().some(day => day.toDateString() === now.toDateString());
  if (currentVisible) renderCalendar();
}, 60_000);
