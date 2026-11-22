import { describe, it, expect } from "vitest";
import {
  COLLECTIONS, collectionKeys, mergeList, mergeState, overlaps, stampChanges, stampOf,
} from "../src/domain/merge.js";
import { KIND, addManualSession, startSession, stopSession } from "../src/domain/sessions.js";
import {
  addProject, liveProjects, patchProject, removeProject, restoreProject,
} from "../src/domain/projects.js";

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

  it("breaks a tie the same way on every device", () => {
    // It used to be "mine wins", which cannot converge: two devices that stamped
    // one record in the same millisecond each kept their own copy for ever. The
    // rule now is arbitrary but shared, so both sides land on the same record.
    const a = [rec("a", 100, { v: "alpha" })];
    const b = [rec("a", 100, { v: "beta" })];
    expect(mergeList(a, b)[0].v).toBe("beta");
    expect(mergeList(b, a)[0].v).toBe("beta");
  });

  it("keeps an identical copy untouched, which is the usual tie after a sync", () => {
    const mine = rec("a", 100, { v: "same" });
    expect(mergeList([mine], [{ ...mine }])[0]).toBe(mine);
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
    projects: [], sessions: [], objectives: [], earnings: [], companies: [], ...over,
  });

  it("reconciles every collection that holds records", () => {
    // Pinned on purpose: a new collection has to be added here deliberately,
    // by somebody who has just checked that the merge handles it.
    expect(COLLECTIONS)
      .toEqual(["projects", "sessions", "objectives", "earnings", "companies", "todos", "payouts", "prefs"]);
    const mine = ledger({ projects: [rec("p1", 1, { name: "old" })], sessions: [rec("s1", 1)] });
    const theirs = ledger({
      projects: [rec("p1", 9, { name: "new" })],
      earnings: [rec("e1", 1)],
      companies: [rec("co:acme", 1)],
      todos: [rec("td1", 1)],
      payouts: [rec("po1", 1)],
    });
    const out = mergeState(mine, theirs);
    expect(out.projects[0].name).toBe("new");
    expect(out.sessions.map((r) => r.id)).toEqual(["s1"]);
    expect(out.earnings.map((r) => r.id)).toEqual(["e1"]);
    expect(out.companies.map((r) => r.id)).toEqual(["co:acme"]);
    expect(out.todos.map((r) => r.id)).toEqual(["td1"]);
    expect(out.payouts.map((r) => r.id)).toEqual(["po1"]);
  });

  it("settles two devices answering one payment on the later answer", () => {
    const mine = ledger({ payouts: [rec("po1", 1, { outcome: "paid" })] });
    const theirs = ledger({ payouts: [rec("po1", 9, { outcome: "moved", movedTo: "2026-12-02" })] });
    expect(mergeState(mine, theirs).payouts[0]).toMatchObject({ outcome: "moved", movedTo: "2026-12-02" });
    // An undo is an edit like any other: the tombstone, being later, wins.
    const undone = ledger({ payouts: [rec("po1", 12, { outcome: "paid", deletedAt: 12 })] });
    expect(mergeState(theirs, undone).payouts[0].deletedAt).toBe(12);
  });

  it("settles two devices editing one client's payday on the later edit", () => {
    // The company id is the folded name, so both devices write the same row
    // rather than creating two schedules that quietly disagree.
    const weekly = { kind: "weekly", cutoff: 1, payday: 3, after: 0 };
    const friday = { kind: "weekly", cutoff: 1, payday: 5, after: 0 };
    const out = mergeState(
      ledger({ companies: [rec("co:outlier", 100, { name: "Outlier", payPeriod: weekly })] }),
      ledger({ companies: [rec("co:outlier", 300, { name: "Outlier", payPeriod: friday })] }),
    );
    expect(out.companies).toHaveLength(1);
    expect(out.companies[0].payPeriod).toEqual(friday);
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

describe("a project deleted on one device stays deleted on both", () => {
  const T = 1_700_000_000_000;
  const base = () => ({
    projects: [
      { id: "p1", name: "A", currentRate: 20, currency: "USD", tasks: [] },
      { id: "p2", name: "B", currentRate: 30, currency: "USD", tasks: [] },
    ],
    sessions: [], objectives: [], earnings: [],
  });

  it("does not hand it back on the next sync", () => {
    // Exactly the reported bug. The phone still has the project, because it
    // has not synced since. Merging must not read that as news.
    const phone = base();
    const desktop = stampChanges(base(), removeProject(base(), "p1", T), T + 1);
    const merged = mergeState(desktop, phone);
    expect(merged.projects.find((p) => p.id === "p1").deletedAt).toBe(T);
    expect(liveProjects(merged.projects).map((p) => p.id)).toEqual(["p2"]);
  });

  it("holds in both merge directions", () => {
    // The device that never saw the delete merges too, and must accept it.
    const phone = base();
    const desktop = stampChanges(base(), removeProject(base(), "p1", T), T + 1);
    expect(liveProjects(mergeState(phone, desktop).projects).map((p) => p.id)).toEqual(["p2"]);
  });

  it("lets an undo on the other device win, because it is later", () => {
    const deleted = stampChanges(base(), removeProject(base(), "p1", T), T + 1);
    const undone = stampChanges(deleted, restoreProject(deleted, "p1"), T + 2);
    expect(liveProjects(mergeState(deleted, undone).projects).map((p) => p.id))
      .toEqual(["p1", "p2"]);
  });

  it("carries the tombstones on its sessions and money too", () => {
    const withWork = {
      ...base(),
      sessions: [{ id: "s1", projectId: "p1", deletedAt: null, segments: [] }],
      earnings: [{ id: "e1", projectId: "p1", cents: 100, deletedAt: null }],
    };
    const desktop = stampChanges(withWork, removeProject(withWork, "p1", T), T + 1);
    const merged = mergeState(desktop, withWork);
    expect(merged.sessions[0].deletedAt).toBe(T);
    expect(merged.earnings[0].deletedAt).toBe(T);
  });
});

describe("a meter stopped from the other device", () => {
  /**
   * The rule that makes stopping from anywhere work.
   *
   * A heartbeat is written WITHOUT a stamp (see App's heartbeat effect), so a
   * laptop ticking once a minute does not out-date the stop a phone made. If
   * it did, the merge would take the laptop's copy and the session would
   * quietly reopen with the hours it had kept counting.
   */
  const stillRunningHere = {
    sessions: [session("s1", T, null, {
      updatedAt: T, closedAt: null,
      segments: [{ startedAt: T, endedAt: null, lastTick: T + 10 * HOUR }],
    })],
  };
  const stoppedThere = {
    sessions: [session("s1", T, T + HOUR, { updatedAt: T + HOUR })],
  };

  it("wins over the copy that is still counting", () => {
    const out = mergeState(stillRunningHere, stoppedThere);
    expect(out.sessions[0].closedAt).toBe(T + HOUR);
    expect(out.sessions[0].segments[0].endedAt).toBe(T + HOUR);
  });

  it("wins from either side of the merge", () => {
    // Whichever device syncs first must reach the same answer, or the session
    // reopens on the next round trip.
    expect(mergeState(stoppedThere, stillRunningHere).sessions[0].closedAt).toBe(T + HOUR);
  });

  it("would lose if the heartbeat counted as an edit", () => {
    // Pinned deliberately: this is what the bug looked like, so a change that
    // reinstates stamping fails here rather than in someone's ledger.
    const ticking = {
      sessions: [{ ...stillRunningHere.sessions[0], updatedAt: T + 10 * HOUR }],
    };
    expect(mergeState(ticking, stoppedThere).sessions[0].closedAt).toBeNull();
  });
});

describe("records the build has not heard of", () => {
  const ledger = (over = {}) => ({ projects: [], sessions: [], ...over });

  it("merges a collection a newer build added, in both directions", () => {
    // The old merge copied `mine` and visited only the known lists, so an older
    // device dropped a newer one's collection on its next sync.
    const newer = ledger({ widgets: [rec("w1", 5, { v: "new" }), rec("w2", 1)] });
    const older = ledger();
    expect(mergeState(older, newer).widgets.map((w) => w.id)).toEqual(["w1", "w2"]);
    expect(mergeState(newer, older).widgets.map((w) => w.id)).toEqual(["w1", "w2"]);
    const both = mergeState(
      ledger({ widgets: [rec("w1", 1, { v: "old" })] }),
      ledger({ widgets: [rec("w1", 9, { v: "new" })] }),
    );
    expect(both.widgets).toEqual([rec("w1", 9, { v: "new" })]);
  });

  it("survives going through an older device and back", () => {
    const newer = ledger({ widgets: [rec("w1", 5)] });
    const viaOlder = mergeState(ledger({ sessions: [rec("s1", 1)] }), newer);
    expect(mergeState(newer, viaOlder).widgets).toEqual([rec("w1", 5)]);
  });

  it("stamps edits to an unknown collection", () => {
    const before = ledger({ widgets: [rec("w1", 1, { v: "a" })] });
    const after = { ...before, widgets: [{ ...before.widgets[0], v: "b" }, { id: "w2" }] };
    const out = stampChanges(before, after, T);
    expect(out.widgets.map((w) => w.updatedAt)).toEqual([T, T]);
    expect(stampChanges(before, before, T).widgets[0]).toBe(before.widgets[0]);
  });

  it("does not mistake other arrays or objects for collections", () => {
    const state = ledger({ tags: ["a", "b"], notes: [{ text: "no id" }], meta: { id: "x" } });
    const out = stampChanges(state, state, T);
    expect(out.tags).toBe(state.tags);
    expect(out.notes).toBe(state.notes);
    expect(out.meta).toBe(state.meta);
    expect(collectionKeys(state)).toEqual(["projects", "sessions"]);
    // Mine kept, as with any scalar; nothing throws or is merged by guesswork.
    expect(mergeState(state, ledger({ tags: ["z"] })).tags).toEqual(["a", "b"]);
  });

  it("leaves a key that is a list on one side and not on the other to the scalar rule", () => {
    const out = mergeState(ledger({ x: [rec("a", 1)] }), ledger({ x: "text" }));
    expect(out.x).toEqual([rec("a", 1)]);
  });

  it("still merges a known collection that holds a record with no id", () => {
    // Behaviour before this change, kept: the known lists are trusted.
    const out = mergeState({ sessions: [{ v: 1 }], projects: [] }, { sessions: [], projects: [] });
    expect(out.sessions).toHaveLength(1);
  });
});

describe("merging scalars", () => {
  const ledger = (over = {}) => ({ projects: [], sessions: [], ...over });

  it("keeps mine where both have a value, and adopts theirs where mine has none", () => {
    const out = mergeState(ledger({ mood: "mine" }), ledger({ mood: "theirs", schema: 3 }));
    expect(out.mood).toBe("mine");
    expect(out.schema).toBe(3);
  });

  it("does not treat a deliberate null as missing", () => {
    expect(mergeState(ledger({ mood: null }), ledger({ mood: "theirs" })).mood).toBeNull();
  });

  it("ignores a non-numeric backup stamp rather than taking it", () => {
    expect(mergeState(ledger({ lastBackupAt: "soon" }), ledger({ lastBackupAt: 5 })).lastBackupAt).toBe(5);
  });
});

describe("two devices converging", () => {
  const byId = (list) => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));

  it("gives the same records whichever way round they are merged, ties included", () => {
    const a = {
      sessions: [rec("s1", 10, { v: "a" }), rec("s2", 20, { v: "a2" }), rec("only-a", 1)],
      widgets: [rec("w", 5, { v: "a" })],
    };
    const b = {
      sessions: [rec("s1", 10, { v: "b" }), rec("s2", 30, { v: "b2" }), rec("only-b", 1)],
      widgets: [rec("w", 5, { v: "b" })],
    };
    const ab = mergeState(a, b);
    const ba = mergeState(b, a);
    expect(byId(ab.sessions)).toEqual(byId(ba.sessions));
    expect(byId(ab.widgets)).toEqual(byId(ba.widgets));
    // And merging the result again changes nothing.
    expect(mergeState(ab, ba).sessions).toEqual(ab.sessions);
  });
});

describe("the size of a real ledger", () => {
  it("merges ten thousand records against ten thousand in well under a quadratic scan", () => {
    const make = (tag, stamp) =>
      Array.from({ length: 10_000 }, (_, i) => rec(`s${i}`, stamp + (i % 3), { tag }));
    const mine = { projects: [], sessions: make("a", 100) };
    const theirs = { projects: [], sessions: make("b", 100) };
    const t0 = performance.now();
    const out = mergeState(mine, theirs);
    const ms = performance.now() - t0;
    expect(out.sessions).toHaveLength(10_000);
    // The old scan did 10^8 comparisons (seconds). Generous so a slow CI runner
    // does not flake: the indexed merge is tens of milliseconds.
    expect(ms).toBeLessThan(2_000);
  });
});
