import { formatMoney, formatShortDuration } from "../../domain/money.js";

/**
 * How much of the time at the desk was billed and how much was idle, drawn as
 * a split bar with the money the idle share did not earn.
 */
export default function TimeAtDesk({ project, share, totalMs, idleMs, idleCents }) {
  return (
    <div className="sec">
      <div className="sec-head"><span className="eyebrow">Time at the desk</span></div>
      <div className="panel">
        <div className="util">
          <span className="eyebrow">Billed</span>
          <span className="util-pct">{Math.round(share * 100)}%</span>
        </div>
        <div className="split">
          <div className="split-billed" style={{ width: `${share * 100}%` }} />
          <div className="split-idle" style={{ width: `${(1 - share) * 100}%` }} />
        </div>
        <div className="split-legend">
          <span className="legend-item">
            <span className="swatch" style={{ background: "var(--jade)" }} />
            {formatShortDuration(totalMs)} billed
          </span>
          <span className="legend-item">
            <span className="swatch" style={{ background: "var(--amber)" }} />
            {formatShortDuration(idleMs)} idle ·{" "}
            {formatMoney(idleCents, project.currency)} unearned
          </span>
        </div>
      </div>
    </div>
  );
}
