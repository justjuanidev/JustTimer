const { ipcRenderer } = require("electron");

const DAY_TASKS_KEY = "justtimer.dayTasks.v1";
const PROJECTS_KEY = "justtimer.projects.v1";
const CHANNELS_KEY = "justtimer.projectChannels.v1";
const WORK_CHANNELS_KEY = "justtimer.workChannels.v1";
const TASKS_KEY = "justtimer.tasks.v1";
const SESSIONS_KEY = "justtimer.sessions.v1";
const ACTIVE_SESSION_KEY = "justtimer.activeSession.v1";
const DAILY_PRIORITIES_KEY = "justtimer.dailyPriorities.v1";
const SHORTS_SECTION_MIGRATION_KEY = "justtimer.shortsSectionCreated.v1";
const OPEN_PROJECT_KEY = "justtimer.openProjectId.v1";
const STATUSES = [
  { id: "idea", label: "Idea", icon: "✦" }, { id: "framing", label: "Framing", icon: "▣" },
  { id: "packaging", label: "Packaging", icon: "◆" }, { id: "planning", label: "Plani", icon: "▤" },
  { id: "recording", label: "Grabación", icon: "●" }, { id: "production", label: "Producción", icon: "●" }, { id: "editing", label: "Edición", icon: "◧" },
  { id: "post", label: "Post", icon: "✓" }
];
const CATEGORIES = [{ id: "all", label: "Todas" }, { id: "inbox", label: "Inbox" }, { id: "actionable", label: "Accionable" }, { id: "incubator", label: "Incubadora" }, { id: "snooze", label: "Snooze" }];

let mode = localStorage.getItem("justtimer.workArea.v1") || localStorage.getItem("justtimer.taskMode.v1") || "personal";
let projectId = null, statusFilter = "all", taskCategory = "all", showArchived = false;
let selectedProjectImage = null, draggedProjectId = null, draggedChannelId = null, draggedTaskId = null;
let selectedWorkChannelImage = null, editingWorkChannelId = null;
let renderCache = null;
let pendingEditorSave = null;
let movingProjectId = null;
let pendingExternalTaskRefresh = false;
const expandedTaskIds = new Set();

