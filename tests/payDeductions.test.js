/**
 * Deductions come off their payday, and what is still to come is part of what
 * is still owed.
 *
 * Today is Tue 17 Nov 2026 on a UTC clock; Larkspur is in before Monday and
 * paid on Wednesday, so a task handed in on Thu 12 Nov is paid Wed 18 Nov (still
 * ahead) and one handed in on Thu 5 Nov was paid Wed 11 Nov (past).
 */
import { describe, it, expect } from "vitest";
import {
  STATUS, comingRows, companyStatement, historyByPayday, paymentHistory, totalsOf,
} from "../src/domain/payHistory.js";
import { upcomingPay } from "../src/domain/payout.js";
import { answerPayout } from "../src/domain/payouts.js";
import { lineRefs, markLines } from "../src/domain/paylines.js";
import { paymentsCsv, STATUS_WORD } from "../src/domain/paymentsCsv.js";

const HOUR = 3_600_000;
const at = (d, h = 12, m = 10) => Date.UTC(2026, m, d, h);
const NOW = at(17);
const utcWeekly = { kind: "weekly", cutoff: 1, payday: 3, after: 0, closesAt: 0, zone: "UTC" };

const task = (id, handedIn) => ({
  id, label: id, createdAt: at(1), state: "submitted", stateAt: handedIn, submittedAt: handedIn,
});
const sittings = (projectId, tasks, currency = "USD") => tasks.map((t) => ({
  id: `s-${projectId}-${t.id}`, projectId, kind: "billed", taskId: t.id, rate: 40, currency,
  deletedAt: null, createdAt: t.submittedAt - 3 * HOUR, closedAt: t.submittedAt - 2 * HOUR,
  segments: [{ startedAt: t.submittedAt - 3 * HOUR, endedAt: t.submittedAt - 2 * HOUR }],
}));
const earning = (id, kind, cents, extra = {}) => ({
  id, projectId: "p", kind, cents, currency: "USD", taskIds: [], at: at(14),
  createdAt: at(14), deletedAt: null, ...extra,
});
const ledger = (tasks, earnings = [], extra = {}) => ({
  projects: [{ id: "p", name: "Gateway", company: "Larkspur", currentRate: 40, currency: "USD", createdAt: at(1), tasks }],
  sessions: sittings("p", tasks),
  earnings,
  companies: [{ id: "co:larkspur", name: "Larkspur", payPeriod: utcWeekly, createdAt: at(1), deletedAt: null }],
  payouts: [],
  ...extra,
});
const t1 = task("t1", at(12)); // Wed 18 Nov, coming
const t9 = task("t9", at(5)); // Wed 11 Nov, past
let n = 0;
const makeId = () => `id${++n}`;
const hist = (s) => paymentHistory(s, NOW);
const pay = (s) => upcomingPay(s, NOW);
const answer = (s, fields) =>
  answerPayout(s, { client: "Larkspur", currency: "USD", projectId: "p", ...fields }, NOW, makeId);
const NOTHING = { due: [], waiting: [], overdue: [] };

