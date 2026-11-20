import { describe, it, expect } from "vitest";
import { paydayThrough, setPayPeriod } from "../src/domain/payPeriod.js";
import { upcomingPay } from "../src/domain/payout.js";

const HOUR = 3_600_000;
const at = (d, h = 12) => Date.UTC(2026, 10, d, h);
const NOW = at(17); // Tue 17 Nov
/** In before Monday, paid Wednesday, on a UTC clock. */
const WED = { kind: "weekly", cutoff: 1, payday: 3, after: 0, closesAt: 0, zone: "UTC" };
const FRI = { ...WED, payday: 5 };
const MON = { ...WED, payday: 1 };

const ledger = (tasks, payouts = []) => ({
  projects: [{ id: "p", name: "Gateway", company: "Larkspur", currentRate: 40, currency: "USD",
               createdAt: at(1), tasks }],
  sessions: tasks.map((t, i) => ({
    id: `s${i}`, projectId: "p", kind: "billed", taskId: t.id, rate: 40, currency: "USD",
    deletedAt: null, createdAt: t.submittedAt - 3 * HOUR, closedAt: t.submittedAt - 2 * HOUR,
    segments: [{ startedAt: t.submittedAt - 3 * HOUR, endedAt: t.submittedAt - 2 * HOUR }],
  })),
  earnings: [],
  companies: [{ id: "co:larkspur", name: "Larkspur", payPeriod: WED, createdAt: at(1), deletedAt: null }],
  payouts,
});
const task = (id, handedIn) => ({
  id, label: id, createdAt: at(1), state: "submitted", stateAt: handedIn, submittedAt: handedIn,
});
// Thu 5 Nov: paid Wed 11th, passed. Thu 12th: paid Wed 18th, still due.
const past = task("past", at(5));
const due = task("due", at(12));
const dates = (s, now = NOW) => {
  const { due: d, overdue } = upcomingPay(s, now);
  return { overdue: overdue.map((r) => r.date), due: d.map((r) => r.date) };
};

describe("changing a client's schedule", () => {
  it("keeps a payday that had passed, and moves the one still to come", () => {
    const s = setPayPeriod(ledger([past, due]), "Larkspur", FRI, NOW);
    expect(s.companies[0].history).toEqual([{ rule: WED, until: NOW }]);
    expect(dates(s)).toEqual({ overdue: ["2026-11-11"], due: ["2026-11-20"] });
  });

  it("still finds the answer given about a passed payday under its old date", () => {
    const answered = ledger([past, due], [{
      id: "a", client: "Larkspur", currency: "USD", scheduled: "2026-11-11", outcome: "paid",
      answeredAt: at(12), createdAt: at(12), deletedAt: null,
    }]);
    const s = setPayPeriod(answered, "Larkspur", FRI, NOW);
    expect(dates(s)).toEqual({ overdue: [], due: ["2026-11-20"] });
  });

  it("dates work done after the change by the new schedule alone", () => {
    const later = task("later", at(19));
    const s = setPayPeriod(ledger([later]), "Larkspur", FRI, NOW);
    expect(dates(s, at(20, 1))).toEqual({ overdue: [], due: ["2026-11-27"] });
  });

  it("moves a payday falling on the day of the change, which was still to come", () => {
    // Changed on Wed 18th itself: the 18th had not passed yet.
    const s = setPayPeriod(ledger([due]), "Larkspur", FRI, at(18, 9));
    expect(dates(s, at(18, 10)).due).toEqual(["2026-11-20"]);
  });

  it("keeps passed paydays through two changes, each under the rule it had", () => {
    const mid = task("mid", at(19)); // under Fri: paid Fri 27th
    let s = setPayPeriod(ledger([past, due, mid]), "Larkspur", FRI, NOW);
    // On 1 Dec the client moves to Mondays. The 27th had passed by then and
    // stays; the 11th stays from the first change.
    s = setPayPeriod(s, "Larkspur", MON, at(31)); // Tue 1 Dec
    expect(s.companies[0].history.map((h) => h.rule.payday)).toEqual([3, 5]);
    const { overdue } = dates(s, at(32));
    expect(overdue).toEqual(["2026-11-11", "2026-11-20", "2026-11-27"]);
  });

  it("puts everything back when the change is undone with the old schedule", () => {
    const changed = setPayPeriod(ledger([past, due]), "Larkspur", FRI, NOW);
    const undone = setPayPeriod(changed, "Larkspur", WED, NOW + 1_000);
    expect(dates(undone)).toEqual(dates(ledger([past, due])));
  });

  it("records nothing when the same schedule is saved again, or when there was none", () => {
    const same = setPayPeriod(ledger([past]), "Larkspur", { ...WED }, NOW);
    expect(same.companies[0]).not.toHaveProperty("history");
    const none = { ...ledger([past]), companies: [] };
    const first = setPayPeriod(none, "Larkspur", WED, NOW);
    expect(first.companies[0]).not.toHaveProperty("history");
    const cleared = setPayPeriod({ ...ledger([past]),
      companies: [{ ...ledger([]).companies[0], payPeriod: null }] }, "Larkspur", WED, NOW);
    expect(cleared.companies[0]).not.toHaveProperty("history");
  });

  it("reads a record written before history existed exactly as before", () => {
    expect(dates(ledger([past, due]))).toEqual({ overdue: ["2026-11-11"], due: ["2026-11-18"] });
    expect(paydayThrough(undefined, WED, at(5))).toEqual(paydayThrough([], WED, at(5)));
  });

  it("ignores a history step it cannot read", () => {
    const junk = [{ rule: null, until: NOW }, { rule: WED }, null];
    expect(paydayThrough(junk, FRI, at(5)).date).toBe("2026-11-13");
  });
});
