import { describe, it, expect } from "vitest";
import {
  busiest, busiestStretch, byHourOfDay, byWeekday, shareOf, standsOut, timedOnly,
} from "../src/domain/rhythm.js";
import { KIND } from "../src/domain/sessions.js";

const HOUR = 3_600_000;
const at = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();
const from = at(2026, 4, 1);
const to = at(2026, 6, 1);
const now = at(2026, 5, 30, 12);

const block = (startedAt, endedAt, extra = {}) => ({
  id: `s${startedAt}`, projectId: "p1", kind: KIND.BILLED, rate: 10, currency: "USD",
  deletedAt: null, closedAt: endedAt, segments: [{ startedAt, endedAt }], ...extra,
});

describe("which day of the week the work lands on", () => {
  it("puts Monday first, where the calendar puts it", () => {
    // 4 May 2026 is a Monday.
    const rows = byWeekday([block(at(2026, 4, 4, 9), at(2026, 4, 4, 11))], from, to, now);
    expect(rows[0].billedMs).toBe(2 * HOUR);
    expect(rows.slice(1).every((r) => r.billedMs === 0)).toBe(true);
  });

  it("splits a session that runs past midnight across both days", () => {
    // Sunday night bleeding into Monday is two days' work, not one.
    const rows = byWeekday(
      [block(at(2026, 4, 10, 23, 30), at(2026, 4, 11, 0, 30))], from, to, now);
    expect(rows[6].billedMs).toBe(0.5 * HOUR); // Sunday 10 May
    expect(rows[0].billedMs).toBe(0.5 * HOUR); // Monday 11 May
  });

  it("counts the calendar days that saw work, so totals can be compared", () => {
    const rows = byWeekday([
      block(at(2026, 4, 4, 9), at(2026, 4, 4, 11)), // Mon
      block(at(2026, 4, 11, 9), at(2026, 4, 11, 10)), // Mon, a week later
    ], from, to, now);
    expect(rows[0].activeDays).toBe(2);
    expect(rows[0].billedMs).toBe(3 * HOUR);
  });

  it("keeps idle time out of the billed figure", () => {
    const rows = byWeekday(
      [block(at(2026, 4, 4, 9), at(2026, 4, 4, 11), { kind: KIND.IDLE })], from, to, now);
    expect(rows[0].billedMs).toBe(0);
    expect(rows[0].idleMs).toBe(2 * HOUR);
    expect(rows[0].activeDays).toBe(1);
  });
});

describe("which hours of the day the work lands in", () => {
  it("spreads a session across every hour it touches", () => {
    // 09:40 to 12:10 is twenty minutes of nine, two whole hours, ten of twelve.
    // Filing it under "09" would claim mornings on the evidence of an afternoon.
    const rows = byHourOfDay(
      [block(at(2026, 4, 4, 9, 40), at(2026, 4, 4, 12, 10))], from, to, now);
    expect(rows[9].billedMs).toBe(20 * 60_000);
    expect(rows[10].billedMs).toBe(HOUR);
    expect(rows[11].billedMs).toBe(HOUR);
    expect(rows[12].billedMs).toBe(10 * 60_000);
  });

  it("returns all twenty-four hours whether or not they were worked", () => {
    const rows = byHourOfDay([], from, to, now);
    expect(rows).toHaveLength(24);
    expect(rows.map((r) => r.hour)).toEqual([...Array(24).keys()]);
  });

  it("files work either side of midnight under the right hours", () => {
    const rows = byHourOfDay(
      [block(at(2026, 4, 10, 23, 35), at(2026, 4, 11, 0, 35))], from, to, now);
    expect(rows[23].billedMs).toBe(25 * 60_000);
    expect(rows[0].billedMs).toBe(35 * 60_000);
  });

  it("terminates across a day that has no midnight", () => {
    // Africa/Cairo springs forward AT midnight, so 26 Apr 2024 starts at 01:00.
    // Hour-walking by calendar fields must still advance.
    const a = new Date(2024, 3, 25, 22).getTime();
    const b = new Date(2024, 3, 26, 4).getTime();
    const rows = byHourOfDay([block(a, b)], a - HOUR, b + HOUR, b);
    const total = rows.reduce((t, r) => t + r.billedMs, 0);
    expect(total).toBe(b - a);
  });

  it("never loses or invents time, whatever the window", () => {
    const a = at(2026, 4, 4, 7, 13);
    const b = at(2026, 4, 5, 3, 47);
    const rows = byHourOfDay([block(a, b)], from, to, now);
    expect(rows.reduce((t, r) => t + r.billedMs, 0)).toBe(b - a);
  });
});

