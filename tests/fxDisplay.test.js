import { describe, it, expect } from "vitest";
import { normaliseRates } from "../src/domain/fx.js";
import { conversion, displayMoney } from "../src/domain/fxDisplay.js";
import { currenciesByValue } from "../src/domain/performance.js";

const rates = normaliseRates({ date: "2026-11-19", usd: { egp: 50, eur: 0.9 } });
const on = (choice) => ({ choice, fxOn: true, rates });

describe("conversion: whether the figures can be shown in one currency", () => {
  it("is not possible with rates off, whatever else is true", () => {
    expect(conversion({ USD: 100 }, { choice: "USD", fxOn: false, rates })).toEqual({ ok: false, why: "off", codes: [] });
    expect(conversion({ USD: 100 }, { choice: "USD", fxOn: false, rates: null }).why).toBe("off");
  });

  it("is not possible with rates on but none fetched yet", () => {
    expect(conversion({ USD: 100 }, { choice: "USD", fxOn: true, rates: null })).toEqual({ ok: false, why: "none", codes: [] });
  });

  it("is possible when every currency has a rate, and for As earned", () => {
    expect(conversion({ USD: 100, EGP: 5 }, on("EUR")).ok).toBe(true);
    expect(conversion({ ZZZ: 100 }, on("earned")).ok).toBe(true);
  });

  it("names the figures' currencies the feed lacks, sorted, and the target when it lacks it", () => {
    expect(conversion({ USD: 100, ZZZ: 5, AAA: 3 }, on("EGP")))
      .toEqual({ ok: false, why: "missing", codes: ["AAA", "ZZZ"] });
    expect(conversion({ USD: 100 }, on("JPY")))
      .toEqual({ ok: false, why: "missing", codes: ["JPY"] });
  });

  it("does not ask for a rate for a zero figure", () => {
    expect(conversion({ USD: 100, ZZZ: 0 }, on("EGP")).ok).toBe(true);
  });
});

describe("displayMoney", () => {
  const order = currenciesByValue;

  it("keeps each currency as earned, in the order given, under As earned", () => {
    const out = displayMoney({ EUR: 500, USD: 2000, EGP: 10_000 }, on("earned"), order);
    expect(out.mode).toBe("separate");
    expect(out.entries).toEqual([["EGP", 10_000], ["USD", 2000], ["EUR", 500]]);
  });

  it("uses insertion order when no order is given", () => {
    expect(displayMoney({ EUR: 500, USD: 2000 }, on("earned")).entries)
      .toEqual([["EUR", 500], ["USD", 2000]]);
  });

  it("converts to one figure, marked approximate, with the rate date", () => {
    const out = displayMoney({ USD: 2000, EUR: 500 }, on("EGP"), order);
    expect(out).toMatchObject({ mode: "converted", cur: "EGP", approx: true, date: "2026-11-19" });
    expect(out.cents).toBe(100_000 + 27_778);
  });

  it("is not approximate when everything was already in the chosen currency", () => {
    const out = displayMoney({ EGP: 4000 }, on("EGP"), order);
    expect(out).toMatchObject({ mode: "converted", cents: 4000, approx: false });
  });

  it("falls back to separate figures, saying why, without usable rates", () => {
    const off = displayMoney({ USD: 2000 }, { choice: "EGP", fxOn: false, rates: null });
    expect(off.mode).toBe("separate");
    expect(off.conv.why).toBe("off");
    const none = displayMoney({ USD: 2000 }, { choice: "EGP", fxOn: true, rates: null });
    expect(none.conv.why).toBe("none");
  });

  it("falls back when a currency is missing, and says which", () => {
    const out = displayMoney({ USD: 2000, ZZZ: 5 }, on("EGP"), order);
    expect(out.mode).toBe("separate");
    expect(out.entries).toEqual([["USD", 2000], ["ZZZ", 5]]);
    expect(out.conv).toMatchObject({ why: "missing", codes: ["ZZZ"] });
  });

  it("falls back when the chosen currency is not in the feed", () => {
    const out = displayMoney({ USD: 2000 }, on("JPY"));
    expect(out.mode).toBe("separate");
    expect(out.conv.codes).toEqual(["JPY"]);
  });

  it("stays separate, and empty, for no figures at all, so the caller prints its dash", () => {
    expect(displayMoney({}, on("EGP"))).toMatchObject({ mode: "separate", entries: [] });
    expect(displayMoney(undefined, on("EGP"))).toMatchObject({ mode: "separate", entries: [] });
  });

  it("does not change the figures it is given", () => {
    const figures = { USD: 2000, EUR: 500 };
    displayMoney(figures, on("EGP"), order);
    expect(figures).toEqual({ USD: 2000, EUR: 500 });
  });
});
