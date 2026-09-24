import { describe, it, expect } from "vitest";
import {
  PERIODS, bucketsFor, byProject, currenciesByValue, deltaRatio, performanceIn,
  periodRange, segmentMsInWindow, sessionMsInWindow, splitByClock, trendFor,
  dailyTotals, heatGrid, heatLevel, heatRange, heatThresholds,
} from "../src/domain/performance.js";
import { isOffClock, offClockProjects, workProjects } from "../src/domain/projects.js";
import { periodStart } from "../src/domain/goals.js";
import { KIND } from "../src/domain/sessions.js";

const HOUR = 3_600_000;
const MIN = 60_000;

const at = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();

/** A closed session of one block. The rate is arithmetic-friendly: 100/hr
 *  means one hour is exactly 10_000 cents. */
const session = (startedAt, endedAt, extra = {}) => ({
  id: "s", projectId: "p1", kind: KIND.BILLED, taskId: null,
  rate: 100, currency: "USD", createdAt: startedAt,
  segments: [{ startedAt, endedAt }], closedAt: endedAt, deletedAt: null, ...extra,
});

describe("overlap with a window", () => {
  it("counts only the part of a segment inside the window", () => {
    const seg = { startedAt: 100, endedAt: 200 };
    expect(segmentMsInWindow(seg, 0, 1000, 0)).toBe(100);   // fully inside
    expect(segmentMsInWindow(seg, 150, 1000, 0)).toBe(50);  // clipped at the start
    expect(segmentMsInWindow(seg, 0, 150, 0)).toBe(50);     // clipped at the end
    expect(segmentMsInWindow(seg, 120, 180, 0)).toBe(60);   // window inside segment
  });

  it("reports nothing for a segment outside the window rather than a negative", () => {
    const seg = { startedAt: 100, endedAt: 200 };
    expect(segmentMsInWindow(seg, 300, 400, 0)).toBe(0);
    expect(segmentMsInWindow(seg, 0, 50, 0)).toBe(0);
  });

  it("treats the window as half-open, so a boundary instant is never counted twice", () => {
    const seg = { startedAt: 100, endedAt: 200 };
    // 200 is the exclusive end of one window and the inclusive start of the
    // next. The two must add to 100, not 200.
    expect(segmentMsInWindow(seg, 100, 200, 0) + segmentMsInWindow(seg, 200, 300, 0)).toBe(100);
  });

  it("measures an open segment up to the caller's now, not the clock", () => {
    expect(segmentMsInWindow({ startedAt: 0, endedAt: null }, 0, HOUR, 30 * MIN)).toBe(30 * MIN);
  });

  it("reads a session with no segments as no time, rather than throwing", () => {
    // Defensive for the same reason the rest of the layer is: a malformed
    // record should report nothing, not take the reporting screen down.
    expect(sessionMsInWindow({ id: "s" }, 0, 1000, 0)).toBe(0);
    expect(sessionMsInWindow({ id: "s", segments: [] }, 0, 1000, 0)).toBe(0);
  });

  it("cannot subtract time when the clock ran backwards", () => {
    expect(segmentMsInWindow({ startedAt: 200, endedAt: 100 }, 0, 1000, 0)).toBe(0);
  });

  it("sums a paused session's blocks and never counts the gap between them", () => {
    const s = session(0, 0, {
      segments: [{ startedAt: 0, endedAt: 10 * MIN }, { startedAt: 50 * MIN, endedAt: 60 * MIN }],
    });
    expect(sessionMsInWindow(s, 0, HOUR, 0)).toBe(20 * MIN);
    expect(sessionMsInWindow(s, 10 * MIN, 50 * MIN, 0)).toBe(0); // the gap alone
  });
});

