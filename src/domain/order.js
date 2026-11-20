/**
 * How the lists order their rows, kept in one place so Work, Overview, the
 * earnings list and the sessions ledger all answer "biggest first" the same
 * way.
 *
 * Nothing here reads the clock or storage, and nothing here ever adds or
 * compares money in two currencies. That is the point of the module: a list
 * of projects paid in EGP and USD has no honest single ranking, so money is
 * ranked inside one currency at a time and the currencies are laid out as
 * groups.
 *
 * The one exception is a ranking in the owner's display currency
 * (`orderByMoneyIn`): every figure is first converted to that one currency
 * through the day's rates, so the rows are compared like with like, and only
 * when EVERY row converts.
 */
import { convertedFigures } from "./fxDisplay.js";

// The orders each list offers, as [key, label]. The key is what a synced
// preference stores, so renaming a label is free and renaming a key is not.
const ADDED = ["added", "Added"];
const EARNED = ["earned", "Earned"];
const RECENT = ["recent", "Recently worked"];
const NAME = ["name", "Name"];
const TIME = ["time", "Time"];
const RATE = ["rate", "An hour"];

export const CARD_ORDERS = [ADDED, EARNED, RECENT, NAME, TIME];
/** Life has no money, so there is nothing to earn there. */
export const LIFE_ORDERS = [ADDED, RECENT, NAME, TIME];
export const BY_PROJECT_ORDERS = [TIME, RATE, EARNED];
export const BY_COMPANY_ORDERS = [TIME, RATE, EARNED];
export const EARNINGS_ORDERS = [["newest", "Newest"], ["amount", "Amount"]];
export const SESSION_ORDERS = EARNINGS_ORDERS;

export const keysOf = (orders) => orders.map(([key]) => key);

/**
 * Which way an order points when it is first picked. Names read A to Z; every
 * other order opens on its biggest or latest first, the way a person asks.
 */
export const opensDescending = (key) => key !== "name";

const present = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Rows by a number. A row with no number (null, undefined, NaN) sinks to the
 * bottom whichever way the sort points: "least first" is a question about rows
 * that have a figure, and the empty ones would otherwise float to the top of
 * it. Ties keep the order the rows came in.
 */
export const orderByNumber = (rows, valueOf, desc = true) => {
  const keyed = rows.map((row) => ({ row, v: valueOf(row) }));
  const have = keyed.filter((k) => present(k.v));
  const none = keyed.filter((k) => !present(k.v));
  have.sort((a, b) => (desc ? b.v - a.v : a.v - b.v));
  return [...have, ...none].map((k) => k.row);
};

/** Rows by name, ignoring case and reading digits as numbers ("Task 2" < "Task 10"). */
export const orderByName = (rows, nameOf, desc = false) => {
  const out = [...rows].sort((a, b) =>
    String(nameOf(a) ?? "").localeCompare(String(nameOf(b) ?? ""), undefined,
      { sensitivity: "base", numeric: true }));
  return desc ? out.reverse() : out;
};

/**
 * A row's single biggest money figure, as { currency, cents }, or null when it
 * has no money. `figures` is { CUR: cents }.
 *
 * Only figures in the SAME currency are ever compared here, because a row's
 * place is decided by one currency alone. A company with 5,000 EGP and 200 USD
 * is an EGP row worth 5,000; nobody can say whether that is more than 200 USD.
 * Zero is no money. Which of two equal figures wins goes by currency code, so
 * the answer does not depend on object order.
 */
export const biggestFigure = (figures) => {
  let best = null;
  for (const [currency, cents] of Object.entries(figures ?? {})) {
    if (!present(cents) || cents === 0) continue;
    if (!best || cents > best.cents || (cents === best.cents && currency < best.currency)) {
      best = { currency, cents };
    }
  }
  return best;
};

/**
 * The order currencies are laid out in: most hours worked in that currency
 * first, as everywhere else the app lists currencies. A currency nothing was
 * timed in follows, and ties go by code. Hours are compared with hours, never
 * money with money, which is why this takes milliseconds per currency.
 *
 * `msByCurrency` may be empty (a list with no clock, such as earnings), which
 * leaves plain code order.
 */
export const groupOrder = (currencies, msByCurrency = {}) =>
  [...new Set(currencies)].sort((a, b) =>
    (msByCurrency[b] ?? 0) - (msByCurrency[a] ?? 0) || (a < b ? -1 : a > b ? 1 : 0));

