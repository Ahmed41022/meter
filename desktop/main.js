const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { hasRunningSession, STORE_KEY } = require("./running.js");

// Single instance: a second launch focuses the existing window rather than
// starting a rival process that would fight over the same storage.
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let quitting = false;

const boundsFile = () => path.join(app.getPath("userData"), "window.json");

const readBounds = () => {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), "utf8"));
    return Number.isFinite(b.width) && Number.isFinite(b.height) ? b : null;
  } catch {
    return null;
  }
};

const saveBounds = () => {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try {
    fs.writeFileSync(boundsFile(), JSON.stringify(win.getNormalBounds()));
  } catch {
    /* a window that won't remember its size is not worth crashing over */
  }
};

/** Asks the renderer what's in storage. Any failure resolves to false — a
 *  broken guard must never trap the user inside the app. */
async function meterIsRunning() {
  if (!win || win.isDestroyed()) return false;
  try {
    const raw = await win.webContents.executeJavaScript(
      `window.localStorage.getItem(${JSON.stringify(STORE_KEY)})`, true
    );
    return hasRunningSession(raw);
  } catch {
    return false;
  }
}

function createWindow() {
  const saved = readBounds();
  win = new BrowserWindow({
    ...(saved ?? { width: 780, height: 920 }),
    minWidth: 380,
    minHeight: 560,
    backgroundColor: "#F1F3EF",
    title: "Meter",
    icon: path.join(__dirname, "meter.ico"),
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.loadFile(path.join(__dirname, "meter.html"));
  win.once("ready-to-show", () => win.show());

  win.on("resize", saveBounds);
  win.on("move", saveBounds);

  // Links open in the real browser, not inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Closing with the meter running is how a session ends up billing overnight.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    meterIsRunning().then((running) => {
      if (!running) {
        quitting = true;
        return win.close();
      }
      const choice = dialog.showMessageBoxSync(win, {
        type: "warning",
        buttons: ["Keep it open", "Close anyway"],
        defaultId: 0,
        cancelId: 0,
        title: "A meter is still running",
        message: "A meter is still running.",
        detail:
          "Closing now leaves the session open. It keeps its start time, so when you reopen " +
          "Meter you'll be offered the chance to stop it at its last heartbeat rather than " +
          "billing the whole gap.",
      });
      if (choice === 1) {
        quitting = true;
        win.close();
      }
    });
  });
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
