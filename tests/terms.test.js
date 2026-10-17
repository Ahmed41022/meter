import { describe, it, expect } from "vitest";
import {
  SCOPE, crossingAt, currentLimit, handedInAt, limitFor, pricer, setOwnLimit, setProjectRate,
  setTaskLimit,
} from "../src/domain/terms.js";
import { sessionCents, overLimitMs } from "../src/domain/sessions.js";
import { performanceIn } from "../src/domain/performance.js";

const H = 3_600_000;
const M = 60_000;
const T = 1_790_000_000_000;

const sitting = (id, taskId, from, ms, extra = {}) => ({
  id, projectId: "p", kind: "billed", taskId, rate: 20, currency: "USD",
  createdAt: from, closedAt: from + ms, deletedAt: null,
  segments: [{ startedAt: from, endedAt: from + ms }], ...extra,
});
const project = (extra = {}) => ({
  id: "p", name: "Gateway", currentRate: 20, currency: "USD", createdAt: T - 100 * H,
  taskLimits: [{ from: null, ms: 2 * H, factor: 0.3 }],
  tasks: [{ id: "t1", label: "T-1" }, { id: "t2", label: "T-2" }],
  ...extra,
});

describe("the limit a task is held to", () => {
  it("is none on a project that never had one", () => {
    expect(limitFor({ id: "p", tasks: [] }, { id: "t1" })).toBeNull();
    expect(currentLimit({ id: "p" })).toBeNull();
  });

  it("is the latest for a task still open", () => {
    const p = project({ taskLimits: [
      { from: null, ms: 2 * H, factor: 0.3 }, { from: T, ms: 3 * H, factor: 0.5 }] });
    expect(limitFor(p, { id: "t1" })).toEqual({ ms: 3 * H, factor: 0.5 });
  });

  it("is the one in force at the hand-in for a task handed in", () => {
    const p = project({ taskLimits: [
      { from: null, ms: 2 * H, factor: 0.3 }, { from: T, ms: 3 * H, factor: 0.5 }] });
    const before = { id: "t1", state: "accepted", submittedAt: T - H, stateAt: T + H };
    const after = { id: "t2", state: "submitted", submittedAt: T + H, stateAt: T + H };
    expect(limitFor(p, before)).toEqual({ ms: 2 * H, factor: 0.3 });
    expect(limitFor(p, after)).toEqual({ ms: 3 * H, factor: 0.5 });
  });

  it("leaves work handed in before a first limit unlimited", () => {
    // A limit set from now on has no say over a task the platform already judged.
    const p = project({ taskLimits: [{ from: T, ms: 2 * H, factor: 0.3 }] });
    expect(limitFor(p, { id: "t1", state: "accepted", submittedAt: T - H })).toBeNull();
    expect(limitFor(p, { id: "t2" })).toEqual({ ms: 2 * H, factor: 0.3 });
  });

  it("reads a task answered before hand-ins were dated by its answer", () => {
    expect(handedInAt({ state: "accepted", stateAt: T })).toBe(T);
    expect(handedInAt({ id: "t1" })).toBeNull();
  });

  it("takes a task's own limit, with the project's share", () => {
    expect(limitFor(project(), { id: "t1", limitMs: 4 * H })).toEqual({ ms: 4 * H, factor: 0.3 });
  });

  it("gives a task's own limit no say where the project has none in force", () => {
    expect(limitFor(project({ taskLimits: [] }), { id: "t1", limitMs: 4 * H })).toBeNull();
    const off = project({ taskLimits: [{ from: null, ms: 2 * H, factor: 0.3 }, { from: T, ms: null, factor: null }] });
    expect(limitFor(off, { id: "t1", limitMs: 4 * H })).toBeNull();
  });
});

describe("where a task crosses its limit", () => {
  it("falls where its sittings, laid end to end in order, reach it", () => {
    const sittings = [sitting("b", "t1", T + 5 * H, 90 * M), sitting("a", "t1", T, 60 * M)];
    // One hour in the first, so the line is an hour into the second.
    expect(crossingAt(sittings, 2 * H)).toBe(T + 5 * H + 60 * M);
  });

  it("leaves idle and deleted time out", () => {
    const sittings = [
      sitting("a", "t1", T, 90 * M),
      sitting("i", "t1", T + 2 * H, 2 * H, { kind: "idle" }),
      sitting("d", "t1", T + 5 * H, 2 * H, { deletedAt: T + 6 * H }),
    ];
    expect(crossingAt(sittings, 2 * H)).toBeNull();
  });

  it("is already known for a sitting still going", () => {
    const running = { ...sitting("r", "t1", T, 0), closedAt: null, segments: [{ startedAt: T, endedAt: null }] };
    expect(crossingAt([running], 2 * H)).toBe(T + 2 * H);
  });
});

