const { ipcRenderer } = require("electron");

const HABITS_KEY = "justtimer.habits.v1";
const HABIT_LOGS_KEY = "justtimer.habitLogs.v1";
const DAY_NAMES = ["Dom", "Lun", "Mar", "Mie", "Jue", "Vie", "Sab"];
const PHASES = {
  morning: { label: "Manana", greeting: "Buenos dias", range: "04:00 - 12:00", start: 4, end: 12 },
  afternoon: { label: "Tarde", greeting: "Buenas tardes", range: "12:00 - 19:00", start: 12, end: 19 },
  night: { label: "Noche", greeting: "Buenas noches", range: "19:00 - 04:00", start: 19, end: 28 },
};

let selectedHabitId = null;
let pendingLog = null;

function $(id) {
  return document.getElementById(id);
}

function readJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function readHabits() {
  const habits = readJson(HABITS_KEY, []);
  return Array.isArray(habits) ? habits : [];
}

function writeHabits(habits) {
  writeJson(HABITS_KEY, habits);
}

function readLogs() {
  const logs = readJson(HABIT_LOGS_KEY, {});
  return logs && typeof logs === "object" ? logs : {};
}

function writeLogs(logs) {
  writeJson(HABIT_LOGS_KEY, logs);
}

function dateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getPhase(date = new Date()) {
  const hour = date.getHours() + date.getMinutes() / 60;
  if (hour >= 4 && hour < 12) return "morning";
  if (hour >= 12 && hour < 19) return "afternoon";
  return "night";
}

function phaseHasPassed(phase, date = new Date()) {
  const hour = date.getHours() + date.getMinutes() / 60;
  if (phase === "morning") return hour >= 12;
  if (phase === "afternoon") return hour >= 19;
  return false;
}

function isScheduledToday(habit, date = new Date()) {
  const days = Array.isArray(habit.days) && habit.days.length ? habit.days : [0, 1, 2, 3, 4, 5, 6];
  return days.includes(date.getDay());
}

function getLog(logs, habitId, key = dateKey()) {
  return logs[`${habitId}:${key}`] || { count: 0, notes: "", difficulty: null, justified: false, events: [] };
}

function targetCount(habit) {
  return Math.max(1, Number(habit.targetCount) || 1);
}

function habitDone(habit, logs, key = dateKey()) {
  const log = getLog(logs, habit.id, key);
  return log.count >= targetCount(habit) || log.justified;
}

function habitCompleteOnly(habit, logs, key = dateKey()) {
  return getLog(logs, habit.id, key).count >= targetCount(habit);
}

function completionStatus(habit, logs, key = dateKey()) {
  const log = getLog(logs, habit.id, key);
  if (log.justified) return "justificado";
  if (log.count >= targetCount(habit)) return "completo";
  return `${log.count}/${targetCount(habit)}`;
}

function todayHabits() {
  const today = new Date();
  return readHabits().filter(habit => isScheduledToday(habit, today) && !habit.archived);
}

function render() {
  const now = new Date();
  const currentPhase = getPhase(now);
  const phase = PHASES[currentPhase];
  const logs = readLogs();
  const habits = todayHabits();
  const phaseHabits = habits.filter(habit => habit.kind === "phase" && habit.phase === currentPhase);
  const overduePhaseHabits = habits.filter(habit =>
    habit.kind === "phase" &&
    habit.phase !== currentPhase &&
    phaseHasPassed(habit.phase, now) &&
    !habitDone(habit, logs)
  );
  const dailyHabits = habits.filter(habit => habit.kind === "daily");
  const dailyPending = dailyHabits.filter(habit => !habitDone(habit, logs));

  $("todayLabel").textContent = `${DAY_NAMES[now.getDay()]} ${dateKey(now)}`;
  $("phaseGreeting").textContent = phase.greeting;
  $("phaseRange").textContent = `${phase.label} · ${phase.range}`;
  $("phaseHero").className = `phase-hero ${currentPhase}`;

  renderHabitList($("phaseHabitList"), [...overduePhaseHabits, ...phaseHabits], logs, overduePhaseHabits.map(h => h.id));
  renderHabitList($("dailyHabitList"), dailyHabits, logs, []);

  setWarning("phaseWarning", overduePhaseHabits.length ? `Quedan ${overduePhaseHabits.length} habitos atrasados para pasar de etapa.` : "");
  setWarning("dailyWarning", dailyPending.length ? `Faltan ${dailyPending.length} habitos del dia o una justificacion.` : "");
  $("phasePanel").classList.toggle("danger-panel", overduePhaseHabits.length > 0);
  $("dailyPanel").classList.toggle("danger-panel", dailyPending.length > 0);

  if (selectedHabitId) renderHabitDetail(selectedHabitId);
}

