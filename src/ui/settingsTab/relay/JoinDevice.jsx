import { useCallback, useEffect, useRef, useState } from "react";
import { createJoiner } from "../../../sync/pairing.js";
import { joinerTransportFor, setDeviceName } from "../../../sync/relay.js";
import { relayFetch } from "../../../sync/relayConfig.js";
import { defaultDeviceName } from "../../../sync/relayWords.js";
import { loadJoinSession, loadVault } from "../../../sync/vaultStore.js";
import { Problem, StepHeading } from "./parts.jsx";

/** How often the new device asks whether it was approved, and for how long
 *  (DESIGN 5.1). The code itself lives ten minutes; five of waiting is plenty
 *  for someone holding both devices. */
export const JOIN_POLL_MS = 2_000;
export const JOIN_GIVE_UP_MS = 5 * 60_000;

/**
 * Joining an account from a device that already has it. Paste or type the code
 * (or arrive here from a `#join=` link, which prefills it), compare the 6
 * digits with the other device's screen, and wait for it to approve. The key
 * never travels in the code; pairing.js carries the proofs, this draws them.
 *
 * Entries already on this device are kept: the first sync merges them with the
 * account's by the same last-edit-wins rule as every other sync, and deletes
 * nothing.
 */
export default function JoinDevice({ focus, initialCode = "", hasData, onJoined, onBack }) {
  const [text, setText] = useState(initialCode);
  const [view, setView] = useState({ phase: "idle" });
  const [busy, setBusy] = useState(false);
  const joiner = useRef(null);
  const since = useRef(0);
  if (!joiner.current) joiner.current = createJoiner({ transportFor: joinerTransportFor(relayFetch), win: globalThis });

  const finish = useCallback(async (state) => {
    // The new device could not name itself before it held the key, so it does now.
    // Best effort: an unnamed device is shown as "Unnamed device", which is fine.
    try {
      const vault = loadVault();
      if (vault) await setDeviceName({ fetch: relayFetch, vault, name: defaultDeviceName() });
    } catch { /* named later from the account screen */ }
    setView(state);
    onJoined?.(state);
  }, [onJoined]);

  const step = useCallback(async (promise) => {
    const next = await promise;
    if (next.phase === "joined") await finish(next); else setView(next);
    return next;
  }, [finish]);

  // A pairing left half way by closing the app: pick it up where it stopped.
  useEffect(() => {
    if (loadJoinSession()) {
      since.current = Date.now();
      step(joiner.current.resume());
    }
  }, [step]);

  const waiting = view.phase === "requesting" || view.phase === "waiting";
  useEffect(() => {
    if (!waiting) return undefined;
    const id = setInterval(() => {
      if (Date.now() - since.current > JOIN_GIVE_UP_MS) {
        setView({ phase: "timeout" });
        joiner.current.cancel();
        return;
      }
      step(joiner.current.poll());
    }, JOIN_POLL_MS);
    return () => clearInterval(id);
  }, [waiting, step]);

  const start = async (e) => {
    e.preventDefault();
    setBusy(true);
    since.current = Date.now();
    try {
      const next = await step(joiner.current.start(text));
      // The approver's key is known after the first look, which is when the
      // digits appear; do not make the person wait a poll interval for it.
      if (next.phase === "waiting" || next.phase === "requesting") step(joiner.current.poll());
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => { joiner.current.cancel(); onBack(); };
  const again = () => { setView({ phase: "idle" }); };
  const { phase } = view;

  return (
    <>
      <StepHeading focus={focus}>Join from another device</StepHeading>

      {(phase === "idle" || phase === "starting") && (
        <form onSubmit={start} aria-busy={busy}>
          <p className="sync-intro">
            On the device that already has the account, open Meter, go to Settings, Meter Sync,
            and choose <strong>Add a device</strong>. Then scan its code with this device&apos;s
            camera, or paste or type the code here.
          </p>
          {hasData && (
            <p className="sync-note">
              Your entries on this device will be merged in, not replaced: for each entry the later
              edit wins, and nothing is deleted.
            </p>
          )}
          <label className="field">
            <span className="eyebrow">Join code</span>
            <textarea className="inp rl-mono" rows={3} value={text} autoComplete="off" spellCheck={false}
                      placeholder="relay-address/XXXX-XXXX-…" onChange={(e) => setText(e.target.value)} />
          </label>
          <div className="controls">
            <button type="submit" className="btn primary" disabled={busy || !text.trim()}>Continue</button>
            <button type="button" className="btn ghost" disabled={busy} onClick={onBack}>Back</button>
          </div>
        </form>
      )}

      {waiting && (
        <>
          {view.digits ? (
            <>
              <p className="sync-intro" role="status">Check that this code matches the one on the other device.</p>
              <p className="rl-digits" aria-label={`Check code ${view.digits.split("").join(" ")}`}>{view.digits}</p>
              <p className="sync-note">
                If it matches, approve on the other device. If it does not, or you did not start
                this, cancel.
              </p>
            </>
          ) : (
            <p className="sync-note" role="status">Contacting the other device…</p>
          )}
          {hasData && (
            <p className="sync-note">Your entries on this device will be merged in, not replaced.</p>
          )}
          <Problem>{view.error?.message}</Problem>
          <div className="controls">
            <button type="button" className="btn ghost" onClick={cancel}>Cancel</button>
          </div>
        </>
      )}

      {phase === "joined" && (
        <>
          <p className="sync-read" role="status"><strong>Joined.</strong> This device now has the account, and is syncing your ledger.</p>
          <div className="controls"><button type="button" className="btn primary" onClick={onBack}>Done</button></div>
        </>
      )}

      {phase === "denied" && (
        <>
          <p className="sync-read" role="status"><strong>The other device said no.</strong> Nothing was shared.</p>
          <div className="controls">
            <button type="button" className="btn primary" onClick={again}>Try again</button>
            <button type="button" className="btn ghost" onClick={onBack}>Back</button>
          </div>
        </>
      )}

      {(phase === "expired" || phase === "timeout" || phase === "failed" || phase === "cancelled") && (
        <>
          <p className="sync-read" role="status">
            <strong>{phase === "expired" ? "That code expired." : phase === "timeout" ? "No answer from the other device." : "Could not join."}</strong>
          </p>
          <Problem>{view.error?.message ?? (phase === "timeout" ? "It was not approved in time. Make a new code on the other device and try again." : "")}</Problem>
          <div className="controls">
            <button type="button" className="btn primary" onClick={again}>Try again</button>
            <button type="button" className="btn ghost" onClick={onBack}>Back</button>
          </div>
        </>
      )}
    </>
  );
}
