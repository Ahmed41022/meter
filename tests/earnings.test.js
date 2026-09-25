import { describe, it, expect } from "vitest";
import {
  EARNING, PAY, addEarning, earningTotals, earningsFor, earningsIn, isCancelled,
  isPending, isSettled, liveEarnings, paysOnAcceptance, payStateOf, removeEarning,
  isPerTask, perTask, perTaskCents, restoreEarning, setPayState,
} from "../src/domain/earnings.js";
import { performanceIn, untimedShare, byProject, byCompany } from "../src/domain/performance.js";
import { KIND } from "../src/domain/sessions.js";

const T = new Date(2026, 4, 5, 12).getTime();
const HOUR = 3_600_000;
const project = { id: "p1", name: "orion", currentRate: 20.5, currency: "USD" };
const empty = { projects: [project], sessions: [], earnings: [] };

describe("money that is not an hour of work", () => {
  it("records an amount with no duration anywhere on it", () => {
    // The whole point: sessions derive money from time, and this cannot.
    const s = addEarning(empty, project, { cents: 300_000, kind: EARNING.PIECE, at: T }, T, "e1");
    expect(s.earnings[0]).toMatchObject({
      projectId: "p1", cents: 300_000, currency: "USD", kind: EARNING.PIECE, at: T,
    });
    expect(s.earnings[0]).not.toHaveProperty("segments");
    expect(s.earnings[0]).not.toHaveProperty("rate");
  });

  it("keeps how many accepted items the money covers", () => {
    // "6 tasks at $500" is the fact; "$3,000" is only the consequence.
    const s = addEarning(empty, project,
      { cents: 300_000, kind: EARNING.PIECE, at: T, units: 6 }, T, "e1");
    expect(s.earnings[0].units).toBe(6);
  });

  it("refuses an amount of nothing", () => {
    expect(addEarning(empty, project, { cents: 0, at: T }, T, "e1").earnings).toHaveLength(0);
    expect(addEarning(empty, project, { cents: NaN, at: T }, T, "e1").earnings).toHaveLength(0);
  });

  it("takes a negative amount, because a clawback is a real thing", () => {
    const s = addEarning(empty, project,
      { cents: -5_000, kind: EARNING.ADJUSTMENT, at: T }, T, "e1");
    expect(s.earnings[0].cents).toBe(-5_000);
  });

  it("removes and restores without losing the record", () => {
    const s = addEarning(empty, project, { cents: 1_000, at: T }, T, "e1");
    const gone = removeEarning(s, "e1", T + 1);
    expect(liveEarnings(gone)).toHaveLength(0);
    expect(gone.earnings).toHaveLength(1);
    expect(liveEarnings(restoreEarning(gone, "e1"))).toHaveLength(1);
  });

  it("reads a store written before earnings existed as having none", () => {
    expect(liveEarnings({ projects: [], sessions: [] })).toEqual([]);
    expect(earningsFor({ projects: [], sessions: [] }, "p1")).toEqual([]);
  });

  it("belongs to a window by its instant, having no span to overlap", () => {
    const at = (h) => new Date(2026, 4, 5, h).getTime();
    const list = [
      { id: "a", at: at(9), currency: "USD", cents: 100 },
      { id: "b", at: at(23), currency: "USD", cents: 100 },
    ];
    expect(earningsIn(list, at(0), at(12)).map((e) => e.id)).toEqual(["a"]);
    // half-open, like every other window in the app
    expect(earningsIn(list, at(9), at(23)).map((e) => e.id)).toEqual(["a"]);
  });
});

