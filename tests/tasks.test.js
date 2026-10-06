import { describe, it, expect } from "vitest";
import {
  addTask, findTask, findTaskByLabel, normaliseLabel, rateFor, removeTask, renameTask,
  resolveTaskId, sessionsUnderTask, setTaskNote, setTaskRate, setTaskPrice, taskLabel, taskTotals, tasksFor,
  parseTaskRate, taskRateInput, ORDER, sortTaskRows, UNASSIGNED, RATE_PROBLEM, taskRateProblem,
} from "../src/domain/tasks.js";
import {
  startSession, stopSession, assignTask, assignTaskToMany, deleteSession, KIND, allSessionsFor,
} from "../src/domain/sessions.js";
import { removeProject } from "../src/domain/projects.js";
import { TASK, setTaskState } from "../src/domain/taskState.js";

const T = 1_700_000_000_000;
const HOUR = 3_600_000;
const project = { id: "p1", name: "Acme", currentRate: 450, currency: "EGP", tasks: [] };
const base = { projects: [project], sessions: [] };
const proj = (s) => s.projects[0];

describe("creating tasks", () => {
  it("stores a trimmed label", () => {
    const s = addTask(base, "p1", { id: "t1", label: "  1234  " }, T);
    expect(tasksFor(proj(s))[0].label).toBe("1234");
  });

  it("ignores a blank label", () => {
    expect(tasksFor(proj(addTask(base, "p1", { id: "t1", label: "   " }, T)))).toHaveLength(0);
  });

  it("will not create a second task that reads as the same one", () => {
    // The whole reason tasks are records: "1234 " and "1234" must not become
    // two rows with the earnings split between them.
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = addTask(s, "p1", { id: "t2", label: " 1234 " }, T);
    s = addTask(s, "p1", { id: "t3", label: "Task-A" }, T);
    s = addTask(s, "p1", { id: "t4", label: "task-a" }, T);
    expect(tasksFor(proj(s)).map((t) => t.label)).toEqual(["1234", "Task-A"]);
  });

  it("does not touch other projects", () => {
    const two = { projects: [project, { ...project, id: "p2", tasks: [] }], sessions: [] };
    const s = addTask(two, "p1", { id: "t1", label: "1234" }, T);
    expect(tasksFor(s.projects[1])).toHaveLength(0);
  });
});

describe("resolving a label to an id", () => {
  it("reuses the existing task's id rather than making a duplicate", () => {
    const s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    expect(resolveTaskId(proj(s), " 1234 ", "fresh")).toBe("t1");
  });

  it("uses the fresh id for a label never seen before", () => {
    expect(resolveTaskId(project, "9999", "fresh")).toBe("fresh");
  });
});

describe("lookups", () => {
  it("reads back a task by id and by label", () => {
    const s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    expect(findTask(proj(s), "t1").label).toBe("1234");
    expect(findTaskByLabel(proj(s), "1234").id).toBe("t1");
  });

  it("labels an unknown or absent task rather than rendering undefined", () => {
    expect(taskLabel(project, null)).toBe("No task");
    expect(taskLabel(project, "gone")).toBe("No task");
  });

  it("treats a project saved before tasks existed as having none", () => {
    const legacy = { id: "p1", name: "Old", currentRate: 450, currency: "EGP" };
    expect(tasksFor(legacy)).toEqual([]);
    expect(normaliseLabel(undefined)).toBe("");
  });
});

describe("renaming", () => {
  it("updates every session pointing at the task, because they hold a reference", () => {
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = startSession(s, proj(s), { now: T, id: "s1", taskId: "t1" });
    s = stopSession(s, "s1", T + HOUR);
    s = renameTask(s, "p1", "t1", "PR review");
    expect(s.sessions[0].taskId).toBe("t1"); // session untouched
    expect(taskTotals(proj(s), allSessionsFor(s, "p1"), T + HOUR)[0].label).toBe("PR review");
  });

  it("ignores a blank rename", () => {
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = renameTask(s, "p1", "t1", "  ");
    expect(taskLabel(proj(s), "t1")).toBe("1234");
  });
});

