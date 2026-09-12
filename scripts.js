const { ipcRenderer } = require("electron");

const SESSIONS_KEY = "justtimer.sessions.v1";
const TASKS_KEY = "justtimer.tasks.v1";
const ACTIVE_SESSION_KEY = "justtimer.activeSession.v1";
const SESSION_TYPES_KEY = "justtimer.sessionTypes.v1";
const PROJECTS_KEY = "justtimer.projects.v1";
const PERSONAL_PROJECTS_KEY = "justtimer.personalProjects.v1";
const WORK_CHANNELS_KEY = "justtimer.workChannels.v1";
const DAY_TASKS_KEY = "justtimer.dayTasks.v1";
const DAILY_PRIORITIES_KEY = "justtimer.dailyPriorities.v1";
const HABITS_KEY = "justtimer.habits.v1";
const HABIT_LOGS_KEY = "justtimer.habitLogs.v1";
const MINI_CONTEXT_KEY = "justtimer.miniProjectContext.v1";
const GOOGLE_SYNC_KEY = "justtimer.googleCalendarSync.v1";
const DEFAULT_DURATION_SECS = 75 * 60;

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
let activeTaskId = null;
let activeTaskStartedAt = null;
let lastTaskCheckpointAt = 0;
let lastSessionPersistAt = 0;
let pendingSessionsSignature = "";
let quarterSlotsVersion = null;
const soundCache = new Map();
const openInlineSubtaskIds = new Set();
const inlineSubtaskDrafts = new Map();

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
  ipcRenderer.send("data-changed");
}

function reconcileGoogleCalendarEvents(payload = {}) {
  const events=Array.isArray(payload.events)?payload.events:[],rangeStart=new Date(payload.timeMin),rangeEnd=new Date(payload.timeMax);
  if(Number.isNaN(rangeStart.getTime())||Number.isNaN(rangeEnd.getTime()))return false;
  const eventIds=new Set(events.map(event=>event.id)),current=readSessions();let changed=false;
  const next=current.filter(session=>{
    if(session.source!=="google-focusmate")return true;
    const start=new Date(session.startAt),inside=start>=rangeStart&&start<rangeEnd;
    const keep=!inside||session.status!=="pending"||eventIds.has(session.googleEventId);
    if(!keep)changed=true;
    return keep;
  });
  const byEvent=new Map(next.filter(session=>session.googleEventId).map(session=>[session.googleEventId,session]));
  events.forEach(event=>{
    const start=new Date(event.startAt),end=new Date(event.endAt);if(Number.isNaN(start.getTime())||Number.isNaN(end.getTime()))return;
    const currentSession=byEvent.get(event.id),status=currentSession?.status&&currentSession.status!=="pending"?currentSession.status:"pending";
    const patch={googleEventId:event.id,source:"google-focusmate",label:event.title,startAt:start.toISOString(),durationSecs:Math.max(60,Math.round((end-start)/1000)),status,htmlLink:event.htmlLink||null};
    if(currentSession){
      const differs=Object.entries(patch).some(([key,value])=>currentSession[key]!==value);
      if(differs){const index=next.indexOf(currentSession);next[index]={...currentSession,...patch,updatedAt:payload.syncedAt||new Date().toISOString()};changed=true;}
    }else{
      const imported={id:`google-${event.id}`,...patch,tasks:[],importedAt:payload.syncedAt||new Date().toISOString()};next.push(imported);byEvent.set(event.id,imported);changed=true;
    }
  });
  localStorage.setItem(GOOGLE_SYNC_KEY,payload.syncedAt||new Date().toISOString());
  if(!changed)return false;
  writeSessions(next);ipcRenderer.send("session-created");updateSessionSummary();renderHome();return true;
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
  ipcRenderer.send("data-changed");
}

function readProjectTasks() {
  const value = readJson(DAY_TASKS_KEY, []);
  return Array.isArray(value) ? value : [];
}

function linkedProjectTaskId(task) {
  return task.projectTaskId || task.movedFromDayTaskId || null;
}

function freshId() { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }

function sessionTaskParentId(task, projectTaskMap = new Map()) {
  if (task.parentSessionTaskId) return task.parentSessionTaskId;
  const parentProjectTaskId=projectTaskMap.get(linkedProjectTaskId(task))?.parentTaskId;
  if (!parentProjectTaskId) return null;
  return readTasks().find(item=>linkedProjectTaskId(item)===parentProjectTaskId)?.id || null;
}

function cloneTasksForCarry(tasks, sourceSessionId) {
  const ids=new Map(tasks.map(task=>[task.id,freshId()]));
  return tasks.map(task=>({...task,id:ids.get(task.id),parentSessionTaskId:ids.get(task.parentSessionTaskId)||null,done:false,completedAt:null,focusedSecs:0,carriedFromSessionId:sourceSessionId}));
}

function syncProjectTasksFromSession(sessionTasks = readTasks(), sessionId = activePendingSessionId) {
  if (!sessionId) return;
  const byProjectTask = new Map(sessionTasks.filter(task => linkedProjectTaskId(task)).map(task => [linkedProjectTaskId(task), task]));
  if (!byProjectTask.size) return;
  let changed = false;
  const next = readProjectTasks().map(projectTask => {
    const sessionTask = byProjectTask.get(projectTask.id);
    if (!sessionTask) return projectTask;
    const sessionFocus = { ...(projectTask.sessionFocus || {}) };
    sessionFocus[sessionId] = Math.max(0, Number(sessionTask.focusedSecs) || 0);
    const sessionIds = [...new Set([...(projectTask.sessionIds || []), sessionId])];
    const updated = {
      ...projectTask,
      text: sessionTask.text || projectTask.text,
      priority: sessionTask.priority || projectTask.priority,
      done: Boolean(sessionTask.done || projectTask.done),
      completedAt: sessionTask.done ? (sessionTask.completedAt || projectTask.completedAt || new Date().toISOString()) : projectTask.completedAt,
      sessionFocus,
      sessionIds,
      sessionCount: sessionIds.length,
      focusedSecs: Object.values(sessionFocus).reduce((sum, secs) => sum + (Number(secs) || 0), 0),
      updatedAt: new Date().toISOString(),
    };
    changed = true;
    return updated;
  });
  if (changed) {
    localStorage.setItem(DAY_TASKS_KEY, JSON.stringify(next));
    ipcRenderer.send("data-changed");
  }
}

function refreshActivePlanFromSessionRecord() {
  if (!activePendingSessionId) return;
  const session = readSessions().find(item => item.id === activePendingSessionId);
  if (!session || !Array.isArray(session.tasks)) return;
  const current = readTasks();
  if (JSON.stringify(current) === JSON.stringify(session.tasks)) return;
  localStorage.setItem(TASKS_KEY, JSON.stringify(session.tasks));
  const validIds = new Set(session.tasks.filter(task => !task.done && !task.deleted).map(task => task.id));
  if (activeTaskId && !validIds.has(activeTaskId)) activeTaskId = session.tasks.find(task => !task.done && !task.deleted)?.id || null;
  renderInlineTasks();
  renderCurrentTask();
}

