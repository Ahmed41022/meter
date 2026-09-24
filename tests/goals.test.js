import { describe, it, expect } from "vitest";
import {
  periodStart, periodBoundary, goalProgress, isGoalMet, normaliseGoal, inPeriod,
  dayEnds, pace, paceGoal, paceState,
} from "../src/domain/goals.js";

describe("period boundaries", () => {
  it("starts weeks on Monday at local midnight", () => {
    const wed = new Date(2024, 4, 15, 14, 30).getTime(); // Wed 15 May 2024
    const start = new Date(periodStart("week", wed));
    expect(start.getDay()).toBe(1);
    expect(start.getDate()).toBe(13);
    expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0]);
  });

  it("treats Sunday as the end of the week, not the start", () => {
    const sun = new Date(2024, 4, 19, 10, 0).getTime();
    expect(new Date(periodStart("week", sun)).getDate()).toBe(13);
  });

  it("does not move the boundary when the week is already Monday", () => {
    const mon = new Date(2024, 4, 13, 9, 0).getTime();
    expect(new Date(periodStart("week", mon)).getDate()).toBe(13);
  });

  it("starts months on the 1st at local midnight", () => {
    const start = new Date(periodStart("month", new Date(2024, 4, 15, 14, 30).getTime()));
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(4);
    expect(start.getHours()).toBe(0);
  });

  it("returns the epoch for a lifetime goal so nothing is filtered out", () => {
    expect(periodStart("lifetime", Date.now())).toBe(0);
  });

  it("starts the week at midnight even when a day in it has no midnight", () => {
    // Regression: some zones spring forward AT 00:00 (Africa/Cairo did on
    // 24 Apr 2026), so `setHours(0,0,0,0)` normalises to 01:00. Carrying that
    // hour into the day-of-week subtraction put the start of the week an hour
    // late, and work done just after midnight on the Monday fell outside the
    // period. Boundaries are built from calendar fields now, so it cannot.
    for (const day of [20, 21, 22, 23, 24, 25, 26]) {
      const start = new Date(periodStart("week", new Date(2026, 3, day, 13, 30).getTime()));
      expect(start.getDay()).toBe(1);
      expect(start.getDate()).toBe(20);
      expect([start.getHours(), start.getMinutes()]).toEqual([0, 0]);
    }
  });

  it("steps whole periods without drifting off the boundary", () => {
    const t = new Date(2026, 8, 24, 13, 45).getTime();
    expect(periodBoundary("week", t, 0)).toBe(periodStart("week", t));
    // A month back from the 31st must not overflow into the following month.
    const back = new Date(periodBoundary("month", new Date(2026, 2, 31, 12).getTime(), -1));
    expect([back.getMonth(), back.getDate()]).toEqual([1, 1]);
  });

  it("buckets a day at local midnight", () => {
    const start = new Date(periodStart("day", new Date(2026, 8, 24, 13, 45).getTime()));
    expect(start.getDate()).toBe(24);
    expect(start.getHours()).toBe(0);
  });

  it("lands on local midnight even across a DST transition", () => {
    // Egypt reintroduced DST in 2023. A boundary computed from wall-clock
    // strings would be an hour out; deriving it from a Date is not.
    for (const d of [new Date(2024, 3, 29), new Date(2024, 9, 28)]) {
      const start = new Date(periodStart("week", d.getTime()));
      expect(start.getHours()).toBe(0);
      expect(start.getDay()).toBe(1);
    }
  });
});

describe("progress", () => {
  it("clamps at 100% rather than overflowing the bar", () => {
    expect(goalProgress(150, 100)).toBe(1);
  });

  it("clamps negatives at zero", () => {
    expect(goalProgress(-5, 100)).toBe(0);
  });

  it("treats a zero or missing target as no goal", () => {
    expect(goalProgress(50, 0)).toBe(0);
    expect(goalProgress(50, null)).toBe(0);
    expect(isGoalMet(50, 0)).toBe(false);
  });

  it("marks a goal met on exact equality", () => {
    expect(isGoalMet(100, 100)).toBe(true);
  });
});

