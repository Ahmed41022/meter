const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { hasRunningSession, STORE_KEY } = require("./running.js");
const { start, PORT, ORIGIN } = require("./server.js");
const { migrationPlan, readScript, writeScript } = require("./migrate.js");
const { isSignIn } = require("./popup.js");

/** A desktop app that exits without a window and without a word is impossible to
 *  report, so anything fatal during startup is written down before it goes. */
const logCrash = (where, err) => {
  try {
    fs.writeFileSync(
      path.join(app.getPath("userData"), "crash.log"),
      `${new Date().toISOString()} ${where}
${err?.stack ?? err}
`,
    );
  } catch { /* nothing left to try */ }
};

process.on("uncaughtException", (err) => logCrash("uncaughtException", err));
process.on("unhandledRejection", (err) => logCrash("unhandledRejection", err));


// Single instance: a second launch focuses the existing window rather than
// starting a rival process that would fight over the same storage.
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let quitting = false;
let served = null;

/** True until the real window exists. The ledger is carried across by opening
 *  hidden windows and closing them again, and destroying the last of those
 *  would otherwise fire `window-all-closed` and quit the app during startup —
 *  before it had ever shown anything. */
let starting = true;

const boundsFile = () => path.join(app.getPath("userData"), "window.json");

/** Written once the ledger has been carried to the served origin. Its presence,
 *  not the state of either store, is what stops the move happening twice — see
 *  the note in migrate.js about silently reverting months of work. */
const movedFile = () => path.join(app.getPath("userData"), "moved-to-localhost.json");

const alreadyMoved = () => {
  try {
    return fs.existsSync(movedFile());
  } catch {
    // Unreadable means unknown, and unknown must mean "don't touch anything".
    return true;
  }
};

const rememberMoved = (note) => {
  try {
    fs.writeFileSync(movedFile(), JSON.stringify({ at: new Date().toISOString(), ...note }));
  } catch {
    /* the move worked; failing to write the note is not worth undoing it for */
  }
};

/** A hidden page on one origin, open just long enough to run one script against
 *  its localStorage. */
async function onOrigin(load, script) {
  const probe = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  try {
    await load(probe);
    return await probe.webContents.executeJavaScript(script, true);
  } finally {
    if (!probe.isDestroyed()) probe.destroy();
  }
}

/**
 * Move the ledger from the old `file://` origin to the served one, once.
 *
 * Every failure path here ends in "leave both stores alone". The old store is
 * never written to and never cleared, so the worst outcome is an app that opens
 * empty with the real data still on disk and a backup still able to restore it.
 */
async function carryLedgerOver(origin) {
  if (alreadyMoved()) return null;
  try {
    const target = await onOrigin((w) => w.loadURL(`${origin}/bridge`), readScript());
    const source = await onOrigin(
      (w) => w.loadFile(path.join(__dirname, "bridge.html")),
      readScript(),
    );
    const entries = migrationPlan(target, source);
    if (!entries.length) {
      // Nothing to do is a settled answer, not a failed one: either the new
      // store is already the live one or there was never an old one.
      rememberMoved({ carried: 0 });
      return null;
    }
    const wrote = await onOrigin((w) => w.loadURL(`${origin}/bridge`), writeScript(entries));
    if (wrote === entries.length) rememberMoved({ carried: wrote });
    return { carried: wrote };
  } catch {
    // Retried on the next launch. Nothing has been changed.
    return null;
  }
}

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

  // Served, not loaded from disk, so the page has an origin Google will accept
  // and the Sync panel works here as it does in a browser.
  win.loadURL(`${served.origin}/`);
  win.once("ready-to-show", () => win.show());

  win.on("resize", saveBounds);
  win.on("move", saveBounds);

  // Links open in the real browser, not inside the app shell — except signing
  // in, which must stay a child window so it can hand the token back to the
  // page that asked for it.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSignIn(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520, height: 680, autoHideMenuBar: true, minimizable: false,
        },
      };
    }
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

app.whenReady().then(async () => {
  try {
    served = await start({
      "/": path.join(__dirname, "meter.html"),
      "/bridge": path.join(__dirname, "bridge.html"),
    });
  } catch (e) {
    logCrash("starting the local server", e);
    // Refusing to start is the safe answer. Falling back to `file://` would
    // open the old store alongside a newer one at the served origin, and two
    // ledgers drifting apart is much harder to recover from than one launch
    // that did not happen.
    dialog.showErrorBox(
      "Meter could not start",
      e?.code === "EADDRINUSE"
        ? `Another program is using port ${PORT}, which Meter needs in order to ` +
          `run. Close it and open Meter again.`
        : `Meter could not open its local address (${ORIGIN}).

${e?.message ?? e}`,
    );
    return app.quit();
  }
  try {
    await carryLedgerOver(served.origin);
  } finally {
    createWindow();
    starting = false;
  }
});

app.on("window-all-closed", () => { if (!starting) app.quit(); });
app.on("will-quit", () => { served?.close?.(); });
