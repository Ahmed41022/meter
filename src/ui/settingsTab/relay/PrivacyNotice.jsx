import { operatorOf } from "../../../sync/relayConfig.js";

/**
 * What the relay sees and cannot see, shown before anything is made (DESIGN M5).
 * A plain notice, not legal text, and it names who runs the relay: "Meter Sync"
 * for the built-in one, and for any other the owner of that address.
 *
 * It is on the first screen AND on the create screen, because an invite link
 * lands straight on the second and must not skip it.
 */
export default function PrivacyNotice({ relay }) {
  const operator = operatorOf(relay);
  return (
    <div className="rl-notice" role="region" aria-label="How Meter Sync handles your data">
      <p className="rl-notice-title">How your data is handled</p>
      <ul>
        <li>
          Everything is encrypted on this device before it is sent. {operator} cannot
          read your projects, clients, amounts or device names, and never has your key.
        </li>
        <li>
          {operator} can see that your account exists, roughly how big it is, how many
          devices it has, when it syncs, and from which network address.
        </li>
        <li>
          If you lose every device <strong>and</strong> the recovery code, nobody can get
          your data back, {operator} included. Keep the recovery code somewhere safe, and
          keep exporting backups.
        </li>
        <li>You can delete the account from Settings at any time. Your ledger on your own devices stays.</li>
      </ul>
      <p className="rl-notice-by">Operated by: {operator}</p>
    </div>
  );
}
