/**
 * For the app tests that exercise Meter Sync: the BUILT app in jsdom, talking to
 * the REAL Worker, its cores and SQL, all in-process. Nothing touches a network:
 * the page's `fetch` is a function that hands the request to the Worker object
 * and throws for any host that is not a relay.
 *
 * What jsdom lacks and this puts in the page, taken from Node: WebCrypto,
 * TextEncoder/TextDecoder, the gzip streams, and Node's own Uint8Array so the
 * bytes WebCrypto returns satisfy the app's `instanceof Uint8Array` checks (they
 * come from another realm otherwise). WebSocket is replaced: by default one that fails the
 * way a relay answering 426 does, so the app's "no live socket" path is the one
 * under test, and with `live` one joined to the real Worker (see liveSocket).
 */
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { JSDOM, DIST, appReady, btn, settle, until } from "./app.integration.helpers.js";
import { admin, world } from "./relayWorld.js";

/** A relay whose clock is the real one: pairing codes and invites carry an
 *  expiry that the page checks against its own `Date.now()`, so the two must
 *  agree. `w.skew` moves ONLY the relay's clock forward (to expire an invite). */
export function newRelay(secrets) {
  const w = world(secrets);
  w.skew = 0;
  Object.defineProperty(w.clock, "t", { get: () => Date.now() + w.skew, set() {}, configurable: true });
  return w;
}

export const makeInvite = async (w, label = "test") => (await admin(w, "/invite", { method: "POST", body: { label } })).body.code;

const RELAY_HOST = /(^|\.)workers\.dev$|^127\.0\.0\.1$/;

/**
 * A WebSocket joined to the REAL Worker and vault object: the upgrade goes
 * through the Worker, and what the object sends to its end of the pair is
 * delivered to the page. Only the runtime's socket machinery is a stand-in.
 */
function liveSocket(w) {
  return class LiveSocket {
    constructor(url, protocols) {
      this.readyState = 0;
      const httpUrl = String(url).replace(/^ws/, "http");
      this.vaultName = `v:${/\/v\/([^/]+)\/ws$/.exec(httpUrl)[1]}`;
      const fail = () => { this.readyState = 3; this.onclose?.({ code: 1006 }); };
      w.fetch(httpUrl, { headers: { upgrade: "websocket", "sec-websocket-protocol": protocols.join(", ") } }).then((res) => {
        const client = res.webSocket;
        if (res.status !== 101 || !client) return fail();
        const server = client.peer;
        this.server = server;
        server.send = (text) => {
          server.sent.push(text);
          setTimeout(() => { if (this.readyState === 1) this.onmessage?.({ data: text }); }, 0);
        };
        server.close = (code, reason) => {
          server.closed = { code, reason };
          this.readyState = 3;
          setTimeout(() => this.onclose?.({ code }), 0);
        };
        this.readyState = 1;
        this.onopen?.();
        return undefined;
      }, fail);
    }
    send(text) {
      if (this.readyState !== 1) return;
      if (text === "ping") { setTimeout(() => this.onmessage?.({ data: "pong" }), 0); return; }
      w.env.VAULT.socketMessage(this.vaultName, this.server, text);
    }
    close() {
      if (this.server && !this.server.closed) this.server.closed = { code: 1000 };
      this.readyState = 3;
    }
  };
}

/** Everything the page asked of the relay, for tests that say what must NOT be
 *  asked as well as what is. */
