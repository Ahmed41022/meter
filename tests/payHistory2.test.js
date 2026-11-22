import { describe, it, expect } from "vitest";
import { companyStatement, historyByPayday, paymentHistory } from "../src/domain/payHistory.js";
import { upcomingPay } from "../src/domain/payout.js";
import { answerPayout } from "../src/domain/payouts.js";
import { lineRefs, markLines, readMarks, writeMarks } from "../src/domain/paylines.js";
import { setPayPeriod } from "../src/domain/payPeriod.js";

const HOUR = 3_600_000;
const at = (d, h = 12, m = 10) => Date.UTC(2026, m, d, h);
const NOW = at(17);
const utcWeekly = { kind: "weekly", cutoff: 1, payday: 3, after: 0, closesAt: 0, zone: "UTC" };

/** In before Monday, paid Wednesday, on a UTC clock. One billed hour a task at $40. */
const project = (id, tasks, currency = "USD", company = "Larkspur") => ({
  id, name: `Gateway ${id}`, company, currentRate: 40, currency, createdAt: at(1), tasks,
});
const sittings = (projectId, tasks, currency = "USD") => tasks.map((t) => ({
  id: `s-${projectId}-${t.id}`, projectId, kind: "billed", taskId: t.id, rate: 40, currency,
  deletedAt: null, createdAt: t.submittedAt - 3 * HOUR, closedAt: t.submittedAt - 2 * HOUR,
  segments: [{ startedAt: t.submittedAt - 3 * HOUR, endedAt: t.submittedAt - 2 * HOUR }],
}));
const ledger = (tasks, earnings = [], extra = {}) => ({
  projects: [project("p", tasks)],
  sessions: sittings("p", tasks),
  earnings,
  companies: [{ id: "co:larkspur", name: "Larkspur", payPeriod: utcWeekly, createdAt: at(1), deletedAt: null }],
  payouts: [],
  ...extra,
});
const task = (id, handedIn) => ({
  id, label: id, createdAt: at(1), state: "submitted", stateAt: handedIn, submittedAt: handedIn,
});
const bonus = (id, taskIds, cents, extra = {}) => ({
  id, projectId: "p", kind: "bonus", cents, currency: "USD", taskIds, at: at(12),
  createdAt: at(12), deletedAt: null, ...extra,
});
// Thu 12 Nov: paid Wed 18th (still ahead). Thu 5 Nov: Wed 11th. Thu 29 Oct: Wed 4th. Thu 22 Oct: Wed 28 Oct.
const t1 = task("t1", at(12));
const t9 = task("t9", at(5));
const t9b = task("t9b", at(5, 13));
const t8 = task("t8", at(29, 12, 9));
const t7 = task("t7", at(22, 12, 9));

let n = 0;
const makeId = () => `id${++n}`;
const hist = (s, now = NOW) => paymentHistory(s, now);
const answer = (s, fields, now = NOW) =>
  answerPayout(s, { client: "Larkspur", currency: "USD", projectId: "p", ...fields }, now, makeId);
const pay = (s) => upcomingPay(s, NOW);
const lineOf = (s, key) => [...pay(s).due, ...pay(s).overdue, ...pay(s).waiting]
  .flatMap((r) => r.tasks).find((l) => l.key === key);

