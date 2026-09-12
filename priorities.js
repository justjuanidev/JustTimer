const { ipcRenderer } = require("electron");
const TASKS_KEY = "justtimer.dayTasks.v1", PROJECTS_KEY = "justtimer.projects.v1", MINI_PROJECTS_KEY = "justtimer.miniProjects.v1", CHANNELS_KEY = "justtimer.workChannels.v1", PRIORITIES_KEY = "justtimer.dailyPriorities.v1";
const $ = id => document.getElementById(id);
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; } };
const write = (key, value) => { localStorage.setItem(key, JSON.stringify(value)); ipcRenderer.send("data-changed"); };
const dateKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
const targetDate = localStorage.getItem("justtimer.priorityTargetDate.v1") || dateKey();
let selectedSlot = 1;
let plan = [];
let selectedProjectId = null;

function uid() { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function tasks() { const value = read(TASKS_KEY, []); return Array.isArray(value) ? value : []; }
function videoProjects() { const value = read(PROJECTS_KEY, []); return Array.isArray(value) ? value : []; }
function miniProjects() { const value = read(MINI_PROJECTS_KEY, []); return Array.isArray(value) ? value : []; }
function projects() { return [...videoProjects(), ...miniProjects().map(project => ({ ...project, title:project.name, workChannelId:"routine", type:"mini-project" }))]; }
function channels() { return read(CHANNELS_KEY, []); }
function projectFor(task) { return projects().find(project => project.id === task.projectId); }
function channelId(task) { const project = projectFor(task); return project?.workChannelId || project?.mode || task.mode || "personal"; }
function channelName(task) { const id = channelId(task); return channels().find(channel => channel.id === id)?.name || (id === "routine" ? "Personal" : id === "work" ? "Laburo" : "JustJuani"); }
function esc(value) { return String(value || "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"); }

function loadPlan() {
  const map = read(PRIORITIES_KEY, {}), raw = Array.isArray(map[targetDate]) ? map[targetDate] : [];
  const allTasks = tasks();
  plan = raw.map((item, index) => { const linked = item.taskId || item.sourceDayTaskId || allTasks.find(task => task.dailyPriorityId === item.id)?.id || null; return { ...item, taskId:linked, sourceDayTaskId:linked, slot:Number(item.slot) || index + 1, kind:item.kind || (index < 3 ? "main" : "additional") }; });
  [1,2,3].forEach(slot => { if (!plan.some(item => item.kind === "main" && item.slot === slot)) plan.push({ id:`slot-${targetDate}-${slot}`, slot, kind:"main", taskId:null, text:"" }); });
}

function renderPlan() {
  const allTasks = tasks(), main = $("mainSlots"), extra = $("extraSlots"); main.innerHTML = ""; extra.innerHTML = "";
  plan.filter(item => item.kind === "main").sort((a,b)=>a.slot-b.slot).forEach(item => main.appendChild(slotRow(item, allTasks)));
  plan.filter(item => item.kind === "additional").sort((a,b)=>a.slot-b.slot).forEach(item => extra.appendChild(slotRow(item, allTasks)));
  if (!extra.children.length) extra.innerHTML = '<p class="priority-empty">Ninguna. Las adicionales nunca se agregan automáticamente.</p>';
}

function slotRow(item, allTasks) {
  const task = allTasks.find(entry => entry.id === item.taskId && !entry.deleted), row = document.createElement("button");
  row.type = "button"; row.className = `priority-slot ${selectedSlot === item.slot ? "selected" : ""} ${task?.done ? "done" : ""}`;
  row.innerHTML = `<span class="slot-number">${item.kind === "main" ? item.slot : "+"}</span><span><strong>${esc(task?.text || item.text || item.snapshotText || "Elegir tarea")}</strong><small>${task ? `${esc(channelName(task))} · ${esc(projectFor(task)?.title || "Sin proyecto")}` : item.taskId ? "Tarea huérfana · podés eliminarla" : "Buscá y seleccioná una tarea existente"}</small></span><span class="slot-actions"><i data-action="clear" title="Quitar de este día">↶</i><i data-action="delete" title="Eliminar tarea">×</i></span>`;
  row.addEventListener("click", event => {
    const action = event.target.dataset.action;
    if (action === "clear") clearPriority(item);
    else if (action === "delete") deleteTaskEverywhere(item, task);
    else selectedSlot = item.slot;
    renderPlan(); renderResults();
  });
  return row;
}

function clearPriority(item) {
  plan = plan.map(entry => entry.id === item.id ? { ...entry, taskId:null, sourceDayTaskId:null, text:"" } : entry).filter(entry => !(entry.id === item.id && entry.kind === "additional"));
}

function deleteTaskEverywhere(item, task) {
  const label = task?.text || item.text || item.snapshotText || "esta prioridad";
  if (!window.confirm(task ? `¿Eliminar “${label}”? También se quitará de todas las sesiones asignadas.` : `Esta tarea ya no es accesible. ¿Limpiar “${label}” de prioridades?`)) return;
  const taskId = task?.id || item.taskId || item.sourceDayTaskId;
  if (taskId) {
    const deletedAt = new Date().toISOString();
    write(TASKS_KEY, tasks().map(entry => entry.id === taskId ? { ...entry, deleted:true, deletedAt, updatedAt:deletedAt } : entry));
    const activeTasks = read("justtimer.tasks.v1", []).filter(entry => entry.id !== taskId && (entry.projectTaskId || entry.movedFromDayTaskId) !== taskId);
    localStorage.setItem("justtimer.tasks.v1", JSON.stringify(activeTasks));
    const sessions = read("justtimer.sessions.v1", []).map(session => ({ ...session, tasks:(session.tasks || []).filter(entry => entry.id !== taskId && (entry.projectTaskId || entry.movedFromDayTaskId) !== taskId) }));
    localStorage.setItem("justtimer.sessions.v1", JSON.stringify(sessions));
  }
  const priorityMap = read(PRIORITIES_KEY, {});
  priorityMap[targetDate] = (priorityMap[targetDate] || []).filter(entry => entry.id !== item.id);
  write(PRIORITIES_KEY, priorityMap);
  clearPriority(item);
  ipcRenderer.send("session-created"); ipcRenderer.send("data-changed");
}

function taskScore(task) {
  const today = dateKey(), project = projectFor(task); let score = 0;
  if (task.dueDate && task.dueDate < today) score += 500;
  if (task.dueDate === today) score += 400;
  if (task.priority === "high") score += 250;
  if (project && !project.archived && !["done","published"].includes(project.status)) score += 100;
  return score - new Date(task.createdAt || 0).getTime() / 1e13;
}

function renderResults() {
  const q = $("searchInput").value.trim().toLowerCase(), filter = $("channelFilter").value, chosen = new Set(plan.map(item=>item.taskId).filter(Boolean)), browser = $("priorityProjectBrowser"), results = $("taskResults");
  if (!selectedProjectId) {
    results.innerHTML = "";
    const availableTasks = tasks().filter(task => !task.deleted && !task.done && (filter === "all" || channelId(task) === filter));
    const projectRows = projects().filter(project => !project.archived && (filter === "all" || (project.workChannelId || project.mode || "personal") === filter)).map(project => ({ project, count:availableTasks.filter(task => task.projectId === project.id).length }));
    const unassignedChannels = [...new Set(availableTasks.filter(task => !task.projectId).map(channelId))].map(id => ({ project:{ id:`__unassigned__:${id}`, title:id === "routine" ? "Personal sin proyecto" : "Tareas generales", workChannelId:id, type:"unassigned" }, count:availableTasks.filter(task => !task.projectId && channelId(task) === id).length }));
    const rows = [...projectRows, ...unassignedChannels].filter(row => !q || row.project.title.toLowerCase().includes(q));
    browser.innerHTML = rows.length ? rows.map(({ project, count }) => `<button class="priority-project-choice" data-project="${esc(project.id)}"><span>${project.type === "mini-project" ? esc(project.icon || "🌱") : project.type === "unassigned" ? "•" : "▶"}</span><span><strong>${esc(project.title)}</strong><small>${esc(channels().find(c=>c.id===(project.workChannelId||project.mode))?.name || (project.workChannelId === "routine" ? "Personal" : "Canal"))} · ${count} tareas pendientes</small></span><b>→</b></button>`).join("") : '<p class="priority-empty">No hay proyectos en este filtro.</p>';
    browser.querySelectorAll("[data-project]").forEach(button => button.addEventListener("click", () => { selectedProjectId = button.dataset.project; $("searchInput").value = ""; renderResults(); }));
    return;
  }
  const isUnassigned = selectedProjectId.startsWith("__unassigned__:"), unassignedChannel = isUnassigned ? selectedProjectId.split(":")[1] : null, project = projects().find(item => item.id === selectedProjectId);
  const projectTitle = isUnassigned ? (unassignedChannel === "routine" ? "Personal sin proyecto" : "Tareas generales") : project?.title || "Proyecto";
  browser.innerHTML = `<div class="priority-project-selected"><button id="backToPriorityProjects" type="button">← Proyectos</button><strong>${esc(projectTitle)}</strong></div>`;
  $("backToPriorityProjects").addEventListener("click", () => { selectedProjectId = null; renderResults(); });
  const list = tasks().filter(task => !task.deleted && !task.done && (isUnassigned ? !task.projectId && channelId(task) === unassignedChannel : task.projectId === selectedProjectId) && (!q || task.text.toLowerCase().includes(q))).sort((a,b) => taskScore(b)-taskScore(a));
  const ids = new Set(list.map(task => task.id)), ordered = [];
  list.filter(task => !task.parentTaskId || !ids.has(task.parentTaskId)).forEach(parent => { ordered.push(parent); list.filter(child => child.parentTaskId === parent.id).forEach(child => ordered.push(child)); });
  results.innerHTML = ordered.length ? ordered.map(task => `<button class="priority-result ${task.parentTaskId?"priority-subtask":""} ${chosen.has(task.id)?"chosen":""}" data-id="${esc(task.id)}"><span><strong>${task.parentTaskId?"↳ ":""}${esc(task.text)}</strong><small>${task.parentTaskId?"Subtarea · ":""}${task.dueDate ? `vence ${task.dueDate}` : esc(channelName(task))}</small></span><b>${task.priority === "high" ? "Urgente" : chosen.has(task.id) ? "Elegida" : "+"}</b></button>`).join("") : '<p class="priority-empty">Este proyecto no tiene tareas pendientes.</p>';
  $("taskResults").querySelectorAll("[data-id]").forEach(button => button.addEventListener("click", () => chooseTask(button.dataset.id)));
}

function chooseTask(taskId) {
  const item = plan.find(entry => entry.slot === selectedSlot) || plan.find(entry => !entry.taskId); if (!item) return;
  plan = plan.map(entry => entry.id === item.id ? { ...entry, taskId, sourceDayTaskId:taskId, text:tasks().find(task=>task.id===taskId)?.text || entry.text, selectedAt:new Date().toISOString() } : (entry.taskId === taskId ? { ...entry, taskId:null, sourceDayTaskId:null, text:"" } : entry)).filter(entry => entry.kind === "main" || entry.taskId);
  renderPlan(); renderResults();
}

function savePlan(close = true) {
  const main = plan.filter(item => item.kind === "main" && item.taskId);
  if (main.length < 3) { alert("Elegí una tarea para cada uno de los tres slots principales."); return; }
  const map = read(PRIORITIES_KEY, {});
  map[targetDate] = plan.filter(item => item.taskId).map(item => ({ ...item, id:item.id.startsWith("slot-") ? `priority-${targetDate}-${uid()}` : item.id, snapshotText:tasks().find(task=>task.id===item.taskId)?.text || item.text }));
  write(PRIORITIES_KEY, map);
  if (close) ipcRenderer.send("close-current-window");
}

function fillFilters() {
  const ids = [...new Set(["routine", "personal", "work", ...channels().filter(channel => !channel.hiddenFromVideos && channel.id !== "routine").map(channel => channel.id), ...tasks().map(channelId)])];
  $("channelFilter").innerHTML = '<option value="all">Todos los canales</option>' + ids.map(id => `<option value="${esc(id)}">${esc(id === "routine" ? "Personal" : channels().find(c=>c.id===id)?.name || id)}</option>`).join("");
  $("newChannel").innerHTML = ids.map(id => `<option value="${esc(id)}">${esc(channels().find(c=>c.id===id)?.name || id)}</option>`).join("");
  fillProjects();
}
function fillProjects() { const channel = $("newChannel").value; $("newProject").innerHTML = '<option value="">Sin proyecto</option>' + projects().filter(p => !p.archived && (p.workChannelId || p.mode || "personal") === channel).map(p => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join(""); }
function createTask(event) {
  event.preventDefault(); const text = $("newTaskName").value.trim(); if (!text) return;
  const all = tasks(), task = { id:uid(), text, done:false, notes:"", priority:"medium", deleted:false, category:"inbox", dueDate:$("newDue").value || null, mode:$("newChannel").value, projectId:$("newProject").value || null, focusedSecs:0, sessionIds:[], createdAt:new Date().toISOString() };
  all.push(task); write(TASKS_KEY, all); chooseTask(task.id); $("createForm").classList.add("hidden"); $("newTaskName").value="";
}

$("priorityDate").textContent = new Date(`${targetDate}T12:00:00`).toLocaleDateString("es-AR", { weekday:"long", day:"numeric", month:"long" });
$("historyDate").value = targetDate;
$("historyDate").addEventListener("change", event => { if (!event.target.value) return; localStorage.setItem("justtimer.priorityTargetDate.v1", event.target.value); location.reload(); });
if (targetDate !== dateKey()) $("priorityTitle").textContent = "Preparar las prioridades de mañana";
$("closeBtn").addEventListener("click",()=>ipcRenderer.send("close-current-window"));
$("saveBtn").addEventListener("click",()=>savePlan());
$("searchInput").addEventListener("input",renderResults); $("channelFilter").addEventListener("change",()=>{ selectedProjectId=null; renderResults(); });
$("addExtraBtn").addEventListener("click",()=>{ const slot = Math.max(3,...plan.map(i=>i.slot))+1; plan.push({id:`extra-${targetDate}-${uid()}`,slot,kind:"additional",taskId:null}); selectedSlot=slot; renderPlan(); renderResults(); });
$("createToggle").addEventListener("click",()=>$("createForm").classList.toggle("hidden")); $("newChannel").addEventListener("change",fillProjects); $("createForm").addEventListener("submit",createTask);
loadPlan(); fillFilters(); renderPlan(); renderResults();
