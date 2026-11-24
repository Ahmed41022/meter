import { describe, expect, it } from "vitest";
import {
  addGoal, coverWords, editGoal, goalResults, goalStanding, isPausedGoal, liveGoals, moveGoal, pauseGoal,
  readGoal, removeGoal, restoreGoal, resumeGoal, termsAt,
} from "../src/domain/workGoals.js";
import { pace, paceState } from "../src/domain/goals.js";
import { mergeState, stampChanges } from "../src/domain/merge.js";
import { setPref } from "../src/domain/prefs.js";

const H = 3_600_000;
/** Local time, in November 2026: the 2nd is a Monday. */
const at = (d, h = 12, m = 0) => new Date(2026, 10, d, h, m).getTime();
const P = (id, extra = {}) => ({ id, name: id.toUpperCase(), currentRate: 10, currency: "USD", createdAt: 1, ...extra });
const projects = [P("a", { company: "Alignerr" }), P("b", { company: "alignerr " }), P("c"), P("life", { offClock: true })];
let n = 0;
const S = (projectId, d, hours, extra = {}) => ({
  id: `s${++n}`, projectId, taskId: null, kind: "billed", rate: 10, currency: "USD", createdAt: at(d, 8),
  segments: [{ startedAt: at(d, 8), endedAt: at(d, 8) + hours * H }], closedAt: at(d, 8) + hours * H, deletedAt: null, ...extra,
});
const ctx = (sessions, now, extra = {}) => ({ projects, sessions, earnings: [], rateOf: (s) => s.rate, now, ...extra });
const F = (extra = {}) => ({ type: "time", target: 360, period: "day", scope: { kind: "all" }, days: [1, 2, 3, 4, 5, 6, 7], ...extra });
const WEEKDAYS = [1, 2, 3, 4, 5];
const one = (fields, now = at(2)) => liveGoals(addGoal({ projects }, F(fields), now, "g"))[0];

describe("what a goal is", () => {
  it("takes a period, a measure, a target, what it covers and its days, and refuses anything else", () => {
    expect(readGoal(F())).toMatchObject({ target: 360, period: "day" });
    expect(readGoal(F({ type: "money", currency: "USD", target: 5 }))).toMatchObject({ currency: "USD" });
    expect(readGoal(F({ days: [5, 1, 5] })).days).toEqual([1, 5]);
    for (const bad of [{ target: 0 }, { target: NaN }, { period: "year" }, { scope: { kind: "company", company: " " } },
      { scope: null }, { days: [] }, { type: "money" }]) expect(readGoal(F(bad))).toBeNull();
    const s = { projects };
    expect(addGoal(s, F({ target: 0 }), at(2), "g")).toBe(s);
  });

  it("leaves a goal a newer build wrote alone, and out of sight", () => {
    const s = { goals: [{ id: "x", period: "decade", scope: { kind: "all" }, terms: [{ from: 0, target: 1 }] }] };
    expect(liveGoals(s)).toEqual([]);
    expect(addGoal(s, F(), at(2), "g").goals).toHaveLength(2);
  });
});

describe("the daily goal there was before", () => {
  const old = setPref({ projects }, "dayGoal", { type: "money", target: 90, currency: "USD" }, at(3));
  it("is a goal, until it is changed, and then it is that record", () => {
    expect(liveGoals(old)).toMatchObject([{ id: "goal:day", period: "day", type: "money", currency: "USD", terms: [{ target: 90 }] }]);
    const added = addGoal(old, F(), at(4), "g");
    expect(liveGoals(added).map((g) => g.id)).toEqual(["goal:day", "g"]);
    const gone = removeGoal(old, "goal:day", at(4));
    expect(liveGoals(gone)).toEqual([]);
    expect(liveGoals(restoreGoal(gone, "goal:day")).map((g) => g.id)).toEqual(["goal:day"]);
  });

  it("is taken over by two devices as one", () => {
    const a = stampChanges(old, addGoal(old, F(), at(4), "ga"), at(4));
    const b = stampChanges(old, addGoal(old, F(), at(4), "gb"), at(4));
    expect(liveGoals(mergeState(a, b)).map((g) => g.id).sort()).toEqual(["ga", "gb", "goal:day"]);
  });
});

describe("where a goal stands", () => {
  const sessions = [S("a", 4, 2), S("b", 4, 1), S("c", 4, 4), S("life", 4, 8), S("a", 4, 3, { kind: "idle" }), S("a", 2, 5)];
  it("covers all work, one company or one project, and never life or idle time", () => {
    const value = (scope, period = "day") => goalStanding(one({ scope, period }), ctx(sessions, at(4, 20))).value / 60;
    expect(value({ kind: "all" })).toBe(7);
    expect(value({ kind: "company", company: "ALIGNERR" })).toBe(3);
    expect(value({ kind: "project", projectId: "c" })).toBe(4);
    expect(value({ kind: "project", projectId: "life" })).toBe(0);
    expect(value({ kind: "project", projectId: "a" }, "week")).toBe(7);
    expect(value({ kind: "project", projectId: "a" }, "month")).toBe(7);
  });

  it("names what it covers", () => {
    expect([{ kind: "all" }, { kind: "company", company: "Alignerr" }, { kind: "project", projectId: "a" },
      { kind: "project", projectId: "zz" }].map((scope) => coverWords(one({ scope }), projects)))
      .toEqual(["All work", "Alignerr", "A", "A removed project"]);
  });

  it("asks nothing of a daily goal on a day off, and counts what is done anyway", () => {
    const g = one({ days: WEEKDAYS });
    expect(goalStanding(g, ctx([], at(6))).off).toBe(false);
    expect(goalStanding(g, ctx([S("a", 7, 6)], at(7, 20)))).toMatchObject({ off: true, met: true });
  });

  it("paces a week over its working days", () => {
    const g = one({ period: "week", target: 2400, days: WEEKDAYS });
    // Wednesday: two of five days finished, so 16 of 40 hours are due.
    expect(goalStanding(g, ctx([S("a", 2, 8), S("a", 3, 8)], at(4)))).toMatchObject({ state: "even", pacing: { totalDays: 5, daysDone: 2, daysLeft: 3, needPerDay: 480 } });
    // Saturday: no day left to ask, and the week is not over.
    const sat = goalStanding(g, ctx([S("a", 2, 8)], at(7)));
    expect(sat).toMatchObject({ state: "behind", pacing: { daysLeft: 0, needPerDay: null, closed: false, remaining: 1920 } });
  });
});

