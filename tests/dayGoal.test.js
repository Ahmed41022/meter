import { describe, expect, it } from "vitest";
import { dayGoalState, isDayGoal } from "../src/domain/dayGoal.js";
import { prefOf, setPref } from "../src/domain/prefs.js";

const H = 3_600_000;
const day = (extra = {}) => ({ billedMs: 0, billedCents: {}, pendingCents: {}, cancelledCents: {}, ...extra });
const hours = (h) => ({ type: "time", target: h * 60 });
const money = (target, currency = "USD") => ({ type: "money", target, currency });
const rates = { base: "EUR", date: "2026-11-20", rates: { EUR: 1, USD: 2, EGP: 100 } };

describe("what a daily goal is", () => {
  it("takes a time or an amount with its currency, above zero, and nothing else", () => {
    expect([hours(6), money(200)].every(isDayGoal)).toBe(true);
    expect([null, undefined, 6, {}, hours(0), hours(NaN), money(-1), money(5, "usd"), { type: "money", target: 5 },
      { type: "items", target: 5 }].some(isDayGoal)).toBe(false);
  });

  it("is a preference that can be set, changed, taken off, and is never stamped for nothing", () => {
    expect(prefOf({}, "dayGoal")).toBeNull();
    const set = setPref({}, "dayGoal", hours(6), 1);
    expect(prefOf(set, "dayGoal")).toEqual(hours(6));
    expect(setPref(set, "dayGoal", hours(6), 2)).toBe(set);
    expect(setPref(set, "dayGoal", hours(0), 2)).toBe(set);
    expect(prefOf(setPref(set, "dayGoal", money(90), 2), "dayGoal")).toEqual(money(90));
    expect(prefOf(setPref(set, "dayGoal", null, 2), "dayGoal")).toBeNull();
  });
});

describe("where the day stands", () => {
  it("counts billed time", () => {
    expect(dayGoalState(hours(6), day({ billedMs: 4.5 * H, idleMs: 3 * H })))
      .toMatchObject({ value: 270, toGo: 90, over: 0, met: false });
    expect(dayGoalState(hours(6), day({ billedMs: 7 * H }))).toMatchObject({ toGo: 0, over: 60, met: true });
  });

  it("counts money earned and money waiting on an answer, and none that was cancelled", () => {
    expect(dayGoalState(money(200), day({
      billedCents: { USD: 12_000 }, pendingCents: { USD: 3_000 }, cancelledCents: { USD: 90_000 },
    }))).toMatchObject({ value: 150, toGo: 50, approx: false });
  });

  it("never adds two currencies as if they were one", () => {
    const totals = day({ billedCents: { USD: 10_000, EGP: 50_000 }, pendingCents: { EGP: 10_000 } });
    expect(dayGoalState(money(200), totals)).toMatchObject({ value: 100, uncounted: { EGP: 60_000 }, approx: false });
    expect(dayGoalState(money(200), totals, { fxOn: true, rates: null })).toMatchObject({ value: 100, uncounted: { EGP: 60_000 } });
    // EGP 600.00 at 100 to 2 is $12.00.
    expect(dayGoalState(money(200), totals, { fxOn: true, rates }))
      .toMatchObject({ value: 112, uncounted: {}, approx: true, date: "2026-11-20" });
  });

  it("is exact, not an estimate, where every figure is in the goal's currency", () => {
    expect(dayGoalState(money(200), day({ billedCents: { USD: 100, EGP: 0 } }), { fxOn: true, rates }))
      .toMatchObject({ value: 1, approx: false, uncounted: {} });
  });

  it("is nothing without a goal", () => {
    expect(dayGoalState(null, day())).toBeNull();
  });
});
