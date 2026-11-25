/**
 * What is left of the day for a goal (hoursLeft.js, projectGoal.js), the day
 * that turns over at `dayEndsAt` (goals.js `turn`, workGoals.js), and how it is
 * said (ui/goals/words.js). Pure: no page. TZ is Africa/Cairo (vitest config),
 * which springs forward at midnight on 24 Apr 2026 and falls back at the end of
 * 29 Oct 2026.
 */
import { describe, expect, it } from "vitest";
import { dayEnds, pace, periodBoundary, weekdayOf } from "../src/domain/goals.js";
import { dayLeft, dayTurn, metersOn, recentRate, todayOf } from "../src/domain/hoursLeft.js";
import { projectGoalStanding } from "../src/domain/projectGoal.js";
import {
  addGoal, editGoal, goalResults, goalStanding, pauseGoal, resumeGoal, termsAt,
} from "../src/domain/workGoals.js";
import { setPref } from "../src/domain/prefs.js";
import { clockOfMinutes, leftWords, todayTone, todayWords } from "../src/ui/goals/words.js";

const M = 60_000;
const H = 3_600_000;
/** Local time in 2026, month counted from 1. 2 Nov is a Monday. */
const at = (mo, d, h = 12, mi = 0) => new Date(2026, mo - 1, d, h, mi).getTime();
const ALL = [1, 2, 3, 4, 5, 6, 7];

const P = (id, extra = {}) => ({ id, name: id.toUpperCase(), currentRate: 10, currency: "USD", createdAt: 1, ...extra });
const projects = [P("a", { company: "Alignerr" }), P("b", { company: "alignerr " }), P("c"), P("life", { offClock: true })];
let n = 0;
const S = (projectId, from, to, extra = {}) => ({
  id: `s${++n}`, projectId, taskId: null, kind: "billed", rate: 10, currency: "USD", createdAt: from,
  segments: [{ startedAt: from, endedAt: to }], closedAt: to, deletedAt: null, ...extra,
});
/** A meter that started at `from` and is still running. */
const R = (projectId, from, extra = {}) => ({
  id: `r${++n}`, projectId, taskId: null, kind: "billed", rate: 10, currency: "USD", createdAt: from,
  segments: [{ startedAt: from, endedAt: null, lastTick: from }], closedAt: null, deletedAt: null, ...extra,
});
const mk = (o = {}) => ({
  id: "g", type: "time", period: "day", scope: { kind: "all" },
  terms: [{ from: at(10, 1, 0), target: 360, days: ALL }], order: 0, pauses: [], createdAt: 1, deletedAt: null, ...o,
});
const ctx = (sessions, now, endsAt = 0, extra = {}) => ({
  projects, sessions, earnings: [], rateOf: (s) => s.rate, now, endsAt, ...extra,
});
const stand = (goal, sessions, now, endsAt = 0, extra) => goalStanding(goal, ctx(sessions, now, endsAt, extra));
const F = (extra = {}) => ({ type: "time", target: 360, period: "day", scope: { kind: "all" }, days: ALL, ...extra });

