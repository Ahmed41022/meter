import { useEffect } from "react";

/**
 * Pulls the clock forward when the app is looked at again, since a hidden tab
 * or a sleeping laptop has had its timers held back.
 */
export function useWakeCatchUp(setNow) {
  /** Catches up the moment the app is looked at again. A tab in the
   *  background, or a laptop asleep overnight, has its timers held back, so
   *  without this the first thing on screen after waking would be yesterday
   *  until the next tick came round. */
  useEffect(() => {
    const catchUp = () => { if (!document.hidden) setNow(Date.now()); };
    document.addEventListener("visibilitychange", catchUp);
    window.addEventListener("focus", catchUp);
    return () => {
      document.removeEventListener("visibilitychange", catchUp);
      window.removeEventListener("focus", catchUp);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- setNow is a state setter, stable by construction
}
