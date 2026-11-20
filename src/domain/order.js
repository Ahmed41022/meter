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
 */

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
 * `groups` is the seam for a converted ranking: a later version can rank on
 * one converted figure by supplying figures in a single currency, with no
 * change to anything that calls this.
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

/** The currencies a set of rows has money in, for building `groups`. */
export const currenciesOf = (rows, figuresOf) =>
  rows.flatMap((row) => Object.entries(figuresOf(row) ?? {})
    .filter(([, cents]) => present(cents) && cents !== 0).map(([c]) => c));