describe("assigning a task to a session", () => {
  it("can be changed while the session is still open", () => {
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = startSession(s, proj(s), { now: T, id: "s1" });
    expect(s.sessions[0].taskId).toBeNull();
    s = assignTask(s, "s1", "t1");
    expect(s.sessions[0].taskId).toBe("t1");
  });

  it("can be corrected after the session is stopped", () => {
    // Filed under the wrong task is a normal mistake and has to be fixable.
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = addTask(s, "p1", { id: "t2", label: "5678" }, T);
    s = startSession(s, proj(s), { now: T, id: "s1", taskId: "t1" });
    s = stopSession(s, "s1", T + HOUR);
    s = assignTask(s, "s1", "t2");
    expect(s.sessions[0].taskId).toBe("t2");
  });

  it("re-files without touching the hours or the rate", () => {
    // taskId is a label on the record; segments and rate are the record.
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = startSession(s, proj(s), { now: T, id: "s1", taskId: "t1" });
    s = stopSession(s, "s1", T + HOUR);
    const before = s.sessions[0];
    const after = assignTask(s, "s1", null).sessions[0];
    expect(after.segments).toEqual(before.segments);
    expect(after.rate).toBe(before.rate);
    expect(after.closedAt).toBe(before.closedAt);
    expect(after.kind).toBe(before.kind);
  });

  it("moves a batch of sessions in one go", () => {
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = addTask(s, "p1", { id: "t2", label: "5678" }, T);
    for (const [i, id] of ["a", "b", "c"].entries()) {
      s = startSession(s, proj(s), { now: T + i * HOUR, id });
      s = stopSession(s, id, T + (i + 1) * HOUR);
    }
    s = assignTaskToMany(s, ["a", "c"], "t2");
    expect(s.sessions.map((x) => x.taskId)).toEqual(["t2", null, "t2"]);
  });

  it("leaves deleted sessions out of a batch assignment", () => {
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = startSession(s, proj(s), { now: T, id: "s1" });
    s = stopSession(s, "s1", T + HOUR);
    s = deleteSession(s, "s1", T + HOUR);
    s = assignTaskToMany(s, ["s1"], "t1");
    expect(s.sessions[0].taskId).toBeNull();
  });

  it("clears a task by assigning null", () => {
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = startSession(s, proj(s), { now: T, id: "s1", taskId: "t1" });
    s = stopSession(s, "s1", T + HOUR);
    expect(assignTask(s, "s1", null).sessions[0].taskId).toBeNull();
  });

  it("will not file time under a task that takes no more", () => {
    // Moving an hour onto work already handed in changes what was handed in,
    // and the money would not follow it: a paid session moved onto a rejected
    // task would stay paid, and the rejected task would read as earning it.
    for (const closed of [TASK.SUBMITTED, TASK.ACCEPTED, TASK.CANCELLED]) {
      let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
      s = addTask(s, "p1", { id: "t2", label: "5678" }, T);
      s = startSession(s, proj(s), { now: T, id: "s1", taskId: "t1" });
      s = stopSession(s, "s1", T + HOUR);
      s = setTaskState(s, "p1", "t2", closed, T + HOUR);
      expect(assignTaskToMany(s, ["s1"], "t2").sessions[0].taskId).toBe("t1");
    }
  });
});