describe("which paydays are in the history", () => {
  it("lists a payday that has passed with no word as unanswered, and leaves the coming one out", () => {
    const s = ledger([t1, t9]);
    const rows = hist(s);
    expect(rows.map((r) => [r.date, r.status])).toEqual([["2026-11-11", "unanswered"]]);
    expect(rows[0]).toMatchObject({
      key: "due|larkspur|2026-11-11|USD", client: "larkspur", company: "Larkspur", currency: "USD",
      scheduled: "2026-11-11", expectedCents: 4_000, receivedCents: 0, differenceCents: null,
      answeredAt: null, moved: false, paidLines: [],
    });
    expect(rows[0].lines.map((l) => [l.key, l.cents])).toEqual([["task:t9:hours", 4_000]]);
  });

  it("shows the lines in the shape the forecast gives them", () => {
    const s = ledger([t9], [bonus("b1", ["t9"], 500)]);
    expect(hist(s)[0].lines).toEqual(pay(s).overdue[0].tasks);
  });

  it("shows a paid payment with what came, and the difference", () => {
    const s = answer(ledger([t9]), { scheduled: "2026-11-11", outcome: "paid", expectedCents: 4_000, receivedNow: 3_900 });
    expect(hist(s)).toHaveLength(1);
    expect(hist(s)[0]).toMatchObject({
      status: "paid", date: "2026-11-11", expectedCents: 4_000, receivedCents: 3_900,
      differenceCents: -100, answeredAt: NOW,
    });
  });

  it("shows a payment paid exactly as expected with no difference", () => {
    const s = answer(ledger([t9]), { scheduled: "2026-11-11", outcome: "paid", expectedCents: 4_000 });
    expect(hist(s)[0]).toMatchObject({ status: "paid", expectedCents: 4_000, receivedCents: 4_000, differenceCents: 0 });
  });

  it("shows a partial payment on the day the rest is expected, with the rest outstanding", () => {
    const s = answer(ledger([t9]), {
      scheduled: "2026-11-11", outcome: "partial", movedTo: "2026-11-25", expectedCents: 4_000, receivedNow: 1_500,
    });
    const [row] = hist(s);
    // Answered, so it is here although its day is still ahead.
    expect(row).toMatchObject({
      status: "partial", date: "2026-11-25", scheduled: "2026-11-11", moved: true,
      expectedCents: 4_000, receivedCents: 1_500, differenceCents: null,
    });
    expect(companyStatement(hist(s), "Larkspur").totals.USD).toMatchObject({ received: 1_500, outstanding: 2_500 });
  });

  it("takes its figures from the answer, not from a forecast that has since changed", () => {
    let s = answer(ledger([t9]), { scheduled: "2026-11-11", outcome: "paid", expectedCents: 4_000 });
    s = { ...s, earnings: [bonus("late", ["t9"], 900)] };
    expect(hist(s)[0]).toMatchObject({ expectedCents: 4_000, receivedCents: 4_000 });
  });

  it("shows a cancelled payment with what was expected and what came", () => {
    const s = answer(ledger([t9]), { scheduled: "2026-11-11", outcome: "cancelled", expectedCents: 4_000 });
    expect(hist(s)[0]).toMatchObject({
      status: "cancelled", expectedCents: 4_000, receivedCents: 0, differenceCents: -4_000,
    });
  });

  it("shows an 'Already paid' answer to a payment whose day is still ahead", () => {
    const s = answer(ledger([t1]), { scheduled: "2026-11-18", outcome: "paid", expectedCents: 4_000 });
    expect(hist(s).map((r) => [r.date, r.status, r.receivedCents])).toEqual([["2026-11-18", "paid", 4_000]]);
  });

  it("shows a payment moved to a day that has passed there, still unanswered", () => {
    const s = answer(ledger([t9]), { scheduled: "2026-11-11", outcome: "moved", movedTo: "2026-11-14" });
    expect(hist(s)).toHaveLength(1);
    expect(hist(s)[0]).toMatchObject({
      status: "unanswered", date: "2026-11-14", scheduled: "2026-11-11", moved: true, expectedCents: 4_000,
    });
  });

  it("leaves out a payment moved to a day still ahead: it is still coming", () => {
    const s = answer(ledger([t9]), { scheduled: "2026-11-11", outcome: "moved", movedTo: "2026-11-24" });
    expect(hist(s)).toEqual([]);
  });

  it("keeps an answer whose payment the forecast no longer has", () => {
    let s = answer(ledger([t9]), { scheduled: "2026-11-11", outcome: "paid", expectedCents: 4_000 });
    s = { ...s, projects: [project("p", [])], sessions: [] };
    expect(hist(s)[0]).toMatchObject({ status: "paid", expectedCents: 4_000, receivedCents: 4_000, lines: [] });
  });

  it("sorts newest first", () => {
    const rows = hist(ledger([t9, t8, t7]));
    expect(rows.map((r) => r.date)).toEqual(["2026-11-11", "2026-11-04", "2026-10-28"]);
  });
});

