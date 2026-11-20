import { formatMoney } from "../domain/money.js";

/** "19 Nov" from the feed's plain date, with no time zone to shift it. */
export const rateDay = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric", month: "short", timeZone: "UTC",
  });

/** The figures as one string: each currency as earned, joined by " · ", or one
 *  converted figure marked "≈" when anything was converted. */
export const moneyText = (display) =>
  display.mode === "converted"
    ? `${display.approx ? "≈ " : ""}${formatMoney(display.cents, display.cur)}`
    : display.entries.map(([cur, c]) => formatMoney(c, cur)).join(" · ");

/** "at 19 Nov rates" for a converted figure that needs it, otherwise "". */
export const rateNote = (display) =>
  display.mode === "converted" && display.approx ? `at ${rateDay(display.date)} rates` : "";
