/**
 * What the generated service worker does with each kind of request. The source
 * is built by scripts/sw.mjs exactly as scripts/build.mjs ships it and run in a
 * `vm` sandbox with a fake `self`, `caches` and `fetch`, so these are
 * statements about the shipped code and not about a copy of its rules.
 *
 * The thing under test is the line between the app's own files and the relay:
 * a relay response is the user's private data and must never be cached, replayed
 * offline or even answered by the worker.
 */
import { describe, it, expect, vi } from "vitest";
import vm from "node:vm";
import { RELAY_HOST_SUFFIXES, buildServiceWorker } from "../scripts/sw.mjs";

const PAGE = "https://ahmed41022.github.io/meter/";

/** Runs the worker and returns a way to fire events at it. */
function boot({ network } = {}) {
  const listeners = {};
  const stored = new Map();
  const cache = {
    put: vi.fn(async (req, res) => { stored.set(req.url, res); }),
    addAll: vi.fn(async () => {}),
  };
  const caches = {
    open: vi.fn(async () => cache),
    match: vi.fn(async (req) => stored.get(typeof req === "string" ? new URL(req, PAGE).href : req.url)),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  };
  const fetchFn = vi.fn(network ?? (async () => new Response("fresh", { status: 200 })));
  const self = {
    location: new URL(`${PAGE}sw.js`), clients: { claim: vi.fn() }, skipWaiting: vi.fn(),
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  vm.runInNewContext(buildServiceWorker({ version: "abc123", precache: ["./", "icon.svg"] }), {
    self, caches, fetch: fetchFn, URL, Response, Promise, Headers,
  });
  /** Fires a fetch event; resolves to what the worker answered, or "ignored". */
  const request = async (url, { method = "GET", headers = {} } = {}) => {
    const req = new Request(url, { method, headers });
    let answered;
    listeners.fetch({ request: req, respondWith: (p) => { answered = p; } });
    if (!answered) return { handled: false };
    const res = await answered;
    // The worker's cache write is not awaited by it; let it settle.
    await new Promise((r) => setTimeout(r, 0));
    return { handled: true, res, cached: stored.has(req.url) };
  };
  return { request, fetchFn, cache, stored, caches, listeners };
}

describe("the app's own files", () => {
  it("are fetched from the network first and cached for offline", async () => {
    const sw = boot();
    const out = await sw.request(`${PAGE}index.html`);
    expect(out).toMatchObject({ handled: true, cached: true });
    expect(await out.res.text()).toBe("fresh");
    expect(sw.fetchFn).toHaveBeenCalledOnce();
  });

  it("fall back to the cache when the network is down", async () => {
    let up = true;
    const sw = boot({ network: async () => { if (!up) throw new TypeError("offline"); return new Response("v1"); } });
    await sw.request(`${PAGE}index.html`);
    up = false;
    const out = await sw.request(`${PAGE}index.html`);
    expect(await out.res.text()).toBe("v1");
  });

  it("do not touch anything but GET", async () => {
    const sw = boot();
    expect(await sw.request(`${PAGE}x`, { method: "POST" })).toEqual({ handled: false });
    expect(sw.fetchFn).not.toHaveBeenCalled();
  });
});

describe("exchange rates, which are cross-origin on purpose", () => {
  it("are still served and cached, so an offline phone keeps a rate", async () => {
    const sw = boot();
    for (const url of [
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
      "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json",
    ]) {
      const out = await sw.request(url);
      expect(out, url).toMatchObject({ handled: true, cached: true });
    }
  });
});

describe("the relay", () => {
  const RELAY = "https://meter-sync.someone.workers.dev";
  const TOKEN = `Bearer ${"t".repeat(43)}`;

  it("is never answered, fetched or cached by the worker when a request carries Authorization", async () => {
    const sw = boot();
    for (const url of [`${RELAY}/v1/v/ID/log?since=0`, `${RELAY}/v1/v/ID/snapshot`, `${RELAY}/v1/v/ID/devices`, `${PAGE}anything`, "https://relay.mydomain.example/v1/v/ID/keybox"]) {
      expect(await sw.request(url, { headers: { authorization: TOKEN } }), url).toEqual({ handled: false });
    }
    expect(sw.fetchFn).not.toHaveBeenCalled();
    expect(sw.cache.put).not.toHaveBeenCalled();
  });

  it("is left alone on a known relay host even without Authorization (GET /v1/info)", async () => {
    const sw = boot();
    expect(RELAY_HOST_SUFFIXES).toContain(".workers.dev");
    expect(await sw.request(`${RELAY}/v1/info`)).toEqual({ handled: false });
    expect(sw.cache.put).not.toHaveBeenCalled();
  });

  it("is not cached when the answer says no-store, whatever the host", async () => {
    const sw = boot({ network: async () => new Response('{"v":1}', { headers: { "cache-control": "no-store" } }) });
    const out = await sw.request("https://relay.mydomain.example/v1/info");
    expect(out).toMatchObject({ handled: true, cached: false });
    expect(await out.res.text()).toBe('{"v":1}');
    expect(sw.cache.put).not.toHaveBeenCalled();
  });

  it("is not touched when it is a WebSocket upgrade or a ws(s) address", async () => {
    const sw = boot();
    expect(await sw.request(`${RELAY}/v1/v/ID/ws`, { headers: { upgrade: "websocket" } })).toEqual({ handled: false });
    // The Request constructor refuses ws: URLs, so the worker's own parsing is
    // exercised with a plain request-shaped object.
    let answered = false;
    sw.listeners.fetch({
      request: { method: "GET", url: "wss://relay.example.workers.dev/v1/v/ID/ws", headers: new Headers() },
      respondWith: () => { answered = true; },
    });
    expect(answered).toBe(false);
  });

  it("holds the same line for every method: a write is never answered either", async () => {
    const sw = boot();
    expect(await sw.request(`${RELAY}/v1/v/ID/log`, { method: "POST", headers: { authorization: TOKEN } })).toEqual({ handled: false });
  });
});

describe("what a rule change would break", () => {
  it("installs, activates and takes over as before", async () => {
    const sw = boot();
    const waits = [];
    sw.listeners.install({ waitUntil: (p) => waits.push(p) });
    sw.listeners.activate({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    expect(sw.cache.addAll).toHaveBeenCalledWith(["./", "icon.svg"]);
  });
});
