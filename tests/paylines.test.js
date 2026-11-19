import { describe, it, expect } from "vitest";
import { lineRefs, markLines, readMarks, writeMarks } from "../src/domain/paylines.js";
import { upcomingPay } from "../src/domain/payout.js";
import { mergeState, stampChanges } from "../src/domain/merge.js";

const HOUR = 3_600_000;
const at = (d, h = 12) => Date.UTC(2026, 10, d, h);
const NOW = at(17);
const utcWeekly = { kind: "weekly", cutoff: 1, payday: 3, after: 0, closesAt: 0, zone: "UTC" };

/** In before Monday, paid Wednesday, on a UTC clock. One billed hour a task at $40. */
const ledger = (tasks, earnings = []) => ({
  projects: [{ id: "p", name: "Gateway", company: "Larkspur", currentRate: 40, currency: "USD",
               createdAt: at(1), tasks }],
  sessions: tasks.map((t, i) => ({
    id: `s${i}`, projectId: "p", kind: "billed", taskId: t.id, rate: 40, currency: "USD",
    deletedAt: null, createdAt: t.submittedAt - 3 * HOUR, closedAt: t.submittedAt - 2 * HOUR,
    segments: [{ startedAt: t.submittedAt - 3 * HOUR, endedAt: t.submittedAt - 2 * HOUR }],
  })),
  earnings,
  companies: [{ id: "co:larkspur", name: "Larkspur", payPeriod: utcWeekly, createdAt: at(1), deletedAt: null }],
  payouts: [],
});
const task = (id, handedIn) => ({
  id, label: id, createdAt: at(1), state: "submitted", stateAt: handedIn, submittedAt: handedIn,
});
const bonus = (id, taskIds, cents, extra = {}) => ({
  id, projectId: "p", kind: "bonus", cents, currency: "USD", taskIds, at: at(12),
  createdAt: at(12), deletedAt: null, ...extra,
});
// Thu 12 Nov: paid Wed 18th. Thu 5 Nov: paid Wed 11th, now past. Thu 19th: paid the 25th.
const t1 = task("t1", at(12));
const t2 = task("t2", at(12, 13));
const old = task("t9", at(5));
const later = task("t4", at(19, 10));

const pay = (s) => upcomingPay(s, NOW);
const lines = (row) => row.tasks.map((l) => [l.key, l.cents]);
const lineOf = (s, key) => [...pay(s).due, ...pay(s).overdue, ...pay(s).waiting]
  .flatMap((r) => r.tasks).find((l) => l.key === key);

describe("which records a line is made of", () => {
  it("names the task for its hours, and every earning a task's line adds up", () => {
    const s = ledger([t1], [bonus("b1", ["t1"], 500), bonus("b2", ["t1"], 700)]);
    expect(lineOf(s, "task:t1:bonus")).toMatchObject({ cents: 1_200, earningIds: ["b1", "b2"] });
    expect(lineOf(s, "task:t1:hours").earningIds).toBeUndefined();
    expect(lineRefs([lineOf(s, "task:t1:hours"), lineOf(s, "task:t1:bonus")])).toEqual([
      { type: "hours", projectId: "p", taskId: "t1" },
      { type: "earning", id: "b1" }, { type: "earning", id: "b2" },
    ]);
  });

  it("names the one earning a shared reward or a task-less line is", () => {
    const s = ledger([t1, t2], [bonus("r", ["t1", "t2"], 900), bonus("x", [], 300)]);
    const reward = lineOf(s, "reward:r");
    const extra = lineOf(s, "extra:x");
    expect(lineRefs([reward, extra, reward])).toEqual([
      { type: "earning", id: "r" }, { type: "earning", id: "x" },
    ]);
  });
});

describe("marking lines paid", () => {
  it("takes a task's hours off its payday and leaves its bonus there", () => {
    const s = ledger([t1, t2], [bonus("b1", ["t1"], 500)]);
    const next = markLines(s, [lineOf(s, "task:t1:hours")], { received: true });
    expect(next.projects[0].tasks[0].hoursReceived).toBe(true);
    const [row] = pay(next).due;
    expect(lines(row)).toEqual([["task:t2:hours", 4_000], ["task:t1:bonus", 500]]);
    expect(row.cents).toBe(4_500);
  });

  it("takes a bonus off by marking its earning received, and the hours stay", () => {
    const s = ledger([t1], [bonus("b1", ["t1"], 500)]);
    const next = markLines(s, [lineOf(s, "task:t1:bonus")], { received: true });
    expect(next.earnings[0].received).toBe(true);
    expect(lines(pay(next).due[0])).toEqual([["task:t1:hours", 4_000]]);
  });

  it("drops the row once every line of it is paid, overdue or not", () => {
    const s = ledger([old]);
    const next = markLines(s, pay(s).overdue[0].tasks, { received: true });
    expect(pay(next)).toEqual({ due: [], waiting: [], overdue: [] });
  });

  it("takes a line under review off too", () => {
    const review = task("t5", at(16));
    const s = { ...ledger([review]), projects: [{ ...ledger([review]).projects[0], paysOnAcceptance: true }] };
    expect(pay(s).waiting).toHaveLength(1);
    const next = markLines(s, pay(s).waiting[0].tasks, { received: true });
    expect(pay(next).waiting).toEqual([]);
  });
});