describe("deductions on the forecast", () => {
  it("nets a task's deduction into its payday, as a line with its kind", () => {
    const s = ledger([t1], [
      earning("e1", "bonus", 10_000, { taskIds: ["t1"] }),
      earning("e2", "adjust", -4_500, { taskIds: ["t1"] }),
    ]);
    const [due] = pay(s).due;
    expect(due.cents).toBe(4_000 + 10_000 - 4_500);
    expect(due.tasks.map((l) => [l.part, l.cents])).toEqual([["hours", 4_000], ["bonus", 10_000], ["adjust", -4_500]]);
    expect(due.cents).toBe(due.tasks.reduce((sum, l) => sum + l.cents, 0));
  });

  it("puts a task-less deduction on the payday its date gives it, with a bonus beside it", () => {
    const s = ledger([], [earning("e1", "bonus", 2_500), earning("e2", "adjust", -1_000, { at: at(15) })]);
    const { due } = pay(s);
    expect(due.map((r) => [r.date, r.cents, r.extras])).toEqual([["2026-11-18", 1_500, 2]]);
    expect(due[0].tasks.map((l) => [l.part, l.cents]).sort()).toEqual([["adjust", -1_000], ["bonus", 2_500]]);
  });

  it("puts a deduction with a payday of its own on that payday, named for a task or not", () => {
    const s = ledger([t1], [
      earning("e1", "bonus", 5_000, { payday: "2026-11-25" }),
      earning("e2", "adjust", -2_000, { payday: "2026-11-25" }),
      earning("e3", "adjust", -2_000, { taskIds: ["t1"], payday: "2026-11-25" }),
    ]);
    const { due } = pay({ ...s, sessions: [] });
    expect(due.map((r) => [r.date, r.cents])).toEqual([["2026-11-25", 1_000]]);
  });

  it("takes a negative shared reward off the payday of the last of its tasks", () => {
    const s = ledger([t1, t9], [
      earning("r1", "bonus", 3_000, { taskIds: ["t1", "t9"] }),
      earning("r2", "adjust", -1_000, { taskIds: ["t1", "t9"] }),
    ]);
    const row = pay(s).due.find((r) => r.date === "2026-11-18");
    expect(row.tasks.filter((l) => l.kind === "reward").map((l) => l.cents).sort((a, b) => a - b)).toEqual([-1_000, 3_000]);
    expect(row.cents).toBe(4_000 + 3_000 - 1_000);
    expect(row.rewards).toBe(2);
  });

  it("does not list a payday that nets to nothing, or less, in Upcoming", () => {
    expect(pay(ledger([t1], [earning("e1", "adjust", -4_000, { taskIds: ["t1"] })]))).toEqual(NOTHING);
    expect(pay(ledger([], [earning("e1", "bonus", 1_000), earning("e2", "adjust", -1_500)]))).toEqual(NOTHING);
    // A past one is not overdue either: nothing is owed.
    expect(pay(ledger([t9], [earning("e1", "adjust", -4_000, { taskIds: ["t9"] })]))).toEqual(NOTHING);
    // A lone deduction, even a big one, makes no payment.
    expect(pay(ledger([t1], [earning("e1", "adjust", -9_000, { taskIds: ["t1"] })]))).toEqual(NOTHING);
  });

  it("leaves a kind that nets to zero without a line", () => {
    const s = ledger([t1], [earning("e1", "adjust", 300, { taskIds: ["t1"] }), earning("e2", "adjust", -300, { taskIds: ["t1"] })]);
    expect(pay(s).due[0].tasks.map((l) => l.part)).toEqual(["hours"]);
  });

  it("answering uses the net as what was expected", () => {
    const s = ledger([t9], [earning("e1", "bonus", 1_000, { taskIds: ["t9"] }), earning("e2", "adjust", -2_500, { taskIds: ["t9"] })]);
    const [row] = pay(s).overdue;
    expect(row.cents).toBe(4_000 + 1_000 - 2_500);
    const done = answer(s, { scheduled: row.date, outcome: "paid", expectedCents: row.cents });
    expect(done.payouts[0].expectedCents).toBe(2_500);
    // Paid exactly as the net: nothing to adjust, so the ledger gains nothing.
    expect(done.earnings).toHaveLength(2);
    expect(hist(done)[0]).toMatchObject({ status: STATUS.PAID, expectedCents: 2_500, receivedCents: 2_500, differenceCents: 0 });
  });

  it("keeps an answer's own adjustment out of the lines and the figures", () => {
    const s0 = ledger([t9], [earning("e1", "adjust", -1_000, { taskIds: ["t9"] })]);
    const before = pay(s0).overdue[0];
    expect(before.cents).toBe(3_000);
    // $28 came of $30: a $2 deduction written by the answer, marked received.
    const s = answer(s0, { scheduled: before.date, outcome: "paid", expectedCents: before.cents, receivedNow: 2_800 });
    const written = s.earnings.find((e) => e.id !== "e1");
    expect(written).toMatchObject({ kind: "adjust", cents: -200, received: true });
    const [row] = hist(s);
    expect(row.lines.map((l) => [l.part, l.cents])).toEqual([["hours", 4_000], ["adjust", -1_000]]);
    expect(row.paidLines).toEqual([]);
    expect(row).toMatchObject({ expectedCents: 3_000, receivedCents: 2_800, differenceCents: -200 });
    expect(pay(s)).toEqual(NOTHING);
  });

  it("lets a deduction line be marked paid like any other, or moved", () => {
    const s = ledger([t9], [earning("e1", "bonus", 1_000, { taskIds: ["t9"] }), earning("e2", "adjust", -2_000, { taskIds: ["t9"] })]);
    const line = pay(s).overdue[0].tasks.find((l) => l.part === "adjust");
    expect(lineRefs([line])).toEqual([{ type: "earning", id: "e2" }]);
    const paid = markLines(s, [line], { received: true, on: "2026-11-11" });
    expect(paid.earnings.find((e) => e.id === "e2")).toMatchObject({ received: true, receivedOn: "2026-11-11" });
    // The rest of the payday no longer carries it; the history has it as a paid line.
    expect(pay(paid).overdue[0].cents).toBe(5_000);
    const [row] = hist(paid);
    expect(row.paidLines.map((l) => [l.part, l.cents])).toEqual([["adjust", -2_000]]);
    expect(row.paidLinesCents).toBe(-2_000);
    const moved = markLines(s, [line], { payday: "2026-11-25" });
    expect(pay(moved).overdue[0].cents).toBe(5_000);
    // On its own on the 25th it nets below nothing, so no payment is listed.
    expect(pay(moved).due).toEqual([]);
  });
});

