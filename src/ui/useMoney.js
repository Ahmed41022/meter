import { displayMoney } from "../domain/fxDisplay.js";
import { formatMoney } from "../domain/money.js";
import { useCurrency } from "./CurrencyContext.jsx";
import { moneyText, rateNote } from "./fxMoney.js";

/**
 * Money for a SUMMARY figure, in the display currency when there is one.
 *
 * Call once per component and use the result in rows: `fmt(cents, cur)` is a
 * single-currency figure as a string ("≈ EGP 1,000.00" when converted, plain
 * `formatMoney` otherwise); `note(cents, cur)` is the rate date for a title, or
 * "" when nothing was converted; `show(figures, order)` is the full display for
 * a set of per-currency figures. Individual records never come through here:
 * they stay in their own currency.
 *
 * Display only. Nothing that writes to the ledger may read these strings or
 * the converted cents behind them.
 */
export function useMoney() {
  const { choice, fxOn, rates } = useCurrency();
  const settings = { choice, fxOn, rates };
  const show = (figures, order) => displayMoney(figures, settings, order);
  return {
    settings,
    show,
    fmt: (cents, cur) => {
      const d = show({ [cur]: cents });
      return d.mode === "converted" ? moneyText(d) : formatMoney(cents, cur);
    },
    note: (cents, cur) => rateNote(show({ [cur]: cents })),
  };
}
