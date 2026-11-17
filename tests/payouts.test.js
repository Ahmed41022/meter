import { describe, it, expect } from "vitest";
import {
  OUTCOME, allPayouts, answerPayout, answerPayouts, answersByPayment, livePayouts, payoutKey,
  removePayout, restorePayout,
} from "../src/domain/payouts.js";
import { upcomingPay } from "../src/domain/payout.js";
import { mergeState, stampChanges } from "../src/domain/merge.js";

const HOUR = 3_600_000;
const at = (d, h = 12) => Date.UTC(2026, 10, d, h);
const NOW = at(17);
const utcWeekly = { kind: "weekly", cutoff: 1, payday: 3, after: 0, closesAt: 0, zone: "UTC" };

/** In before Monday, paid Wednesday, on a UTC clock. */
const ledger = (tasks, payouts, extra = {}) => ({
  projects: [{ id: "p", name: "Gateway", company: "Larkspur", currentRate: 40, currency: "USD",
               createdAt: at(1), tasks }],
  sessions: tasks.map((t, i) => ({
    id: `s${i}`, projectId: "p", kind: "billed", taskId: t.id, rate: 40, currency: "USD",
    deletedAt: null, createdAt: t.submittedAt - 3 * HOUR, closedAt: t.submittedAt - 2 * HOUR,
    segments: [{ startedAt: t.submittedAt - 3 * HOUR, endedAt: t.submittedAt - 2 * HOUR }],
  })),
  earnings: [],
  companies: [{ id: "co:larkspur", name: "Larkspur", payPeriod: utcWeekly, createdAt: at(1), deletedAt: null }],
  payouts,
  ...extra,
});
const task = (id, handedIn) => ({
  id, label: id, createdAt: at(1), state: "submitted", stateAt: handedIn, submittedAt: handedIn,
});
// Handed in Thu 12 Nov: paid Wed 18th. Thu 5 Nov: paid Wed 11th, now past.
const future = task("t1", at(12));
const past = task("t2", at(5));
const answer = (scheduled, outcome, movedTo, extra = {}) => ({
  id: `a-${scheduled}`, client: "Larkspur", currency: "USD", scheduled, outcome,
  ...(movedTo ? { movedTo } : {}), answeredAt: at(16), createdAt: at(16), deletedAt: null, ...extra,
});

describe("answers to payments", () => {
  const base = { projects: [], sessions: [] };
  const paid = { client: "Larkspur", currency: "USD", scheduled: "2026-11-18", outcome: OUTCOME.PAID };

  it("records an answer under the payment it is about", () => {
    const s = answerPayout(base, paid, 100, "a1");
    expect(s.payouts).toEqual([{
      id: "a1", client: "Larkspur", currency: "USD", scheduled: "2026-11-18", outcome: "paid",
      answeredAt: 100, createdAt: 100, deletedAt: null,
    }]);
    expect(answersByPayment(s).get(payoutKey("larkspur ", "USD", "2026-11-18")).id).toBe("a1");
  });

  it("replaces an earlier answer rather than adding a second", () => {
    const first = answerPayout(base, paid, 100, "a1");
    const moved = answerPayout(first, { ...paid, outcome: OUTCOME.MOVED, movedTo: "2026-11-25" }, 200, "a2");
    expect(moved.payouts).toHaveLength(1);
    expect(moved.payouts[0]).toMatchObject({ id: "a1", outcome: "moved", movedTo: "2026-11-25", answeredAt: 200, createdAt: 100 });
    // Answered paid again, the old move goes with it.
    const again = answerPayout(moved, paid, 300, "a3");
    expect(again.payouts[0]).not.toHaveProperty("movedTo");
    expect(livePayouts(again)).toHaveLength(1);
  });

  it("treats the client's folded name as one payment, and a currency or date as another", () => {
    const s = answerPayout(base, paid, 1, "a1");
    expect(answerPayout(s, { ...paid, client: " larkspur" }, 2, "a2").payouts).toHaveLength(1);
    expect(answerPayout(s, { ...paid, currency: "EUR" }, 2, "a2").payouts).toHaveLength(2);
    expect(answerPayout(s, { ...paid, scheduled: "2026-11-25" }, 2, "a2").payouts).toHaveLength(2);
  });

  it("refuses what would be stored as a lie", () => {
    expect(answerPayout(base, { ...paid, client: " " }, 1, "a")).toBe(base);
    expect(answerPayout(base, { ...paid, scheduled: "soon" }, 1, "a")).toBe(base);
    expect(answerPayout(base, { ...paid, outcome: "lost" }, 1, "a")).toBe(base);
    expect(answerPayout(base, { ...paid, outcome: OUTCOME.MOVED }, 1, "a")).toBe(base);
    expect(answerPayout(base, { ...paid, outcome: OUTCOME.MOVED, movedTo: "next" }, 1, "a")).toBe(base);
  });

  it("answers many at once, each under an id of its own", () => {
    let n = 0;
    const s = answerPayouts(base, [paid, { ...paid, scheduled: "2026-11-25" }], 5, () => `n${++n}`);
    expect(s.payouts.map((p) => p.id)).toEqual(["n1", "n2"]);
  });

  it("removes by tombstone and restores, and a store without any reads as none", () => {
    const s = answerPayout(base, paid, 1, "a1");
    const gone = removePayout(s, "a1", 9);
    expect(gone.payouts[0].deletedAt).toBe(9);
    expect(livePayouts(gone)).toEqual([]);
    expect(livePayouts(restorePayout(gone, "a1"))).toHaveLength(1);
    expect(allPayouts(base)).toEqual([]);
  });

  it("is stamped by the sync like any other record, and merges on the later answer", () => {
    const s = answerPayout(base, paid, 1, "a1");
    expect(stampChanges(base, s, 50).payouts[0].updatedAt).toBe(50);
    const other = { ...s, payouts: [{ ...s.payouts[0], outcome: "moved", movedTo: "2026-12-02", updatedAt: 60 }] };
    expect(mergeState(stampChanges(base, s, 50), other).payouts[0].outcome).toBe("moved");
  });
});

