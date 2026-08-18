const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");
const DATA_SCHEMA_VERSION = 1;
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
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("in-process-gpu");

let mainWindow;
const childWindows = new Map();
let lastSnapshotStorage = "";

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
    parent: mainWindow,
  });

  child.on("closed", () => childWindows.delete(key));
  child.on("close", () => captureSnapshotFromWindow(child));
  child.loadFile(path.join(__dirname, file));
  childWindows.set(key, child);
}

app.whenReady().then(() => {
  createWindow();
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

ipcMain.on("close-current-window", event => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.on("open-calendar", () => {
  openChildWindow("calendar", "calendar.html", { width: 920, height: 700, resizable: true });
});

ipcMain.on("open-tasks", () => {
  openChildWindow("tasks", "tasks.html", { width: 380, height: 520, resizable: true });
});

ipcMain.on("open-day-tasks", () => {
  openChildWindow("day-tasks", "day.html", { width: 1020, height: 720, resizable: true });
});

ipcMain.handle("get-startup-setting", () => app.getLoginItemSettings().openAtLogin);

ipcMain.handle("set-startup-setting", (_event, enabled) => {
  if (process.platform !== "win32") return { enabled: false, supported: false };
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    path: app.getPath("exe"),
    args: [],
  });
  return { enabled: app.getLoginItemSettings().openAtLogin, supported: true };
});

ipcMain.on("data-changed", event => {
  captureSnapshotFromWindow(BrowserWindow.fromWebContents(event.sender) || mainWindow);
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
  openChildWindow("habits", "habits.html", { width: 760, height: 560, resizable: true });
});

ipcMain.on("open-stats", () => {
  openChildWindow("stats", "stats.html", { width: 980, height: 720, resizable: true });
});

ipcMain.on("session-created", () => {
  captureSnapshotFromWindow(mainWindow);
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
