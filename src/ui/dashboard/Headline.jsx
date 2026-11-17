import { Fragment } from "react";
import { formatMoney } from "../../domain/money.js";
import { Delta } from "../charts.jsx";
import { periodLabel, rangeNote } from "./labels.js";

/** The big figure: what the period earned, its window, and how it compares. */
export default function Headline({
  period, offset, from, to, earned, moneyDeltas, vs, pending,
}) {
  return (
    <div className="grand">
      <span className="eyebrow">{periodLabel(period, offset, from, to)} · earned</span>
      {earned.length === 0
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
          + {pending.map(([cur, c]) => formatMoney(c, cur)).join(" · ")} pending
        </div>
      )}
    </div>
  );
}