describe("what time over the limit pays", () => {
  const state = () => {
    const sessions = [sitting("a", "t1", T, 90 * M), sitting("b", "t1", T + 3 * H, 70 * M)];
    return { projects: [project()], sessions };
  };

  it("pays the first two hours in full and the rest at 30%", () => {
    // 2h 40m at $20/hr with a 2h limit: $40 for two hours, and forty minutes
    // at $6/hr, $4. $44, not $53.33.
    const { projects, sessions } = state();
    const price = pricer(projects, sessions);
    const total = sessions.reduce((c, s) => c + sessionCents(s, -Infinity, Infinity, T + 9 * H, price), 0);
    expect(total).toBe(4400);
    // The second sitting is split: thirty minutes in full, forty over.
    expect(sessionCents(sessions[1], -Infinity, Infinity, T + 9 * H, price)).toBe(1000 + 400);
    expect(overLimitMs(sessions[1], -Infinity, Infinity, T + 9 * H, price)).toBe(40 * M);
  });

  it("splits a window at the line, so each day carries its own share", () => {
    const { projects, sessions } = state();
    const price = pricer(projects, sessions);
    // A window holding only the over-limit forty minutes.
    const over = performanceIn(sessions, T + 3 * H + 30 * M, T + 9 * H, T + 9 * H, price);
    expect(over.billedCents).toEqual({ USD: 400 });
    expect(over.billedMs).toBe(40 * M);
  });

  it("pays nothing over the limit at 0%", () => {
    const { sessions } = state();
    const price = pricer([project({ taskLimits: [{ from: null, ms: 2 * H, factor: 0 }] })], sessions);
    expect(performanceIn(sessions, -Infinity, Infinity, T + 9 * H, price).billedCents).toEqual({ USD: 4000 });
  });

  it("keeps each task's limit to itself", () => {
    const sessions = [sitting("a", "t1", T, 2 * H), sitting("b", "t2", T + 3 * H, 2 * H)];
    const price = pricer([project()], sessions);
    expect(performanceIn(sessions, -Infinity, Infinity, T + 9 * H, price).billedCents).toEqual({ USD: 8000 });
  });

  it("puts no limit on work filed under no task", () => {
    const sessions = [sitting("a", null, T, 4 * H)];
    expect(performanceIn(sessions, -Infinity, Infinity, T + 9 * H, pricer([project()], sessions)).billedCents)
      .toEqual({ USD: 8000 });
  });

  it("is the plain rate times the time where nothing has a limit", () => {
    const { sessions } = state();
    const price = pricer([project({ taskLimits: undefined })], sessions);
    expect(price.limit(sessions[1])).toBeNull();
    expect(performanceIn(sessions, -Infinity, Infinity, T + 9 * H, price).billedCents).toEqual({ USD: 5333 });
  });

  it("says how much of the limit is left before it is crossed", () => {
    const sessions = [sitting("a", "t1", T, 90 * M)];
    const price = pricer([project()], sessions);
    expect(price.terms(sessions[0])).toEqual({ ms: 2 * H, factor: 0.3, at: null });
    expect(price.limit(sessions[0])).toBeNull();
  });
});