/**
 * Rows by what they are worth, grouped by currency.
 *
 * `figuresOf(row)` is { CUR: cents } for that row. Each row is placed by its
 * biggest single-currency figure (see biggestFigure). Groups follow `groups`,
 * a list of currency codes, then any currency not in it by code; inside a
 * group the biggest comes first, or the smallest when `desc` is false.
 * Rows with no money sink to the bottom either way, in the order they came.
 *
 * `groups` is the seam for a converted ranking: figures supplied in a single
 * currency rank as one group (see `orderByMoneyIn`, which does exactly that
 * when the display currency allows).
 */
export const orderByMoney = (rows, figuresOf, { desc = true, groups = [] } = {}) => {
  const rank = new Map(groups.map((c, i) => [c, i]));
  const rankOf = (c) => (rank.has(c) ? rank.get(c) : groups.length);
  const keyed = rows.map((row) => ({ row, top: biggestFigure(figuresOf(row)) }));
  const have = keyed.filter((k) => k.top);
  const none = keyed.filter((k) => !k.top);
  have.sort((a, b) => {
    if (a.top.currency !== b.top.currency) {
      return rankOf(a.top.currency) - rankOf(b.top.currency)
        || (a.top.currency < b.top.currency ? -1 : 1);
    }
    return desc ? b.top.cents - a.top.cents : a.top.cents - b.top.cents;
  });
  return [...have, ...none].map((k) => k.row);
};

/**
 * `orderByMoney` over rows that may be ranked in the display currency.
 *
 * `fx` is `{ choice, fxOn, rates }`, or null for "as earned". When every row
 * can be converted they are ranked as one group by converted value; otherwise
 * this is exactly `orderByMoney` with the given `groups`, so nothing changes
 * for anyone not using a display currency.
 */
export const orderByMoneyIn = (rows, figuresOf, options, fx = null) => {
  const converted = fx && convertedFigures(rows, figuresOf, fx);
  return converted
    ? orderByMoney(rows, converted, { desc: options.desc })
    : orderByMoney(rows, figuresOf, options);
};

/** The currencies a set of rows has money in, for building `groups`. */
export const currenciesOf = (rows, figuresOf) =>
  rows.flatMap((row) => Object.entries(figuresOf(row) ?? {})
    .filter(([, cents]) => present(cents) && cents !== 0).map(([c]) => c));

/** Milliseconds per currency summed over rows, for laying groups out. */
const hoursOf = (rows) => {
  const ms = {};
  for (const r of rows) {
    for (const [c, v] of Object.entries(r.billedMsByCurrency ?? {})) ms[c] = (ms[c] || 0) + v;
  }
  return ms;
};

/** Order by money with groups laid out by the hours the rows themselves report. */
const byMoneyAndHours = (rows, figuresOf, fx = null) =>
  orderByMoneyIn(rows, figuresOf,
    { groups: groupOrder(currenciesOf(rows, figuresOf), hoursOf(rows)) }, fx);

/**
 * The Overview's By project rows in the chosen order. "time" is the order they
 * arrive in (busiest first), and "earned" ranks each row by what it reports as
 * settled money for the period, one currency at a time. ("An hour" is ranked
 * by worthPerHour, which has its own floor and sole-currency rule.)
 */
export const orderProjectRows = (rows, key, fx = null) =>
  key === "earned" ? byMoneyAndHours(rows, (r) => r.billedCents, fx) : rows;

/**
 * The Overview's By company rows in the chosen order, with the unassigned row
 * always last: it is a gap to fill, not a client to rank.
 *
 * "earned" with one currency is the order the rollup has always had (most
 * money, then most time), because the rows arrive in that order and ties and
 * the empty ones keep it. Only money above zero ranks, as before. "rate" is
 * the blended hourly figure, which a row has only when its money is in one
 * currency, so it is ranked inside that currency and rows with no rate sink.
 */
export const orderCompanyRows = (rows, key, fx = null) => {
  const named = rows.filter((r) => r.company !== null);
  const gap = rows.filter((r) => r.company === null);
  const sorted = key === "time"
    ? orderByNumber(named, (r) => (r.billedMs > 0 ? r.billedMs : null))
    : key === "rate"
      ? byMoneyAndHours(named, (r) => (r.rateCents > 0 ? { [r.currency]: r.rateCents } : {}), fx)
      : byMoneyAndHours(named, (r) => Object.fromEntries(
        Object.entries(r.billedCents).filter(([, c]) => c > 0)), fx);
  return [...sorted, ...gap];
};