describe("a session that crosses midnight", () => {
  // The reason reporting splits by overlap instead of asking which bucket a
  // session STARTED in. Filing it whole under either day moves half an hour of
  // money onto the wrong day, and the daily figures stop summing to the weekly.
  const s = session(at(2026, 8, 23, 23, 30), at(2026, 8, 24, 0, 30));

  it("gives each day only the minutes it is owed", () => {
    const d23 = periodRange("day", at(2026, 8, 23, 12));
    const d24 = periodRange("day", at(2026, 8, 24, 12));
    expect(sessionMsInWindow(s, d23.from, d23.to, 0)).toBe(30 * MIN);
    expect(sessionMsInWindow(s, d24.from, d24.to, 0)).toBe(30 * MIN);
  });

  it("still reports the whole hour for the week containing both days", () => {
    const week = periodRange("week", at(2026, 8, 24, 12));
    expect(sessionMsInWindow(s, week.from, week.to, 0)).toBe(HOUR);
  });
});

describe("period windows", () => {
  const t = at(2026, 8, 24, 13, 45);

  it("agrees with the goal period boundary it shares", () => {
    for (const period of PERIODS) {
      expect(periodRange(period, t).from).toBe(periodStart(period, t));
    }
  });

  it("contains the instant it was asked about", () => {
    for (const period of PERIODS) {
      const { from, to } = periodRange(period, t);
      expect(from).toBeLessThanOrEqual(t);
      expect(to).toBeGreaterThan(t);
    }
  });

  it("abuts the periods either side, leaving no gap and no overlap", () => {
    // An overlap double-counts the shared time; a gap loses it.
    for (const period of PERIODS) {
      expect(periodRange(period, t, -1).to).toBe(periodRange(period, t).from);
      expect(periodRange(period, t).to).toBe(periodRange(period, t, 1).from);
    }
  });

  it("steps back a whole month from the 31st without overflowing into March", () => {
    // `setMonth` on the 31st lands on 2 or 3 March. Building each boundary from
    // the 1st cannot.
    const { from, to } = periodRange("month", at(2026, 2, 31, 12), -1);
    expect([new Date(from).getMonth(), new Date(from).getDate()]).toEqual([1, 1]);
    expect([new Date(to).getMonth(), new Date(to).getDate()]).toEqual([2, 1]);
  });

  it("keeps every day of the year disjoint from the next, DST included", () => {
    // Zones that spring forward AT midnight (Africa/Cairo does) have no local
    // 00:00 on that date, so the day begins at 01:00. Adding 24h to that start
    // would reach an hour into the next day and the shared hour would be
    // counted twice. Walking a whole year catches it wherever the tests run.
    for (let d = new Date(2026, 0, 1); d.getFullYear() === 2026; d.setDate(d.getDate() + 1)) {
      const noon = new Date(d).setHours(12, 0, 0, 0);
      const here = periodRange("day", noon);
      const next = periodRange("day", new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12).getTime());
      expect(here.to).toBe(next.from);
      expect(here.to).toBeGreaterThan(here.from);
    }
  });
});