describe("whether money has landed", () => {
  it("reads an absent status as settled, so nothing already stored changed", () => {
    expect(payStateOf({ id: "s1" })).toBe(PAY.PAID);
    expect(isSettled({ id: "s1" })).toBe(true);
    expect(isPending({ id: "s1" })).toBe(false);
  });

  it("moves a record between states and clears back to absent", () => {
    const s = { ...empty, sessions: [{ id: "s1", projectId: "p1" }] };
    expect(setPayState(s, "s1", PAY.PENDING).sessions[0].status).toBe(PAY.PENDING);
    const back = setPayState(setPayState(s, "s1", PAY.PENDING), "s1", PAY.PAID);
    // absent rather than "paid", because absent is what settled has always meant
    expect(back.sessions[0]).not.toHaveProperty("status");
    expect(isSettled(back.sessions[0])).toBe(true);
  });

  it("moves earnings by the same call", () => {
    const s = addEarning(empty, project, { cents: 1_000, at: T }, T, "e1");
    expect(setPayState(s, "e1", PAY.CANCELLED).earnings[0].status).toBe(PAY.CANCELLED);
  });

  it("splits settled from pending and drops cancelled", () => {
    const list = [
      { currency: "USD", cents: 100 },
      { currency: "USD", cents: 50, status: PAY.PENDING },
      { currency: "USD", cents: 999, status: PAY.CANCELLED },
    ];
    expect(earningTotals(list)).toEqual({ settled: { USD: 100 }, pending: { USD: 50 } });
  });

  it("knows a project that only pays once the work is accepted", () => {
    expect(paysOnAcceptance(project)).toBe(false);
    expect(paysOnAcceptance({ ...project, paysOnAcceptance: true })).toBe(true);
  });

  it("keeps cancelled work rather than deleting it", () => {
    // The hours were still worked. Erasing the record would leave them in the
    // ledger with no account of where their money went.
    const s = addEarning(empty, project, { cents: 1_181, at: T }, T, "e1");
    const killed = setPayState(s, "e1", PAY.CANCELLED);
    expect(liveEarnings(killed)).toHaveLength(1);
    expect(isCancelled(liveEarnings(killed)[0])).toBe(true);
  });
});

describe("reporting money that no clock measured", () => {
  const at = (d, h = 9) => new Date(2026, 4, d, h).getTime();
  const from = at(1, 0);
  const to = at(31, 0);
  const now = at(30);
  const session = (id, hours, extra = {}) => ({
    id, projectId: "p1", kind: KIND.BILLED, rate: 20.5, currency: "USD", deletedAt: null,
    segments: [{ startedAt: at(10), endedAt: at(10) + hours * HOUR }],
    closedAt: at(10) + hours * HOUR, ...extra,
  });
  const earning = (id, cents, extra = {}) =>
    ({ id, projectId: "p1", currency: "USD", cents, at: at(12), kind: EARNING.PIECE, deletedAt: null, ...extra });

  it("adds money with no hours into the total without moving the clock", () => {
    const r = performanceIn([session("s1", 2)], from, to, now, undefined, [earning("e1", 300_000)]);
    expect(r.billedMs).toBe(2 * HOUR);
    expect(r.billedCents.USD).toBe(4_100 + 300_000);
    // and the timed part is kept apart, so a rate can be quoted either way
    expect(r.timedCents.USD).toBe(4_100);
  });

  it("reports what share of the money no clock measured", () => {
    const r = performanceIn([session("s1", 2)], from, to, now, undefined, [earning("e1", 300_000)]);
    expect(untimedShare(r, "USD")).toBeCloseTo(300_000 / 304_100, 6);
    expect(untimedShare(performanceIn([session("s1", 2)], from, to, now), "USD")).toBe(0);
    expect(untimedShare(performanceIn([], from, to, now), "USD")).toBeNull();
  });

  it("keeps pending money out of the headline and on its own line", () => {
    const r = performanceIn(
      [session("s1", 2, { status: PAY.PENDING })], from, to, now, undefined,
      [earning("e1", 50_000, { status: PAY.PENDING })]);
    expect(r.billedCents.USD ?? 0).toBe(0);
    expect(r.pendingCents.USD).toBe(4_100 + 50_000);
    // the hours still happened, whoever has not paid for them yet
    expect(r.billedMs).toBe(2 * HOUR);
  });

  it("counts cancelled money nowhere but keeps its hours", () => {
    const r = performanceIn(
      [session("s1", 2, { status: PAY.CANCELLED })], from, to, now, undefined,
      [earning("e1", 999_00, { status: PAY.CANCELLED })]);
    expect(r.billedCents.USD ?? 0).toBe(0);
    expect(r.pendingCents.USD ?? 0).toBe(0);
    expect(r.billedMs).toBe(0);
  });

  it("keeps a piece-rate project in the breakdown though it has no session", () => {
    // Its entire income was paid per accepted item. Filtering on hours alone
    // would drop the project that earned the most.
    const rows = byProject([project], [], from, to, now, undefined, [earning("e1", 975_000)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].billedCents.USD).toBe(975_000);
    expect(rows[0].billedMs).toBe(0);
  });

  it("keeps such a project in the company breakdown too", () => {
    const withCo = { ...project, company: "Northwind" };
    const rows = byCompany([withCo], [], from, to, now, undefined, [earning("e1", 975_000)]);
    expect(rows.map((r) => r.company)).toEqual(["Northwind"]);
    expect(rows[0].billedCents.USD).toBe(975_000);
  });

  it("files each earning under its own project", () => {
    const other = { id: "p2", name: "lumen", currentRate: 7.5, currency: "USD" };
    const rows = byProject([project, other], [], from, to, now, undefined,
      [earning("e1", 100_00), { ...earning("e2", 25_00), projectId: "p2" }]);
    const byId = Object.fromEntries(rows.map((r) => [r.project.id, r]));
    expect(byId.p1.billedCents.USD).toBe(100_00);
    expect(byId.p2.billedCents.USD).toBe(25_00);
  });
});