describe("the forecast with answers", () => {
  const rows = (s) => upcomingPay(s, NOW);

  it("keeps a payment the owner has not answered, and lists a past one as overdue", () => {
    const { due, overdue, waiting } = rows(ledger([future, past], []));
    expect(due.map((r) => [r.date, r.scheduled])).toEqual([["2026-11-18", "2026-11-18"]]);
    expect(overdue.map((r) => [r.date, r.cents])).toEqual([["2026-11-11", 4_000]]);
    expect(waiting).toEqual([]);
    expect(due[0].moved).toBeUndefined();
  });

  it("lists overdue rows oldest first", () => {
    const older = task("t3", at(1));
    expect(rows(ledger([past, older], [])).overdue.map((r) => r.date)).toEqual(["2026-11-04", "2026-11-11"]);
  });

  it("takes a payment off the list once it is marked paid, overdue or not", () => {
    const s = ledger([future, past], [answer("2026-11-18", "paid"), answer("2026-11-11", "paid")]);
    expect(rows(s)).toEqual({ due: [], waiting: [], overdue: [] });
  });

  it("lists a moved payment at its new date, as the same row, never merged into another", () => {
    const other = task("t4", at(19, 10)); // after Monday's cutoff: paid on the 25th
    const s = ledger([future, other], [answer("2026-11-18", "moved", "2026-11-25")]);
    const { due } = rows(s);
    expect(due.map((r) => [r.date, r.scheduled, !!r.moved, r.cents])).toEqual([
      ["2026-11-25", "2026-11-18", true, 4_000], ["2026-11-25", "2026-11-25", false, 4_000],
    ]);
    expect(new Set(due.map((r) => r.key)).size).toBe(2);
  });

  it("makes a moved payment overdue once the new date passes, and still moved", () => {
    const s = ledger([future], [answer("2026-11-18", "moved", "2026-11-16")]);
    const { due, overdue } = rows(s);
    expect(due).toEqual([]);
    expect(overdue.map((r) => [r.date, r.scheduled, r.moved])).toEqual([["2026-11-16", "2026-11-18", true]]);
  });

  it("is an answer for the payment only, so another date or currency is untouched", () => {
    const s = ledger([future, past], [answer("2026-11-18", "paid", null, { currency: "EUR" })]);
    expect(rows(s).due).toHaveLength(1);
  });

  it("leaves money waiting on a review as it was", () => {
    const review = { ...task("t5", at(16)), state: "submitted" };
    const s = ledger([review], [answer("2026-11-25", "paid")]);
    s.projects[0].paysOnAcceptance = true;
    const { waiting, due } = rows(s);
    expect(due).toEqual([]);
    expect(waiting.map((r) => r.date)).toEqual(["2026-11-25"]);
  });

  it("answers twice with the later answer, and ignores a tombstoned one", () => {
    const replaced = answerPayout(ledger([future], []),
      { client: "Larkspur", currency: "USD", scheduled: "2026-11-18", outcome: "paid" }, 1, "x");
    const movedAgain = answerPayout(replaced,
      { client: "Larkspur", currency: "USD", scheduled: "2026-11-18", outcome: "moved", movedTo: "2026-12-02" }, 2, "y");
    expect(rows(movedAgain).due.map((r) => r.date)).toEqual(["2026-12-02"]);
    const undone = removePayout(movedAgain, "x", 3);
    expect(rows(undone).due.map((r) => r.date)).toEqual(["2026-11-18"]);
  });

  it("lists a past payment as overdue the day after it, on the client's clock", () => {
    const s = ledger([future], []);
    expect(upcomingPay(s, at(18, 23)).due).toHaveLength(1);
    expect(upcomingPay(s, at(19, 0)).overdue).toHaveLength(1);
  });
});
