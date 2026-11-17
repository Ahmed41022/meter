import { formatMoney } from "../../domain/money.js";
import { SETTING, saveSetting } from "../../storage/settings.js";
import { clockFor } from "../../domain/payouts.js";
import { dayKey } from "../../domain/objectives.js";
import PaymentAnswer, { payDay } from "../PaymentAnswer.jsx";

/**
 * The prompt for the oldest payday that has passed with no answer. It is shown
 * on every tab, so it lives with the other App-level banners rather than in the
 * Overview that owns the one-time question about past paydays.
 */
export default function PaydayNotice({ pay, state, now, answerPayment, setLaterDay }) {
  return (
    <div className="banner" role="status">
      <span className="eyebrow">A payday has passed</span>
      <p>
        {pay.overdue[0].company}&apos;s payday on {payDay(pay.overdue[0].date)}
        {" "}({formatMoney(pay.overdue[0].cents, pay.overdue[0].currency)}) has passed.
        What happened?
      </p>
      <PaymentAnswer key={pay.overdue[0].key} row={pay.overdue[0]}
                     clock={clockFor(state, pay.overdue[0], now)}
                     choices={["paid", "partial", "cancelled"]} dismissLabel="Later"
                     onSave={(fields) => answerPayment(pay.overdue[0], fields)}
                     onCancel={() => {
                       saveSetting(SETTING.PAYOUT_LATER, dayKey(now));
                       setLaterDay(dayKey(now));
                     }} />
    </div>
  );
}