describe("chart buckets", () => {
  it("reads a day hour by hour and a week day by day", () => {
    expect(bucketsFor("day", at(2026, 8, 24, 12))).toHaveLength(24);
    expect(bucketsFor("week", at(2026, 8, 24, 12))).toHaveLength(7);
  });

  it("gives a month one bucket per real day", () => {
    expect(bucketsFor("month", at(2026, 1, 10))).toHaveLength(28); // Feb 2026
    expect(bucketsFor("month", at(2026, 8, 10))).toHaveLength(30); // Sep 2026
    expect(bucketsFor("month", at(2024, 1, 10))).toHaveLength(29); // leap Feb
  });

  it("labels a week by weekday, starting Monday", () => {
    const week = bucketsFor("week", at(2026, 8, 24, 12));
    expect(new Date(week[0].from).getDay()).toBe(1);
    expect(new Date(week[6].from).getDay()).toBe(0);
  });

  it("tiles its period exactly — no gap, no overlap, nothing past the end", () => {
    // The property the whole chart rests on: the bars must add up to the
    // headline, so the buckets must cover the window and no more.
    const t = at(2026, 8, 24, 13, 45);
    for (const period of PERIODS) {
      const { from, to } = periodRange(period, t);
      const buckets = bucketsFor(period, t);
      expect(buckets[0].from).toBe(from);
      expect(buckets[buckets.length - 1].to).toBe(to);
      buckets.forEach((b, i) => {
        if (i > 0) expect(b.from).toBe(buckets[i - 1].to);
        expect(b.to).toBeGreaterThan(b.from);
      });
      expect(buckets.reduce((sum, b) => sum + (b.to - b.from), 0)).toBe(to - from);
    }
  });

  it("tiles every day of the year, so a short or long DST day loses no hour", () => {
    for (let d = new Date(2026, 0, 1); d.getFullYear() === 2026; d.setDate(d.getDate() + 1)) {
      const noon = new Date(d).setHours(12, 0, 0, 0);
      const { from, to } = periodRange("day", noon);
      const buckets = bucketsFor("day", noon);
      expect(buckets.reduce((sum, b) => sum + (b.to - b.from), 0)).toBe(to - from);
      expect(buckets[0].from).toBe(from);
      expect(buckets[buckets.length - 1].to).toBe(to);
    }
  });

  it("marks axis labels on round hours and dated days, not on every bucket", () => {
    const day = bucketsFor("day", at(2026, 8, 24, 12));
    expect(day.filter((b) => b.major).length).toBeGreaterThan(0);
    expect(day.filter((b) => b.major).length).toBeLessThan(day.length);
    expect(bucketsFor("week", at(2026, 8, 24, 12)).every((b) => b.major)).toBe(true);
  });

  it("splits a session's time across buckets so they sum to the period total", () => {
    const s = session(at(2026, 8, 21, 22), at(2026, 8, 23, 3)); // spans three days
    const t = at(2026, 8, 24, 12);
    for (const period of PERIODS) {
      const { from, to } = periodRange(period, t);
      const whole = sessionMsInWindow(s, from, to, t);
      const parts = bucketsFor(period, t)
        .reduce((sum, b) => sum + sessionMsInWindow(s, b.from, b.to, t), 0);
      expect(parts).toBe(whole);
    }
  });
});

describe("what a window was worth", () => {
  const from = at(2026, 8, 24);
  const to = at(2026, 8, 25);

  it("keeps billed and idle in separate fields so neither can leak into the other", () => {
    const result = performanceIn([
      session(at(2026, 8, 24, 9), at(2026, 8, 24, 11)),
      session(at(2026, 8, 24, 11), at(2026, 8, 24, 12), { kind: KIND.IDLE }),
    ], from, to, 0);
    expect(result.billedMs).toBe(2 * HOUR);
    expect(result.idleMs).toBe(HOUR);
    expect(result.billedCents).toEqual({ USD: 20_000 });
    expect(result.idleCents).toEqual({ USD: 10_000 });
  });

  it("values only the time inside the window, not the whole session", () => {
    // 23:00 to 01:00 is two hours of work but only one hour of this day.
    const result = performanceIn(
      [session(at(2026, 8, 24, 23), at(2026, 8, 25, 1))], from, to, 0);
    expect(result.billedMs).toBe(HOUR);
    expect(result.billedCents).toEqual({ USD: 10_000 });
  });

  it("keeps currencies apart instead of adding unlike units", () => {
    const result = performanceIn([
      session(at(2026, 8, 24, 9), at(2026, 8, 24, 10)),
      session(at(2026, 8, 24, 10), at(2026, 8, 24, 11), { currency: "EGP", rate: 450 }),
    ], from, to, 0);
    expect(result.billedCents).toEqual({ USD: 10_000, EGP: 45_000 });
  });

  it("values a session at an overriding rate when the caller supplies one", () => {
    // A task carrying a rate reprices every session filed under it. The
    // snapshot on the session is untouched; the caller answers which applies.
    const s = session(at(2026, 8, 24, 9), at(2026, 8, 24, 10));
    expect(performanceIn([s], from, to, 0, () => 250).billedCents).toEqual({ USD: 25_000 });
    expect(s.rate).toBe(100);
  });

  it("ignores sessions with no time in the window", () => {
    const result = performanceIn([session(at(2026, 8, 1), at(2026, 8, 2))], from, to, 0);
    expect(result).toEqual({ billedMs: 0, idleMs: 0, billedCents: {}, idleCents: {} });
  });

  it("counts a still-running session up to the caller's now", () => {
    const started = at(2026, 8, 24, 9);
    const s = session(started, null, {
      segments: [{ startedAt: started, endedAt: null }], closedAt: null,
    });
    expect(performanceIn([s], from, to, at(2026, 8, 24, 11)).billedMs).toBe(2 * HOUR);
  });
});

