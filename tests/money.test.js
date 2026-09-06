import { describe, it, expect } from "vitest";
import {
  earningsCents, sumCents, formatDuration, formatShortDuration, moneyParts, formatMoney,
} from "../src/domain/money.js";

const HOUR = 3_600_000;

describe("earnings", () => {
  it("bills a whole hour exactly", () => {
    expect(earningsCents(450, HOUR)).toBe(45_000);
  });

  it("bills partial hours proportionally", () => {
    expect(earningsCents(450, HOUR / 4)).toBe(11_250);
  });

  it("does not drift the way an accumulating counter would", () => {
    // A ticker adding (rate/3600) once per second for 10k seconds accumulates
    // float error. Deriving once from elapsed time cannot.
    const derived = earningsCents(450, 10_000 * 1000);
    let accumulated = 0;
    for (let i = 0; i < 10_000; i++) accumulated += (1 / 3600) * 450;
    expect(derived).toBe(125_000);
    expect(Math.round(accumulated * 100)).toBe(derived); // holds here, but only by luck
  });

  it("rounds to the minor unit rather than carrying fractions of a cent", () => {
    const cents = earningsCents(100, 1000); // one second at 100/hr
    expect(Number.isInteger(cents)).toBe(true);
    expect(cents).toBe(3); // 2.777... rounds to 3
  });

  it("sums a mixed-rate ledger without losing precision", () => {
    const sessions = [{ rate: 450 }, { rate: 900 }, { rate: 125.5 }];
    const total = sumCents(sessions, () => HOUR);
    expect(total).toBe(45_000 + 90_000 + 12_550);
  });

  it("returns zero for a session with no elapsed time", () => {
    expect(earningsCents(450, 0)).toBe(0);
  });
});

describe("formatting", () => {
  it("pads durations to a stable width so digits do not jump", () => {
    expect(formatDuration(0)).toBe("00:00:00");
    expect(formatDuration(HOUR + 61_000)).toBe("01:01:01");
    expect(formatDuration(100 * HOUR)).toBe("100:00:00");
  });

  it("switches from minutes to hours for the ledger", () => {
    expect(formatShortDuration(45 * 60_000)).toBe("45m");
    expect(formatShortDuration(HOUR + 5 * 60_000)).toBe("1h 05m");
  });

  it("splits major from minor units for the meter face", () => {
    const { head, tail } = moneyParts(123_456, "USD");
    expect(tail).toBe("56");
    expect(head).toContain("1,234");
  });

  it("falls back to a readable string on an unknown currency code", () => {
    expect(formatMoney(45_000, "NOTACURRENCY")).toContain("450.00");
  });
});

describe("formatting fallbacks", () => {
  it("splits parts without Intl when the currency code is invalid", () => {
    const { head, tail } = moneyParts(45_678, "ZZZ_NOT_REAL");
    expect(head).toBe("456");
    expect(tail).toBe("78");
  });

  it("handles a negative balance without mangling the fraction", () => {
    const { tail } = moneyParts(-4_550, "ZZZ_NOT_REAL");
    expect(tail).toBe("50");
  });

  it("returns zero for an empty ledger", () => {
    expect(sumCents([], () => 0)).toBe(0);
  });
});