describe("deductions in the history", () => {
  it("lists a past unanswered payday at its net", () => {
    const s = ledger([t9], [earning("e1", "adjust", -1_000, { taskIds: ["t9"] })]);
    expect(hist(s)[0]).toMatchObject({ status: STATUS.UNANSWERED, expectedCents: 3_000 });
    expect(companyStatement(hist(s), "Larkspur").totals.USD)
      .toMatchObject({ expected: 3_000, outstanding: 3_000, overdue: 3_000 });
  });

  it("keeps a past payday that nets to nothing, with its lines, and counts the net", () => {
    const s = ledger([t9], [earning("e1", "adjust", -4_000, { taskIds: ["t9"] })]);
    const [row] = hist(s);
    expect(row).toMatchObject({ status: STATUS.NETTED, date: "2026-11-11", expectedCents: 0, receivedCents: 0 });
    expect(row.lines.map((l) => [l.part, l.cents])).toEqual([["hours", 4_000], ["adjust", -4_000]]);
    expect(STATUS_WORD[STATUS.NETTED]).toBe("Nothing to come");
    // Below nothing, the deduction is carried into the totals.
    const less = ledger([t9], [earning("e1", "adjust", -5_500, { taskIds: ["t9"] })]);
    expect(hist(less)[0]).toMatchObject({ status: STATUS.NETTED, expectedCents: -1_500, receivedCents: -1_500 });
    expect(totalsOf(hist(less)).USD).toMatchObject({ expected: -1_500, received: -1_500, outstanding: 0 });
  });

  it("counts deductions in the totals of a forecast row that was answered", () => {
    let s = ledger([t9], [earning("e1", "bonus", 1_000, { taskIds: ["t9"] }), earning("e2", "adjust", -2_500, { taskIds: ["t9"] })]);
    s = answer(s, { scheduled: "2026-11-11", outcome: "paid", expectedCents: 2_500 });
    expect(totalsOf(hist(s)).USD).toMatchObject({ expected: 2_500, received: 2_500 });
  });

  it("nets a deduction on an open task worked in the past (addWorkedLines)", () => {
    // Never handed in: dated by when it was done, and taken as paid.
    const open = { id: "o1", label: "o1", createdAt: at(1) };
    const sessions = [{
      id: "so", projectId: "p", kind: "billed", taskId: "o1", rate: 40, currency: "USD", deletedAt: null,
      createdAt: at(5, 9), closedAt: at(5, 11), segments: [{ startedAt: at(5, 9), endedAt: at(5, 11) }],
    }];
    const deduction = earning("e1", "adjust", -1_500, { taskIds: ["o1"], at: at(5, 12) });
    const s = { ...ledger([open]), sessions, earnings: [deduction] };
    const [row] = hist(s);
    // Two hours at $40, less $15.
    expect(row).toMatchObject({ status: STATUS.PAID, inferred: true, expectedCents: 6_500, receivedCents: 6_500 });
    expect(row.lines.map((l) => [l.part, l.cents]).sort()).toEqual([["adjust", -1_500], ["hours", 8_000]]);
    expect(totalsOf(hist(s)).USD).toMatchObject({ expected: 6_500, received: 6_500 });
    // A payday only deductions come to is netted, not paid.
    const only = { ...s, sessions: [] };
    expect(hist(only)[0]).toMatchObject({ status: STATUS.NETTED, expectedCents: -1_500, receivedCents: -1_500 });
    // An answer's own adjustment on an open task is still left out.
    const answered = {
      ...only,
      payouts: [{ id: "a", client: "Larkspur", currency: "USD", scheduled: "2026-11-11", outcome: "paid",
        expectedCents: 1, adjustmentId: "e1", answeredAt: NOW, createdAt: NOW, deletedAt: null }],
    };
    expect(hist(answered).flatMap((r) => [...r.lines, ...r.paidLines])).toEqual([]);
  });
});