function refreshActivePlanFromCanonicalTasks() {
  if (!activePendingSessionId) return;
  const canonical = new Map(readProjectTasks().map(task => [task.id, task]));
  let changed = false;
  const next = readTasks().map(task => {
    const source = canonical.get(linkedProjectTaskId(task));
    if (!source) return task;
    const patch = { text:source.text, notes:source.notes || "", priority:source.priority || "medium", category:source.category || "inbox", done:Boolean(source.done), completedAt:source.completedAt || null };
    if (Object.entries(patch).every(([key,value]) => task[key] === value)) return task;
    changed = true;
    return { ...task, ...patch };
  });
  if (!changed) return;
  localStorage.setItem(TASKS_KEY, JSON.stringify(next));
  updateSession(activePendingSessionId, { tasks:next });
  renderInlineTasks();
  renderCurrentTask();
}

function ensureCanonicalSessionTasks(session) {
  if (!session) return [];
  const canonical = readProjectTasks(), known = new Set(canonical.map(task=>task.id));
  let changed = false;
  const linked = (Array.isArray(session.tasks) ? session.tasks : []).map(task => {
    if (linkedProjectTaskId(task)) return task;
    const canonicalId = `session-task-${task.id}`;
    if (!known.has(canonicalId)) {
      canonical.push({ id:canonicalId, text:task.text || "Tarea", done:Boolean(task.done), notes:task.notes || "", priority:task.priority || "medium", deleted:Boolean(task.deleted), category:task.category || "actionable", dueDate:null, mode:session.workArea || "routine", projectId:session.projectId || null, focusedSecs:Number(task.focusedSecs)||0, sessionFocus:{[session.id]:Number(task.focusedSecs)||0}, sessionIds:[session.id], sessionCount:1, createdAt:task.createdAt || new Date().toISOString(), migratedFromSessionTask:true });
      known.add(canonicalId);
    }
    changed = true;
    return { ...task, projectTaskId:canonicalId, movedFromDayTaskId:canonicalId };
  });
  if (changed) {
    localStorage.setItem(DAY_TASKS_KEY,JSON.stringify(canonical));
    updateSession(session.id,{tasks:linked});
    ipcRenderer.send("data-changed");
  }
  return linked;
}

function reconcileProjectTaskHistory() {
  const contributions = new Map();
  readSessions().forEach(session => (session.tasks || []).forEach(task => {
    const taskId = linkedProjectTaskId(task);
    if (!taskId) return;
    if (!contributions.has(taskId)) contributions.set(taskId, []);
    contributions.get(taskId).push({ session, task });
  }));
  if (!contributions.size) return;
  let changed = false;
  const next = readProjectTasks().map(projectTask => {
    const records = contributions.get(projectTask.id);
    if (!records?.length) return projectTask;
    const sessionFocus = { ...(projectTask.sessionFocus || {}) };
    records.forEach(({ session, task }) => { sessionFocus[session.id] = Math.max(Number(sessionFocus[session.id]) || 0, Number(task.focusedSecs) || 0); });
    const sessionIds = [...new Set([...(projectTask.sessionIds || []), ...records.map(record => record.session.id)])];
    const completed = records.find(record => record.task.done);
    changed = true;
    return {
      ...projectTask,
      done: Boolean(projectTask.done || completed),
      completedAt: projectTask.completedAt || completed?.task.completedAt || null,
      sessionFocus,
      sessionIds,
      sessionCount: sessionIds.length,
      focusedSecs: Object.values(sessionFocus).reduce((sum, secs) => sum + (Number(secs) || 0), 0),
    };
  });
  if (changed) localStorage.setItem(DAY_TASKS_KEY, JSON.stringify(next));
}

function sessionTaskElapsed(task, now = Date.now()) {
  const stored = Math.max(0, Number(task?.focusedSecs) || 0);
  return task?.id === activeTaskId && activeTaskStartedAt && timerRunning && !breakActive
    ? stored + Math.max(0, Math.floor((now - activeTaskStartedAt.getTime()) / 1000))
    : stored;
}

function checkpointActiveTaskTime(now = new Date()) {
  if (!activeTaskId || !activeTaskStartedAt || !timerRunning || breakActive) return;
  const delta = Math.max(0, Math.floor((now - activeTaskStartedAt) / 1000));
  if (!delta) return;
  const next = readTasks().map(task => task.id === activeTaskId ? { ...task, focusedSecs: (Number(task.focusedSecs) || 0) + delta } : task);
  activeTaskStartedAt = now;
  lastTaskCheckpointAt = now.getTime();
  writeTasks(next);
  if (activePendingSessionId) { updateSession(activePendingSessionId, { tasks: next, activeTaskId }); lastSessionPersistAt = now.getTime(); }
  syncProjectTasksFromSession(next);
}

function chooseDefaultActiveTask() {
  const first = readTasks().find(task => !task.deleted && !task.done);
  activeTaskId = first?.id || null;
  activeTaskStartedAt = activeTaskId && timerRunning && !breakActive ? new Date() : null;
  renderCurrentTask();
}

function setActiveTask(taskId) {
  if (taskId === activeTaskId) return;
  checkpointActiveTaskTime();
  activeTaskId = readTasks().some(task => task.id === taskId && !task.done && !task.deleted) ? taskId : null;
  activeTaskStartedAt = activeTaskId && timerRunning && !breakActive ? new Date() : null;
  if (activePendingSessionId) updateSession(activePendingSessionId, { activeTaskId });
  renderInlineTasks();
  renderCurrentTask();
}

function renderCurrentTask() {
  const task = readTasks().find(item => item.id === activeTaskId && !item.done && !item.deleted);
  const box = $("currentTaskLabel");
  if (!box) return;
  box.classList.toggle("hidden", !task);
  if (!task) return;
  $("currentTaskText").textContent = task.text;
  $("currentTaskTime").textContent = formatTaskDuration(sessionTaskElapsed(task));
}

function formatTaskDuration(secs) {
  const safe = Math.max(0, Math.floor(Number(secs) || 0));
  if (safe < 60) return `${safe} s`;
  const hours = Math.floor(safe / 3600), mins = Math.floor((safe % 3600) / 60);
  return hours ? `${hours} h ${mins} min` : `${mins} min`;
}

function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; }
}

