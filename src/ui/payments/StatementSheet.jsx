import { formatMoney } from "../../domain/money.js";
import { lineWords } from "../../domain/paymentsCsv.js";
import { payDay } from "../PaymentAnswer.jsx";
import { METRICS, metricText, useApproxTotals } from "./Totals.jsx";
import { STATUS_WORD, differenceWords, figuresOf } from "./words.js";

/**
 * The statement as it is printed. It is in the page all the time and hidden on
 * screen; the print rules hide everything else and show only this, black on
 * white. A plain list and table rather than the screen's cards, so it reads on
 * paper and each payday can be kept on one page.
 *
 * The "≈" line appears only when the screen shows it, because it comes from
 * the same figures. Every amount in the table is in its own currency.
 */
export default function StatementSheet({ title, rows, totals, now }) {
  const codes = Object.keys(totals).sort();
  const { rows: approx } = useApproxTotals(totals);
  const made = new Date(now).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  const note = approx?.find((r) => r.note)?.note;
  return (
    <section className="print-sheet" aria-label="Statement for printing">
      <h1>{title}</h1>
      <p>Generated {made}. All amounts in their own currency.</p>
      <table className="sheet-totals">
        <thead>
          <tr><th>Currency</th>{METRICS.map(([k, l]) => <th key={k}>{l}</th>)}</tr>
        </thead>
        <tbody>
          {codes.map((cur) => (
            <tr key={cur}>
              <td>{cur}</td>
              {METRICS.map(([k]) => <td key={k}>{metricText(k, totals[cur][k], cur)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {approx && (
        <p className="sheet-approx">
          All currencies, estimated: {approx.map((r) => `${r.label} ${r.text}`).join(" · ")}
          {note ? ` (${note})` : ""}
        </p>
      )}
      {rows.map((row) => {
        const { expected, received } = figuresOf(row);
        const money = (c) => formatMoney(c, row.currency);
        const diff = row.status === "paid" ? differenceWords(row.differenceCents, row.currency) : "";
        const lines = [...row.lines.map((l) => [l, false]), ...row.paidLines.map((l) => [l, true])];
        return (
          <div className="sheet-day" key={row.key}>
            <h3>{payDay(row.date)} · {row.company || "No company"} · {STATUS_WORD[row.status]}</h3>
            <p>
              Expected {money(expected)} · Received {money(received)}
              {diff ? ` · ${diff}` : ""}
              {row.moved && row.scheduled !== row.date ? ` · moved from ${payDay(row.scheduled)}` : ""}
            </p>
            {lines.length > 0 && (
              <table className="sheet-lines">
                <tbody>
                  {lines.map(([l, paid], i) => {
                    const w = lineWords(l);
                    return (
                      <tr key={`${l.key}|${i}`}>
                        <td>{w.kind}{w.label ? ` · ${w.label}` : ""} · {l.project}</td>
                        <td>{paid ? "paid line by line" : ""}</td>
                        <td>{money(l.cents)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
      {rows.length === 0 && <p>Nothing to report for this period.</p>}
    </section>
  );
}