describe("pace over some of the days", () => {
  const week = { target: 100, from: at(2, 0), to: at(9, 0) };
  it("is unchanged where every day counts", () => {
    expect(pace({ ...week, days: [1, 2, 3, 4, 5, 6, 7] }, 10, at(4))).toEqual(pace(week, 10, at(4)));
  });
  it("is missed only once the period is over", () => {
    expect(paceState(pace({ ...week, days: WEEKDAYS }, 10, at(8)))).toBe("behind");
    expect(paceState(pace({ ...week, days: WEEKDAYS }, 10, at(9, 0)))).toBe("missed");
    expect(pace({ target: 5, from: at(7, 0), to: at(8, 0), days: WEEKDAYS }, 0, at(7))).toBeNull();
  });
});

describe("an honest history", () => {
  it("judges past periods by the target they had", () => {
    let s = addGoal({ projects }, F({ target: 120 }), at(2), "g");
    s = editGoal(s, "g", F({ target: 480 }), at(5));
    const g = liveGoals(s)[0];
    expect([3, 4, 5, 6].map((d) => termsAt(g, at(d + 1, 0)).target)).toEqual([120, 120, 480, 480]);
    const worked = [2, 3, 4, 5].map((d) => S("a", d, 3));
    expect(goalResults(g, ctx(worked, at(6))).map((r) => r.met)).toEqual([false, true, true, true]);
  });

  it("keeps the last of two changes on one day, and writes nothing for none", () => {
    let s = addGoal({ projects }, F({ target: 120 }), at(2), "g");
    s = editGoal(s, "g", F({ target: 200 }), at(3, 9));
    s = editGoal(s, "g", F({ target: 300 }), at(3, 18));
    expect(liveGoals(s)[0].terms.map((t) => t.target)).toEqual([120, 300]);
    expect(editGoal(s, "g", F({ target: 300 }), at(4)).goals[0]).toBe(s.goals[0]);
  });

  it("starts again when it asks a different question", () => {
    const s = addGoal({ projects }, F(), at(2), "g");
    for (const change of [{ period: "week" }, { type: "money", currency: "USD" }, { scope: { kind: "project", projectId: "a" } }]) {
      const g = liveGoals(editGoal(s, "g", F({ target: 400, ...change }), at(9)))[0];
      expect(g.terms).toEqual([{ from: at(9, 0), target: 400, days: [1, 2, 3, 4, 5, 6, 7] }]);
    }
    const back = editGoal(editGoal(s, "g", F({ type: "money", currency: "USD" }), at(3)), "g", F(), at(4));
    expect("currency" in liveGoals(back)[0]).toBe(false);
  });
});

describe("how the last periods went", () => {
  it("leaves out days off, unless the goal was met on one", () => {
    const g = one({ days: WEEKDAYS, target: 60 });
    // Thu 5 and Fri 6 missed and met, Sat 7 rested, Sun 8 worked; asked on Mon 9.
    const r = goalResults(g, ctx([S("a", 6, 2), S("a", 8, 2)], at(9)));
    expect(r.map((x) => [new Date(x.from).getDate(), x.met])).toEqual([[8, true], [6, true], [5, false], [4, false], [3, false]]);
  });

  it("leaves out the period it was set part way through", () => {
    const g = one({ period: "week", target: 60 }, at(4));
    expect(goalResults(g, ctx([], at(9)))).toEqual([]);
    expect(goalResults(g, ctx([], at(16))).map((r) => r.met)).toEqual([false]);
  });

  it("leaves out the periods it was paused in", () => {
    let s = addGoal({ projects }, F({ target: 60 }), at(2), "g");
    s = pauseGoal(s, "g", at(4));
    expect(isPausedGoal(liveGoals(s)[0])).toBe(true);
    expect(pauseGoal(s, "g", at(5)).goals[0]).toBe(s.goals[0]);
    s = resumeGoal(s, "g", at(6));
    expect(goalResults(liveGoals(s)[0], ctx([], at(9))).map((r) => new Date(r.from).getDate())).toEqual([8, 7, 3, 2]);
    // Paused and put straight back, it was not paused.
    expect(resumeGoal(pauseGoal(s, "g", at(8, 9)), "g", at(8, 10)).goals[0].pauses).toHaveLength(1);
  });

  it("looks back five periods at most", () => {
    expect(goalResults(one({}, at(2)), ctx([], at(20)))).toHaveLength(5);
  });
});

it("is put in the owner's order", () => {
  let s = { projects };
  for (const id of ["x", "y", "z"]) s = addGoal(s, F(), at(2), id);
  const order = (st) => liveGoals(st).map((g) => g.id).join("");
  expect(order(s)).toBe("xyz");
  s = moveGoal(s, "z", -1);
  expect(order(s)).toBe("xzy");
  expect(moveGoal(s, "x", -1)).toBe(s);
  expect(moveGoal(s, "y", 1)).toBe(s);
  expect(order(addGoal(s, F(), at(3), "w"))).toBe("xzyw");
});
