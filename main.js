const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

app.setPath("userData", path.join(__dirname, ".electron-user-data"));
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

app.whenReady().then(createWindow);

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

ipcMain.on("session-created", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("sessions-updated");
  }
});