describe("per-task totals", () => {
  const build = () => {
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = addTask(s, "p1", { id: "t2", label: "5678" }, T);
    // t1: 2h billed
    s = startSession(s, proj(s), { now: T, id: "s1", taskId: "t1" });
    s = stopSession(s, "s1", T + 2 * HOUR);
    // t2: 1h billed
    s = startSession(s, proj(s), { now: T + 2 * HOUR, id: "s2", taskId: "t2" });
    s = stopSession(s, "s2", T + 3 * HOUR);
    // t1: 1h idle
    s = startSession(s, proj(s), { now: T + 3 * HOUR, id: "i1", kind: KIND.IDLE, taskId: "t1" });
    s = stopSession(s, "i1", T + 4 * HOUR);
    // no task: 30m billed
    s = startSession(s, proj(s), { now: T + 4 * HOUR, id: "s3" });
    s = stopSession(s, "s3", T + 4.5 * HOUR);
    return s;
  };

  it("groups time and earnings by task", () => {
    const s = build();
    const rows = taskTotals(proj(s), allSessionsFor(s, "p1"), T + 5 * HOUR);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(byLabel["1234"].billedMs).toBe(2 * HOUR);
    expect(byLabel["1234"].billedCents).toBe(90_000);
    expect(byLabel["5678"].billedCents).toBe(45_000);
  });

  it("keeps idle time out of the earned column", () => {
    const s = build();
    const row = taskTotals(proj(s), allSessionsFor(s, "p1"), T + 5 * HOUR)
      .find((r) => r.label === "1234");
    expect(row.billedCents).toBe(90_000); // 2h, not 3h
    expect(row.idleMs).toBe(HOUR);
    expect(row.idleCents).toBe(45_000);
  });

  it("buckets sessions with no task under their own row", () => {
    const s = build();
    const row = taskTotals(proj(s), allSessionsFor(s, "p1"), T + 5 * HOUR)
      .find((r) => r.taskId === null);
    expect(row.label).toBe("No task");
    expect(row.billedMs).toBe(0.5 * HOUR);
  });

  it("orders by earnings so the biggest task is first", () => {
    const s = build();
    const rows = taskTotals(proj(s), allSessionsFor(s, "p1"), T + 5 * HOUR);
    expect(rows.map((r) => r.label)).toEqual(["1234", "5678", "No task"]);
  });

  it("counts sessions per task", () => {
    const s = build();
    const row = taskTotals(proj(s), allSessionsFor(s, "p1"), T + 5 * HOUR)
      .find((r) => r.label === "1234");
    expect(row.sessions).toBe(2); // one billed, one idle
  });

  it("is empty when nothing has been recorded", () => {
    expect(taskTotals(project, [], T)).toEqual([]);
  });

  it("still totals a running session against its task", () => {
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = startSession(s, proj(s), { now: T, id: "s1", taskId: "t1" });
    const row = taskTotals(proj(s), allSessionsFor(s, "p1"), T + HOUR)[0];
    expect(row.billedMs).toBe(HOUR);
  });

  it("exports a stable key for the unassigned bucket", () => {
    expect(UNASSIGNED).toBe("__unassigned__");
  });
});

describe("project removal", () => {
  it("takes the project's tasks with it", () => {
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = startSession(s, proj(s), { now: T, id: "s1", taskId: "t1" });
    const after = removeProject(s, "p1", T + 1);
    // Tombstoned rather than dropped, so a sync carries the deletion instead
    // of the other device handing the project back.
    expect(after.projects.filter((p) => !p.deletedAt)).toHaveLength(0);
    expect(after.sessions.filter((x) => !x.deletedAt)).toHaveLength(0);
  });
});