describe("comparison against the previous period", () => {
  it("reports the signed change as a ratio of what came before", () => {
    expect(deltaRatio(6, 4)).toBe(0.5);
    expect(deltaRatio(2, 4)).toBe(-0.5);
    expect(deltaRatio(4, 4)).toBe(0);
  });

  it("reports null rather than a percentage when there is no baseline", () => {
    // "No previous data" and "no change" are different statements. Rendering
    // the first as +0% invents a baseline that never existed.
    expect(deltaRatio(5, 0)).toBeNull();
    expect(deltaRatio(0, 0)).toBeNull();
  });
});

describe("rolling up", () => {
  const projects = [
    { id: "p1", name: "Acme", currency: "USD", currentRate: 100 },
    { id: "p2", name: "Beta", currency: "USD", currentRate: 100 },
    { id: "p3", name: "Idle only", currency: "USD", currentRate: 100 },
  ];
  const from = at(2026, 8, 24);
  const to = at(2026, 8, 25);
  const sessions = [
    session(at(2026, 8, 24, 9), at(2026, 8, 24, 10)),
    session(at(2026, 8, 24, 10), at(2026, 8, 24, 13), { projectId: "p2" }),
    session(at(2026, 8, 24, 13), at(2026, 8, 24, 14), { projectId: "p3", kind: KIND.IDLE }),
  ];

  it("orders projects by billed time, busiest first", () => {
    const rows = byProject(projects, sessions, from, to, 0);
    expect(rows.map((r) => r.project.id)).toEqual(["p2", "p1", "p3"]);
    expect(rows[0].billedMs).toBe(3 * HOUR);
  });

  it("falls back to idle time to order projects with equal billed time", () => {
    const tied = [
      { id: "a", name: "A", currency: "USD", currentRate: 100 },
      { id: "b", name: "B", currency: "USD", currentRate: 100 },
    ];
    const rows = byProject(tied, [
      session(at(2026, 8, 24, 9), at(2026, 8, 24, 10), { projectId: "a" }),
      session(at(2026, 8, 24, 9), at(2026, 8, 24, 10), { projectId: "b" }),
      session(at(2026, 8, 24, 10), at(2026, 8, 24, 13), { projectId: "b", kind: KIND.IDLE }),
    ], from, to, 0);
    expect(rows.map((r) => r.project.id)).toEqual(["b", "a"]);
  });

  it("keeps a project that only logged idle time", () => {
    const idleOnly = byProject(projects, sessions, from, to, 0)
      .find((r) => r.project.id === "p3");
    expect(idleOnly.billedMs).toBe(0);
    expect(idleOnly.idleMs).toBe(HOUR);
  });

  it("drops projects with no time in the window rather than listing zeroes", () => {
    expect(byProject(projects, [], from, to, 0)).toEqual([]);
  });

  it("orders currencies by size for display without ever adding them", () => {
    expect(currenciesByValue({ USD: 100, EGP: 500, EUR: 250 }))
      .toEqual([["EGP", 500], ["EUR", 250], ["USD", 100]]);
    expect(currenciesByValue({})).toEqual([]);
  });

  it("attaches each bucket's totals to the bucket itself", () => {
    const trend = trendFor("day", [session(at(2026, 8, 24, 9), at(2026, 8, 24, 10))],
                           at(2026, 8, 24, 12));
    const nine = trend.find((b) => b.label === "09");
    expect(nine.billedMs).toBe(HOUR);
    expect(nine.from).toBeLessThan(nine.to);
    expect(trend.filter((b) => b.billedMs > 0)).toHaveLength(1);
  });

  it("produces a trend whose bars sum to the period headline", () => {
    const spanning = [
      session(at(2026, 8, 22, 23), at(2026, 8, 23, 2)),
      session(at(2026, 8, 24, 9), at(2026, 8, 24, 17)),
    ];
    const t = at(2026, 8, 24, 18);
    const { from: f, to: o } = periodRange("week", t);
    const headline = performanceIn(spanning, f, o, t);
    const bars = trendFor("week", spanning, t);
    expect(bars.reduce((sum, b) => sum + b.billedMs, 0)).toBe(headline.billedMs);
  });
});

