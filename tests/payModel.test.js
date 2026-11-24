import { describe, expect, it } from "vitest";
import { MODEL, modelOf, setPayModel } from "../src/domain/payModel.js";
import { SCOPE, pricer } from "../src/domain/terms.js";
import { isPieceOnly } from "../src/domain/earnings.js";
import { sessionCents, startSession } from "../src/domain/sessions.js";
import { answerTasks, submitTasks } from "../src/domain/settle.js";

const H = 3_600_000;
const T = 1_790_000_000_000;
let n = 0;
const id = () => `new${++n}`;

const tasks = [
  { id: "open", label: "open" },
  { id: "sub", label: "sub", state: "submitted", stateAt: T - 5 * H, submittedAt: T - 5 * H },
  { id: "acc", label: "acc", state: "accepted", stateAt: T - 4 * H, submittedAt: T - 6 * H },
  { id: "rej", label: "rej", state: "cancelled", stateAt: T - 4 * H, submittedAt: T - 6 * H },
  { id: "own", label: "own", rate: 99 },
];
const STATUS = { sub: "pending", rej: "cancelled" };
const sitting = (taskId, rate, extra = {}) => ({
  id: `s-${taskId}`, projectId: "p", kind: "billed", taskId: taskId === "none" ? null : taskId, rate, currency: "USD",
  createdAt: T - 20 * H, closedAt: T - 19 * H, deletedAt: null,
  segments: [{ startedAt: T - 20 * H, endedAt: T - 19 * H }],
  ...(STATUS[taskId] ? { status: STATUS[taskId] } : {}), ...extra,
});
const running = (rate) => sitting("open", rate, {
  id: "s-running", closedAt: null, segments: [{ startedAt: T - H, endedAt: null, lastTick: T }],
});
const ledger = (project, rate, earnings = []) => ({
  projects: [{ id: "p", name: "P", currency: "USD", createdAt: T - 100 * H, tasks, ...project }, { id: "q", name: "Q", currentRate: 7, currency: "USD", tasks: [] }],
  sessions: [
    ...["open", "sub", "acc", "rej", "own", "none"].map((t) => sitting(t, rate)), running(rate),
    { ...sitting("none", 7), id: "s-q", projectId: "q" },
  ],
  earnings,
});
const hourly = (extra = {}, earnings = []) => ledger({ currentRate: 20, ...extra }, 20, earnings);
const perTask = (extra = {}, earnings = []) =>
  ledger({ currentRate: 0, perTask: 500, paysOnAcceptance: true, ...extra }, 0, earnings);
const line = (taskId, extra = {}) => ({
  id: `e-${taskId}`, projectId: "p", taskIds: [taskId], kind: "piece", cents: 50_000, currency: "USD",
  at: T - 6 * H, note: `Accepted · ${taskId}`, units: 1, createdAt: T - 6 * H, deletedAt: null, ...extra,
});

const p = (s) => s.projects[0];
const rates = (s) => Object.fromEntries(s.sessions.map((x) => [x.id.slice(2), x.rate]));
const lines = (s) => (s.earnings ?? []).filter((e) => !e.deletedAt)
  .map((e) => [e.taskIds?.[0] ?? null, e.cents, e.status ?? "paid"]);
const to = (s, terms, scope = SCOPE.FORWARD) => setPayModel(s, "p", terms, scope, T, id);
const PIECE = { model: MODEL.PER_TASK, perTask: 500 };
const HOURLY = { model: MODEL.HOURLY, rate: 30 };