describe("changing the limit", () => {
  const base = () => ({ projects: [project({ taskLimits: undefined })], sessions: [] });

  it("adds an entry from now on, so work already handed in keeps its terms", () => {
    let s = setTaskLimit(base(), "p", { ms: 2 * H, factor: 0.3 }, SCOPE.FORWARD, T);
    s = setTaskLimit(s, "p", { ms: 3 * H, factor: 0.3 }, SCOPE.FORWARD, T + 10 * H);
    expect(s.projects[0].taskLimits).toEqual([
      { from: T, ms: 2 * H, factor: 0.3 }, { from: T + 10 * H, ms: 3 * H, factor: 0.3 }]);
    expect(currentLimit(s.projects[0])).toMatchObject({ ms: 3 * H });
  });

  it("replaces the history when made to everything", () => {
    let s = setTaskLimit(base(), "p", { ms: 2 * H, factor: 0.3 }, SCOPE.FORWARD, T);
    s = setTaskLimit(s, "p", { ms: 3 * H, factor: 0.5 }, SCOPE.ALL, T + 10 * H);
    expect(s.projects[0].taskLimits).toEqual([{ from: null, ms: 3 * H, factor: 0.5 }]);
  });

  it("takes a limit away from now on, or entirely", () => {
    let s = setTaskLimit(base(), "p", { ms: 2 * H, factor: 0.3 }, SCOPE.FORWARD, T);
    const later = setTaskLimit(s, "p", { ms: null }, SCOPE.FORWARD, T + H);
    expect(currentLimit(later.projects[0])).toBeNull();
    expect(later.projects[0].taskLimits).toHaveLength(2);
    s = setTaskLimit(s, "p", { ms: null }, SCOPE.ALL, T + H);
    expect(s.projects[0].taskLimits).toBeUndefined();
  });

  it("sets and clears one task's own limit", () => {
    let s = setOwnLimit({ projects: [project()] }, "p", "t1", 4 * H);
    expect(s.projects[0].tasks[0].limitMs).toBe(4 * H);
    s = setOwnLimit(s, "p", "t1", null);
    expect("limitMs" in s.projects[0].tasks[0]).toBe(false);
  });
});

describe("changing the rate", () => {
  const state = () => ({
    projects: [project({
      taskLimits: undefined,
      tasks: [
        { id: "open", label: "open" },
        { id: "in", label: "handed in", state: "submitted", submittedAt: T },
        { id: "own", label: "own rate", rate: 50 },
        { id: "share", label: "a share", factor: 0.3 },
      ],
    })],
    sessions: [
      sitting("o", "open", T, H), sitting("i", "in", T, H), sitting("w", "own", T, H),
      sitting("s", "share", T, H), sitting("n", null, T, H),
    ],
  });
  const rates = (s) => Object.fromEntries(s.sessions.map((x) => [x.id, x.rate]));

  it("from now on, reprices open tasks and leaves handed-in work alone", () => {
    const s = setProjectRate(state(), "p", 25, SCOPE.FORWARD);
    expect(s.projects[0].currentRate).toBe(25);
    expect(rates(s)).toEqual({ o: 25, i: 20, w: 20, s: 25, n: 20 });
  });

  it("everywhere, reprices the whole project except a task with its own rate", () => {
    const s = setProjectRate(state(), "p", 25, SCOPE.ALL);
    expect(rates(s)).toEqual({ o: 25, i: 25, w: 20, s: 25, n: 25 });
  });

  it("refuses a rate that is not above zero", () => {
    const s = state();
    expect(setProjectRate(s, "p", 0, SCOPE.ALL)).toBe(s);
  });
});

describe("the limit outside the screens", () => {
  const state = (extra = {}) => ({
    projects: [project(extra)],
    sessions: [sitting("a", "t1", T, 90 * M), sitting("b", "t1", T + 3 * H, 70 * M)],
    earnings: [],
  });

  it("prices the CSV row that crossed the line, and says why in its note", async () => {
    const { toCsv } = await import("../src/domain/csv.js");
    const rows = toCsv(state(), T + 9 * H).split(/\r?\n/).filter(Boolean).slice(1);
    const crossed = rows.find((r) => r.includes("over the task's limit"));
    expect(crossed).toMatch(/"14\.00"/);
    expect(crossed).toMatch(/40m over the task's limit, at 30%/);
    expect(rows.find((r) => !r.includes("over the task's limit") && r.includes("Billed"))).toMatch(/"30\.00"/);
  });

  it("prices an hourly bonus on time over the limit at the same share", async () => {
    const { submitTasks } = await import("../src/domain/settle.js");
    let n = 0;
    const s = submitTasks(state({ bonusPerHour: 10 }), project({ bonusPerHour: 10 }), ["t1"], T + 9 * H, () => `e${++n}`);
    // Two hours at $10 and forty minutes at $3: $22.
    expect(s.earnings[0].cents).toBe(2200);
    expect(s.earnings[0].note).toMatch(/40m of it over the limit at 30%/);
  });
});
