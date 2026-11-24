import { describe, expect, it } from "vitest";
import {
  KIND, addManualSession, assignTask, makeMain, overlappingSessions, pauseSession, resumeSession,
  sessionCents, startSession, stopSession,
} from "../src/domain/sessions.js";
import { mayOverlap, metersClash, runningMeters, wouldStop } from "../src/domain/concurrency.js";
import { addProject, patchProject } from "../src/domain/projects.js";
import { mergeState, overlaps, stampChanges } from "../src/domain/merge.js";
import { isRunning } from "../src/domain/time.js";

const T = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const tasks = [{ id: "t1", label: "one" }, { id: "t2", label: "two" }];
const project = (id, extra = {}) => ({ id, name: id, currentRate: 60, currency: "USD", tasks, ...extra });
const A = project("A");
const C = project("C");
const B = project("B", { parallelTasks: true });
const D = project("D", { parallelTasks: true });
const L = project("L", { offClock: true });
const M = project("M", { offClock: true });
const empty = { projects: [A, B, C, D, L, M], sessions: [] };

/** Starts each `[project, taskId, kind]` a minute apart; ids are s1, s2, … */
const run = (starts, state = empty) => starts.reduce((s, [p, taskId = null, kind], i) =>
  startSession(s, p, { now: T + i * MIN, id: `s${i + 1}`, taskId, kind }), state);
const going = (s) => s.sessions.filter(isRunning).map((x) => x.id);

describe("which meters a start leaves running", () => {
  it.each([
    ["A then C: one ordinary project at a time", [[A], [C]], ["s2"]],
    ["A then A, another task", [[A, "t1"], [A, "t2"]], ["s2"]],
    ["B with B, two tasks", [[B, "t1"], [B, "t2"]], ["s1", "s2"]],
    ["B beside A", [[A, "t1"], [B, "t1"]], ["s1", "s2"]],
    ["A beside B already going", [[B, "t1"], [A, "t1"]], ["s1", "s2"]],
    ["B, A, then C: only A is closed", [[B, "t1"], [A], [C]], ["s1", "s3"]],
    ["two parallel projects", [[B, "t1"], [D, "t1"], [B, "t2"]], ["s1", "s2", "s3"]],
    ["B twice on one task: the first is closed", [[B, "t1"], [B, "t1"]], ["s2"]],
    ["B twice with no task: the first is closed", [[B], [B]], ["s2"]],
    ["life beside ordinary work", [[A], [L]], ["s1", "s2"]],
    ["work beside life already going", [[L], [A], [B, "t1"]], ["s1", "s2", "s3"]],
    ["two life activities, even of one project", [[L, "t1"], [L, "t2"], [M]], ["s3"]],
    ["life leaves idle alone", [[A, null, KIND.IDLE], [L]], ["s1", "s2"]],
    ["idle ends ordinary work and leaves a background task ticking",
      [[A], [B, "t1"], [A, "t2", KIND.IDLE]], ["s2", "s3"]],
    ["switching one parallel task to idle ends that meter only",
      [[B, "t1"], [B, "t2"], [B, "t1", KIND.IDLE]], ["s2", "s3"]],
    ["any work ends idle, a parallel task too", [[A, null, KIND.IDLE], [B, "t1"]], ["s2"]],
  ])("%s", (_, starts, expected) => {
    expect(going(run(starts))).toEqual(expected);
  });

  it("goes by what the project allows now, so turning it off goes back to one", () => {
    const two = run([[B, "t1"], [B, "t2"]]);
    const off = patchProject(two, "B", { parallelTasks: false });
    expect(going(off)).toEqual(["s1", "s2"]); // the setting itself stops nothing
    const next = startSession(off, { ...B, parallelTasks: false }, { now: T + HOUR, id: "s3" });
    expect(going(next)).toEqual(["s3"]);
  });

  it("never reads the option off a project that is off the clock", () => {
    const X = project("X", { offClock: true, parallelTasks: true });
    expect(going(run([[X, "t1"], [X, "t2"]], { projects: [X], sessions: [] }))).toEqual(["s2"]);
  });
});

describe("resuming", () => {
  it("closes what may not run beside it, and nothing else", () => {
    const s = pauseSession(run([[B, "t1"], [B, "t2"]]), "s1", T + 10 * MIN);
    expect(going(resumeSession(s, "s1", T + 20 * MIN))).toEqual(["s1", "s2"]);
    const off = patchProject(s, "B", { parallelTasks: false });
    expect(going(resumeSession(off, "s1", T + 20 * MIN))).toEqual(["s1"]);
  });

  it("leaves the ledger untouched when there is nothing to resume", () => {
    const s = run([[A]]);
    expect(resumeSession(s, "s1", T + HOUR)).toBe(s);
    expect(resumeSession(s, "nobody", T + HOUR)).toBe(s);
  });
});

