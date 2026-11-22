import { formatMoney } from "../../domain/money.js";
import { STATUS_WORD } from "../../domain/paymentsCsv.js";

export { STATUS_WORD };

/** How much more or less than expected came, in words: "$1.00 more",
 *  "$2.00 less". Nothing for a payment that is not closed, which has no
 *  difference yet, and "as expected" for a closed one that matched. */
export const differenceWords = (cents, currency) => {
  if (cents === null || cents === undefined) return "";
  if (cents === 0) return "as expected";
  return `${formatMoney(Math.abs(cents), currency)} ${cents > 0 ? "more" : "less"}`;
};

/** "November 2026" from a "2026-11" month key, with no time zone to shift it. */
export const monthName = (month) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, {
    month: "long", year: "numeric", timeZone: "UTC",
  });

/** A row's figures as the history shows them: lines paid one by one came as
 *  listed, so they are in both the expected and the received, as in the totals. */
export const figuresOf = (row) => ({
  expected: row.expectedCents + row.paidLinesCents,
  received: row.receivedCents + row.paidLinesCents,
});