describe("lines paid one by one", () => {
  it("files lines under the payday they were marked on, with the day recorded", () => {
    let s = ledger([t9, t9b]);
    s = markLines(s, [lineOf(s, "task:t9:hours")], { received: true, on: "2026-11-11" });
    const [row] = hist(s);
    // The other task is still unanswered on the same payday.
    expect(row).toMatchObject({ date: "2026-11-11", status: "unanswered", expectedCents: 4_000, paidLinesCents: 4_000 });
    expect(row.paidLines.map((l) => [l.key, l.cents, l.receivedOn, l.inferred]))
      .toEqual([["task:t9:hours", 4_000, "2026-11-11", false]]);
    expect(row.lines.map((l) => l.key)).toEqual(["task:t9b:hours"]);
  });

  it("stands a row of its own, lines-paid, when every line of the payday was paid", () => {
    let s = ledger([t1], [bonus("b1", ["t1"], 500)]);
    s = markLines(s, [lineOf(s, "task:t1:hours"), lineOf(s, "task:t1:bonus")], { received: true, on: "2026-11-18" });
    const [row] = hist(s);
    expect(row).toMatchObject({
      date: "2026-11-18", status: "lines-paid", expectedCents: 0, paidLinesCents: 4_500, lines: [],
    });
    expect(row.paidLines.map((l) => l.key)).toEqual(["task:t1:hours", "task:t1:bonus"]);
  });

  it("stands a lines-paid row on the recorded day when that payday no longer exists", () => {
    let s = ledger([t9]);
    s = markLines(s, [lineOf(s, "task:t9:hours")], { received: true, on: "2026-10-28" });
    expect(hist(s).map((r) => [r.date, r.status])).toEqual([["2026-10-28", "lines-paid"]]);
  });

  it("dates lines with no recorded day by the payday the rules give them, and marks them inferred", () => {
    let s = ledger([t9, t9b]);
    s = markLines(s, [lineOf(s, "task:t9:hours")], { received: true });
    const [row] = hist(s);
    expect(row.date).toBe("2026-11-11");
    expect(row.paidLines).toMatchObject([{ key: "task:t9:hours", receivedOn: "2026-11-11", inferred: true }]);
  });

  it("reads a line marked before dates were kept as received with no day", () => {
    const old = { ...t9, hoursReceived: true };
    const s = ledger([old]);
    expect(hist(s)[0]).toMatchObject({ status: "lines-paid", date: "2026-11-11" });
    expect(hist(s)[0].paidLines[0]).toMatchObject({ receivedOn: "2026-11-11", inferred: true });
  });

  it("keeps a payment's own adjustment out of its paid lines", () => {
    const s = answer(ledger([t9]), { scheduled: "2026-11-11", outcome: "paid", expectedCents: 4_000, receivedNow: 3_900 });
    expect(s.earnings.some((e) => e.received === true)).toBe(true);
    expect(hist(s)[0].paidLines).toEqual([]);
  });

  it("splits one line's earnings by the day each was recorded", () => {
    let s = ledger([t9], [bonus("b1", ["t9"], 500, { received: true, receivedOn: "2026-11-11" }),
      bonus("b2", ["t9"], 700, { received: true })]);
    s = { ...s, projects: [project("p", [{ ...t9, hoursReceived: true }])] };
    const [row] = hist(s);
    expect(row.paidLines.map((l) => [l.key, l.cents, l.receivedOn]).sort())
      .toEqual([["task:t9:bonus", 500, "2026-11-11"], ["task:t9:bonus", 700, "2026-11-11"], ["task:t9:hours", 4_000, "2026-11-11"]].sort());
  });
});

