/**
 * Serving the app to itself, over the loopback interface.
 *
 * A page loaded from disk has no origin Google will authorise — it reports
 * itself as `file://`, and the sign-in request comes back `invalid_request`
 * however the app is configured. Serving the very same file over
 * `http://127.0.0.1` gives it a real origin, and loopback is the one insecure
 * origin Google makes an explicit exception for. Nothing else changes: the
 * bytes served are the bytes on disk.
 *
 * The port is FIXED, not chosen at random. The origin includes the port, and
 * the origin is the thing Google authorises, so a port that moved between runs
 * would be a different app every time — and, worse, a different localStorage
 * every time, because browsers key storage by origin too.
 *
 * This is not a web server in the usual sense. It binds the loopback address
 * only, so nothing off this machine can reach it, and it answers from a fixed
 * map of routes read once at startup rather than resolving a path under a
 * directory — there is no path here to traverse.
 */
// Unprefixed, deliberately: Electron patches `fs` so that reads resolve inside
// the packaged asar archive, and the `node:` form does not always get the same
// treatment. Every path handed to this module lives inside that archive.
const http = require("http");
const fs = require("fs");

/** Below Windows' ephemeral range (49152+), so the OS will never hand it to
 *  something else on a whim, and not a port any common tool claims. */
const PORT = 47823;
const HOST = "127.0.0.1";
const ORIGIN = `http://${HOST}:${PORT}`;

/** Lets a launch that finds the port occupied tell our own server from a
 *  stranger's, rather than guessing from the response body. */
const MARKER = "x-meter-app";

function createServer(routes) {
  const bodies = new Map(
    Object.entries(routes).map(([route, file]) => [route, fs.readFileSync(file)]),
  );
  return http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      return res.end();
    }
    const body = bodies.get((req.url || "/").split("?")[0]);
    if (!body) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
      [MARKER]: "1",
      // Never cache. An update replaces the file wholesale, and a stale copy
      // would be yesterday's app reading today's ledger.
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  });
}

/**
 * Binds the fixed port, or rejects saying why.
 *
 * An `EADDRINUSE` here is reported rather than worked around. Quietly moving to
 * a free port would open a second, empty localStorage and leave the real ledger
 * stranded on the old origin — a silent fork of the user's data is far worse
 * than a window that says what is wrong.
 */
function start(routes, { port = PORT, host = HOST } = {}) {
  const server = createServer(routes);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const actual = server.address().port;
      resolve({
        server,
        port: actual,
        origin: `http://${host}:${actual}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { createServer, start, PORT, HOST, ORIGIN, MARKER };
