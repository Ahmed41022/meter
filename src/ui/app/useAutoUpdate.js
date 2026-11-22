import { useCallback, useEffect, useRef } from "react";
import {
  BUILT_AT, buildIn, canSelfUpdate, isNewer, markUpdateReload,
} from "./autoUpdate.js";
import { anyUnsavedSettings } from "../settings/drafts.js";

/** How often a page that hears nothing checks anyway. */
export const CHECK_EVERY_MS = 30 * 60_000;
/** Coming back on screen checks again, but not more often than this. */
const SHOWN_GAP_MS = 5 * 60_000;
/** While typing is unsaved, how soon to look again. */
const WAIT_MS = 30_000;
/** A device can announce a build the host does not serve yet (a deploy still
 *  running). How soon to ask the host again. */
const NOT_YET_MS = 2 * 60_000;

/**
 * Updates the hosted app in place when a newer build is out. `newerSeen` is
 * the newest build stamp heard from another device; see autoUpdate.js.
 */
export function useAutoUpdate({ newerSeen = null, flash }) {
  const enabled = canSelfUpdate();
  const lastCheck = useRef(0);
  const timer = useRef(null);
  const going = useRef(false);

  const reloadInto = useCallback((stamp) => {
    if (going.current) return;
    if (anyUnsavedSettings()) {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => reloadInto(stamp), WAIT_MS);
      return;
    }
    // Once per build per tab: if the reload still comes up old, a cache in
    // between is holding on, and reloading again would only loop.
    try {
      if (sessionStorage.getItem("meter:update-tried") === String(stamp)) return;
      sessionStorage.setItem("meter:update-tried", String(stamp));
    } catch { /* no session storage: still update, at worst once per check */ }
    going.current = true;
    flash?.("Updating Meter to the latest version…");
    markUpdateReload();
    setTimeout(() => globalThis.location.reload(), 800);
  }, [flash]);

  const check = useCallback(async () => {
    if (!enabled || going.current) return;
    lastCheck.current = Date.now();
    let stamp = null;
    try {
      const res = await fetch(new URL("./", globalThis.location.href), { cache: "no-cache" });
      if (res.ok) stamp = buildIn(await res.text());
    } catch {
      return; // offline: the next check will do
    }
    if (isNewer(stamp, BUILT_AT)) reloadInto(stamp);
  }, [enabled, reloadInto]);

  // On its own: a little after opening, every half hour, and on coming back.
  useEffect(() => {
    if (!enabled) return undefined;
    const first = setTimeout(check, 10_000);
    const every = setInterval(check, CHECK_EVERY_MS);
    const onShow = () => {
      if (!document.hidden && Date.now() - lastCheck.current > SHOWN_GAP_MS) check();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearTimeout(first);
      clearInterval(every);
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [enabled, check]);

  // Another device runs a newer build: look now, and again shortly if the
  // host does not have it yet.
  useEffect(() => {
    if (!enabled || !isNewer(newerSeen, BUILT_AT)) return undefined;
    check();
    const again = setInterval(check, NOT_YET_MS);
    return () => clearInterval(again);
  }, [enabled, newerSeen, check]);
}