describe("money paid before dates were kept", () => {
  it("dates a task-less earning added as already paid from when it was added, by the schedule then", () => {
    // Added Thu 5 Nov, so the Wednesday after: the 11th.
    const loose = { id: "x1", projectId: "p", kind: "bonus", cents: 900, currency: "USD", taskIds: [],
      at: at(5), createdAt: at(5), deletedAt: null, received: true };
    let s = ledger([], [loose]);
    const [row] = hist(s);
    expect(row).toMatchObject({ date: "2026-11-11", status: "lines-paid", paidLinesCents: 900 });
    expect(row.paidLines).toMatchObject([{ key: "extra:x1", receivedOn: "2026-11-11", inferred: true }]);
    // A schedule changed afterwards leaves it on the payday it had, not the new rule's.
    s = setPayPeriod(s, "Larkspur", { ...utcWeekly, payday: 5 }, NOW);
    expect(hist(s)[0]).toMatchObject({ date: "2026-11-11", status: "lines-paid" });
  });

  it("leaves a company with no schedule out of the history", () => {
    const loose = { id: "x1", projectId: "p", kind: "bonus", cents: 900, currency: "USD", taskIds: [],
      at: at(5), createdAt: at(5), deletedAt: null, received: true };
    expect(hist(ledger([t9], [loose], { companies: [] }))).toEqual([]);
  });

  it("marks a recorded date as recorded, not inferred", () => {
    let s = ledger([t9]);
    s = markLines(s, [lineOf(s, "task:t9:hours")], { received: true, on: "2026-11-11" });
    expect(hist(s)[0].paidLines[0].inferred).toBe(false);
  });
});

describe("the day a line was paid, through marking, undo and moving", () => {
  it("is stored on the task for its hours and on the earning for the rest", () => {
    const s = ledger([t9], [bonus("b1", ["t9"], 500)]);
    const next = markLines(s, [lineOf(s, "task:t9:hours"), lineOf(s, "task:t9:bonus")], { received: true, on: "2026-11-11" });
    expect(next.projects[0].tasks[0]).toMatchObject({ hoursReceived: true, hoursReceivedOn: "2026-11-11" });
    expect(next.earnings[0]).toMatchObject({ received: true, receivedOn: "2026-11-11" });
  });

  it("leaves the day off when none is given, and off a day that is not a day", () => {
    const s = ledger([t9]);
    for (const on of [undefined, "next Wednesday", 5]) {
      const next = markLines(s, [lineOf(s, "task:t9:hours")], { received: true, on });
      expect(next.projects[0].tasks[0].hoursReceived).toBe(true);
      expect("hoursReceivedOn" in next.projects[0].tasks[0]).toBe(false);
    }
  });

  it("round-trips through readMarks and writeMarks, so Undo puts back exactly what was there", () => {
    const s = ledger([t9], [bonus("b1", ["t9"], 500)]);
    const lines = [lineOf(s, "task:t9:hours"), lineOf(s, "task:t9:bonus")];
    const before = readMarks(s, lineRefs(lines));
    expect(before.every((m) => m.received === false && m.receivedOn === null)).toBe(true);
    const marked = markLines(s, lines, { received: true, on: "2026-11-11" });
    const mid = readMarks(marked, lineRefs(lines));
    expect(mid.map((m) => [m.received, m.receivedOn])).toEqual([[true, "2026-11-11"], [true, "2026-11-11"]]);
    // Undo, then redo from what was read, is the same state each time.
    expect(writeMarks(marked, before)).toEqual(s);
    expect(writeMarks(writeMarks(marked, before), mid)).toEqual(marked);
  });

  it("is cleared when the line is moved", () => {
    const s = ledger([t9], [bonus("b1", ["t9"], 500)]);
    const lines = [lineOf(s, "task:t9:hours"), lineOf(s, "task:t9:bonus")];
    const marked = markLines(s, lines, { received: true, on: "2026-11-11" });
    const moved = markLines(marked, lines, { payday: "2026-12-02" });
    expect(moved.projects[0].tasks[0]).toMatchObject({ hoursPayday: "2026-12-02" });
    expect("hoursReceivedOn" in moved.projects[0].tasks[0]).toBe(false);
    expect("hoursReceived" in moved.projects[0].tasks[0]).toBe(false);
    expect("receivedOn" in moved.earnings[0]).toBe(false);
    expect(hist(moved).filter((r) => r.paidLines.length)).toEqual([]);
  });

  it("is cleared when the mark is taken off", () => {
    const s = ledger([t9]);
    const lines = [lineOf(s, "task:t9:hours")];
    const marked = markLines(s, lines, { received: true, on: "2026-11-11" });
    const off = writeMarks(marked, readMarks(marked, lineRefs(lines)).map((m) => ({ ...m, received: false })));
    expect(off.projects[0].tasks[0]).not.toHaveProperty("hoursReceivedOn");
  });

  it("is kept when an already paid line is marked paid again without a day", () => {
    const s = ledger([t9]);
    const lines = [lineOf(s, "task:t9:hours")];
    const marked = markLines(s, lines, { received: true, on: "2026-11-11" });
    expect(markLines(marked, lines, { received: true }).projects[0]).toBe(marked.projects[0]);
  });
});

