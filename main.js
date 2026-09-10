const { app, BrowserWindow, ipcMain, dialog, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const GoogleCalendar = require("./google-calendar");
const { autoUpdater } = require("electron-updater");
const DATA_SCHEMA_VERSION = 3;
const DATA_ROOT = path.join(app.getPath("appData"), "JustTimerData");
const STABLE_USER_DATA = path.join(DATA_ROOT, "User Data");
const BACKUP_ROOT = path.join(DATA_ROOT, "Backups");
const SNAPSHOT_ROOT = path.join(DATA_ROOT, "Snapshots");
const LEGACY_USER_DATA = app.getPath("userData");
const log = {
  info: (...args) => {
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'updater.log'), '[INFO] ' + args.join(' ') + '\n'); } catch (e) {}
    console.log(...args);
  },
  warn: (...args) => {
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'updater.log'), '[WARN] ' + args.join(' ') + '\n'); } catch (e) {}
    console.warn(...args);
  },
  error: (...args) => {
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'updater.log'), '[ERROR] ' + args.join(' ') + '\n'); } catch (e) {}
    console.error(...args);
  }
};
autoUpdater.logger = log;

if (process.platform === "win32") {
  app.setAppUserModelId("com.justjuani.justtimer");
}

function canUseDirectory(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const testFile = path.join(dir, ".write-test");
    fs.writeFileSync(testFile, "ok");
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

function directoryHasFiles(dir) {
  try { return fs.existsSync(dir) && fs.readdirSync(dir).length > 0; } catch { return false; }
}

function safeStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function copyUserDataIfNeeded(fromDir, toDir) {
  try {
    if (!fromDir || fromDir === toDir || !fs.existsSync(fromDir)) return;
    const targetHasData = directoryHasFiles(toDir);
    if (targetHasData) return;
    fs.mkdirSync(BACKUP_ROOT, { recursive: true });
    const migrationBackup = path.join(BACKUP_ROOT, `pre-migration-${safeStamp()}`);
    fs.cpSync(fromDir, migrationBackup, { recursive: true, force: false, errorOnExist: true });
    fs.mkdirSync(toDir, { recursive: true });
    fs.cpSync(fromDir, toDir, { recursive: true, force: false, errorOnExist: false });
    if (!directoryHasFiles(toDir)) throw new Error("The migrated data directory is empty");
    fs.writeFileSync(path.join(DATA_ROOT, "migration.json"), JSON.stringify({
      schemaVersion: DATA_SCHEMA_VERSION,
      migratedAt: new Date().toISOString(),
      from: fromDir,
      to: toDir,
      backup: migrationBackup,
    }, null, 2));
  } catch (error) {
    console.warn("User data migration skipped; legacy data remains untouched:", error);
  }
}

function configureUserDataPath() {
  if (!app.isPackaged) {
    app.setPath("userData", path.join(__dirname, ".electron-user-data"));
    return;
  }

  // Program files live under Local/Programs and may be replaced by an update.
  // Persistent data lives under Roaming/JustTimerData and is never an installer
  // target. Migration is copy-only and starts with a complete backup.
  const exeDir = path.dirname(app.getPath("exe"));
  const besideExeData = path.join(exeDir, "JustTimer-data");

  if (!directoryHasFiles(STABLE_USER_DATA)) {
    if (directoryHasFiles(LEGACY_USER_DATA)) copyUserDataIfNeeded(LEGACY_USER_DATA, STABLE_USER_DATA);
    else if (directoryHasFiles(besideExeData)) copyUserDataIfNeeded(besideExeData, STABLE_USER_DATA);
  }
  fs.mkdirSync(STABLE_USER_DATA, { recursive: true });
  app.setPath("userData", STABLE_USER_DATA);
}

function backupBeforeNewVersion() {
  if (!app.isPackaged || !directoryHasFiles(STABLE_USER_DATA)) return;
  try {
    fs.mkdirSync(BACKUP_ROOT, { recursive: true });
    const markerPath = path.join(DATA_ROOT, "last-version.txt");
    const previousVersion = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8").trim() : "";
    const currentVersion = app.getVersion();
    if (previousVersion === currentVersion) return;
    const target = path.join(BACKUP_ROOT, `before-${currentVersion}-${safeStamp()}`);
    fs.mkdirSync(target, { recursive: true });
    for (const name of ["Local Storage", "Preferences"]) {
      const source = path.join(STABLE_USER_DATA, name);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(target, name), { recursive: true, force: false });
    }
    const snapshot = path.join(SNAPSHOT_ROOT, "current.json");
    if (fs.existsSync(snapshot)) fs.copyFileSync(snapshot, path.join(target, "data-snapshot.json"));
    fs.writeFileSync(path.join(target, "backup.json"), JSON.stringify({
      schemaVersion: DATA_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      previousVersion: previousVersion || null,
      nextVersion: currentVersion,
    }, null, 2));
    fs.writeFileSync(markerPath, currentVersion, "utf8");
  } catch (error) {
    console.warn("Pre-update backup failed; existing data remains untouched:", error);
  }
}

