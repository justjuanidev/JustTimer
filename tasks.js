const { ipcRenderer } = require("electron");

const SESSIONS_KEY = "justtimer.sessions.v1";
const TASKS_KEY = "justtimer.tasks.v1";
const DAY_TASKS_KEY = "justtimer.dayTasks.v1";
const ACTIVE_SESSION_KEY = "justtimer.activeSession.v1";

let activeNoteTaskId = null;
let activeNoteScope = "session"; // "session" | "day"
let draggedTaskId = null;
let activeView = "session"; // "session" | "day"
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
    // Sound is a nice-to-have; never block task editing for audio.
  }
}

function readJsonArray(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readTasks() {
  return readJsonArray(TASKS_KEY);
}

function writeTasks(tasks) {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  syncActiveSessionTasks(tasks);
}

function readDayTasks() {
  return readJsonArray(DAY_TASKS_KEY);
}

function writeDayTasks(tasks) {
  localStorage.setItem(DAY_TASKS_KEY, JSON.stringify(tasks));
}

// Generic accessors so the rest of the file can work with "the active scope"
// instead of branching everywhere.
function readScope(scope) {
  return scope === "day" ? readDayTasks() : readTasks();
}

function writeScope(scope, tasks) {
  if (scope === "day") writeDayTasks(tasks);
  else writeTasks(tasks);
}

function readSessions() {
  return readJsonArray(SESSIONS_KEY);
}

function writeSessions(sessions) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

function syncActiveSessionTasks(tasks = readTasks()) {
  const active = readActiveSession();
  if (!active?.sessionId) return;
  writeSessions(readSessions().map(session =>
    session.id === active.sessionId ? { ...session, tasks } : session
  ));
  ipcRenderer.send("session-created");
}

function readActiveSession() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACTIVE_SESSION_KEY) || "null");
    return parsed && parsed.startAt ? parsed : null;
  } catch {
    return null;
  }
}

function getSessionTiming() {
  const active = readActiveSession();
  if (!active) return null;

  const elapsedSecs = Math.max(0, Math.floor((Date.now() - new Date(active.startAt).getTime()) / 1000));
  const durationSecs = Number(active.durationSecs) || 0;
  return {
    sessionId: active.sessionId,
    elapsedSecs,
    elapsedMin: Math.floor(elapsedSecs / 60),
    remainingSecs: Math.max(0, durationSecs - elapsedSecs),
    remainingMin: Math.max(0, Math.ceil((durationSecs - elapsedSecs) / 60)),
  };
}

function makeTask(text) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    text,
    done: false,
    notes: "",
    priority: "medium",
    deleted: false,
    createdAt: new Date().toISOString(),
  };
}

function addTask() {
  const text = $("taskInput").value.trim();
  if (!text) return;

  const tasks = readScope(activeView);
  tasks.push(makeTask(text));
  writeScope(activeView, tasks);

  $("taskInput").value = "";
  renderAll();
}

function openTaskNotes(taskId, scope) {
  const task = readScope(scope).find(item => item.id === taskId);
  if (!task) return;

  activeNoteTaskId = taskId;
  activeNoteScope = scope;
  $("noteTitle").textContent = task.text;
  $("taskNotesInput").value = task.notes || "";
  $("notePanel").classList.remove("hidden");
  $("taskNotesInput").focus();
}

function saveTaskNote() {
  if (!activeNoteTaskId) return;

  const notes = $("taskNotesInput").value.trim();
  writeScope(activeNoteScope, readScope(activeNoteScope).map(task =>
    task.id === activeNoteTaskId ? { ...task, notes } : task
  ));
  $("notePanel").classList.add("hidden");
  activeNoteTaskId = null;
  renderAll();
}

function renameTask(taskId, scope) {
  const task = readScope(scope).find(item => item.id === taskId);
  if (!task) return;
  const nextText = window.prompt("Editar tarea", task.text);
  if (nextText === null) return;
  const text = nextText.trim();
  if (!text) return;
  writeScope(scope, readScope(scope).map(item =>
    item.id === taskId ? { ...item, text, renamedAt: new Date().toISOString() } : item
  ));
  renderAll();
}