describe("schedules, currencies and statements", () => {
  it("keeps a payday where it was when the schedule is changed afterwards", () => {
    const s = ledger([t9, t8]);
    const before = hist(s).map((r) => r.date);
    const friday = { ...utcWeekly, payday: 5 };
    const changed = setPayPeriod(s, "Larkspur", friday, NOW);
    expect(hist(changed).map((r) => r.date)).toEqual(before);
  });

  it("files an answer to a past payday under its date after the schedule changes", () => {
    let s = answer(ledger([t9]), { scheduled: "2026-11-11", outcome: "paid", expectedCents: 4_000 });
    s = setPayPeriod(s, "Larkspur", { ...utcWeekly, payday: 5 }, NOW);
    expect(hist(s).map((r) => [r.date, r.status])).toEqual([["2026-11-11", "paid"]]);
  });

  it("never adds two currencies together", () => {
    const eur = [task("e1", at(5)), task("e2", at(5, 13))];
    const s = ledger([t9], [], {
      projects: [project("p", [t9]), project("q", eur, "EUR")],
      sessions: [...sittings("p", [t9]), ...sittings("q", eur, "EUR")],
    });
    const rows = hist(s);
    expect(rows.map((r) => [r.currency, r.expectedCents]).sort()).toEqual([["EUR", 8_000], ["USD", 4_000]]);
    const { days, months } = historyByPayday(rows);
    expect(days).toHaveLength(1);
    expect(days[0].totals.USD.expected).toBe(4_000);
    expect(days[0].totals.EUR.expected).toBe(8_000);
    expect(months[0].totals).toEqual(days[0].totals);
    expect(Object.keys(companyStatement(rows, "larkspur").totals).sort()).toEqual(["EUR", "USD"]);
  });

  it("groups by date with per-date and per-month subtotals", () => {
    const s = ledger([t9, t9b, t8, t7]);
    const { days, months } = historyByPayday(hist(s));
    expect(days.map((d) => [d.date, d.rows.length, d.totals.USD.expected]))
      .toEqual([["2026-11-11", 1, 8_000], ["2026-11-04", 1, 4_000], ["2026-10-28", 1, 4_000]]);
    expect(months.map((m) => [m.month, m.dates, m.totals.USD.expected]))
      .toEqual([["2026-11", ["2026-11-11", "2026-11-04"], 12_000], ["2026-10", ["2026-10-28"], 4_000]]);
  });

  it("totals a company's statement per currency", () => {
    let s = ledger([t9, t8, t7, t1], [], { projects: [project("p", [t9, t8, t7, t1])] });
    s = answer(s, { scheduled: "2026-11-11", outcome: "paid", expectedCents: 4_000, receivedNow: 4_100 });
    s = answer(s, { scheduled: "2026-11-04", outcome: "cancelled", expectedCents: 4_000 });
    s = answer(s, { scheduled: "2026-10-28", outcome: "partial", movedTo: "2026-11-25", expectedCents: 4_000, receivedNow: 1_000 });
    s = answer(s, { scheduled: "2026-11-18", outcome: "paid", expectedCents: 4_000 });
    const st = companyStatement(hist(s), "LARKSPUR");
    expect(st.company).toBe("Larkspur");
    expect(st.totals).toEqual({
      // Four payments of 4,000 expected; 4,100, nothing, 1,000 and 4,000 came.
      USD: { expected: 16_000, received: 9_100, outstanding: 3_000, overdue: 0, coming: 3_000, waiting: 0, cancelled: 4_000, difference: 100 },
    });
    expect(st.paydays.map((r) => r.date)).toEqual(["2026-11-25", "2026-11-18", "2026-11-11", "2026-11-04"]);
    expect(st.paydays.every((r) => Array.isArray(r.lines))).toBe(true);
  });

  it("counts a unanswered payment as outstanding and lines paid as received", () => {
    let s = ledger([t9, t9b]);
    s = markLines(s, [lineOf(s, "task:t9:hours")], { received: true, on: "2026-11-11" });
    expect(companyStatement(hist(s), "Larkspur").totals.USD)
      .toEqual({ expected: 8_000, received: 4_000, outstanding: 4_000, overdue: 4_000, coming: 0, waiting: 0, cancelled: 0, difference: 0 });
  });

  it("is empty for a company with nothing in the period", () => {
    expect(companyStatement(hist(ledger([t9])), "Nobody")).toMatchObject({ totals: {}, paydays: [] });
  });
});

