import { describe, expect, it } from "vitest";
import {
  countdownMs, minimumFor, minimumOf, minimumState, readHours, setOwnMinimum,
} from "../src/domain/minimum.js";
import { addProject } from "../src/domain/projects.js";
import { addTask } from "../src/domain/tasks.js";
import { pricer } from "../src/domain/terms.js";
import { sessionCents } from "../src/domain/sessions.js";

const H = 3_600_000;
const T = 1_700_000_000_000;
const task = (extra = {}) => ({ id: "t1", label: "one", ...extra });
const project = (extra = {}, t = {}) => ({
  id: "p", name: "P", currentRate: 60, currency: "USD", taskMinMs: 8 * H, tasks: [task(t)], ...extra,
});
const sitting = (id, from, to, extra = {}) => ({
  id, projectId: "p", taskId: "t1", kind: "billed", rate: 60, currency: "USD",
  segments: [{ startedAt: from, endedAt: to }], deletedAt: null, ...extra,
});

describe("which minimum a task is held to", () => {
  it.each([
    ["the project's", project(), 8 * H],
    ["its own instead", project({}, { minMs: 3 * H }), 3 * H],
    ["its own where the project has none", project({ taskMinMs: null }, { minMs: 3 * H }), 3 * H],
    ["none, said with 0", project({}, { minMs: 0 }), null],
    ["none anywhere", project({ taskMinMs: undefined }), null],
    ["none once handed in", project({}, { state: "submitted" }), null],
    ["none off the clock", project({ offClock: true }), null],
  ])("%s", (_, p, expected) => {
    expect(minimumFor(p, p.tasks[0])).toBe(expected);
  });

  it("is none for work under no task", () => {
    expect(minimumState(project(), null, [], T)).toBeNull();
  });
});

describe("counting down to it", () => {
  it("takes every billed sitting on the task off, and nothing else", () => {
    const sessions = [
      sitting("a", T, T + 2 * H),
      sitting("b", T + 3 * H, T + 4 * H),
      sitting("idle", T + 5 * H, T + 6 * H, { kind: "idle" }),
      sitting("gone", T + 5 * H, T + 6 * H, { deletedAt: T }),
      sitting("other", T + 5 * H, T + 6 * H, { taskId: "t2" }),
    ];
    expect(minimumState(project(), "t1", sessions, T + 9 * H))
      .toEqual({ ms: 8 * H, doneMs: 3 * H, leftMs: 5 * H, at: null });
  });

  it("knows when a sitting still going will meet it, and stops at zero", () => {
    const sessions = [sitting("a", T, T + 2 * H), sitting("b", T + 10 * H, null)];
    const at = (now) => minimumState(project(), "t1", sessions, now);
    expect(at(T + 11 * H)).toMatchObject({ leftMs: 5 * H, at: T + 16 * H });
    expect(at(T + 16 * H).leftMs).toBe(0);
    expect(at(T + 20 * H)).toMatchObject({ leftMs: 0, doneMs: 12 * H, at: T + 16 * H });
  });

  it("is not shown on an idle sitting, which counts towards nothing", () => {
    expect(minimumOf(project(), sitting("i", T, null, { kind: "idle" }), [], T)).toBeNull();
  });

  it("reads zero only once it is met", () => {
    expect([countdownMs(1), countdownMs(1000), countdownMs(0)]).toEqual([1000, 1000, 0]);
  });

  it("changes no money", () => {
    const s = sitting("a", T, T + 10 * H);
    const worth = (p) => sessionCents(s, -Infinity, Infinity, T, pricer([p], [s]));
    expect(worth(project())).toBe(worth(project({ taskMinMs: null })));
  });
});

describe("setting it", () => {
  it("reads hours as typed, a decimal comma too, and refuses what it cannot read", () => {
    expect(["", " 8 ", "7,5", "0"].map(readHours)).toEqual([null, 8 * H, 7.5 * H, 0]);
    expect(["abc", "-2"].map(readHours)).toEqual([NaN, NaN]);
  });

  it("keeps a task's own, a 0 included, and clears it with nothing", () => {
    const state = { projects: [project()] };
    const own = (s) => s.projects[0].tasks[0];
    expect(own(setOwnMinimum(state, "p", "t1", 0)).minMs).toBe(0);
    const set = setOwnMinimum(state, "p", "t1", 2 * H);
    expect(own(set).minMs).toBe(2 * H);
    expect("minMs" in own(setOwnMinimum(set, "p", "t1", null))).toBe(false);
  });

  it("is written on a new project or task only where given", () => {
    const made = (f) => addProject({ projects: [] }, { name: "n", rate: 1, currency: "USD", ...f }, T, "p").projects[0];
    expect(made({ taskMinMs: 8 * H }).taskMinMs).toBe(8 * H);
    expect("taskMinMs" in made({ taskMinMs: 0 })).toBe(false);
    expect("taskMinMs" in made({ taskMinMs: H, offClock: true })).toBe(false);
    const added = (f) => addTask({ projects: [project()] }, "p", { id: "n", label: "new", ...f }, T).projects[0].tasks[1];
    expect(added({ minMs: 0 }).minMs).toBe(0);
    expect("minMs" in added({ minMs: null })).toBe(false);
  });
});