function readDailyPriorities() {
  const value = readJson(DAILY_PRIORITIES_KEY, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function syncDueTasksToDailyPriorities() {
  // Deadlines and daily priorities are deliberately independent. Older builds
  // linked every task due today here; keeping this as a no-op prevents that data
  // model from being reintroduced while remaining compatible with old calls.
}

function prioritiesForToday() {
  const items = readDailyPriorities()[todayKey()];
  return Array.isArray(items) ? items.filter(item => item && String(item.text || "").trim()) : [];
}

function hasDailyPriorities() {
  return prioritiesForToday().filter(item => (item.kind || "main") === "main").length >= 3;
}

function addDailyPriorityInput(value = "") {
  const row = document.createElement("div");
  row.className = "daily-priority-row";
  row.innerHTML = `<span class="daily-priority-number"></span><input class="daily-priority-input" maxlength="180" placeholder="Tarea prioritaria" /><button class="daily-priority-remove" type="button" title="Quitar">&times;</button>`;
  row.querySelector("input").value = value;
  row.querySelector(".daily-priority-remove").addEventListener("click", () => {
    if ($("dailyPriorityList").children.length <= 3) return;
    row.remove();
    renumberDailyPriorities();
    resizeWindow();
  });
  $("dailyPriorityList").appendChild(row);
  renumberDailyPriorities();
}

function renumberDailyPriorities() {
  [...$("dailyPriorityList").children].forEach((row, index) => {
    row.querySelector(".daily-priority-number").textContent = String(index + 1);
  });
}

function showDailyPrioritiesPanel() {
  $("dailyPriorityList").innerHTML = "";
  const existing = prioritiesForToday();
  (existing.length ? existing : [{ text: "" }, { text: "" }, { text: "" }]).forEach(item => addDailyPriorityInput(item.text));
  while ($("dailyPriorityList").children.length < 3) addDailyPriorityInput();
  showPanel("panelDailyPriorities");
  $("dailyPriorityList").querySelector("input")?.focus();
}

function requireDailyPriorities() {
  return true;
}

function saveDailyPriorities() {
  const texts = [...document.querySelectorAll(".daily-priority-input")].map(input => input.value.trim()).filter(Boolean);
  if (texts.length < 3) {
    $("dailyPriorityError").textContent = "Completá al menos 3 tareas prioritarias.";
    $("dailyPriorityError").classList.remove("hidden");
    resizeWindow();
    return;
  }
  const date = todayKey();
  const existingPlan = readDailyPriorities();
  const priorItems = Array.isArray(existingPlan[date]) ? existingPlan[date] : [];
  const items = texts.map((text, index) => ({
    id: priorItems[index]?.id || `priority-${date}-${Date.now()}-${index}`,
    text,
    createdAt: priorItems[index]?.createdAt || new Date().toISOString(),
  }));
  localStorage.setItem(DAILY_PRIORITIES_KEY, JSON.stringify({ ...existingPlan, [date]: items }));

  const dayTasks = readJson(DAY_TASKS_KEY, []);
  const safeDayTasks = Array.isArray(dayTasks) ? dayTasks : [];
  const existingIds = new Set(safeDayTasks.map(task => task.dailyPriorityId).filter(Boolean));
  items.forEach(item => {
    if (existingIds.has(item.id)) return;
    safeDayTasks.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text: item.text,
      done: false,
      notes: "",
      priority: "high",
      deleted: false,
      category: "actionable",
      dueDate: date,
      mode: "work",
      projectId: null,
      dailyPriorityId: item.id,
      dailyPriorityDate: date,
      createdAt: new Date().toISOString(),
    });
  });
  localStorage.setItem(DAY_TASKS_KEY, JSON.stringify(safeDayTasks));
  ipcRenderer.send("data-changed");
  $("dailyPriorityError").classList.add("hidden");
  showPanel("panelSetup");
}

function resolvePriorityTask(item, tasks = readProjectTasks()) {
  const taskId = item.taskId || item.sourceDayTaskId;
  return tasks.find(task => (task.id === taskId || task.dailyPriorityId === item.id) && !task.deleted) || null;
}

function renderHomePriorities() {
  const list = $("homePriorityList");
  if (!list) return;
  const tasks = readProjectTasks();
  const items = prioritiesForToday().sort((a, b) => (Number(a.slot) || 99) - (Number(b.slot) || 99));
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = '<div class="home-item-empty">Elegí las tres cosas que harían exitoso el día.</div>';
    return;
  }
  items.forEach((item, index) => {
    const task = resolvePriorityTask(item, tasks);
    const done = Boolean(task?.done || item.completedAt);
    const row = document.createElement("div");
    row.className = `home-item ${done ? "done" : ""} ${(item.kind === "additional" || index > 2) ? "additional" : ""}`;
    row.innerHTML = `<button type="button" aria-label="${done ? "Reabrir" : "Completar"}">${done ? "✓" : ""}</button><span></span><button class="home-item-delete" type="button" title="Eliminar tarea">×</button>`;
    row.querySelector("span").textContent = task?.text || item.text || "Tarea eliminada";
    row.querySelector("button").disabled = !task;
    row.querySelector("button").addEventListener("click", () => togglePriorityTask(item, task, !done));
    row.querySelector(".home-item-delete").disabled = false;
    row.querySelector(".home-item-delete").addEventListener("click", () => deletePriorityTask(item, task));
    list.appendChild(row);
  });
}

function deletePriorityTask(item, task) {
  const label = task?.text || item.text || item.snapshotText || "esta prioridad";
  const message = task
    ? `¿Eliminar “${label}”? Se quitará también de las sesiones donde esté asignada.`
    : `Esta prioridad quedó sin una tarea accesible. ¿Quitar “${label}” del día?`;
  if (!window.confirm(message)) return;
  const taskId = task?.id || item.taskId || item.sourceDayTaskId;
  if (taskId) {
    const deletedAt = new Date().toISOString();
    localStorage.setItem(DAY_TASKS_KEY, JSON.stringify(readProjectTasks().map(entry => entry.id === taskId ? { ...entry, deleted:true, deletedAt, updatedAt:deletedAt } : entry)));
    const withoutTask = list => (list || []).filter(entry => entry.id !== taskId && linkedProjectTaskId(entry) !== taskId);
    writeTasks(withoutTask(readTasks()));
    writeSessions(readSessions().map(session => ({ ...session, tasks:withoutTask(session.tasks) })));
  }
  const plan = readDailyPriorities();
  plan[todayKey()] = (plan[todayKey()] || []).filter(entry => entry.id !== item.id);
  localStorage.setItem(DAILY_PRIORITIES_KEY, JSON.stringify(plan));
  ipcRenderer.send("data-changed");
  renderHome();
}

function togglePriorityTask(item, task, done) {
  if (!task) return;
  const completedAt = done ? new Date().toISOString() : null;
  const nextTasks = readProjectTasks().map(entry => entry.id === task.id ? { ...entry, done, completedAt, updatedAt: new Date().toISOString() } : entry);
  localStorage.setItem(DAY_TASKS_KEY, JSON.stringify(nextTasks));
  const updateLinked = list => list.map(entry => linkedProjectTaskId(entry) === task.id ? { ...entry, done, completedAt } : entry);
  writeTasks(updateLinked(readTasks()));
  writeSessions(readSessions().map(session => ({ ...session, tasks: updateLinked(session.tasks || []) })));
  const plan = readDailyPriorities();
  plan[todayKey()] = (plan[todayKey()] || []).map(entry => entry.id === item.id ? { ...entry, completedAt } : entry);
  localStorage.setItem(DAILY_PRIORITIES_KEY, JSON.stringify(plan));
  ipcRenderer.send("data-changed");
  renderHomePriorities();
}