describe("periods", () => {
  const s = ledger([t9, t8, t7]);
  const rows = hist(s);

  it("includes both edges and nothing outside them", () => {
    const dates = (period) => historyByPayday(rows, period).days.map((d) => d.date);
    expect(dates({ from: "2026-11-04", to: "2026-11-11" })).toEqual(["2026-11-11", "2026-11-04"]);
    expect(dates({ from: "2026-11-05", to: "2026-11-10" })).toEqual([]);
    expect(dates({ from: "2026-11-11" })).toEqual(["2026-11-11"]);
    expect(dates({ to: "2026-10-28" })).toEqual(["2026-10-28"]);
    expect(dates({})).toHaveLength(3);
    expect(companyStatement(rows, "Larkspur", { from: "2026-11-04", to: "2026-11-04" }).paydays).toHaveLength(1);
  });

  it("ignores an edge that is not a day", () => {
    expect(historyByPayday(rows, { from: "soon", to: null }).days).toHaveLength(3);
  });

  it("judges whether a payday is past on the client's own clock", () => {
    // In before Monday, paid Tuesday: work from Thu 12 Nov is paid Tue 17th.
    const tuesday = { ...utcWeekly, payday: 2 };
    const east = { ...tuesday, zone: "Pacific/Kiritimati" };
    const late = Date.UTC(2026, 10, 17, 23);
    const mk = (rule) => ledger([t1], [], {
      companies: [{ id: "co:larkspur", name: "Larkspur", payPeriod: rule, createdAt: at(1), deletedAt: null }],
    });
    // 23:00 UTC on the 17th is already the 18th on Kiritimati's clock.
    expect(paymentHistory(mk(tuesday), late)).toEqual([]);
    expect(paymentHistory(mk(east), late).map((r) => [r.date, r.status])).toEqual([["2026-11-17", "unanswered"]]);
  });
});

describe("the forecast is untouched", () => {
  it("upcomingPay gives the same rows with the history built beside it", () => {
    const s = answer(ledger([t1, t9, t8]), { scheduled: "2026-11-04", outcome: "paid", expectedCents: 4_000 });
    const before = JSON.stringify(pay(s));
    hist(s);
    expect(JSON.stringify(pay(s))).toBe(before);
    expect(pay(s).overdue.map((r) => r.date)).toEqual(["2026-11-11"]);
    expect(pay(s).due.map((r) => r.date)).toEqual(["2026-11-18"]);
  });

  it("gives no settled fields on forecast lines", () => {
    const s = ledger([t9]);
    expect(pay(s).overdue[0].tasks[0]).not.toHaveProperty("receivedOn");
  });
});