describe("goal validation", () => {
  it("rejects empty and non-numeric targets", () => {
    expect(normaliseGoal({ type: "money", target: "" })).toBeNull();
    expect(normaliseGoal({ type: "money", target: "abc" })).toBeNull();
    expect(normaliseGoal({ type: "money", target: -5 })).toBeNull();
    expect(normaliseGoal(null)).toBeNull();
  });

  it("coerces a numeric string from the input field", () => {
    expect(normaliseGoal({ type: "money", target: "500" })).toEqual({ type: "money", target: 500 });
  });
});

describe("period membership", () => {
  const startedAtOf = (s) => s.startedAt;

  it("includes a session started inside the period", () => {
    const now = new Date(2024, 4, 15, 12).getTime();
    const session = { startedAt: new Date(2024, 4, 14, 9).getTime() };
    expect(inPeriod(session, "week", now, startedAtOf)).toBe(true);
  });

  it("excludes a session from the previous period", () => {
    const now = new Date(2024, 4, 15, 12).getTime();
    const session = { startedAt: new Date(2024, 4, 10, 9).getTime() }; // previous week
    expect(inPeriod(session, "week", now, startedAtOf)).toBe(false);
  });

  it("includes everything for a lifetime goal", () => {
    expect(inPeriod({ startedAt: 1 }, "lifetime", Date.now(), startedAtOf)).toBe(true);
  });
});

describe("counting the days of a period", () => {
  const at = (y, m, d, h = 0) => new Date(y, m, d, h).getTime();

  it("counts calendar days, not 24-hour slices", () => {
    // Regression guard: Africa/Cairo sprang forward at 00:00 on 26 Apr 2024,
    // so this week is 167 hours long. Dividing elapsed time by 86,400,000 gives
    // 6.96 days and floors to 6 — the last day of the week would silently stop
    // existing, and every pacing figure derived from it would be wrong.
    const ends = dayEnds(at(2024, 3, 22), at(2024, 3, 29));
    expect(ends).toHaveLength(7);
    expect(at(2024, 3, 29) - at(2024, 3, 22)).toBe(167 * 3_600_000);
  });

  it("tiles the window exactly, with nothing spilling past the end", () => {
    const from = at(2024, 4, 13);
    const to = at(2024, 4, 20);
    const ends = dayEnds(from, to);
    expect(ends[ends.length - 1]).toBe(to);
    // each end is the next one's start, so the days meet without gap or overlap
    const starts = [from, ...ends.slice(0, -1)];
    expect(ends.every((end, i) => end > starts[i])).toBe(true);
  });

  it("counts a 31-day month as 31 days and February as its own length", () => {
    expect(dayEnds(at(2024, 0, 1), at(2024, 1, 1))).toHaveLength(31);
    expect(dayEnds(at(2024, 1, 1), at(2024, 2, 1))).toHaveLength(29); // leap
    expect(dayEnds(at(2023, 1, 1), at(2023, 2, 1))).toHaveLength(28);
  });

  it("has no days at all in an empty or backwards window", () => {
    expect(dayEnds(at(2024, 4, 13), at(2024, 4, 13))).toEqual([]);
    expect(dayEnds(at(2024, 4, 20), at(2024, 4, 13))).toEqual([]);
  });
});