function closeTaskNote() {
  $("notePanel").classList.add("hidden");
  activeNoteTaskId = null;
}

function setView(view) {
  activeView = view;
  $("tabSession").classList.toggle("active", view === "session");
  $("tabDay").classList.toggle("active", view === "day");
  $("viewSession").classList.toggle("hidden", view !== "session");
  $("viewDay").classList.toggle("hidden", view !== "day");
  $("taskInput").placeholder = view === "day" ? "Nueva tarea del dia" : "Nueva tarea";
}

function renderAll() {
  renderTaskList({
    listEl: $("taskList"),
    scope: "session",
    emptyText: "Sin tareas todavia",
  });
  renderTaskList({
    listEl: $("dayTaskList"),
    scope: "day",
    emptyText: "Sin tareas del dia todavia",
  });
}

function renderTaskList({ listEl, scope, emptyText }) {
  const tasks = readScope(scope).filter(task => !task.deleted);
  listEl.innerHTML = "";

  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "pending-row";
    empty.textContent = emptyText;
    listEl.appendChild(empty);
    return;
  }

  const sessionTasks = scope === "day" ? readTasks() : null;

  tasks.forEach(task => {
    const isDay = scope === "day";
    const movedToSession = isDay && sessionTasks.some(item => item.movedFromDayTaskId === task.id);

    const row = document.createElement("div");
    row.className = `task-row ${isDay ? "day-task" : ""} priority-${task.priority || "medium"} ${task.done ? "done" : ""}`;
    row.draggable = true;
    row.dataset.taskId = task.id;

    const moveButtonHtml = isDay
      ? `<button class="day-task-to-session ${movedToSession ? "in-session" : ""}" type="button" title="${movedToSession ? "Ya esta en la sesion" : "Mover a la sesion"}">${movedToSession ? "✓" : "→"}</button>`
      : "";

    row.innerHTML = `
      <span class="task-drag" title="Mover">::</span>
      <input class="task-check" type="checkbox" ${task.done ? "checked" : ""} />
      <button class="task-text" type="button"></button>
      <select class="task-priority" title="Prioridad">
        <option value="high">P1</option>
        <option value="medium">P2</option>
        <option value="low">P3</option>
      </select>
      <button class="task-note ${task.notes ? "has-note" : ""}" type="button" title="Notas">i</button>
      ${moveButtonHtml}
      <button class="task-delete" type="button" title="Eliminar">&times;</button>
    `;
    row.querySelector(".task-priority").value = task.priority || "medium";
    row.querySelector(".task-text").textContent = task.done && Number.isFinite(task.completionElapsedMin)
      ? `${task.text} · min ${task.completionElapsedMin}`
      : task.text;

    row.addEventListener("dragstart", event => {
      draggedTaskId = task.id;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", task.id);
    });
    row.addEventListener("dragend", () => {
      draggedTaskId = null;
      row.classList.remove("dragging");
    });
    row.addEventListener("dragover", event => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("drop", event => {
      event.preventDefault();
      const sourceId = draggedTaskId || event.dataTransfer.getData("text/plain");
      reorderTasks(scope, sourceId, task.id);
    });

    row.querySelector(".task-check").addEventListener("change", event => {
      const checked = event.target.checked;
      const nextTasks = readScope(scope).map(item =>
        item.id === task.id ? withCompletionTiming(item, checked, scope) : item
      );
      writeScope(scope, nextTasks);
      if (checked) {
        playSound("task_done");
        const visibleTasks = nextTasks.filter(item => !item.deleted);
        if (visibleTasks.length && visibleTasks.every(item => item.done)) {
          playSound("all_done");
        }
      }
      renderAll();
    });

    row.querySelector(".task-priority").addEventListener("change", event => {
      writeScope(scope, readScope(scope).map(item =>
        item.id === task.id ? { ...item, priority: event.target.value } : item
      ));
      renderAll();
    });

    row.querySelector(".task-text").addEventListener("click", () => openTaskNotes(task.id, scope));
    row.querySelector(".task-text").addEventListener("dblclick", () => renameTask(task.id, scope));
    row.querySelector(".task-note").addEventListener("click", () => openTaskNotes(task.id, scope));

    if (isDay) {
      row.querySelector(".day-task-to-session").addEventListener("click", () => {
        if (movedToSession) return;
        moveDayTaskToSession(task.id);
      });
    }

    row.querySelector(".task-delete").addEventListener("click", () => {
      const active = scope === "session" ? getSessionTiming() : null;
      if (active) {
        writeScope(scope, readScope(scope).map(item =>
          item.id === task.id
            ? {
                ...item,
                deleted: true,
                deletedAt: new Date().toISOString(),
                deletedElapsedSecs: active.elapsedSecs,
                deletedElapsedMin: active.elapsedMin,
                deletedRemainingSecs: active.remainingSecs,
                deletedRemainingMin: active.remainingMin,
              }
            : item
        ));
      } else {
        writeScope(scope, readScope(scope).filter(item => item.id !== task.id));
      }
      if (activeNoteTaskId === task.id && activeNoteScope === scope) closeTaskNote();
      renderAll();
    });

    listEl.appendChild(row);
  });
}