describe("a large ledger", () => {
  it("is built in reasonable time from 10,000 sittings over three years", () => {
    const DAY = 86_400_000;
    const start = Date.UTC(2023, 10, 1, 12);
    const projects = [];
    const sessions = [];
    for (let p = 0; p < 6; p += 1) {
      const tasks = [];
      for (let i = 0; i < 1_667; i += 1) {
        const when = start + Math.floor((i / 1_667) * 1_095) * DAY;
        const t = { id: `t${p}-${i}`, label: `Task ${i}`, createdAt: when, state: "accepted", stateAt: when + 2 * DAY, submittedAt: when };
        tasks.push(t);
        sessions.push(...sittings(`p${p}`, [t]));
      }
      projects.push(project(`p${p}`, tasks, p % 2 ? "EUR" : "USD", p < 3 ? "Larkspur" : "Northwind"));
    }
    const state = {
      projects, sessions, earnings: [],
      companies: [
        { id: "co:larkspur", name: "Larkspur", payPeriod: utcWeekly, createdAt: start, deletedAt: null },
        { id: "co:northwind", name: "Northwind", payPeriod: { ...utcWeekly, payday: 5 }, createdAt: start, deletedAt: null },
      ],
      payouts: [],
    };
    expect(state.sessions.length).toBeGreaterThanOrEqual(10_000);
    const now = Date.UTC(2026, 10, 17, 12);
    const t0 = performance.now();
    const rows = paymentHistory(state, now);
    const took = performance.now() - t0;
    expect(rows.length).toBeGreaterThan(300);
    expect(rows.every((r) => r.status === "unanswered")).toBe(true);
    expect(took).toBeLessThan(5_000);
    const t1 = performance.now();
    historyByPayday(rows);
    companyStatement(rows, "Larkspur");
    expect(performance.now() - t1).toBeLessThan(1_000);
  });
});

