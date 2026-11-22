import { formatMoney } from "../../domain/money.js";
import { currenciesByValue } from "../../domain/performance.js";
import CurrencySwitch from "../CurrencySwitch.jsx";
import { useMoney } from "../useMoney.js";
import { moneyText, rateNote } from "../fxMoney.js";
import { differenceWords } from "./words.js";

/** The five figures a statement keeps, in the order they are read. */
export const METRICS = [
  ["received", "Received"], ["expected", "Expected"], ["outstanding", "Still owed"],
  ["cancelled", "Cancelled"], ["difference", "Difference"],
];

/** One figure of one currency, as the cards print it. */
export const metricText = (key, cents, currency) =>
  (key === "difference" ? differenceWords(cents, currency) : formatMoney(cents, currency));

/**
 * The totals of every currency as one figure in the display currency, per
 * metric, or `rows: null` when nothing was converted. A figure here is an
 * estimate and says so with "≈"; the per-currency cards stay the facts.
 * Display only: it is never an input to anything that is written down.
 * `display` is what the switcher needs to explain why converting did not happen.
 */
export function useApproxTotals(totals) {
  const fx = useMoney();
  const codes = Object.keys(totals);
  const shown = METRICS.map(([key, label]) => ({
    key, label,
    display: fx.show(Object.fromEntries(codes.map((c) => [c, totals[c][key]])), currenciesByValue),
  }));
  const converted = shown.filter((m) => m.display.mode === "converted");
  const rows = codes.length > 0 && converted.some((m) => m.display.approx)
    ? converted.map((m) => ({
      key: m.key, label: m.label, text: moneyText(m.display), note: rateNote(m.display),
    }))
    : null;
  return { rows, display: shown[0].display };
}

/**
 * A card per currency with the statement's figures, and below them, where
 * rates allow, the same figures as one "≈" total. Currencies are never added:
 * each card is one currency's, and the "≈" block is a conversion, marked.
 */
export default function Totals({ totals }) {
  const codes = Object.keys(totals).sort();
  const { rows, display } = useApproxTotals(totals);
  if (codes.length === 0) return null;
  return (
    <div className="stmt-totals">
      {codes.map((cur) => (
        <div className="stmt-card" key={cur} role="group" aria-label={`Totals in ${cur}`}>
          <div className="eyebrow">{cur}</div>
          <dl>
            {METRICS.map(([key, label]) => (
              <div key={key} className="stmt-fig">
                <dt>{label}</dt>
                <dd data-metric={key}>{metricText(key, totals[cur][key], cur)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <div className="stmt-card stmt-approx" role="group" aria-label="Totals in the display currency">
        <div className="stmt-approx-head">
          <span className="eyebrow">All currencies</span>
          <CurrencySwitch display={display} />
        </div>
        {rows ? (
          <dl>
            {rows.map((r) => (
              <div key={r.key} className="stmt-fig" title={r.note || undefined}>
                <dt>{r.label}</dt>
                <dd data-metric={r.key}>{r.text}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="hint" style={{ margin: 0 }}>
            Each currency is shown as it was paid. Choose a display currency for one estimate.
          </p>
        )}
      </div>
    </div>
  );
}
