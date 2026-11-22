import { useState } from "react";
import { formatInvite, parseInvite } from "../../../sync/codes.js";
import { createAccount } from "../../../sync/relayActions.js";
import { isDefaultRelay, relayFetch } from "../../../sync/relayConfig.js";
import { cleanDeviceName, defaultDeviceName, explainFailure } from "../../../sync/relayWords.js";
import PrivacyNotice from "./PrivacyNotice.jsx";
import { Problem, StepHeading } from "./parts.jsx";

/** What the person typed or pasted as `{ code, relay }`: a bare code, or a whole
 *  `#invite=` link. Empty is fine when the relay is open to everyone. */
const readInvite = (text) => (text.trim() ? parseInvite(text) : { code: null, relay: null });

/**
 * Making an account: an invite, a name for this device, and a button. The
 * button does the whole of it in the order that makes a retry safe (see
 * relayActions.createAccount), so every failure here can simply be tried again.
 *
 * `resume` means an earlier attempt left an identity on this device that the
 * relay never confirmed; pressing the button finishes it rather than starting
 * a second account.
 */
export default function CreateAccount({
  focus, relay, open, initialInvite = "", resume = false, onDone, onBack,
}) {
  const [invite, setInvite] = useState(initialInvite);
  const [name, setName] = useState(() => defaultDeviceName());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [field, setField] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setProblem("");
    setField(null);
    setBusy(true);
    try {
      const { code, relay: named } = readInvite(invite);
      if (named && named !== relay) {
        // An invite link can name a relay. Switching to one silently would send
        // the person's (encrypted) ledger to a server they never chose.
        setProblem(`This invite is for the relay at ${new URL(named).host}, not this one. Go back, choose Use my own relay and enter that address if you trust it.`);
        setField("invite");
        return;
      }
      if (!code && !open) {
        setProblem("Enter your invite code. This relay only makes accounts for people who have one.");
        setField("invite");
        return;
      }
      const vault = await createAccount({
        fetch: relayFetch, win: globalThis, relay, invite: code, name: cleanDeviceName(name, defaultDeviceName()),
      });
      onDone(vault);
    } catch (err) {
      const said = explainFailure(err);
      setProblem(said.message);
      setField(said.field ?? null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} aria-busy={busy}>
      <StepHeading focus={focus}>Create an account</StepHeading>
      <PrivacyNotice relay={relay} />
      {!isDefaultRelay(relay) && (
        <p className="sync-note">Relay: <code className="origin">{relay}</code></p>
      )}
      {resume && (
        <p className="sync-note">
          An earlier attempt on this device did not finish. This picks it up where it stopped,
          without making a second account.
        </p>
      )}
      <label className="field">
        <span className="eyebrow">Invite code{open ? " (optional on this relay)" : ""}</span>
        <input className="inp rl-mono" value={invite} autoComplete="off" spellCheck={false} autoCapitalize="characters"
               placeholder="MTR-XXXXX-XXXXX-XXXXX-XXXXX" aria-invalid={field === "invite" || field === "code"}
               onChange={(e) => setInvite(e.target.value)} />
        {/* A code with the dashes put back reads better than a bare run of letters. */}
        <small className="rl-hint">{previewOf(invite)}</small>
      </label>
      <label className="field">
        <span className="eyebrow">Name for this device</span>
        <input className="inp" value={name} maxLength={40} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        <small className="rl-hint">Shown in your list of devices. Encrypted: the relay cannot read it.</small>
      </label>
      <Problem>{problem}</Problem>
      <div className="controls">
        <button type="submit" className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
        <button type="button" className="btn ghost" disabled={busy} onClick={onBack}>Back</button>
      </div>
    </form>
  );
}

function previewOf(text) {
  try {
    const { code } = readInvite(text);
    return code ? `Reads as ${formatInvite(code)}` : "";
  } catch {
    return "";
  }
}
