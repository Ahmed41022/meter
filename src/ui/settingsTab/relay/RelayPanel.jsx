import { useEffect, useState } from "react";
import { cryptoAvailable } from "../../../sync/crypto.js";
import { acknowledgeRecovery, recoveryPending } from "../../../sync/relayActions.js";
import { DEFAULT_RELAY } from "../../../sync/relayConfig.js";
import { statusWords } from "../../../sync/relayWords.js";
import { loadJoinSession } from "../../../sync/vaultStore.js";
import Account from "./Account.jsx";
import AddDevice from "./AddDevice.jsx";
import CreateAccount from "./CreateAccount.jsx";
import JoinDevice from "./JoinDevice.jsx";
import NotSetUp from "./NotSetUp.jsx";
import RecoveryCode from "./RecoveryCode.jsx";
import { Problem, useTick } from "./parts.jsx";

/** Screens that only make sense without an account, and those that only make
 *  sense with one. "join" is in neither: it stays up after a join to say it worked. */
const BEFORE = ["intro", "notice", "create"];
const AFTER = ["account", "add", "recovery", "recovery-view"];

/**
 * Which screen shows, from where the person has navigated and what this device
 * holds. Derived, so that leaving or joining moves the screen on its own without
 * every handler having to remember to.
 */
export const screenFor = (view, active) => {
  if (active) return BEFORE.includes(view) ? "account" : view;
  return AFTER.includes(view) ? "intro" : view;
};

/** Where the panel opens: an unconfirmed recovery code first, a half-done join
 *  or create where it stopped, and a link's invite or join code on its screen. */
const firstView = ({ active, vault, intent }) => {
  if (active) return recoveryPending() ? "recovery" : "account";
  if (intent?.kind === "join" || (intent?.kind === "bad" && intent.what === "join") || loadJoinSession()) return "join";
  if (intent?.kind === "invite" || vault) return "create";
  return "intro";
};

/**
 * Meter Sync in Settings: one small component per screen, chosen here. See
 * the folder's other files for what each says; this holds only the navigation
 * and the little that has to be remembered between screens (which relay a
 * create is for, whether to move focus).
 */
export default function RelayPanel({ relay, intent, onIntentUsed, hasData }) {
  const { vault, active } = relay;
  const secure = cryptoAvailable();
  const now = useTick(5_000);
  const [view, setView] = useState(() => firstView({ active, vault, intent }));
  // Focus moves to a new screen's heading only after the person has navigated:
  // opening the Settings tab must not steal it.
  const [moved, setMoved] = useState(false);
  const [target, setTarget] = useState(() => ({
    relay: intent?.kind === "invite" && intent.relay ? intent.relay : vault?.relay ?? DEFAULT_RELAY,
    open: false,
  }));
  // What a link said that this device cannot act on: unusable, or for something
  // the account already on this device would have to be left first.
  const [notice] = useState(() => {
    if (intent?.kind === "bad") return intent.message;
    if (active && intent?.kind === "join") return "A join link was opened, but this device already has an account, so it cannot join another. To join that one, choose Leave on this device first, then open the link again.";
    if (active && intent?.kind === "invite") return "An invite link was opened, but this device already has an account. To use the invite, choose Leave on this device first, then open the link again.";
    return "";
  });
  // Taken: a later visit to Settings starts fresh instead of replaying the link.
  useEffect(() => { onIntentUsed?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, on first showing
  const go = (next) => { setMoved(true); setView(next); };
  const screen = screenFor(view, active);

  const words = active ? statusWords(relay.status, now) : null;

  return (
    <div className="sec">
      <div className="sec-head">
        <span className="eyebrow">Meter Sync</span>
        <span className="eyebrow">{words ? words.label : "Not set up"}</span>
      </div>
      <div className="panel rl">
        {notice && <Problem>{notice}</Problem>}

        {screen === "intro" && (
          <>
            <p className="sync-intro">
              Meter Sync keeps this ledger on your phone, computer and browser, end-to-end encrypted, so
              nothing but you can read it. It is replacing Google Drive for syncing.
            </p>
            <div className="controls">
              <button type="button" className="btn primary" onClick={() => go("notice")}>Set up Meter Sync</button>
            </div>
          </>
        )}

        {screen === "notice" && (
          <NotSetUp focus={moved} secure={secure}
                    onCreate={() => { setTarget({ relay: DEFAULT_RELAY, open: false }); go("create"); }}
                    onJoin={() => go("join")}
                    onOwnRelay={(url, info) => { setTarget({ relay: url, open: Boolean(info.open) }); go("create"); }}
                    onBack={() => go("intro")} />
        )}

        {screen === "create" && (
          <CreateAccount focus={moved} relay={vault && !active ? vault.relay : target.relay} open={target.open}
                         initialInvite={intent?.kind === "invite" ? intent.code : vault?.invite ?? ""}
                         resume={Boolean(vault) && !active}
                         onDone={() => { relay.reload(); go("recovery"); }}
                         onBack={() => go(vault && !active ? "intro" : "notice")} />
        )}

        {screen === "recovery" && vault && (
          <RecoveryCode vault={vault} focus={moved} required={recoveryPending()}
                        onDone={() => { acknowledgeRecovery(); go("account"); }} />
        )}
        {screen === "recovery-view" && vault && (
          <RecoveryCode vault={vault} focus={moved} onDone={() => go("account")} />
        )}

        {screen === "account" && vault && (
          <Account relay={relay} focus={moved} onAdd={() => go("add")} onShowRecovery={() => go("recovery-view")} />
        )}

        {screen === "add" && vault && (
          <AddDevice relay={relay} focus={moved} onClose={() => go("account")} />
        )}

        {screen === "join" && (
          <JoinDevice focus={moved} hasData={hasData}
                      initialCode={intent?.kind === "join" ? intent.text : ""}
                      onJoined={() => relay.reload()}
                      onBack={() => go(active ? "account" : "notice")} />
        )}
      </div>
    </div>
  );
}
