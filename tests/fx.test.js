import { describe, it, expect } from "vitest";
import {
  COMMON_CURRENCIES, convertCents, convertFigures, hasCurrency, isRatesTable, knownCurrencies,
  normaliseRates,
} from "../src/domain/fx.js";

const feed = (usd = { egp: 50, eur: 0.9, gbp: 0.8 }, date = "2026-11-19") => ({ date, usd });
const table = normaliseRates(feed());

describe("normaliseRates", () => {
  it("upper-cases the codes and keeps the date and the numbers", () => {
    expect(table).toEqual({
      base: "USD", date: "2026-11-19", rates: { EGP: 50, EUR: 0.9, GBP: 0.8, USD: 1 },
    });
  });

  it("always has USD at exactly 1, even when the feed's own entry is odd", () => {
    expect(normaliseRates(feed({ usd: 1.0000001, egp: 50 })).rates.USD).toBe(1);
  });

  it.each([
    ["nothing", null],
    ["a string", "rates"],
    ["no date", { usd: { egp: 50 } }],
    ["a date with a time", { date: "2026-11-19T10:00:00Z", usd: { egp: 50 } }],
    ["a day that does not exist", { date: "2026-02-30", usd: { egp: 50 } }],
    ["a numeric date", { date: 20261119, usd: { egp: 50 } }],
    ["no usd base", { date: "2026-11-19", eur: { usd: 1.1 } }],
    ["a usd table that is an array", { date: "2026-11-19", usd: [1, 2] }],
    ["a usd table that is null", { date: "2026-11-19", usd: null }],
    ["an empty table", { date: "2026-11-19", usd: {} }],
    ["a table with no usable rate", { date: "2026-11-19", usd: { egp: 0, eur: -1, gbp: "1" } }],
  ])("rejects %s", (_, raw) => {
    expect(normaliseRates(raw)).toBeNull();
  });

  it("drops a bad entry without losing the good ones", () => {
    const out = normaliseRates(feed({
      egp: 50, eur: 0, gbp: -2, sar: NaN, aed: Infinity, jpy: "150", cad: null, chf: 0.8,
    }));
    expect(Object.keys(out.rates).sort()).toEqual(["CHF", "EGP", "USD"]);
  });

  it("skips keys that are not three-letter codes (the feed lists many tickers)", () => {
    const out = normaliseRates(feed({ egp: 50, "1inch": 2, usdt1: 1, bitcoin: 0.00001 }));
    expect(Object.keys(out.rates).sort()).toEqual(["EGP", "USD"]);
  });
});

describe("isRatesTable", () => {
  it("accepts what normaliseRates gives and refuses a damaged copy", () => {
    expect(isRatesTable(table)).toBe(true);
    expect(isRatesTable(null)).toBe(false);
    expect(isRatesTable({ ...table, base: "EUR" })).toBe(false);
    expect(isRatesTable({ ...table, date: "yesterday" })).toBe(false);
    expect(isRatesTable({ ...table, rates: { ...table.rates, EGP: 0 } })).toBe(false);
    expect(isRatesTable({ ...table, rates: { EGP: 50 } })).toBe(false);
    expect(isRatesTable({ ...table, rates: { ...table.rates, egp: 50 } })).toBe(false);
  });
});

describe("knownCurrencies and hasCurrency", () => {
  it("lists the codes sorted, and answers for a table or for none", () => {
    expect(knownCurrencies(table)).toEqual(["EGP", "EUR", "GBP", "USD"]);
    expect(knownCurrencies(null)).toEqual([]);
    expect(hasCurrency(table, "EGP")).toBe(true);
    expect(hasCurrency(table, "JPY")).toBe(false);
    expect(hasCurrency(null, "USD")).toBe(false);
  });

  it("has a built-in list of unique codes that starts with the project currencies", () => {
    expect(COMMON_CURRENCIES.slice(0, 6)).toEqual(["EGP", "USD", "EUR", "GBP", "SAR", "AED"]);
    expect(new Set(COMMON_CURRENCIES).size).toBe(COMMON_CURRENCIES.length);
    expect(COMMON_CURRENCIES.every((c) => /^[A-Z]{3}$/.test(c))).toBe(true);
  });
});

