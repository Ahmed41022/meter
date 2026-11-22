import { useState } from "react";
import { checkRelayUrl } from "../../../sync/codes.js";
import { getInfo } from "../../../sync/relay.js";
import { DEFAULT_RELAY, relayFetch } from "../../../sync/relayConfig.js";
import { explainFailure } from "../../../sync/relayWords.js";
import PrivacyNotice from "./PrivacyNotice.jsx";
import { Problem, StepHeading } from "./parts.jsx";

/**
 * The first screen of setting up: the notice, then the three ways in. "Use my
 * own relay" is for the few who run their own, so it stays folded away; what is
 * typed there is checked (a real web address, and one that answers like a Meter
 * relay) before it is used for anything.
 */
export default function NotSetUp({ focus, onCreate, onJoin, onOwnRelay, onBack, secure }) {
  const [address, setAddress] = useState("");
  const [problem, setProblem] = useState("");
  const [checking, setChecking] = useState(false);

  const useOwn = async (e) => {
    e.preventDefault();
    setProblem("");
    let relay;
    try { relay = checkRelayUrl(address); } catch (err) { setProblem(explainFailure(err).message); return; }
    setChecking(true);
    try {
      const info = await getInfo({ fetch: relayFetch, relay });
      if (!info || typeof info !== "object" || info.v === undefined) throw new Error("not a relay");
      onOwnRelay(relay, info);
    } catch (err) {
      setProblem(err?.name === "TransportError" && err.code === "network"
        ? "Could not reach that address. Check it and your connection."
        : "That address did not answer like a Meter relay. Check that it is the address of a deployed Meter relay.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <StepHeading focus={focus}>Set up Meter Sync</StepHeading>
      <PrivacyNotice relay={DEFAULT_RELAY} />
      {!secure && (
        <p className="sync-note rl-warn" role="alert">
          Sync needs a secure page (https), and this page is not one, so it cannot encrypt
          anything here. Open Meter from its https address or the installed app.
        </p>
      )}
      <div className="rl-choices">
        <button type="button" className="btn primary" disabled={!secure} onClick={onCreate}>Create an account</button>
        <button type="button" className="btn" disabled={!secure} onClick={onJoin}>Join from another device</button>
      </div>
      <p className="sync-note">
        Creating an account needs an invite code. Joining needs the code another device shows
        when you choose Add a device there.
      </p>
      <details className="rl-own">
        <summary>Use my own relay</summary>
        <form onSubmit={useOwn}>
          <p className="sync-intro">
            For people who run their own copy of the Meter relay. Enter its address, such as
            https://my-relay.example.workers.dev. Your data then goes there instead.
          </p>
          <label className="field">
            <span className="eyebrow">Relay address</span>
            <input className="inp" value={address} inputMode="url" autoComplete="off" spellCheck={false}
                   placeholder="https://…" onChange={(e) => setAddress(e.target.value)} />
          </label>
          <Problem>{problem}</Problem>
          <div className="controls">
            <button type="submit" className="btn ghost" disabled={!address.trim() || checking || !secure}>
              {checking ? "Checking…" : "Check and use this relay"}
            </button>
          </div>
        </form>
      </details>
      <div className="sync-more">
        <button type="button" className="linkish" onClick={onBack}>Back</button>
      </div>
    </>
  );
}
