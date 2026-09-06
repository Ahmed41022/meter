import { formatMoney, formatShortDuration } from "../domain/money.js";

/** Time and money per task. Idle sits on its own line, never added into the
 *  earned column. */
export default function TaskBreakdown({ rows, currency }) {
  return (
    <div className="panel">
      {rows.map((r) => (
        <div className={"trow" + (r.taskId ? "" : " none")} key={r.taskId ?? "none"}>
          <div>
            <div className="trow-label">{r.label}</div>
            <div className="trow-sub">
              {r.sessions} session{r.sessions === 1 ? "" : "s"}
            </div>
            {r.idleMs > 0 && (
              <div className="trow-sub idle">
                {formatShortDuration(r.idleMs)} idle · {formatMoney(r.idleCents, currency)} unearned
              </div>
            )}
          </div>
          <span className="trow-time">
            {r.billedMs > 0 ? formatShortDuration(r.billedMs) : "—"}
          </span>
          <span className="trow-amt">{formatMoney(r.billedCents, currency)}</span>
        </div>
      ))}
    </div>
  );
}
