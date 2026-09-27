import { describe, it, expect } from "vitest";
import { daysOfWork, recentPicks, spillsPast } from "../src/domain/recent.js";
import { performanceIn } from "../src/domain/performance.js";

const HOUR = 3_600_000;
const at = (d, h = 9, m = 0) => new Date(2026, 8, d, h, m).getTime();
const NOW = at(28, 12);

const project = (id, extra = {}) => ({
  id, name: id, currentRate: 60, currency: "USD", tasks: [], ...extra,
});
const session = (id, projectId, from, to, extra = {}) => ({
  id, projectId, kind: "billed", taskId: null, rate: 60, currency: "USD",
  createdAt: from, closedAt: to, deletedAt: null,
  segments: [{ startedAt: from, endedAt: to }], ...extra,
});

describe("what to start again", () => {
  const projects = [project("a"), project("b")];

  it("offers the most recent thing first", () => {
    const list = [session("s1", "a", at(20), at(20, 10)), session("s2", "b", at(25), at(25, 10))];
    expect(recentPicks(list, projects).map((p) => p.project.id)).toEqual(["b", "a"]);
  });

  it("offers one row per project-and-task, not one per sitting", () => {
    // Eight sittings on the same task yesterday should be one way back into
    // it. The shortness of the list is the whole value of it.
    const list = [1, 2, 3, 4].map((n) =>
      session(`s${n}`, "a", at(20 + n), at(20 + n, 10), { taskId: "t1" }));
    expect(recentPicks(list, projects)).toHaveLength(1);
  });

  it("treats the same project under two tasks as two ways back", () => {
    const list = [
      session("s1", "a", at(20), at(20, 10), { taskId: "t1" }),
      session("s2", "a", at(21), at(21, 10), { taskId: "t2" }),
    ];
    expect(recentPicks(list, projects)).toHaveLength(2);
  });

  it("leaves out a project that will not take new time", () => {
    // Starting a meter CLOSES whatever else is open, so a button that should
    // not have been pressed does not merely fail — it stops a good session.
    const stopped = [project("a", { status: "done" }), project("b", { status: "paused" })];
    const list = [session("s1", "a", at(20), at(20, 10)), session("s2", "b", at(21), at(21, 10))];
    expect(recentPicks(list, stopped)).toEqual([]);
  });

  it("leaves out a project that has been deleted from under it", () => {
    expect(recentPicks([session("s1", "gone", at(20), at(20, 10))], projects)).toEqual([]);
  });

  it("skips deleted sessions, and keeps to the limit", () => {
    const list = [
      session("s1", "a", at(20), at(20, 10), { deletedAt: NOW }),
      session("s2", "b", at(21), at(21, 10)),
    ];
    expect(recentPicks(list, projects).map((p) => p.project.id)).toEqual(["b"]);
    expect(recentPicks(
      [1, 2, 3, 4, 5].map((n) => session(`s${n}`, "a", at(10 + n), at(10 + n, 10), { taskId: `t${n}` })),
      projects, 2,
    )).toHaveLength(2);
  });
});

describe("the days there was work", () => {
  it("groups by day, newest first, newest session first inside", () => {
    const list = [
      session("s1", "a", at(20, 9), at(20, 10)),
      session("s2", "a", at(22, 9), at(22, 10)),
      session("s3", "a", at(22, 14), at(22, 15)),
    ];
    const days = daysOfWork(list);
    expect(days).toHaveLength(2);
    expect(days[0].sessions.map((s) => s.id)).toEqual(["s3", "s2"]);
    expect(days[1].sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  it("leaves out the days nothing happened", () => {
    // A fortnight off would otherwise be fourteen rows saying nothing,
    // between the two days you wanted to compare.
    const days = daysOfWork([session("s1", "a", at(1), at(1, 1)), session("s2", "a", at(28), at(28, 1))]);
    expect(days).toHaveLength(2);
  });

  it("lists a session that crossed midnight once, under the day it started", () => {
    // A list is a list of events, and an event happened when it started.
    // Showing it under both days would show the same work twice.
    const crossed = session("s1", "a", at(21, 23, 30), at(22, 0, 30));
    const days = daysOfWork([crossed]);
    expect(days).toHaveLength(1);
    expect(days[0].dayStart).toBe(at(21, 0, 0));
  });

  it("but the day's OWN totals still split it, the way every other screen does", () => {
    // The two rules disagree on purpose. This is the pairing that must hold:
    // grouped under the 21st, counted half in each.
    const crossed = session("s1", "a", at(21, 23, 30), at(22, 0, 30));
    const days = daysOfWork([crossed]);
    const first = performanceIn([crossed], days[0].dayStart, days[0].dayEnd, NOW);
    expect(first.billedMs).toBe(HOUR / 2);
    expect(spillsPast(crossed, days[0].dayEnd, NOW)).toBe(true);
  });

  it("does not call an ordinary session a spill", () => {
    const days = daysOfWork([session("s1", "a", at(21, 9), at(21, 10))]);
    expect(spillsPast(days[0].sessions[0], days[0].dayEnd, NOW)).toBe(false);
  });

  it("counts a still-running session as spilling once the day is over", () => {
    const open = {
      ...session("s1", "a", at(27, 23), null),
      closedAt: null, segments: [{ startedAt: at(27, 23), endedAt: null }],
    };
    const days = daysOfWork([open]);
    expect(spillsPast(open, days[0].dayEnd, NOW)).toBe(true);
  });

  it("ignores deleted sessions entirely", () => {
    expect(daysOfWork([session("s1", "a", at(20), at(20, 1), { deletedAt: NOW })])).toEqual([]);
  });
});