function currentHabitPhase(date = new Date()) {
  const hour = date.getHours() + date.getMinutes() / 60;
  if (hour >= 4 && hour < 12) return { id: "morning", label: "Mañana", range: "04:00–12:00" };
  if (hour >= 12 && hour < 19) return { id: "afternoon", label: "Tarde", range: "12:00–19:00" };
  return { id: "night", label: "Noche", range: "19:00–04:00" };
}

function habitIsDone(habit, logs) {
  const log = logs[`${habit.id}:${todayKey()}`] || {};
  return Boolean(log.justified || Number(log.count) >= Math.max(1, Number(habit.targetCount) || 1));
}

function renderHomeHabits() {
  const phase = currentHabitPhase();
  $("homeHabitPhase").textContent = phase.label;
  $("homeHabitPhaseRange").textContent = phase.range;
  const list = $("homeHabitList"), habits = readJson(HABITS_KEY, []), logs = readJson(HABIT_LOGS_KEY, {}), day = new Date().getDay();
  const visible = (Array.isArray(habits) ? habits : []).filter(habit => !habit.archived && (!habit.days?.length || habit.days.includes(day)) && ((habit.kind === "phase" && habit.phase === phase.id) || habit.kind === "daily"));
  list.innerHTML = "";
  if (!visible.length) { list.innerHTML = '<div class="home-item-empty">No hay hábitos para este período.</div>'; return; }
  visible.slice(0, 5).forEach(habit => {
    const done = habitIsDone(habit, logs), row = document.createElement("div");
    row.className = `home-item ${done ? "done" : ""}`;
    row.innerHTML = `<button type="button">${done ? "✓" : ""}</button><span></span>`;
    row.querySelector("span").textContent = habit.name;
    row.querySelector("button").addEventListener("click", () => quickCompleteHabit(habit, done));
    list.appendChild(row);
  });
}

function quickCompleteHabit(habit, wasDone) {
  const logs = readJson(HABIT_LOGS_KEY, {}), key = `${habit.id}:${todayKey()}`, current = logs[key] || { count: 0, events: [] }, at = new Date().toISOString();
  logs[key] = { ...current, count: wasDone ? 0 : Math.max(1, Number(habit.targetCount) || 1), justified: false, updatedAt: at, events: [...(current.events || []), { at, type: wasDone ? "reopen" : "complete", source: "home" }] };
  localStorage.setItem(HABIT_LOGS_KEY, JSON.stringify(logs));
  ipcRenderer.send("data-changed");
  renderHomeHabits();
}

function renderBetweenSessions() {
  const card = $("homeGap"), next = getPendingSessions().find(session => new Date(session.startAt) > new Date());
  if (!card || timerRunning || waiting || !next) { card?.classList.add("hidden"); return; }
  const usableMinutes = Math.floor((new Date(next.startAt) - Date.now()) / 60000) - 1;
  if (usableMinutes <= 1) {
    card.classList.remove("hidden");
    $("homeGapTitle").textContent = "Tu próxima sesión empieza en breve";
    $("homeGapCopy").textContent = `${fmtHour(new Date(next.startAt))} · preparate con calma.`;
    $("useGapBtn").classList.add("hidden");
    return;
  }
  card.classList.remove("hidden"); $("useGapBtn").classList.remove("hidden");
  $("homeGapTitle").textContent = `Tenés ${usableMinutes} minutos libres`;
  $("homeGapCopy").textContent = `Próxima sesión: ${next.projectName || next.workAreaName || "Focusmate"} · ${fmtHour(new Date(next.startAt))}. También podés descansar.`;
  $("useGapBtn").dataset.nextStart = next.startAt;
}

function renderHome() {
  renderHomePriorities();
  renderHomeHabits();
  renderBetweenSessions();
  resizeWindow();
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
  ipcRenderer.send("data-changed");
}

function readProjects() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROJECTS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readPersonalProjects() {
  try { const parsed=JSON.parse(localStorage.getItem(PERSONAL_PROJECTS_KEY)||"[]"); return Array.isArray(parsed)?parsed:[]; } catch { return []; }
}

function assignableProjects(area = null) {
  const videos=readProjects(), personal=readPersonalProjects().map(project=>({...project,title:project.name,workChannelId:"routine",type:"personal-project"}));
  const all=area==="routine"?[...videos,...personal]:videos;
  return all.filter(project=>!project.archived && (!area || projectWorkChannel(project)===area));
}

function readWorkChannels() {
  let channels = [];
  try { const parsed = JSON.parse(localStorage.getItem(WORK_CHANNELS_KEY) || "[]"); channels = Array.isArray(parsed) ? parsed : []; } catch {}
  [{ id: "personal", name: "JustJuani", order: 0 }, { id: "work", name: "Laburo", order: 1 }, { id: "routine", name: "Personal", order: 999, hiddenFromVideos: true }].forEach(item => { if (!channels.some(channel => channel.id === item.id)) channels.push(item); });
  return channels.sort((a, b) => (a.order || 0) - (b.order || 0));
}
function projectWorkChannel(project) { return project?.workChannelId || project?.mode || "personal"; }

function workAreaLabel(value) {
  return readWorkChannels().find(channel => channel.id === value)?.name || (value === "work" ? "Laburo" : "JustJuani");
}

function fillWorkAreaSelect(select, selectedArea) {
  if (!select) return;
  select.innerHTML = readWorkChannels().map(channel => `<option value="${channel.id}">${channel.name}</option>`).join("");
  select.value = readWorkChannels().some(channel => channel.id === selectedArea) ? selectedArea : "personal";
}

function fillVideoSelect(select, area, selectedId = "") {
  if (!select) return;
  const projects = assignableProjects(area);
  const current = selectedId || select.value;
  select.innerHTML = `<option value="">Trabajo general de ${workAreaLabel(area)}</option>`;
  projects.forEach(project => {
      const option = document.createElement("option");
      option.value = project.id;
      option.textContent = project.title;
      select.appendChild(option);
  });
  select.value = projects.some(project => project.id === current && projectWorkChannel(project) === area) ? current : "";
}