describe("off the clock", () => {
  const work = { id: "p1", name: "Acme", currency: "USD", currentRate: 100 };
  const life = { id: "p2", name: "Life", currency: "USD", currentRate: 100, offClock: true };
  const from = at(2026, 8, 24);
  const to = at(2026, 8, 25);

  it("reads a project with no flag as work, so nothing already recorded moves", () => {
    // The absent-means-work rule: every project written before this existed
    // has no flag at all, and that has to keep counting as work.
    expect(isOffClock({ id: "p" })).toBe(false);
    expect(isOffClock({ id: "p", offClock: false })).toBe(false);
    expect(isOffClock({ id: "p", offClock: true })).toBe(true);
    expect(isOffClock(undefined)).toBe(false);
  });

  it("hands back work projects by default and off-clock ones only by name", () => {
    expect(workProjects([work, life]).map((p) => p.id)).toEqual(["p1"]);
    expect(offClockProjects([work, life]).map((p) => p.id)).toEqual(["p2"]);
  });

  it("splits sessions by the clock their project keeps", () => {
    const a = session(at(2026, 8, 24, 9), at(2026, 8, 24, 10));
    const b = session(at(2026, 8, 24, 10), at(2026, 8, 24, 12), { projectId: "p2" });
    const { work: onClock, offClock } = splitByClock([work, life], [a, b]);
    expect(onClock).toEqual([a]);
    expect(offClock).toEqual([b]);
  });

  it("counts a session whose project has vanished as work rather than hiding it", () => {
    // Reporting should fail towards showing time you did record.
    const orphan = session(at(2026, 8, 24, 9), at(2026, 8, 24, 10), { projectId: "gone" });
    expect(splitByClock([work, life], [orphan]).work).toEqual([orphan]);
  });

  it("keeps off-clock hours out of every work figure", () => {
    // The whole point. Sleep tracked at a rate must never reach an earnings
    // total, and must not inflate billed time or the billable share either —
    // which is exactly what a 0.00001 rate failed to prevent.
    const sessions = [
      session(at(2026, 8, 24, 9), at(2026, 8, 24, 10)),                          // 1h work
      session(at(2026, 8, 24, 10), at(2026, 8, 24, 18), { projectId: "p2" }),    // 8h asleep
    ];
    const { work: onClock } = splitByClock([work, life], sessions);
    const figures = performanceIn(onClock, from, to, 0);

    expect(figures.billedMs).toBe(HOUR);
    expect(figures.billedCents).toEqual({ USD: 10_000 });

    // and counting the lot would have said otherwise
    expect(performanceIn(sessions, from, to, 0).billedMs).toBe(9 * HOUR);
  });

  it("still reports off-clock time when it is asked for by name", () => {
    const asleep = session(at(2026, 8, 24, 0), at(2026, 8, 24, 8), { projectId: "p2" });
    const { offClock } = splitByClock([work, life], [asleep]);
    const rows = byProject(offClockProjects([work, life]), offClock, from, to, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].project.name).toBe("Life");
    expect(rows[0].billedMs).toBe(8 * HOUR);
  });

  it("leaves off-clock projects out of the work breakdown entirely", () => {
    const sessions = [
      session(at(2026, 8, 24, 9), at(2026, 8, 24, 10)),
      session(at(2026, 8, 24, 10), at(2026, 8, 24, 18), { projectId: "p2" }),
    ];
    const { work: onClock } = splitByClock([work, life], sessions);
    const rows = byProject(workProjects([work, life]), onClock, from, to, 0);
    expect(rows.map((r) => r.project.id)).toEqual(["p1"]);
  });
});

