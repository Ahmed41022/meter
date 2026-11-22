/**
 * The service worker's source for the web build, as a function of the build.
 * It lives here, not inline in build.mjs, so a test can run exactly what ships.
 *
 * Network first, cache only as a fallback.
 *
 * The whole app is one document, so a cache-first worker would pin whichever
 * version a phone happened to install and keep serving it after every deploy,
 * the failure that makes people uninstall a web app. This way an online phone
 * always runs the current build, and an offline one runs the last it saw.
 *
 * What it must never touch: the relay. A relay response is private (it is the
 * user's encrypted ledger, a pairing answer, a token check) and must not be
 * kept on the phone's disk, replayed offline, or looked at by a worker whose
 * job is to serve the shell. So a request is left alone, untouched and
 * uncached, when
 *
 *   - it carries an Authorization header: every relay call that means anything
 *     does (device token, join token), wherever the relay is hosted, including
 *     a relay the user chose themselves whose address no build can know;
 *   - it goes to a relay host this build knows (RELAY_HOST_SUFFIXES);
 *   - it is a WebSocket upgrade (a browser does not route those through a
 *     worker; the check costs nothing and holds if that ever changes).
 *
 * Why not "skip every cross-origin request": the exchange-rate fetch is
 * cross-origin on purpose and is allowed to be cached, so an offline phone still
 * has a rate to show. Authorization plus the known relay host is the narrowest
 * rule that covers the relay. And for the one relay call that has no
 * Authorization header (GET /v1/info) on a host this build cannot know, the
 * relay answers `cache-control: no-store`, and the worker honours that on
 * every response, so nothing marked private is ever written to the cache.
 */

/** Hosts that are a relay by their name. A relay on a custom domain is covered
 *  by the Authorization rule and by `no-store`, not by this list. */
export const RELAY_HOST_SUFFIXES = [".workers.dev"];

export function buildServiceWorker({ version, precache }) {
  return `const CACHE = "meter-${version}";
const RELAY_HOST_SUFFIXES = ${JSON.stringify(RELAY_HOST_SUFFIXES)};
const isRelay = (request) => {
  if (request.headers.has("authorization")) return true;
  if ((request.headers.get("upgrade") || "").toLowerCase() === "websocket") return true;
  const url = new URL(request.url);
  if (url.protocol === "ws:" || url.protocol === "wss:") return true;
  return RELAY_HOST_SUFFIXES.some((s) => url.hostname.endsWith(s));
};
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(${JSON.stringify(precache)})).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  if (isRelay(e.request)) return;
  e.respondWith(fetch(e.request)
    .then((res) => {
      if (!/no-store/i.test(res.headers.get("cache-control") || "")) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    })
    .catch(() => caches.match(e.request).then((hit) => hit ?? caches.match("./"))));
});
`;
}