function renderProjectSelects(selectedId = "", selectedArea = null) {
  const project = [...readProjects(),...readPersonalProjects().map(item=>({...item,title:item.name,workChannelId:"routine"}))].find(item => item.id === selectedId);
  const area = selectedArea || (project ? projectWorkChannel(project) : null) || localStorage.getItem("justtimer.workArea.v1") || "personal";
  [$("sessionWorkArea"), $("reviewWorkArea")].filter(Boolean).forEach(select => fillWorkAreaSelect(select, area));
  fillVideoSelect($("sessionProjectSelect"), area, selectedId);
  fillVideoSelect($("reviewProject"), area, selectedId);
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

function nextQuarters(n = 4) {
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
      const drawer = $("inlineTasksPanel");
      const drawerBottom = drawer && !drawer.classList.contains("hidden") ? drawer.getBoundingClientRect().bottom : 0;
      const total = Math.ceil(Math.max(activePanel.offsetTop + bottom + paddingBottom, drawerBottom + 8));
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
  ["panelSetup", "panelWait", "panelTimer", "panelReview", "inlineTasksPanel"].forEach(id => ro.observe($(id)));
}

function showPanel(id) {
  ["panelSetup", "panelWait", "panelTimer", "panelReview"].forEach(panelId => {
    $(panelId).classList.toggle("hidden", panelId !== id);
  });
  if (!["panelSetup", "panelTimer"].includes(id)) $("inlineTasksPanel").classList.add("hidden");
  resizeWindow();
}

function buildQuarterButtons() {
  const grid = $("quarterGrid");
  grid.innerHTML = "";
  const now = new Date();
  quarterSlotsVersion = Math.floor(now.getTime() / (15 * 60 * 1000));

  nextQuarters(4).forEach(time => {
    const btn = document.createElement("button");
    btn.className = "quarter-btn" + (time <= now ? " past" : "");
    btn.textContent = fmtHour(time);
    btn.addEventListener("click", () => selectQuarter(time, btn));
    grid.appendChild(btn);
  });

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

function updateSessionSummary(pending = getPendingSessions()) {
  const today = new Date();
  const todayCount = pending.filter(session => (session.workArea || "personal") !== "routine" && session.workAreaName !== "Personal" && isSameDay(new Date(session.startAt), today)).length;
  $("sessionSummary").textContent = todayCount === 1
    ? "Tienes 1 sesion hoy"
    : todayCount > 1
      ? `Tienes ${todayCount} sesiones hoy`
      : "";

  renderNextSession(pending[0]);
  renderBetweenSessions();
  const signature = pending.slice(0, 4).map(session => `${session.id}:${session.startAt}:${session.durationSecs}:${session.workArea}:${session.projectId}`).join("|");
  if (signature !== pendingSessionsSignature) {
    pendingSessionsSignature = signature;
    renderPendingSessions(pending);
    resizeWindow();
  }
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
    const channel = readWorkChannels().find(item => item.id === (session.workArea || "personal")) || { name: workAreaLabel(session.workArea), avatarUrl: null };
    const avatar = channel.avatarUrl ? `<img src="${channel.avatarUrl}" alt="" />` : `<b>${channel.id === "routine" ? "J" : (channel.name || "J").slice(0, 1).toUpperCase()}</b>`;
    row.innerHTML = `
      <span class="pending-avatar">${avatar}</span><span class="pending-copy"><strong>${fmtHour(start)} · ${Math.round(session.durationSecs / 60)} min</strong><small>${channel.name}${session.projectName ? ` · ${session.projectName}` : ""}</small></span>
      <button type="button" data-id="${session.id}" title="Cancelar">&times;</button>
    `;
    list.appendChild(row);
  });
  resizeWindow();
}

function autoStartPendingSessions(pending = getPendingSessions()) {
  if (timerRunning || waiting) return;

  const due = pending.find(session => new Date(session.startAt) <= new Date());
  if (!due) return;
  if (!requireDailyPriorities()) return;

  activePendingSessionId = due.id;
  const backlog = readTasks().filter(task => !task.done && !task.deleted);
  const planned = ensureCanonicalSessionTasks(due).map(task => ({ ...task, projectTaskId: linkedProjectTaskId(task) }));
  const plannedLinks = new Set(planned.map(task => linkedProjectTaskId(task) || task.id));
  writeTasks([...planned, ...backlog.filter(task => !plannedLinks.has(linkedProjectTaskId(task) || task.id)).map(task => ({ ...task, id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, focusedSecs: 0 }))]);
  updateSession(due.id, { status: "running" });
  durationSecs = due.durationSecs;
  startAt = new Date(due.startAt);
  schedule(startAt);
}

function restoreActiveSession() {
  const saved = readJson(ACTIVE_SESSION_KEY, null);
  if (!saved?.sessionId) return false;
  const session = readSessions().find(item => item.id === saved.sessionId);
  const restoredStart = new Date(saved.startAt || session?.startAt);
  const restoredDuration = Math.max(0, Number(saved.durationSecs || session?.durationSecs) || 0);
  if (!session || Number.isNaN(restoredStart.getTime()) || !restoredDuration) {
    writeActiveSession(null);
    return false;
  }
  const elapsed = Math.max(0, Math.floor((Date.now() - restoredStart.getTime()) / 1000));
  if (elapsed >= restoredDuration || session.status === "done" || session.status === "cancelled") {
    if (session.status === "running") updateSession(session.id, { status:"done", completedAt:new Date(restoredStart.getTime() + restoredDuration * 1000).toISOString(), endedAt:new Date(restoredStart.getTime() + restoredDuration * 1000).toISOString() });
    writeActiveSession(null);
    return false;
  }
  activePendingSessionId = session.id;
  durationSecs = restoredDuration;
  startAt = restoredStart;
  breakSegments = Array.isArray(saved.breakSegments) ? saved.breakSegments : (Array.isArray(session.breakSegments) ? session.breakSegments : []);
  breakActive = Boolean(saved.breakActive);
  activeBreakStart = saved.activeBreakStart ? new Date(saved.activeBreakStart) : null;
  if (breakActive && activeBreakStart && !Number.isNaN(activeBreakStart.getTime())) {
    document.body.classList.add("break-mode");
    $("breakBtn")?.classList.add("active");
  } else {
    breakActive = false;
    activeBreakStart = null;
  }
  localStorage.setItem(TASKS_KEY, JSON.stringify(ensureCanonicalSessionTasks(session)));
  schedule(restoredStart);
  return true;
}

function startSelectedNow() {
  if (!requireDailyPriorities()) return;
  if (!durationSecs) {
    showError("Primero elegi la duracion");
    return;
  }
  schedule(selectedQuarter || new Date());
}