describe("the activity calendar", () => {
  const at = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();
  const seg = (from, to) => ({ startedAt: from, endedAt: to });
  const s = (id, segments, kind = KIND.BILLED) =>
    ({ id, projectId: "p1", kind, rate: 100, currency: "USD", segments,
       closedAt: segments[segments.length - 1].endedAt, deletedAt: null });

  describe("totalling each day", () => {
    it("files a session under the day it happened on", () => {
      const byDay = dailyTotals([s("a", [seg(at(2024, 4, 15, 9), at(2024, 4, 15, 12))])],
        at(2024, 4, 1), at(2024, 5, 1), at(2024, 4, 20));
      expect(byDay.get(at(2024, 4, 15))).toEqual({ billedMs: 3 * HOUR, idleMs: 0 });
      expect(byDay.size).toBe(1);
    });

    it("splits a session that runs past midnight across both days", () => {
      // The same rule the rest of the module uses. Colouring one cell for the
      // whole session would darken a day that saw half an hour of it.
      const byDay = dailyTotals([s("a", [seg(at(2024, 4, 15, 23, 30), at(2024, 4, 16, 2, 30))])],
        at(2024, 4, 1), at(2024, 5, 1), at(2024, 4, 20));
      expect(byDay.get(at(2024, 4, 15)).billedMs).toBe(30 * MIN);
      expect(byDay.get(at(2024, 4, 16)).billedMs).toBe(2 * HOUR + 30 * MIN);
    });

    it("keeps billed and idle apart in the same day", () => {
      const byDay = dailyTotals([
        s("a", [seg(at(2024, 4, 15, 9), at(2024, 4, 15, 12))]),
        s("b", [seg(at(2024, 4, 15, 12), at(2024, 4, 15, 13))], KIND.IDLE),
      ], at(2024, 4, 1), at(2024, 5, 1), at(2024, 4, 20));
      expect(byDay.get(at(2024, 4, 15))).toEqual({ billedMs: 3 * HOUR, idleMs: HOUR });
    });

    it("adds up several sessions and the gaps of a paused one", () => {
      const byDay = dailyTotals([
        s("a", [seg(at(2024, 4, 15, 9), at(2024, 4, 15, 10)),
                seg(at(2024, 4, 15, 14), at(2024, 4, 15, 15))]),
        s("b", [seg(at(2024, 4, 15, 16), at(2024, 4, 15, 17))]),
      ], at(2024, 4, 1), at(2024, 5, 1), at(2024, 4, 20));
      // the four-hour break between the two segments is not time worked
      expect(byDay.get(at(2024, 4, 15)).billedMs).toBe(3 * HOUR);
    });

    it("clips to the window rather than spilling outside it", () => {
      const byDay = dailyTotals([s("a", [seg(at(2024, 3, 30, 22), at(2024, 4, 1, 2))])],
        at(2024, 4, 1), at(2024, 5, 1), at(2024, 4, 20));
      expect(byDay.has(at(2024, 3, 30))).toBe(false);
      expect(byDay.get(at(2024, 4, 1)).billedMs).toBe(2 * HOUR);
    });

    it("counts an open session up to now and no further", () => {
      const now = at(2024, 4, 15, 11);
      const open = { id: "o", projectId: "p1", kind: KIND.BILLED, rate: 100, currency: "USD",
                     segments: [{ startedAt: at(2024, 4, 15, 9), endedAt: null }],
                     closedAt: null, deletedAt: null };
      expect(dailyTotals([open], at(2024, 4, 1), at(2024, 5, 1), now).get(at(2024, 4, 15)).billedMs)
        .toBe(2 * HOUR);
    });
  });

  describe("laying out the grid", () => {
    const now = at(2024, 4, 15, 14); // Wed 15 May 2024

    it("ends with the week containing today, so today is the last column", () => {
      const { from, to } = heatRange(now, 53);
      const grid = heatGrid(from, to, new Map(), at(2024, 4, 15));
      expect(grid).toHaveLength(53);
      const last = grid[grid.length - 1];
      expect(last.days.map((d) => d.at)).toContain(at(2024, 4, 15));
      expect(new Date(last.from).getDay()).toBe(1); // Monday
    });

    it("puts Monday in the first row of every column", () => {
      const { from, to } = heatRange(now, 8);
      for (const week of heatGrid(from, to, new Map(), at(2024, 4, 15))) {
        expect(week.days.map((d) => new Date(d.at).getDay())).toEqual([1, 2, 3, 4, 5, 6, 0]);
      }
    });

    it("keeps the rows aligned across a DST shift", () => {
      // Regression guard: stepping by a fixed 86,400,000ms through the week
      // Africa/Cairo sprang forward would slide every later day an hour early
      // and eventually land a Tuesday in the Monday row.
      const { from, to } = heatRange(at(2024, 4, 15), 8); // spans 26 Apr 2024
      const grid = heatGrid(from, to, new Map(), at(2024, 4, 15));
      const all = grid.flatMap((w) => w.days);
      // Every cell is the start of its OWN calendar date. Not "midnight": on
      // 26 Apr 2024 Cairo had no 00:00, and that day legitimately begins at
      // 01:00 — which is exactly the day the naive arithmetic loses.
      expect(all.every((d) => {
        const date = new Date(d.at);
        return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() === d.at;
      })).toBe(true);
      expect(all.map((d) => d.at)).toContain(at(2024, 3, 26));
      expect(new Date(at(2024, 3, 26)).getHours()).toBe(1);
    });

    it("marks the days that have not happened yet", () => {
      const { from, to } = heatRange(now, 2);
      const days = heatGrid(from, to, new Map(), at(2024, 4, 15)).flatMap((w) => w.days);
      expect(days.find((d) => d.at === at(2024, 4, 15)).future).toBe(false);
      expect(days.find((d) => d.at === at(2024, 4, 16)).future).toBe(true);
      expect(days.find((d) => d.at === at(2024, 4, 14)).future).toBe(false);
    });

    it("carries each day's totals into its cell", () => {
      const byDay = dailyTotals([s("a", [seg(at(2024, 4, 14, 9), at(2024, 4, 14, 12))])],
        0, Infinity, now);
      const { from, to } = heatRange(now, 2);
      const cell = heatGrid(from, to, byDay, at(2024, 4, 15))
        .flatMap((w) => w.days).find((d) => d.at === at(2024, 4, 14));
      expect(cell.billedMs).toBe(3 * HOUR);
    });
  });

  describe("shading the cells", () => {
    it("cuts the scale at the quantiles of the days that have time on them", () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8].map((h) => h * HOUR);
      const cuts = heatThresholds(values, 4);
      expect(cuts).toHaveLength(3);
      expect(cuts.map((c) => c / HOUR)).toEqual([2, 4, 6]);
    });

    it("ignores empty days when deciding the scale", () => {
      // Otherwise a single busy week in a blank year sets every boundary by how
      // often you did nothing, and comes out uniformly at the darkest shade.
      const busy = [2 * HOUR, 4 * HOUR, 6 * HOUR, 8 * HOUR];
      expect(heatThresholds([...busy, ...Array(300).fill(0)], 4))
        .toEqual(heatThresholds(busy, 4));
    });

    it("puts a day with nothing on it below the first level", () => {
      const cuts = heatThresholds([HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR], 4);
      expect(heatLevel(0, cuts)).toBe(0);
      expect(heatLevel(30 * MIN, cuts)).toBe(1);
      expect(heatLevel(10 * HOUR, cuts)).toBe(4);
    });

    it("survives a calendar with nothing in it at all", () => {
      expect(heatThresholds([], 4)).toEqual([]);
      expect(heatLevel(0, [])).toBe(0);
      expect(heatLevel(HOUR, [])).toBe(1);
    });

    it("keeps every identical day on the same level", () => {
      const same = Array(20).fill(3 * HOUR);
      const cuts = heatThresholds(same, 4);
      expect(same.every((v) => heatLevel(v, cuts) === 1)).toBe(true);
    });
  });
});