describe("what is still owed, with what is coming", () => {
  // t9: Wed 11 Nov, unanswered ($40 overdue). t1: Wed 18 Nov, coming ($40).
  const s = ledger([t9, t1]);

  it("turns the forecast's due rows into coming rows, and leaves waiting apart", () => {
    const { coming, waiting } = comingRows(pay(s));
    expect(coming.map((r) => [r.status, r.date, r.expectedCents, r.receivedCents, r.currency]))
      .toEqual([["coming", "2026-11-18", 4_000, 0, "USD"]]);
    expect(coming[0].lines.map((l) => l.part)).toEqual(["hours"]);
    expect(waiting).toEqual([]);
  });

  it("makes Still owed overdue plus coming, and Expected include coming", () => {
    const { totals, coming } = historyByPayday(hist(s), {}, pay(s));
    expect(coming).toHaveLength(1);
    expect(totals.USD).toMatchObject({ expected: 8_000, received: 0, outstanding: 8_000, overdue: 4_000, coming: 4_000, waiting: 0 });
    // Without the forecast, as before.
    expect(historyByPayday(hist(s)).totals.USD).toMatchObject({ outstanding: 4_000, coming: 0 });
  });

  it("keeps work waiting on a review out of what is owed, and says it apart", () => {
    const forecast = {
      ...pay(s),
      waiting: [{ client: "larkspur", company: "Larkspur", currency: "USD", date: "2026-11-25", cents: 1_200, tasks: [] }],
    };
    const { totals } = historyByPayday(hist(s), {}, forecast);
    expect(totals.USD).toMatchObject({ waiting: 1_200, expected: 8_000, outstanding: 8_000 });
    expect(companyStatement(hist(s), "larkspur", {}, forecast).totals.USD.waiting).toBe(1_200);
    // Waiting money in another currency is its own card, never added.
    const eur = { ...forecast, waiting: [{ ...forecast.waiting[0], currency: "EUR", cents: 500 }] };
    expect(historyByPayday(hist(s), {}, eur).totals.EUR).toMatchObject({ waiting: 500, expected: 0, outstanding: 0 });
  });

  it("applies the period to coming paydays by their date", () => {
    const f = pay(s);
    const h = hist(s);
    expect(historyByPayday(h, { from: "2026-11-01", to: "2026-11-30" }, f).totals.USD.coming).toBe(4_000);
    expect(historyByPayday(h, { from: "2026-11-19", to: "2026-11-30" }, f).coming).toEqual([]);
    expect(historyByPayday(h, { from: "2026-10-01", to: "2026-10-31" }, f).totals).toEqual({});
    expect(historyByPayday(h, { from: "2025-01-01", to: "2025-12-31" }, f).totals).toEqual({});
    expect(historyByPayday(h, { from: "2026-11-18" }, f).totals.USD.coming).toBe(4_000);
    expect(historyByPayday(h, { to: "2026-11-17" }, f).totals.USD.coming).toBe(0);
  });

  it("does the same for a company, and for no other", () => {
    const f = pay(s);
    const st = companyStatement(hist(s), "LARKSPUR", {}, f);
    expect(st.totals.USD).toMatchObject({ outstanding: 8_000, overdue: 4_000, coming: 4_000 });
    expect(st.coming.map((r) => r.date)).toEqual(["2026-11-18"]);
    expect(companyStatement(hist(s), "Fernhill", {}, f)).toMatchObject({ totals: {}, paydays: [], coming: [] });
    // A company with nothing but coming money still has its name.
    expect(companyStatement([], "larkspur", {}, f).company).toBe("Larkspur");
  });

  it("counts a moved payday on the day it was moved to, and a partly paid rest only once", () => {
    let m = answer(s, { scheduled: "2026-11-18", outcome: "moved", movedTo: "2026-12-02", expectedCents: 4_000 });
    expect(comingRows(pay(m)).coming.map((r) => [r.date, r.scheduled, r.moved])).toEqual([["2026-12-02", "2026-11-18", true]]);
    expect(historyByPayday(hist(m), { from: "2026-11-01", to: "2026-11-30" }, pay(m)).totals.USD.coming).toBe(0);
    expect(historyByPayday(hist(m), { from: "2026-12-01", to: "2026-12-31" }, pay(m)).totals.USD.coming).toBe(4_000);
    // Partly paid, the rest due on a day ahead: owed once, as coming (its day
    // has not come), beside the separate $40 payday still to come.
    m = answer(s, { scheduled: "2026-11-11", outcome: "partial", movedTo: "2026-11-25", expectedCents: 4_000, receivedNow: 1_000 });
    const { totals } = historyByPayday(hist(m), {}, pay(m));
    expect(totals.USD).toMatchObject({ overdue: 0, coming: 7_000, outstanding: 7_000, received: 1_000, expected: 8_000 });
  });

  it("includes coming paydays in the CSV with the status Coming", () => {
    const { coming } = historyByPayday(hist(s), {}, pay(s));
    const csv = paymentsCsv([...coming, ...hist(s)]).trimEnd().split("\n");
    expect(csv[1]).toBe('"2026-11-18","Larkspur","USD","Coming","40.00","0.00","","Hours","t1","Gateway","40.00","No","",""');
    expect(csv).toHaveLength(3);
  });

  it("nets deductions into a coming payday, and a coming payday of nothing is not coming", () => {
    const d = ledger([t1], [earning("e1", "bonus", 1_000, { taskIds: ["t1"] }), earning("e2", "adjust", -500, { taskIds: ["t1"] })]);
    expect(historyByPayday(hist(d), {}, pay(d)).totals.USD).toMatchObject({ coming: 4_500, outstanding: 4_500 });
    const none = ledger([t1], [earning("e2", "adjust", -4_000, { taskIds: ["t1"] })]);
    expect(historyByPayday(hist(none), {}, pay(none)).totals).toEqual({});
  });

  it("never adds across currencies", () => {
    const both = ledger([t1]);
    const e1 = task("e1", at(12));
    both.projects.push({ id: "q", name: "Atlas", company: "Larkspur", currentRate: 40, currency: "EUR", createdAt: at(1), tasks: [e1] });
    both.sessions.push(...sittings("q", [e1], "EUR"));
    const { totals } = historyByPayday(hist(both), {}, pay(both));
    expect(Object.keys(totals).sort()).toEqual(["EUR", "USD"]);
    expect(totals.EUR.coming).toBe(4_000);
    expect(totals.USD.coming).toBe(4_000);
  });
});

