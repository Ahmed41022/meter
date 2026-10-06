import { describe, it, expect } from "vitest";
import {
  PERIODS, bucketsFor, byProject, currenciesByValue, deltaRatio, performanceIn,
  periodRange, segmentMsInWindow, sessionMsInWindow, splitByClock, trendFor,
  dailyTotals, heatDepth, heatGrid, heatLevel, heatRange, heatThresholds,
  byCompany, comparisonRanges, concentration, currenciesByWork, effectiveRate, firstRecord,
  goalValue, hourlyRates, revenueShare, samePointBefore, soleCurrency, streaks, worthPerHour,
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

  /**
   * All time is exempt from the two invariants below, deliberately. It does not
   * repeat, so it has no neighbour to abut and no offset to step. Its start is
   * the first record rather than a calendar boundary, and `goals.js` still puts
   * its boundaryless period at the epoch — right for a lifetime goal, wrong for
   * a chart that would otherwise draw every empty month since 1970. It has its
   * own tests at the foot of this file.
   */
  const REPEATING = PERIODS.filter((p) => p !== "all");

  it("agrees with the goal period boundary it shares", () => {
    for (const period of REPEATING) {
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
    for (const period of REPEATING) {
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
    expect(result).toEqual({
      billedMs: 0, idleMs: 0,
      billedCents: {}, idleCents: {}, pendingCents: {}, timedCents: {}, cancelledCents: {},
      billedMsByCurrency: {},
    });
  });

  it("agrees with the heat map about a day whose work was rejected", () => {
    // The grid distributes every segment it is given; the headline used to
    // skip cancelled sessions outright. The same day came out as five hours
    // in one place and nothing in the other.
    const rejected = [
      session(at(2026, 8, 24, 9), at(2026, 8, 24, 12), { status: "cancelled" }),
      session(at(2026, 8, 24, 13), at(2026, 8, 24, 15), { status: "cancelled" }),
    ];
    const headline = performanceIn(rejected, from, to, 0);
    const grid = [...dailyTotals(rejected, from, to, 0).values()]
      .reduce((a, cell) => a + cell.billedMs, 0);
    expect(headline.billedMs).toBe(5 * HOUR);
    expect(grid).toBe(headline.billedMs);
    expect(headline.billedCents).toEqual({});
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

describe("what a period still going is compared with", () => {
  const wed = at(2026, 9, 7, 15, 30); // Wednesday 7 Oct 2026, 15:30

  it("finds the same point in each kind of period before", () => {
    expect(samePointBefore("day", wed)).toBe(at(2026, 9, 6, 15, 30));
    expect(samePointBefore("week", wed)).toBe(at(2026, 8, 30, 15, 30)); // last Wednesday
    expect(samePointBefore("month", wed)).toBe(at(2026, 8, 7, 15, 30));
    expect(samePointBefore("year", wed)).toBe(at(2025, 9, 7, 15, 30));
    expect(samePointBefore("all", wed)).toBeNull();
  });

  it("clamps a day the earlier month does not have to its last day", () => {
    expect(samePointBefore("month", at(2026, 2, 31, 10))).toBe(at(2026, 1, 28, 10));
    expect(samePointBefore("year", at(2024, 1, 29, 10))).toBe(at(2023, 1, 28, 10));
    // and January reaches back into December of the year before
    expect(samePointBefore("month", at(2026, 0, 15, 8))).toBe(at(2025, 11, 15, 8));
  });

  it("keeps the weekday when the week between holds a DST change at midnight", () => {
    // Africa/Cairo sprang forward at 00:00 on Friday 24 Apr 2026. A week back
    // from Friday 1 May 00:30 is that Friday, which has no 00:30 and is read
    // as 01:30. Seven days of milliseconds lands on the Thursday instead.
    const fri = at(2026, 4, 1, 0, 30);
    const back = new Date(samePointBefore("week", fri));
    expect([back.getDay(), back.getDate()]).toEqual([5, 24]);
    expect(new Date(fri - 7 * 24 * HOUR).getDay()).toBe(4);
  });

  it("sets the period so far against the period before up to the same point", () => {
    expect(comparisonRanges("week", wed)).toEqual({
      current: { from: at(2026, 9, 5), to: wed },
      previous: { from: at(2026, 8, 28), to: at(2026, 8, 30, 15, 30) },
      toDate: true,
    });
  });

  it("compares a period that is over whole, with the whole one before it", () => {
    expect(comparisonRanges("week", wed, -1)).toEqual({
      current: periodRange("week", wed, -1),
      previous: periodRange("week", wed, -2),
      toDate: false,
    });
  });

  it("has nothing to compare all time with", () => {
    expect(comparisonRanges("all", wed)).toBeNull();
  });

  it("reads a Wednesday as level with last Wednesday, not as most of a week down", () => {
    // Two hours by Monday evening this week; last week had an hour on Monday
    // and eight on Thursday, which this week has not reached yet.
    const sessions = [
      session(at(2026, 9, 5, 9), at(2026, 9, 5, 11)),
      session(at(2026, 8, 28, 9), at(2026, 8, 28, 10)),
      session(at(2026, 9, 1, 9), at(2026, 9, 1, 17)),
    ];
    const { current, previous } = comparisonRanges("week", wed);
    const sofar = performanceIn(sessions, current.from, current.to, wed);
    const before = performanceIn(sessions, previous.from, previous.to, wed);
    expect(deltaRatio(sofar.billedMs, before.billedMs)).toBe(1);
    // against all of last week the same two hours read as a collapse
    const whole = periodRange("week", wed, -1);
    expect(deltaRatio(sofar.billedMs, performanceIn(sessions, whole.from, whole.to, wed).billedMs))
      .toBeCloseTo(-7 / 9, 6);
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

    it("never states the same boundary twice, however few days there are", () => {
      // Several quantiles land on the same day when there are few of them,
      // and the legend printed "to 1h 00m" three times over.
      expect(heatThresholds([HOUR], 4)).toEqual([HOUR]);
      expect(heatThresholds([HOUR, HOUR, HOUR, 2 * HOUR], 4)).toEqual([HOUR]);
      expect(heatThresholds(Array(20).fill(3 * HOUR), 4)).toEqual([3 * HOUR]);
    });

    it("takes boundaries to the minute, so none print as the same figure", () => {
      // 59m50s, 59m55s and 59m58s all print as "1h 00m".
      const near = [59 * MIN + 50_000, 59 * MIN + 55_000, 59 * MIN + 58_000, 2 * HOUR];
      expect(heatThresholds(near, 4)).toEqual([HOUR]);
      // a day at the boundary is still on the shade the legend says it is
      expect(heatLevel(59 * MIN + 58_000, heatThresholds(near, 4))).toBe(1);
      expect(heatLevel(2 * HOUR, heatThresholds(near, 4))).toBe(2);
    });
  });
});

describe("grouping by who the work was for", () => {
  const at = (y, m, d, h = 0) => new Date(y, m, d, h).getTime();
  const from = at(2024, 4, 13);
  const to = at(2024, 4, 20);
  const now = at(2024, 4, 19);
  const project = (id, company, rate = 100, currency = "USD") =>
    ({ id, name: id, currentRate: rate, currency, company });
  const sess = (id, projectId, hours, rate = 100, currency = "USD", kind = KIND.BILLED) => ({
    id, projectId, kind, rate, currency, deletedAt: null,
    segments: [{ startedAt: at(2024, 4, 14, 9), endedAt: at(2024, 4, 14, 9 + hours) }],
    closedAt: at(2024, 4, 14, 9 + hours),
  });

  it("adds up every project belonging to one company", () => {
    const projects = [project("a", "Northwind"), project("b", "Northwind"), project("c", "Lumen", 50)];
    const rows = byCompany(projects, [
      sess("s1", "a", 2), sess("s2", "b", 3), sess("s3", "c", 4, 50),
    ], from, to, now);
    expect(rows.map((r) => r.company)).toEqual(["Northwind", "Lumen"]);
    expect(rows[0].billedMs).toBe(5 * HOUR);
    expect(rows[0].billedCents.USD).toBe(500_00);
    expect(rows[0].projects.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("keeps unassigned work as its own row, last", () => {
    // Dropping it would make the shares add up to less than the whole while
    // looking like they added up to all of it.
    const rows = byCompany(
      [project("a", "Northwind"), project("b", null)],
      [sess("s1", "a", 1), sess("s2", "b", 9)], from, to, now);
    expect(rows.map((r) => r.company)).toEqual(["Northwind", null]);
    expect(rows[1].billedMs).toBe(9 * HOUR);
  });

  it("ranks companies by what they paid, not by hours", () => {
    const rows = byCompany(
      [project("a", "Rich", 500), project("b", "Busy", 10)],
      [sess("s1", "a", 1, 500), sess("s2", "b", 20, 10)], from, to, now);
    expect(rows.map((r) => r.company)).toEqual(["Rich", "Busy"]);
  });

  it("drops a company with no time in the window", () => {
    const rows = byCompany(
      [project("a", "Northwind"), project("b", "Dormant")], [sess("s1", "a", 1)], from, to, now);
    expect(rows.map((r) => r.company)).toEqual(["Northwind"]);
  });

  it("ignores sessions whose project was not passed in", () => {
    // Off-clock work has no client, and sleep is not unassigned revenue.
    const rows = byCompany([project("a", "Northwind")],
      [sess("s1", "a", 2), sess("s2", "sleep", 8)], from, to, now);
    expect(rows).toHaveLength(1);
    expect(rows[0].billedMs).toBe(2 * HOUR);
  });

  it("keeps idle time out of the money but not out of the row", () => {
    const rows = byCompany([project("a", "Northwind")],
      [sess("s1", "a", 2), sess("s2", "a", 1, 100, "USD", KIND.IDLE)], from, to, now);
    expect(rows[0]).toMatchObject({ billedMs: 2 * HOUR, idleMs: HOUR });
    expect(rows[0].billedCents.USD).toBe(200_00);
  });

  it("treats one client typed two ways as one company, under the spelling met first", () => {
    // The payday rule already folds these to one key; two rows here made one
    // client read as two, each with half of its money.
    const projects = [
      project("a", "Northwind"), project("b", "northwind"), project("c", " NORTHWIND "),
      project("d", "Lumen", 50),
    ];
    const rows = byCompany(projects, [
      sess("s1", "a", 2), sess("s2", "b", 3), sess("s3", "c", 1), sess("s4", "d", 4, 50),
    ], from, to, now);
    expect(rows.map((r) => r.company)).toEqual(["Northwind", "Lumen"]);
    expect(rows[0].projects.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(rows[0].billedMs).toBe(6 * HOUR);
    expect(rows[0].billedCents.USD).toBe(600_00);
  });

  it("folds spaces, hyphens and underscores the way the payday rule does", () => {
    const rows = byCompany(
      [project("a", "North Wind"), project("b", "north-wind"), project("c", "north_wind")],
      [sess("s1", "a", 1), sess("s2", "b", 1), sess("s3", "c", 1)], from, to, now);
    expect(rows.map((r) => [r.company, r.projects.length])).toEqual([["North Wind", 3]]);
  });

  it("keeps a name that folds to nothing apart from work with no company", () => {
    const rows = byCompany([project("a", "-"), project("b", null)],
      [sess("s1", "a", 2), sess("s2", "b", 1)], from, to, now);
    expect(rows.map((r) => r.company)).toEqual(["-", null]);
  });
});

describe("what an hour actually came to", () => {
  it("blends the rates across a company's work", () => {
    // The figure no per-project rate can give you.
    expect(effectiveRate(500_00, 5 * HOUR)).toBe(100_00);
    expect(effectiveRate(300_00, 4 * HOUR)).toBe(75_00);
  });

  it("divides billed hours, never desk hours", () => {
    // Idle time earns nothing by definition; folding it in would report a rate
    // that was never charged.
    expect(effectiveRate(180_00, 2 * HOUR)).toBe(90_00);
  });

  it("has no answer without billed time", () => {
    expect(effectiveRate(0, 0)).toBeNull();
    expect(effectiveRate(100_00, 0)).toBeNull();
  });

  it("names the single currency a figure can be in, or refuses", () => {
    expect(soleCurrency({ USD: 100 })).toBe("USD");
    expect(soleCurrency({})).toBeNull();
    expect(soleCurrency({ USD: 100, EGP: 50 })).toBeNull();
  });
});

describe("share of the revenue", () => {
  const row = (billedCents) => ({ billedCents });

  it("splits one currency into shares that add up", () => {
    const rows = [row({ USD: 800_00 }), row({ USD: 200_00 })];
    const shares = revenueShare(rows);
    expect(shares.get(rows[0])).toBeCloseTo(0.8, 6);
    expect(shares.get(rows[1])).toBeCloseTo(0.2, 6);
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it("refuses to take a share across currencies", () => {
    // 100 EGP and 100 USD have no total to be a share of, and inventing one is
    // the same lie as adding them.
    expect(revenueShare([row({ USD: 100_00 }), row({ EGP: 100_00 })])).toBeNull();
  });

  it("has nothing to divide when nothing was earned", () => {
    expect(revenueShare([row({})])).toBeNull();
    expect(revenueShare([row({ USD: 0 })])).toBeNull();
  });
});

describe("streaks", () => {
  const days = (pattern) => [...pattern].map((c) => ({ ms: c === "x" ? 3_600_000 : 0 }));
  const run = (pattern) => streaks(days(pattern), (d) => d.ms > 0);

  it("counts the longest run of consecutive days", () => {
    expect(run("xx..xxxx..x").longest).toBe(4);
  });

  it("counts the run you are on right now", () => {
    expect(run("..xxxxx")).toMatchObject({ current: 5, includesToday: true });
  });

  it("does not break today's streak just because today is not over", () => {
    // Reporting a five-day run as broken at 09:00 would be wrong, and the kind
    // of wrong that makes a streak feel like an accusation.
    expect(run("..xxxxx.")).toMatchObject({ current: 5, includesToday: false });
  });

  it("is broken once a whole day has passed with nothing on it", () => {
    expect(run("xxxxx..")).toMatchObject({ current: 0, includesToday: false });
  });

  it("counts a single day as a run of one", () => {
    expect(run("....x")).toMatchObject({ current: 1, longest: 1, includesToday: true });
  });

  it("handles a calendar that is entirely empty or entirely full", () => {
    expect(run("......")).toMatchObject({ current: 0, longest: 0, includesToday: false });
    expect(run("xxxxxx")).toMatchObject({ current: 6, longest: 6, includesToday: true });
    expect(streaks([], () => true)).toMatchObject({ current: 0, longest: 0, includesToday: false });
  });

  it("does not let the whole window count as one run across a gap", () => {
    expect(run("xxx.xxx")).toMatchObject({ longest: 3, current: 3 });
  });
});

describe("a year at a time", () => {
  const at = (y, m, d, h = 0) => new Date(y, m, d, h).getTime();
  const now = at(2026, 8, 24, 12);

  it("runs from 1 January to 1 January", () => {
    const { from, to } = periodRange("year", now, 0);
    expect(new Date(from).getFullYear()).toBe(2026);
    expect([new Date(from).getMonth(), new Date(from).getDate()]).toEqual([0, 1]);
    expect(new Date(to).getFullYear()).toBe(2027);
  });

  it("steps whole years backwards", () => {
    expect(new Date(periodRange("year", now, -1).from).getFullYear()).toBe(2025);
    expect(new Date(periodRange("year", now, -2).from).getFullYear()).toBe(2024);
  });

  it("reads month by month, not day by day", () => {
    // 365 bars two pixels wide is a texture, not a chart.
    const buckets = bucketsFor("year", now, 0);
    expect(buckets).toHaveLength(12);
    expect(buckets.every((b) => b.major)).toBe(true);
  });

  it("gives February its own length rather than a gap", () => {
    const leap = bucketsFor("year", at(2024, 5, 1), 0);
    const feb = leap[1];
    expect((feb.to - feb.from) / 86_400_000).toBe(29);
    const plain = bucketsFor("year", at(2023, 5, 1), 0);
    expect((plain[1].to - plain[1].from) / 86_400_000).toBe(28);
  });

  it("tiles the year exactly", () => {
    const buckets = bucketsFor("year", now, 0);
    const { from, to } = periodRange("year", now, 0);
    expect(buckets[0].from).toBe(from);
    expect(buckets[buckets.length - 1].to).toBe(to);
    expect(buckets.every((b, i) => i === 0 || b.from === buckets[i - 1].to)).toBe(true);
  });
});

describe("looking further back than one calendar", () => {
  const at = (y, m, d) => new Date(y, m, d).getTime();
  const now = at(2026, 8, 24);

  it("steps a whole grid at a time, so no week lands in two views", () => {
    const first = heatRange(now, 53, 0);
    const second = heatRange(now, 53, 1);
    expect(second.to).toBe(first.from);
    expect(heatRange(now, 53, 2).to).toBe(second.from);
  });

  it("keeps every window the same number of weeks", () => {
    for (const back of [0, 1, 2, 5]) {
      const { from, to } = heatRange(now, 53, back);
      expect(heatGrid(from, to, new Map(), now)).toHaveLength(53);
    }
  });

  it("knows how far back there is anything to see", () => {
    expect(heatDepth(at(2026, 0, 1), now)).toBe(0);      // inside the first grid
    expect(heatDepth(at(2025, 0, 1), now)).toBe(1);
    expect(heatDepth(at(2024, 0, 1), now)).toBe(2);
    expect(heatDepth(Infinity, now)).toBe(0);            // nothing recorded at all
  });
});

describe("all time", () => {
  const seg = (s, e) => ({ startedAt: s, endedAt: e });
  const now = at(2026, 8, 24, 15); // 24 Sep 2026, 15:00

  it("offers itself last, after the periods that repeat", () => {
    expect(PERIODS).toEqual(["day", "week", "month", "year", "all"]);
  });

  it("runs from the first thing ever recorded to the end of today", () => {
    const { from, to } = periodRange("all", now, 0, at(2024, 5, 7, 11));
    expect(from).toBe(at(2024, 5, 7)); // that DAY's start, not that instant
    expect(to).toBe(at(2026, 8, 25)); // end of today, so today's work counts
  });

  it("collapses to today when nothing has been recorded at all", () => {
    // An empty ledger must not open a window at the epoch: every month between
    // 1970 and now would be charted as a month nothing was earned in.
    expect(periodRange("all", now, 0, Infinity))
      .toEqual({ from: at(2026, 8, 24), to: at(2026, 8, 25) });
  });

  it("cannot be stepped, because there is exactly one of it", () => {
    const first = at(2024, 5, 7);
    expect(periodRange("all", now, -3, first)).toEqual(periodRange("all", now, 0, first));
    expect(periodRange("all", now, 2, first)).toEqual(periodRange("all", now, 0, first));
  });

  it("starts where the money starts, not only where the clock does", () => {
    // A project paid per accepted item earns on days holding no session, so a
    // window opened from sessions alone would cut off its earliest income.
    const sessions = [{ segments: [seg(at(2025, 0, 10), at(2025, 0, 10, 2))] }];
    expect(firstRecord(sessions, [{ at: at(2024, 5, 7, 12) }])).toBe(at(2024, 5, 7, 12));
    expect(firstRecord(sessions)).toBe(at(2025, 0, 10));
    expect(firstRecord([], [])).toBe(Infinity);
  });

  it("charts by calendar month, tiling the span exactly", () => {
    const first = at(2026, 5, 15); // mid-June: the record starts mid-month
    const buckets = bucketsFor("all", now, 0, first);
    const { from, to } = periodRange("all", now, 0, first);
    expect(buckets[0].from).toBe(from);
    expect(buckets.at(-1).to).toBe(to);
    for (let i = 1; i < buckets.length; i += 1) {
      expect(buckets[i].from).toBe(buckets[i - 1].to); // no gap, no overlap
    }
    expect(buckets.map((b) => b.label)).toEqual(["Jun", "Jul", "Aug", "Sep"]);
  });

  it("marks the years instead of repeating month names it cannot place", () => {
    // Twenty-eight bars reading Jan..Dec..Jan..Dec say nothing about WHICH
    // January, so on a span of years each January carries its year instead.
    const buckets = bucketsFor("all", now, 0, at(2024, 5, 7));
    expect(buckets.filter((b) => b.major).map((b) => b.label))
      .toEqual(["2024", "2025", "2026"]);
    expect(buckets.find((b) => b.label === "Mar").major).toBe(false);
  });

  it("sums every year of work into one figure", () => {
    const sessions = [
      session(at(2024, 5, 7, 9), at(2024, 5, 7, 11)),
      session(at(2025, 2, 3, 9), at(2025, 2, 3, 12)),
      session(at(2026, 8, 1, 9), at(2026, 8, 1, 13)),
    ];
    const { from, to } = periodRange("all", now, 0, firstRecord(sessions));
    const r = performanceIn(sessions, from, to, now);
    expect(r.billedMs).toBe(9 * HOUR);
    expect(r.billedCents.USD).toBe(90_000); // 9h at 100/hr
  });
});

describe("which work was actually worth the time", () => {
  const row = (name, hours, dollars, extra = {}) => ({
    project: { id: name, name, currency: "USD" },
    billedMs: hours * HOUR, idleMs: 0, billedMsByCurrency: { USD: hours * HOUR },
    billedCents: { USD: Math.round(dollars * 100) },
    pendingCents: {}, timedCents: { USD: Math.round(dollars * 100) },
    ...extra,
  });

  it("ranks by what an hour came to, not by how much was earned", () => {
    // The biggest earner is not the best-paid hour, and only one of those
    // answers "which of these should I take more of".
    const rows = [row("big", 300, 16_849), row("small", 23, 2_164)];
    expect(worthPerHour(rows, "USD").map((r) => r.project.name)).toEqual(["small", "big"]);
    expect(worthPerHour(rows, "USD")[0].perHour).toBe(Math.round(216_400 / 23));
  });

  it("leaves out anything too short to mean anything", () => {
    // Six minutes that happened to pay $50 is $500/hr as arithmetic and noise
    // as a finding — and ranking would put it first, where the eye goes.
    const rows = [row("real", 20, 400), row("blip", 0.1, 50)];
    expect(worthPerHour(rows, "USD").map((r) => r.project.name)).toEqual(["real"]);
  });

  it("holds the floor high enough that one untimed payment cannot top the list", () => {
    // Taken from the real ledger: 1h40m of work that also collected $49.93 of
    // money no clock measured reads as $106/hr and outranks everything.
    const rows = [row("beacon", 1.67, 176.30), row("orion", 291, 16_848)];
    expect(worthPerHour(rows, "USD").map((r) => r.project.name)).toEqual(["orion"]);
    // and it is a floor on TIME, so a short row still counts if asked for
    expect(worthPerHour(rows, "USD", HOUR).map((r) => r.project.name)[0]).toBe("beacon");
  });

  it("leaves out work that earned nothing, which has no rate to rank", () => {
    const rows = [row("paid", 10, 200), row("unpaid", 10, 0)];
    expect(worthPerHour(rows, "USD").map((r) => r.project.name)).toEqual(["paid"]);
  });

  it("names the largest share of the money and how large it is", () => {
    const rows = [row("orion", 291, 16_849), row("a", 40, 3_487), row("b", 23, 2_164)];
    const c = concentration(rows, "USD");
    expect(c.row.project.name).toBe("orion");
    expect(Math.round(c.share * 100)).toBe(75);
  });

  it("says nothing where there is no money, or no one currency", () => {
    expect(concentration([], "USD")).toBeNull();
    expect(concentration([row("a", 5, 0)], "USD")).toBeNull();
    expect(concentration([row("a", 5, 10)], null)).toBeNull();
  });

  it("ranks a row by the hours worked in the ranking's currency, not all of its hours", () => {
    // Ten dollar hours paid $500; the row's six pound hours earned none of it.
    const mixed = row("mixed", 16, 500, { billedMsByCurrency: { USD: 10 * HOUR, EGP: 6 * HOUR } });
    expect(worthPerHour([mixed], "USD")[0].perHour).toBe(50_00);
    // and the floor is on those hours too: three dollar hours are not five
    const thin = row("thin", 9, 300, { billedMsByCurrency: { USD: 3 * HOUR, EGP: 6 * HOUR } });
    expect(worthPerHour([thin], "USD")).toEqual([]);
  });
});

describe("where a project's goal stands", () => {
  // The week of Mon 5 Oct 2026, read on the Wednesday.
  const from = at(2026, 9, 5);
  const to = at(2026, 9, 12);
  const now = at(2026, 9, 7, 12);
  const alpha = { id: "p1", name: "Alpha", currency: "USD", currentRate: 60 };
  const money = { type: "money", target: 500, period: "week" };
  const time = { type: "time", target: 600, period: "week" };
  const earning = (cents, when, extra = {}) => ({
    id: `e${cents}`, projectId: "p1", kind: "bonus", cents, currency: "USD", at: when,
    note: "", createdAt: when, deletedAt: null, ...extra,
  });
  const work = [session(at(2026, 9, 5, 9), at(2026, 9, 5, 11), { rate: 60 })]; // $120

  it("counts the settled money no clock measured, as the headline does", () => {
    // Alpha's week read $120 of $500 with a $60 bonus left out.
    const earnings = [
      earning(6_000, at(2026, 9, 6, 12)),                          // counts
      earning(10_000, at(2026, 9, 6, 13), { status: "pending" }),  // waiting: not yet
      earning(3_000, at(2026, 9, 6, 14), { status: "cancelled" }), // never
      earning(4_000, at(2026, 8, 30, 12)),                         // last week
    ];
    expect(goalValue(money, alpha, work, earnings, from, to, now)).toBe(180);
  });

  it("lets a project paid per accepted item move its money goal", () => {
    const piece = { ...alpha, currentRate: 0, perTask: 50 };
    expect(goalValue(money, piece, [], [earning(15_000, at(2026, 9, 6, 12))], from, to, now)).toBe(150);
  });

  it("counts the project's own currency only", () => {
    const pounds = earning(30_000, at(2026, 9, 6, 12), { currency: "EGP" });
    expect(goalValue(money, alpha, work, [pounds], from, to, now)).toBe(120);
  });

  it("leaves clock money still waiting on an answer out, and its hours in", () => {
    const waiting = [session(at(2026, 9, 5, 9), at(2026, 9, 5, 11), { rate: 60, status: "pending" })];
    expect(goalValue(money, alpha, waiting, [], from, to, now)).toBe(0);
    expect(goalValue(time, alpha, waiting, [], from, to, now)).toBe(120);
  });

  it("reads a time goal in minutes, which money with no hours cannot move", () => {
    expect(goalValue(time, alpha, work, [earning(6_000, at(2026, 9, 6, 12))], from, to, now)).toBe(120);
  });
});

describe("two currencies in one period", () => {
  // The week from the review: $40 and EGP 300 on Tuesday, $30 on Wednesday.
  // Three dollar hours and one pound hour.
  const from = at(2026, 9, 5);
  const to = at(2026, 9, 12);
  const sessions = [
    session(at(2026, 9, 6, 9), at(2026, 9, 6, 11), { rate: 20 }),
    session(at(2026, 9, 6, 12), at(2026, 9, 6, 13), { rate: 300, currency: "EGP", projectId: "e" }),
    session(at(2026, 9, 7, 9), at(2026, 9, 7, 10), { rate: 30, projectId: "u2" }),
  ];
  const week = performanceIn(sessions, from, to, at(2026, 9, 7, 18));

  it("keeps the hours apart by the currency they were worked in", () => {
    expect(week.billedMsByCurrency).toEqual({ USD: 3 * HOUR, EGP: HOUR });
    expect(week.billedMs).toBe(4 * HOUR);
    // idle time earns in no currency, so it is in none of them
    const idle = session(at(2026, 9, 8, 9), at(2026, 9, 8, 10), { kind: KIND.IDLE });
    expect(performanceIn([...sessions, idle], from, to, at(2026, 9, 8, 18)).billedMsByCurrency)
      .toEqual({ USD: 3 * HOUR, EGP: HOUR });
  });

  it("leads with the currency the work was in, not the bigger number", () => {
    // EGP 300 is a bigger figure than $70 and a quarter of the hours.
    expect(currenciesByValue(week.billedCents).map(([c]) => c)).toEqual(["EGP", "USD"]);
    expect(currenciesByWork(week)).toEqual([["USD", 7_000], ["EGP", 30_000]]);
  });

  it("puts money no clock measured after the hours, biggest first", () => {
    const totals = { billedCents: { USD: 7_000, EUR: 50_000, GBP: 90_000 }, billedMsByCurrency: { USD: HOUR } };
    expect(currenciesByWork(totals).map(([c]) => c)).toEqual(["USD", "GBP", "EUR"]);
  });

  it("quotes an hour in each currency over that currency's hours alone", () => {
    // Never EGP 300 divided by all four hours, which read "EGP 75.00/hr".
    const rates = hourlyRates(week);
    expect(rates.map((r) => [r.currency, r.rateCents])).toEqual([["USD", 2_333], ["EGP", 30_000]]);
  });

  it("has no hour to quote for money with no hours, and nothing an hour for hours with no money", () => {
    const totals = performanceIn(
      [session(at(2026, 9, 6, 9), at(2026, 9, 6, 11), { status: "cancelled" })], from, to, at(2026, 9, 7),
      undefined, [{ projectId: "p1", cents: 5_000, currency: "EUR", at: at(2026, 9, 6, 12) }]);
    expect(hourlyRates(totals).map((r) => [r.currency, r.rateCents])).toEqual([["USD", 0]]);
  });

  it("gives a company's hour over that currency's hours only", () => {
    // Settled dollars, and pound hours that were rejected: the dollars were
    // earned in the dollar hours.
    const rows = byCompany([{ id: "p1", name: "a", currency: "USD", company: "Northwind" },
      { id: "e", name: "b", currency: "EGP", company: "Northwind" }], [
      session(at(2026, 9, 6, 9), at(2026, 9, 6, 11)),
      session(at(2026, 9, 6, 12), at(2026, 9, 6, 14), { currency: "EGP", rate: 300, projectId: "e", status: "cancelled" }),
    ], from, to, at(2026, 9, 7));
    expect(rows[0].currency).toBe("USD");
    expect(rows[0].rateCents).toBe(100_00);
  });
});
