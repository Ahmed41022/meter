import { useMemo, useState } from "react";
import { paymentHistory } from "../../domain/payHistory.js";
import UpcomingPayments from "../dashboard/UpcomingPayments.jsx";
import History from "./History.jsx";

/**
 * Payments: what is coming in, and what has come.
 *
 * Upcoming payments is the Overview's panel moved here as it was, with the
 * same props and the same answering flows; the state it needs (which row is
 * open, being moved or being marked paid) moved with it, because this is the
 * only place that panel is mounted. Below it, the history, which is derived
 * from the ledger like the forecast and never stored.
 */
export default function PaymentsView({
  ledger, pay, asked, onSettleAsk, onPaid, onAnswer, onMovePayment, onMarkLines, companyRules, now,
}) {
  /** The row being given another date, and the date typed. One at a time. */
  const [moving, setMoving] = useState(null);
  /** The row whose "Already paid" form is open: a future payment marked paid
   *  asks what came, as an overdue one does. */
  const [paying, setPaying] = useState(null);
  // One payday open at a time: these are read one at a time, and all of them
  // open at once is a wall of task names.
  const [openPay, setOpenPay] = useState(null);
  const togglePay = (key) => setOpenPay((cur) => (cur === key ? null : key));

  /* Once a minute, like the forecast: a payday passes at a minute, and
     working the history out again on every tick of a running meter would
     walk the whole ledger for nothing. */
  const minute = Math.floor(now / 60_000);
  const { projects, sessions, earnings, companies, payouts } = ledger;
  const history = useMemo(
    () => paymentHistory({ projects, sessions, earnings, companies, payouts }, now),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above: the minute, not the second
    [projects, sessions, earnings, companies, payouts, minute],
  );

  return (
    <div className="pay-tab">
      {/* Hidden when printing, with everything else that is not the statement. */}
      <div className="print-hide">
        {(pay.due.length > 0 || pay.waiting.length > 0 || pay.overdue.length > 0) && (
          <UpcomingPayments
            pay={pay} asked={asked} onSettleAsk={onSettleAsk} onPaid={onPaid} onAnswer={onAnswer}
            onMovePayment={onMovePayment} onMarkLines={onMarkLines} companyRules={companyRules}
            now={now} openPay={openPay}
            togglePay={togglePay} moving={moving} setMoving={setMoving} paying={paying}
            setPaying={setPaying}
          />
        )}
      </div>
      <History history={history} pay={pay} now={now} />
    </div>
  );
}
