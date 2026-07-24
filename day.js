const { ipcRenderer } = require("electron");

const DAY_TASKS_KEY = "justtimer.dayTasks.v1";
const PROJECTS_KEY = "justtimer.projects.v1";
const TASKS_KEY = "justtimer.tasks.v1";
const SESSIONS_KEY = "justtimer.sessions.v1";
const ACTIVE_SESSION_KEY = "justtimer.activeSession.v1";
let mode = localStorage.getItem("justtimer.taskMode.v1") || "work";
let category = "all";
let projectId = null;
let showArchived = false;
let selectedProjectImage = null;

function $(id) { return document.getElementById(id); }
function readArray(key) { try { const value = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(value) ? value : []; } catch { return []; } }
function writeArray(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function tasks() { return readArray(DAY_TASKS_KEY); }
function projects() { return readArray(PROJECTS_KEY); }
function id() { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function esc(value) { return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }

function newTask(text) {
  return { id: id(), text, done: false, notes: "", priority: "medium", deleted: false, category: $("newTaskCategory").value, dueDate: $("newTaskDue").value || null, mode, projectId, createdAt: new Date().toISOString() };
}

function addTask() {
  const text = $("newTaskInput").value.trim(); if (!text) return;
  const all = tasks(); all.push(newTask(text)); writeArray(DAY_TASKS_KEY, all);
  $("newTaskInput").value = ""; $("newTaskDue").value = ""; render();
}

function taskMatches(task) { return !task.deleted && task.mode === mode && (!projectId || task.projectId === projectId) && (category === "all" || task.category === category); }
function taskDateLabel(date) { if (!date) return "Sin fecha límite"; const today = new Date(); today.setHours(0,0,0,0); const due = new Date(`${date}T00:00:00`); const prefix = due < today ? "Vencida" : due.getTime() === today.getTime() ? "Hoy" : "Límite"; return `${prefix}: ${due.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })}`; }

function renderTasks() {
  const list = $("dayTaskList"); const all = tasks().filter(taskMatches); list.innerHTML = "";
  if (!all.length) { list.innerHTML = `<div class="day-empty">No hay tareas en esta vista.</div>`; return; }
  all.sort((a,b) => Number(a.done) - Number(b.done) || String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999"))).forEach(task => {
    const project = projects().find(item => item.id === task.projectId);
    const row = document.createElement("article"); row.className = `day-task-row ${task.done ? "done" : ""}`;
    row.innerHTML = `<input type="checkbox" ${task.done ? "checked" : ""} aria-label="Completar tarea"><div class="day-task-main"><button class="day-task-title" type="button">${esc(task.text)}</button><div class="day-task-meta"><span class="category-pill ${task.category || "inbox"}">${categoryLabel(task.category)}</span><span class="due-label ${isOverdue(task) ? "overdue" : ""}">${taskDateLabel(task.dueDate)}</span>${project ? `<span class="project-label">${esc(project.title)}</span>` : ""}</div></div><select class="day-task-project" title="Proyecto"><option value="">Sin proyecto</option>${projects().filter(item => item.mode === mode).map(item => `<option value="${item.id}">${esc(item.title)}</option>`).join("")}</select><button class="tool-btn task-import" title="Llevar a la sesión actual">→ sesión</button><button class="task-delete" title="Eliminar">×</button>`;
    row.querySelector(".day-task-project").value = task.projectId || "";
    row.querySelector("input").addEventListener("change", event => updateTask(task.id, { done: event.target.checked, completedAt: event.target.checked ? new Date().toISOString() : null }));
    row.querySelector(".day-task-title").addEventListener("click", () => editTask(task));
    row.querySelector(".day-task-project").addEventListener("change", event => updateTask(task.id, { projectId: event.target.value || null }));
    row.querySelector(".task-import").addEventListener("click", () => importToSession(task));
    row.querySelector(".task-delete").addEventListener("click", () => updateTask(task.id, { deleted: true, deletedAt: new Date().toISOString() }));
    list.appendChild(row);
  });
}

function categoryLabel(value) { return ({ inbox: "Inbox", actionable: "Accionable", incubator: "Incubadora", snooze: "Snooze" })[value] || "Inbox"; }
function isOverdue(task) { return task.dueDate && !task.done && new Date(`${task.dueDate}T23:59:59`) < new Date(); }
function updateTask(taskId, patch) { writeArray(DAY_TASKS_KEY, tasks().map(task => task.id === taskId ? { ...task, ...patch } : task)); render(); }

function editTask(task) {
  const text = window.prompt("Editar tarea", task.text); if (text === null || !text.trim()) return;
  const dueDate = window.prompt("Fecha límite (AAAA-MM-DD; dejar vacío para quitar)", task.dueDate || ""); if (dueDate === null) return;
  const nextCategory = window.prompt("Categoría: inbox, actionable, incubator o snooze", task.category || "inbox"); if (nextCategory === null) return;
  const valid = ["inbox", "actionable", "incubator", "snooze"].includes(nextCategory.toLowerCase()) ? nextCategory.toLowerCase() : task.category;
  updateTask(task.id, { text: text.trim(), dueDate: dueDate.trim() || null, category: valid, editedAt: new Date().toISOString() });
}

function activeSession() { try { return JSON.parse(localStorage.getItem(ACTIVE_SESSION_KEY) || "null"); } catch { return null; } }
function importToSession(task) {
  const active = activeSession(); if (!active?.sessionId) { alert("Iniciá una sesión para importar esta tarea."); return; }
  const sessionTasks = readArray(TASKS_KEY); if (!sessionTasks.some(item => item.movedFromDayTaskId === task.id)) sessionTasks.push({ id: id(), text: task.text, done: false, notes: task.notes || "", priority: task.priority || "medium", deleted: false, movedFromDayTaskId: task.id, importedAt: new Date().toISOString() });
  writeArray(TASKS_KEY, sessionTasks);
  writeArray(SESSIONS_KEY, readArray(SESSIONS_KEY).map(session => session.id === active.sessionId ? { ...session, tasks: sessionTasks } : session));
  ipcRenderer.send("session-created"); alert("Tarea agregada a la sesión actual.");
}

function projectSessionStats(project) {
  const sessions = readArray(SESSIONS_KEY).filter(session => session.status === "done" && (session.projectId === project.id || session.projectName === project.title));
  return { sessions: sessions.length, hours: sessions.reduce((sum, session) => sum + (Number(session.durationSecs) || 0) / 3600, 0) };
}

function renderProjects() {
  const grid = $("projectGrid"); const items = projects().filter(project => project.mode === mode && Boolean(project.archived) === showArchived); grid.innerHTML = "";
  $("archivedProjectsBtn").classList.toggle("active", showArchived);
  $("archivedProjectsBtn").textContent = showArchived ? "Proyectos activos" : "Archivados";
  const allCard = document.createElement("button"); allCard.className = `project-card ${projectId ? "" : "active"}`; allCard.innerHTML = `<span class="project-thumb project-empty">▦</span><strong>Todos los proyectos</strong>`; allCard.addEventListener("click", () => { projectId = null; render(); }); grid.appendChild(allCard);
  items.forEach(project => { const count = tasks().filter(task => !task.deleted && task.projectId === project.id).length; const stats = projectSessionStats(project); const card = document.createElement("button"); card.className = `project-card ${project.id === projectId ? "active" : ""}`; card.innerHTML = project.imageUrl ? `<img class="project-thumb" src="${esc(project.imageUrl)}" alt="" /><strong>${esc(project.title)}</strong><small>${count} tareas · ${stats.sessions} sesiones · ${stats.hours.toFixed(1)} h</small>` : `<span class="project-thumb project-empty">▦</span><strong>${esc(project.title)}</strong><small>${count} tareas · ${stats.sessions} sesiones · ${stats.hours.toFixed(1)} h</small>`; card.addEventListener("click", () => { projectId = project.id; category = "all"; render(); }); grid.appendChild(card); });
}

function renderContext() { const context = $("projectContext"), project = projects().find(item => item.id === projectId); context.classList.toggle("hidden", !project); if (project) { const stats = projectSessionStats(project); context.innerHTML = `<strong>${esc(project.title)}</strong><span>${stats.sessions} sesiones · ${stats.hours.toFixed(1)} h enfocadas</span><button class="tool-btn" id="archiveProject">${project.archived ? "Restaurar" : "Archivar"}</button><button class="tool-btn danger" id="deleteProject">Borrar</button><button class="tool-btn" id="clearProject">Ver todas</button>`; } $("clearProject")?.addEventListener("click", () => { projectId = null; render(); }); $("archiveProject")?.addEventListener("click", () => { const target = projects().find(item => item.id === projectId); writeArray(PROJECTS_KEY, projects().map(item => item.id === projectId ? { ...item, archived: !target.archived, archivedAt: !target.archived ? new Date().toISOString() : null } : item)); projectId = null; render(); }); $("deleteProject")?.addEventListener("click", () => { const target = projects().find(item => item.id === projectId); if (!target || !window.confirm(`¿Borrar el proyecto “${target.title}”? Las sesiones existentes conservarán sus estadísticas históricas.`)) return; writeArray(PROJECTS_KEY, projects().filter(item => item.id !== projectId)); writeArray(DAY_TASKS_KEY, tasks().map(task => task.projectId === projectId ? { ...task, projectId: null } : task)); projectId = null; render(); }); }
function render() { document.body.classList.toggle("day-work", mode === "work"); document.body.classList.toggle("day-personal", mode === "personal"); $("daySubtitle").textContent = mode === "work" ? "Modo trabajo · organizá tu día y proyectos" : "Modo personal · organizá tu día y proyectos"; document.querySelectorAll("[data-mode]").forEach(button => button.classList.toggle("active", button.dataset.mode === mode)); document.querySelectorAll(".day-filter").forEach(button => button.classList.toggle("active", button.dataset.category === category)); renderContext(); renderTasks(); renderProjects(); }

$("addTaskBtn").addEventListener("click", addTask); $("newTaskInput").addEventListener("keydown", event => { if (event.key === "Enter") addTask(); });
document.querySelectorAll("[data-mode]").forEach(button => button.addEventListener("click", () => { mode = button.dataset.mode; localStorage.setItem("justtimer.taskMode.v1", mode); projectId = null; render(); }));
document.querySelectorAll(".day-filter").forEach(button => button.addEventListener("click", () => { category = button.dataset.category; render(); }));
$("newProjectBtn").addEventListener("click", () => $("projectForm").classList.toggle("hidden"));
$("archivedProjectsBtn").addEventListener("click", () => { showArchived = !showArchived; projectId = null; render(); });
$("uploadProjectImageBtn").addEventListener("click", async () => { selectedProjectImage = await ipcRenderer.invoke("select-project-image"); if (selectedProjectImage) $("uploadProjectImageBtn").textContent = "Imagen elegida"; });
$("projectForm").addEventListener("submit", event => { event.preventDefault(); const title = $("projectName").value.trim(); if (!title) return; const all = projects(); all.push({ id: id(), title, imageUrl: selectedProjectImage || $("projectImage").value.trim() || null, mode, createdAt: new Date().toISOString() }); writeArray(PROJECTS_KEY, all); $("projectName").value = ""; $("projectImage").value = ""; selectedProjectImage = null; $("uploadProjectImageBtn").textContent = "Subir imagen"; $("projectForm").classList.add("hidden"); render(); });
$("closeBtn").addEventListener("click", () => ipcRenderer.send("close-current-window"));
render();
