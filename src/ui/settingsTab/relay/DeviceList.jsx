import { secondsAgo } from "../../../sync/relayWords.js";

/**
 * The account's devices, names opened on this device (the relay cannot read
 * them). Removing another device needs the key to be changed for everyone left,
 * which is not built yet, so the button is shown but off, with the reason beside
 * it: hiding it would suggest there is no way to do it, and a button that did a
 * half-job would be worse.
 */
export default function DeviceList({ devices, selfId, now, problem, loading }) {
  if (problem) return <p className="rl-problem" role="alert">{problem}</p>;
  if (loading && !devices.length) return <p className="sync-note">Loading devices…</p>;
  return (
    <>
      <ul className="rl-devices">
        {devices.map((d) => (
          <li key={d.id} className="rl-device">
            <span className="rl-device-main">
              <span className="rl-device-name">{d.name ?? "Unnamed device"}</span>
              {d.id === selfId && <span className="rl-tag">this device</span>}
              <span className="rl-device-meta">
                {d.seenAt ? `Last seen ${secondsAgo(d.seenAt, now)}` : "Not seen yet"}
              </span>
            </span>
            {d.id !== selfId && (
              <button type="button" className="btn ghost rl-remove" disabled aria-describedby="rl-remove-note">Remove</button>
            )}
          </li>
        ))}
      </ul>
      {devices.length > 1 && (
        <p className="sync-note" id="rl-remove-note">
          Removing a device comes in the next update, because it also has to change the key for
          everyone who stays. Until then, a lost device can be cut off by deleting the account.
        </p>
      )}
    </>
  );
}
