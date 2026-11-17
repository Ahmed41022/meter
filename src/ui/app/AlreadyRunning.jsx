import { Notice } from "../parts.jsx";

/**
 * The warning that a session was ticking moments ago, with its way to carry on
 * regardless. Set at startup, and again by a merge that finds two meters going.
 */
export default function AlreadyRunning({ setConflict }) {
  return (
    <>
      <Notice title="Already running">
        A session was ticking seconds ago. If you have Meter open in another tab, close one —
        two tabs writing the same record will overwrite each other.
      </Notice>
      <div className="controls" style={{ marginTop: -10, marginBottom: 20 }}>
        <button className="btn ghost" onClick={() => setConflict(false)}>This tab only</button>
      </div>
    </>
  );
}
