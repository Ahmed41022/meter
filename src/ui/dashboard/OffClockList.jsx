import { formatShortDuration } from "../../domain/money.js";

/** What was tracked off the clock in the period, kept out of work and earnings. */
export default function OffClockList({ offRows, onOpenProject }) {
  const offMs = offRows.reduce((a, r) => a + r.billedMs + r.idleMs, 0);

  return (
    <div className="sec">
      <div className="sec-head">
        <span className="eyebrow">Off the clock</span>
        <span className="eyebrow">{formatShortDuration(offMs)}</span>
      </div>
      <div className="panel">
        <div className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
          Tracked, but counted as neither work nor earnings.
        </div>
        {offRows.map(({ project, billedMs, idleMs }) => {
          const total = billedMs + idleMs;
          return (
            <button className="prow off" key={project.id}
                    onClick={() => onOpenProject(project.id)}>
              <span className="prow-top">
                <span className="prow-name">{project.name}</span>
                <span className="prow-amt">{formatShortDuration(total)}</span>
              </span>
              <span className="prow-bar">
                <span className="prow-off" style={{ width: `${(total / offMs) * 100}%` }} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