configureUserDataPath();
backupBeforeNewVersion();
let mainWindow;
const childWindows = new Map();
let lastSnapshotStorage = "";
let snapshotTimer = null;
let snapshotSource = null;
let googleCalendar;
const notifiedHabitKeys = new Set();
const APP_OPENED_AT = Date.now();

function showDueHabitNotifications(reminders = []) {
  const now = Date.now();
  reminders.forEach(reminder => {
    const at = new Date(reminder.at).getTime();
    const key = reminder.notificationKey || `${reminder.habitId}:${reminder.at}:${reminder.kind || "time"}`;
    if (notifiedHabitKeys.has(key) || at < now - 65000 || at > now) return;
    notifiedHabitKeys.add(key);
    if (Notification.isSupported()) {
      const notification = new Notification({ title: reminder.name || "JustTimer · Hábito pendiente", body: reminder.body });
      notification.on("click", () => openHabitReminderActions(reminder));
      notification.show();
    }
  });
}

async function openHabitReminderActions(reminder) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const result = await dialog.showMessageBox(mainWindow, { type:"question", title:reminder.name || "Hábito pendiente", message:reminder.name || reminder.body, detail:"Podés resolverlo sin abrir el administrador.", buttons:["Hecho", "Recordarme en 15 min", "No lo voy a hacer", "Cancelar"], defaultId:0, cancelId:3 });
  if (result.response === 0) {
    await mainWindow.webContents.executeJavaScript(`(() => { const id=${JSON.stringify(reminder.habitId)}, now=new Date(), day=[now.getFullYear(),String(now.getMonth()+1).padStart(2,"0"),String(now.getDate()).padStart(2,"0")].join("-"); const habits=JSON.parse(localStorage.getItem("justtimer.habits.v1")||"[]"), habit=habits.find(h=>h.id===id), logs=JSON.parse(localStorage.getItem("justtimer.habitLogs.v1")||"{}"), key=id+":"+day, current=logs[key]||{count:0,events:[]}, at=now.toISOString(); logs[key]={...current,count:Math.max(1,Number(habit?.targetCount)||1),justified:false,updatedAt:at,events:[...(current.events||[]),{at,type:"complete",source:"notification"}]}; localStorage.setItem("justtimer.habitLogs.v1",JSON.stringify(logs)); })()`, true);
    scheduleSnapshot(mainWindow); mainWindow.webContents.send("sessions-updated");
  } else if (result.response === 1) {
    const snoozed = { ...reminder, at:new Date(Date.now()+15*60000).toISOString(), kind:`snooze-${Date.now()}`, body:`${reminder.name || "El hábito"} sigue pendiente` };
    setTimeout(() => showDueHabitNotifications([snoozed]), 15*60000);
  } else if (result.response === 2) {
    openChildWindow("habits", "habits.html", { width:860, height:650, minWidth:680, minHeight:520, resizable:true });
  }
}

