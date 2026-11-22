/**
 * The spans a statement can be drawn over, as days.
 *
 * The history's dates are plain days on each client's own clock (see
 * payHistory.js), so a span is a pair of inclusive days and not a pair of
 * instants, and "this month" is worked out from the day the owner's device is
 * on, with no time zone arithmetic to shift an edge by one.
 *
 * Like the rest of `domain/`, nothing here reads the clock or storage: `today`
 * is passed in as a day.
 */
import { isDay } from "./payPeriod.js";

export const STATEMENT_PERIODS = [
  ["month", "This month"], ["last-month", "Last month"], ["year", "This year"],
  ["last-year", "Last year"], ["all", "All"], ["custom", "Custom"],
];

/** Opened on when nothing was chosen: a year is long enough to hold the
 *  paydays somebody comes back to check, and short enough to read. */
export const DEFAULT_STATEMENT_PERIOD = "year";

const pad = (n) => String(n).padStart(2, "0");
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * `{ from, to }` for a choice, either left out for "all". `custom` is the two
 * days typed, either of which may be empty and then leaves that side open.
 */
export const statementRange = (key, today, custom = {}) => {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const month = (yy, mm) => ({ from: `${yy}-${pad(mm)}-01`, to: `${yy}-${pad(mm)}-${pad(lastDay(yy, mm))}` });
  switch (key) {
    case "month": return month(y, m);
    case "last-month": return m === 1 ? month(y - 1, 12) : month(y, m - 1);
    case "year": return { from: `${y}-01-01`, to: `${y}-12-31` };
    case "last-year": return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case "custom": return {
      ...(isDay(custom.from) ? { from: custom.from } : {}),
      ...(isDay(custom.to) ? { to: custom.to } : {}),
    };
    default: return {};
  }
};

/** The span in words, for a statement's title: its name and the days it
 *  covers, so a printout still says what it covered once the screen is gone. */
export const statementLabel = (key, range) => {
  const days = range.from && range.to ? `${range.from} to ${range.to}`
    : range.from ? `from ${range.from}` : range.to ? `up to ${range.to}` : "";
  if (key === "all" || (key === "custom" && !days)) return "All time";
  if (key === "custom") return days;
  const name = STATEMENT_PERIODS.find(([k]) => k === key)?.[1] ?? "";
  return `${name} (${days})`;
};

/** What is remembered for the choice: the key, or "custom|from|to". */
export const packChoice = (key, custom = {}) =>
  (key === "custom" ? `custom|${custom.from ?? ""}|${custom.to ?? ""}` : key);

/** The reverse, forgiving: anything unknown is the default, as a value from a
 *  future version or a hand edit must not leave the history empty. */
export const unpackChoice = (value) => {
  const [key, from = "", to = ""] = String(value ?? "").split("|");
  if (key === "custom") return { key, custom: { from: isDay(from) ? from : "", to: isDay(to) ? to : "" } };
  return {
    key: STATEMENT_PERIODS.some(([k]) => k === key && k !== "custom") ? key : DEFAULT_STATEMENT_PERIOD,
    custom: { from: "", to: "" },
  };
};
