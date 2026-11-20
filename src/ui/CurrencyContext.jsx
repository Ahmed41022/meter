import { createContext, useContext } from "react";
import { displayMoney } from "../domain/fxDisplay.js";

/**
 * The app-wide display currency and what is needed to apply it, so a total
 * anywhere can ask "what do I print?" without every screen above it passing
 * the rates down. The default is the app as it was: no rates, so everything
 * is shown as earned.
 */
export const CurrencyContext = createContext({
  choice: "USD", fxOn: false, rates: null, favourites: ["USD"],
  onChoose: () => {}, onOpenSettings: () => {},
});

export const useCurrency = () => useContext(CurrencyContext);

/** What to print for these per-currency figures, under the current choice. */
export function useDisplay(figures, order) {
  const { choice, fxOn, rates } = useCurrency();
  return displayMoney(figures, { choice, fxOn, rates }, order);
}
