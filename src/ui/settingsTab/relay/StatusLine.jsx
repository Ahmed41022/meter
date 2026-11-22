import { secondsAgo, statusWords } from "../../../sync/relayWords.js";

/** A presence entry stops being shown after this long without word. Two missed
 *  minutes means the meter's device is gone, not slow. */
export const PRESENCE_FRESH_MS = 150_000;

/**
 * The sync status in words, and whether live updates are on. `role="status"`
 * so a change (offline, removed, deleted) is announced.
 */
export default function StatusLine({ status, socketState, now }) {
  const words = statusWords(status, now);
  const live = socketState === "connected";
  return (
    <div className={`rl-status tone-${words.tone}`}>
      <p className="sync-read" role="status">
        <strong>{words.label}.</strong> {words.detail}
      </p>
      {status.state === "ok" && (
        <p className="sync-note">
          {live
            ? "Live updates are on: changes from your other devices arrive within moments."
            : "Live updates are off here, so Meter checks when you open it, after your edits, and every couple of minutes while a meter runs."}
          {status.pulled > 0 && " Brought changes in."}
          {status.raced && " Another device wrote at the same time; both sets of changes were kept."}
        </p>
      )}
    </div>
  );
}

/** "Running on <device>, seen 12 s ago", one line per device with a meter going.
 *  Shown only here: presence is never in the ledger. `devices` supplies names. */
export function PresenceLines({ presence, devices, selfId, now }) {
  const rows = Object.entries(presence)
    .filter(([id, p]) => id !== selfId && now - p.at < PRESENCE_FRESH_MS)
    .map(([id, p]) => ({ id, at: p.at, name: devices.find((d) => d.id === id)?.name ?? "another device" }));
  if (!rows.length) return null;
  return (
    <ul className="rl-presence" aria-label="Meters running on your other devices">
      {rows.map((r) => (
        <li key={r.id}>Running on {r.name}, seen {secondsAgo(r.at, now)}</li>
      ))}
    </ul>
  );
}