function moveDayTaskToSession(dayTaskId) {
  const dayTasks = readDayTasks();
  const dayTask = dayTasks.find(item => item.id === dayTaskId);
  if (!dayTask) return;

  const sessionTasks = readTasks();
  if (sessionTasks.some(item => item.movedFromDayTaskId === dayTaskId)) {
    renderAll();
    return;
  }

  sessionTasks.push({
    ...makeTask(dayTask.text),
    priority: dayTask.priority || "medium",
    notes: dayTask.notes || "",
    movedFromDayTaskId: dayTask.id,
  });
  writeTasks(sessionTasks);
  renderAll();
}

function reorderTasks(scope, sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return;

  const tasks = readScope(scope);
  const sourceIndex = tasks.findIndex(task => task.id === sourceId);
  const targetIndex = tasks.findIndex(task => task.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;

  const [source] = tasks.splice(sourceIndex, 1);
  tasks.splice(targetIndex, 0, source);
  writeScope(scope, tasks);
  renderAll();
}

function withCompletionTiming(task, done, scope) {
  if (!done) {
    const {
      completedAt,
      completionElapsedSecs,
      completionElapsedMin,
      completionRemainingSecs,
      completionRemainingMin,
      ...rest
    } = task;
    return { ...rest, done: false };
  }

  // Elapsed-time tracking only makes sense relative to a running session,
  // which day tasks aren't part of.
  const active = scope === "session" ? getSessionTiming() : null;
  if (!active) {
    return {
      ...task,
      done: true,
      completedAt: new Date().toISOString(),
    };
  }

  return {
    ...task,
    done: true,
    completedAt: new Date().toISOString(),
    completionElapsedSecs: active.elapsedSecs,
    completionElapsedMin: active.elapsedMin,
    completionRemainingSecs: active.remainingSecs,
    completionRemainingMin: active.remainingMin,
  };
}

$("addBtn").addEventListener("click", addTask);
$("taskInput").addEventListener("keydown", event => {
  if (event.key === "Enter") addTask();
});
$("saveNoteBtn").addEventListener("click", saveTaskNote);
$("closeNoteBtn").addEventListener("click", closeTaskNote);
$("taskNotesInput").addEventListener("keydown", event => {
  if (event.ctrlKey && event.key === "Enter") saveTaskNote();
});
$("closeBtn").addEventListener("click", () => ipcRenderer.send("close-current-window"));
$("tabSession").addEventListener("click", () => setView("session"));
$("tabDay").addEventListener("click", () => setView("day"));

setView("session");
renderAll();