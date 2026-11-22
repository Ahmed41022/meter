import { useEffect, useRef } from "react";
import { isRunning, isStale } from "../../domain/time.js";
import { liveSessions, ownedBy } from "../../domain/sessions.js";
import { cameFromUpdate } from "./autoUpdate.js";

/**
 * Opening the ledger and deciding what the first screen has to say about it:
 * the unreadable-ledger banner, the crashed-meter recovery and the
 * already-running warning all come out of this one load, so they start together.
 */
const STALE_MS = 150_000;
export const EMPTY = { projects: [], sessions: [], objectives: [], earnings: [] };

export function useStartup({
  store, device, stateRef, toastTimer, setState, setUnreadable, setReady, setRecoveryId,
  setConflict,
}) {
  const booted = useRef(false);

  /** Startup only. Guarded independently of the dependency array so that no
   *  future change to these deps can resurrect the startup banners after the
   *  user has already answered them. */
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    let alive = true;
    store.load().then((loaded) => {
      if (!alive) return;
      const data = loaded ?? EMPTY;
      stateRef.current = data;
      setState(data);
      // Empty because what was stored could not be read, not because nothing
      // was. The store has already made it safe; the banner says how.
      setUnreadable(store.unreadable);
      setReady(true);

      const t = Date.now();
      /**
       * Only meters this device opened are ours to judge.
       *
       * A session running on another device stopped syncing its heartbeat the
       * moment it started — proof of life is deliberately local — so from here
       * it always looks stale, and offering to close it at its last tick would
       * cut hours off work that is still being done. It is not a crash and it
       * is not a second tab: it is the other machine, and the running bar
       * already offers to stop it.
       */
      const running = liveSessions(data.sessions)
        .filter((s) => isRunning(s) && ownedBy(s, device));
      const stale = running.find((s) => isStale(s, t, STALE_MS));
      if (stale) setRecoveryId(stale.id);
      // fresh heartbeat: another tab, unless this tab just reloaded itself
      // into an update and the meter was its own a second ago.
      else if (running.length && !cameFromUpdate()) setConflict(true);
    });
    return () => { alive = false; clearTimeout(toastTimer.current); }; // eslint-disable-line react-hooks/exhaustive-deps -- the timer is cleared as it stands, on purpose
  }, [store, device]); // eslint-disable-line react-hooks/exhaustive-deps -- setters and refs passed in are stable; load once for a store and device
}
