import { useCallback, useEffect, useRef, useState } from "react";
import { deleteVault, listDevices, setDeviceName } from "../../../sync/relay.js";
import { relayFetch } from "../../../sync/relayConfig.js";
import { cleanDeviceName, explainFailure } from "../../../sync/relayWords.js";
import DeviceList from "./DeviceList.jsx";
import StatusLine, { PresenceLines } from "./StatusLine.jsx";
import { Problem, StepHeading, useTick } from "./parts.jsx";

/** The word that has to be typed before an account is deleted. The relay checks
 *  the same word, so a request that skipped this screen is refused too. */
export const DELETE_WORD = "delete";

/** Where nothing can sync until the person acts, so Sync now and Add a device
 *  would only fail. */
const STUCK = new Set(["auth", "deleted"]);

/**
 * An account that is set up: how it is doing, this device's name, the devices,
 * and the few things done rarely. The rare, destructive ones (leave, delete,
 * show the code) each ask first, in place of the buttons, so a stray tap cannot
 * do them.
 */
export default function Account({ relay, focus, onAdd, onShowRecovery }) {
  const { vault, status, socketState, presence, subscribe } = relay;
  const now = useTick(5_000);
  const [devices, setDevices] = useState([]);
  const [listProblem, setListProblem] = useState("");
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(null);
  const [nameProblem, setNameProblem] = useState("");
  const [saving, setSaving] = useState(false);
  const [ask, setAsk] = useState(null); // "recovery" | "leave" | "delete"
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const stuck = STUCK.has(status.state);
  const deleted = status.state === "deleted";
  // Read when a list comes back, not a reason to ask for it again: a round
  // finishing every few seconds must not mean a request for the device list.
  const stuckRef = useRef(stuck);
  stuckRef.current = stuck;

  const refresh = useCallback(async () => {
    try {
      const list = await listDevices({ fetch: relayFetch, vault });
      setDevices(list);
      setListProblem("");
      setDraft((d) => d ?? (list.find((x) => x.id === vault.deviceId)?.name ?? ""));
    } catch (e) {
      // A removed or deleted account has no list to show; the status line says why.
      if (!stuckRef.current) setListProblem(explainFailure(e).message);
    } finally {
      setLoading(false);
    }
  }, [vault]);

  useEffect(() => { refresh(); }, [refresh]);
  // The relay says when a device joined or left; look again then.
  useEffect(() => subscribe((m) => { if (m.t === "devices") refresh(); }), [subscribe, refresh]);

  const saveName = async (e) => {
    e.preventDefault();
    setNameProblem("");
    setSaving(true);
    try {
      const name = cleanDeviceName(draft);
      await setDeviceName({ fetch: relayFetch, vault, name });
      setDraft(name);
      await refresh();
    } catch (err) {
      setNameProblem(explainFailure(err).message);
    } finally {
      setSaving(false);
    }
  };

  const close = () => { setAsk(null); setTyped(""); setProblem(""); };

  const doDelete = async () => {
    setBusy(true);
    setProblem("");
    try {
      await deleteVault({ fetch: relayFetch, vault });
      relay.leave();
    } catch (err) {
      setProblem(explainFailure(err).message);
      setBusy(false);
    }
  };

  return (
    <>
      <StepHeading focus={focus}>Your account</StepHeading>
      <StatusLine status={status} socketState={socketState} now={now} />
      <PresenceLines presence={presence} devices={devices} selfId={vault.deviceId} now={now} />

      {!stuck && (
        <div className="controls">
          <button type="button" className="btn primary" disabled={status.state === "syncing"} onClick={relay.syncNow}>
            Sync now
          </button>
          <button type="button" className="btn ghost" disabled={status.state === "needs-update" || status.state === "rekey"} onClick={onAdd}>
            Add a device
          </button>
        </div>
      )}

      {!deleted && (
        <>
          <form className="rl-name" onSubmit={saveName}>
            <label className="field">
              <span className="eyebrow">This device&apos;s name</span>
              <span className="rl-inline">
                <input className="inp" value={draft ?? ""} maxLength={40} autoComplete="off" disabled={draft === null}
                       onChange={(e) => setDraft(e.target.value)} />
                <button type="submit" className="btn ghost" disabled={saving || draft === null}>{saving ? "Saving…" : "Save"}</button>
              </span>
            </label>
            <Problem>{nameProblem}</Problem>
          </form>
          <span className="eyebrow rl-sub">Devices</span>
          <DeviceList devices={devices} selfId={vault.deviceId} now={now} problem={listProblem} loading={loading} />
        </>
      )}

      {ask === "recovery" && (
        <div className="rl-confirm" role="alertdialog" aria-labelledby="rl-ask-title">
          <StepHeading focus id="rl-ask-title">Show the recovery code?</StepHeading>
          <p className="sync-intro">Anyone who sees it can read your ledger. Make sure nobody is looking at your screen.</p>
          <div className="controls">
            <button type="button" className="btn primary" onClick={onShowRecovery}>Show it</button>
            <button type="button" className="btn ghost" onClick={close}>Cancel</button>
          </div>
        </div>
      )}

      {ask === "leave" && (
        <div className="rl-confirm" role="alertdialog" aria-labelledby="rl-ask-title">
          <StepHeading focus id="rl-ask-title">Leave on this device?</StepHeading>
          <p className="sync-intro">
            This device stops syncing and forgets the account. Your ledger here stays exactly as it
            is, and the account stays on your other devices. To sync again you would join it again
            (or use the recovery code).
          </p>
          <div className="controls">
            <button type="button" className="btn danger" onClick={() => relay.leave()}>Leave on this device</button>
            <button type="button" className="btn ghost" onClick={close}>Cancel</button>
          </div>
        </div>
      )}

      {ask === "delete" && (
        <div className="rl-confirm" role="alertdialog" aria-labelledby="rl-ask-title">
          <StepHeading focus id="rl-ask-title">Delete the account?</StepHeading>
          <p className="sync-intro">
            This erases the account and everything stored for it on the relay, for every device.
            It cannot be undone. The ledger on your devices is not touched, but they will stop syncing.
          </p>
          <label className="field">
            <span className="eyebrow">Type {DELETE_WORD} to confirm</span>
            <input className="inp" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
          </label>
          <Problem>{problem}</Problem>
          <div className="controls">
            <button type="button" className="btn danger" disabled={typed.trim().toLowerCase() !== DELETE_WORD || busy} onClick={doDelete}>
              {busy ? "Deleting…" : "Delete account"}
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={close}>Cancel</button>
          </div>
        </div>
      )}

      {!ask && (
        <div className="sync-more rl-more">
          {!deleted && (
            <>
              <button type="button" className="linkish" onClick={() => setAsk("recovery")}>Show recovery code</button>
              <span className="sync-sep" aria-hidden="true">·</span>
            </>
          )}
          <button type="button" className="linkish" onClick={() => setAsk("leave")}>Leave on this device</button>
          {!stuck && (
            <>
              <span className="sync-sep" aria-hidden="true">·</span>
              <button type="button" className="linkish" onClick={() => setAsk("delete")}>Delete account</button>
            </>
          )}
        </div>
      )}
    </>
  );
}
