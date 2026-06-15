const { ipcRenderer } = require("electron");

const SESSIONS_KEY = "justtimer.sessions.v1";
const DAYS = ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"];
const SLOT_HEIGHT = 28;

let weekStart = startOfWeek(new Date());
let selectedStart = null;
let selectedSessionId = null;
let visibleDays = 7;
let didAutoScroll = false;
let registerMode = false;

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

function sessionPreview(session, start) {
  const energy = session.energy ? ` e${session.energy}` : "";
  const label = session.label ? ` ${session.label}` : "";
  const tasks = Array.isArray(session.tasks) && session.tasks.length
    ? ` ${session.tasks.filter(task => task.done).length}/${session.tasks.length}`
    : "";
  return `${fmtHour(start)}${energy}\n${tasks}${label}`.trim();
}

function renderCalendar() {
  const grid = $("calendarGrid");
  grid.innerHTML = "";

  const days = getVisibleDays();
  grid.style.setProperty("--day-count", String(days.length));
  $("weekLabel").textContent = `${fmtDate(days[0])} - ${fmtDate(days.at(-1))}/${days.at(-1).getFullYear()}`;
  $("selectedInfo").textContent = selectedStart
    ? `Seleccionado: ${fmtDate(selectedStart)} ${fmtHour(selectedStart)} - ${getDurationMinutes()} min`
    : registerMode
      ? "Modo registro: elegi cualquier bloque pasado o futuro"
      : "Elegi un bloque futuro de 15 minutos";

  grid.appendChild(cell("cal-corner", ""));
  days.forEach(day => {
    grid.appendChild(cell("cal-day-head", `${DAYS[day.getDay() === 0 ? 6 : day.getDay() - 1]} ${day.getDate()}`));
  });

  const now = new Date();
  const currentVisible = days.some(day => day.toDateString() === now.toDateString());
  const sessions = readSessions().filter(session => session.status !== "cancelled");

  for (let hour = 0; hour < 24; hour += 1) {
    for (let quarter = 0; quarter < 4; quarter += 1) {
      const minute = quarter * 15;
      grid.appendChild(cell("cal-hour", quarter === 0 ? `${hour}:00` : ""));

      days.forEach(day => {
        const slotTime = new Date(day);
        slotTime.setHours(hour, minute, 0, 0);

        const isPast = slotTime < now;
        const slot = cell(`cal-slot ${isPast ? "past" : "available"}`, "");
        slot.dataset.start = slotTime.toISOString();

        const isCurrentSlot = currentVisible &&
          slotTime.getHours() === now.getHours() &&
          slotTime.getMinutes() <= now.getMinutes() &&
          now.getMinutes() < slotTime.getMinutes() + 15;

        if (isCurrentSlot) {
          const pct = ((now.getMinutes() - minute) / 15) * 100;
          slot.classList.add("now-slot");
          slot.style.setProperty("--now-offset", `${pct}%`);
        }

        if (selectedStart && slotTime.getTime() === selectedStart.getTime()) {
          slot.classList.add("selected");
        }

        const session = sessions.find(item => new Date(item.startAt).getTime() === slotTime.getTime());
        if (session) {
          const chip = document.createElement("div");
          const durationSlots = Math.max(1, Math.ceil(session.durationSecs / (15 * 60)));
          chip.className = `session-chip ${energyClass(session.energy)}`;
          chip.style.height = `${durationSlots * SLOT_HEIGHT - 4}px`;
          chip.style.zIndex = session.status === "done" ? "3" : "2";
          chip.textContent = sessionPreview(session, slotTime);
          slot.classList.toggle("session-selected", selectedSessionId === session.id);
          slot.appendChild(chip);
          slot.addEventListener("click", event => {
            event.stopPropagation();
            selectedStart = null;
            selectedSessionId = session.id;
            renderSidePanel();
            renderCalendar();
          });
        } else if (!isPast || registerMode) {
          slot.addEventListener("click", () => {
            selectedStart = slotTime;
            selectedSessionId = null;
            renderSidePanel();
            renderCalendar();
          });
        }

        grid.appendChild(slot);
      });
    }
  }

  requestAnimationFrame(() => {
    const scrollTarget = Math.max(0, (now.getHours() * 4 - 4) * SLOT_HEIGHT);
    if (currentVisible && !didAutoScroll) {
      grid.scrollTop = scrollTarget;
      didAutoScroll = true;
    }
  });
}

function cell(className, text) {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}

