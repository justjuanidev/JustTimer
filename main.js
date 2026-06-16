const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");

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

function copyUserDataIfNeeded(fromDir, toDir) {
  try {
    if (!fromDir || fromDir === toDir || !fs.existsSync(fromDir)) return;
    const targetHasData = fs.existsSync(toDir) && fs.readdirSync(toDir).length > 0;
    if (targetHasData) return;
    fs.mkdirSync(toDir, { recursive: true });
    fs.cpSync(fromDir, toDir, { recursive: true, force: false, errorOnExist: false });
  } catch (error) {
    console.warn("User data migration skipped:", error);
  }
}

function configureUserDataPath() {
  if (!app.isPackaged) {
    app.setPath("userData", path.join(__dirname, ".electron-user-data"));
    return;
  }

  const defaultUserData = app.getPath("userData");
  const exeDir = path.dirname(app.getPath("exe"));
  const localUserData = path.join(exeDir, "JustTimer-data");

  if (canUseDirectory(localUserData)) {
    copyUserDataIfNeeded(defaultUserData, localUserData);
    app.setPath("userData", localUserData);
  }
}

configureUserDataPath();
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("in-process-gpu");

let mainWindow;
const childWindows = new Map();

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
  child.loadFile(path.join(__dirname, file));
  childWindows.set(key, child);
}

app.whenReady().then(() => {
  createWindow();
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

ipcMain.on("open-habits", () => {
  openChildWindow("habits", "habits.html", { width: 760, height: 560, resizable: true });
});

ipcMain.on("session-created", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("sessions-updated");
  }
});

function initAutoUpdater() {
  if (!autoUpdater) return;

  autoUpdater.on('checking-for-update', () => {
    mainWindow?.webContents.send('update-checking');
  });

  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Actualización disponible',
      message: 'Hay una nueva versión. Se descargará en segundo plano.'
    });
    mainWindow?.webContents.send('update-available', info);
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
