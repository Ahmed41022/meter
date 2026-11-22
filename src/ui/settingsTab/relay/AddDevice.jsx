import { useCallback, useEffect, useRef, useState } from "react";
import { createApprover } from "../../../sync/pairing.js";
import { approverTransport } from "../../../sync/relay.js";
import { APP_URL, relayFetch } from "../../../sync/relayConfig.js";
import QrCode from "./QrCode.jsx";
import { CopyButton, Problem, StepHeading, useTick } from "./parts.jsx";

/** How often the approver looks for a request when the socket has not said one
 *  arrived. The socket's `pair_request` makes it immediate; this is the floor. */
export const PAIR_POLL_MS = 3_000;

const countdown = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Adding a device, from the device that already has the account (the approver).
 * It opens a short-lived join slot and shows its code as a QR and as text. When
 * the new device asks, the 6-digit check is shown here and on the new device;
 * the owner approves only if they match, which is the proof that the device in
 * their hand is the one asking (DESIGN 5.1). All the protocol is pairing.js;
 * this only draws its states and calls its steps.
 */
export default function AddDevice({ relay, focus, onClose, onAdded }) {
  const { vault, subscribe } = relay;
  const [view, setView] = useState({ phase: "starting" });
  const [busy, setBusy] = useState(false);
  const approver = useRef(null);
  const now = useTick(1_000);

  const begin = useCallback(async () => {
    const a = createApprover({ transport: approverTransport({ fetch: relayFetch, vault }), vault, appOrigin: APP_URL });
    approver.current = a;
    setView({ phase: "starting" });
    setView(await a.start());
  }, [vault]);

  useEffect(() => {
    begin();
    // Walking away leaves the slot to expire on its own, which it does in ten minutes.
    return () => approver.current?.cancel();
  }, [begin]);

  const look = useCallback(async () => {
    const a = approver.current;
    if (a) setView(await a.poll());
  }, []);

  useEffect(() => {
    if (view.phase !== "waiting") return undefined;
    const id = setInterval(look, PAIR_POLL_MS);
    return () => clearInterval(id);
  }, [view.phase, look]);

  useEffect(() => subscribe((m) => { if (m.t === "pair_request") look(); }), [subscribe, look]);

  const act = async (step) => {
    setBusy(true);
    try {
      const next = await approver.current[step]();
      setView(next);
      if (next.phase === "approved") onAdded?.();
    } finally {
      setBusy(false);
    }
  };

  const { phase } = view;
  return (
    <>
      <StepHeading focus={focus}>Add a device</StepHeading>

      {phase === "starting" && <p className="sync-note" role="status">Making a code…</p>}

      {phase === "waiting" && (
        <>
          <ol className="rl-steps">
            <li>On the new device, open Meter and go to Settings, then Meter Sync, then <strong>Join from another device</strong>.</li>
            <li>Scan this code with its camera, or type or paste the code below.</li>
            <li>Come back here, check the 6 digits, and approve.</li>
          </ol>
          <QrCode text={view.link ?? view.code} label="Code for the new device" />
          <p className="eyebrow rl-sub">Or type this code</p>
          <code className="rl-codebox" aria-label="Join code">{view.code}</code>
          <div className="controls rl-copyrow">
            <CopyButton text={view.code} label="Copy code" />
            {view.link && <CopyButton text={view.link} label="Copy link" />}
          </div>
          <p className="sync-note" role="timer">
            Expires in {countdown(view.expiresAt - now)}. It works once, and it cannot open your
            data on its own: this device still has to approve.
          </p>
          <Problem>{view.error?.message}</Problem>
          <div className="controls">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}

      {phase === "confirm" && (
        <>
          <p className="sync-intro" role="status">A new device wants to join this account.</p>
          <p className="rl-digits" aria-label={`Check code ${view.digits.split("").join(" ")}`}>{view.digits}</p>
          <p className="sync-note">
            The same 6 digits must be showing on the new device, in your hand. If they are not, or
            you are not adding a device right now, press Deny.
          </p>
          <Problem>{view.error?.message}</Problem>
          <div className="controls">
            <button type="button" className="btn primary" disabled={busy} onClick={() => act("approve")}>Approve</button>
            <button type="button" className="btn danger" disabled={busy} onClick={() => act("deny")}>Deny</button>
          </div>
        </>
      )}

      {phase === "approved" && (
        <>
          <p className="sync-read" role="status"><strong>Device added.</strong> It is downloading your ledger now.</p>
          <div className="controls"><button type="button" className="btn primary" onClick={onClose}>Done</button></div>
        </>
      )}

      {phase === "denied" && (
        <>
          <p className="sync-read" role="status"><strong>Denied.</strong> Nothing was shared, and that code no longer works.</p>
          <div className="controls"><button type="button" className="btn primary" onClick={onClose}>Done</button></div>
        </>
      )}

      {phase === "expired" && (
        <>
          <p className="sync-read" role="status"><strong>That code expired.</strong> Nothing was shared.</p>
          <div className="controls">
            <button type="button" className="btn primary" onClick={begin}>Make a new code</button>
            <button type="button" className="btn ghost" onClick={onClose}>Back</button>
          </div>
        </>
      )}

      {(phase === "failed" || phase === "idle") && (
        <>
          <p className="sync-read" role="status"><strong>Could not add the device.</strong></p>
          <Problem>{view.error?.message ?? "Something went wrong."}</Problem>
          <div className="controls">
            {(view.error?.retry ?? true) && <button type="button" className="btn primary" onClick={begin}>Try again</button>}
            <button type="button" className="btn ghost" onClick={onClose}>Back</button>
          </div>
        </>
      )}
    </>
  );
}