describe("naming the peak", () => {
  const hours = (spec) => {
    const rows = [...Array(24).keys()].map((hour) => ({ hour, billedMs: 0, idleMs: 0 }));
    for (const [h, ms] of Object.entries(spec)) rows[h].billedMs = ms;
    return rows;
  };

  it("finds the busiest row", () => {
    expect(busiest(hours({ 9: HOUR, 14: 3 * HOUR })).hour).toBe(14);
  });

  it("says nothing rather than guessing when nothing was billed", () => {
    expect(busiest(hours({}))).toBeNull();
    expect(busiestStretch(hours({}))).toBeNull();
  });

  it("breaks ties towards the earlier row, so it reads the same every render", () => {
    expect(busiest(hours({ 9: HOUR, 14: HOUR })).hour).toBe(9);
  });

  it("finds the best run of consecutive hours", () => {
    const s = busiestStretch(hours({ 9: HOUR, 10: HOUR, 11: HOUR, 12: HOUR, 20: 2 * HOUR }), 4);
    expect(s.from).toBe(9);
    expect(s.to).toBe(13);
    expect(s.billedMs).toBe(4 * HOUR);
  });

  it("wraps past midnight, because a day is a circle", () => {
    // This ledger holds sessions that start at 23:35 and end at 00:33. A
    // window that cannot wrap splits them and reports neither end.
    const s = busiestStretch(hours({ 22: HOUR, 23: 2 * HOUR, 0: 2 * HOUR, 1: HOUR }), 4);
    expect(s.from).toBe(22);
    expect(s.to).toBe(2);
    expect(s.billedMs).toBe(6 * HOUR);
  });

  it("reports what share of everything a slice holds", () => {
    const rows = hours({ 9: HOUR, 10: 3 * HOUR });
    expect(shareOf(rows, 3 * HOUR)).toBe(0.75);
    expect(shareOf(hours({}), 0)).toBeNull();
  });
});

describe("refusing to report noise as a finding", () => {
  const rows = (...ms) => ms.map((billedMs, weekday) => ({ weekday, billedMs, idleMs: 0 }));

  it("names a peak that genuinely stands above the rest", () => {
    expect(standsOut(rows(10, 10, 40, 10, 10, 10, 10)).weekday).toBe(2);
  });

  it("names nothing when the week is flat", () => {
    // 100/82/98/92/81/97/81 is what this ledger actually looks like. Calling
    // that "busiest on Monday" states a rounding difference as a habit.
    expect(standsOut(rows(100, 82, 98, 92, 81, 97, 81))).toBeNull();
  });

  it("names the only row there is", () => {
    expect(standsOut(rows(0, 0, 5, 0, 0, 0, 0)).weekday).toBe(2);
  });

  it("says nothing at all when nothing was billed", () => {
    expect(standsOut(rows(0, 0, 0, 0, 0, 0, 0))).toBeNull();
  });
});

describe("keeping invented clock times out of an hourly reading", () => {
  const block = (startedAt, endedAt, extra = {}) => ({
    id: `s${startedAt}`, projectId: "p1", kind: KIND.BILLED, rate: 10, currency: "USD",
    deletedAt: null, closedAt: endedAt, segments: [{ startedAt, endedAt }], ...extra,
  });

  it("drops typed-in sessions, whose hour was chosen rather than measured", () => {
    const list = [
      block(at(2026, 4, 4, 9), at(2026, 4, 4, 10), { manual: true }),
      block(at(2026, 4, 4, 21), at(2026, 4, 4, 22)),
    ];
    expect(timedOnly(list)).toHaveLength(1);
    const hours = byHourOfDay(timedOnly(list), from, to, now);
    expect(hours[9].billedMs).toBe(0); // the placed one
    expect(hours[21].billedMs).toBe(HOUR); // the measured one
  });

  it("keeps them for a weekday reading, where the date IS real", () => {
    const list = [block(at(2026, 4, 4, 9), at(2026, 4, 4, 11), { manual: true })];
    expect(byWeekday(list, from, to, now)[0].billedMs).toBe(2 * HOUR);
  });
});