describe("the turn, where there is none", () => {
  it("leaves every boundary as it was: no turn is a turn of 0", () => {
    const starts = [at(4, 18, 0), at(10, 24, 0), at(12, 28, 0)];
    let checked = 0;
    const differ = [];
    for (const start of starts) {
      for (let t = start; t < start + 15 * 24 * H; t += 53 * M) {
        for (const p of ["day", "week", "month", "year", "lifetime"]) {
          for (const k of [-2, -1, 0, 1, 2]) {
            if (periodBoundary(p, t, k) !== periodBoundary(p, t, k, 0)) differ.push([p, t, k]);
            checked++;
          }
        }
      }
    }
    expect(differ).toEqual([]);
    expect(checked).toBeGreaterThan(10_000);
    const [from, to] = [at(11, 2, 0), at(11, 9, 0)];
    expect(dayEnds(from, to)).toEqual(dayEnds(from, to, 0));
    expect(weekdayOf(at(11, 4, 1))).toBe(weekdayOf(at(11, 4, 1), 0));
    const p = { target: 70, from, to };
    expect(pace(p, 10, at(11, 4))).toEqual(pace({ ...p, turn: 0 }, 10, at(11, 4)));
  });

  it("holds for any turn: an instant is inside its own period, and a boundary starts the one it begins", () => {
    const broken = [];
    for (const turn of [60, 180, 720]) {
      for (let t = at(4, 20, 0); t < at(4, 29, 0); t += 71 * M) {
        for (const p of ["day", "week", "month", "year"]) {
          const a = periodBoundary(p, t, 0, turn);
          const b = periodBoundary(p, t, 1, turn);
          const ok = a <= t && t < b && periodBoundary(p, b, 0, turn) === b
            && periodBoundary(p, a, 0, turn) === a && periodBoundary(p, a - 1, 1, turn) === a;
          if (!ok) broken.push([turn, p, t]);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("the minutes around the turn", () => {
  it("is still the day before at 2:59, and the day itself from 3:00", () => {
    const turn = 180;
    const tue = (h, m) => at(11, 3, h, m);
    expect(periodBoundary("day", tue(2, 59), 0, turn)).toBe(at(11, 2, 3));
    expect(periodBoundary("day", tue(2, 59), 1, turn)).toBe(at(11, 3, 3));
    for (const [h, m] of [[3, 0], [3, 1]]) {
      expect(periodBoundary("day", tue(h, m), 0, turn)).toBe(at(11, 3, 3));
      expect(periodBoundary("day", tue(h, m), 1, turn)).toBe(at(11, 4, 3));
    }
    expect(periodBoundary("day", tue(2, 59), 0, turn)).toBeLessThan(tue(2, 59));
    expect(weekdayOf(tue(2, 59), turn)).toBe(1); // Monday's night
    expect(weekdayOf(tue(3, 0), turn)).toBe(2);
    expect(weekdayOf(tue(3, 1), turn)).toBe(2);
    expect(weekdayOf(tue(2, 59))).toBe(2); // no turn: Tuesday
  });

  it("says how long is left, down to the last minute, and that the day has turned", () => {
    const left = (h, m) => dayLeft(at(11, 3, h, m), 180);
    expect(left(2, 59)).toMatchObject({ from: at(11, 2, 3), to: at(11, 3, 3), until: at(11, 3, 3), leftMs: M, over: false });
    expect(left(3, 0)).toMatchObject({ from: at(11, 3, 3), to: at(11, 4, 3), leftMs: 24 * H, over: false });
    expect(left(3, 1).leftMs).toBe(24 * H - M);
  });

  it("starts a week and a month at the turn: Sunday night belongs to the week that ends", () => {
    const turn = 180;
    // Sun 8 Nov into Mon 9 Nov.
    expect(periodBoundary("week", at(11, 9, 2), 0, turn)).toBe(at(11, 2, 3));
    expect(periodBoundary("week", at(11, 9, 2), 1, turn)).toBe(at(11, 9, 3));
    expect(periodBoundary("week", at(11, 9, 3), 0, turn)).toBe(at(11, 9, 3));
    expect(periodBoundary("week", at(11, 9, 3), 1, turn)).toBe(at(11, 16, 3));
    expect(weekdayOf(at(11, 9, 2), turn)).toBe(7);
    // Mon 30 Nov into Tue 1 Dec, and Sun 1 Nov at 2 AM is still October.
    expect(periodBoundary("month", at(12, 1, 2), 0, turn)).toBe(at(11, 1, 3));
    expect(periodBoundary("month", at(12, 1, 2), 1, turn)).toBe(at(12, 1, 3));
    expect(periodBoundary("month", at(12, 1, 3), 0, turn)).toBe(at(12, 1, 3));
    expect(periodBoundary("month", at(11, 1, 2), 0, turn)).toBe(at(10, 1, 3));
    expect(periodBoundary("year", at(1, 1, 2), 0, turn)).toBe(new Date(2025, 0, 1, 3).getTime());
    expect(periodBoundary("year", at(1, 1, 3), 0, turn)).toBe(new Date(2026, 0, 1, 3).getTime());
  });
});

describe("daylight saving in Cairo", () => {
  it("has days of 23 and 25 hours that are still one day each, with and without a turn", () => {
    // Spring forward: midnight of 24 Apr does not exist.
    expect(periodBoundary("day", at(4, 24, 12), 0)).toBe(new Date(2026, 3, 24).getTime());
    expect(new Date(periodBoundary("day", at(4, 24, 12), 0)).getHours()).toBe(1);
    for (const turn of [0, 180]) {
      const from = periodBoundary("week", at(4, 22), 0, turn);
      const to = periodBoundary("week", at(4, 22), 1, turn);
      const ends = dayEnds(from, to, turn);
      expect(ends).toHaveLength(7);
      expect(ends.at(-1)).toBe(to);
      expect(ends.map((e) => weekdayOf(e - 1, turn))).toEqual([1, 2, 3, 4, 5, 6, 7]);
      const days = ends.map((e, i) => (e - (ends[i - 1] ?? from)) / H);
      expect(days.reduce((a, b) => a + b, 0)).toBe(7 * 24 - 1);
      expect(days.filter((d) => d !== 24)).toEqual([23]);
      expect(pace({ target: 700, from, to, turn }, 0, at(4, 25, 12)).totalDays).toBe(7);
    }
  });

  it("does the same where the hour is repeated, and tells the two 23:30s apart as one day", () => {
    for (const turn of [0, 180]) {
      const from = periodBoundary("week", at(10, 28), 0, turn);
      const to = periodBoundary("week", at(10, 28), 1, turn);
      const ends = dayEnds(from, to, turn);
      expect(ends).toHaveLength(7);
      const days = ends.map((e, i) => (e - (ends[i - 1] ?? from)) / H);
      expect(days.filter((d) => d !== 24)).toEqual([25]);
      expect(ends.map((e) => weekdayOf(e - 1, turn))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    }
    // 23:30 on Thursday 29 Oct happens twice, an hour apart.
    const first = at(10, 29, 23, 30);
    expect(weekdayOf(first)).toBe(4);
    expect(weekdayOf(first + H)).toBe(4);
    expect(weekdayOf(first + H + 31 * M)).toBe(5);
    // With a turn, 00:30 on the 30th (second pass, +02) is still Thursday's night.
    expect(weekdayOf(first + H + M * 60, 180)).toBe(4);
    expect(dayLeft(first + 2 * H, 180).leftMs).toBeGreaterThan(0);
  });
});

describe("noon and the evening", () => {
  it("is a turn at noon exactly, and an evening cut-off one minute after", () => {
    expect(dayTurn(0)).toBe(0);
    expect(dayTurn(1)).toBe(1);
    expect(dayTurn(720)).toBe(720);
    expect(dayTurn(721)).toBe(0);
    expect(dayTurn(1380)).toBe(0);
    expect(dayLeft(at(11, 3, 11, 59), 720)).toMatchObject({ from: at(11, 2, 12), to: at(11, 3, 12), leftMs: M });
    expect(dayLeft(at(11, 3, 12, 0), 720)).toMatchObject({ from: at(11, 3, 12), to: at(11, 4, 12), leftMs: 24 * H });
    // 12:01 is an evening: the day starts at midnight, and is out at 12:01.
    const d = dayLeft(at(11, 3, 12, 0), 721);
    expect(d).toMatchObject({ from: at(11, 3, 0), to: at(11, 4, 0), until: at(11, 3, 12, 1), leftMs: M, over: false });
    expect(dayLeft(at(11, 3, 12, 1), 721)).toMatchObject({ leftMs: 0, over: true });
  });

  it("calls none of an evening day left after the cut-off, though it goes on until midnight", () => {
    const end = 23 * 60;
    expect(dayLeft(at(11, 3, 22, 59), end)).toMatchObject({ leftMs: M, over: false });
    expect(dayLeft(at(11, 3, 23, 0), end)).toMatchObject({ leftMs: 0, over: true, to: at(11, 4, 0) });
    expect(dayLeft(at(11, 3, 23, 59), end)).toMatchObject({ leftMs: 0, over: true, from: at(11, 3, 0) });
    expect(dayLeft(at(11, 4, 0, 0), end)).toMatchObject({ from: at(11, 4, 0), over: false, leftMs: 23 * H });
    expect(dayLeft(at(11, 3, 12), 0)).toMatchObject({ until: at(11, 4, 0), leftMs: 12 * H, over: false });
  });
});

describe("a day's goal and what is left of the day", () => {
  const daily = mk({ terms: [{ from: at(10, 1, 0), target: 100, days: ALL }] });
  it("counts work until the turn for the day before, and from it for the new one", () => {
    const night = S("a", at(11, 3, 1), at(11, 3, 2));
    const before = stand(daily, [night], at(11, 3, 2, 59), 180);
    expect([before.value, before.from, before.today.leftMs]).toEqual([60, at(11, 2, 3), M]);
    const after = stand(daily, [night], at(11, 3, 3, 0), 180);
    expect([after.value, after.from, after.today.leftMs]).toEqual([0, at(11, 3, 3), 24 * H]);
    // The same work with no turn: Tuesday's, all day.
    expect(stand(daily, [night], at(11, 3, 2, 59), 0).value).toBe(60);
    expect(stand(daily, [night], at(11, 3, 3, 30), 0).value).toBe(60);
    expect(stand(daily, [night], at(11, 3, 3, 30), 180).value).toBe(0);
  });

  it("takes the weekday of the logical day for days off", () => {
    const weekdays = mk({ terms: [{ from: at(10, 1, 0), target: 100, days: [1, 2, 3, 4, 5] }] });
    const off = (d, h, m, e) => stand(weekdays, [], at(11, d, h, m), e).off;
    expect(off(7, 1, 0, 180)).toBe(false); // Sat 01:00 is Friday's night
    expect(off(7, 2, 59, 180)).toBe(false);
    expect(off(7, 3, 0, 180)).toBe(true);
    expect(off(7, 1, 0, 0)).toBe(true);
    expect(off(9, 1, 0, 180)).toBe(true); // Mon 01:00 is Sunday's
    expect(off(9, 3, 0, 180)).toBe(false);
    expect(stand(weekdays, [], at(11, 7, 3), 180).today).toBeNull();
    expect(stand(weekdays, [], at(11, 7, 1), 180).today).not.toBeNull();
  });

  it("is short, tight or fits by what is left, at the edges", () => {
    // 100 minutes left of the day at 22:20.
    const state = (target, now = at(11, 3, 22, 20), sessions = []) => stand(
      mk({ terms: [{ from: at(10, 1, 0), target, days: ALL }] }), sessions, now).today.state;
    expect(state(100)).toBe("tight"); // exactly what is left is not more than it
    expect(state(101)).toBe("short");
    expect(state(81)).toBe("tight");
    expect(state(80)).toBe("fits"); // exactly four fifths is not over four fifths
    expect(state(100, at(11, 3, 22, 19))).toBe("tight");
    expect(state(100, at(11, 3, 22, 21))).toBe("short");
    expect(state(100, at(11, 3, 12))).toBe("fits");
    expect(state(100, at(11, 3, 23, 59))).toBe("short");
    // Worked part of it already: 30 done, 70 to go: fits in 100 minutes, not in 30.
    expect(state(100, at(11, 3, 22, 20), [S("a", at(11, 3, 9), at(11, 3, 9, 30))])).toBe("fits");
    expect(state(100, at(11, 3, 23, 30), [S("a", at(11, 3, 9), at(11, 3, 9, 30))])).toBe("short");
  });

  it("is over once the day is, with the evening's end", () => {
    const s = (h, m, sessions = []) => stand(daily, sessions, at(11, 3, h, m), 23 * 60).today;
    expect(s(22, 30).state).toBe("short");
    expect(s(23, 0)).toMatchObject({ state: "over", toGo: 100, endsAt: 1380 });
    // Work after the cut-off still counts for the day, and can still finish it.
    const late = [S("a", at(11, 3, 23, 10), at(11, 3, 23, 20))];
    expect(stand(daily, late, at(11, 3, 23, 30), 1380).value).toBe(10);
    expect(stand(daily, late, at(11, 3, 23, 30), 1380).today.toGo).toBe(90);
    expect(stand(daily, [], at(11, 4, 0, 10), 1380).today).toMatchObject({ state: "fits", endsAt: 1380 });
    expect(stand(daily, [], at(11, 4, 0, 10), 1380).today.leftMs).toBe(22 * H + 50 * M);
  });

  it("turns at noon exactly", () => {
    const work = [S("a", at(11, 3, 11, 30), at(11, 3, 11, 45))];
    expect(stand(daily, work, at(11, 3, 11, 59), 720).value).toBe(15);
    expect(stand(daily, work, at(11, 3, 12, 0), 720).value).toBe(0);
    expect(stand(daily, work, at(11, 3, 12, 0), 720).from).toBe(at(11, 3, 12));
  });
});

describe("todayOf, by itself", () => {
  const day = (leftMin, extra = {}) => ({ leftMs: leftMin * M, over: false, endsAt: 0, to: Infinity, ...extra });
  const base = { type: "time", target: 100, value: 0, now: 0 };
  const week = (extra = {}) => ({ met: false, closed: false, daysLeft: 4, remaining: 500, ...extra });

  it("is nothing for a goal that is met, closed or out of days, or whose share is nothing", () => {
    for (const pacing of [week({ met: true }), week({ closed: true }), week({ daysLeft: 0 })]) {
      expect(todayOf({ ...base, target: 600, pacing, day: day(600) })).toBeNull();
    }
    expect(todayOf({ ...base, target: 0, day: day(600) })).toBeNull();
    // More than the target was done before today: nothing is asked of it.
    expect(todayOf({ ...base, target: 100, value: 200, valueToday: 0, pacing: week({ daysLeft: 2 }), day: day(600) })).toBeNull();
  });

  it("says done, over, short, tight, fits and open, with the edges", () => {
    const st = (extra, d = day(100)) => todayOf({ ...base, day: d, ...extra }).state;
    expect(st({ value: 100 })).toBe("done");
    expect(st({ value: 150 })).toBe("done");
    expect(st({ value: 100 }, day(0, { over: true }))).toBe("done");
    expect(st({ value: 10 }, day(0, { over: true }))).toBe("over");
    expect(st({ target: 80 })).toBe("fits");
    expect(st({ target: 80.5 })).toBe("tight");
    expect(st({ target: 100 })).toBe("tight");
    expect(st({ target: 100.5 })).toBe("short");
    expect(st({ type: "money", perHour: null })).toBe("open");
    expect(st({ type: "money", perHour: null }, day(0, { over: true }))).toBe("over");
  });

  it("keeps a week's share where the day started, and moves what cannot fit to the days after", () => {
    // 600 for the week, 100 done before today, four days to go: 125 a day.
    const t = (done, left, extra = {}) => todayOf({
      type: "time", target: 600, value: 100 + done, valueToday: done, now: 0, day: day(left),
      pacing: week({ remaining: 500 - done }), ...extra,
    });
    expect(t(0, 600)).toMatchObject({ kind: "share", share: 125, done: 0, toGo: 125, state: "fits", then: 125 });
    expect(t(30, 600)).toMatchObject({ share: 125, done: 30, toGo: 95, then: 125 });
    expect(t(125, 600)).toMatchObject({ share: 125, toGo: 0, state: "done", then: 125 });
    expect(t(200, 600)).toMatchObject({ share: 125, toGo: 0, state: "done", then: 100 });
    // Only 50 minutes fit: the other 75 are asked of the three days after.
    expect(t(0, 50)).toMatchObject({ state: "short", then: 150 });
    // The day is over: all of what is left is asked of the rest.
    expect(t(30, 0, { day: day(0, { over: true }) })).toMatchObject({ state: "over", toGo: 95, then: (470 - 0) / 3 });
    // The last day has no days after it.
    expect(t(0, 600, { pacing: week({ daysLeft: 1, remaining: 500 }) }).then).toBeNull();
    expect(todayOf({ ...base, day: day(10) }).then).toBeNull();
  });

  it("holds as many minutes as there are meters on it", () => {
    const st = (meters, left = 100, target = 150) => todayOf({ ...base, target, meters, day: day(left) }).state;
    expect(st(0)).toBe("short");
    expect(st(1)).toBe("short");
    expect(st(2)).toBe("fits"); // 200 held, and 150 is no more than 160
    expect(st(2, 100, 161)).toBe("tight");
    expect(st(2, 100, 201)).toBe("short");
    expect(todayOf({ ...base, target: 150, meters: 2, day: day(60) }).then).toBeNull();
  });

  it("finishes at the time a running covered time goal would be met, and only before the day turns", () => {
    const now = at(11, 3, 9);
    const f = (extra) => todayOf({ ...base, target: 60, now, day: day(600, { to: at(11, 4, 0) }), ...extra }).finishAt;
    expect(f({ meters: 1 })).toBe(now + 60 * M);
    expect(f({ meters: 2 })).toBe(now + 30 * M);
    expect(f({ meters: 0 })).toBeNull();
    expect(f({ meters: 1, value: 60 })).toBeNull();
    expect(f({ meters: 1, pacing: week({ daysLeft: 2 }) })).toBeNull();
    expect(f({ meters: 1, type: "money", perHour: 30 })).toBeNull();
    expect(f({ meters: 1, now: at(11, 3, 23, 30) })).toBeNull(); // 00:30 is tomorrow
    expect(f({ meters: 1, now: at(11, 3, 22, 59) })).toBe(at(11, 3, 22, 59) + 60 * M);
  });

  it("works from the recent rate for money, or says what an hour would have to earn", () => {
    const m = (extra, left = 120) => todayOf({ ...base, type: "money", target: 50, day: day(left), ...extra });
    expect(m({ perHour: 30 })).toMatchObject({ state: "tight", atRateMs: (50 / 30) * H, needPerHour: null });
    expect(m({ perHour: 40 }).state).toBe("fits");
    expect(m({ perHour: 25 }).state).toBe("tight"); // 50 held, 50 to earn
    expect(m({ perHour: 20 }).state).toBe("short");
    expect(m({ perHour: 30, meters: 2 }).state).toBe("fits");
    expect(m({ perHour: null })).toMatchObject({ state: "open", atRateMs: null, needPerHour: 25 });
    expect(m({ perHour: 0 })).toMatchObject({ state: "open", needPerHour: 25 });
    expect(m({ perHour: null }, 0.5).needPerHour).toBeNull(); // under a minute left
    expect(m({ perHour: null }, 1).needPerHour).toBeCloseTo(3000, 5);
    expect(todayOf({ ...base, day: day(60) }).atRateMs).toBeNull();
  });
});

describe("meters and the rate", () => {
  it("counts running billed meters, and not idle, stopped or deleted ones", () => {
    const t = at(11, 3, 9);
    expect(metersOn([R("a", t), R("b", t), R("a", t, { kind: "idle" }), R("a", t, { deletedAt: 5 }), S("a", t, t + H)])).toBe(2);
    expect(metersOn([])).toBe(0);
  });

  const rate = (sessions, now = at(11, 3, 12)) => recentRate(sessions, [], now, (s) => s.rate, (t) => ({
    value: (t.billedCents.USD ?? 0) / 100, ms: t.billedMsByCurrency.USD ?? 0,
  }));
  it("quotes a rate from at least five hours, and nothing under", () => {
    const w = (hours, day = 28, extra = {}) => S("a", at(10, day, 9), at(10, day, 9) + hours * H, extra);
    expect(rate([w(5)])).toBe(10);
    expect(rate([w(4.99)])).toBeNull();
    expect(rate([w(3), w(2, 29)])).toBe(10);
    expect(rate([w(5, 28, { rate: 0 })])).toBeNull();
    expect(rate([w(5, 28, { rate: 30 })])).toBe(30);
    expect(rate([w(6, 3)])).toBeNull(); // 3 Oct is over 30 days before 3 Nov
    expect(rate([w(6, 5)])).toBe(10);
  });
});

describe("money goals through goalStanding", () => {
  const money = mk({ type: "money", currency: "USD", terms: [{ from: at(10, 1, 0), target: 100, days: ALL }] });
  const now = at(11, 3, 12);
  const six = [S("a", at(10, 28, 9), at(10, 28, 15))];

  it("works out how long the rest takes at the recent rate", () => {
    const { today } = stand(money, six, now);
    expect(today).toMatchObject({ toGo: 100, state: "tight", needPerHour: null });
    expect(today.atRateMs).toBe(10 * H);
  });

  it("asks what an hour would have to earn under five hours of work, or none lately", () => {
    for (const sessions of [[S("a", at(10, 28, 9), at(10, 28, 9) + 5 * H - M)], [], [S("a", at(9, 20, 9), at(9, 20, 20))]]) {
      const { today } = stand(money, sessions, now);
      expect(today).toMatchObject({ state: "open", atRateMs: null });
      expect(today.needPerHour).toBeCloseTo(100 / 12, 6);
    }
    expect(stand(money, [S("a", at(10, 28, 9), at(10, 28, 9) + 5 * H)], now).today.state).toBe("tight");
  });

  it("has no rate where some of the work was in a currency that cannot be counted", () => {
    const mixed = [...six, S("a", at(10, 29, 9), at(10, 29, 15), { currency: "EGP" })];
    const at1 = stand(money, mixed, now);
    expect(at1.today).toMatchObject({ state: "open", atRateMs: null });
    expect(at1.today.needPerHour).toBeGreaterThan(0);
  });

  it("is a rate of the covered work only", () => {
    const company = { ...money, scope: { kind: "company", company: "Alignerr" } };
    expect(stand(company, [S("c", at(10, 28, 9), at(10, 28, 15))], now).today.state).toBe("open");
    expect(stand(company, six, now).today.state).toBe("tight");
  });
});

describe("parallel meters, through goalStanding", () => {
  const now = at(11, 3, 9);
  const daily = (extra) => mk({ terms: [{ from: at(10, 1, 0), target: 60, days: ALL }], ...extra });
  const finish = (goal, sessions, endsAt = 0, t = now) => stand(goal, sessions, t, endsAt).today.finishAt;

  it("multiplies the finish time and what the day holds by the covered meters running", () => {
    expect(finish(daily(), [R("a", now)])).toBe(now + 60 * M);
    expect(finish(daily(), [R("a", now), R("c", now)])).toBe(now + 30 * M);
    expect(finish(daily(), [])).toBeNull();
    // 120 minutes left, 120 to do: tight on one meter, fits on two.
    const two = (sessions) => stand(mk({ terms: [{ from: at(10, 1, 0), target: 120, days: ALL }] }), sessions, at(11, 3, 22)).today.state;
    expect(two([R("a", at(11, 3, 22))])).toBe("tight");
    expect(two([R("a", at(11, 3, 22)), R("c", at(11, 3, 22))])).toBe("fits");
    expect(two([])).toBe("tight");
  });

  it("never counts idle time, life projects, or work the goal does not cover", () => {
    const noise = [R("life", now), R("a", now, { kind: "idle" })];
    expect(finish(daily(), [R("a", now), ...noise])).toBe(now + 60 * M);
    const company = daily({ scope: { kind: "company", company: "Alignerr" } });
    expect(finish(company, [R("a", now), R("c", now), ...noise])).toBe(now + 60 * M);
    expect(finish(company, [R("a", now), R("b", now), R("c", now)])).toBe(now + 30 * M);
    const project = daily({ scope: { kind: "project", projectId: "c" } });
    expect(finish(project, [R("a", now), R("b", now)])).toBeNull();
    expect(finish(project, [R("a", now), R("c", now)])).toBe(now + 60 * M);
  });

  it("gives a finish time for a time goal of a day only, and only before the day turns", () => {
    const weekly = mk({ period: "week", terms: [{ from: at(10, 1, 0), target: 600, days: ALL }] });
    expect(stand(weekly, [R("a", now)], now).today.finishAt).toBeNull();
    const money = mk({ type: "money", currency: "USD", terms: [{ from: at(10, 1, 0), target: 5, days: ALL }] });
    expect(stand(money, [R("a", now)], now).today.finishAt).toBeNull();
    // 23:30 plus an hour is tomorrow, unless the day runs on to 3.
    const late = at(11, 3, 23, 30);
    expect(finish(daily(), [R("a", late)], 0, late)).toBeNull();
    expect(finish(daily(), [R("a", late)], 180, late)).toBe(late + 60 * M);
    // At 02:30 on a day that turns at 3 it is no longer today.
    const night = at(11, 4, 2, 30);
    expect(finish(daily(), [R("a", night)], 180, night)).toBeNull();
    expect(finish(daily(), [R("a", at(11, 4, 1, 59))], 180, at(11, 4, 1, 59))).toBe(at(11, 4, 2, 59));
  });
});

describe("a week or a month, with a turn", () => {
  const weekly = mk({ period: "week", terms: [{ from: at(10, 1, 0), target: 600, days: ALL }] });
  const worked = [S("a", at(11, 2, 9), at(11, 2, 9) + 100 * M), S("a", at(11, 3, 9), at(11, 3, 9) + 100 * M)];

  it("fixes today's share at the start of the day, and does not move it as it is worked", () => {
    const today = (extra = [], now = at(11, 4, 12)) => stand(weekly, [...worked, ...extra], now).today;
    expect(today()).toMatchObject({ share: 80, done: 0, toGo: 80, then: 80 });
    const some = today([S("a", at(11, 4, 9), at(11, 4, 9, 30))]);
    expect(some).toMatchObject({ share: 80, done: 30, toGo: 50, state: "fits", then: 80 });
    const all = today([S("a", at(11, 4, 9), at(11, 4, 10, 20))]);
    expect(all).toMatchObject({ share: 80, done: 80, toGo: 0, state: "done", then: 80 });
    // And what is done above it lowers what the days after are asked.
    expect(today([S("a", at(11, 4, 9), at(11, 4, 11))]).then).toBe(70);
  });

  it("counts days from the turn: Wednesday 02:30 is still Tuesday", () => {
    expect(stand(weekly, worked, at(11, 4, 2, 30), 180).pacing).toMatchObject({ daysDone: 1, daysLeft: 6 });
    expect(stand(weekly, worked, at(11, 4, 2, 30), 0).pacing).toMatchObject({ daysDone: 2, daysLeft: 5 });
    expect(stand(weekly, worked, at(11, 4, 3, 0), 180).pacing).toMatchObject({ daysDone: 2, daysLeft: 5 });
  });

  it("asks nothing of the days after on the last working day, and nothing once it is gone", () => {
    const sundayOn = (h, m, d, e) => stand(weekly, [], at(11, d, h, m), e);
    expect(sundayOn(12, 0, 8, 0).today).toMatchObject({ share: 600, then: null });
    expect(sundayOn(12, 0, 8, 0).pacing.daysLeft).toBe(1);
    // Mon 02:00 with a turn is still Sunday, and the week's last day.
    expect(sundayOn(2, 0, 9, 180).pacing.daysLeft).toBe(1);
    expect(sundayOn(2, 59, 9, 180).today.then).toBeNull();
    expect(sundayOn(2, 59, 9, 180).from).toBe(at(11, 2, 3));
    // From 03:00 it is a new week and its first day.
    const next = sundayOn(3, 0, 9, 180);
    expect(next.from).toBe(at(11, 9, 3));
    expect(next.pacing.daysLeft).toBe(7);
    expect(next.today.share).toBeCloseTo(600 / 7, 8);
    expect(next.today.then).toBeCloseTo(600 / 7, 8);
    // Working days only: after Friday there is none left.
    const monToFri = mk({ period: "week", terms: [{ from: at(10, 1, 0), target: 500, days: [1, 2, 3, 4, 5] }] });
    const fri = stand(monToFri, [], at(11, 6, 12));
    expect(fri.pacing.daysLeft).toBe(1);
    expect(fri.today.then).toBeNull();
    expect(stand(monToFri, [], at(11, 7, 1), 180).today.then).toBeNull(); // still Friday
    expect(stand(monToFri, [], at(11, 7, 1), 180).today).not.toBeNull();
    expect(stand(monToFri, [], at(11, 7, 12)).today).toBeNull();
    expect(stand(monToFri, [], at(11, 7, 3), 180).today).toBeNull();
  });

  it("turns a month at 3 on the 1st", () => {
    const monthly = mk({ period: "month", terms: [{ from: at(10, 1, 0), target: 3000, days: ALL }] });
    const last = stand(monthly, [], at(12, 1, 2, 59), 180);
    expect(last.pacing).toMatchObject({ totalDays: 30, daysLeft: 1 });
    expect(last.today).toMatchObject({ share: 3000, then: null });
    const first = stand(monthly, [], at(12, 1, 3, 0), 180);
    expect(first.pacing).toMatchObject({ totalDays: 31, daysLeft: 31 });
    expect(first.today.share).toBeCloseTo(3000 / 31, 8);
    expect(stand(monthly, [], at(11, 1, 2, 59), 180).pacing).toMatchObject({ totalDays: 31, daysLeft: 1 }); // 1 Nov 02:59 is October's last night
  });
});

describe("a project's own goal", () => {
  const p = P("a");
  const goal = { period: "week", type: "time", target: 600 };
  const run = (sessions, now, endsAt) => projectGoalStanding(p, goal, { sessions, earnings: [], now, rateOf: (s) => s.rate, endsAt });

  it("has no standing for no goal, a lifetime goal, or a target that is not one", () => {
    const x = { sessions: [], earnings: [], now: at(11, 4), rateOf: (s) => s.rate };
    expect(projectGoalStanding(p, null, x)).toBeNull();
    expect(projectGoalStanding(p, { ...goal, period: "lifetime" }, x)).toBeNull();
    expect(projectGoalStanding(p, { ...goal, target: 0 }, x)).toBeNull();
  });

  it("reads the week and the day by the turn, and agrees with itself on the same instant", () => {
    const work = [S("a", at(11, 9, 1), at(11, 9, 2)), S("a", at(11, 3, 9), at(11, 3, 11))];
    const night = run(work, at(11, 9, 2, 30), 180);
    expect(night.from).toBe(at(11, 2, 3));
    expect(night.value).toBe(180);
    expect(night.today).toMatchObject({ done: 60, then: null });
    const morning = run(work, at(11, 9, 3, 30), 180);
    expect(morning.from).toBe(at(11, 9, 3));
    expect(morning.value).toBe(0);
    expect(run(work, at(11, 9, 2, 30), 0).from).toBe(at(11, 9, 0));
    // The same figure the goals list gives for the same goal.
    const g = mk({ period: "week", scope: { kind: "project", projectId: "a" }, terms: [{ from: at(10, 1, 0), target: 600, days: ALL }] });
    const listed = stand(g, work, at(11, 9, 2, 30), 180);
    expect([night.value, night.today.share, night.today.toGo]).toEqual([listed.value, listed.today.share, listed.today.toGo]);
  });
});

describe("terms, results and pauses with a turn", () => {
  const goal = mk({ terms: [{ from: at(11, 1, 0), target: 60, days: ALL }, { from: at(11, 4, 0), target: 120, days: ALL }] });

  it("dates terms by the calendar day, so a change on an afternoon leaves the day before alone", () => {
    for (const turn of [0, 180, 720]) {
      expect(termsAt(goal, periodBoundary("day", at(11, 3, 12), 1, turn), turn).target).toBe(60);
      expect(termsAt(goal, periodBoundary("day", at(11, 4, 12), 1, turn), turn).target).toBe(120);
    }
    // Day of 3 Nov with a turn ends at 03:00 on the 4th, which is still the 3rd's.
    expect(termsAt(goal, at(11, 4, 3), 180).target).toBe(60);
    expect(termsAt(goal, at(11, 4, 3) + 1, 180).target).toBe(120);
    expect(termsAt(goal, at(11, 4, 0), 0).target).toBe(60);
    expect(termsAt(goal, at(11, 4, 0) + 1, 0).target).toBe(120);
    expect(termsAt(goal, at(10, 1), 0).target).toBe(60); // before all of them: the first
  });

  const results = (g, sessions, now, endsAt) => goalResults(g, ctx(sessions, now, endsAt));
  const ninety = [2, 3, 4, 5].map((d) => S("a", at(11, d, 9), at(11, d, 10, 30)));

  it("judges a day by the terms of its own day, whatever the day end, and when it changes between", () => {
    const now = at(11, 6, 12);
    const flags = (endsAt) => results(goal, ninety, now, endsAt).map((r) => r.met);
    // 5 and 4 Nov want 120 and have 90; the 3rd and 2nd wanted 60.
    expect(flags(0)).toEqual([false, false, true, true, false]);
    expect(flags(180)).toEqual([false, false, true, true, false]);
    // Noon: 9:00 on the 5th is the 4th's day, so the days shift by one.
    expect(flags(720)).toEqual([false, false, true, true, true]);
    expect(flags(1380)).toEqual([false, false, true, true, false]);
    // A change made on the 4th by a goal edited then, and the day end changed afterwards.
    const day = addGoal(setPref({ projects }, "dayEndsAt", 0, at(11, 1)), F({ target: 60 }), at(11, 1, 14), "g");
    const edited = editGoal(day, "g", F({ target: 120 }), at(11, 4, 14));
    const turned = setPref(edited, "dayEndsAt", 180, at(11, 5));
    const g0 = edited.goals[0];
    expect(g0.terms.map((t) => [t.from, t.target])).toEqual([[at(11, 1, 0), 60], [at(11, 4, 0), 120]]);
    for (const endsAt of [0, 180]) {
      expect(results(g0, ninety, now, endsAt).map((r) => r.met)).toEqual([false, false, true, true, false]);
    }
    expect(turned.prefs.find((x) => x.id === "dayEndsAt").value).toBe(180);
  });

  it("puts work after midnight in the day before, in the results", () => {
    const late = [S("a", at(11, 3, 1), at(11, 3, 2, 30))]; // 90 minutes in the small hours of the 3rd
    const g = mk({ terms: [{ from: at(11, 1, 0), target: 60, days: ALL }] });
    const now = at(11, 5, 12);
    expect(results(g, late, now, 180)).toEqual([
      { from: at(11, 4, 3), met: false }, { from: at(11, 3, 3), met: false }, { from: at(11, 2, 3), met: true }, { from: at(11, 1, 3), met: false },
    ]);
    expect(results(g, late, now, 0).map((r) => [r.from, r.met])).toEqual([
      [at(11, 4, 0), false], [at(11, 3, 0), true], [at(11, 2, 0), false], [at(11, 1, 0), false],
    ]);
  });

  it("skips a day off unless it was met, by the logical day's weekday", () => {
    const weekdays = mk({ terms: [{ from: at(11, 1, 0), target: 60, days: [1, 2, 3, 4, 5] }] });
    // Friday 6th's night (Sat 01:00), and Sunday's (Mon 01:00): the first is a working day, the second is a rest day that was met.
    const work = [S("a", at(11, 7, 1), at(11, 7, 2, 30)), S("a", at(11, 9, 1), at(11, 9, 2, 30))];
    const got = results(weekdays, work, at(11, 9, 12), 180);
    expect(got.map((r) => [r.from, r.met])).toEqual([
      [at(11, 8, 3), true], [at(11, 6, 3), true], [at(11, 5, 3), false], [at(11, 4, 3), false], [at(11, 3, 3), false],
    ]);
    // With no turn Saturday's 01:00 is Saturday's: off and met counts, Friday is a miss.
    expect(results(weekdays, work.slice(0, 1), at(11, 9, 12), 0).map((r) => [r.from, r.met]).slice(0, 3))
      .toEqual([[at(11, 7, 0), true], [at(11, 6, 0), false], [at(11, 5, 0), false]]);
  });

  it("leaves out periods the goal was paused in, with a turn", () => {
    const g = mk({
      terms: [{ from: at(11, 1, 0), target: 60, days: ALL }],
      pauses: [{ from: at(11, 3, 10), to: at(11, 4, 10) }],
    });
    // The pause touches the days that run 3 Nov 03:00 to 5 Nov 03:00, and no other.
    expect(results(g, [], at(11, 6, 12), 180).map((r) => r.from)).toEqual([at(11, 5, 3), at(11, 2, 3), at(11, 1, 3)]);
    // It ended at 10:00 on the 4th, which a turn at noon puts in the day that began on the 3rd.
    expect(results(g, [], at(11, 6, 12), 720).map((r) => r.from)).toEqual([at(11, 5, 12), at(11, 4, 12), at(11, 1, 12)]);
  });

  it("starts a goal's first term on the day it is for, and drops a pause that began and ended in one", () => {
    const base = (endsAt) => setPref({ projects }, "dayEndsAt", endsAt, 1);
    const night = at(11, 4, 1);
    for (const [endsAt, from] of [[0, at(11, 4, 0)], [180, at(11, 3, 0)], [720, at(11, 3, 0)], [721, at(11, 4, 0)], [1380, at(11, 4, 0)]]) {
      expect(addGoal(base(endsAt), F(), night, "g").goals[0].terms[0].from).toBe(from);
    }
    // Edited in the small hours, it is the same day's term as the one made the evening before: the last wins.
    const early = addGoal(base(180), F({ target: 60 }), at(11, 3, 20), "g");
    const later = editGoal(early, "g", F({ target: 90 }), night);
    expect(later.goals[0].terms.map((t) => [t.from, t.target])).toEqual([[at(11, 3, 0), 90]]);
    // Paused at 02:00 and resumed at 04:00: one day with no turn, two with one.
    for (const [endsAt, kept] of [[0, 0], [180, 1]]) {
      const s = addGoal(base(endsAt), F(), at(11, 1, 9), "g");
      const resumed = resumeGoal(pauseGoal(s, "g", at(11, 4, 2)), "g", at(11, 4, 4));
      expect(resumed.goals[0].pauses).toHaveLength(kept);
    }
  });
});

describe("saying it", () => {
  const show = (v) => `${Math.round(v)}m`;
  const t = (extra) => ({ kind: "day", share: 100, done: 0, toGo: 100, state: "fits", leftMs: 5 * H, endsAt: 0, then: null, atRateMs: null, needPerHour: null, finishAt: null, ...extra });

  it("says a day's part that is done, with what the days after are asked", () => {
    expect(todayWords(t({ state: "done", share: 60 }), show)).toBe("Today’s 60m done");
    expect(todayWords(t({ state: "done", share: 60, kind: "share", then: 80 }), show)).toBe("Today’s 60m done · then 80m/day");
  });

  it("says it is over, with the hour the day ended", () => {
    const day = todayWords(t({ state: "over", toGo: 30, endsAt: 180 }), show);
    expect(day).toMatch(/^30m short · your day ended at .*0?3[:.]00/);
    const share = todayWords(t({ state: "over", kind: "share", done: 20, share: 80, then: 90, endsAt: 1380 }), show);
    expect(share).toMatch(/^Today 20m of 80m · your day ended at .*· then 90m\/day$/);
    expect(share).toMatch(/(11|23)[:.]00/);
    expect(clockOfMinutes(0)).toMatch(/(12|0?0)[:.]00/);
  });

  it("says what is to go and what is left, and 'only' where it is short", () => {
    expect(todayWords(t({ toGo: 45 }), show)).toBe("45m to go · 5h 00m left today");
    expect(todayWords(t({ toGo: 45, state: "tight" }), show)).toBe("45m to go · 5h 00m left today");
    expect(todayWords(t({ toGo: 45, state: "short", leftMs: 30 * M }), show)).toBe("45m to go · only 30m left today");
    // A week's share is spoken as done of share; "then" only where today falls short of it.
    const fits = todayWords(t({ kind: "share", share: 80, done: 20, then: 80 }), show);
    expect(fits).toBe("Today 20m of 80m · 5h 00m left today");
    const short = todayWords(t({ kind: "share", share: 80, done: 20, state: "short", leftMs: 30 * M, then: 90 }), show);
    expect(short).toBe("Today 20m of 80m · only 30m left today · then 90m/day");
    expect(todayWords(t({ state: "short", leftMs: 30 * M }), show)).not.toMatch(/then/);
  });

  it("says the rate, the rate needed, and when it will be met", () => {
    expect(todayWords(t({ atRateMs: 10 * H }), show)).toMatch(/^100m to go · ≈ 10h 00m at your recent rate · 5h 00m left today$/);
    expect(todayWords(t({ needPerHour: 8.4, state: "open" }), show)).toMatch(/^100m to go · 8m per hour needed · 5h 00m left today$/);
    const met = todayWords(t({ finishAt: at(11, 3, 14, 30) }), show);
    expect(met).toMatch(/^100m to go · 5h 00m left today · met around .*(2[:.]30|14[:.]30)/);
  });

  it("never says 0m of what is left, and is amber where the day cannot hold it", () => {
    expect(leftWords(0)).toBe("1m");
    expect(leftWords(30_000)).toBe("1m");
    expect(leftWords(90 * M)).toBe("1h 30m");
    expect(todayWords(t({ state: "short", leftMs: 0 }), show)).toMatch(/only 1m left today/);
    expect(todayTone({ state: "done" })).toBe("met");
    for (const state of ["tight", "short", "over"]) expect(todayTone({ state })).toBe("behind");
    for (const state of ["fits", "open"]) expect(todayTone({ state })).toBe("even");
  });
});
