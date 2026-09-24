import { describe, it, expect } from "vitest";
import {
  COLLECTIONS, mergeList, mergeState, overlaps, stampChanges, stampOf,
} from "../src/domain/merge.js";
import { KIND, addManualSession, startSession, stopSession } from "../src/domain/sessions.js";
import { addProject, patchProject } from "../src/domain/projects.js";

const T = new Date(2026, 8, 25, 12).getTime();
const HOUR = 3_600_000;
const rec = (id, updatedAt, extra = {}) => ({ id, updatedAt, ...extra });
const seg = (from, to) => ({ startedAt: from, endedAt: to });
const session = (id, from, to, extra = {}) => ({
  id, projectId: "p1", kind: KIND.BILLED, rate: 20, currency: "USD", deletedAt: null,
  segments: [seg(from, to)], closedAt: to, ...extra,
});

describe("which version of a record wins", () => {
  it("takes the one edited later", () => {
    const out = mergeList([rec("a", 100, { v: "mine" })], [rec("a", 200, { v: "theirs" })]);
    expect(out).toHaveLength(1);
    expect(out[0].v).toBe("theirs");
  });

  it("treats an unstamped record as older than any stamped one", () => {
    // Everything written before sync existed has no stamp. It must lose to a
    // record somebody has since touched, not win by being silent.
    expect(stampOf({ id: "a" })).toBe(0);
    expect(mergeList([{ id: "a", v: "old" }], [rec("a", 1, { v: "touched" })])[0].v)
      .toBe("touched");
  });

  it("breaks a tie the same way every time", () => {
    // Otherwise the merge depends on which copy arrived first, and a merge that
    // is not deterministic cannot be reasoned about.
    const mine = [rec("a", 100, { v: "mine" })];
    const theirs = [rec("a", 100, { v: "theirs" })];
    expect(mergeList(mine, theirs)[0].v).toBe("mine");
    expect(mergeList(mine, theirs)[0].v).toBe("mine");
  });

  it("keeps what only one side has, from either side", () => {
    const out = mergeList([rec("a", 1)], [rec("b", 1)]);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("holds its order, so a sync does not reshuffle the page", () => {
    const mine = [rec("a", 1), rec("b", 1), rec("c", 1)];
    const theirs = [rec("c", 9), rec("z", 1), rec("a", 9)];
    expect(mergeList(mine, theirs).map((r) => r.id)).toEqual(["a", "b", "c", "z"]);
  });

  it("is idempotent, so merging twice changes nothing more", () => {
    const mine = [rec("a", 1), rec("b", 5)];
    const theirs = [rec("b", 9), rec("c", 2)];
    const once = mergeList(mine, theirs);
    expect(mergeList(once, theirs)).toEqual(once);
  });
});

describe("a delete surviving a merge", () => {
  it("does not resurrect what the other device never saw deleted", () => {
    // The classic sync bug, and this model cannot have it: deletion is a FIELD,
    // so it merges like any other edit.
    const deleted = [rec("a", 200, { deletedAt: 200 })];
    const stale = [rec("a", 100, { deletedAt: null })];
    expect(mergeList(deleted, stale)[0].deletedAt).toBe(200);
    expect(mergeList(stale, deleted)[0].deletedAt).toBe(200);
  });

  it("lets an undelete win when it is the later act", () => {
    const back = mergeList(
      [rec("a", 100, { deletedAt: 100 })],
      [rec("a", 300, { deletedAt: null })],
    );
    expect(back[0].deletedAt).toBeNull();
  });
});

describe("merging whole ledgers", () => {
  const ledger = (over = {}) => ({
    projects: [], sessions: [], objectives: [], earnings: [], ...over,
  });

  it("reconciles every collection that holds records", () => {
    expect(COLLECTIONS).toEqual(["projects", "sessions", "objectives", "earnings"]);
    const mine = ledger({ projects: [rec("p1", 1, { name: "old" })], sessions: [rec("s1", 1)] });
    const theirs = ledger({
      projects: [rec("p1", 9, { name: "new" })],
      earnings: [rec("e1", 1)],
    });
    const out = mergeState(mine, theirs);
    expect(out.projects[0].name).toBe("new");
    expect(out.sessions.map((r) => r.id)).toEqual(["s1"]);
    expect(out.earnings.map((r) => r.id)).toEqual(["e1"]);
  });

  it("keeps the later backup stamp, so it does not nag for a file that exists", () => {
    expect(mergeState(ledger({ lastBackupAt: 100 }), ledger({ lastBackupAt: 500 })).lastBackupAt)
      .toBe(500);
    expect(mergeState(ledger({ lastBackupAt: 500 }), ledger({ lastBackupAt: 100 })).lastBackupAt)
      .toBe(500);
    expect(mergeState(ledger(), ledger()).lastBackupAt).toBeUndefined();
  });

  it("survives a missing side, and a store predating a whole collection", () => {
    expect(mergeState(ledger({ sessions: [rec("s1", 1)] }), null).sessions).toHaveLength(1);
    expect(mergeState(null, ledger({ sessions: [rec("s1", 1)] })).sessions).toHaveLength(1);
    const ancient = { projects: [], sessions: [rec("s1", 1)] };
    expect(mergeState(ancient, ledger({ earnings: [rec("e1", 1)] })).earnings).toHaveLength(1);
  });

  it("does not lose a session each device recorded separately", () => {
    // The whole point. Taking the newer document would delete one of these.
    const mine = ledger({ sessions: [session("desk", T, T + HOUR, { updatedAt: T })] });
    const theirs = ledger({
      sessions: [session("phone", T + 2 * HOUR, T + 3 * HOUR, { updatedAt: T + 1 })],
    });
    expect(mergeState(mine, theirs).sessions.map((s) => s.id)).toEqual(["desk", "phone"]);
  });
});

describe("stamping only what changed", () => {
  const empty = { projects: [], sessions: [], objectives: [], earnings: [] };

  it("stamps a new record and leaves its neighbours untouched", () => {
    const before = addProject(empty, { name: "A", rate: 10, currency: "USD" }, 1, "p1");
    const after = addProject(before, { name: "B", rate: 10, currency: "USD" }, 2, "p2");
    const out = stampChanges(before, after, T);
    expect(out.projects.find((p) => p.id === "p2").updatedAt).toBe(T);
    expect(out.projects.find((p) => p.id === "p1")).not.toHaveProperty("updatedAt");
  });

  it("stamps an edited record only", () => {
    const base = addProject(
      addProject(empty, { name: "A", rate: 10, currency: "USD" }, 1, "p1"),
      { name: "B", rate: 10, currency: "USD" }, 1, "p2",
    );
    const after = patchProject(base, "p1", { name: "A2" });
    const out = stampChanges(base, after, T);
    expect(out.projects.find((p) => p.id === "p1").updatedAt).toBe(T);
    expect(out.projects.find((p) => p.id === "p2")).not.toHaveProperty("updatedAt");
  });

  it("rests on the reducers being pure, and proves they are", () => {
    // If a reducer ever rebuilt untouched records, everything would stamp on
    // every change and every merge would become a coin toss.
    const base = {
      ...empty,
      projects: [{ id: "p1", name: "A", currentRate: 10, currency: "USD" }],
    };
    const started = startSession(base, base.projects[0], { now: T, id: "s1" });
    expect(started.projects[0]).toBe(base.projects[0]);
    const out = stampChanges(base, started, T);
    expect(out.projects[0]).not.toHaveProperty("updatedAt");
    expect(out.sessions[0].updatedAt).toBe(T);
  });

  it("stamps a stop, because closing a session changes it", () => {
    const base = {
      ...empty,
      projects: [{ id: "p1", name: "A", currentRate: 10, currency: "USD" }],
    };
    const running = startSession(base, base.projects[0], { now: T, id: "s1" });
    const stopped = stopSession(running, "s1", T + HOUR);
    expect(stampChanges(running, stopped, T + HOUR).sessions[0].updatedAt).toBe(T + HOUR);
  });

  it("leaves the state alone when nothing changed at all", () => {
    expect(stampChanges(empty, empty, T)).toEqual(empty);
  });
});

describe("time counted twice", () => {
  it("finds two sessions over the same hour", () => {
    // The meter was running on two devices. Nothing else about the ledger looks
    // wrong: the hours just read high, and the money with them.
    const found = overlaps([
      session("a", T, T + 2 * HOUR),
      session("b", T + HOUR, T + 3 * HOUR),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ a: "a", b: "b", ms: HOUR });
  });

  it("says nothing about sessions that merely touch", () => {
    // Back to back is not an overlap; these windows are half-open.
    expect(overlaps([session("a", T, T + HOUR), session("b", T + HOUR, T + 2 * HOUR)]))
      .toEqual([]);
  });

  it("ignores deleted records and idle time", () => {
    // Sleeping while another machine logged a nap is not a double-counted hour.
    expect(overlaps([
      session("a", T, T + 2 * HOUR),
      session("b", T + HOUR, T + 3 * HOUR, { deletedAt: T }),
    ])).toEqual([]);
    expect(overlaps([
      session("a", T, T + 2 * HOUR, { kind: KIND.IDLE }),
      session("b", T + HOUR, T + 3 * HOUR, { kind: KIND.IDLE }),
    ])).toEqual([]);
  });

  it("measures a still-running session up to now", () => {
    const open = session("a", T, null, { segments: [seg(T, null)], closedAt: null });
    const found = overlaps([open, session("b", T + HOUR, T + 2 * HOUR)], T + 2 * HOUR);
    expect(found).toHaveLength(1);
    expect(found[0].ms).toBe(HOUR);
  });

  it("finds nothing in a ledger the app itself built", () => {
    // Starting a session closes every other, so the timer cannot produce one.
    let state = {
      projects: [{ id: "p1", name: "A", currentRate: 10, currency: "USD" }], sessions: [],
    };
    state = startSession(state, state.projects[0], { now: T, id: "s1" });
    state = stopSession(state, "s1", T + HOUR);
    state = addManualSession(
      state, state.projects[0], { startedAt: T + 2 * HOUR, endedAt: T + 3 * HOUR }, T, "s2",
    );
    expect(overlaps(state.sessions)).toEqual([]);
  });
});