function install(window, w, seen, live) {
  const put = (name, value) => Object.defineProperty(window, name, { value, configurable: true, writable: true });
  put("crypto", webcrypto);
  put("TextEncoder", TextEncoder);
  put("TextDecoder", TextDecoder);
  put("CompressionStream", CompressionStream);
  put("DecompressionStream", DecompressionStream);
  put("Uint8Array", Uint8Array);
  // Every interval the app starts, so a test can fire one (the slow poll) without
  // waiting the two minutes it really takes.
  const intervals = [];
  const realSetInterval = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...args) => {
    const id = realSetInterval(fn, ms, ...args);
    intervals.push({ fn, ms, id });
    return id;
  };
  const realClearInterval = window.clearInterval.bind(window);
  window.clearInterval = (id) => {
    const at = intervals.findIndex((t) => t.id === id);
    if (at !== -1) intervals.splice(at, 1);
    realClearInterval(id);
  };
  window.__intervals = intervals;
  put("fetch", async (url, init = {}) => {
    const u = new URL(String(url));
    if (!RELAY_HOST.test(u.hostname)) throw new Error(`network access in test: ${url}`);
    seen.push({ url: String(url), method: init.method ?? "GET", authorization: init.headers?.authorization ?? null });
    // jsdom's AbortSignal is not Node's; the Worker does not need it.
    const rest = { ...init };
    delete rest.signal;
    return w.fetch(String(url), rest);
  });
  put("WebSocket", live ? liveSocket(w) : class RefusedSocket {
    constructor() {
      this.readyState = 0;
      setTimeout(() => { this.readyState = 3; this.onclose?.({ code: 1006 }); }, 0);
    }
    send() {}
    close() { this.readyState = 3; }
  });
}

/**
 * The app on a page of its own, over relay `w`.
 * @param seed      the ledger, as `boot` takes it
 * @param settings  device-local keys to set before the app loads
 * @param hash      a fragment to open with, e.g. "#invite=MTR-..."
 * @param live      true for a WebSocket that reaches the relay; false (the
 *                  default) for one the relay refuses, like a 426
 */
export async function bootApp(w, { seed = null, settings = {}, hash = "", live = false } = {}) {
  let html = readFileSync(DIST, "utf8");
  const sets = [
    seed && `localStorage.setItem('meter:v1', ${JSON.stringify(JSON.stringify(seed))});`,
    ...Object.entries(settings).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`),
  ].filter(Boolean);
  if (sets.length) html = html.replace('<div id="root"></div>', `<div id="root"></div><script>${sets.join("")}</script>`);
  const requests = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: `http://localhost/${hash}`,
    beforeParse: (window) => install(window, w, requests, live),
  });
  dom.requests = requests;
  await appReady(dom);
  return dom;
}

// ------------------------------------------------------------------- driving

export const doc = (dom) => dom.window.document;

/** The Settings tab, where Meter Sync lives. */
export async function openSettings(dom) {
  const tab = [...doc(dom).querySelectorAll("[role=tab]")].find((t) => t.textContent === "Settings");
  if (tab.getAttribute("aria-selected") !== "true") { tab.click(); await settle(); }
}

/** The Meter Sync block (not the Google Drive one, whose eyebrow is "Sync"). */
export const panel = (dom) => [...doc(dom).querySelectorAll(".sec")]
  .find((x) => /^Meter Sync/.test(x.querySelector(".eyebrow")?.textContent ?? ""));

export const heading = (dom) => panel(dom)?.querySelector(".rl-h")?.textContent ?? "";

/** Clicks the first button in the panel whose text matches, and lets React settle. */
export async function press(dom, re) {
  const b = btn(panel(dom), re);
  if (!b) throw new Error(`no button ${re} in: ${panel(dom)?.textContent}`);
  b.click();
  await settle();
}

export const fill = async (dom, el, value) => {
  const win = dom.window;
  const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  await settle();
};

export const waitFor = (dom, cond, what, timeout = 20_000) => until(() => cond(panel(dom)), { timeout, what });

/** Accounts the relay currently holds, as its own admin says. */
export const liveVaults = async (w) => (await admin(w, "/stats")).body.vaults.count;

/** Everything a ledger may be asked to hold, as one string to search. */
export const ledgerText = (dom) => dom.window.localStorage.getItem("meter:v1") ?? "";

export const stored = (dom, key) => dom.window.localStorage.getItem(key);

export { btn, settle, until };
