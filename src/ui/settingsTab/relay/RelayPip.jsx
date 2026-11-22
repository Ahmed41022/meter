import { pipState, statusWords } from "../../../sync/relayWords.js";
import { useTick } from "./parts.jsx";

/**
 * The footer's one-line sync state for Meter Sync, in the same pip the Drive
 * sync used, so the footer looks the same whichever is running. A state the
 * button cannot fix (removed, deleted, needs the new key, needs an update) sends
 * the person to Settings instead of pretending that syncing again would help.
 */
export default function RelayPip({ status, onSync, onOpenSettings }) {
  // Its own clock: the app's ticks only while a meter runs, and "synced 3 min
  // ago" must not stand still.
  const now = useTick(15_000);
  const words = statusWords(status, now);
  const stuck = words.tone === "bad";
  return (
    <button className={`pip pip-${pipState(words.tone, status.state)}`}
            onClick={stuck ? onOpenSettings : onSync} disabled={status.state === "syncing"}
            title={words.detail}>
      <span className="pip-dot" aria-hidden="true" />
      {words.label}
    </button>
  );
}