function createRunningSession(startDt) {
  const sessions = readSessions();
  const workArea = "routine";
  const projectId = null;
  const project = readProjects().find(item => item.id === projectId);
  const session = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    startAt: startDt.toISOString(),
    durationSecs,
    label: "",
    workArea,
    workAreaName: workAreaLabel(workArea),
    projectId,
    projectName: project?.title || null,
    status: "running",
    tasks: readTasks(),
    notes: "",
    energy: null,
    breakSegments: [],
    breakTotalSecs: 0,
    createdAt: new Date().toISOString(),
  };
  sessions.push(session);
  writeSessions(sessions);
  activePendingSessionId = session.id;
  syncProjectTasksFromSession(session.tasks, session.id);
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
  if (!requireDailyPriorities()) return;
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
  const savedActive = readSessions().find(session => session.id === activePendingSessionId)?.activeTaskId;
  activeTaskId = readTasks().some(task => task.id === savedActive && !task.done && !task.deleted) ? savedActive : (readTasks().find(task => !task.done && !task.deleted)?.id || null);
  activeTaskStartedAt = activeTaskId && !breakActive ? new Date() : null;
  lastTaskCheckpointAt = Date.now();
  playSound("start");
  showPanel("panelTimer");
  renderCurrentTask();
  tickTimer();
}

function tickTimer() {
  if (!timerRunning) return;

  const remaining = Math.max(0, (endAt - Date.now()) / 1000);
  const liveTasks = readTasks();
  if (!liveTasks.some(task => task.id === activeTaskId && !task.done && !task.deleted)) {
    activeTaskId = liveTasks.find(task => !task.done && !task.deleted)?.id || null;
    activeTaskStartedAt = activeTaskId && !breakActive ? new Date() : null;
  }
  $("timerLabel").textContent = fmtCountdown(remaining);
  $("timerLabel").style.color = remaining <= 60 ? "#ff4444" : "white";
  $("progressFill").style.width = `${((durationSecs - remaining) / durationSecs) * 100}%`;
  renderCurrentTask();
  if (Date.now() - lastTaskCheckpointAt >= 5000) checkpointActiveTaskTime();
  if (remaining <= 60 && !timerWarnPlayed) {
    timerWarnPlayed = true;
    playSound("sound_warn");
  }
  if (activePendingSessionId && Date.now() - lastSessionPersistAt >= 5000) {
    updateSession(activePendingSessionId, {
      breakSegments,
      breakTotalSecs: getBreakTotalSecs(),
      tasks: readTasks(),
      activeTaskId,
    });
    lastSessionPersistAt = Date.now();
  }

  if (remaining <= 0) {
    checkpointActiveTaskTime();
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
  const current = readSessions().find(session => session.id === activePendingSessionId);
  renderProjectSelects(current?.projectId || "", current?.workArea || null);
  renderReviewTasks();
  renderReviewCarryOptions(current);
  $("reviewNotes").value = "";
  reviewEnergy = 5;
  buildEnergyButtons();
  showPanel("panelReview");
}

function nextPendingSession(currentSession) {
  const currentStart = new Date(currentSession?.startAt || 0).getTime();
  return readSessions()
    .filter(session => session.id !== currentSession?.id && session.status === "pending" && new Date(session.startAt).getTime() > currentStart)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))[0] || null;
}

function renderReviewCarryOptions(currentSession) {
  const pending = readTasks().filter(task => !task.deleted && !task.done);
  const row = $("reviewCarryRow"), next = nextPendingSession(currentSession);
  row.classList.toggle("hidden", !pending.length);
  if (!pending.length) return;
  const nextOption = $("reviewCarryMode").querySelector('option[value="next"]');
  nextOption.disabled = !next;
  $("reviewCarryMode").value = next ? "next" : "pending";
  $("reviewCarryHelp").textContent = next
    ? `Próxima: ${new Date(next.startAt).toLocaleString("es-AR", { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
    : "No hay otra sesión futura: quedarán pendientes dentro del video.";
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
      <span></span><small class="review-task-time"></small>
      <textarea class="review-task-note" rows="2" placeholder="nota de tarea"></textarea>
    `;
    row.querySelector("span").textContent = task.text;
    row.querySelector(".review-task-time").textContent = formatTaskDuration(sessionTaskElapsed(task));
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
  checkpointActiveTaskTime();
  const reviewedTasks = skip ? readTasks() : collectReviewTasks();
  const current = activePendingSessionId ? readSessions().find(session => session.id === activePendingSessionId) : null;
  const unfinished = reviewedTasks.filter(task => !task.deleted && !task.done);
  const next = current && !skip && $("reviewCarryMode").value === "next" ? nextPendingSession(current) : null;
  const keepPending = cloneTasksForCarry(unfinished, activePendingSessionId);
  if (activePendingSessionId) {
    const workArea = skip ? (current?.workArea || "personal") : ($("reviewWorkArea").value || "personal");
    const selectedProjectId = skip ? (current?.projectId || null) : ($("reviewProject").value || null);
    updateSession(activePendingSessionId, {
      status: "done",
      completedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      label: "",
      workArea,
      workAreaName: workAreaLabel(workArea),
      projectId: selectedProjectId,
      projectName: assignableProjects(workArea).find(project => project.id === selectedProjectId)?.title || null,
      notes: skip ? "" : $("reviewNotes").value.trim(),
      energy: skip ? null : reviewEnergy,
      tasks: reviewedTasks,
      breakSegments,
      breakTotalSecs: getBreakTotalSecs(),
    });
    syncProjectTasksFromSession(reviewedTasks, activePendingSessionId);
    if (next && unfinished.length) {
      const existingLinks = new Set((next.tasks || []).map(task => linkedProjectTaskId(task) || task.id));
      const carried = cloneTasksForCarry(unfinished.filter(task => !existingLinks.has(linkedProjectTaskId(task) || task.id)), activePendingSessionId).map(task=>({ ...task, projectTaskId:linkedProjectTaskId(task) }));
      updateSession(next.id, { tasks: [...(next.tasks || []), ...carried] });
      syncProjectTasksFromSession(carried, next.id);
    }
  }
  activeTaskId = null;
  activeTaskStartedAt = null;
  activePendingSessionId = null;
  writeActiveSession(null);
  writeTasks(next ? [] : keepPending);
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
    activeTaskStartedAt = activeTaskId ? new Date() : null;
  } else {
    checkpointActiveTaskTime();
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
  checkpointActiveTaskTime(now);
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
    syncProjectTasksFromSession(readTasks(), activePendingSessionId);
    ipcRenderer.send("session-created");
  }

  timerRunning = false;
  waiting = false;
  activePendingSessionId = null;
  activeTaskId = null;
  activeTaskStartedAt = null;
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

function openCalendar() {
  ipcRenderer.send("open-calendar");
}

function openTasks() {
  ipcRenderer.send("open-day-tasks");
}

