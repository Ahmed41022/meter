import { useState } from "react";
import { recoveryCodeOf } from "../../../sync/relayActions.js";
import { CopyButton, StepHeading } from "./parts.jsx";

/**
 * The recovery code: the vault key itself, as eight groups of eight characters.
 *
 * `required` is the first showing, right after an account is made: the person
 * must say they saved it before moving on, because from then on losing every
 * device without it loses the data (DESIGN 3.7). Without `required` it is the
 * "Show recovery code" view of an existing account, which only reveals and hides.
 * The code never leaves this screen except by the person copying it, and it is
 * not kept in React state: it is derived from the stored key on each render.
 */
export default function RecoveryCode({ vault, focus, required = false, onDone }) {
  const [saved, setSaved] = useState(false);
  const code = recoveryCodeOf(vault);
  return (
    <>
      <StepHeading focus={focus}>{required ? "Save your recovery code" : "Your recovery code"}</StepHeading>
      <p className="sync-intro">
        {required
          ? "This code is the only way to get your data back if you lose every device that has this account. Meter Sync cannot recover it for you, because it never has your key."
          : "Anyone with this code can read your ledger. Keep it private."}
      </p>
      <div className="rl-groups" aria-label="Recovery code, eight groups of eight characters">
        {code.split("-").map((group, i) => (
          <span className="rl-group" key={i}><span className="rl-ix" aria-hidden="true">{i + 1}</span>{group}</span>
        ))}
      </div>
      <div className="controls rl-copyrow">
        <CopyButton text={code} label="Copy" />
      </div>
      <p className="sync-note">
        Keep it in a password manager, or write it down and keep the paper somewhere safe.
        Don&apos;t keep it only on the device that uses it.
      </p>
      {required ? (
        <>
          <label className="clash-ok">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            I have saved it
          </label>
          <div className="controls">
            <button type="button" className="btn primary" disabled={!saved} onClick={onDone}>Continue</button>
          </div>
        </>
      ) : (
        <div className="controls">
          <button type="button" className="btn ghost" onClick={onDone}>Hide</button>
        </div>
      )}
    </>
  );
}