async function checkHabitNotifications() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try {
    const payload = await mainWindow.webContents.executeJavaScript(`(() => {
      const habits = JSON.parse(localStorage.getItem("justtimer.habits.v1") || "[]");
      const logs = JSON.parse(localStorage.getItem("justtimer.habitLogs.v1") || "{}");
      return { habits, logs };
    })()`, true);
    const now = new Date(), dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const reminders = [];
    (payload.habits || []).filter(habit => !habit.archived && (!habit.days?.length || habit.days.includes(now.getDay()))).forEach(habit => {
      const current = payload.logs?.[`${habit.id}:${dayKey}`] || {};
      if (current.justified || Number(current.count) >= Math.max(1, Number(habit.targetCount) || 1)) return;
      (habit.reminderTimes || []).forEach(time => { const [hour, minute] = time.split(":").map(Number), at = new Date(now); at.setHours(hour, minute, 0, 0); reminders.push({ habitId: habit.id, name:habit.name, at: at.toISOString(), body: `${habit.name} sigue pendiente`, kind: "time" }); });
      if (habit.kind === "phase" && habit.remindBeforePhaseEnd) { const ends = { morning: 12, afternoon: 19, night: 28 }, end = ends[habit.phase]; if (end) { const at = new Date(now); at.setHours(end % 24, 0, 0, 0); if (end >= 24) at.setDate(at.getDate() + 1); at.setMinutes(at.getMinutes() - 15); reminders.push({ habitId: habit.id, name:habit.name, at: at.toISOString(), body: `${habit.name}: faltan 15 minutos para cambiar de etapa`, kind: "phase-end" }); } }
      if (habit.remindOnAppStart && Date.now() - APP_OPENED_AT < 90000) reminders.push({ habitId:habit.id, name:habit.name, at:now.toISOString(), body:`${habit.name} está pendiente al iniciar JustTimer`, kind:"app-start", notificationKey:`${habit.id}:app-start:${APP_OPENED_AT}` });
      if (habit.remindOnPhaseStart) {
        const hour = now.getHours() + now.getMinutes() / 60, currentPhase = hour >= 4 && hour < 12 ? "morning" : hour >= 12 && hour < 19 ? "afternoon" : "night";
        if (habit.kind === "daily" || habit.phase === currentPhase) {
          const startHour = currentPhase === "morning" ? 7 : currentPhase === "afternoon" ? 12 : 19, at = new Date(now); at.setHours(startHour, 0, 0, 0);
          reminders.push({ habitId:habit.id, name:habit.name, at:at.toISOString(), body:`${habit.name}: comenzó ${currentPhase === "morning" ? "la mañana" : currentPhase === "afternoon" ? "la tarde" : "la noche"}`, kind:`phase-start-${currentPhase}` });
        }
      }
    });
    showDueHabitNotifications(reminders);
  } catch (error) { log.warn("Habit notifications skipped:", error.message); }
}

function writeDataSnapshot(storage) {
  if (!storage || typeof storage !== "object" || Array.isArray(storage)) return;
  const justTimerStorage = Object.fromEntries(Object.entries(storage).filter(([key]) => key.startsWith("justtimer.")));
  const document = {
    schemaVersion: DATA_SCHEMA_VERSION,
    appVersion: app.getVersion(),
    savedAt: new Date().toISOString(),
    storage: justTimerStorage,
  };
  const storageJson = JSON.stringify(justTimerStorage);
  if (storageJson === lastSnapshotStorage) return;
  const json = JSON.stringify(document, null, 2);
  fs.mkdirSync(SNAPSHOT_ROOT, { recursive: true });
  const currentPath = path.join(SNAPSHOT_ROOT, "current.json");
  const temporaryPath = `${currentPath}.tmp`;
  fs.writeFileSync(temporaryPath, json, "utf8");
  fs.renameSync(temporaryPath, currentPath);
  lastSnapshotStorage = storageJson;
}

async function captureSnapshotFromWindow(target = mainWindow) {
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
  try {
    const storage = await target.webContents.executeJavaScript(
      `Object.fromEntries(Array.from({length: localStorage.length}, (_, i) => { const key = localStorage.key(i); return [key, localStorage.getItem(key)]; }))`,
      true,
    );
    writeDataSnapshot(storage);
  } catch (error) {
    log.warn("Data snapshot skipped:", error.message);
  }
}

function scheduleSnapshot(target = mainWindow) {
  snapshotSource = target && !target.isDestroyed() ? target : mainWindow;
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    captureSnapshotFromWindow(snapshotSource);
  }, 900);
}