function setWarning(id, message) {
  const el = $(id);
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

function renderHabitList(list, habits, logs, overdueIds) {
  list.innerHTML = "";

  if (!habits.length) {
    const empty = document.createElement("div");
    empty.className = "habit-empty";
    empty.textContent = "Sin habitos para este bloque";
    list.appendChild(empty);
    return;
  }

  habits.forEach(habit => {
    const log = getLog(logs, habit.id);
    const done = habitDone(habit, logs);
    const row = document.createElement("div");
    row.className = `habit-row ${done ? "done" : ""} ${overdueIds.includes(habit.id) ? "overdue" : ""}`;
    row.innerHTML = `
      <button class="habit-main" type="button">
        <span class="habit-name"></span>
        <span class="habit-meta"></span>
      </button>
      <button class="habit-small-btn complete" type="button" title="Completar">✓</button>
      <button class="habit-small-btn justify" type="button" title="Justificar">!</button>
    `;
    row.querySelector(".habit-name").textContent = habit.name;
    row.querySelector(".habit-meta").textContent = `${completionStatus(habit, logs)} · ${scheduleText(habit)}${log.difficulty ? ` · costo ${log.difficulty}/10` : ""}`;
    row.querySelector(".habit-main").addEventListener("click", () => {
      selectedHabitId = habit.id;
      renderHabitDetail(habit.id);
    });
    row.querySelector(".complete").addEventListener("click", () => openLogDialog(habit, "complete"));
    row.querySelector(".justify").addEventListener("click", () => openLogDialog(habit, "justify"));
    list.appendChild(row);
  });
}

function scheduleText(habit) {
  const days = (habit.days || []).map(day => DAY_NAMES[day]).join(" ");
  if (habit.kind === "daily") return days || "todos los dias";
  return `${PHASES[habit.phase]?.label || "bloque"} · ${days || "todos los dias"}`;
}

function openLogDialog(habit, mode) {
  pendingLog = { habitId: habit.id, mode };
  $("habitLogTitle").textContent = mode === "justify" ? `Justificar: ${habit.name}` : `Completar: ${habit.name}`;
  $("habitLogNotes").value = "";
  $("habitDifficulty").value = "5";
  $("habitDifficultyReadout").textContent = "5 / 10";
  $("habitLogDialog").showModal();
}

function savePendingLog() {
  if (!pendingLog) return;
  const habit = readHabits().find(item => item.id === pendingLog.habitId);
  if (!habit) return;

  const logs = readLogs();
  const key = `${habit.id}:${dateKey()}`;
  const current = getLog(logs, habit.id);
  const event = {
    at: new Date().toISOString(),
    type: pendingLog.mode,
    notes: $("habitLogNotes").value.trim(),
    difficulty: Number($("habitDifficulty").value),
  };
  logs[key] = {
    ...current,
    count: pendingLog.mode === "complete" ? Math.min(targetCount(habit), current.count + 1) : current.count,
    justified: pendingLog.mode === "justify" ? true : current.justified,
    notes: event.notes || current.notes || "",
    difficulty: event.difficulty,
    updatedAt: event.at,
    events: [...(current.events || []), event],
  };
  writeLogs(logs);
  pendingLog = null;
  $("habitLogDialog").close();
  render();
}

function renderHabitDetail(habitId) {
  const detail = $("habitDetail");
  const habit = readHabits().find(item => item.id === habitId);
  if (!habit) {
    detail.classList.add("hidden");
    return;
  }

  const logs = readLogs();
  const stats = getStats(habit, logs);
  detail.classList.remove("hidden");
  detail.innerHTML = `
    <div class="side-title">${escapeHtml(habit.name)}</div>
    <div class="side-meta">${escapeHtml(scheduleText(habit))}</div>
    <div class="habit-stat-grid">
      <div><strong>${stats.monthDone}</strong><span>este mes</span></div>
      <div><strong>${stats.totalDone}</strong><span>total</span></div>
      <div><strong>${stats.streak}</strong><span>racha</span></div>
      <div><strong>${stats.rate}%</strong><span>cumplimiento</span></div>
    </div>
    <div class="habit-month-dots">${monthDots(habit, logs)}</div>
    <div class="side-section">Historial</div>
    <div class="habit-history">${historyMarkup(habit, logs)}</div>
    <button class="tool-btn danger side-delete-btn" id="archiveHabitBtn">Archivar habito</button>
  `;
  $("archiveHabitBtn").addEventListener("click", () => archiveHabit(habit.id));
}

function getStats(habit, logs) {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const totalKeys = Object.keys(logs).filter(key => key.startsWith(`${habit.id}:`));
  const doneKeys = totalKeys.filter(key => {
    const dayKey = key.split(":")[1];
    return habitCompleteOnly(habit, logs, dayKey);
  });
  const monthDone = doneKeys.filter(key => {
    const day = new Date(`${key.split(":")[1]}T00:00:00`);
    return day >= first && day <= today;
  }).length;
  const scheduledPast = scheduledDaysUntil(habit, today).filter(day => day <= today);
  const completedScheduled = scheduledPast.filter(day => habitCompleteOnly(habit, logs, dateKey(day))).length;
  const rate = scheduledPast.length ? Math.round((completedScheduled / scheduledPast.length) * 100) : 0;
  return {
    totalDone: doneKeys.length,
    monthDone,
    streak: streakCount(habit, logs),
    rate,
  };
}

function scheduledDaysUntil(habit, until) {
  const start = new Date(until.getFullYear(), until.getMonth(), 1);
  const days = [];
  for (let day = new Date(start); day <= until; day.setDate(day.getDate() + 1)) {
    if (isScheduledToday(habit, day)) days.push(new Date(day));
  }
  return days;
}

function streakCount(habit, logs) {
  let streak = 0;
  const cursor = new Date();
  for (let i = 0; i < 370; i += 1) {
    if (isScheduledToday(habit, cursor)) {
      if (!habitCompleteOnly(habit, logs, dateKey(cursor))) break;
      streak += 1;
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function monthDots(habit, logs) {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  let html = "";
  for (let day = 1; day <= last; day += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), day);
    const scheduled = isScheduledToday(habit, date);
    const key = dateKey(date);
    let cls = "future";
    if (!scheduled) cls = "off";
    else if (date <= now) cls = habitCompleteOnly(habit, logs, key) ? "ok" : "miss";
    html += `<span class="habit-dot ${cls}" title="${key}"></span>`;
  }
  return html;
}

function historyMarkup(habit, logs) {
  const entries = Object.entries(logs)
    .filter(([key]) => key.startsWith(`${habit.id}:`))
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 18);

  if (!entries.length) return `<div class="side-copy">(sin registros)</div>`;
  return entries.map(([key, log]) => {
    const day = key.split(":")[1];
    const status = log.justified ? "justificado" : log.count >= targetCount(habit) ? "completo" : `${log.count}/${targetCount(habit)}`;
    return `<div class="habit-history-row"><strong>${day}</strong><span>${status}</span><span>${escapeHtml(log.notes || "")}</span></div>`;
  }).join("");
}

function archiveHabit(id) {
  if (!window.confirm("Archivar este habito?")) return;
  writeHabits(readHabits().map(habit =>
    habit.id === id ? { ...habit, archived: true, archivedAt: new Date().toISOString() } : habit
  ));
  selectedHabitId = null;
  $("habitDetail").classList.add("hidden");
  render();
}

function buildDayButtons() {
  const wrap = $("habitDays");
  wrap.innerHTML = "";
  [1, 2, 3, 4, 5, 6, 0].forEach(day => {
    const label = document.createElement("label");
    label.className = "habit-day";
    label.innerHTML = `<input type="checkbox" value="${day}" checked /><span>${DAY_NAMES[day]}</span>`;
    wrap.appendChild(label);
  });
}

function openHabitForm() {
  $("habitNameInput").value = "";
  $("habitKindSelect").value = "phase";
  $("habitPhaseSelect").value = "morning";
  $("habitTargetInput").value = "1";
  buildDayButtons();
  $("habitFormDialog").showModal();
}

function saveHabit(event) {
  event.preventDefault();
  const name = $("habitNameInput").value.trim();
  if (!name) return;
  const kind = $("habitKindSelect").value;
  const days = [...$("habitDays").querySelectorAll("input:checked")].map(input => Number(input.value));
  const habits = readHabits();
  habits.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    kind,
    phase: kind === "phase" ? $("habitPhaseSelect").value : null,
    targetCount: Math.max(1, Number($("habitTargetInput").value) || 1),
    days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
    createdAt: new Date().toISOString(),
  });
  writeHabits(habits);
  $("habitFormDialog").close();
  render();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

$("addHabitBtn").addEventListener("click", openHabitForm);
$("habitForm").addEventListener("submit", saveHabit);
$("cancelHabitFormBtn").addEventListener("click", () => $("habitFormDialog").close());
$("habitLogForm").addEventListener("submit", event => {
  event.preventDefault();
  savePendingLog();
});
$("cancelHabitLogBtn").addEventListener("click", () => $("habitLogDialog").close());
$("habitDifficulty").addEventListener("input", event => {
  $("habitDifficultyReadout").textContent = `${event.target.value} / 10`;
});
$("habitKindSelect").addEventListener("change", event => {
  $("habitPhaseSelect").classList.toggle("hidden", event.target.value !== "phase");
});
$("closeBtn").addEventListener("click", () => ipcRenderer.send("close-current-window"));

render();
setInterval(render, 60_000);