describe("work on tasks never handed in", () => {
  // Open tasks (no hand-in, no answer) and sittings with no task: most of a
  // ledger kept before tasks were handed in. Each sitting is dated by the
  // period it was worked in, under the client's schedule.
  const open = (id) => ({ id, label: id, createdAt: at(1) });
  const sitting = (id, taskId, end, hours = 1, extra = {}) => ({
    id, projectId: "p", kind: "billed", taskId, rate: 40, currency: "USD",
    deletedAt: null, createdAt: end - hours * HOUR, closedAt: end,
    segments: [{ startedAt: end - hours * HOUR, endedAt: end }], ...extra,
  });
  const withSittings = (tasks, sessions, extra = {}) => ({ ...ledger([]), projects: [project("p", tasks)], sessions, ...extra });

  it("dates each sitting by when it was done and counts it as paid on that payday", () => {
    // Worked Thu 5 Nov -> paid Wed 11th; Thu 29 Oct -> Wed 4th. One task, two paydays.
    const s = withSittings([open("o1")], [sitting("a", "o1", at(5)), sitting("b", "o1", at(29, 12, 9), 2)]);
    const rows = hist(s);
    expect(rows.map((r) => [r.date, r.status, r.inferred, r.receivedCents])).toEqual([
      ["2026-11-11", "paid", true, 4_000], ["2026-11-04", "paid", true, 8_000],
    ]);
    expect(rows[1].lines).toMatchObject([{ key: "task:o1:hours", part: "hours", label: "o1", cents: 8_000 }]);
  });

  it("includes sittings with no task at all", () => {
    const rows = hist(withSittings([], [sitting("a", null, at(5))]));
    expect(rows).toHaveLength(1);
    expect(rows[0].lines[0]).toMatchObject({ label: "No task", cents: 4_000 });
  });

  it("leaves this period's open work out: it is still to be handed in", () => {
    // Worked Mon 16 Nov after the cutoff -> paid Wed 25th, not past.
    expect(hist(withSittings([open("o1")], [sitting("a", "o1", at(16, 12))]))).toEqual([]);
  });

  it("never counts a handed-in task twice: the forecast dates it, not this", () => {
    const s = ledger([t9]);
    const rows = hist(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].lines.map((l) => l.key)).toEqual(["task:t9:hours"]);
    expect(rows[0].status).toBe("unanswered");
  });

  it("adds the work to an answered payday as paid on top, keeping what the answer said", () => {
    // The owner's case: an answer given when only a bonus could be seen on that
    // payday said $5 came. The hours dated since were paid too, and must count
    // in what was received, not sit in the lines and nowhere in the totals.
    let s = withSittings([open("o1")], [sitting("a", "o1", at(5))], { earnings: [bonus("b0", [], 500, { at: at(5) })] });
    s = answer(s, { scheduled: "2026-11-11", outcome: "paid", expectedCents: 500, receivedNow: 500 });
    const [row] = hist(s);
    expect(row).toMatchObject({ status: "paid", expectedCents: 500, receivedCents: 500, paidLinesCents: 4_000 });
    expect(row.paidLines).toMatchObject([{ key: "task:o1:hours", cents: 4_000, inferred: true, worked: true, receivedOn: "2026-11-11" }]);
    expect(companyStatement(hist(s), "larkspur").totals.USD).toMatchObject({ received: 4_500, expected: 4_500, outstanding: 0 });
  });

  it("adds open work to a payday not answered as paid, leaving only the forecast's part owed", () => {
    const s = withSittings([t9, open("o1")], [...sittings("p", [t9]), sitting("a", "o1", at(6))]);
    const [row] = hist(s);
    expect(row).toMatchObject({ status: "unanswered", expectedCents: 4_000, paidLinesCents: 4_000 });
    expect(row.lines.map((l) => l.key)).toEqual(["task:t9:hours"]);
    expect(row.paidLines.map((l) => l.key)).toEqual(["task:o1:hours"]);
    expect(companyStatement(hist(s), "larkspur").totals.USD).toMatchObject({ outstanding: 4_000, received: 4_000 });
  });

  it("leaves out pending, cancelled, idle, running and off-clock time, and clients with no schedule", () => {
    const s = withSittings([open("o1")], [
      sitting("pend", "o1", at(5), 1, { status: "pending" }),
      sitting("canc", "o1", at(5), 1, { status: "cancelled" }),
      sitting("idle", "o1", at(5), 1, { kind: "idle" }),
      { ...sitting("run", "o1", at(5)), closedAt: null, segments: [{ startedAt: at(5), endedAt: null }] },
    ]);
    expect(hist(s)).toEqual([]);
    const off = withSittings([open("o1")], [sitting("a", "o1", at(5))]);
    off.projects[0].offClock = true;
    expect(hist(off)).toEqual([]);
    const none = withSittings([open("o1")], [sitting("a", "o1", at(5))], { companies: [] });
    expect(hist(none)).toEqual([]);
  });

  it("takes an earning on an open task with it, dated by the day it was added", () => {
    const s = withSittings([open("o1")], [], { earnings: [bonus("b1", ["o1"], 700, { at: at(5) })] });
    const [row] = hist(s);
    expect(row).toMatchObject({ date: "2026-11-11", receivedCents: 700, inferred: true });
    expect(row.lines[0]).toMatchObject({ key: "task:o1:bonus", cents: 700 });
  });

  it("keeps past dates where they were after the client's schedule changed", () => {
    let s = withSittings([open("o1")], [sitting("a", "o1", at(5))]);
    s = setPayPeriod(s, "Larkspur", { ...utcWeekly, payday: 5 }, NOW);
    expect(hist(s).map((r) => r.date)).toEqual(["2026-11-11"]);
  });
});

describe("schedule-dated work in exports", () => {
  it("counts it in the CSV's payday figures and does not call it paid line by line", async () => {
    const { paymentsCsv } = await import("../src/domain/paymentsCsv.js");
    const end = at(5);
    let s = { ...ledger([]), projects: [project("p", [{ id: "o1", label: "o1", createdAt: at(1) }])],
      sessions: [{ id: "a", projectId: "p", kind: "billed", taskId: "o1", rate: 40, currency: "USD", deletedAt: null,
        createdAt: end - HOUR, closedAt: end, segments: [{ startedAt: end - HOUR, endedAt: end }] }],
      earnings: [bonus("b0", [], 500, { at: at(5) })] };
    s = answer(s, { scheduled: "2026-11-11", outcome: "paid", expectedCents: 500, receivedNow: 500 });
    const lines = paymentsCsv(hist(s)).trim().split("\n");
    const cells = (l) => l.split(",").map((c) => c.replace(/^"|"$/g, ""));
    expect(cells(lines[1]).slice(4, 6)).toEqual(["45.00", "45.00"]);
    const worked = lines.find((l) => l.includes("\"o1\""));
    expect(cells(worked).slice(-3)).toEqual(["No", "2026-11-11", "schedule"]);
  });
});
