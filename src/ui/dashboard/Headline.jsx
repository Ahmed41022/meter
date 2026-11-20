import { Fragment } from "react";
import { formatMoney } from "../../domain/money.js";
import { useDisplay } from "../CurrencyContext.jsx";
import CurrencySwitch from "../CurrencySwitch.jsx";
import { moneyText, rateNote } from "../fxMoney.js";
import { Delta } from "../charts.jsx";
import { periodLabel, rangeNote } from "./labels.js";

/** The big figure: what the period earned, its window, and how it compares. */
export default function Headline({
  period, offset, from, to, earned, moneyDeltas, vs, pending,
}) {
  // `earned` arrives already in the order of the period's hours; the entries
  // are kept in that order as the figures, so "as earned" prints as it always did.
  const shown = useDisplay(Object.fromEntries(earned));
  const waiting = useDisplay(Object.fromEntries(pending));
  return (
    <div className="grand">
      <span className="eyebrow">{periodLabel(period, offset, from, to)} · earned</span>
      <CurrencySwitch display={shown} className="grand-switch" />
      {shown.mode === "converted"
        ? (
          <div className="grand-amt">
            {moneyText(shown)}
            {rateNote(shown) && <span className="fx-date">{rateNote(shown)}</span>}
          </div>
        )
        : earned.length === 0
        ? <div className="grand-amt">—</div>
        : earned.map(([cur, cents], i) => (
            <div className={i === 0 ? "grand-amt" : "grand-alt"} key={cur}>
              {formatMoney(cents, cur)}
            </div>
          ))}
      <div className="dash-sub">
        {rangeNote(period, from, to)}
        {/* One currency reads as it always has. Several are each named, and
            the comparison is said once, after the last of them. */}
        {moneyDeltas.length === 1 && <> · <Delta ratio={moneyDeltas[0][1]} label={vs} /></>}
        {moneyDeltas.length > 1 && moneyDeltas.map(([cur, ratio], i) => (
          <Fragment key={cur}> · <Delta ratio={ratio} unit={cur} label={vs}
                                        bare={i < moneyDeltas.length - 1} /></Fragment>
        ))}
      </div>
      {/* Money still waiting on someone else's decision. Below the headline
          rather than inside it: the figure you glance at should be what has
          actually landed, or a rejected week reads as a good one. */}
      {pending.length > 0 && (
        <div className="grand-pending">
          + {moneyText(waiting)} pending
        </div>
      )}
    </div>
  );
}