describe("which meter is the main one", () => {
  const view = (s) => runningMeters(s.sessions, s.projects)
    .map((m) => [m.session.id, m.main, m.background, m.canBeMain]);

  it("is the ordinary project, whichever started first", () => {
    expect(view(run([[A], [B, "t1"]])))
      .toEqual([["s1", true, false, false], ["s2", false, true, false]]);
    expect(view(run([[B, "t1"], [A]])).map((r) => r[0])).toEqual(["s2", "s1"]);
  });

  it("is the latest parallel task otherwise, until another is made main", () => {
    const s = run([[B, "t1"], [B, "t2"]]);
    expect(view(s)).toEqual([["s2", true, false, false], ["s1", false, true, true]]);
    const swapped = makeMain(s, "s1", T + HOUR);
    expect(view(swapped)).toEqual([["s1", true, false, false], ["s2", false, true, true]]);
    expect(going(swapped)).toEqual(["s1", "s2"]);
  });

  it("never calls a life activity background work", () => {
    expect(view(run([[L], [A]])))
      .toEqual([["s2", true, false, false], ["s1", false, false, false]]);
    expect(view(run([[L]]))).toEqual([["s1", true, false, false]]);
  });
});

it("says which one-click starts would stop something", () => {
  const s = run([[A], [B, "t1"], [L]]);
  const stops = (projectId, taskId = null) =>
    wouldStop(s.sessions, s.projects, { id: null, projectId, taskId });
  expect([stops("C"), stops("B", "t1"), stops("M")]).toEqual([true, true, true]);
  expect([stops("B", "t2"), stops("D")]).toEqual([false, false]);
});

describe("time that may share its hours", () => {
  it("pays every parallel task its own clock in full", () => {
    let s = run([[B, "t1"], [B, "t2"]]);
    s = stopSession(stopSession(s, "s1", T + HOUR), "s2", T + HOUR + MIN);
    expect(s.sessions.map((x) => sessionCents(x, -Infinity, Infinity, T))).toEqual([6000, 6000]);
  });

  it("is not reported as counted twice, also after the option is turned off", () => {
    const started = run([[A], [B, "t1"], [B, "t2"], [L]]);
    const s = started.sessions.reduce((st, x) => stopSession(st, x.id, T + HOUR), started);
    expect(overlaps(s.sessions, T + HOUR, s.projects)).toEqual([]);
    const off = patchProject(s, "B", { parallelTasks: false });
    expect(overlaps(off.sessions, T + HOUR, off.projects)).toEqual([]);
  });

  it("still finds two that clash with a parallel task between them", () => {
    const s = (id, projectId, from, to) => ({
      id, projectId, taskId: null, segments: [{ startedAt: from, endedAt: to }], closedAt: to, deletedAt: null,
    });
    const found = overlaps([
      s("a", "A", T, T + 5 * HOUR), s("b", "B", T + HOUR, T + 3 * HOUR), s("c", "C", T + 2 * HOUR, T + 4 * HOUR),
    ], T, empty.projects);
    expect(found).toEqual([{ a: "a", b: "c", ms: 2 * HOUR, at: T + 2 * HOUR }]);
  });

  it("still finds one task timed twice", () => {
    const one = { id: "x", projectId: "B", taskId: "t1", parallel: true };
    expect(mayOverlap(one, { ...one, id: "y" }, empty.projects)).toBe(false);
    expect(mayOverlap(one, { ...one, id: "y", taskId: "t2" }, empty.projects)).toBe(true);
  });

  it("is not warned about when typed in by hand", () => {
    const s = stopSession(run([[A, "t1"]]), "s1", T + HOUR);
    const span = { startedAt: T, endedAt: T + HOUR };
    const clash = (projectId) => overlappingSessions(s, span, null, { projectId, taskId: null, kind: KIND.BILLED })
      .map((x) => x.id);
    expect([clash("B"), clash("L"), clash("C")]).toEqual([[], [], ["s1"]]);
    expect(addManualSession(s, B, span, T, "m").sessions.at(-1).parallel).toBe(true);
    expect("parallel" in addManualSession(s, A, span, T, "m").sessions.at(-1)).toBe(false);
  });
});

it("calls two devices' meters a clash only when they may not run together", () => {
  const merged = (p, q) => {
    const one = stampChanges(empty, startSession(empty, p, { now: T, id: "one", taskId: "t1" }), T);
    const two = stampChanges(empty, startSession(empty, q, { now: T, id: "two", taskId: "t2" }), T);
    const m = mergeState(one, two);
    return metersClash(m.sessions, m.projects);
  };
  expect([merged(A, C), merged(A, B), merged(B, B), merged(A, L), merged(L, M)])
    .toEqual([true, false, false, false, true]);
});

it("will not move a running meter onto a task that already has one", () => {
  const s = run([[B, "t1"], [B, "t2"]]);
  const taskOf = (st, id) => st.sessions.find((x) => x.id === id).taskId;
  expect(taskOf(assignTask(s, "s1", "t2"), "s1")).toBe("t1");
  expect(taskOf(assignTask(s, "s1", null), "s1")).toBe(null);
});

it("writes the option on a new project only when asked, and never off the clock", () => {
  const made = (fields) =>
    addProject({ projects: [] }, { name: "n", rate: 1, currency: "USD", ...fields }, T, "p").projects[0];
  expect(made({ parallelTasks: true }).parallelTasks).toBe(true);
  expect("parallelTasks" in made({})).toBe(false);
  expect("parallelTasks" in made({ parallelTasks: true, offClock: true })).toBe(false);
});
