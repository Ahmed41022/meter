/**
 * Where the desktop app's page comes from, and what it may do to the window.
 *
 * The window shows the hosted app rather than a copy bundled at build time, so
 * a deploy reaches it the way it reaches a phone, and every device that syncs
 * runs the same build. The hosted app keeps itself for offline use (its
 * service worker), so after the first visit this works without a connection.
 */
const APP_URL = "https://ahmed41022.github.io/meter/";
const APP_ORIGIN = new URL(APP_URL).origin;

/** A page the window itself may show: the hosted app, or the bundled copy at
 *  the local origin it falls back to. Anything else opens in the browser. */
function isAppPage(url, localOrigin = null) {
  try {
    const u = new URL(url);
    if (u.origin === APP_ORIGIN) return u.pathname.startsWith(new URL(APP_URL).pathname);
    return localOrigin !== null && u.origin === localOrigin;
  } catch {
    return false;
  }
}

const HEX = /^#[0-9a-f]{6}$/i;

/** The title bar's colours as the page asked for them, or null. The page is
 *  remote, so what it sends is checked before it reaches the window. */
function titleBarColors(input) {
  if (!input || typeof input !== "object") return null;
  const { color, symbol } = input;
  return HEX.test(color ?? "") && HEX.test(symbol ?? "") ? { color, symbolColor: symbol } : null;
}

/** Shown when the hosted app cannot be reached and has never been kept for
 *  offline use: the one case with nothing to show. */
const offlinePage = (dark) => {
  const bg = dark ? "#0E1210" : "#F1F3EF";
  const ink = dark ? "#E7EDE9" : "#101613";
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>Meter</title>
<style>html,body{margin:0;height:100%;background:${bg};color:${ink};font:15px system-ui,'Segoe UI',sans-serif}
main{max-width:420px;margin:0 auto;padding:30vh 24px 0}a{color:#18A87A;font-weight:600}</style></head>
<body><main><h2>Meter needs the internet once</h2><p>It loads the latest version the first time, then keeps it for working offline. Nothing in your ledger has changed.</p>
<p><a href="${APP_URL}">Try again</a></p></main></body></html>`)}`;
};

module.exports = { APP_URL, APP_ORIGIN, isAppPage, titleBarColors, offlinePage };
