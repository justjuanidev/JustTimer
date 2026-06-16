const { ipcRenderer } = require("electron");

const SESSIONS_KEY = "justtimer.sessions.v1";
const TASKS_KEY = "justtimer.tasks.v1";
const ACTIVE_SESSION_KEY = "justtimer.activeSession.v1";
let activeNoteTaskId = null;
let draggedTaskId = null;
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
  syncActiveSessionTasks(tasks);
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

function addTask() {
  const text = $("taskInput").value.trim();
  if (!text) return;

  const tasks = readTasks();
  tasks.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    text,
    done: false,
    notes: "",
    priority: "medium",
    deleted: false,
    createdAt: new Date().toISOString(),
  });

  writeTasks(tasks);
  $("taskInput").value = "";
  renderTasks();
}

function openTaskNotes(taskId) {
  const task = readTasks().find(item => item.id === taskId);
  if (!task) return;

  activeNoteTaskId = taskId;
  $("noteTitle").textContent = task.text;
  $("taskNotesInput").value = task.notes || "";
  $("notePanel").classList.remove("hidden");
  $("taskNotesInput").focus();
}

function saveTaskNote() {
  if (!activeNoteTaskId) return;

  const notes = $("taskNotesInput").value.trim();
  writeTasks(readTasks().map(task =>
    task.id === activeNoteTaskId ? { ...task, notes } : task
  ));
  $("notePanel").classList.add("hidden");
  activeNoteTaskId = null;
  renderTasks();
}

function renameTask(taskId) {
  const task = readTasks().find(item => item.id === taskId);
  if (!task) return;
  const nextText = window.prompt("Editar tarea", task.text);
  if (nextText === null) return;
  const text = nextText.trim();
  if (!text) return;
  writeTasks(readTasks().map(item =>
    item.id === taskId ? { ...item, text, renamedAt: new Date().toISOString() } : item
  ));
  renderTasks();
}

function closeTaskNote() {
  $("notePanel").classList.add("hidden");
  activeNoteTaskId = null;
}

function renderTasks() {
  const list = $("taskList");
  const tasks = readTasks().filter(task => !task.deleted);
  list.innerHTML = "";

  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "pending-row";
    empty.textContent = "Sin tareas todavia";
    list.appendChild(empty);
    return;
  }

  tasks.forEach(task => {
    const row = document.createElement("div");
    row.className = `task-row priority-${task.priority || "medium"} ${task.done ? "done" : ""}`;
    row.draggable = true;
    row.dataset.taskId = task.id;
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
      reorderTasks(sourceId, task.id);
    });
    row.querySelector(".task-check").addEventListener("change", event => {
      const checked = event.target.checked;
      const nextTasks = readTasks().map(item =>
        item.id === task.id ? withCompletionTiming(item, checked) : item
      );
      writeTasks(nextTasks);
      if (checked) {
        playSound("task_done");
        const visibleTasks = nextTasks.filter(item => !item.deleted);
        if (visibleTasks.length && visibleTasks.every(item => item.done)) {
          playSound("all_done");
        }
      }
      renderTasks();
    });
    row.querySelector(".task-priority").addEventListener("change", event => {
      writeTasks(readTasks().map(item =>
        item.id === task.id ? { ...item, priority: event.target.value } : item
      ));
      renderTasks();
    });
    row.querySelector(".task-text").addEventListener("click", () => openTaskNotes(task.id));
    row.querySelector(".task-text").addEventListener("dblclick", () => renameTask(task.id));
    row.querySelector(".task-note").addEventListener("click", () => openTaskNotes(task.id));
    row.querySelector(".task-delete").addEventListener("click", () => {
      const active = getSessionTiming();
      if (active) {
        writeTasks(readTasks().map(item =>
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
        writeTasks(readTasks().filter(item => item.id !== task.id));
      }
      if (activeNoteTaskId === task.id) closeTaskNote();
      renderTasks();
    });
    list.appendChild(row);
  });
}

function reorderTasks(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return;

  const tasks = readTasks();
  const sourceIndex = tasks.findIndex(task => task.id === sourceId);
  const targetIndex = tasks.findIndex(task => task.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;

  const [source] = tasks.splice(sourceIndex, 1);
  tasks.splice(targetIndex, 0, source);
  writeTasks(tasks);
  renderTasks();
}

function withCompletionTiming(task, done) {
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

  const active = getSessionTiming();
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

renderTasks();