describe("convertCents", () => {
  it("goes through USD: dollars to pounds, and pounds to dollars", () => {
    expect(convertCents(1000, "USD", "EGP", table)).toBe(50_000);
    expect(convertCents(50_000, "EGP", "USD", table)).toBe(1000);
  });

  it("goes between two non-USD currencies by their ratio", () => {
    expect(convertCents(5000, "EGP", "EUR", table)).toBe(90);
  });

  it("returns the amount itself for the same currency", () => {
    expect(convertCents(12_345, "EGP", "EGP", table)).toBe(12_345);
    expect(convertCents(0, "USD", "USD", table)).toBe(0);
  });

  it("rounds to the nearest cent, halves away from zero", () => {
    const half = normaliseRates({ date: "2026-11-19", usd: { aaa: 0.5, bbb: 2 } });
    // 5 cents at 0.5 per dollar is 2.5 cents.
    expect(convertCents(5, "USD", "AAA", half)).toBe(3);
    expect(convertCents(-5, "USD", "AAA", half)).toBe(-3);
    expect(convertCents(4, "USD", "AAA", half)).toBe(2);
    expect(convertCents(1, "USD", "AAA", half)).toBe(1);   // 0.5 rounds up
  });

  it("converts a negative amount to exactly the negative of the positive one", () => {
    for (const cents of [1, 7, 333, 12_345]) {
      expect(convertCents(-cents, "EGP", "EUR", table)).toBe(-convertCents(cents, "EGP", "EUR", table));
    }
  });

  it("returns an integer", () => {
    const out = convertCents(777, "EGP", "GBP", table);
    expect(Number.isInteger(out)).toBe(true);
  });

  it("is null when either currency is unknown, or there is no table", () => {
    expect(convertCents(100, "JPY", "USD", table)).toBeNull();
    expect(convertCents(100, "USD", "JPY", table)).toBeNull();
    expect(convertCents(100, "JPY", "JPY", table)).toBeNull();
    expect(convertCents(100, "USD", "EGP", null)).toBeNull();
  });

  it("is null for an amount that is not a finite number", () => {
    expect(convertCents(NaN, "USD", "EGP", table)).toBeNull();
    expect(convertCents(undefined, "USD", "EGP", table)).toBeNull();
    expect(convertCents(Infinity, "USD", "EGP", table)).toBeNull();
  });
});

describe("convertFigures", () => {
  it("adds each currency's conversion and says it converted", () => {
    expect(convertFigures({ USD: 1000, EGP: 5000, EUR: 90 }, "USD", table))
      .toEqual({ cents: 1000 + 100 + 100, converted: true, missing: [] });
  });

  it("is not converted when everything is already in the target currency", () => {
    expect(convertFigures({ USD: 4000 }, "USD", table))
      .toEqual({ cents: 4000, converted: false, missing: [] });
  });

  it("ignores a zero figure: it needs no rate and does not make the total approximate", () => {
    expect(convertFigures({ USD: 4000, JPY: 0, EGP: 0 }, "USD", table))
      .toEqual({ cents: 4000, converted: false, missing: [] });
  });

  it("gives null cents and lists every missing code, sorted, when any is unknown", () => {
    expect(convertFigures({ USD: 1000, ZZZ: 5, JPY: 7 }, "USD", table))
      .toEqual({ cents: null, converted: true, missing: ["JPY", "ZZZ"] });
  });

  it("is null when the target itself is unknown", () => {
    expect(convertFigures({ USD: 1000 }, "JPY", table))
      .toEqual({ cents: null, converted: true, missing: ["USD"] });
  });

  it("is zero for no figures at all, and null for no usable table", () => {
    expect(convertFigures({}, "USD", table)).toEqual({ cents: 0, converted: false, missing: [] });
    expect(convertFigures(undefined, "USD", table)).toEqual({ cents: 0, converted: false, missing: [] });
    expect(convertFigures({ USD: 5 }, "EGP", null).cents).toBeNull();
  });

  it("does not change the figures it was given", () => {
    const figures = { USD: 1000, EGP: 5000 };
    convertFigures(figures, "EUR", table);
    expect(figures).toEqual({ USD: 1000, EGP: 5000 });
  });
});
