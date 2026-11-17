import { useEffect } from "react";

/**
 * The app's clock. Every "today" and "this week" reads `now`, so how often it
 * moves is a decision about the whole screen, and it lives apart from the
 * state it drives.
 */
const TICK_MS = 1_000;
/**
 * How often the clock moves while no meter is running.
 *
 * Nothing on screen changes faster than the minute then, but the day and the
 * week do turn over, and every "today" and "this week" in the app reads this
 * clock. Twice a minute crosses midnight on time without re-rendering the
 * whole app every second for a figure that has not moved.
 */
const IDLE_TICK_MS = 30_000;

export function useClock(anyRunning, setNow) {
  /**
   * Drives rendering only. Stop this interval and the stored data is still
   * correct — elapsed time is derived, never accumulated here.
   *
   * It runs whether or not a meter does. Today's figures, the Overview's
   * period and the day a goal is paced against all read `now`, and a clock
   * that only moved with a meter left an app opened on Sunday night still
   * showing Sunday on Monday morning, with Monday's week reported as last
   * week's. A running meter needs the second; otherwise the idle tick will do.
   */
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), anyRunning ? TICK_MS : IDLE_TICK_MS);
    return () => clearInterval(id);
  }, [anyRunning]); // eslint-disable-line react-hooks/exhaustive-deps -- setNow is a state setter, stable by construction
}
