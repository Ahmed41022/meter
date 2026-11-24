import { isOffClock, statusOf } from "../../domain/projects.js";
import { allowsParallel } from "../../domain/concurrency.js";
import { paysOnAcceptance } from "../../domain/earnings.js";

/**
 * The controls below the Save bar: what a project counts as, when it pays and
 * its status. Each is one click with an immediate effect, which is why they sit
 * together and apart from the typed, staged half of the panel.
 */
export default function ProjectState({ project, onPatch, onSetStatus }) {
  return (
    <>
      <div className="sec-head" style={{ marginTop: 22 }}>
        <span className="eyebrow">Counts as</span>
      </div>
      {/* One choice between two states, so a segmented control — `.btn` grows
          to fill its row, which turned a toggle into two slabs the size of
          Save buttons. */}
      <div className="modes" role="tablist" aria-label="How this project counts">
        <button role="tab" aria-selected={!isOffClock(project)}
                className={"seg-btn" + (isOffClock(project) ? "" : " on")}
                onClick={() => onPatch({ offClock: false })}>
          Paid work
        </button>
        <button role="tab" aria-selected={isOffClock(project)}
                className={"seg-btn" + (isOffClock(project) ? " on" : "")}
                onClick={() => onPatch({ offClock: true })}>
          Off the clock
        </button>
      </div>
      <div className="hint">
        Off the clock is for what you track but don&apos;t work: sleep, play, time away. The hours
        stay recorded and get their own panel; they never reach an earnings figure.
      </div>

      {!isOffClock(project) && (
        <>
          <div className="sec-head" style={{ marginTop: 22 }}>
            <span className="eyebrow">When it pays</span>
          </div>
          <div className="modes" role="tablist" aria-label="When this project pays">
            <button role="tab" aria-selected={!paysOnAcceptance(project)}
                    className={"seg-btn" + (paysOnAcceptance(project) ? "" : " on")}
                    onClick={() => onPatch({ paysOnAcceptance: false })}>
              As worked
            </button>
            <button role="tab" aria-selected={paysOnAcceptance(project)}
                    className={"seg-btn" + (paysOnAcceptance(project) ? " on" : "")}
                    onClick={() => onPatch({ paysOnAcceptance: true })}>
              Once accepted
            </button>
          </div>
          <div className="hint">
            Paid once accepted means nothing counts as earned until somebody says yes. Sessions
            start out <strong>pending</strong> and stay that way when you submit, reported on
            their own line rather than in your earnings; the acceptance reward waits beside them.
            Accepting pays both. A rejection cancels both, and the hours stay on the record with
            their time and without their money.
          </div>

          <div className="sec-head" style={{ marginTop: 22 }}>
            <span className="eyebrow">Parallel tasks</span>
          </div>
          <div className="modes" role="tablist" aria-label="Whether this project's tasks can run in parallel">
            {[[false, "One at a time"], [true, "Allowed"]].map(([on, label]) => (
              <button key={label} role="tab" aria-selected={allowsParallel(project) === on}
                      className={"seg-btn" + (allowsParallel(project) === on ? " on" : "")}
                      onClick={() => onPatch({ parallelTasks: on })}>
                {label}
              </button>
            ))}
          </div>
          <div className="hint">
            Allowed is for work whose clock keeps ticking while something else does the waiting.
            Several of its tasks can run at once, and it can run beside other projects; whatever
            is not your main task says <strong>working in background</strong>. Each task&apos;s
            time counts in full, so the hours can add up to more than the clock on the wall.
          </div>
        </>
      )}

      <div className="sec-head" style={{ marginTop: 22 }}>
        <span className="eyebrow">Status</span>
      </div>
      {/* Three states, one control — two checkboxes could express "paused and
          done", which is not a thing a project can be. */}
      <div className="modes" role="tablist" aria-label="Project status">
        {[["active", "Running"], ["paused", "Paused"], ["done", "Done"]].map(([key, label]) => (
          <button key={key} role="tab" aria-selected={statusOf(project) === key}
                  className={"seg-btn" + (statusOf(project) === key ? " on" : "")}
                  onClick={() => onSetStatus(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="hint">
        {statusOf(project) === "done"
          ? "Finished. It has left the Targets panel and won't take new time, and its page now "
            + "reports what it came to. Every hour it recorded is still in your history."
          : statusOf(project) === "paused"
            ? "On hold. It stays where it is but has left the Targets panel and won't take new "
              + "time — set it running again when you come back to it."
            : "Paused keeps it in place for work that has gone quiet. Done files it away with a "
              + "closing summary. Both leave Targets and take no new time, though a meter already "
              + "running keeps going until you stop it; neither hides any history."}
      </div>
    </>
  );
}