function priorityLabel(priority) { return priority === "high" ? "Urgente" : priority === "low" ? "Baja" : "Normal"; }
function persistInlineTasks(nextTasks) {
  writeTasks(nextTasks);
  if (activePendingSessionId) updateSession(activePendingSessionId, { tasks: nextTasks });
  syncProjectTasksFromSession(nextTasks);
  renderInlineTasks();
  renderCurrentTask();
}
function addInlineSubtask(parentTask, text) {
  const value=String(text||"").trim(); if(!value)return;
  if(parentTask.id===activeTaskId)checkpointActiveTaskTime();
  const nowIso=new Date().toISOString(), projectTasks=readProjectTasks(), parentProjectTaskId=linkedProjectTaskId(parentTask), parentProjectTask=projectTasks.find(task=>task.id===parentProjectTaskId);
  let projectTaskId=null;
  if(parentProjectTask){
    projectTaskId=freshId();
    const projectSubtask={id:projectTaskId,parentTaskId:parentProjectTask.id,text:value,done:false,notes:"",priority:parentTask.priority||parentProjectTask.priority||"medium",deleted:false,category:parentProjectTask.category||"inbox",dueDate:parentProjectTask.dueDate||null,mode:parentProjectTask.mode||"personal",projectId:parentProjectTask.projectId,focusedSecs:0,sessionIds:activePendingSessionId?[activePendingSessionId]:[],sessionCount:activePendingSessionId?1:0,createdAt:nowIso};
    localStorage.setItem(DAY_TASKS_KEY,JSON.stringify([...projectTasks,projectSubtask])); ipcRenderer.send("data-changed");
  }
  const sessionSubtask={id:freshId(),parentSessionTaskId:parentTask.id,parentProjectTaskId:parentProjectTaskId||null,projectTaskId,movedFromDayTaskId:projectTaskId,text:value,done:false,notes:"",priority:parentTask.priority||"medium",deleted:false,focusedSecs:0,createdAt:nowIso};
  openInlineSubtaskIds.delete(parentTask.id); inlineSubtaskDrafts.delete(parentTask.id); persistInlineTasks([...readTasks(),sessionSubtask]);
}
function renderInlineTasks() {
  const list = $("inlineTaskList"), items = readTasks().filter(task => !task.deleted), projectTaskMap=new Map(readProjectTasks().map(task=>[task.id,task]));
  list.innerHTML = "";
  if (!items.length) { list.innerHTML = '<div class="inline-task-empty">Todavía no hay tareas para esta sesión.</div>'; resizeWindow(); return; }
  const parentById=new Map(items.map(task=>[task.id,sessionTaskParentId(task,projectTaskMap)])), ordered=[],added=new Set();
  const appendBranch=task=>{if(added.has(task.id))return;added.add(task.id);ordered.push(task);items.filter(child=>parentById.get(child.id)===task.id).forEach(appendBranch);};
  items.filter(task=>!parentById.get(task.id)||!items.some(parent=>parent.id===parentById.get(task.id))).forEach(appendBranch); items.forEach(appendBranch);
  ordered.forEach(task => {
    const parentId=parentById.get(task.id), isSubtask=Boolean(parentId);
    const row = document.createElement("div"); row.className = `inline-task-row ${isSubtask?"inline-subtask":""} ${task.done ? "done" : ""} ${task.id === activeTaskId ? "active" : ""}`;
    row.draggable = !isSubtask;
    row.dataset.taskId = task.id;
    row.innerHTML = `<span class="inline-drag" title="${isSubtask?"Subtarea":"Arrastrar"}">${isSubtask?"↳":"⋮⋮"}</span><button class="inline-check" type="button">${task.done ? "✓" : ""}</button><span class="inline-task-copy"><b></b><small>${isSubtask?"Subtarea · ":""}${formatTaskDuration(sessionTaskElapsed(task))}</small></span><button class="inline-active" type="button" title="Trabajar en esta tarea">${task.id === activeTaskId ? "▶" : "▷"}</button><button class="inline-add-subtask" type="button" title="Agregar subtarea">+</button><button class="inline-priority priority-${task.priority || "medium"}" type="button">${priorityLabel(task.priority)}</button><button class="inline-delete" type="button">×</button>`;
    row.querySelector(".inline-task-copy b").textContent = task.text;
    row.querySelector(".inline-check").addEventListener("click", () => {
      if (task.id === activeTaskId) checkpointActiveTaskTime();
      const next = readTasks().map(item => item.id === task.id ? { ...item, done: !item.done, completedAt: !item.done ? new Date().toISOString() : null } : item);
      persistInlineTasks(next);
      if (task.id === activeTaskId && !task.done) chooseDefaultActiveTask();
    });
    row.querySelector(".inline-active").addEventListener("click", () => !task.done && setActiveTask(task.id));
    row.querySelector(".inline-add-subtask").addEventListener("click",()=>{openInlineSubtaskIds.has(task.id)?openInlineSubtaskIds.delete(task.id):openInlineSubtaskIds.add(task.id);renderInlineTasks();});
    row.querySelector(".inline-priority").addEventListener("click", () => { const order = ["low", "medium", "high"], next = order[(order.indexOf(task.priority || "medium") + 1) % order.length]; persistInlineTasks(readTasks().map(item => item.id === task.id ? { ...item, priority: next } : item)); });
    row.querySelector(".inline-delete").addEventListener("click", () => {
      if (task.id === activeTaskId) checkpointActiveTaskTime();
      const current=readTasks(),removeIds=new Set([task.id]);let grew=true;while(grew){grew=false;current.forEach(item=>{if(!removeIds.has(item.id)&&removeIds.has(sessionTaskParentId(item,projectTaskMap))){removeIds.add(item.id);grew=true;}});}
      persistInlineTasks(current.filter(item => !removeIds.has(item.id)));
      if (task.id === activeTaskId) chooseDefaultActiveTask();
    });
    row.addEventListener("dragstart", event => { if(isSubtask){event.preventDefault();return;}event.dataTransfer.setData("text/plain", task.id); row.classList.add("dragging"); });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", event => event.preventDefault());
    row.addEventListener("drop", event => {
      event.preventDefault();
      const sourceId = event.dataTransfer.getData("text/plain");
      const ordered = readTasks(), sourceIndex = ordered.findIndex(item => item.id === sourceId), targetIndex = ordered.findIndex(item => item.id === task.id);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
      checkpointActiveTaskTime();
      const [moved] = ordered.splice(sourceIndex, 1); ordered.splice(targetIndex, 0, moved);
      persistInlineTasks(ordered);
      chooseDefaultActiveTask();
    });
    list.appendChild(row);
    if(openInlineSubtaskIds.has(task.id)){
      const form=document.createElement("form");form.className=`inline-subtask-add ${isSubtask?"nested":""}`;form.innerHTML='<input maxlength="90" placeholder="Ej. Sacar la basura" /><button type="submit">+</button>';
      const input=form.querySelector("input");input.value=inlineSubtaskDrafts.get(task.id)||"";input.addEventListener("input",()=>inlineSubtaskDrafts.set(task.id,input.value));form.addEventListener("submit",event=>{event.preventDefault();addInlineSubtask(task,input.value);});list.appendChild(form);requestAnimationFrame(()=>input.focus());
    }
  });
  resizeWindow();
}
function toggleInlineTasks() {
  $("inlineTasksPanel").classList.toggle("hidden");
  if (!$("inlineTasksPanel").classList.contains("hidden")) renderInlineTasks();
  resizeWindow();
}

