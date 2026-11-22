/**
 * Keeping every device on the same build.
 *
 * Each build is stamped with the moment of the commit it was built from
 * (`__METER_BUILT_AT__`, and a `<meta name="meter-build">` in the page). Two
 * devices that sync compare those stamps: every batch a device sends carries
 * its own (sync/changes.js), and so does a short hello when its live
 * connection opens. A device that hears of a newer one checks the hosted page
 * itself, bypassing the browser's cache, and reloads into it when it is there.
 * It also checks now and then on its own, and when it comes back on screen, so
 * an update reaches a device that has nobody to hear it from.
 *
 * Only the hosted app does this (it is the one with a service worker, and the
 * desktop app loads it). The single-file `meter.html` has nowhere to update
 * from, and the tests run without either.
 *
 * Reloading is safe for the ledger, which is saved as it changes, and for a
 * running meter, whose time is derived from when it started. What a reload
 * would lose is typing not yet saved, so it waits while any is open.
 */

/* global __METER_BUILT_AT__ */
export const BUILT_AT = typeof __METER_BUILT_AT__ === "number" ? __METER_BUILT_AT__ : 0;

/** The build stamp in a page's HTML, or null. */
export const buildIn = (html) => {
  const m = /<meta name="meter-build" content="(\d+)"/.exec(String(html ?? ""));
  return m ? Number(m[1]) : null;
};

/** A stamp from somewhere else, as a number, or null when it is not one. */
export const stampOf = (value) => (Number.isFinite(value) && value > 0 ? value : null);

/** Whether `theirs` is a newer build than `mine`. An unknown stamp never is. */
export const isNewer = (theirs, mine = BUILT_AT) => {
  const t = stampOf(theirs);
  return t !== null && stampOf(mine) !== null && t > mine;
};

/** Set just before reloading into an update, so the page that comes up knows
 *  the meter it finds ticking was its own a second ago and not another tab's. */
export const RELOADED_KEY = "meter:updated-reload";
const RELOAD_GRACE_MS = 60_000;

export const markUpdateReload = (now = Date.now()) => {
  try { sessionStorage.setItem(RELOADED_KEY, String(now)); } catch { /* private mode */ }
};

/** True once, right after an update reload. */
export const cameFromUpdate = (now = Date.now()) => {
  try {
    const at = Number(sessionStorage.getItem(RELOADED_KEY));
    sessionStorage.removeItem(RELOADED_KEY);
    return Number.isFinite(at) && at > 0 && now - at < RELOAD_GRACE_MS;
  } catch {
    return false;
  }
};

/** Whether this page can update itself at all. */
export const canSelfUpdate = () => typeof navigator !== "undefined"
  && "serviceWorker" in navigator
  && typeof fetch === "function"
  && /^https?:$/.test(globalThis.location?.protocol ?? "")
  && BUILT_AT > 0;