describe("moving lines to another day", () => {
  it("puts a task's hours on the payment for that day, beside what else is paid then", () => {
    const s = ledger([t1, later], [bonus("b1", ["t1"], 500)]);
    const next = markLines(s, [lineOf(s, "task:t1:hours")], { payday: "2026-11-25" });
    expect(next.projects[0].tasks[0].hoursPayday).toBe("2026-11-25");
    const { due } = pay(next);
    expect(due.map((r) => [r.date, r.cents])).toEqual([["2026-11-18", 500], ["2026-11-25", 8_000]]);
    expect(lines(due[1]).map(([k]) => k).sort()).toEqual(["task:t1:hours", "task:t4:hours"]);
  });

  it("moves a bonus out of its task, and an overdue line onto a coming payday", () => {
    const s = ledger([old], [bonus("b1", ["t9"], 500)]);
    const next = markLines(s, [lineOf(s, "task:t9:bonus")], { payday: "2026-11-25" });
    expect(next.earnings[0].payday).toBe("2026-11-25");
    const { due, overdue } = pay(next);
    expect(overdue.map((r) => r.cents)).toEqual([4_000]);
    expect(due.map((r) => [r.date, r.cents])).toEqual([["2026-11-25", 500]]);
  });

  it("takes back an earlier 'paid' when a line is moved, so it is coming again", () => {
    const s = ledger([t1]);
    const paid = markLines(s, [lineOf(s, "task:t1:hours")], { received: true });
    const hours = { kind: "task", part: "hours", projectId: "p", taskId: "t1" };
    const moved = markLines(paid, [hours], { payday: "2026-11-25" });
    expect(moved.projects[0].tasks[0]).not.toHaveProperty("hoursReceived");
    expect(pay(moved).due.map((r) => r.date)).toEqual(["2026-11-25"]);
  });

  it("leaves out work under review moved to a day that has gone, like any passed floor", () => {
    const review = task("t5", at(16));
    const base = ledger([review]);
    const s = { ...base, projects: [{ ...base.projects[0], paysOnAcceptance: true }] };
    const next = markLines(s, pay(s).waiting[0].tasks, { payday: "2026-11-11" });
    expect(pay(next).waiting).toEqual([]);
  });

  it("changes nothing for anything that is not a real day or a known change", () => {
    const s = ledger([t1]);
    const line = [lineOf(s, "task:t1:hours")];
    expect(markLines(s, line, { payday: "next" })).toBe(s);
    expect(markLines(s, line, {})).toBe(s);
    expect(markLines(s, line, { received: "yes" })).toBe(s);
  });
});

describe("undo and sync", () => {
  it("puts lines back with an edit, and leaves records it never touched as they were", () => {
    const s = ledger([t1, t2], [bonus("b1", ["t1"], 500), bonus("b2", ["t2"], 200)]);
    const picked = [lineOf(s, "task:t1:hours"), lineOf(s, "task:t1:bonus")];
    const before = readMarks(s, lineRefs(picked));
    const marked = stampChanges(s, markLines(s, picked, { received: true }), 100);
    expect(marked.earnings[1]).toBe(s.earnings[1]);
    const undone = stampChanges(marked, writeMarks(marked, before), 200);
    expect(pay(undone)).toEqual(pay(s));
    // Rebuilt, so the undo is stamped later than the mark and wins a sync.
    expect(undone.earnings[0].updatedAt).toBe(200);
    expect(undone.projects[0].updatedAt).toBe(200);
    expect(undone.earnings[0]).not.toHaveProperty("received");
    expect(undone.projects[0].tasks[0]).not.toHaveProperty("hoursReceived");
  });

  it("does not stamp a record whose marks were already as asked", () => {
    const s = ledger([t1], [bonus("b1", ["t1"], 500, { received: true })]);
    const next = writeMarks(s, [{ type: "earning", id: "b1", received: true, payday: null }]);
    expect(next.earnings[0]).toBe(s.earnings[0]);
  });

  it("keeps a task's hours mark through a sync with a copy that never had it", () => {
    const s = stampChanges({}, ledger([t1]), 50);
    const mine = stampChanges(s, markLines(s, [lineOf(s, "task:t1:hours")], { received: true }), 100);
    expect(pay(mergeState(mine, s)).due).toEqual([]);
    expect(pay(mergeState(s, mine)).due).toEqual([]);
  });
});