function $(id) { return document.getElementById(id); }
function readArray(key) { try { const value = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(value) ? value : []; } catch { return []; } }
function writeArray(key, value) { localStorage.setItem(key, JSON.stringify(value)); ipcRenderer.send("data-changed"); }
function tasks() { return renderCache?.tasks || readArray(DAY_TASKS_KEY); }
function projects() { return renderCache?.projects || readArray(PROJECTS_KEY); }
function channels() { return renderCache?.channels || readArray(CHANNELS_KEY); }
function workChannels() { return renderCache?.workChannels || readArray(WORK_CHANNELS_KEY); }
function sessionRecords() { return renderCache?.sessions || readArray(SESSIONS_KEY); }
function beginRenderCache() { renderCache = { tasks:readArray(DAY_TASKS_KEY), projects:readArray(PROJECTS_KEY), channels:readArray(CHANNELS_KEY), workChannels:readArray(WORK_CHANNELS_KEY), sessions:readArray(SESSIONS_KEY) }; }
function endRenderCache() { renderCache = null; }
function uid() { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function esc(value) { return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function statusInfo(id) { return STATUSES.find(item => item.id === id) || STATUSES[0]; }
function categoryLabel(value) { return CATEGORIES.find(item => item.id === value)?.label || "Inbox"; }
function formatTaskDuration(secs) { const safe = Math.max(0, Math.floor(Number(secs) || 0)), h = Math.floor(safe / 3600), m = Math.floor((safe % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min`; }
function todayKey(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }

function promoteReadyTasks(allTasks, nowKey = todayKey()) {
  const byId=new Map(allTasks.map(task=>[task.id,task])); let changed=false;
  const next=allTasks.map(task=>{
    if (task.deleted || task.done || task.automationResolvedAt || !["snooze","incubator"].includes(task.category)) return task;
    const dependencies=Array.isArray(task.blockedByTaskIds)?task.blockedByTaskIds.filter(id=>id!==task.id):[];
    const hasDate=Boolean(task.activateDate), dateReady=!hasDate || task.activateDate<=nowKey;
    const hasDependencies=dependencies.length>0, dependenciesReady=!hasDependencies || dependencies.every(id=>{const source=byId.get(id);return !source || source.done || source.deleted;});
    if (!(hasDate||hasDependencies) || !dateReady || !dependenciesReady) return task;
    const activatedAt=new Date().toISOString(), activationReason=hasDate&&hasDependencies?"date-and-dependencies":hasDate?"date":"dependencies";
    changed=true; return {...task,category:task.activateToCategory==="incubator"?"incubator":"actionable",activatedAt,activationReason,automationResolvedAt:activatedAt,activationHistory:[...(task.activationHistory||[]),{activatedAt,activationReason,fromCategory:task.category,toCategory:task.activateToCategory==="incubator"?"incubator":"actionable"}].slice(-10)};
  });
  return {tasks:next,changed};
}

function applyTaskAutomations() {
  const current=readArray(DAY_TASKS_KEY), promoted=promoteReadyTasks(current);
  if (promoted.changed) writeArray(DAY_TASKS_KEY,promoted.tasks);
  return promoted.changed;
}

function ensureWorkChannels() {
  const all = workChannels();
  let changed = false;
  [{ id: "personal", name: "JustJuani", order: 0 }, { id: "work", name: "Laburo", order: 1 }, { id: "routine", name: "Personal", order: 999, hiddenFromVideos: true }].forEach(item => {
    if (!all.some(channel => channel.id === item.id)) { all.push(item); changed = true; }
  });
  if (changed) writeArray(WORK_CHANNELS_KEY, all);
  if (!all.some(channel => channel.id === mode) || mode === "routine" || all.find(channel => channel.id === mode)?.hiddenFromVideos) mode = "personal";
  return all.sort((a, b) => (a.order || 0) - (b.order || 0));
}
function projectWorkChannel(project) { return project.workChannelId || project.mode || "personal"; }
function workChannelInfo(id) { return ensureWorkChannels().find(channel => channel.id === id) || ensureWorkChannels()[0]; }
function avatarMarkup(channel, className = "") { return channel?.avatarUrl ? `<img class="${className}" src="${esc(channel.avatarUrl)}" alt="" />` : esc((channel?.name || "C").slice(0, 1).toUpperCase()); }
function renderWorkspaces() {
  const current = workChannelInfo(mode);
  $("workspaceSwitch").innerHTML = ensureWorkChannels().filter(channel => !channel.hiddenFromVideos && channel.id !== "routine").map(channel => `<button class="workspace-btn ${channel.id === mode ? "active" : ""}" data-work-channel="${esc(channel.id)}">${esc(channel.name)}</button>`).join("") + '<button class="workspace-add" id="addWorkChannel" title="Agregar canal">+</button>';
  $("workspaceSwitch").querySelectorAll("[data-work-channel]").forEach(button => button.addEventListener("click", () => {
    mode = button.dataset.workChannel; localStorage.setItem("justtimer.workArea.v1", mode); projectId = null; statusFilter = "all"; closeForms(); renderLibrary();
  }));
  $("addWorkChannel").addEventListener("click", () => openWorkChannelForm());
  $("brandMark").innerHTML = avatarMarkup(current, "brand-avatar");
  $("brandMark").title = `Editar ${current.name}`;
}

function ensureChannels() {
  const all = channels();
  let changed = false;
  if (!all.some(channel => channel.mode === "personal")) { all.push({ id: "default-personal-videos", name: "Canal JustJuani", mode: "personal", orientation:"horizontal", order: 0 }); changed = true; }
  const videos = all.find(channel => channel.id === "default-personal-videos");
  if (videos?.name === "Videos") { videos.name = "Canal JustJuani"; changed = true; }
  if (!localStorage.getItem(SHORTS_SECTION_MIGRATION_KEY)) {
    if (!all.some(channel => channel.mode === "personal" && channel.name.toLowerCase() === "shorts")) { all.push({ id:"default-personal-shorts", name:"Shorts", mode:"personal", orientation:"vertical", order:all.filter(channel => channel.mode === "personal").length }); changed = true; }
    localStorage.setItem(SHORTS_SECTION_MIGRATION_KEY, "1");
  }
  const legacyWorkIndex = all.findIndex(channel => channel.id === "default-work" || (channel.mode === "work" && channel.name === "Clientes"));
  if (legacyWorkIndex >= 0) {
    let replacement = all.find(channel => channel.mode === "work" && channel !== all[legacyWorkIndex]);
    if (!replacement) { replacement = { id: "default-work-general", name: "General", mode: "work", order: 0 }; all.push(replacement); }
    const legacyId = all[legacyWorkIndex].id, allProjects = projects();
    if (allProjects.some(project => project.channelId === legacyId)) localStorage.setItem(PROJECTS_KEY, JSON.stringify(allProjects.map(project => project.channelId === legacyId ? { ...project, channelId: replacement.id } : project)));
    all.splice(legacyWorkIndex, 1); changed = true;
  }
  if (!all.some(channel => channel.mode === "work")) { all.push({ id: "default-work-general", name: "General", mode: "work", order: 0 }); changed = true; }
  const legacyResearch = all.find(channel => channel.id === "default-personal-research");
  if (legacyResearch?.name === "Investigación") { legacyResearch.name = "Ideas futuras"; changed = true; }
  all.forEach(channel => { if (!channel.orientation) { channel.orientation = channel.name.toLowerCase() === "shorts" ? "vertical" : "horizontal"; changed = true; } });
  ensureWorkChannels().filter(workChannel => !workChannel.hiddenFromVideos && workChannel.id !== "routine").forEach(workChannel => {
    if (!["personal", "work"].includes(workChannel.id) && !all.some(channel => channel.mode === workChannel.id)) {
      all.push({ id: `default-${workChannel.id}`, name: "Videos", mode: workChannel.id, order: 0 }); changed = true;
    }
  });
  if (changed) writeArray(CHANNELS_KEY, all);
  return all;
}
function channelFor(project) {
  const available = ensureChannels().filter(item => item.mode === projectWorkChannel(project));
  return available.find(item => item.id === project.channelId) || available[0];
}

function readPriorityMap() { try { const value = JSON.parse(localStorage.getItem(DAILY_PRIORITIES_KEY) || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; } }
function syncDueTasksToToday(allTasks = tasks()) {
  return allTasks;
}

function projectStats(project) {
  const projectTasks = tasks().filter(task => !task.deleted && task.projectId === project.id);
  const sessions = sessionRecords().filter(session => session.status === "done" && (session.projectId === project.id || session.projectName === project.title));
  return { tasks: projectTasks.length, pending: projectTasks.filter(task => !task.done).length, sessions: sessions.length, hours: sessions.reduce((sum, session) => sum + (Number(session.durationSecs) || 0) / 3600, 0) };
}

function renderStatusFilters() {
  const active = projects().filter(project => projectWorkChannel(project) === mode && !project.archived);
  $("statusFilters").innerHTML = `<button class="status-filter ${statusFilter === "all" ? "active" : ""}" data-status="all">Todos</button>` + STATUSES.map(status => `<button class="status-filter ${statusFilter === status.id ? "active" : ""}" data-status="${status.id}"><span>${status.icon}</span>${status.label}<small>${active.filter(project => (project.status || "idea") === status.id).length}</small></button>`).join("");
  $("statusFilters").querySelectorAll("[data-status]").forEach(button => button.addEventListener("click", () => { statusFilter = button.dataset.status; renderLibrary(); }));
}
function renderProjectFormOptions() {
  const available = ensureChannels().filter(item => item.mode === mode && !item.archived).sort((a, b) => (a.order || 0) - (b.order || 0));
  $("projectChannel").innerHTML = available.map(channel => `<option value="${channel.id}">${esc(channel.name)}</option>`).join("");
  $("projectStatus").innerHTML = STATUSES.map(status => `<option value="${status.id}">${status.label}</option>`).join("");
}
function emptyThumbnail(project) {
  return `<div class="project-thumbnail placeholder"><span>▶</span><small>VIDEO</small></div>`;
}

function projectCard(project, orientation = "horizontal") {
  const stats = projectStats(project), status = statusInfo(project.status), article = document.createElement("article");
  article.className = `video-project-card ${orientation === "vertical" ? "vertical-card" : ""}`; article.draggable = true; article.dataset.projectId = project.id;
  const thumbnail = project.imageUrl ? `<img class="project-thumbnail" src="${esc(project.imageUrl)}" alt="" />` : emptyThumbnail(project);
  const schedule = [project.startDate ? `Inicio ${taskDateLabel(project.startDate)}` : "", project.dueDate ? `Límite ${taskDateLabel(project.dueDate)}` : ""].filter(Boolean).join(" · ");
  article.innerHTML = `<button class="thumbnail-button" type="button" aria-label="Abrir ${esc(project.title)}">${thumbnail}<span class="status-badge status-${status.id}">${status.icon} ${status.label}</span><span class="hours-badge">${stats.hours.toFixed(1)} h</span></button><div class="video-card-info"><div class="video-card-copy"><h3 title="Doble clic para editar">${esc(project.title)}</h3><p>${stats.pending} pendientes · ${stats.tasks} tareas · ${stats.sessions} sesiones${schedule ? ` · ${esc(schedule)}` : ""}</p></div><button class="card-menu" type="button" title="Opciones">•••</button><div class="card-popover hidden"><button data-action="rename">Editar título</button><button data-action="move">Mover a otro canal</button><button data-action="status">Avanzar estado</button><button data-action="archive">${project.archived ? "Restaurar" : "Archivar"}</button><button class="danger-action" data-action="delete">Borrar video/proyecto</button></div></div>`;
  article.querySelector(".thumbnail-button").addEventListener("click", () => openProject(project.id));
  article.querySelector("h3").addEventListener("dblclick", () => renameProject(project.id));
  const popover = article.querySelector(".card-popover");
  article.querySelector(".card-menu").addEventListener("click", event => { event.stopPropagation(); document.querySelectorAll(".card-popover").forEach(item => item !== popover && item.classList.add("hidden")); popover.classList.toggle("hidden"); });
  popover.querySelector('[data-action="rename"]').addEventListener("click", () => renameProject(project.id));
  popover.querySelector('[data-action="move"]').addEventListener("click", () => openMoveProjectDialog(project.id));
  popover.querySelector('[data-action="status"]').addEventListener("click", () => cycleProjectStatus(project.id));
  popover.querySelector('[data-action="archive"]').addEventListener("click", () => archiveProject(project.id));
  popover.querySelector('[data-action="delete"]').addEventListener("click", () => deleteProject(project.id));
  article.addEventListener("dragstart", () => { draggedProjectId = project.id; article.classList.add("dragging"); });
  article.addEventListener("dragend", () => { draggedProjectId = null; article.classList.remove("dragging"); });
  article.addEventListener("dragover", event => event.preventDefault());
  article.addEventListener("drop", event => { event.preventDefault(); event.stopPropagation(); reorderProject(draggedProjectId, project.id, channelFor(project)?.id); });
  return article;
}

function renderLibrary() {
  beginRenderCache();
  renderWorkspaces(); renderStatusFilters(); renderProjectFormOptions();
  $("archivedProjectsBtn").classList.toggle("selected", showArchived);
  $("archivedProjectsBtn").textContent = showArchived ? "↩" : "🗂️";
  $("archivedProjectsBtn").title = showArchived ? "Volver a videos activos" : "Ver archivados";
  const root = $("projectChannels"); root.innerHTML = "";
  const allProjects = projects();
  const visibleChannels = ensureChannels().filter(channel => {
    if (channel.mode !== mode) return false;
    if (!showArchived) return !channel.archived;
    return Boolean(channel.archived) || allProjects.some(project => projectWorkChannel(project) === mode && channelFor(project)?.id === channel.id && project.archived);
  }).sort((a, b) => (a.order || 0) - (b.order || 0));
  visibleChannels.forEach(channel => {
    const items = allProjects.filter(project => projectWorkChannel(project) === mode && channelFor(project)?.id === channel.id && (showArchived ? (channel.archived || project.archived) : !project.archived) && (statusFilter === "all" || (project.status || "idea") === statusFilter)).sort((a, b) => (a.order ?? 999999) - (b.order ?? 999999));
    if (!items.length && (statusFilter !== "all" || (showArchived && !channel.archived))) return;
    const channelProjects = allProjects.filter(project => projectWorkChannel(project) === mode && channelFor(project)?.id === channel.id && !project.archived);
    const totalHours = channelProjects.reduce((sum, project) => sum + projectStats(project).hours, 0);
    const section = document.createElement("section"); section.className = `channel-section ${channel.orientation === "vertical" ? "vertical-section" : ""}`; section.dataset.channelId = channel.id;
    section.innerHTML = `<div class="channel-heading"><button class="section-drag" type="button" draggable="true" title="Arrastrar para reordenar" aria-label="Reordenar ${esc(channel.name)}">⋮⋮</button><div class="channel-copy"><h2>${esc(channel.name)}</h2><p>${channelProjects.length} proyectos · ${totalHours.toFixed(1)} horas enfocadas</p></div><div class="channel-actions"><button class="channel-edit" title="Renombrar sección">✎</button><button class="channel-archive" title="${channel.archived ? "Restaurar sección" : "Archivar sección"}">${channel.archived ? "↩" : "▣"}</button><button class="channel-delete" title="Eliminar sección">×</button></div></div><div class="video-grid"></div>`;
    section.querySelector(".channel-edit").addEventListener("click", () => renameChannel(channel.id));
    section.querySelector(".channel-archive").addEventListener("click", () => archiveChannel(channel.id));
    section.querySelector(".channel-delete").addEventListener("click", () => deleteChannel(channel.id));
    const dragHandle = section.querySelector(".section-drag");
    dragHandle.addEventListener("dragstart", event => { draggedChannelId = channel.id; section.classList.add("dragging-section"); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", channel.id); });
    dragHandle.addEventListener("dragend", () => { draggedChannelId = null; section.classList.remove("dragging-section"); document.querySelectorAll(".section-drop-target").forEach(item => item.classList.remove("section-drop-target")); });
    section.addEventListener("dragover", event => { if (!draggedChannelId) return; event.preventDefault(); section.classList.add("section-drop-target"); });
    section.addEventListener("dragleave", event => { if (!section.contains(event.relatedTarget)) section.classList.remove("section-drop-target"); });
    section.addEventListener("drop", event => { if (!draggedChannelId) return; event.preventDefault(); event.stopPropagation(); section.classList.remove("section-drop-target"); reorderChannel(draggedChannelId, channel.id); });
    const grid = section.querySelector(".video-grid"); items.forEach(project => grid.appendChild(projectCard(project, channel.orientation)));
    if (!items.length) grid.innerHTML = `<button class="empty-channel" type="button">+ Agregar el primer proyecto a ${esc(channel.name)}</button>`;
    grid.querySelector(".empty-channel")?.addEventListener("click", () => openProjectForm(channel.id));
    grid.addEventListener("dragover", event => { if (draggedProjectId) { event.preventDefault(); grid.classList.add("project-drop-target"); } });
    grid.addEventListener("dragleave", event => { if (!grid.contains(event.relatedTarget)) grid.classList.remove("project-drop-target"); });
    grid.addEventListener("drop", event => { grid.classList.remove("project-drop-target"); if (draggedProjectId && event.target === grid) { event.preventDefault(); moveProjectToChannel(draggedProjectId, channel.id); } });
    root.appendChild(section);
  });
  if (!root.children.length) root.innerHTML = '<div class="library-empty"><span>⌕</span><h2>No hay videos en este filtro</h2><p>Probá con otro estado o volvé a ver los videos activos.</p></div>';
  endRenderCache();
}

function openProject(id) { projectId = id; taskCategory = "all"; $("libraryView").classList.add("hidden"); $("projectDetail").classList.remove("hidden"); renderDetail(); }
function closeProject() { projectId = null; $("projectDetail").classList.add("hidden"); $("libraryView").classList.remove("hidden"); renderLibrary(); }
function renderDetail() {
  beginRenderCache();
  const project = projects().find(item => item.id === projectId); if (!project) return closeProject();
  const stats = projectStats(project), status = statusInfo(project.status), channel = channelFor(project);
  const cover = project.imageUrl ? `<img src="${esc(project.imageUrl)}" alt="" />` : emptyThumbnail(project);
  $("projectDetailHero").classList.toggle("vertical-detail", channel?.orientation === "vertical");
  $("projectDetailHero").innerHTML = `<div class="detail-cover">${cover}</div><div class="detail-copy"><span class="detail-eyebrow">${esc(channel?.name || "Canal")} · Video</span><h2>${esc(project.title)}</h2><div class="detail-metrics"><span><strong>${stats.tasks}</strong> tareas</span><span><strong>${stats.sessions}</strong> sesiones</span><span><strong>${stats.hours.toFixed(1)}</strong> horas</span></div><div class="project-schedule"><label><span>Inicio</span><input class="light-input" id="detailStartDate" type="date" value="${esc(project.startDate || "")}" /></label><label><span>Fecha límite</span><input class="light-input" id="detailDueDate" type="date" value="${esc(project.dueDate || "")}" /></label><label class="project-auto-start"><input id="detailAutoStart" type="checkbox" ${project.autoStartOnPlanning ? "checked" : ""}/><span>Asignar inicio al pasar a Plani</span></label><button class="ui-btn quiet" id="saveProjectDates">Guardar fechas</button></div></div><div class="detail-actions"><select class="status-select" id="detailStatus">${STATUSES.map(item => `<option value="${item.id}" ${item.id === status.id ? "selected" : ""}>${item.icon} ${item.label}</option>`).join("")}</select><button class="ui-btn quiet" id="renameProjectBtn">Editar título</button><button class="ui-btn quiet" id="moveProjectBtn">Mover de canal</button><button class="ui-btn quiet" id="archiveProjectBtn">${project.archived ? "Restaurar" : "Archivar"}</button><button class="ui-btn danger" id="deleteProjectBtn">Borrar</button></div>`;
  $("detailStatus").addEventListener("change", event => updateProjectStatus(project, event.target.value));
  $("saveProjectDates").addEventListener("click", () => saveProjectDates(project.id));
  $("renameProjectBtn").addEventListener("click", () => renameProject(project.id));
  $("moveProjectBtn").addEventListener("click", () => openMoveProjectDialog(project.id));
  $("archiveProjectBtn").addEventListener("click", () => archiveProject(project.id, true));
  $("deleteProjectBtn").addEventListener("click", () => deleteProject(project.id, true));
  renderTaskFilters(); renderTasks();
  endRenderCache();
}

function renderTaskFilters() {
  $("taskCategoryFilters").innerHTML = CATEGORIES.map(item => `<button class="task-filter ${taskCategory === item.id ? "active" : ""}" data-category="${item.id}">${item.label}</button>`).join("");
  $("taskCategoryFilters").querySelectorAll("[data-category]").forEach(button => button.addEventListener("click", () => { taskCategory = button.dataset.category; if (taskCategory !== "all") $("newTaskCategory").value = taskCategory; renderTaskFilters(); renderTasks(); }));
}
function renderTasks() {
  const list = $("dayTaskList");
  const projectTasks = tasks().filter(task => !task.deleted && task.projectId === projectId);
  const filtered = projectTasks.filter(task => !task.parentTaskId && (taskCategory === "all" || task.category === taskCategory));
  const pending = filtered.filter(task => !task.done).sort((a, b) => (a.order ?? 999999) - (b.order ?? 999999) || new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  const completed = filtered.filter(task => task.done).sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  list.innerHTML = "";
  if (!filtered.length) { list.innerHTML = '<div class="todo-empty"><span>✓</span><strong>Todo despejado</strong><p>Agregá la próxima acción para este proyecto.</p></div>'; return; }
  const appendTask = task => {
    const subtasks = projectTasks.filter(item => item.parentTaskId === task.id).sort((a,b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)), expanded = expandedTaskIds.has(task.id);
    const row = document.createElement("article"); row.className = `todo-row ${task.done ? "done" : ""} priority-${task.priority || "medium"}`; row.dataset.taskId = task.id; row.draggable = !task.done;
    const due = task.dueDate ? ` · <b class="${isOverdue(task) ? "overdue" : ""}">${taskDateLabel(task.dueDate)}</b>` : "";
    const sessionCount = new Set(task.sessionIds || []).size || Number(task.sessionCount) || 0;
    const completedAt = task.done && task.completedAt ? ` · Completada ${new Date(task.completedAt).toLocaleString("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "";
    const estimated = Math.max(0, Number(task.estimatedSessions) || 0);
    const sessionLabel = estimated ? `${sessionCount}/${estimated} sesiones` : `${sessionCount} ${sessionCount === 1 ? "sesión" : "sesiones"}`;
    const dependencies=(task.blockedByTaskIds||[]).filter(id=>projectTasks.some(item=>item.id===id&&!item.deleted));
    const automation = task.activateDate ? ` · Activa ${taskDateLabel(task.activateDate)}` : dependencies.length ? ` · Depende de ${dependencies.length}` : "";
    const effort = ` · ${sessionLabel} · ${formatTaskDuration(task.focusedSecs)}${automation}${completedAt}`;
    row.innerHTML = `<button class="task-drag-handle" type="button" title="Arrastrar para cambiar el orden">⋮⋮</button><button class="todo-check" aria-label="Completar">${task.done ? "✓" : ""}</button><button class="subtask-toggle ${expanded ? "expanded" : ""}" title="${subtasks.length ? "Mostrar subtareas" : "Agregar subtarea"}">${expanded ? "▾" : "▸"}<small>${subtasks.length || "+"}</small></button><button class="todo-copy" type="button"><strong>${esc(task.text)}</strong><span><i class="category-dot ${task.category || "inbox"}"></i>${categoryLabel(task.category)}${due}${effort}</span></button><button class="priority-button" title="Cambiar prioridad">⚑</button><button class="session-button" title="Asignar a próxima sesión disponible">→ próxima</button><button class="todo-delete" title="Eliminar">×</button>`;
    row.querySelector(".todo-check").addEventListener("click", () => updateTask(task.id, { done: !task.done, completedAt: !task.done ? new Date().toISOString() : null }));
    row.querySelector(".todo-copy").addEventListener("click", () => editTask(task));
    row.querySelector(".priority-button").addEventListener("click", () => { const values = ["low", "medium", "high"]; updateTask(task.id, { priority: values[(values.indexOf(task.priority || "medium") + 1) % values.length] }); });
    row.querySelector(".session-button").addEventListener("click", () => assignToNextSessions(task));
    row.querySelector(".todo-delete").addEventListener("click", () => deleteTaskEverywhere(task.id));
    row.querySelector(".subtask-toggle").addEventListener("click", () => { expanded ? expandedTaskIds.delete(task.id) : expandedTaskIds.add(task.id); renderTasks(); });
    row.addEventListener("dragstart", event => { if (task.done) return event.preventDefault(); draggedTaskId = task.id; row.classList.add("dragging-task"); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", task.id); });
    row.addEventListener("dragend", () => { draggedTaskId = null; row.classList.remove("dragging-task"); document.querySelectorAll(".task-drop-target").forEach(item => item.classList.remove("task-drop-target")); });
    row.addEventListener("dragover", event => { if (!draggedTaskId || task.done || draggedTaskId === task.id) return; event.preventDefault(); row.classList.add("task-drop-target"); });
    row.addEventListener("dragleave", event => { if (!row.contains(event.relatedTarget)) row.classList.remove("task-drop-target"); });
    row.addEventListener("drop", event => { if (!draggedTaskId || task.done) return; event.preventDefault(); row.classList.remove("task-drop-target"); reorderTask(draggedTaskId, task.id); });
    list.appendChild(row);
    const panel = document.createElement("div"); panel.className = `subtask-panel ${expanded ? "expanded" : ""}`;
    panel.innerHTML = `<div class="subtask-list">${subtasks.map(subtask => { const count=new Set(subtask.sessionIds||[]).size,estimate=Math.max(0,Number(subtask.estimatedSessions)||0); return `<article class="subtask-row ${subtask.done ? "done" : ""}" data-subtask-id="${esc(subtask.id)}"><button class="todo-check" data-subtask-check>${subtask.done ? "✓" : ""}</button><button class="subtask-copy" data-subtask-edit><strong>${esc(subtask.text)}</strong><span>${count}${estimate?`/${estimate}`:""} sesiones · ${formatTaskDuration(subtask.focusedSecs || 0)} trabajados</span></button><button class="session-button" data-subtask-session>→ próxima</button><button class="todo-delete" data-subtask-delete>×</button></article>`; }).join("")}</div><form class="subtask-add"><input maxlength="160" placeholder="Agregar subtarea" /><button type="submit">+</button></form>`;
    panel.querySelectorAll("[data-subtask-id]").forEach(child => { const subtask = subtasks.find(item => item.id === child.dataset.subtaskId); child.querySelector("[data-subtask-check]").addEventListener("click", () => updateTask(subtask.id, { done:!subtask.done, completedAt:!subtask.done ? new Date().toISOString() : null })); child.querySelector("[data-subtask-edit]").addEventListener("click", () => editTask(subtask)); child.querySelector("[data-subtask-session]").addEventListener("click", () => assignToNextSessions(subtask)); child.querySelector("[data-subtask-delete]").addEventListener("click", () => deleteTaskEverywhere(subtask.id)); });
    panel.querySelector(".subtask-add").addEventListener("submit", event => addSubtask(event, task));
    list.appendChild(panel);
  };
  pending.forEach(appendTask);
  if (completed.length) {
    const heading = document.createElement("div"); heading.className = "completed-task-heading";
    heading.innerHTML = `<span>✓ Tareas completadas</span><small>${completed.length}</small>`;
    list.appendChild(heading);
    completed.forEach(appendTask);
  }
}

function addSubtask(event, parent) {
  event.preventDefault(); const input = event.currentTarget.querySelector("input"), text = input.value.trim(); if (!text) return;
  const all = readArray(DAY_TASKS_KEY), nowIso=new Date().toISOString(), subtask={ id:uid(), parentTaskId:parent.id, text, done:false, notes:"", priority:parent.priority || "medium", deleted:false, category:parent.category || "inbox", dueDate:parent.dueDate || null, mode:projectWorkChannel(projects().find(project => project.id === parent.projectId)), projectId:parent.projectId, focusedSecs:0, sessionIds:[], createdAt:nowIso };
  const running=activeSession(), sessionTasks=readArray(TASKS_KEY), parentSessionTask=sessionTasks.find(task=>(task.projectTaskId||task.movedFromDayTaskId)===parent.id);
  if(running?.sessionId&&parentSessionTask){
    const sessionTask={id:uid(),parentSessionTaskId:parentSessionTask.id,parentProjectTaskId:parent.id,projectTaskId:subtask.id,movedFromDayTaskId:subtask.id,text,done:false,notes:"",priority:subtask.priority,deleted:false,focusedSecs:0,createdAt:nowIso};
    subtask.sessionIds=[running.sessionId];subtask.sessionCount=1;sessionTasks.push(sessionTask);
    localStorage.setItem(TASKS_KEY,JSON.stringify(sessionTasks));
    localStorage.setItem(SESSIONS_KEY,JSON.stringify(readArray(SESSIONS_KEY).map(session=>session.id===running.sessionId?{...session,tasks:sessionTasks}:session)));
    ipcRenderer.send("session-created");
  }
  all.push(subtask); writeArray(DAY_TASKS_KEY, all); expandedTaskIds.add(parent.id); renderDetail();
}

function addTask(event) {
  event.preventDefault(); const text = $("newTaskInput").value.trim(); if (!text || !projectId) return;
  const selectedCategory = taskCategory === "all" ? $("newTaskCategory").value : taskCategory, all = tasks();
  const estimatedSessions = Math.max(0, Math.round(Number($("newTaskEstimate").value) || 0));
  all.push({ id: uid(), text, done: false, notes: "", priority: "medium", deleted: false, category: selectedCategory, dueDate: $("newTaskDue").value || null, estimatedSessions:estimatedSessions || null, order:all.filter(task => !task.deleted && !task.parentTaskId && task.projectId === projectId).length, mode, projectId, createdAt: new Date().toISOString() });
  writeArray(DAY_TASKS_KEY, all); $("newTaskInput").value = ""; $("newTaskDue").value = ""; $("newTaskEstimate").value = ""; renderDetail();
}
function taskDateLabel(date) {
  const due = new Date(date + "T00:00:00"), today = new Date(); today.setHours(0, 0, 0, 0);
  if (due < today) return "Vencida " + due.toLocaleDateString("es-AR", { day: "numeric", month: "short" });
  if (due.getTime() === today.getTime()) return "Hoy";
  return due.toLocaleDateString("es-AR", { day: "numeric", month: "short" });
}
function isOverdue(task) { return task.dueDate && !task.done && new Date(task.dueDate + "T23:59:59") < new Date(); }
function updateTask(id, patch) { const updated=tasks().map(task => task.id === id ? { ...task, ...patch } : task), promoted=promoteReadyTasks(updated); writeArray(DAY_TASKS_KEY, promoted.tasks); renderDetail(); }
function reorderTask(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const all = tasks(), topLevel = all.filter(task => !task.deleted && !task.parentTaskId && task.projectId === projectId && !task.done).sort((a,b)=>(a.order ?? 999999)-(b.order ?? 999999) || new Date(a.createdAt||0)-new Date(b.createdAt||0));
  const sourceIndex = topLevel.findIndex(task => task.id === sourceId), targetIndex = topLevel.findIndex(task => task.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [moved] = topLevel.splice(sourceIndex, 1); topLevel.splice(targetIndex, 0, moved);
  const orderById = new Map(topLevel.map((task, index) => [task.id, index]));
  writeArray(DAY_TASKS_KEY, all.map(task => orderById.has(task.id) ? { ...task, order:orderById.get(task.id), reorderedAt:new Date().toISOString() } : task));
  draggedTaskId = null; renderDetail();
}
function deleteTaskEverywhere(id) {
  const deletedAt = new Date().toISOString(), allTasks = tasks(), ids = new Set([id]);
  allTasks.filter(task => task.parentTaskId === id).forEach(task => ids.add(task.id));
  writeArray(DAY_TASKS_KEY, allTasks.map(task => ids.has(task.id) ? { ...task, deleted:true, deletedAt, sessionIds:[], sessionCount:0 } : task));
  const withoutTask = list => (list || []).filter(task => !ids.has(task.projectTaskId || task.movedFromDayTaskId) && !ids.has(task.id));
  writeArray(SESSIONS_KEY, readArray(SESSIONS_KEY).map(session => ({ ...session, tasks:withoutTask(session.tasks) })));
  writeArray(TASKS_KEY, withoutTask(readArray(TASKS_KEY)));
  ipcRenderer.send("session-created"); renderDetail();
}
function editTask(task) {
  const allTasks=tasks(), byId=new Map(allTasks.map(item=>[item.id,item]));
  const dependsOn=(sourceId,targetId,seen=new Set())=>{if(sourceId===targetId)return true;if(seen.has(sourceId))return false;seen.add(sourceId);return (byId.get(sourceId)?.blockedByTaskIds||[]).some(id=>dependsOn(id,targetId,seen));};
  const dependencyOptions=allTasks.filter(item=>!item.deleted&&item.id!==task.id&&item.projectId===task.projectId&&!dependsOn(item.id,task.id)).map(item=>({id:item.id,text:item.text,done:Boolean(item.done)}));
  openProjectEditor({ eyebrow:"Tarea", title:"Editar tarea", label:"Descripción", value:task.text, dueDate:task.dueDate || "", category:task.category || "inbox", estimatedSessions:task.estimatedSessions || "", activateDate:task.activateDate||"", activateToCategory:task.activateToCategory||"actionable", blockedByTaskIds:task.blockedByTaskIds||[], dependencyOptions, showDate:true, showCategory:true, showEstimate:true, showAutomation:true, onSave:({ text,dueDate,category,estimatedSessions,activateDate,activateToCategory,blockedByTaskIds }) => { const automationChanged=(task.activateDate||"")!==(activateDate||"") || (task.activateToCategory||"actionable")!==(activateToCategory||"actionable") || JSON.stringify([...(task.blockedByTaskIds||[])].sort())!==JSON.stringify([...blockedByTaskIds].sort()); updateTask(task.id, { text, dueDate:dueDate || null, category:category || "inbox", estimatedSessions:estimatedSessions > 0 ? estimatedSessions : null, activateDate:activateDate||null, activateToCategory:activateToCategory||"actionable", blockedByTaskIds, automationResolvedAt:automationChanged?null:task.automationResolvedAt||null, editedAt:new Date().toISOString() }); } });
}

function activeSession() { try { return JSON.parse(localStorage.getItem(ACTIVE_SESSION_KEY) || "null"); } catch { return null; } }
function importToSession(task) {
  const active = activeSession(); if (!active?.sessionId) { alert("Iniciá una sesión para importar esta tarea."); return; }
  const sessionTasks = readArray(TASKS_KEY);
  if (!sessionTasks.some(item => (item.projectTaskId || item.movedFromDayTaskId) === task.id)) sessionTasks.push({ id: uid(), text: task.text, done: false, notes: task.notes || "", priority: task.priority || "medium", deleted: false, projectTaskId: task.id, movedFromDayTaskId: task.id, focusedSecs: 0, importedAt: new Date().toISOString() });
  writeArray(TASKS_KEY, sessionTasks);
  writeArray(SESSIONS_KEY, readArray(SESSIONS_KEY).map(session => session.id === active.sessionId ? { ...session, tasks: sessionTasks } : session));
  writeArray(DAY_TASKS_KEY, tasks().map(item => item.id === task.id ? { ...item, sessionIds: [...new Set([...(item.sessionIds || []), active.sessionId])], sessionCount: new Set([...(item.sessionIds || []), active.sessionId]).size } : item));
  ipcRenderer.send("session-created"); alert("Tarea agregada a la sesión actual.");
}

function assignToNextSessions(task) {
  const requested = window.prompt("¿A cuántas próximas sesiones querés asignarla?", "1");
  if (requested === null) return;
  const count = Math.max(1, Math.min(20, Number.parseInt(requested, 10) || 1));
  const project = projects().find(item => item.id === task.projectId), channel = project ? projectWorkChannel(project) : (task.mode || mode);
  const future = readArray(SESSIONS_KEY).filter(session => session.status === "pending" && new Date(session.startAt) > new Date() && (session.workArea || "personal") === channel).sort((a,b) => new Date(a.startAt)-new Date(b.startAt));
  if (!future.length) { alert(`No hay sesiones futuras disponibles en ${workChannelInfo(channel)?.name || channel}.`); return; }
  const selected = future.slice(0, count), selectedIds = new Set(selected.map(session => session.id));
  const nextSessions = readArray(SESSIONS_KEY).map(session => {
    if (!selectedIds.has(session.id)) return session;
    const sessionTasks = Array.isArray(session.tasks) ? [...session.tasks] : [];
    if (!sessionTasks.some(item => (item.projectTaskId || item.movedFromDayTaskId) === task.id)) sessionTasks.push({ id:uid(), projectTaskId:task.id, movedFromDayTaskId:task.id, text:task.text, notes:task.notes||"", priority:task.priority||"medium", done:false, deleted:false, focusedSecs:0, importedAt:new Date().toISOString() });
    return { ...session, tasks:sessionTasks };
  });
  writeArray(SESSIONS_KEY, nextSessions);
  writeArray(DAY_TASKS_KEY, tasks().map(item => item.id === task.id ? { ...item, sessionIds:[...new Set([...(item.sessionIds||[]), ...selectedIds])], sessionCount:new Set([...(item.sessionIds||[]), ...selectedIds]).size } : item));
  ipcRenderer.send("session-created"); renderDetail();
  alert(`Asignada a ${selected.length} ${selected.length === 1 ? "sesión" : "sesiones"}.`);
}

function updateProject(id, patch) { writeArray(PROJECTS_KEY, projects().map(project => project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)); projectId ? renderDetail() : renderLibrary(); }
function updateProjectStatus(project, status) {
  const patch = { status };
  if (status === "planning" && project.autoStartOnPlanning && !project.startDate) patch.startDate = todayKey();
  updateProject(project.id, patch);
}
function saveProjectDates(id) {
  const startDate = $("detailStartDate").value || null, dueDate = $("detailDueDate").value || null;
  if (startDate && dueDate && startDate > dueDate) { alert("La fecha de inicio no puede ser posterior a la fecha límite."); return; }
  const autoStartOnPlanning = $("detailAutoStart").checked, project = projects().find(item => item.id === id), patch = { startDate, dueDate, autoStartOnPlanning };
  if (!startDate && autoStartOnPlanning && project?.status === "planning") patch.startDate = todayKey();
  updateProject(id, patch);
}
function renameProject(id) { const project = projects().find(item => item.id === id); if (project) openProjectEditor({ eyebrow:"Video / proyecto", title:"Editar título", label:"Título", value:project.title, onSave:({text}) => updateProject(id, { title:text }) }); }
function cycleProjectStatus(id) { const project = projects().find(item => item.id === id), current = STATUSES.findIndex(item => item.id === (project?.status || "idea")); if (project) updateProjectStatus(project, STATUSES[(current + 1) % STATUSES.length].id); }
function archiveProject(id, leaveDetail = false) {
  const project = projects().find(item => item.id === id); if (!project) return;
  writeArray(PROJECTS_KEY, projects().map(item => item.id === id ? { ...item, archived: !project.archived, archivedAt: !project.archived ? new Date().toISOString() : null } : item));
  leaveDetail ? closeProject() : renderLibrary();
}
function deleteProject(id, leaveDetail = false) {
  const project = projects().find(item => item.id === id); if (!project) return;
  if (!window.confirm(`¿Seguro que querés borrar “${project.title}”? Sus tareas también se quitarán de las sesiones.`)) return;
  const projectTasks = tasks().filter(task => task.projectId === id), taskIds = new Set(projectTasks.map(task => task.id)), deletedAt = new Date().toISOString();
  const withoutProjectTasks = list => (list || []).filter(task => !taskIds.has(task.projectTaskId || task.movedFromDayTaskId) && !taskIds.has(task.id));
  writeArray(PROJECTS_KEY, projects().filter(item => item.id !== id));
  writeArray(DAY_TASKS_KEY, tasks().map(task => task.projectId === id ? { ...task, deleted:true, deletedAt, sessionIds:[], sessionCount:0 } : task));
  writeArray(SESSIONS_KEY, readArray(SESSIONS_KEY).map(session => ({ ...session, tasks:withoutProjectTasks(session.tasks) })));
  writeArray(TASKS_KEY, withoutProjectTasks(readArray(TASKS_KEY)));
  ipcRenderer.send("session-created");
  if (leaveDetail || projectId === id) closeProject(); else renderLibrary();
}
function reorderProject(sourceId, targetId, channelId) {
  if (!sourceId || sourceId === targetId) return;
  const all = projects(), source = all.find(item => item.id === sourceId), target = all.find(item => item.id === targetId); if (!source || !target) return;
  const ordered = all.filter(item => projectWorkChannel(item) === mode && channelFor(item)?.id === channelId && item.id !== sourceId).sort((a, b) => (a.order ?? 999999) - (b.order ?? 999999));
  ordered.splice(Math.max(0, ordered.findIndex(item => item.id === targetId)), 0, source);
  ordered.forEach((item, order) => { const original = all.find(project => project.id === item.id); original.order = order; original.channelId = channelId; });
  writeArray(PROJECTS_KEY, all); renderLibrary();
}
function moveProjectToChannel(id, channelId) { if (id) updateProject(id, { channelId, order: projects().filter(project => project.channelId === channelId).length }); }
function reorderChannel(sourceId, targetId) {
  if (!sourceId || sourceId === targetId) return;
  const all = channels(), source = all.find(item => item.id === sourceId), target = all.find(item => item.id === targetId);
  if (!source || !target || source.mode !== target.mode) return;
  const ordered = all.filter(item => item.mode === source.mode && item.id !== sourceId).sort((a,b) => (a.order ?? 999999) - (b.order ?? 999999));
  ordered.splice(Math.max(0, ordered.findIndex(item => item.id === targetId)), 0, source);
  ordered.forEach((item, order) => { item.order = order; });
  writeArray(CHANNELS_KEY, all); renderLibrary();
}
function archiveChannel(id) {
  const current = channels().find(item => item.id === id); if (!current) return;
  writeArray(CHANNELS_KEY, channels().map(item => item.id === id ? { ...item, archived:!current.archived, archivedAt:!current.archived ? new Date().toISOString() : null } : item));
  renderLibrary();
}
function deleteChannel(id) {
  const allChannels = channels(), current = allChannels.find(item => item.id === id); if (!current) return;
  const affected = projects().filter(project => channelFor(project)?.id === id);
  if (!window.confirm(`¿Eliminar la sección “${current.name}”?${affected.length ? ` Sus ${affected.length} proyecto${affected.length === 1 ? "" : "s"} se moverán a otra sección.` : ""}`)) return;
  let fallback = allChannels.filter(item => item.mode === current.mode && item.id !== id && !item.archived).sort((a,b) => (a.order || 0) - (b.order || 0))[0];
  if (!fallback) { fallback = { id:`section-${uid()}`, name:"General", mode:current.mode, orientation:"horizontal", order:0, createdAt:new Date().toISOString() }; allChannels.push(fallback); }
  const remaining = allChannels.filter(item => item.id !== id);
  remaining.filter(item => item.mode === current.mode).sort((a,b) => (a.order || 0) - (b.order || 0)).forEach((item, order) => { item.order = order; });
  const fallbackCount = projects().filter(project => project.channelId === fallback.id).length;
  writeArray(CHANNELS_KEY, remaining);
  if (affected.length) {
    const affectedOrder = new Map(affected.map((project, index) => [project.id, fallbackCount + index]));
    writeArray(PROJECTS_KEY, projects().map(project => affectedOrder.has(project.id) ? { ...project, channelId:fallback.id, order:affectedOrder.get(project.id) } : project));
  }
  renderLibrary();
}
function fillMoveProjectSections(workChannelId, selectedId = "") {
  const available = ensureChannels().filter(channel => channel.mode === workChannelId && !channel.archived).sort((a,b) => (a.order || 0) - (b.order || 0));
  $("moveProjectSection").innerHTML = available.map(channel => `<option value="${esc(channel.id)}">${esc(channel.name)}</option>`).join("");
  $("moveProjectSection").value = available.some(channel => channel.id === selectedId) ? selectedId : (available[0]?.id || "");
}
function openMoveProjectDialog(id) {
  const project = projects().find(item => item.id === id); if (!project) return;
  movingProjectId = id; $("moveProjectTitle").textContent = project.title;
  const available = ensureWorkChannels().filter(channel => !channel.hiddenFromVideos && channel.id !== "routine");
  $("moveProjectWorkChannel").innerHTML = available.map(channel => `<option value="${esc(channel.id)}">${esc(channel.name)}</option>`).join("");
  $("moveProjectWorkChannel").value = projectWorkChannel(project); fillMoveProjectSections($("moveProjectWorkChannel").value, project.channelId);
  $("moveProjectDialog").showModal();
}
function closeMoveProjectDialog() { movingProjectId = null; $("moveProjectDialog").close(); }
function moveProjectAcrossChannels(id, workChannelId, channelId) {
  const project = projects().find(item => item.id === id), channel = workChannelInfo(workChannelId); if (!project || !channelId) return;
  writeArray(PROJECTS_KEY, projects().map(item => item.id === id ? { ...item, workChannelId, mode:workChannelId, channelId, updatedAt:new Date().toISOString() } : item));
  writeArray(DAY_TASKS_KEY, tasks().map(task => task.projectId === id ? { ...task, mode:workChannelId } : task));
  writeArray(SESSIONS_KEY, readArray(SESSIONS_KEY).map(session => session.projectId === id ? { ...session, workArea:workChannelId, workAreaName:channel.name, projectName:project.title } : session));
  mode = workChannelId; localStorage.setItem("justtimer.workArea.v1", mode); ipcRenderer.send("session-created"); closeMoveProjectDialog(); closeProject();
}
function renameChannel(id) {
  const channel = channels().find(item => item.id === id); if (!channel) return;
  openProjectEditor({ eyebrow:"Sección", title:"Editar sección", label:"Nombre", value:channel.name, onSave:({text}) => { writeArray(CHANNELS_KEY, channels().map(item => item.id === id ? { ...item, name:text } : item)); renderLibrary(); } });
}
function openProjectEditor({ eyebrow="Editar", title="Editar", label="Nombre", value="", dueDate="", category="inbox", estimatedSessions="", activateDate="", activateToCategory="actionable", blockedByTaskIds=[], dependencyOptions=[], showDate=false, showCategory=false, showEstimate=false, showAutomation=false, onSave }) {
  pendingEditorSave = onSave;
  $("projectEditEyebrow").textContent = eyebrow; $("projectEditTitle").textContent = title; $("projectEditTextLabel").firstChild.textContent = label;
  $("projectEditText").value = value; $("projectEditDate").value = dueDate; $("projectEditDateRow").classList.toggle("hidden", !showDate); $("projectEditCategory").value = category; $("projectEditCategoryRow").classList.toggle("hidden", !showCategory); $("projectEditEstimate").value = estimatedSessions; $("projectEditEstimateRow").classList.toggle("hidden", !showEstimate);
  $("projectEditActivateDate").value=activateDate; $("projectEditActivateTo").value=activateToCategory; $("projectEditAutomationRows").classList.toggle("hidden",!showAutomation); $("projectEditDependenciesRow").classList.toggle("hidden",!showAutomation);
  const selectedDependencies=new Set(blockedByTaskIds); $("projectEditDependencies").innerHTML=dependencyOptions.length?`<div class="task-dependency-options">${dependencyOptions.map(item=>`<label><input type="checkbox" value="${esc(item.id)}" ${selectedDependencies.has(item.id)?"checked":""}><span>${item.done?"✓ ":""}${esc(item.text)}</span></label>`).join("")}</div>`:"<p>No hay otras tareas en este proyecto.</p>";
  $("projectEditDialog").showModal(); requestAnimationFrame(() => { $("projectEditText").focus(); $("projectEditText").select(); });
}
function closeProjectEditor() { pendingEditorSave = null; $("projectEditDialog").close(); }
function openProjectForm(channelId) {
  renderProjectFormOptions(); if (channelId) $("projectChannel").value = channelId;
  $("projectStartDate").value = ""; $("projectDueDate").value = ""; $("projectAutoStart").checked = true;
  closeForms(); $("projectForm").classList.remove("hidden"); $("projectName").focus();
}
function closeForms() { $("projectForm").classList.add("hidden"); $("channelForm").classList.add("hidden"); $("workChannelForm").classList.add("hidden"); }
function openWorkChannelForm(editId = null) {
  closeForms(); editingWorkChannelId = editId; selectedWorkChannelImage = null;
  const channel = editId ? workChannelInfo(editId) : null;
  $("workChannelFormTitle").textContent = channel ? `Editar ${channel.name}` : "Nuevo canal";
  $("workChannelName").value = channel?.name || ""; $("workChannelImage").value = channel?.avatarUrl?.startsWith("http") ? channel.avatarUrl : "";
  $("uploadWorkChannelImage").textContent = channel?.avatarUrl ? "Cambiar foto" : "Subir foto";
  $("workChannelForm").classList.remove("hidden"); $("workChannelName").focus();
}

$("newProjectBtn").addEventListener("click", () => openProjectForm());
$("cancelProjectBtn").addEventListener("click", closeForms);
$("newChannelBtn").addEventListener("click", () => { closeForms(); $("channelForm").classList.remove("hidden"); $("channelName").focus(); });
$("cancelChannelBtn").addEventListener("click", closeForms);
$("archivedProjectsBtn").addEventListener("click", () => { showArchived = !showArchived; statusFilter = "all"; renderLibrary(); });
$("backToProjects").addEventListener("click", closeProject);
$("taskForm").addEventListener("submit", addTask);
$("moveProjectWorkChannel").addEventListener("change", event => fillMoveProjectSections(event.target.value));
$("moveProjectClose").addEventListener("click", closeMoveProjectDialog);
$("moveProjectCancel").addEventListener("click", closeMoveProjectDialog);
$("moveProjectForm").addEventListener("submit", event => { event.preventDefault(); if (movingProjectId) moveProjectAcrossChannels(movingProjectId, $("moveProjectWorkChannel").value, $("moveProjectSection").value); });
$("projectEditForm").addEventListener("submit", event => { event.preventDefault(); const text = $("projectEditText").value.trim(); if (!text || !pendingEditorSave) return; const save = pendingEditorSave, dueDate = $("projectEditDateRow").classList.contains("hidden") ? "" : $("projectEditDate").value, category = $("projectEditCategoryRow").classList.contains("hidden") ? null : $("projectEditCategory").value, estimatedSessions = $("projectEditEstimateRow").classList.contains("hidden") ? null : Math.max(0, Math.round(Number($("projectEditEstimate").value) || 0)), activateDate=$("projectEditAutomationRows").classList.contains("hidden")?null:$("projectEditActivateDate").value, activateToCategory=$("projectEditAutomationRows").classList.contains("hidden")?null:$("projectEditActivateTo").value, blockedByTaskIds=$("projectEditDependenciesRow").classList.contains("hidden")?[]:[...$("projectEditDependencies").querySelectorAll("input:checked")].map(input=>input.value); pendingEditorSave = null; $("projectEditDialog").close(); save({ text, dueDate, category, estimatedSessions, activateDate, activateToCategory, blockedByTaskIds }); });
$("projectEditClose").addEventListener("click", closeProjectEditor);
$("projectEditCancel").addEventListener("click", closeProjectEditor);
$("channelForm").addEventListener("submit", event => {
  event.preventDefault(); const name = $("channelName").value.trim(); if (!name) return;
  const all = channels(); all.push({ id: uid(), name, mode, orientation:$("channelOrientation").value === "vertical" ? "vertical" : "horizontal", order: all.filter(item => item.mode === mode).length, createdAt: new Date().toISOString() });
  writeArray(CHANNELS_KEY, all); $("channelName").value = ""; closeForms(); renderLibrary();
});
$("uploadProjectImageBtn").addEventListener("click", async () => { selectedProjectImage = await ipcRenderer.invoke("select-project-image"); if (selectedProjectImage) $("uploadProjectImageBtn").textContent = "Miniatura elegida ✓"; });
$("brandMark").addEventListener("click", () => openWorkChannelForm(mode));
$("cancelWorkChannel").addEventListener("click", closeForms);
$("uploadWorkChannelImage").addEventListener("click", async () => { selectedWorkChannelImage = await ipcRenderer.invoke("select-project-image"); if (selectedWorkChannelImage) $("uploadWorkChannelImage").textContent = "Foto elegida ✓"; });
$("workChannelForm").addEventListener("submit", event => {
  event.preventDefault(); const name = $("workChannelName").value.trim(); if (!name) return;
  const all = ensureWorkChannels();
  if (editingWorkChannelId) {
    const current = all.find(channel => channel.id === editingWorkChannelId);
    if (current) { current.name = name; current.avatarUrl = selectedWorkChannelImage || $("workChannelImage").value.trim() || current.avatarUrl || null; }
  } else {
    const channelId = `channel-${uid()}`; all.push({ id: channelId, name, avatarUrl: selectedWorkChannelImage || $("workChannelImage").value.trim() || null, order: all.length }); mode = channelId; localStorage.setItem("justtimer.workArea.v1", mode);
  }
  writeArray(WORK_CHANNELS_KEY, all); editingWorkChannelId = null; selectedWorkChannelImage = null; closeForms(); ensureChannels(); renderLibrary();
});
$("projectForm").addEventListener("submit", event => {
  event.preventDefault(); const title = $("projectName").value.trim(); if (!title) return;
  let startDate = $("projectStartDate").value || null; const dueDate = $("projectDueDate").value || null, autoStartOnPlanning = $("projectAutoStart").checked, status = $("projectStatus").value;
  if (!startDate && autoStartOnPlanning && status === "planning") startDate = todayKey();
  if (startDate && dueDate && startDate > dueDate) { alert("La fecha de inicio no puede ser posterior a la fecha límite."); return; }
  const all = projects(), channelId = $("projectChannel").value;
  all.push({ id: uid(), title, imageUrl: selectedProjectImage || $("projectImage").value.trim() || null, mode: mode === "work" ? "work" : "personal", workChannelId: mode, channelId, type: "video", status, startDate, dueDate, autoStartOnPlanning, order: all.filter(item => item.channelId === channelId).length, archived: false, createdAt: new Date().toISOString() });
  writeArray(PROJECTS_KEY, all); $("projectName").value = ""; $("projectImage").value = ""; selectedProjectImage = null;
  $("uploadProjectImageBtn").textContent = "Subir miniatura"; closeForms(); renderLibrary();
});
$("closeBtn").addEventListener("click", () => ipcRenderer.send("close-current-window"));
document.addEventListener("click", event => { if (!event.target.closest(".card-menu") && !event.target.closest(".card-popover")) document.querySelectorAll(".card-popover").forEach(item => item.classList.add("hidden")); });
window.addEventListener("focus", () => { applyTaskAutomations(); projectId ? renderDetail() : renderLibrary(); });
function hasUnsavedTaskDraft() {
  if ($("projectEditDialog")?.open) return true;
  if ($("newTaskInput")?.value.trim()) return true;
  return [...document.querySelectorAll(".subtask-add input")].some(input=>input.value.trim());
}
window.addEventListener("storage", event => {
  if ([DAY_TASKS_KEY, SESSIONS_KEY, TASKS_KEY].includes(event.key)) {
    if (projectId&&hasUnsavedTaskDraft()) pendingExternalTaskRefresh=true;
    else { pendingExternalTaskRefresh=false; projectId ? renderDetail() : renderLibrary(); }
  }
  if (event.key === OPEN_PROJECT_KEY && event.newValue) { const target = projects().find(item => item.id === event.newValue && !item.archived); if (target) openProject(target.id); localStorage.removeItem(OPEN_PROJECT_KEY); }
});
document.addEventListener("input",event=>{
  if(!event.target.matches(".subtask-add input,#newTaskInput,#projectEditDialog input,#projectEditDialog select"))return;
  if(hasUnsavedTaskDraft())pendingExternalTaskRefresh=true;
  else if(pendingExternalTaskRefresh){pendingExternalTaskRefresh=false;projectId?renderDetail():renderLibrary();}
});

syncDueTasksToToday(); applyTaskAutomations(); ensureWorkChannels(); ensureChannels();
renderLibrary();
const requestedProjectId = localStorage.getItem(OPEN_PROJECT_KEY);
if (requestedProjectId && projects().some(item => item.id === requestedProjectId && !item.archived)) openProject(requestedProjectId);
localStorage.removeItem(OPEN_PROJECT_KEY);
setInterval(() => { if (applyTaskAutomations()) projectId ? renderDetail() : renderLibrary(); }, 60_000);