describe("task rate override", () => {
  const build = (rate) => {
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = startSession(s, proj(s), { now: T, id: "s1", taskId: "t1" }); // snapshots 450
    s = stopSession(s, "s1", T + 2 * HOUR);
    return rate === undefined ? s : setTaskRate(s, "p1", "t1", rate);
  };

  it("falls back to the session's own snapshot when no override is set", () => {
    const s = build();
    expect(rateFor(proj(s), s.sessions[0])).toBe(450);
  });

  it("reprices sessions already finished", () => {
    // The case this exists for: you're told after the fact what you're paid.
    const s = build(90);
    expect(rateFor(proj(s), s.sessions[0])).toBe(90);
    const row = taskTotals(proj(s), allSessionsFor(s, "p1"), T + 3 * HOUR)[0];
    expect(row.billedCents).toBe(18_000); // 2h at 90, not at 450
  });

  it("leaves the recorded hours and the session snapshot alone", () => {
    // Repricing must not touch the audit trail.
    const before = build().sessions[0];
    const after = build(90).sessions[0];
    expect(after.segments).toEqual(before.segments);
    expect(after.rate).toBe(450); // snapshot preserved, override lives on the task
    expect(after.closedAt).toBe(before.closedAt);
  });

  it("drops the override when cleared, restoring the snapshot", () => {
    let s = build(90);
    s = setTaskRate(s, "p1", "t1", null);
    expect(rateFor(proj(s), s.sessions[0])).toBe(450);
  });

  it("ignores a negative or non-numeric rate", () => {
    // Zero is no longer in this list: it is a rate somebody meant to type, for
    // work that genuinely pays nothing. See "a task that pays nothing".
    for (const bad of [-5, "abc", ""]) {
      const s = setTaskRate(build(), "p1", "t1", bad);
      expect(findTask(proj(s), "t1").rate ?? null).toBeNull();
    }
  });

  it("keeps a zero, because unpaid is an answer", () => {
    const s = setTaskRate(build(), "p1", "t1", 0);
    expect(findTask(proj(s), "t1").rate).toBe(0);
  });

  it("coerces the numeric string an input field produces", () => {
    const s = setTaskRate(build(), "p1", "t1", "62.5");
    expect(findTask(proj(s), "t1").rate).toBe(62.5);
  });

  it("only applies to sessions filed under that task", () => {
    let s = build(90);
    s = startSession(s, proj(s), { now: T + 3 * HOUR, id: "s2" }); // no task
    s = stopSession(s, "s2", T + 4 * HOUR);
    expect(rateFor(proj(s), s.sessions.find((x) => x.id === "s2"))).toBe(450);
  });

  it("reports the override on the breakdown row", () => {
    const s = build(90);
    expect(taskTotals(proj(s), allSessionsFor(s, "p1"), T + 3 * HOUR)[0].rate).toBe(90);
    expect(taskTotals(proj(build()), allSessionsFor(build(), "p1"), T + 3 * HOUR)[0].rate).toBeNull();
  });

  it("prices idle time at the override too", () => {
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = startSession(s, proj(s), { now: T, id: "i1", kind: KIND.IDLE, taskId: "t1" });
    s = stopSession(s, "i1", T + HOUR);
    s = setTaskRate(s, "p1", "t1", 90);
    expect(taskTotals(proj(s), allSessionsFor(s, "p1"), T + HOUR)[0].idleCents).toBe(9_000);
  });
});