function openHabits() {
  ipcRenderer.send("open-habits");
}

$("calBtn").addEventListener("click", openCalendar);
$("projectsSetupBtn").addEventListener("click", openTasks);
$("habitsBtn").addEventListener("click", openHabits);
$("calTimerBtn").addEventListener("click", openCalendar);
$("tasksTimerBtn").addEventListener("click", toggleInlineTasks);
$("projectsTimerBtn").addEventListener("click", openTasks);
$("closeInlineTasks").addEventListener("click", toggleInlineTasks);
$("openFullTasks").addEventListener("click", openTasks);
$("inlineTaskForm").addEventListener("submit", event => {
  event.preventDefault(); const text = $("inlineTaskInput").value.trim(); if (!text) return;
  const nowIso = new Date().toISOString(), session = readSessions().find(item => item.id === activePendingSessionId);
  const projectTask = { id:freshId(), text, done:false, notes:"", priority:"medium", deleted:false, category:"actionable", dueDate:null, mode:session?.workArea || "routine", projectId:session?.projectId || null, focusedSecs:0, sessionIds:activePendingSessionId?[activePendingSessionId]:[], sessionCount:activePendingSessionId?1:0, createdAt:nowIso };
  localStorage.setItem(DAY_TASKS_KEY, JSON.stringify([...readProjectTasks(), projectTask]));
  const sessionTask = { id:freshId(), projectTaskId:projectTask.id, movedFromDayTaskId:projectTask.id, text, done:false, notes:"", priority:"medium", category:"actionable", deleted:false, focusedSecs:0, createdAt:nowIso };
  persistInlineTasks([...readTasks(), sessionTask]);
  ipcRenderer.send("data-changed");
  $("inlineTaskInput").value = "";
});

$("pendingSessions").addEventListener("click", event => {
  const button = event.target.closest("button[data-id]");
  if (!button) return;
  updateSession(button.dataset.id, { status: "cancelled" });
  updateSessionSummary();
  resizeWindow();
});

$("closeBtn").addEventListener("click", () => {
  const today = new Date(), day = today.getDay(), key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  let habits = [], logs = {};
  try { habits = JSON.parse(localStorage.getItem("justtimer.habits.v1") || "[]"); logs = JSON.parse(localStorage.getItem("justtimer.habitLogs.v1") || "{}"); } catch {}
  const pending = habits.filter(habit => !habit.archived && (!habit.days?.length || habit.days.includes(day))).filter(habit => { const log = logs[`${habit.id}:${key}`] || {}; return !(log.justified || Number(log.count) >= Math.max(1, Number(habit.targetCount) || 1)); }).map(habit => `• ${habit.name}`);
  const sessions = readSessions().filter(session => (session.workArea || "personal") !== "routine" && session.workAreaName !== "Personal" && isSameDay(new Date(session.startAt), today) && session.status === "done");
  const dayTasks = readProjectTasks();
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowItems = readDailyPriorities()[todayKey(tomorrow)] || [];
  const summary = {
    prioritiesDone: prioritiesForToday().slice(0, 3).filter(item => resolvePriorityTask(item, dayTasks)?.done || item.completedAt).length,
    prioritiesTotal: Math.min(3, prioritiesForToday().filter(item => (item.kind || "main") === "main").length),
    focusSecs: sessions.reduce((sum, session) => sum + Math.max(0, Number(session.durationSecs) || 0) - Math.max(0, Number(session.breakTotalSecs) || 0), 0),
    tasksDone: dayTasks.filter(task => task.completedAt && isSameDay(new Date(task.completedAt), today)).length,
    averageEnergy: sessions.filter(session => Number(session.energy)).reduce((acc, session, _, arr) => acc + Number(session.energy) / arr.length, 0),
  };
  ipcRenderer.invoke("request-app-close", { pendingHabits: pending, summary, tomorrowReady: tomorrowItems.filter(item => (item.kind || "main") === "main").length >= 3, tomorrowDate: todayKey(tomorrow) });
});

$("choosePrioritiesBtn").addEventListener("click", () => {
  localStorage.setItem("justtimer.priorityTargetDate.v1", todayKey());
  ipcRenderer.send("open-priorities");
});
$("manageHabitsBtn").addEventListener("click", openHabits);
$("useGapBtn").addEventListener("click", event => {
  localStorage.setItem(MINI_CONTEXT_KEY, JSON.stringify({ nextStartAt: event.currentTarget.dataset.nextStart || null, openedAt: new Date().toISOString() }));
  ipcRenderer.send("data-changed");
  ipcRenderer.send("open-mini-projects");
});
$("restGapBtn").addEventListener("click", () => $("homeGap").classList.add("hidden"));

ipcRenderer.on("sessions-updated", updateSessionSummary);
ipcRenderer.on("google-calendar-auto-sync", (_event, payload) => reconcileGoogleCalendarEvents(payload));
$("reviewWorkArea").addEventListener("change", event => {
  fillVideoSelect($("reviewProject"), event.target.value);
});
window.addEventListener("focus", () => {
  updateSessionSummary();
  renderProjectSelects();
  renderHome();
  if (!$("inlineTasksPanel").classList.contains("hidden")) renderInlineTasks();
});
window.addEventListener("storage", event => {
  if (event.key === TASKS_KEY) {
    if (!$("inlineTasksPanel").classList.contains("hidden")) renderInlineTasks();
    renderCurrentTask();
  }
  if (event.key === SESSIONS_KEY) refreshActivePlanFromSessionRecord();
  if (event.key === DAY_TASKS_KEY) refreshActivePlanFromCanonicalTasks();
  if ([PROJECTS_KEY, PERSONAL_PROJECTS_KEY, WORK_CHANNELS_KEY].includes(event.key)) renderProjectSelects();
});

updateSkyGradient();
setInterval(updateSkyGradient, 60_000);
setInterval(() => {
  const pending = getPendingSessions();
  updateSessionSummary(pending);
  autoStartPendingSessions(pending);
  const currentQuarterVersion = Math.floor(Date.now() / (15 * 60 * 1000));
  if (currentQuarterVersion !== quarterSlotsVersion && !$("panelSetup").classList.contains("hidden")) { selectedQuarter = null; buildQuarterButtons(); }
}, 1000);

buildQuarterButtons();
renderProjectSelects();
document.querySelector('.dur-btn[data-mins="75"]')?.classList.add("selected");
updateSessionSummary();
initResizeObserver();

async function initializeApp() {
  reconcileProjectTaskHistory();
  const restored = restoreActiveSession();
  if (!restored) showPanel("panelSetup");
  renderHome();
  ipcRenderer.send("data-changed");
  if (!restored && !hasDailyPriorities()) setTimeout(() => {
    localStorage.setItem("justtimer.priorityTargetDate.v1", todayKey());
    ipcRenderer.send("open-priorities");
  }, 500);
}

initializeApp();
