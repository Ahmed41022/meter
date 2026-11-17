import { useEffect } from "react";
import { heartbeat } from "../../domain/sessions.js";

/**
 * Proof of life for a running meter. Local on purpose: it is written without a
 * change stamp so it can never out-vote a stop made on the other device.
 */
const HEARTBEAT_MS = 60_000;

export function useHeartbeat({ meterHere, recoveryId, write, device, stateRef }) {
  /**
   * Proof of life, so a crash can be closed at the right timestamp.
   *
   * Written with `write` rather than `commit`, which is the whole difference
   * between a meter you can stop from your phone and one you cannot. `commit`
   * stamps what it touched, and the merge takes the later stamp — so a laptop
   * ticking once a minute would out-stamp the stop your phone made, and the
   * session would quietly reopen with the hours the laptop kept counting.
   *
   * A heartbeat is not news about the ledger. It is this device saying it is
   * still here, to itself.
   */
  useEffect(() => {
    if (!meterHere || recoveryId) return;
    const id = setInterval(
      () => write(heartbeat(stateRef.current, Date.now(), device)),
      HEARTBEAT_MS,
    );
    return () => clearInterval(id);
  }, [meterHere, recoveryId, write, device]); // eslint-disable-line react-hooks/exhaustive-deps -- stateRef is a ref, stable by construction
}
