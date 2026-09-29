import { formatMoney, formatShortDuration } from "../domain/money.js";
import { taskPay } from "../domain/earnings.js";
import { UNASSIGNED } from "../domain/tasks.js";
import { TASK } from "../domain/taskState.js";

/**
 * What one task is owed, in the words that matter once there are forty of them.
 *
 * "Not claimed" is the load-bearing one. On work paid on acceptance the
 * absence of a line is not a zero — it is a task that is done and not yet
 * credited, and it looks exactly like a task worth nothing unless something
 * says otherwise.
 *
 * A shared reward is named, never divided. Fifty tasks covered by one payment
 * are each paid for; none of them is worth a fiftieth of it.
 */
function PayLine({ pay, currency }) {
  if (!pay.claimed && !pay.cancelled) {
    return <div className="trow-sub unclaimed">not claimed</div>;
  }
  const parts = [];
  if (pay.settled) parts.push(`${formatMoney(pay.settled, currency)} paid`);
  if (pay.pending) parts.push(`${formatMoney(pay.pending, currency)} pending`);
  if (pay.shared) parts.push(`in ${pay.shared} shared reward${pay.shared === 1 ? "" : "s"}`);
  if (pay.cancelled) parts.push(`${pay.cancelled} rejected`);
  return (
    <div className={"trow-sub" + (pay.pending && !pay.settled ? " owed" : " earned")}>
      {parts.join(" · ")}
    </div>
  );
}

/**
 * What a task's state is called on screen.
 *
 * "Rejected" rather than "cancelled": cancelled is how the money is stored,
 * because that is what happens to it, but what happened to the WORK is that
 * somebody turned it down, and the row is about the work.
 */
const STATE_WORD = {
  [TASK.SUBMITTED]: "submitted",
  [TASK.ACCEPTED]: "accepted",
  [TASK.CANCELLED]: "rejected",
};

/** Time and money per task. Idle sits on its own line, never added into the
 *  earned column. An off-clock project has no earned column at all — a row of
 *  zeroes would only invite the reader to treat them as a figure. */
export default function TaskBreakdown({
  rows, currency, active, onPick, onEdit, offClock, piece = false,
  earnings = null, selected = null, onToggleSelect,
}) {
  // On work paid per accepted item the hours earn nothing by the hour, so the
  // earned column is a row of zeroes sitting next to the money that was
  // actually paid — the one place a reader would take it for a figure.
  const money = !offClock && !piece;
  // Whether a batch can be acted on is the caller's question, not this one's.
  // "No task" is never selectable: it is a bucket, not a thing anyone accepted.
  const picking = !!onToggleSelect && !!selected;
  return (
    <div className="panel">
      {rows.map((r) => (
        <div key={r.taskId ?? UNASSIGNED}
             className={"trow" + (r.taskId ? "" : " none")
               + (picking ? " pick" : "")
               + (onPick ? " clickable" : "")
               + (selected?.includes(r.taskId) ? " sel" : "")
               + ((active && active === (r.taskId ?? UNASSIGNED)) ? " on" : "")}
             onClick={() => onPick?.(r.taskId ?? UNASSIGNED)}>
          {picking && (r.taskId ? (
            <input type="checkbox" className="row-check" checked={selected.includes(r.taskId)}
                   aria-label={`Select ${r.label}`}
                   onClick={(e) => e.stopPropagation()}
                   onChange={() => onToggleSelect(r.taskId)} />
          ) : <span className="row-check" aria-hidden="true" />)}
          <div>
            <div className="trow-label">
              {r.label}
              {r.state && (
                <span className={"tag state-" + r.state}>{STATE_WORD[r.state]}</span>
              )}
            </div>
            <div className="trow-sub">
              {offClock
                ? `${r.sessions} entr${r.sessions === 1 ? "y" : "ies"}`
                : `${r.sessions} session${r.sessions === 1 ? "" : "s"}`}
              {!offClock && r.rate != null
              && ` · priced at ${formatMoney(Math.round(r.rate * 100), currency)}/hr`}
              {onEdit && r.taskId && (
                <>
                  {" · "}
                  <button className="linkish" onClick={(e) => { e.stopPropagation(); onEdit(r.taskId); }}>
                    edit
                  </button>
                </>
              )}
            </div>
            {r.note && <div className="trow-note">{r.note}</div>}
            {earnings && r.taskId && (
              <PayLine pay={taskPay(earnings, r.taskId)} currency={currency} />
            )}
            {r.idleMs > 0 && (
              <div className="trow-sub idle">
                {formatShortDuration(r.idleMs)} idle
                {!offClock && ` · ${formatMoney(r.idleCents, currency)} unearned`}
              </div>
            )}
          </div>
          <span className="trow-time">
            {r.billedMs > 0 ? formatShortDuration(r.billedMs) : "—"}
          </span>
          {money && <span className="trow-amt">{formatMoney(r.billedCents, currency)}</span>}
        </div>
      ))}
    </div>
  );
}
