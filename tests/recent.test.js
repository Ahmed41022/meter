import { describe, it, expect } from "vitest";
import { daysOfWork, recentPicks, spillsPast } from "../src/domain/recent.js";
import { performanceIn, sessionMsInWindow } from "../src/domain/performance.js";

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

  it("lists a session that crossed midnight under both of the days it touched", () => {
    // Every figure splits it at midnight, so the list does too: filed whole
    // under the day it started, the rows under one heading could not add up
    // to the heading above them.
    const crossed = session("s1", "a", at(21, 23), at(22, 2));
    const days = daysOfWork([crossed], NOW);
    expect(days.map((d) => d.dayStart)).toEqual([at(22, 0, 0), at(21, 0, 0)]);
    expect(days.every((d) => d.sessions[0] === crossed)).toBe(true);
  });

  it("gives each listing its own day's share, and the shares add up to the day", () => {
    // The pairing that must hold: an hour before midnight and two after,
    // each listed where it fell and counted there by the heading.
    const crossed = session("s1", "a", at(21, 23), at(22, 2));
    const morning = session("s2", "a", at(22, 9), at(22, 10));
    const days = daysOfWork([crossed, morning], NOW);
    for (const day of days) {
      const heading = performanceIn([crossed, morning], day.dayStart, day.dayEnd, NOW);
      const rows = day.sessions
        .map((s) => sessionMsInWindow(s, day.dayStart, day.dayEnd, NOW))
        .reduce((a, b) => a + b, 0);
      expect(rows).toBe(heading.billedMs);
    }
    expect(sessionMsInWindow(crossed, days[1].dayStart, days[1].dayEnd, NOW)).toBe(HOUR);
    expect(sessionMsInWindow(crossed, days[0].dayStart, days[0].dayEnd, NOW)).toBe(2 * HOUR);
    // newest first inside a day, so the sitting carried over from the night
    // before sits under the morning's
    expect(days[0].sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(spillsPast(crossed, days[1].dayEnd, NOW)).toBe(true);
    expect(spillsPast(crossed, days[0].dayEnd, NOW)).toBe(false);
  });

  it("splits at the midnight a DST change moves, without losing either day", () => {
    // Africa/Cairo sprang forward AT midnight on 24 Apr 2026, so that day has
    // no 00:00 and begins at 01:00. 23:00 to 02:00 is two real hours: one on
    // each side.
    const april = (d, h) => new Date(2026, 3, d, h).getTime();
    const crossed = session("s1", "a", april(23, 23), april(24, 2));
    const days = daysOfWork([crossed], april(24, 12));
    expect(days.map((d) => d.dayStart)).toEqual([new Date(2026, 3, 24).getTime(), april(23, 0)]);
    expect(days.map((d) => sessionMsInWindow(crossed, d.dayStart, d.dayEnd, 0))).toEqual([HOUR, HOUR]);
  });

  it("lists a paused sitting only on the days it actually ran", () => {
    const paused = {
      ...session("s1", "a", at(20, 9), at(22, 10)),
      segments: [{ startedAt: at(20, 9), endedAt: at(20, 10) }, { startedAt: at(22, 9), endedAt: at(22, 10) }],
    };
    expect(daysOfWork([paused], NOW).map((d) => d.dayStart)).toEqual([at(22, 0, 0), at(20, 0, 0)]);
  });

  it("does not list a sitting under a day it only ended at the start of", () => {
    const toMidnight = session("s1", "a", at(21, 22), at(22, 0, 0));
    expect(daysOfWork([toMidnight], NOW).map((d) => d.dayStart)).toEqual([at(21, 0, 0)]);
  });

  it("carries a running sitting into today, and no further than now", () => {
    const open = {
      ...session("s1", "a", at(27, 23), null),
      closedAt: null, segments: [{ startedAt: at(27, 23), endedAt: null }],
    };
    const days = daysOfWork([open], NOW);
    expect(days.map((d) => d.dayStart)).toEqual([at(28, 0, 0), at(27, 0, 0)]);
    expect(spillsPast(open, days[1].dayEnd, NOW)).toBe(true);
    expect(spillsPast(open, days[0].dayEnd, NOW)).toBe(false);
    // Without a now there is nothing to measure it to, so it stays under the
    // day it started rather than reaching into days nobody asked about.
    expect(daysOfWork([open]).map((d) => d.dayStart)).toEqual([at(27, 0, 0)]);
  });

  it("still lists a sitting with no time in it yet, under the day it started", () => {
    const empty = { ...session("s1", "a", at(27, 9), at(27, 9)) };
    expect(daysOfWork([empty], NOW).map((d) => d.dayStart)).toEqual([at(27, 0, 0)]);
  });

  it("does not call an ordinary session a spill", () => {
    const days = daysOfWork([session("s1", "a", at(21, 9), at(21, 10))], NOW);
    expect(spillsPast(days[0].sessions[0], days[0].dayEnd, NOW)).toBe(false);
  });

  it("ignores deleted sessions entirely", () => {
    expect(daysOfWork([session("s1", "a", at(20), at(20, 1), { deletedAt: NOW })])).toEqual([]);
  });
});
