const { app, BrowserWindow, shell } = require("electron");
const path = require("path");

// Single instance: a second launch focuses the existing window rather than
// starting a rival process that would fight over the same storage.
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 900,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: "#F1F3EF",
    title: "Meter",
    icon: path.join(__dirname, "meter.ico"),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, "meter.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});
app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
