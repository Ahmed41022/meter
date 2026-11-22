import { formatMoney } from "../../domain/money.js";
import { historyByPayday, totalsOf } from "../../domain/payHistory.js";
import { payDay } from "../PaymentAnswer.jsx";
import HistoryRow from "./HistoryRow.jsx";
import StatementSheet from "./StatementSheet.jsx";
import Totals from "./Totals.jsx";
import Actions from "./Actions.jsx";
import { monthName } from "./words.js";
import { paymentsCsv } from "../../domain/paymentsCsv.js";

/** A month's subtotals, one currency at a time: what came and what is still to. */
const subtotal = (totals) => Object.keys(totals).sort()
  .map((cur) => `${formatMoney(totals[cur].received, cur)} received, ${formatMoney(totals[cur].outstanding, cur)} outstanding`)
  .join(" · ");

/** A set of rows' still-to-come money, per currency. */
const comingTotal = (rows) => Object.entries(totalsOf(rows)).sort(([a], [b]) => a.localeCompare(b))
  .map(([cur, t]) => formatMoney(t.coming, cur)).join(" · ");

/**
 * The history by payday: first what is still coming, soonest first, then the
 * days newest first under a header for each month, with what came and what is
 * still owed in that month, per currency. The coming paydays are read-only:
 * answering them is Upcoming payments' job, a little above.
 */
export default function ByPayday({ history, pay, range, label, open, toggle, now, onCsv }) {
  const { days, months, coming, totals } = historyByPayday(history, range, pay);
  const past = days.flatMap((d) => d.rows);
  // Coming first, as on screen, then what has happened.
  const rows = [...coming, ...past];
  const ahead = [...new Set(coming.map((r) => r.date))];
  return (
    <>
      <div className="print-hide">
      <Actions onPrint={() => window.print()} onCsv={() => onCsv("payments", paymentsCsv(rows))}
               disabled={rows.length === 0} printLabel="Print" />
      <Totals totals={totals} />
      {coming.length > 0 && (
        <div className="hist-coming">
          <div className="sec-head">
            <span className="eyebrow">Coming</span>
            <span className="eyebrow hist-month-total">{comingTotal(coming)}</span>
          </div>
          <div className="panel">
            {ahead.map((date) => (
              <div className="coming-day" key={date}>
                <div className="coming-date">{payDay(date)}</div>
                {coming.filter((r) => r.date === date).map((row) => (
                  <HistoryRow key={row.key} row={row} open={open.has(row.key)}
                              onToggle={() => toggle(row.key)} />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      {rows.length === 0 && (
        <p className="hint" role="status">
          No payments in this period yet. Paydays appear here once they have passed or been answered.
        </p>
      )}
      {months.map((m) => (
        <div className="hist-month" key={m.month}>
          <div className="sec-head">
            <span className="eyebrow">{monthName(m.month)}</span>
            <span className="eyebrow hist-month-total">{subtotal(m.totals)}</span>
          </div>
          <div className="panel">
            {days.filter((d) => d.date.slice(0, 7) === m.month).map((d) => (
              <div className="hist-day" key={d.date}>
                <div className="hist-date">{payDay(d.date)}</div>
                {d.rows.map((row) => (
                  <HistoryRow key={row.key} row={row} open={open.has(row.key)}
                              onToggle={() => toggle(row.key)} />
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
      </div>
      <StatementSheet title={`Statement — All companies — ${label}`} rows={rows} totals={totals} now={now} />
    </>
  );
}