describe("a partly paid payment's rest", () => {
  it("is coming when it is due on a later day, and overdue once that day has passed", async () => {
    const { paymentHistory, historyByPayday } = await import("../src/domain/payHistory.js");
    const { answerPayout } = await import("../src/domain/payouts.js");
    const { upcomingPay } = await import("../src/domain/payout.js");
    const HOUR = 3_600_000;
    const at = (d, h = 12) => Date.UTC(2026, 10, d, h);
    const t = { id: "t9", label: "t9", createdAt: at(1), state: "submitted", stateAt: at(5), submittedAt: at(5) };
    let s = {
      projects: [{ id: "p", name: "G", company: "Larkspur", currentRate: 40, currency: "USD", createdAt: at(1), tasks: [t] }],
      sessions: [{ id: "s", projectId: "p", kind: "billed", taskId: "t9", rate: 40, currency: "USD", deletedAt: null,
        createdAt: at(5) - 3 * HOUR, closedAt: at(5) - 2 * HOUR, segments: [{ startedAt: at(5) - 3 * HOUR, endedAt: at(5) - 2 * HOUR }] }],
      earnings: [], payouts: [],
      companies: [{ id: "co:larkspur", name: "Larkspur", payPeriod: { kind: "weekly", cutoff: 1, payday: 3, after: 0, closesAt: 0, zone: "UTC" }, createdAt: at(1), deletedAt: null }],
    };
    // $40 due Wed 11th; $15 came, the rest expected Wed 25th.
    s = answerPayout(s, { client: "Larkspur", currency: "USD", scheduled: "2026-11-11", outcome: "partial", movedTo: "2026-11-25", expectedCents: 4_000, receivedNow: 1_500, projectId: "p" }, at(17), () => "a1");
    const totals = (now) => historyByPayday(paymentHistory(s, now), {}, upcomingPay(s, now)).totals.USD;
    expect(totals(at(17))).toMatchObject({ outstanding: 2_500, coming: 2_500, overdue: 0, received: 1_500 });
    expect(totals(at(27))).toMatchObject({ outstanding: 2_500, coming: 0, overdue: 2_500 });
  });
});
