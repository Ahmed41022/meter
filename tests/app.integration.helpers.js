/**
 * Shared by the tests/app.integration.*.test.js files, which drive the BUILT
 * artifact (dist/meter.html) in jsdom. Not a test file itself.
 */
import { beforeAll, afterEach } from "vitest";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { JSDOM as RealJSDOM } from "jsdom";

/**
 * Every page a test builds goes through this class, so each one is tracked:
 * `settle` watches the live ones for DOM mutations, and `afterEach` closes
 * them all. Closing stops the page's timers (the app ticks every second while a
 * meter runs) and frees it; without it every window of the run stays alive.
 */
const live = new Set();
export class JSDOM extends RealJSDOM {
  constructor(...args) {
    super(...args);
    const { window } = this;
    this.mutations = 0;
    this.observer = new window.MutationObserver(() => { this.mutations++; });
    this.observer.observe(window.document, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
    live.add(this);
  }
}
const liveMutations = () => { let n = 0; for (const dom of live) n += dom.mutations; return n; };

export const DIST = new URL("../dist/meter.html", import.meta.url);
/** A real, fixed stretch of time. Only for tests whose subject IS time passing
 *  (nothing may happen in a window at least as long as the app's tick). */
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls until `cond` returns something truthy, and returns it. Timers and
 * React keep running between polls. On timeout it THROWS, naming `what`, so a
 * thing that never happens fails the test instead of passing quietly.
 */
export const until = async (cond, { timeout = 5000, what = "the condition" } = {}) => {
  const t0 = Date.now();
  for (;;) {
    let value;
    try { value = cond(); } catch { value = null; }
    if (value) return value;
    if (Date.now() - t0 > timeout) throw new Error(`Timed out after ${timeout} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 4));
  }
};

/**
 * For a step that only needs React to flush after a click or an input: resolves
 * once the page has stopped changing for a few polls (and at least a couple of
 * macrotask turns have gone by). Capped; if the page is still moving at the cap
 * it just returns, and the assertion that follows is what decides.
 */
export const settle = async (cap = 2000) => {
  const t0 = Date.now();
  let last = liveMutations(), stable = 0, turns = 0;
  while (Date.now() - t0 < cap && (stable < 3 || turns < 3)) {
    await new Promise((r) => setTimeout(r, 4));
    turns++;
    const now = liveMutations();
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
};

/** The app has mounted and loaded its ledger (the "Loading" placeholder is gone). */
export const appReady = (dom) => until(() => {
  const root = dom.window.document.getElementById("root");
  return root && root.querySelector(".mtr") && !/Loading your ledger/.test(root.textContent);
}, { what: "the app to finish loading" });

/**
 * Instruments localStorage before the bundle runs, so tests can assert that
 * the app touches storage a bounded number of times. Reads are the tell for a
 * render loop: the store is meant to load exactly once at startup.
 */
// Patched on the prototype: jsdom's Storage is a Proxy, so assigning
// getItem directly on the instance is silently ignored.
export const COUNTER = `<script>
  window.__reads = 0; window.__writes = 0;
  const g = Storage.prototype.getItem, t = Storage.prototype.setItem;
  Storage.prototype.getItem = function (...a) {
    if (a[0] === 'meter:v1') window.__reads++;
    return g.apply(this, a);
  };
  Storage.prototype.setItem = function (...a) {
    if (a[0] === 'meter:v1') window.__writes++;
    return t.apply(this, a);
  };
</script>`;

/** `settings` seeds device-local keys — the ones that are NOT part of the
 *  ledger, such as the Google client id. They have to be in place before the
 *  page runs, because the app reads them once at mount, exactly as a real
 *  browser would. */
export const boot = async (seed, settings = null, script = "") => {
  let html = readFileSync(DIST, "utf8");
  const sets = [
    seed && `localStorage.setItem('meter:v1', ${JSON.stringify(JSON.stringify(seed))});`,
    ...Object.entries(settings ?? {}).map(
      ([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`),
  ].filter(Boolean);
  // `script` runs before the bundle, for what a test must have in place first
  // (a stubbed fetch, say): jsdom has no network of its own.
  const preamble = (sets.length ? `<script>${sets.join("")}</script>${COUNTER}` : COUNTER)
    + (script ? `<script>${script}</script>` : "");
  html = html.replace('<div id="root"></div>', `<div id="root"></div>${preamble}`);
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/" });
  await appReady(dom);
  return dom;
};

export const runningSeed = (lastTickAgoMs) => {
  const now = Date.now(), HOUR = 3_600_000;
  return {
    projects: [{ id: "p1", name: "Acme", currentRate: 450, currency: "EGP",
                 createdAt: now - HOUR, sessionGoal: null, overallGoal: null }],
    sessions: [{ id: "s1", projectId: "p1", kind: "billed", rate: 450, currency: "EGP",
                 createdAt: now - HOUR,
                 segments: [{ startedAt: now - HOUR, endedAt: null, lastTick: now - lastTickAgoMs }],
                 closedAt: null, deletedAt: null }],
  };
};

export const btn = (d, re) => [...d.querySelectorAll("button")].find((b) => re.test(b.textContent));

/**
 * Boot, then go to the Overview.
 *
 * Most of the dashboard tests below were written when the app opened on the
 * Overview. It opens on Today now — what you are doing, not how the month
 * went — so a test about the dashboard has to say which screen it means.
 */
/**
 * The Overview opened on all time rather than the week it defaults to.
 *
 * For tests that seed work a day or two back to say "not today" and then ask
 * whether it shows up at all. The week starts on Monday, so on a Monday
 * yesterday is last week and those tests failed one day in seven — on the
 * real clock, wherever they happened to run. Nothing they assert is about
 * where a week begins; the tests that are say so with their own period.
 */
export const ALL_TIME = { "meter:period": "all" };

export const bootDash = async (seed, settings = null) => {
  const dom = await boot(seed, settings);
  await settle();
  await toProjects(dom.window.document, "Overview");
  return dom;
};

/**
 * The overall view is what the app opens on, so anything that manages projects
 * switches to the Projects tab first. Idempotent: a no-op when that tab is
 * already showing, or when a project is open and the tabs are replaced by the
 * back link.
 */
export const toProjects = async (d, name = "Work") => {
  const tab = [...d.querySelectorAll("[role=tab]")].find((t) => t.textContent === name);
  if (tab && tab.getAttribute("aria-selected") !== "true") {
    tab.click();
    await settle();
  }
};
export const setValue = (win, el, value) => {
  const proto = el.tagName === "SELECT" ? win.HTMLSelectElement.prototype
    : el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype
      : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
};

/** Starting now asks for a task first: click Start, answer the prompt, and the
 *  same button confirms. Pass `task` to create a new one on the way in. */
export const startMeter = async (dom, { idle = false, task = null, existing = null } = {}) => {
  const { window } = dom, d = window.document;
  const label = idle ? /Start idle/i : /Start the meter/i;
  btn(d, label).click();
  await settle();
  if (task !== null) {
    btn(d, /New task/i).click();
    await settle();
    setValue(window, d.querySelector(".prompt input"), task);
  } else if (existing !== null) {
    btn(d, /^Existing/i).click();
    await settle();
    const select = d.querySelector(".prompt select");
    const option = [...select.options].find((o) => o.textContent === existing);
    setValue(window, select, option.value);
  }
  btn(d, label).click();
  await until(() => /^(Running|Idling)$/.test(d.querySelector(".state")?.textContent.trim() ?? ""),
    { what: "the meter to start" });
  await settle();
};

/** Walks a directory for the newest mtime. */
const newestMtime = (dir) => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
};

/**
 * Call once at the top of every integration test file: checks the build is not
 * stale before any test runs, and closes every page a test opened after it.
 */
export const guardBuiltApp = () => {
  beforeAll(() => {
    if (!existsSync(DIST)) throw new Error("dist/meter.html missing — run `npm run build` first");

    // These tests drive the built file. A build that failed leaves the previous
    // bundle in place, so without this check they would quietly keep passing
    // against stale output and report green on code that doesn't even compile.
    const built = statSync(DIST).mtimeMs;
    const sources = Math.max(
      newestMtime(new URL("../src/", import.meta.url)),
      newestMtime(new URL("../scripts/", import.meta.url))
    );
    if (sources > built) {
      throw new Error(
        "dist/meter.html is older than src/ — the last build failed or was skipped. Run `npm run build`."
      );
    }
  });

  afterEach(() => {
    for (const dom of live) {
      dom.observer.disconnect();
      dom.window.close();
    }
    live.clear();
  });
};