describe("a project that only pays once the work is accepted", () => {
  const onAcceptance = { ...project, paysOnAcceptance: true };

  it("starts its meter pending rather than counted", async () => {
    const { startSession } = await import("../src/domain/sessions.js");
    const s = startSession(empty, onAcceptance, { now: T, id: "s1" });
    expect(s.sessions[0].status).toBe(PAY.PENDING);
    expect(isPending(s.sessions[0])).toBe(true);
  });

  it("does the same for time typed in after the fact", async () => {
    const { addManualSession } = await import("../src/domain/sessions.js");
    const s = addManualSession(empty, onAcceptance,
      { startedAt: T, endedAt: T + HOUR }, T, "m1");
    expect(s.sessions[0].status).toBe(PAY.PENDING);
  });

  it("leaves an ordinary project's sessions with no status at all", async () => {
    const { startSession } = await import("../src/domain/sessions.js");
    expect(startSession(empty, project, { now: T, id: "s1" }).sessions[0])
      .not.toHaveProperty("status");
  });
});

describe("work priced per accepted item", () => {
  it("reads a project written before per-item pricing existed as having none", () => {
    expect(perTask(project)).toBeNull();
    expect(isPerTask(project)).toBe(false);
  });

  it("takes a price per item and multiplies it out", () => {
    const p = { ...project, perTask: 250 };
    expect(perTask(p)).toBe(250);
    expect(isPerTask(p)).toBe(true);
    expect(perTaskCents(p, 6)).toBe(150_000); // 6 x $250
  });

  it("refuses a price that is not one", () => {
    for (const bad of [0, -5, "", null, "abc", NaN]) {
      expect(perTask({ ...project, perTask: bad })).toBeNull();
    }
  });

  it("says null rather than zero when there is nothing to multiply", () => {
    // A confident $0.00 reads as "these items are worth nothing", which is a
    // different claim from "this project has no per-item price".
    expect(perTaskCents(project, 6)).toBeNull();
    expect(perTaskCents({ ...project, perTask: 250 }, 0)).toBeNull();
    expect(perTaskCents({ ...project, perTask: 250 }, "")).toBeNull();
  });

  it("lets a project carry both an hourly rate and a per-item price", () => {
    // Some work pays by the hour AND throws in per-item bonuses; neither field
    // says anything about the other.
    const both = { ...project, currentRate: 20.5, perTask: 500 };
    expect(perTask(both)).toBe(500);
    expect(both.currentRate).toBe(20.5);
  });
});
