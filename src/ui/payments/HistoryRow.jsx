import { formatMoney } from "../../domain/money.js";
import { LineName } from "../dashboard/PayLines.jsx";
import { payDay } from "../PaymentAnswer.jsx";
import { STATUS_WORD, differenceWords, figuresOf, shownCents } from "./words.js";

/**
 * One payday of one company in the history: who, what became of it, what was
 * expected, what came and the difference, and, opened, the lines it is made
 * of. Read-only; answering is the Upcoming list's job. A line paid one by one
 * is marked as such and looks the same whether its day was recorded or worked
 * out, because from the owner's side the payday rules gave it that day. A
 * payday still to come is the same row, read-only, with what is expected.
 */
export default function HistoryRow({ row, open, onToggle, showCompany = true }) {
  const { expected, received } = figuresOf(row);
  const money = (c) => formatMoney(c, row.currency);
  const diff = row.status === "paid" ? differenceWords(row.differenceCents, row.currency) : "";
  const movedFrom = row.moved && row.scheduled !== row.date ? payDay(row.scheduled) : "";
  const empty = row.lines.length === 0 && row.paidLines.length === 0;
  return (
    <div className="hist-row" data-status={row.status}>
      <div className={"trow clickable" + (open ? " on" : "")} role="button" tabIndex={0}
           aria-expanded={open}
           onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onToggle(); }}
           onClick={onToggle}>
        <div>
          <div className="trow-label">
            {showCompany && <span className="hist-co">{row.company || "No company"}</span>}
            <span className={`stat stat-${row.status}`}>{STATUS_WORD[row.status]}</span>
          </div>
          <div className="trow-sub">
            <span>Expected {money(expected)}</span>
            {/* Nothing has come of a payday that has not happened yet. */}
            {row.status !== "coming" && <>{" · "}<span>Received {money(received)}</span></>}
            {diff && <>{" · "}<span className="hist-diff">{diff}</span></>}
            {movedFrom && <>{" · "}<span>moved from {movedFrom}</span></>}
          </div>
        </div>
        <span className="trow-amt">{money(shownCents(row))}</span>
      </div>
      {open && (
        <div className="paylist">
          {row.lines.map((t) => (
            <div className="payline" key={t.key}>
              <LineName t={t} />
              <span className="payline-amt">{money(t.cents)}</span>
            </div>
          ))}
          {row.paidLines.map((t, i) => (
            <div className="payline paid" key={`${t.key}|${i}`}>
              <LineName t={t} />
              {!t.worked && <span className="payline-tag">paid line by line</span>}
              <span className="payline-amt">{money(t.cents)}</span>
            </div>
          ))}
          {empty && (
            <p className="hint" style={{ margin: 0 }}>
              No lines are left behind this payment: its work was removed after it was answered.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