describe("deleting a task", () => {
  const withSessions = () => {
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = addTask(s, "p1", { id: "t2", label: "5678" }, T);
    s = startSession(s, proj(s), { now: T, id: "s1", taskId: "t1" });
    s = stopSession(s, "s1", T + HOUR);
    s = startSession(s, proj(s), { now: T + HOUR, id: "s2", taskId: "t2" });
    s = stopSession(s, "s2", T + 2 * HOUR);
    return s;
  };

  it("unfiles its sessions rather than orphaning them", () => {
    // The hours must survive; only the filing goes.
    const s = removeTask(withSessions(), "p1", "t1");
    expect(findTask(proj(s), "t1")).toBeNull();
    const moved = s.sessions.find((x) => x.id === "s1");
    expect(moved.taskId).toBeNull();
    expect(moved.segments).toEqual(withSessions().sessions[0].segments);
  });

  it("leaves other tasks and their sessions alone", () => {
    const s = removeTask(withSessions(), "p1", "t1");
    expect(findTask(proj(s), "t2").label).toBe("5678");
    expect(s.sessions.find((x) => x.id === "s2").taskId).toBe("t2");
  });

  it("moves the unfiled hours into the No task row", () => {
    const s = removeTask(withSessions(), "p1", "t1");
    const rows = taskTotals(proj(s), allSessionsFor(s, "p1"), T + 3 * HOUR);
    expect(rows.find((r) => r.taskId === null).billedMs).toBe(HOUR);
  });

  it("counts what would be unfiled before you confirm", () => {
    const s = withSessions();
    expect(sessionsUnderTask(allSessionsFor(s, "p1"), "t1")).toBe(1);
    expect(sessionsUnderTask(allSessionsFor(s, "p1"), "nope")).toBe(0);
  });

  it("does not reach into another project", () => {
    const two = { ...withSessions() };
    two.projects = [...two.projects, { id: "p2", name: "B", currentRate: 900, currency: "EGP",
                                       tasks: [{ id: "t1", label: "same id", createdAt: T }] }];
    const s = removeTask(two, "p1", "t1");
    expect(findTask(s.projects[1], "t1")).not.toBeNull();
  });
});

describe("a task priced as a share of the base rate", () => {
  const session = (rate) => ({ id: "s1", projectId: "p1", taskId: "t1", rate, kind: "billed" });

  it("reads a percentage as a rule rather than a number", () => {
    expect(parseTaskRate("30%")).toEqual({ rate: null, factor: 0.3 });
    expect(parseTaskRate(" 30 % ".replace(" %", "%").trim())).toEqual({ rate: null, factor: 0.3 });
    expect(parseTaskRate("4.92")).toEqual({ rate: 4.92, factor: null });
    expect(parseTaskRate("")).toEqual({ rate: null, factor: null });
    expect(parseTaskRate(null)).toEqual({ rate: null, factor: null });
  });

  it("applies the share to what the session recorded", () => {
    const s = setTaskRate(addTask(base, "p1", { id: "t1", label: "assessment" }, T), "p1", "t1", "30%");
    expect(rateFor(proj(s), session(16.40))).toBeCloseTo(4.92, 10);
  });

  it("follows the base rate across eras without being touched", () => {
    // The whole reason to store the rule: this project was $25, then $15.75,
    // then $16.40. A number typed once would have been wrong twice.
    const s = setTaskRate(addTask(base, "p1", { id: "t1", label: "assessment" }, T), "p1", "t1", "30%");
    expect(rateFor(proj(s), session(25))).toBeCloseTo(7.5, 10);
    expect(rateFor(proj(s), session(15.75))).toBeCloseTo(4.725, 10);
    expect(rateFor(proj(s), session(16.40))).toBeCloseTo(4.92, 10);
  });

  it("lets an absolute rate be set, and clears the share", () => {
    let s = setTaskRate(addTask(base, "p1", { id: "t1", label: "x" }, T), "p1", "t1", "30%");
    s = setTaskRate(s, "p1", "t1", "9");
    expect(findTask(proj(s), "t1")).toMatchObject({ rate: 9, factor: null });
    expect(rateFor(proj(s), session(16.40))).toBe(9);
  });

  it("falls back to the snapshot when both are cleared", () => {
    let s = setTaskRate(addTask(base, "p1", { id: "t1", label: "x" }, T), "p1", "t1", "30%");
    s = setTaskRate(s, "p1", "t1", "");
    expect(rateFor(proj(s), session(16.40))).toBe(16.40);
  });

  it("can be set as the task is created", () => {
    const s = addTask(base, "p1", { id: "t1", label: "assessment", factor: 0.3 }, T);
    expect(rateFor(proj(s), session(20))).toBeCloseTo(6, 10);
  });

  it("writes no field at all when nothing was given", () => {
    // Absence is the meaning. A null would say the same thing louder, and
    // would travel through sync as a change.
    const s = addTask(base, "p1", { id: "t1", label: "plain" }, T);
    expect(findTask(proj(s), "t1")).not.toHaveProperty("rate");
    expect(findTask(proj(s), "t1")).not.toHaveProperty("factor");
    expect(findTask(proj(s), "t1")).not.toHaveProperty("price");
  });

  it("shows a share back as a percentage, so editing it again is not a trap", () => {
    expect(taskRateInput({ factor: 0.3 })).toBe("30%");
    expect(taskRateInput({ rate: 4.92 })).toBe("4.92");
    expect(taskRateInput({})).toBe("");
  });

  it("ignores a percentage that is not a number", () => {
    expect(parseTaskRate("abc%")).toEqual({ rate: null, factor: null });
    expect(parseTaskRate("-30%")).toEqual({ rate: null, factor: null });
  });
});

