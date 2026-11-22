import { companyStatement } from "../../domain/payHistory.js";
import { paymentsCsv } from "../../domain/paymentsCsv.js";
import { payDay } from "../PaymentAnswer.jsx";
import Actions from "./Actions.jsx";
import HistoryRow from "./HistoryRow.jsx";
import StatementSheet from "./StatementSheet.jsx";
import Totals from "./Totals.jsx";

/**
 * One company's account of itself: a card per currency, then its paydays. The
 * picker lists the companies that appear in the history, which are the only
 * ones there is anything to say about.
 */
export default function ByCompany({
  history, pay, companies, client, onClient, range, label, open, toggle, now, onCsv,
}) {
  const statement = companyStatement(history, client, range, pay);
  // Coming first, soonest first, then what has happened, newest first.
  const rows = [...statement.coming, ...statement.paydays];
  // The picker's own spelling: the statement's folded key is lower case.
  const name = companies.find((c) => c.client === client)?.company ?? statement.company;
  return (
    <>
      <div className="print-hide">
      <div className="stmt-pick">
        <select className="inp" aria-label="Company" value={client}
                onChange={(e) => onClient(e.target.value)}>
          {companies.map((c) => <option key={c.client} value={c.client}>{c.company}</option>)}
        </select>
        <Actions onPrint={() => window.print()} onCsv={() => onCsv(`payments-${name.replace(/[^a-z0-9]+/gi, "-")}`, paymentsCsv(rows))}
                 disabled={rows.length === 0} printLabel="Print statement" />
      </div>
      <Totals totals={statement.totals} />
      {rows.length === 0 && (
        <p className="hint" role="status">
          Nothing from {name || "this company"} in this period.
        </p>
      )}
      {rows.length > 0 && (
        <div className="panel">
          {rows.map((row) => (
            <div className={row.status === "coming" ? "coming-day" : "hist-day"} key={row.key}>
              <div className={row.status === "coming" ? "coming-date" : "hist-date"}>
                {row.status === "coming" ? `Coming · ${payDay(row.date)}` : payDay(row.date)}
              </div>
              <HistoryRow row={row} open={open.has(row.key)} onToggle={() => toggle(row.key)}
                          showCompany={false} />
            </div>
          ))}
        </div>
      )}
      </div>
      <StatementSheet title={`Statement — ${name} — ${label}`} rows={rows}
                      totals={statement.totals} now={now} />
    </>
  );
}