describe("pacing a goal", () => {
  const at = (y, m, d, h = 0) => new Date(y, m, d, h).getTime();
  // The user's real goal: $1,260 a week on a $90/hr project — 14 hours, or
  // $180 a day flat.
  const weekly = { type: "money", target: 1260, period: "week" };
  const wed = at(2024, 4, 15, 14, 30); // Wed of the week Mon 13 – Sun 19

  it("judges the value against the days that have finished", () => {
    // Wednesday afternoon: Monday and Tuesday are done, so two days' worth is
    // what was owed by now. Today is not counted as gone — it is still yours.
    const p = paceGoal(weekly, 360, wed);
    expect(p).toMatchObject({ totalDays: 7, daysDone: 2, daysLeft: 5, expected: 360, drift: 0 });
    expect(paceState(p)).toBe("even");
  });

  it("reports how far off the line the value actually is", () => {
    expect(paceGoal(weekly, 200, wed).drift).toBe(-160);
    expect(paceState(paceGoal(weekly, 200, wed))).toBe("behind");
    expect(paceGoal(weekly, 500, wed).drift).toBe(140);
    expect(paceState(paceGoal(weekly, 500, wed))).toBe("ahead");
  });

  it("says what each remaining day would have to carry", () => {
    // $760 left over Wednesday, Thursday, Friday, Saturday, Sunday.
    expect(paceGoal(weekly, 500, wed).needPerDay).toBe(152);
    // and the same deficit late in the week is a much steeper ask
    const sun = at(2024, 4, 19, 10);
    expect(paceGoal(weekly, 500, sun).needPerDay).toBe(760);
    expect(paceGoal(weekly, 500, sun).daysLeft).toBe(1);
  });

  it("counts today as the first day left, never as a day gone", () => {
    // Otherwise the last day of a period has nothing left to do it in, and the
    // required daily figure divides by zero.
    const sun = at(2024, 4, 19, 23, 59);
    const p = paceGoal(weekly, 1000, sun);
    expect(p.daysLeft).toBe(1);
    expect(p.closed).toBe(false);
    expect(p.needPerDay).toBe(260);
  });

  it("cannot call you behind at the start of a period", () => {
    // Nothing was owed yet. The honest figure this early is what it will take
    // per day, and that is the one `needPerDay` carries.
    const mon = at(2024, 4, 13, 9);
    const p = paceGoal(weekly, 0, mon);
    expect(p).toMatchObject({ daysDone: 0, expected: 0, drift: 0, daysLeft: 7 });
    expect(paceState(p)).toBe("even");
    expect(p.needPerDay).toBe(180);
  });

  it("treats a trivial gap as on pace rather than as news", () => {
    // Being $2 behind on a $1,260 week is true and useless.
    expect(paceState(paceGoal(weekly, 358, wed))).toBe("even");
    expect(paceState(paceGoal(weekly, 352, wed))).toBe("behind");
  });

  it("stops asking for more once the target is met", () => {
    const p = paceGoal(weekly, 1400, wed);
    expect(paceState(p)).toBe("met");
    expect(p).toMatchObject({ remaining: 0, over: 140, needPerDay: null });
  });

  it("calls a finished period missed rather than behind", () => {
    // Monday of the following week: the whole of the last one is spent, and
    // "3 days left" would be a lie about a period that has none.
    const nextMon = at(2024, 4, 20, 9);
    const p = pace({ target: 1260, from: at(2024, 4, 13), to: at(2024, 4, 20) }, 900, nextMon);
    expect(p).toMatchObject({ daysDone: 7, daysLeft: 0, closed: true, needPerDay: null });
    expect(paceState(p)).toBe("missed");
    expect(p.remaining).toBe(360);
  });

  it("paces a month against its own length", () => {
    const monthly = { type: "time", target: 3100, period: "month" };
    const p = paceGoal(monthly, 0, at(2024, 3, 11, 12)); // 11 Apr, a 30-day month
    expect(p.totalDays).toBe(30);
    expect(p.daysDone).toBe(10);
    expect(p.flatPerDay).toBeCloseTo(103.333, 3);
  });

  it("paces a week that loses an hour to DST without losing a day", () => {
    // 26 Apr 2024 was 23 hours long in Africa/Cairo. The week is still seven
    // days, and Friday is still one of them.
    const p = paceGoal(weekly, 0, at(2024, 3, 27, 12)); // Sat 27 Apr
    expect(p.totalDays).toBe(7);
    expect(p.daysDone).toBe(5);
    expect(p.flatPerDay).toBe(180);
  });

  it("has nothing to say about a goal with no end", () => {
    // A lifetime target is not late.
    expect(paceGoal({ type: "money", target: 5000, period: "lifetime" }, 100, wed)).toBeNull();
    expect(paceState(null)).toBeNull();
  });

  it("has nothing to say without a target", () => {
    expect(paceGoal(null, 100, wed)).toBeNull();
    expect(paceGoal({ type: "money", target: 0, period: "week" }, 100, wed)).toBeNull();
    expect(paceGoal({ type: "money", target: "", period: "week" }, 100, wed)).toBeNull();
  });

  it("reads a target typed as a string, like the input field gives it", () => {
    expect(paceGoal({ type: "money", target: "1260", period: "week" }, 360, wed).flatPerDay).toBe(180);
  });
});
