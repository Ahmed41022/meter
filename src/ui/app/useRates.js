import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRates, isStale, loadCache, saveCache } from "../../fx/rates.js";

/**
 * Live exchange rates for the screen, when the owner has turned them on.
 *
 * With `fxOn` false this does nothing at all: no read of the cache, no fetch,
 * no timer, and `rates` is null so nothing on screen can convert. That is what
 * keeps the app identical to before for anyone who never opens Settings →
 * Currency.
 *
 * With it on: the saved copy is read at once (so a figure can show offline),
 * a fetch follows if that copy is missing or stale, and the same check repeats
 * while the app stays open. It checks rather than fetches, so an app left open
 * all week asks about once a day, not four times a day.
 *
 * `status` is "off", "idle" (on, nothing yet), "loading", "ok", or "error". An
 * error keeps whatever rates the cache held, so a failed refresh offline still
 * leaves last time's figures standing, with the error beside them.
 */
const CHECK_MS = 6 * 3_600_000;
const OFF = { rates: null, status: "off", error: null, fetchedAt: null };

const fromCache = (cache) => cache
  ? { rates: cache, status: "ok", error: null, fetchedAt: cache.fetchedAt }
  : { rates: null, status: "idle", error: null, fetchedAt: null };

export function useRates(fxOn, { fetch, now = Date.now } = {}) {
  const [state, setState] = useState(OFF);
  const live = useRef(0);        // bumped whenever the switch flips or we unmount
  const inFlight = useRef(null);
  const cacheRef = useRef(null);
  // Held in refs so the effect below depends on the switch alone.
  const optionsRef = useRef({ fetch, now });
  optionsRef.current = { fetch, now };

  // A function, not `live.current++` in the cleanup, which lint reads as a stale ref.
  const invalidate = () => { live.current++; };

  const run = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    const token = live.current;
    setState((s) => ({ ...s, status: "loading", error: null }));
    const job = fetchRates(optionsRef.current).then(
      (fresh) => {
        if (token !== live.current) return;
        cacheRef.current = fresh;
        saveCache(fresh);
        setState(fromCache(fresh));
      },
      (e) => {
        if (token !== live.current) return;
        setState((s) => ({ ...s, status: "error", error: e?.message || "Could not get rates." }));
      },
    ).finally(() => { if (inFlight.current === job) inFlight.current = null; });
    inFlight.current = job;
    return job;
  }, []);

  useEffect(() => {
    if (!fxOn) {
      invalidate();
      inFlight.current = null;
      cacheRef.current = null;
      setState((s) => (s.status === "off" ? s : OFF));
      return undefined;
    }
    invalidate();
    cacheRef.current = loadCache();
    setState(fromCache(cacheRef.current));
    const check = () => {
      if (isStale(cacheRef.current, optionsRef.current.now())) run();
    };
    check();
    const id = setInterval(check, CHECK_MS);
    return () => {
      clearInterval(id);
      invalidate();
      inFlight.current = null;
    };
  }, [fxOn, run]);

  /** Fetch now, whatever the cache says. Nothing happens while the switch is off. */
  const refresh = useCallback(() => (fxOn ? run() : Promise.resolve()), [fxOn, run]);

  return { ...state, refresh };
}