function renderSidePanel() {
  const panel = $("sessionSidePanel");
  const session = readSessions().find(item => item.id === selectedSessionId);

  if (!session) {
    panel.innerHTML = `<div class="side-empty">Selecciona una sesion para ver detalles</div>`;
    return;
  }

  const start = new Date(session.startAt);
  const tasks = Array.isArray(session.tasks) ? session.tasks : [];
  panel.innerHTML = `
    <div class="side-title">Editar sesion</div>
    <form class="side-edit-form" id="sideEditForm">
      <input class="tool-input" id="sideLabel" type="text" maxlength="40" placeholder="tipo / etiqueta" value="${escapeAttr(session.label || "")}" />
      <div class="side-edit-grid">
        <input class="tool-input" id="sideStart" type="datetime-local" value="${toDateTimeLocal(start)}" />
        <input class="tool-input" id="sideDuration" type="number" min="1" max="480" value="${Math.max(1, Math.round((session.durationSecs || 0) / 60))}" />
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
      <div class="side-section">Tareas completadas / pendientes</div>
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
      <textarea class="tool-textarea side-task-notes" rows="2" placeholder="Notas de tarea">${escapeHtml(task.notes || "")}</textarea>
    </div>
  `;
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
        done,
      };
      if (done) task.completedAt = original.completedAt || nowIso;
      if (!done) delete task.completedAt;
      return task;
    }).filter(task => task.text);

    const status = $("sideStatus").value;
    const fallbackEnd = new Date(start.getTime() + durationMinutes * 60_000).toISOString();
    return {
      ...session,
      label: $("sideLabel").value.trim(),
      startAt: start.toISOString(),
      durationSecs: durationMinutes * 60,
      status,
      notes: $("sideNotes").value.trim(),
      energy: $("sideEnergy").value ? Number($("sideEnergy").value) : null,
      tasks,
      completedAt: status === "done" ? (session.completedAt || nowIso) : session.completedAt,
      endedAt: status === "done" ? (session.endedAt || fallbackEnd) : session.endedAt,
    };
  });

  writeSessions(sessions);
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

  writeSessions(readSessions().filter(item => item.id !== id));
  selectedSessionId = null;
  renderSidePanel();
  renderCalendar();
  ipcRenderer.send("session-created");
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
  const isPastRecord = registerMode || selectedStart < new Date();
  const endedAt = new Date(selectedStart.getTime() + durationMinutes * 60_000);
  sessions.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    startAt: selectedStart.toISOString(),
    durationSecs: durationMinutes * 60,
    label: $("labelInput").value.trim(),
    status: isPastRecord ? "done" : "pending",
    tasks: [],
    notes: "",
    energy: null,
    completedAt: isPastRecord ? new Date().toISOString() : null,
    endedAt: isPastRecord ? endedAt.toISOString() : null,
    manualRecord: isPastRecord,
    createdAt: new Date().toISOString(),
  });
  writeSessions(sessions);
  ipcRenderer.send("session-created");
  showMsg(isPastRecord ? "Sesion registrada" : `Sesion creada para ${fmtHour(selectedStart)}`);
  selectedStart = null;
  selectedSessionId = null;
  $("labelInput").value = "";
  renderSidePanel();
  renderCalendar();
}

function moveRange(direction) {
  weekStart = addDays(weekStart, direction * visibleDays);
  selectedStart = null;
  selectedSessionId = null;
  didAutoScroll = false;
  renderSidePanel();
  renderCalendar();
}

function goToday() {
  weekStart = visibleDays === 3 ? new Date() : startOfWeek(new Date());
  weekStart.setHours(0, 0, 0, 0);
  selectedStart = null;
  selectedSessionId = null;
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
$("todayBtn").addEventListener("click", goToday);
$("registerModeBtn").addEventListener("click", toggleRegisterMode);
$("weekViewBtn").addEventListener("click", () => setVisibleDays(7));
$("threeDayViewBtn").addEventListener("click", () => setVisibleDays(3));
$("durationSelect").addEventListener("change", renderCalendar);
$("customDuration").addEventListener("input", renderCalendar);
$("saveBtn").addEventListener("click", saveSession);
$("clearBtn").addEventListener("click", () => {
  selectedStart = null;
  selectedSessionId = null;
  $("customDuration").value = "";
  $("labelInput").value = "";
  renderSidePanel();
  renderCalendar();
});
$("closeBtn").addEventListener("click", () => ipcRenderer.send("close-current-window"));

renderSidePanel();
renderCalendar();
setInterval(() => {
  const now = new Date();
  const currentVisible = getVisibleDays().some(day => day.toDateString() === now.toDateString());
  if (currentVisible) renderCalendar();
}, 60_000);