describe("from by the hour to per task", () => {
  it("makes it the project one created that way is", () => {
    const s = to(hourly({ bonusPerHour: 5 }), PIECE);
    expect(p(s)).toMatchObject({ currentRate: 0, perTask: 500, bonusPerHour: null, paysOnAcceptance: true });
    expect(isPieceOnly(p(s))).toBe(true);
    expect(s.projects[1]).toMatchObject({ currentRate: 7 });
  });

  it("from now on, moves open tasks and the sitting running on one, and nothing past", () => {
    const s = to(hourly(), PIECE);
    expect(rates(s)).toEqual({ open: 0, running: 0, sub: 20, acc: 20, rej: 20, own: 20, none: 20, q: 7 });
    expect(lines(s)).toEqual([]);
    const before = hourly();
    const worth = (st, sid) => sessionCents(st.sessions.find((x) => x.id === sid), -Infinity, Infinity, T, pricer(st.projects, st.sessions));
    for (const sid of ["s-sub", "s-acc", "s-rej", "s-own", "s-none"]) expect(worth(s, sid)).toBe(worth(before, sid));
    expect(s.sessions.map((x) => x.status)).toEqual(before.sessions.map((x) => x.status));
  });

  it("past included, stops every hour paying and pays each handed-in task its price, as it stands", () => {
    const s = to(hourly(), PIECE, SCOPE.ALL);
    expect(rates(s)).toEqual({ open: 0, running: 0, sub: 0, acc: 0, rej: 0, own: 20, none: 0, q: 7 });
    expect(lines(s)).toEqual([["sub", 50_000, "pending"], ["acc", 50_000, "paid"], ["rej", 50_000, "cancelled"]]);
  });

  it("past included, prices an hourly bonus already written afresh, and leaves a typed amount alone", () => {
    const s = to(hourly({ bonusPerHour: 5 }, [
      line("acc", { kind: "bonus", cents: 500, note: "Accepted · acc · 1h 00m at 5/hr", units: undefined, status: "paid" }),
      line("sub", { cents: 1234, note: "what they told me", status: "pending" }),
    ]), PIECE, SCOPE.ALL);
    expect(lines(s)).toEqual([["acc", 50_000, "paid"], ["sub", 1234, "pending"], ["rej", 50_000, "cancelled"]]);
  });

  it("then pays an open task its price once, when it is accepted", () => {
    let s = to(hourly(), PIECE);
    s = submitTasks(s, p(s), ["open"], T + H, id, T + H);
    s = answerTasks(s, p(s), ["open"], "accepted", T + 2 * H);
    expect(lines(s)).toEqual([["open", 50_000, "paid"]]);
    expect(startSession(s, p(s), { now: T + 3 * H, id: "x" }).sessions.at(-1)).toMatchObject({ rate: 0, status: "pending" });
  });
});

describe("from per task to by the hour", () => {
  it("leaves no price behind as a bonus, and when it pays as it was", () => {
    const s = to(perTask(), HOURLY);
    expect(p(s)).toMatchObject({ currentRate: 30, perTask: null, bonusPerHour: null, paysOnAcceptance: true });
    expect(modelOf(p(s))).toBe(MODEL.HOURLY);
  });

  it("can keep a flat amount, or an hourly one, on top, never both", () => {
    expect(p(to(perTask(), { ...HOURLY, perTask: 70 }))).toMatchObject({ currentRate: 30, perTask: 70, bonusPerHour: null });
    expect(p(to(perTask(), { ...HOURLY, perTask: 70, bonusPerHour: 4 }))).toMatchObject({ perTask: null, bonusPerHour: 4 });
  });

  it("from now on, keeps what handed-in tasks were paid", () => {
    const earned = [line("acc", { status: "paid" }), line("sub", { status: "pending" })];
    const s = to(perTask({}, earned), HOURLY);
    expect(rates(s)).toEqual({ open: 30, running: 30, sub: 0, acc: 0, rej: 0, own: 0, none: 0, q: 7 });
    expect(s.earnings).toBe(earned);
  });

  it("past included, pays the hours and takes the per-task lines off, but not a typed one", () => {
    const s = to(perTask({}, [line("acc"), line("sub", { note: "typed", status: "pending" })]), HOURLY, SCOPE.ALL);
    expect(rates(s)).toEqual({ open: 30, running: 30, sub: 30, acc: 30, rej: 30, own: 0, none: 30, q: 7 });
    expect(lines(s)).toEqual([["sub", 50_000, "pending"]]);
    expect(s.earnings.find((e) => e.id === "e-acc").deletedAt).toBe(T); // a tombstone, so it syncs
    expect(s.sessions.map((x) => x.status)).toEqual(perTask().sessions.map((x) => x.status));
  });

  it("there and back from now on leaves every figure of the past where it was", () => {
    const start = hourly();
    const back = to(to(start, PIECE), { model: MODEL.HOURLY, rate: 20 });
    expect(rates(back)).toEqual(rates(start));
    expect(lines(back)).toEqual([]);
  });
});

describe("what is refused", () => {
  it.each([
    ["no price", hourly(), { model: MODEL.PER_TASK, perTask: null }],
    ["a zero price", hourly(), { model: MODEL.PER_TASK, perTask: 0 }],
    ["a price that is not a number", hourly(), { model: MODEL.PER_TASK, perTask: NaN }],
    ["a zero rate", perTask(), { model: MODEL.HOURLY, rate: 0 }],
    ["a negative rate", perTask(), { model: MODEL.HOURLY, rate: -3 }],
    ["the model it already has", hourly(), HOURLY],
    ["a project off the clock", hourly({ offClock: true }), PIECE],
  ])("%s, whole", (_, state, terms) => {
    expect(to(state, terms, SCOPE.ALL)).toBe(state);
  });

  it("calls an hourly project with a flat bonus hourly", () => {
    expect(modelOf({ currentRate: 20, perTask: 70 })).toBe(MODEL.HOURLY);
  });
});