describe("a task with its own price per accepted item", () => {
  it("is set and cleared independently of any rate", () => {
    let s = addTask(base, "p1", { id: "t1", label: "CL", price: 300 }, T);
    expect(findTask(proj(s), "t1").price).toBe(300);
    s = setTaskPrice(s, "p1", "t1", null);
    expect(findTask(proj(s), "t1").price).toBeNull();
  });

  it("appears in the per-task totals so a panel can show it", () => {
    const s = addTask(base, "p1", { id: "t1", label: "CL", price: 300 }, T);
    const sessions = [{
      id: "s1", projectId: "p1", taskId: "t1", rate: 0, kind: "billed",
      currency: "EGP", deletedAt: null, segments: [{ startedAt: T, endedAt: T + HOUR }],
    }];
    expect(taskTotals(proj(s), sessions, T + HOUR)[0])
      .toMatchObject({ label: "CL", price: 300, factor: null, rate: null });
  });
});

describe("a task that pays nothing", () => {
  const session = (rate) => ({ id: "s1", projectId: "p1", taskId: "t1", rate, kind: "billed" });

  it("tells zero apart from empty", () => {
    // Empty means "whatever the project says". Zero means "this one is
    // unpaid" — onboarding, training, an unpaid trial. Conflating them left
    // no way to say the second except a number so small it rounds away, which
    // is a lie that still reports as income.
    expect(parseTaskRate("0")).toEqual({ rate: 0, factor: null });
    expect(parseTaskRate("")).toEqual({ rate: null, factor: null });
  });

  it("values its sessions at nothing rather than at the project rate", () => {
    const s = setTaskRate(addTask(base, "p1", { id: "t1", label: "Onboarding" }, T), "p1", "t1", "0");
    expect(rateFor(proj(s), session(450))).toBe(0);
  });

  it("can be set free at creation", () => {
    const s = addTask(base, "p1", { id: "t1", label: "Onboarding", rate: 0 }, T);
    expect(findTask(proj(s), "t1").rate).toBe(0);
    expect(rateFor(proj(s), session(450))).toBe(0);
  });

  it("goes back to inheriting when the box is cleared", () => {
    let s = setTaskRate(addTask(base, "p1", { id: "t1", label: "x" }, T), "p1", "t1", "0");
    s = setTaskRate(s, "p1", "t1", "");
    expect(rateFor(proj(s), session(450))).toBe(450);
  });

  it("shows zero back as zero, not as empty", () => {
    expect(taskRateInput({ rate: 0 })).toBe("0");
  });

  it("still refuses a rate that is not a number", () => {
    const s = setTaskRate(addTask(base, "p1", { id: "t1", label: "x" }, T), "p1", "t1", "abc");
    expect(rateFor(proj(s), session(450))).toBe(450);
  });

  it("refuses a negative one, which is not a thing", () => {
    const s = setTaskRate(addTask(base, "p1", { id: "t1", label: "x" }, T), "p1", "t1", "-5");
    expect(rateFor(proj(s), session(450))).toBe(450);
  });
});

