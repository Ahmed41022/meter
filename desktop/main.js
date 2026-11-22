const { app, BrowserWindow, dialog, shell, ipcMain, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");
const { hasRunningSession, STORE_KEY } = require("./running.js");
const { start, PORT, ORIGIN } = require("./server.js");
const {
  migrationPlan, readScript, writeScript, webMigrationPlan, readPrefixScript,
} = require("./migrate.js");
const { APP_URL, isAppPage, titleBarColors, offlinePage } = require("./web.js");
const { isSignIn } = require("./popup.js");
const { guardUnsavedSettings } = require("./unsaved.js");

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
//
// Quitting is not enough on its own to make the second copy do nothing.
// `app.quit()` only asks: Electron still becomes ready, and whatever is waiting
// for that still runs. So the second copy went on to start its own server,
// found the port held by the first, and showed an error blaming "another
// program" — which was Meter. Everything that starts something is therefore
// registered at the bottom of this file only in the copy that holds the lock,
// as in Electron's own single-instance example.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

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

/** Written once the ledger has been carried to the hosted app. As with the move
 *  above, the flag and not the stores is what stops it happening twice. */
const webFile = () => path.join(app.getPath("userData"), "moved-to-web.json");

const movedToWeb = () => {
  try {
    return fs.existsSync(webFile());
  } catch {
    return false;
  }
};

/**
 * Carry everything the app keeps to the hosted app's origin, once (see
 * migrate.js). Returns whether the window should open the hosted app.
 *
 * Until it has worked, the window opens the bundled copy as before: offline on
 * the first launch after this update, say. Nothing is lost by waiting, and the
 * next launch tries again. Once it has worked, the hosted app is the one.
 */
async function carryToWeb(localOrigin) {
  if (movedToWeb()) return true;
  // Any same-origin URL gives a page whose storage is the app's; the manifest
  // is small and does not start the app. loadURL rejects when the network
  // could not fetch it, and then nothing is read or written.
  const onApp = (w) => w.loadURL(`${APP_URL}manifest.webmanifest`);
  try {
    const source = await onOrigin((w) => w.loadURL(`${localOrigin}/bridge`), readPrefixScript());
    const target = await onOrigin(onApp, readPrefixScript());
    const entries = webMigrationPlan(target, source);
    if (entries.length) {
      const wrote = await onOrigin(onApp, writeScript(entries));
      if (wrote !== entries.length) return false;
    }
    try {
      fs.writeFileSync(webFile(), JSON.stringify({ at: new Date().toISOString(), carried: entries.length }));
    } catch {
      return false; // without the flag a later launch could carry stale data over
    }
    return true;
  } catch {
    return false;
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

/** The window's own colours before the page says which theme it shows. */
const shellColors = () => (nativeTheme.shouldUseDarkColors
  ? { color: "#0E1210", symbolColor: "#E7EDE9" }
  : { color: "#F1F3EF", symbolColor: "#101613" });

function createWindow(useWeb) {
  const saved = readBounds();
  const first = shellColors();
  win = new BrowserWindow({
    ...(saved ?? { width: 780, height: 920 }),
    minWidth: 380,
    minHeight: 560,
    backgroundColor: first.color,
    title: "Meter",
    icon: path.join(__dirname, "meter.ico"),
    autoHideMenuBar: true,
    show: false,
    // No title bar of the system's: the page runs to the top in its own
    // colour, the three buttons sit over it, and the page keeps that strip
    // clear and draggable (src/ui/styles.js, .titlebar). The buttons take the
    // page's theme when it says (preload.js), so the edge no longer shows the
    // system's colour against the app's.
    titleBarStyle: "hidden",
    titleBarOverlay: { ...first, height: 34 },
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // The hosted app, so every deploy reaches this window as it reaches a phone.
  // The bundled copy, served locally so it has an origin Google will accept,
  // only until the ledger has been carried across (carryToWeb).
  win.loadURL(useWeb ? APP_URL : `${served.origin}/`);
  win.once("ready-to-show", () => win.show());

  // Never been kept for offline use and no connection: say so, with a way to
  // try again, rather than a blank window.
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && String(url).startsWith(APP_URL)) {
      win.loadURL(offlinePage(nativeTheme.shouldUseDarkColors));
    }
  });

  // The window shows the app and nothing else; any other page opens in the
  // browser.
  win.webContents.on("will-navigate", (event, url) => {
    if (isAppPage(url, served.origin) || String(url).startsWith("data:")) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  // F11 is real full screen, title bar and buttons gone; Escape or F11 again
  // comes back.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11" || (input.key === "Escape" && win.isFullScreen())) {
      event.preventDefault();
      win.setFullScreen(input.key === "F11" ? !win.isFullScreen() : false);
    }
  });

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

  // Settings typed and not saved make the page object to closing; ask, as a
  // browser would. Keeping them open undoes the go-ahead the close guard below
  // gave, so the next close asks about a running meter again.
  guardUnsavedSettings(win, dialog, () => { quitting = false; });

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

// Only in the copy holding the lock: see the note on `primary` above.
if (primary) {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  // The page's theme, for the title bar's buttons. Only from the main window,
  // and only colours: see web.js.
  ipcMain.on("meter:title-bar", (event, input) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    const colors = titleBarColors(input);
    if (!colors) return;
    try {
      win.setTitleBarOverlay(colors);
      win.setBackgroundColor(colors.color);
    } catch { /* an older Electron without the overlay: nothing to colour */ }
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
    let useWeb = false;
    try {
      await carryLedgerOver(served.origin);
      useWeb = await carryToWeb(served.origin);
    } finally {
      createWindow(useWeb);
      starting = false;
    }
  });

  app.on("window-all-closed", () => { if (!starting) app.quit(); });
  app.on("will-quit", () => { served?.close?.(); });
}
