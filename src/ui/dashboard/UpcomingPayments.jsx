import { formatMoney } from "../../domain/money.js";
import { currenciesByValue } from "../../domain/performance.js";
import { clockFor } from "../../domain/payouts.js";
import PaymentAnswer, { payDay } from "../PaymentAnswer.jsx";
import PayLines from "./PayLines.jsx";
import { useHelp } from "../HelpTip.jsx";
import { useMoney } from "../useMoney.js";
import { moneyText, rateNote } from "../fxMoney.js";

/** The task-less money on a row, counted by kind and named in lower case. */
const extraParts = (row) => {
  const counts = new Map();
  for (const line of row.tasks) {
    if (line.kind === "extra") counts.set(line.part, (counts.get(line.part) ?? 0) + 1);
  }
  const names = { bonus: "bonus", adjust: "adjustment", piece: "per-item payment" };
  return [...counts].map(([part, n]) => `${n} ${names[part] ?? "payment"}${n === 1 ? "" : "s"}`);
};

/**
 * The Upcoming payments panel: the overdue, confirmed and waiting paydays, the
 * one-time question about past ones, and each row's tasks and answer forms.
 * Which row is open, being moved or being marked paid stays with the view,
 * because this panel is only mounted while there is a payment to show.
 */
export default function UpcomingPayments({
  pay, asked, onSettleAsk, onPaid, onAnswer, onMovePayment, onMarkLines, companyRules, now, openPay,
  togglePay, moving, setMoving, paying, setPaying,
}) {
  /* What is coming in, and when, is worked out once a minute by the App, which
     needs it for the notice that follows a passed payday on every tab. */
  /** Never summed across currencies — 100 EGP and 100 USD are not 200. */
  const fx = useMoney();
  const help = useHelp("How upcoming payments work");
  /** The display currency, when there is one, applies to what is SHOWN on a
   *  heading or a row. The rows themselves keep their own cents and currency:
   *  answering a payment reads those, never anything converted. */
  const figuresOf = (rows) =>
    rows.reduce((acc, r) => ({ ...acc, [r.currency]: (acc[r.currency] ?? 0) + r.cents }), {});
  const totalOf = (rows) => moneyText(fx.show(figuresOf(rows), currenciesByValue));
  const dateOf = (rows) => rateNote(fx.show(figuresOf(rows), currenciesByValue)) || undefined;
  const payTotal = totalOf(pay.due);
  const lateTotal = totalOf(pay.overdue);

  /*
   * Past paydays nobody has answered. A ledger with years of them, every one
   * received, would open on a wall of "overdue", so the first time there are
   * any the owner is asked once whether to mark the lot as received. Either
   * answer is remembered on this device and the question does not come back.
   */
  const settleAsk = onSettleAsk;

  /** A row's client clock: today on it, and the next payday from now. */
  const clientClock = (row) => clockFor({ companies: companyRules }, row, now);
  /** What a payday row is made of: its tasks, and any reward shared across a
   *  batch, which is one payment however many tasks it names. */
  const payParts = (row, soft) => [
    row.items > 0 && (soft
      ? `${row.items} waiting on a review`
      : `${row.items} task${row.items === 1 ? "" : "s"}`),
    row.rewards > 0 && `${row.rewards} shared reward${row.rewards === 1 ? "" : "s"}`,
    // Money named for no task, said by what it is: "1 bonus", "2 adjustments".
    ...extraParts(row),
  ].filter(Boolean).join(" · ");

  return (
    <div className="sec">
      <div className="sec-head">
        <span className="sec-title">
          <span className="eyebrow">Upcoming payments</span>
          {help.button}
        </span>
        {/* Only the answered money, and it says so. The rows below carry
            dates of their own now, so a bare figure here would read as
            their total and be short by everything still under review. */}
        <span className="eyebrow" title={dateOf([...pay.overdue, ...pay.due])}>
          {pay.overdue.length > 0 && `${lateTotal} overdue · `}
          {pay.due.length === 0 ? "nothing confirmed yet" : `${payTotal} confirmed`}
        </span>
      </div>
      {/* How the list is worked out, behind the "?" so it is there when
          wanted and not a wall of text under every payday. */}
      {help.panel(
        <ul>
          <li>Dates come from each client&apos;s payday, set in a project&apos;s settings.</li>
          <li>
            Paid as worked: a task is paid in the run for the period it was handed in.
            Paid once accepted: in the run for the period its answer fell in, so one
            accepted after its period shut rides the next run. Work nobody has reviewed
            has no date, only the soonest it could arrive.
          </li>
          <li>
            A payday that has passed stays listed as overdue until you say it was paid
            or give it a new date.
          </li>
          <li>
            A reward shared by several tasks is paid with the last of them, and waits
            until then. A bonus tied to no task rides the next payday after it was
            added, unless a payday was chosen for it or it is marked paid.
          </li>
          <li>
            A deduction, such as a negative adjustment, comes off the payday it
            belongs to, so each figure is what will actually land. A payday that nets
            to nothing is not listed here; once it has passed, it appears in the
            history with its lines.
          </li>
          <li>
            Open a row to see its lines. Tick some to mark just those paid, or move
            them to another day, when a client pays only part of a payday.
          </li>
        </ul>,
      )}
      <div className="panel">
        {/* Here rather than with the app's own notices: those say something
            is wrong with the app or the data, and this is a question about
            the list it sits on, which is where it can be read and acted on. */}
        {pay.overdue.length > 0 && !asked && (
          <div className="banner" role="status" style={{ marginBottom: 14 }}>
            <span className="eyebrow">Past paydays</span>
            <p>
              {pay.overdue.length} past payday{pay.overdue.length === 1 ? " has" : "s have"} no
              answer. Mark {pay.overdue.length === 1 ? "it" : "them all"} as received?
            </p>
            <div className="controls">
              <button className="btn primary"
                      onClick={() => { onPaid(pay.overdue); settleAsk(); }}>
                Mark all received
              </button>
              <button className="btn ghost" onClick={settleAsk}>Keep them listed</button>
            </div>
          </div>
        )}
        {/* Every row opens. A payday is a number you are about to plan
            around, and "which tasks make that up, and which of them
            somebody still has to approve" is the first thing you want to
            know about one — especially when the two kinds of row carry
            dates that look alike. */}
        {[...pay.overdue.map((r) => [r, false, true]), ...pay.due.map((r) => [r, false, false]),
          ...pay.waiting.map((r) => [r, true, false])]
          .map(([row, soft, late]) => (
            <div className="payrow" key={row.key}>
              <div className={"trow clickable" + (openPay === row.key ? " on" : "")}
                   role="button" tabIndex={0}
                   aria-expanded={openPay === row.key}
                   onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") togglePay(row.key); }}
                   onClick={() => togglePay(row.key)}>
                <div>
                  <div className="trow-label">
                    {soft ? `Not before ${payDay(row.date)}`
                      : late ? `Overdue · ${payDay(row.date)}` : payDay(row.date)}
                  </div>
                  <div className={"trow-sub" + (soft ? " owed" : late ? " late" : "")}>
                    {row.company || "No company"} · {payParts(row, soft)}
                    {row.partial && ` · partly received: ${formatMoney(row.partial.receivedCents, row.currency)} of ${formatMoney(row.partial.expectedCents, row.currency)}`}
                    {row.moved && ` · moved from ${payDay(row.scheduled)}`}
                  </div>
                </div>
                <span className="trow-amt" title={dateOf([row])}>{totalOf([row])}</span>
              </div>
              {openPay === row.key && (
                <div className="paylist">
                  {/* Each line can be picked and marked paid or moved on its
                      own, on every kind of row: a client can pay some of a
                      payday and hold the rest back. Keyed by the row, so
                      what was picked goes when another row opens. */}
                  <PayLines key={row.key} row={row} clock={clientClock(row)} onMarkLines={onMarkLines} />
                  {/* What was said about the payment as a whole, not about
                      one line of it: a payout either came or did not. Not
                      on money still waiting on a review, which has no date
                      to have moved or arrived on. */}
                  {!soft && late && (
                    <PaymentAnswer row={row} clock={clientClock(row)}
                                   choices={["paid", "partial", "cancelled"]}
                                   onSave={(fields) => onAnswer(row, fields)} />
                  )}
                  {!soft && !late && paying === row.key && (
                    <PaymentAnswer row={row} clock={clientClock(row)} choices={["paid"]}
                                   onSave={(fields) => { onAnswer(row, fields); setPaying(null); }}
                                   onCancel={() => setPaying(null)} />
                  )}
                  {!soft && !late && paying !== row.key && (
                    <div className="payact">
                      <button className="btn ghost"
                              onClick={() => { setMoving(null); setPaying(row.key); }}>Already paid</button>
                      {moving?.key === row.key ? (() => {
                        const from = clientClock(row).today;
                        const ok = moving.date >= from;
                        return (
                          <>
                            <input className="inp" type="date" aria-label="New payday" min={from}
                                   value={moving.date}
                                   onChange={(e) => setMoving({ ...moving, date: e.target.value })} />
                            <button className="btn primary" disabled={!ok}
                                    onClick={() => { onMovePayment(row, moving.date); setMoving(null); }}>
                              Save
                            </button>
                            <button className="btn ghost" onClick={() => setMoving(null)}>Cancel</button>
                            {!ok && (
                              <span className="hint warn" role="alert">Pick today or a later day.</span>
                            )}
                          </>
                        );
                      })() : (
                        <button className="btn ghost"
                                onClick={() => setMoving({ key: row.key, date: clientClock(row).next })}>
                          Change date
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