describe("a rate written with a comma, or not a rate at all", () => {
  it("reads a decimal comma the way it was meant", () => {
    expect(parseTaskRate("12,5")).toEqual({ rate: 12.5, factor: null });
    expect(parseTaskRate(" 12,5 % ")).toEqual({ rate: null, factor: 0.125 });
    expect(parseTaskRate("0,125")).toEqual({ rate: 0.125, factor: null });
  });

  it("will not guess at a comma that could be thousands", () => {
    // "1,250" is 1250 to one reader and 1.25 to another, and a guess is a rate
    // a thousand times wrong, so it is named rather than read either way.
    expect(taskRateProblem("1,250")).toBe(RATE_PROBLEM.AMBIGUOUS);
    expect(taskRateProblem("12,500%")).toBe(RATE_PROBLEM.AMBIGUOUS);
    expect(parseTaskRate("1,250")).toEqual({ rate: null, factor: null });
  });

  it("names what is wrong with a box that cannot be saved", () => {
    expect(taskRateProblem("-5")).toBe(RATE_PROBLEM.NEGATIVE);
    expect(taskRateProblem("-5%")).toBe(RATE_PROBLEM.NEGATIVE);
    expect(taskRateProblem("abc")).toBe(RATE_PROBLEM.UNREADABLE);
    expect(taskRateProblem("%")).toBe(RATE_PROBLEM.UNREADABLE);
    expect(taskRateProblem("12.5.1")).toBe(RATE_PROBLEM.UNREADABLE);
    for (const fine of ["", "  ", "0", "12.5", "12,5", "30%", " 12,5 % ", null, undefined]) {
      expect(taskRateProblem(fine)).toBeNull();
    }
  });

  it("keeps the rate a task has when handed something that is not one", () => {
    // Read as "no rate", a slip of the finger cleared the rate the task had.
    let s = setTaskRate(addTask(base, "p1", { id: "t1", label: "x" }, T), "p1", "t1", "35");
    for (const bad of ["-5", "abc", "1,250", "-5%"]) {
      s = setTaskRate(s, "p1", "t1", bad);
      expect(findTask(proj(s), "t1").rate).toBe(35);
    }
    expect(findTask(proj(setTaskRate(s, "p1", "t1", "12,5")), "t1").rate).toBe(12.5);
  });
});

describe("a note on a task", () => {
  it("keeps what the label cannot hold", () => {
    // The label is what every report groups by, so it stays short and stable.
    // The ticket id, the link and the caveat go here instead.
    const s = addTask(base, "p1", { id: "t1", label: "1234", note: "  QA-88 · rerun weekly " }, T);
    expect(findTask(proj(s), "t1").note).toBe("QA-88 · rerun weekly");
  });

  it("is left off when there is none, so absent keeps meaning none", () => {
    expect(addTask(base, "p1", { id: "t1", label: "1234" }, T).projects[0].tasks[0])
      .not.toHaveProperty("note");
    expect(addTask(base, "p1", { id: "t1", label: "1234", note: "   " }, T).projects[0].tasks[0])
      .not.toHaveProperty("note");
  });

  it("is written, rewritten and cleared", () => {
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = setTaskNote(s, "p1", "t1", "first");
    expect(findTask(proj(s), "t1").note).toBe("first");
    s = setTaskNote(s, "p1", "t1", "second");
    expect(findTask(proj(s), "t1").note).toBe("second");
    s = setTaskNote(s, "p1", "t1", "  ");
    expect(findTask(proj(s), "t1")).not.toHaveProperty("note");
  });

  it("never touches what the task is worth", () => {
    // A note is the one field on a task that no figure depends on.
    let s = addTask(base, "p1", { id: "t1", label: "1234", rate: 90, note: "a" }, T);
    s = setTaskNote(s, "p1", "t1", "b");
    expect(findTask(proj(s), "t1").rate).toBe(90);
  });

  it("reaches the breakdown, which is where it gets read", () => {
    let s = addTask(base, "p1", { id: "t1", label: "1234", note: "QA-88" }, T);
    s = startSession(s, proj(s), { now: T, id: "s1", taskId: "t1" });
    s = stopSession(s, "s1", T + HOUR);
    const row = taskTotals(proj(s), allSessionsFor(s, "p1"), T + HOUR)[0];
    expect(row.note).toBe("QA-88");
  });

  it("leaves other tasks alone", () => {
    let s = addTask(base, "p1", { id: "t1", label: "1234" }, T);
    s = addTask(s, "p1", { id: "t2", label: "1235" }, T);
    s = setTaskNote(s, "p1", "t1", "only mine");
    expect(findTask(proj(s), "t2")).not.toHaveProperty("note");
  });
});

