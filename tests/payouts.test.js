import { describe, it, expect } from "vitest";
import {
  OUTCOME, allPayouts, answerPayout, answerPayouts, answersByPayment, clockFor, largestProject,
  livePayouts, payoutKey, removePayout, restorePayment, restorePayout, snapshotPayment,
} from "../src/domain/payouts.js";
import { EARNING, earningTotals, liveEarnings } from "../src/domain/earnings.js";
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
    const s = answerPayout(base, paid, 100, () => "a1");
    expect(s.payouts).toEqual([{
      id: "a1", client: "Larkspur", currency: "USD", scheduled: "2026-11-18", outcome: "paid",
      answeredAt: 100, createdAt: 100, deletedAt: null,
    }]);
    expect(answersByPayment(s).get(payoutKey("larkspur ", "USD", "2026-11-18")).id).toBe("a1");
  });

  it("replaces an earlier answer rather than adding a second", () => {
    const first = answerPayout(base, paid, 100, () => "a1");
    const moved = answerPayout(first, { ...paid, outcome: OUTCOME.MOVED, movedTo: "2026-11-25" }, 200, () => "a2");
    expect(moved.payouts).toHaveLength(1);
    expect(moved.payouts[0]).toMatchObject({ id: "a1", outcome: "moved", movedTo: "2026-11-25", answeredAt: 200, createdAt: 100 });
    // Answered paid again, the old move goes with it.
    const again = answerPayout(moved, paid, 300, () => "a3");
    expect(again.payouts[0]).not.toHaveProperty("movedTo");
    expect(livePayouts(again)).toHaveLength(1);
  });

  it("treats the client's folded name as one payment, and a currency or date as another", () => {
    const s = answerPayout(base, paid, 1, () => "a1");
    expect(answerPayout(s, { ...paid, client: " larkspur" }, 2, () => "a2").payouts).toHaveLength(1);
    expect(answerPayout(s, { ...paid, currency: "EUR" }, 2, () => "a2").payouts).toHaveLength(2);
    expect(answerPayout(s, { ...paid, scheduled: "2026-11-25" }, 2, () => "a2").payouts).toHaveLength(2);
  });

  it("refuses what would be stored as a lie", () => {
    expect(answerPayout(base, { ...paid, client: " " }, 1, () => "a")).toBe(base);
    expect(answerPayout(base, { ...paid, scheduled: "soon" }, 1, () => "a")).toBe(base);
    expect(answerPayout(base, { ...paid, outcome: "lost" }, 1, () => "a")).toBe(base);
    expect(answerPayout(base, { ...paid, outcome: OUTCOME.MOVED }, 1, () => "a")).toBe(base);
    expect(answerPayout(base, { ...paid, outcome: OUTCOME.MOVED, movedTo: "next" }, 1, () => "a")).toBe(base);
  });

  it("answers many at once, each under an id of its own", () => {
    let n = 0;
    const s = answerPayouts(base, [paid, { ...paid, scheduled: "2026-11-25" }], 5, () => `n${++n}`);
    expect(s.payouts.map((p) => p.id)).toEqual(["n1", "n2"]);
  });

  it("removes by tombstone and restores, and a store without any reads as none", () => {
    const s = answerPayout(base, paid, 1, () => "a1");
    const gone = removePayout(s, "a1", 9);
    expect(gone.payouts[0].deletedAt).toBe(9);
    expect(livePayouts(gone)).toEqual([]);
    expect(livePayouts(restorePayout(gone, "a1"))).toHaveLength(1);
    expect(allPayouts(base)).toEqual([]);
  });

  it("is stamped by the sync like any other record, and merges on the later answer", () => {
    const s = answerPayout(base, paid, 1, () => "a1");
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
      { client: "Larkspur", currency: "USD", scheduled: "2026-11-18", outcome: "paid" }, 1, () => "x");
    const movedAgain = answerPayout(replaced,
      { client: "Larkspur", currency: "USD", scheduled: "2026-11-18", outcome: "moved", movedTo: "2026-12-02" }, 2, () => "y");
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

describe("answering with amounts", () => {
  const ids = () => { let n = 0; return () => `id${++n}`; };
  const state = (extra = {}) => ledger([future], [], extra);
  const rowOf = (s) => upcomingPay(s, NOW).due[0];
  const answerRow = (s, row, fields, when = at(17), makeId = ids()) => answerPayout(s, {
    client: row.company, currency: row.currency, scheduled: row.scheduled,
    expectedCents: row.cents, projectId: largestProject(row), ...fields,
  }, when, makeId);
  const settled = (s) => earningTotals(liveEarnings(s)).settled;
  const live = (s) => livePayouts(s)[0];
  const who = (row) => ({ client: row.company, currency: row.currency, scheduled: row.scheduled });

  it("pays exactly as expected without a received amount, and writes no money", () => {
    const s0 = state();
    const s = answerRow(s0, rowOf(s0), { outcome: OUTCOME.PAID });
    expect(live(s)).toMatchObject({ outcome: "paid", expectedCents: 4_000 });
    expect(live(s)).not.toHaveProperty("receivedCents");
    expect(live(s)).not.toHaveProperty("adjustmentId");
    expect(s.earnings).toEqual([]);
    // An amount that is the amount is the same thing.
    const same = answerRow(s0, rowOf(s0), { outcome: OUTCOME.PAID, receivedNow: 4_000 });
    expect(live(same)).not.toHaveProperty("receivedCents");
  });

  it("records $41 for an expected $40 as a one dollar adjustment in the row's currency and project", () => {
    const s0 = state();
    const s = answerRow(s0, rowOf(s0), { outcome: OUTCOME.PAID, receivedNow: 4_100 });
    expect(live(s)).toMatchObject({ receivedCents: 4_100, expectedCents: 4_000 });
    const [adjust] = s.earnings;
    expect(adjust).toMatchObject({
      id: live(s).adjustmentId, projectId: "p", kind: EARNING.ADJUSTMENT, cents: 100,
      currency: "USD", at: at(17), received: true, deletedAt: null,
    });
    expect(adjust).not.toHaveProperty("taskIds");
    expect(adjust.note).toMatch(/Received \$41\.00 of \$40\.00 · Larkspur, /);
    expect(settled(s)).toEqual({ USD: 100 });
    // Received, so the forecast never counts it as coming.
    expect(upcomingPay(s, NOW)).toEqual({ due: [], waiting: [], overdue: [] });
  });

  it("makes less than expected a negative adjustment", () => {
    const s0 = state();
    const s = answerRow(s0, rowOf(s0), { outcome: OUTCOME.PAID, receivedNow: 3_500 });
    expect(s.earnings[0].cents).toBe(-500);
    expect(settled(s)).toEqual({ USD: -500 });
  });

  it("cancels: the row goes, the money comes off the earnings, and received is what came", () => {
    const s0 = state();
    const s = answerRow(s0, rowOf(s0), { outcome: OUTCOME.CANCELLED });
    expect(live(s)).toMatchObject({ outcome: "cancelled", receivedCents: 0 });
    expect(s.earnings[0]).toMatchObject({ cents: -4_000, kind: EARNING.ADJUSTMENT });
    expect(settled(s)).toEqual({ USD: -4_000 });
    expect(upcomingPay(s, NOW).due).toEqual([]);
    // Some of it came before it was cancelled.
    const some = answerRow(s0, rowOf(s0), { outcome: OUTCOME.CANCELLED, receivedNow: 1_000 });
    expect(settled(some)).toEqual({ USD: -3_000 });
  });

  it("partly received: lists only the rest at the new date, with no money written yet", () => {
    const s0 = state();
    const s = answerRow(s0, rowOf(s0), { outcome: OUTCOME.PARTIAL, receivedNow: 1_500, movedTo: "2026-11-25" });
    expect(s.earnings).toEqual([]);
    const { due } = upcomingPay(s, NOW);
    expect(due.map((r) => [r.date, r.scheduled, r.cents, r.moved])).toEqual([["2026-11-25", "2026-11-18", 2_500, true]]);
    expect(due[0].partial).toEqual({ expectedCents: 4_000, receivedCents: 1_500 });
    // Back overdue when the new date passes.
    expect(upcomingPay(s, at(26)).overdue.map((r) => [r.date, r.cents])).toEqual([["2026-11-25", 2_500]]);
  });

  it("refuses a partial with nothing to wait for, or no day, or a bad amount", () => {
    const s0 = state();
    const row = rowOf(s0);
    for (const fields of [
      { outcome: OUTCOME.PARTIAL, receivedNow: 4_000, movedTo: "2026-11-25" },
      { outcome: OUTCOME.PARTIAL, receivedNow: 100 },
      { outcome: OUTCOME.PAID, receivedNow: -5 },
      { outcome: OUTCOME.PAID, receivedNow: NaN },
    ]) expect(answerRow(s0, row, fields)).toBe(s0);
    // A difference with no project to book it to is refused too.
    expect(answerRow(s0, row, { outcome: OUTCOME.CANCELLED, projectId: "gone" })).toBe(s0);
  });

  it("adds up what a partial answer receives, and closes against what was expected at first", () => {
    let s = state();
    s = answerRow(s, rowOf(s), { outcome: OUTCOME.PARTIAL, receivedNow: 1_500, movedTo: "2026-11-25" });
    // The remainder row is now 2,500; the same payment answered again adds to it.
    const rest = upcomingPay(s, NOW).due[0];
    s = answerRow(s, rest, { outcome: OUTCOME.PARTIAL, receivedNow: 1_000, movedTo: "2026-12-02" });
    expect(live(s)).toMatchObject({ outcome: "partial", receivedCents: 2_500, expectedCents: 4_000 });
    expect(upcomingPay(s, NOW).due[0].cents).toBe(1_500);
    // Closed for the rest: exactly as expected in all, so no money.
    const exact = answerRow(s, upcomingPay(s, NOW).due[0], { outcome: OUTCOME.PAID, receivedNow: 1_500 });
    expect(live(exact)).not.toHaveProperty("receivedCents");
    expect(exact.earnings).toEqual([]);
    // $1 over in all.
    const over = answerRow(s, upcomingPay(s, NOW).due[0], { outcome: OUTCOME.PAID, receivedNow: 1_600 });
    expect(live(over)).toMatchObject({ receivedCents: 4_100 });
    expect(over.earnings.map((e) => e.cents)).toEqual([100]);
  });

  it("keeps the expected figure from the first answer when the forecast has since changed", () => {
    let s = state();
    s = answerRow(s, rowOf(s), { outcome: OUTCOME.MOVED, movedTo: "2026-11-25" });
    expect(live(s).expectedCents).toBe(4_000);
    // The row has grown, and a later answer still measures against what it was.
    const grown = { ...rowOf(s), cents: 9_999 };
    const later = answerRow(s, grown, { outcome: OUTCOME.PAID, receivedNow: 4_000 });
    expect(live(later)).toMatchObject({ expectedCents: 4_000 });
    expect(later.earnings).toEqual([]);
  });

  it("books a difference in the row's own currency, to the project the row is mostly from", () => {
    const eur = { id: "e1", projectId: "p", taskId: "t1", kind: EARNING.BONUS, cents: 2_000, currency: "EUR",
                  units: 1, at: at(12), createdAt: at(12), deletedAt: null };
    const s0 = state({ earnings: [eur] });
    const row = upcomingPay(s0, NOW).due.find((r) => r.currency === "EUR");
    const s = answerRow(s0, row, { outcome: OUTCOME.PAID, receivedNow: 2_100 });
    const adjust = s.earnings.find((e) => e.kind === EARNING.ADJUSTMENT);
    expect(adjust).toMatchObject({ currency: "EUR", cents: 100, projectId: "p" });
    expect(settled(s)).toEqual({ EUR: 2_100 });
  });

  it("picks the project with the most in the row, the first on a tie", () => {
    const line = (projectId, cents) => ({ projectId, cents });
    expect(largestProject({ tasks: [line("a", 100), line("b", 300), line("a", 150)] })).toBe("b");
    expect(largestProject({ tasks: [line("a", 100), line("b", 100)] })).toBe("a");
    expect(largestProject({ tasks: [] })).toBeNull();
  });

  it("replaces the adjustment when the payment is answered again", () => {
    const s0 = state();
    const row = rowOf(s0);
    const makeId = ids();
    const paid = answerRow(s0, row, { outcome: OUTCOME.PAID, receivedNow: 4_100 }, at(17), makeId);
    const first = live(paid).adjustmentId;
    const cancelled = answerRow(paid, row, { outcome: OUTCOME.CANCELLED }, at(18), makeId);
    expect(livePayouts(cancelled)).toHaveLength(1);
    expect(live(cancelled).adjustmentId).not.toBe(first);
    expect(cancelled.earnings.find((e) => e.id === first).deletedAt).toBe(at(18));
    expect(settled(cancelled)).toEqual({ USD: -4_000 });
    // Answered as exact after having been off by a dollar: no adjustment left.
    const exact = answerRow(paid, row, { outcome: OUTCOME.PAID }, at(18), makeId);
    expect(settled(exact)).toEqual({});
    expect(live(exact)).not.toHaveProperty("adjustmentId");
  });

  it("takes an answer back as edits, restoring both the answer and the adjustment", () => {
    const s0 = state();
    const row = rowOf(s0);
    const key = payoutKey(row.company, row.currency, row.scheduled);
    const makeId = ids();
    // First answered, then answered again; undo the second.
    const paid = answerRow(s0, row, { outcome: OUTCOME.PAID, receivedNow: 4_100 }, at(17), makeId);
    const snap = snapshotPayment(paid, who(row));
    const cancelled = answerRow(paid, row, { outcome: OUTCOME.CANCELLED }, at(18), makeId);
    const back = restorePayment(cancelled, key, snap, at(19));
    expect(live(back)).toMatchObject({ outcome: "paid", receivedCents: 4_100, adjustmentId: snap.answer.adjustmentId });
    expect(settled(back)).toEqual({ USD: 100 });
    // Undo of a first answer tombstones the answer and its adjustment.
    const snap0 = snapshotPayment(s0, who(row));
    const gone = restorePayment(paid, key, snap0, at(19));
    expect(livePayouts(gone)).toEqual([]);
    expect(settled(gone)).toEqual({});
    // Nothing was dropped, so a sync has only edits to carry.
    expect(allPayouts(gone)).toHaveLength(1);
    expect(gone.earnings).toHaveLength(1);
    expect(gone.earnings[0].deletedAt).toBe(at(19));
    // And the forecast has its row back.
    expect(upcomingPay(gone, NOW).due).toHaveLength(1);
  });

  it("stamps every record an answer and its undo touch", () => {
    const s0 = state();
    const row = rowOf(s0);
    const paid = answerRow(s0, row, { outcome: OUTCOME.PAID, receivedNow: 4_100 });
    const stamped = stampChanges(s0, paid, 77);
    expect(stamped.payouts[0].updatedAt).toBe(77);
    expect(stamped.earnings[0].updatedAt).toBe(77);
    const undone = restorePayment(stamped, payoutKey(row.company, row.currency, row.scheduled),
      { answer: null, adjustment: null }, 90);
    const restamped = stampChanges(stamped, undone, 91);
    expect(restamped.payouts[0]).toMatchObject({ deletedAt: 90, updatedAt: 91 });
    expect(restamped.earnings[0]).toMatchObject({ deletedAt: 90, updatedAt: 91 });
  });

  it("reads an answer written before amounts existed as exactly as expected", () => {
    const s = ledger([future], [answer("2026-11-18", "paid")]);
    expect(upcomingPay(s, NOW)).toEqual({ due: [], waiting: [], overdue: [] });
    expect(earningTotals(liveEarnings(s)).settled).toEqual({});
  });

  it("gives a payment's clock: today on the client's calendar, and the next payday from now", () => {
    expect(clockFor(state(), { company: "Larkspur" }, NOW)).toEqual({ today: "2026-11-17", next: "2026-11-25" });
  });
});
