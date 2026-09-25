/**
 * Keeping two devices on the same ledger, through the user's own Google Drive.
 *
 * The client id is asked for rather than built in, because it belongs to their
 * Google Cloud project and is tied to their authorised origin. It is not a
 * secret — a page cannot keep one — it only names the app.
 */
const STATE_WORDS = {
  idle: "Not syncing",
  syncing: "Syncing…",
  ok: "Synced",
  error: "Sync failed",
};

const ago = (at, now) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

/** What the last round actually did, as a phrase rather than a status code. */
function Outcome({ status, now, signedIn }) {
  if (status.state === "error") return <span className="sync-bad">{status.error}</span>;
  if (!status.at) {
    return signedIn ? "Signed in. Nothing synced yet." : "Sign in to start syncing.";
  }
  return (
    <>
      Last synced {ago(status.at, now)}
      {status.created && " · created the file in Drive"}
      {status.pushed && !status.created && " · sent your changes"}
      {status.pulled && " · brought changes in"}
      {!status.pushed && !status.pulled && !status.created && " · nothing to do"}
    </>
  );
}

export default function Sync({
  clientId, draft, onDraft, onSaveClientId, onForget,
  status, now, onSync, onSignOut, signedIn, canSignIn = true, origin = "",
}) {
  const configured = Boolean(clientId);
  return (
    <div className="sec">
      <div className="sec-head">
        <span className="eyebrow">Sync</span>
        <span className="eyebrow">
          {canSignIn ? (STATE_WORDS[status.state] ?? "") : "Unavailable here"}
        </span>
      </div>
      <div className="panel">
        {!canSignIn ? (
          // A page opened from disk has no origin Google will authorise, so this
          // copy cannot sign in however it is configured. Saying so is better
          // than a button whose only possible outcome is an error page.
          <>
            <p className="sync-intro">
              This copy runs from a file on disk, and Google only signs in pages served
              from a web address. Sync works in the browser version; open that and sign
              in there.
            </p>
            <p className="sync-intro last">
              To move this ledger across meanwhile: Export a backup here, then Restore it
              wherever you want it.
            </p>
          </>
        ) : !configured ? (
          <>
            <p className="sync-intro">
              Sync keeps this ledger in a hidden folder in your own Google Drive, so another
              device can pick it up. Nothing passes through anyone else’s server, and the
              permission it asks for cannot see the rest of your Drive.
            </p>
            <p className="sync-intro">
              It needs a client ID from a Google Cloud project of your own: enable the Drive
              API, add the address below as an authorised JavaScript origin, and paste the ID
              here. Google matches that origin exactly, so each place you run Meter needs its
              own entry — they can all share one client ID.
            </p>
            {origin && (
              <div className="sync-origin">
                <span className="eyebrow">Authorise this origin</span>
                <code className="origin">{origin}</code>
              </div>
            )}
            <label className="field">
              <span className="eyebrow">Google client ID</span>
              <input className="inp" value={draft} placeholder="…apps.googleusercontent.com"
                     onChange={(e) => onDraft(e.target.value)}
                     onKeyDown={(e) => e.key === "Enter" && onSaveClientId()} />
            </label>
            <div className="controls">
              <button className="btn primary" disabled={!draft.trim()} onClick={onSaveClientId}>
                Save
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="sync-read">
              <Outcome status={status} now={now} signedIn={signedIn} />
            </p>
            {status.raced && (
              <p className="sync-note">
                Another device had written since this one last looked. Both sets of changes
                were kept.
              </p>
            )}
            {/* One action here, not three abreast. Signing out and changing the
                client ID are each done once and then never again, and giving
                them the same weight as the button you actually press made the
                panel read as a row of equally likely choices. */}
            <div className="controls">
              <button className="btn primary" disabled={status.state === "syncing"}
                      onClick={onSync}>
                {signedIn ? "Sync now" : "Sign in with Google"}
              </button>
            </div>
            <div className="sync-more">
              {signedIn && (
                <>
                  <button className="linkish" onClick={onSignOut}>Sign out</button>
                  <span className="sync-sep" aria-hidden="true">·</span>
                </>
              )}
              <button className="linkish" onClick={onForget}>Change client ID</button>
            </div>
            <p className="sync-foot">
              Syncing merges rather than replaces: a record edited on two devices keeps the
              later edit, and nothing either device recorded is dropped.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