describe("reading the task list in a chosen order", () => {
  /*
   * Rows built by hand rather than driven through sessions. The sort is a
   * pure function of four fields, and a fixture that had to earn each one
   * through a meter would hide which field each assertion is about.
   */
  const row = (taskId, billedCents, billedMs, idleMs, submittedAt) => ({
    taskId, label: taskId, billedCents, billedMs, idleMs, submittedAt,
  });

  //          id     earned  billed      idle       handed in
  const rows = [
    row("big", 30_000, 2 * HOUR, 0, T + 3 * HOUR),
    row("slow", 20_000, 9 * HOUR, 5 * HOUR, T + 1 * HOUR),
    row("quick", 10_000, 1 * HOUR, 1 * HOUR, T + 5 * HOUR),
    row("open", 5_000, 4 * HOUR, 0, undefined),
  ];
  const ids = (list) => list.map((r) => r.taskId);

  it("leaves the order alone when asked for one it does not have", () => {
    expect(sortTaskRows(rows, "whatever")).toBe(rows);
  });

  it("orders by what a task is worth", () => {
    expect(ids(sortTaskRows(rows, ORDER.PAY))).toEqual(["big", "slow", "quick", "open"]);
    expect(ids(sortTaskRows(rows, ORDER.PAY, false))).toEqual(["open", "quick", "slow", "big"]);
  });

  it("takes the amount from whoever asked, not from the clock alone", () => {
    // On work paid per accepted item the hours earn nothing by the hour, so
    // the caller supplies what the row is actually worth. Reversing the
    // figures must reverse the list.
    const payOf = (r) => -r.billedCents;
    expect(ids(sortTaskRows(rows, ORDER.PAY, true, payOf)))
      .toEqual(["open", "quick", "slow", "big"]);
  });

  it("orders by the day the work went in", () => {
    expect(ids(sortTaskRows(rows, ORDER.SUBMITTED))).toEqual(["quick", "big", "slow", "open"]);
  });

  it("keeps a task that was never handed in at the bottom either way round", () => {
    /*
     * The absence of a date is not an early date. Reversing "handed in"
     * should bring the oldest submission to the top — not every task that has
     * no submission at all, which would bury the answer under the rows that
     * cannot have it.
     */
    expect(ids(sortTaskRows(rows, ORDER.SUBMITTED, false)))
      .toEqual(["slow", "big", "quick", "open"]);
  });

  it("orders by the hours and by the hours lost", () => {
    expect(ids(sortTaskRows(rows, ORDER.TIME))).toEqual(["slow", "open", "big", "quick"]);
    expect(ids(sortTaskRows(rows, ORDER.IDLE))).toEqual(["slow", "quick", "big", "open"]);
    // Two tasks with no idle time at all keep the order they came in, which is
    // the earned-first one the breakdown already returns.
    expect(ids(sortTaskRows(rows, ORDER.IDLE)).slice(2)).toEqual(["big", "open"]);
  });

  it("does not disturb the list it was given", () => {
    const before = ids(rows);
    sortTaskRows(rows, ORDER.TIME);
    expect(ids(rows)).toEqual(before);
  });
});
