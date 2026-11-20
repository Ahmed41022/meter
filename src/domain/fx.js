/**
 * Exchange rates, as pure arithmetic.
 *
 * Nothing here fetches, stores or reads the clock: the network half is in
 * src/fx/rates.js, and this file only says what a feed response means and how
 * to turn one currency's cents into another's.
 *
 * Stored money is never touched by any of this. A conversion produces a
 * display figure, computed fresh each time from the stored amounts, and the
 * screen is expected to mark it as approximate ("≈") with the rate date. Money
 * in different currencies is only ever added AFTER conversion through one
 * table of rates, never raw.
 *
 * Rates are "units per 1 USD", the shape the feed uses: `{ EGP: 53.83 }` means
 * one dollar buys 53.83 pounds. Going from A to B is therefore `rates[B] /
 * rates[A]`, with USD itself at 1.
 */

const CODE = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const positive = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

/** True for a real calendar day written as YYYY-MM-DD ("2026-02-30" is not). */
const isDay = (s) => {
  if (typeof s !== "string" || !DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/**
 * A feed response (`{ date, usd: { egp: 53.83, ... } }`) as `{ base, date,
 * rates }` with upper-case codes, or null when it cannot be trusted.
 *
 * Rejected whole: no object, no date or one that is not a real day, no `usd`
 * table, or a table that leaves no usable rate. Within a usable table the feed
 * also lists crypto tickers and odd entries, so a key that is not a three-letter
 * code is skipped, and so is a three-letter code whose number is not finite and
 * positive: one bad line must not cost the owner every good one. The skipped
 * currency simply reads as "not in the feed", which every caller already
 * handles. USD is always present at exactly 1, as the base.
 */
export const normaliseRates = (raw) => {
  if (!raw || typeof raw !== "object" || !isDay(raw.date)) return null;
  const table = raw.usd;
  if (!table || typeof table !== "object" || Array.isArray(table)) return null;
  const rates = {};
  for (const [key, value] of Object.entries(table)) {
    const code = key.toUpperCase();
    if (!CODE.test(code) || !positive(value)) continue;
    rates[code] = value;
  }
  if (Object.keys(rates).length === 0) return null;
  rates.USD = 1;
  return { base: "USD", date: raw.date, rates };
};

/** Whether a table that came out of storage still has the shape normalise gives. */
export const isRatesTable = (r) =>
  !!r && r.base === "USD" && isDay(r.date) && !!r.rates && typeof r.rates === "object"
  && r.rates.USD === 1
  && Object.entries(r.rates).every(([code, v]) => CODE.test(code) && positive(v));

/** The currency codes a table knows, sorted. */
export const knownCurrencies = (rates) => Object.keys(rates?.rates ?? {}).sort();

/** Whether the table can convert this currency. */
export const hasCurrency = (rates, code) => positive(rates?.rates?.[code]);

/**
 * Cents in one currency as cents in another, or null when either is unknown.
 *
 * Rounding: to the nearest whole cent, halves away from zero, once per
 * conversion. Away from zero rather than JS's Math.round (which sends -2.5 to
 * -2) so a refund or correction converts to exactly the negative of the same
 * amount paid. The same currency returns the input untouched, so USD to USD
 * never wanders by a cent through floating point.
 */
export const convertCents = (cents, from, to, rates) => {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return null;
  if (!hasCurrency(rates, from) || !hasCurrency(rates, to)) return null;
  if (from === to) return Math.round(cents);
  const exact = (Math.abs(cents) * rates.rates[to]) / rates.rates[from];
  return Math.sign(cents) * Math.round(exact);
};

/**
 * A set of per-currency totals, `{ EGP: 1000, USD: 500 }`, as one figure in
 * `to`: `{ cents, converted, missing }`.
 *
 * `converted` is true when any non-zero figure was in a different currency, so
 * the caller knows to mark the result "≈". `missing` lists the currencies the
 * table cannot convert; when it is not empty `cents` is null, because a total
 * that quietly left a currency out would be a wrong number. A figure of zero
 * (or no figure) is ignored: it adds nothing, so it neither needs a rate nor
 * makes the total approximate.
 *
 * Each currency is converted and rounded on its own and the results are added,
 * so the parts always sum to the whole shown.
 */
export const convertFigures = (figures, to, rates) => {
  let cents = 0, converted = false;
  const missing = [];
  for (const [code, amount] of Object.entries(figures ?? {})) {
    if (!amount) continue;
    if (code !== to) converted = true;
    const one = convertCents(amount, code, to, rates);
    if (one === null) { missing.push(code); continue; }
    cents += one;
  }
  missing.sort();
  return { cents: missing.length ? null : cents, converted, missing };
};

/**
 * Codes to offer when no rates have been fetched yet and the feed's own list is
 * not there to choose from. The six a project can be priced in come first.
 */
export const COMMON_CURRENCIES = [
  "EGP", "USD", "EUR", "GBP", "SAR", "AED",
  "AUD", "CAD", "CHF", "CNY", "INR", "JPY", "KWD", "QAR", "BHD", "OMR", "JOD", "TRY",
  "RUB", "BRL", "MXN", "ZAR", "NGN", "KES", "MAD", "SEK", "NOK", "DKK", "PLN", "SGD",
  "HKD", "NZD", "KRW", "PKR", "IDR", "MYR", "THB",
];

/**
 * The currencies worth offering when adding a favourite.
 *
 * The feed lists everything it has, crypto tickers and retired currencies
 * included (ADA, AKT, ATS, BEF, AZM...), which buries the ones anybody holds.
 * So: its codes intersected with `supported`, the platform's list of current
 * ISO 4217 currencies (`Intl.supportedValuesOf("currency")`), passed in so this
 * stays pure. With no rates yet, or no such list on this platform, or nothing
 * in common, the built-in common list stands in.
 */
export const offerableCurrencies = (rates, supported) => {
  if (rates && Array.isArray(supported) && supported.length) {
    const current = new Set(supported);
    const both = knownCurrencies(rates).filter((c) => current.has(c));
    if (both.length) return both;
  }
  return [...COMMON_CURRENCIES];
};