const sharedWindowOptions = {
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  resizable: false,
  maximizable: false,
  fullscreenable: false,
  icon: path.join(__dirname, "logo.ico"),
  webPreferences: {
    contextIsolation: false,
    nodeIntegration: true,
  },
};

function createWindow() {
  mainWindow = new BrowserWindow({
    ...sharedWindowOptions,
    width: 280,
    height: 112,
  });

  mainWindow.loadFile("index.html");
  mainWindow.webContents.on("did-finish-load", () => captureSnapshotFromWindow(mainWindow));
}

function openChildWindow(key, file, options) {
  const current = childWindows.get(key);
  if (current && !current.isDestroyed()) {
    current.focus();
    return;
  }

  const child = new BrowserWindow({
    ...sharedWindowOptions,
    ...options,
    show: false,
    parent: undefined,
    alwaysOnTop: false,
    transparent: false,
    backgroundColor: "#ffffff",
  });

  child.once("ready-to-show", () => {
    child.center();
    child.show();
    child.focus();
  });
  child.on("closed", () => childWindows.delete(key));
  child.on("close", () => captureSnapshotFromWindow(child));
  child.loadFile(path.join(__dirname, file));
  childWindows.set(key, child);
}

app.whenReady().then(() => {
  googleCalendar = new GoogleCalendar(path.join(app.getPath("userData"), "google-calendar.json"));
  createWindow();
  mainWindow.webContents.on("did-finish-load", checkHabitNotifications);
  setInterval(checkHabitNotifications, 30 * 1000).unref();
  setInterval(() => captureSnapshotFromWindow(mainWindow), 5 * 60 * 1000).unref();
  // Initialize auto-updater after window is ready
  try {
    initAutoUpdater();
  } catch (e) {
    console.error('Auto-updater init failed:', e);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.on("resize", (event, height) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const [currentWidth] = mainWindow.getContentSize();
    mainWindow.setContentSize(currentWidth, Math.max(104, Math.round(height)), false);
  }
});

ipcMain.on("close-app", () => {
  app.quit();
});

ipcMain.handle("request-app-close", async (_event, payload = {}) => {
  const pendingHabits = Array.isArray(payload) ? payload : (payload.pendingHabits || []);
  const summary = payload.summary || {};
  const hours = Math.floor((summary.focusSecs || 0) / 3600), minutes = Math.floor(((summary.focusSecs || 0) % 3600) / 60);
  const detail = [
    `🎯 Prioridades: ${summary.prioritiesDone || 0}/${summary.prioritiesTotal || 3}`,
    `⏱ Foco: ${hours ? `${hours}h ` : ""}${minutes}m`,
    `✓ Tareas: ${summary.tasksDone || 0}`,
    summary.averageEnergy ? `⚡ Energía promedio: ${Number(summary.averageEnergy).toFixed(1)}` : null,
    pendingHabits.length ? `\nHábitos pendientes (podés resolverlos mañana):\n${pendingHabits.slice(0, 5).join("\n")}` : null,
  ].filter(Boolean).join("\n");
  const tomorrowReady = Boolean(payload.tomorrowReady);
  const result = await dialog.showMessageBox(mainWindow, {
    type: "info", title: "Día terminado", message: "Día terminado", detail,
    buttons: tomorrowReady ? ["Cerrar JustTimer", "Seguir usando"] : ["Definir prioridades de mañana", "Dejar para mañana", "Seguir usando"],
    defaultId: 0, cancelId: tomorrowReady ? 1 : 2,
  });
  if (!tomorrowReady && result.response === 0) {
    await mainWindow.webContents.executeJavaScript(`localStorage.setItem("justtimer.priorityTargetDate.v1", ${JSON.stringify(payload.tomorrowDate || "")})`, true);
    openChildWindow("priorities", "priorities.html", { width: 820, height: 680, minWidth: 680, minHeight: 560, resizable: true });
    return { closed: false };
  }
  if ((tomorrowReady && result.response === 0) || (!tomorrowReady && result.response === 1)) { app.quit(); return { closed: true }; }
  return { closed: false };
});

ipcMain.handle("google-calendar-status", () => googleCalendar.status());
ipcMain.handle("google-calendar-configure", (_event, credentials) => googleCalendar.configure(credentials));
ipcMain.handle("google-calendar-connect", () => googleCalendar.connect());
ipcMain.handle("google-calendar-disconnect", () => googleCalendar.disconnect());
ipcMain.handle("google-calendar-sync", (_event, range) => googleCalendar.events(range.timeMin, range.timeMax));

ipcMain.on("schedule-habit-notifications", (_event, reminders = []) => {
  showDueHabitNotifications(reminders);
});

ipcMain.on("close-current-window", event => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.on("open-calendar", () => {
  openChildWindow("calendar", "calendar.html", { width: 1040, height: 740, minWidth: 780, minHeight: 580, resizable: true });
});

ipcMain.on("open-tasks", () => {
  openChildWindow("tasks", "tasks.html", { width: 520, height: 620, minWidth: 420, minHeight: 480, resizable: true });
});

ipcMain.on("open-day-tasks", () => {
  openChildWindow("day-tasks", "day.html", { width: 1180, height: 760, minWidth: 720, minHeight: 560, resizable: true });
});

ipcMain.on("data-changed", event => {
  scheduleSnapshot(BrowserWindow.fromWebContents(event.sender) || mainWindow);
});

ipcMain.handle("select-project-image", async event => {
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const result = await dialog.showOpenDialog(owner, {
    title: "Elegir imagen del proyecto",
    properties: ["openFile"],
    filters: [{ name: "Imágenes", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const imagePath = result.filePaths[0];
  const extension = path.extname(imagePath).slice(1).toLowerCase().replace("jpg", "jpeg");
  return `data:image/${extension};base64,${fs.readFileSync(imagePath).toString("base64")}`;
});

ipcMain.on("open-habits", () => {
  openChildWindow("habits", "habits.html", { width: 860, height: 650, minWidth: 680, minHeight: 520, resizable: true });
});

ipcMain.on("open-priorities", () => {
  openChildWindow("priorities", "priorities.html", { width: 820, height: 680, minWidth: 680, minHeight: 560, resizable: true });
});

ipcMain.on("open-mini-projects", () => {
  openChildWindow("mini-projects", "mini-projects.html", { width: 760, height: 650, minWidth: 620, minHeight: 520, resizable: true });
});

ipcMain.on("open-stats", () => {
  openChildWindow("stats", "stats.html", { width: 980, height: 720, resizable: true });
});

ipcMain.on("session-created", () => {
  scheduleSnapshot(mainWindow);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("sessions-updated");
  }
  for (const window of childWindows.values()) {
    if (!window.isDestroyed()) window.webContents.send("sessions-updated");
  }
});

ipcMain.handle("export-analytics", async (event, payload) => {
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const result = await dialog.showSaveDialog(owner, {
    title: "Exportar analitica de sesiones",
    defaultPath: `justtimer-analitica-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return { saved: false };
  fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), "utf8");
  return { saved: true, path: result.filePath };
});

function initAutoUpdater() {
  if (!autoUpdater) return;

  autoUpdater.on('checking-for-update', () => {
    mainWindow?.webContents.send('update-checking');
  });

  autoUpdater.on('update-available', (info) => {
    log.info('Update available, starting download...');
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Actualización disponible',
      message: 'Hay una nueva versión. Se descargará en segundo plano.'
    });
    mainWindow?.webContents.send('update-available', info);
    autoUpdater.downloadUpdate().catch(err => log.error('downloadUpdate failed:', err));
  });

  autoUpdater.on('update-not-available', () => {
    mainWindow?.webContents.send('update-not-available');
  });

  autoUpdater.on('error', (err) => {
    mainWindow?.webContents.send('update-error', (err && err.stack) || err);
  });

  autoUpdater.on('download-progress', (progressObj) => {
    mainWindow?.webContents.send('update-progress', progressObj);
  });

  autoUpdater.on('update-downloaded', (info) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Instalar y reiniciar', 'Más tarde'],
      defaultId: 0,
      cancelId: 1,
      title: 'Actualizar',
      message: 'La actualización se descargó. ¿Deseas instalarla ahora?'
    });
    if (choice === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  // Only check for updates when not in development
  if (process.env.NODE_ENV !== 'development') {
    autoUpdater.checkForUpdatesAndNotify();
  }
}
