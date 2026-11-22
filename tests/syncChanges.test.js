import { describe, it, expect } from "vitest";
import {
  BATCH_VERSION, UnsupportedBatch, acknowledge, applyBatch, pending, pruneSent, reconcile,
  toBatch, toBatches,
} from "../src/sync/changes.js";
import { mergeState, stampChanges } from "../src/domain/merge.js";
import {
  deleteSession, heartbeat, startSession, stopSession,
} from "../src/domain/sessions.js";

const T = new Date(2026, 8, 25, 12).getTime();
const HOUR = 3_600_000;
const rec = (id, updatedAt, extra = {}) => ({ id, updatedAt, ...extra });
const ledger = (over = {}) => ({ projects: [], sessions: [], ...over });
const project = { id: "p1", name: "A", currentRate: 10, currency: "USD" };
const ids = (changes) => changes.map(({ k, r }) => `${k}/${r.id}`).sort();

/** A full round trip as a device sees it: what it would push, as the batch the
 *  relay would hold, then acknowledged. */
const push = (state, sent) => {
  const work = pending(state, sent);
  const batches = toBatches(work);
  return { batches, sent: batches.reduce(acknowledge, sent) };
};

describe("what is pending", () => {
  it("is every record when nothing has been sent, and nothing once it all has", () => {
    const state = ledger({ projects: [rec("p1", 1)], sessions: [rec("s1", 2), rec("s2", 3)] });
    expect(ids(pending(state, {}).changes)).toEqual(["projects/p1", "sessions/s1", "sessions/s2"]);
    const { sent } = push(state, {});
    expect(pending(state, sent).changes).toEqual([]);
  });

  it("is only what was edited since", () => {
    const state = ledger({ sessions: [rec("s1", 2), rec("s2", 3)] });
    const { sent } = push(state, {});
    const edited = { ...state, sessions: [state.sessions[0], rec("s2", 9, { v: "x" })] };
    expect(ids(pending(edited, sent).changes)).toEqual(["sessions/s2"]);
  });

  it("is never created by the heartbeat, which writes no stamp", () => {
    // The rule that lets a meter be stopped from another device: a tick must not
    // look like news, or it would be pushed and could out-date a stop.
    const base = { projects: [project], sessions: [] };
    const running = stampChanges(base, startSession(base, project, { now: T, id: "s1", device: "d1" }), T);
    const { sent } = push(running, {});
    const ticked = heartbeat(running, T + 5 * 60_000, "d1");
    expect(ticked.sessions[0].segments[0].lastTick).toBe(T + 5 * 60_000);
    expect(pending(ticked, sent).changes).toEqual([]);
    // A stop is an edit, is stamped, and goes.
    const stopped = stampChanges(ticked, stopSession(ticked, "s1", T + HOUR), T + HOUR);
    expect(ids(pending(stopped, sent).changes)).toEqual(["sessions/s1"]);
  });

  it("carries the backup stamp until it has been sent", () => {
    const state = ledger({ lastBackupAt: 500 });
    expect(pending(state, {}).meta).toEqual({ lastBackupAt: 500 });
    const { sent } = push(state, {});
    expect(pending(state, sent).meta).toEqual({});
    expect(pending({ ...state, lastBackupAt: 900 }, sent).meta).toEqual({ lastBackupAt: 900 });
  });

  it("treats a damaged sent map as nothing sent", () => {
    const state = ledger({ sessions: [rec("s1", 2)] });
    expect(pending(state, { "sessions/s1": "soon" }).changes).toHaveLength(1);
    expect(pending(state, null).changes).toHaveLength(1);
  });
});

describe("batches", () => {
  it("are versioned and say nothing when there is nothing to say", () => {
    expect(toBatch([{ k: "sessions", r: rec("s1", 1) }]).v).toBe(BATCH_VERSION);
    expect(toBatches({ changes: [], meta: {} })).toEqual([]);
  });

  it("are split by size, with the scalars in the first only", () => {
    const changes = Array.from({ length: 50 }, (_, i) => ({ k: "sessions", r: rec(`s${i}`, 1, { pad: "x".repeat(100) }) }));
    const batches = toBatches({ changes, meta: { lastBackupAt: 5 } }, 1_000);
    expect(batches.length).toBeGreaterThan(3);
    expect(batches.flatMap((b) => b.changes)).toHaveLength(50);
    expect(batches[0].meta).toEqual({ lastBackupAt: 5 });
    expect(batches[1].meta).toEqual({});
  });

  it("can carry just the scalar", () => {
    const [batch] = toBatches({ changes: [], meta: { lastBackupAt: 5 } });
    expect(batch.changes).toEqual([]);
    expect(batch.meta.lastBackupAt).toBe(5);
  });

  it("acknowledge the stamp each record had when SENT, not as it is now", () => {
    const state = ledger({ sessions: [rec("s1", 2)] });
    const [batch] = toBatches(pending(state, {}));
    const sent = acknowledge({}, batch);
    // An edit made while the request was in flight is later than what was sent.
    expect(pending(ledger({ sessions: [rec("s1", 7)] }), sent).changes).toHaveLength(1);
  });
});

describe("taking a batch in", () => {
  it("applies the same batch twice as a no-op", () => {
    const batch = toBatch([{ k: "sessions", r: rec("s1", 5, { v: "a" }) }], { lastBackupAt: 9 });
    const once = applyBatch(ledger(), batch, {});
    expect(once.changed).toBe(true);
    const twice = applyBatch(once.state, batch, once.sent);
    expect(twice.changed).toBe(false);
    expect(twice.state).toBe(once.state);
    expect(twice.sent).toEqual(once.sent);
  });

  it("does not send a record straight back (echo suppression)", () => {
    const batch = toBatch([{ k: "sessions", r: rec("s1", 5) }], { lastBackupAt: 9 });
    const { state, sent } = applyBatch(ledger(), batch, {});
    expect(pending(state, sent)).toEqual({ changes: [], meta: {} });
  });

  it("keeps a local record that is newer, and still has it pending", () => {
    const mine = ledger({ sessions: [rec("s1", 9, { v: "mine" })] });
    const out = applyBatch(mine, toBatch([{ k: "sessions", r: rec("s1", 5, { v: "theirs" }) }]), {});
    expect(out.state.sessions[0].v).toBe("mine");
    expect(out.changed).toBe(false);
    expect(ids(pending(out.state, out.sent).changes)).toEqual(["sessions/s1"]);
  });

  it("keeps the local copy of an exact tie it wins, and still sends it", () => {
    // Same stamp, different content: the relay holds the loser, so marking the
    // winner as sent would leave the other device on the wrong one for good.
    const mine = ledger({ sessions: [rec("s1", 5, { v: "zeta" })] });
    const out = applyBatch(mine, toBatch([{ k: "sessions", r: rec("s1", 5, { v: "alpha" }) }]), {});
    expect(out.state.sessions[0].v).toBe("zeta");
    expect(ids(pending(out.state, out.sent).changes)).toEqual(["sessions/s1"]);
  });

  it("adopts the relay's copy of a tie it loses, and does not send it back", () => {
    const mine = ledger({ sessions: [rec("s1", 5, { v: "alpha" })] });
    const out = applyBatch(mine, toBatch([{ k: "sessions", r: rec("s1", 5, { v: "zeta" }) }]), {});
    expect(out.state.sessions[0].v).toBe("zeta");
    expect(pending(out.state, out.sent).changes).toEqual([]);
  });

  it("refuses a batch from a newer build, and says what to do", () => {
    const state = ledger();
    expect(() => applyBatch(state, { v: BATCH_VERSION + 1, changes: [], meta: {} }, {}))
      .toThrow(UnsupportedBatch);
    try {
      applyBatch(state, { v: BATCH_VERSION + 1, changes: [], meta: {} }, {});
    } catch (e) {
      expect(e.version).toBe(BATCH_VERSION + 1);
      expect(e.message).toMatch(/Update the app/);
    }
  });

  it("refuses a batch it cannot read, rather than half applying it", () => {
    const state = ledger();
    for (const bad of [
      null, {}, { v: 1 }, { v: 1, changes: [{ k: "sessions", r: { no: "id" } }] },
      { v: 1, changes: [{ k: "__proto__", r: rec("a", 1) }] },
      { v: 1, changes: [rec("a", 1), { k: 3, r: rec("a", 1) }] },
    ]) {
      expect(() => applyBatch(state, bad, {})).toThrow("not readable");
    }
    expect(Object.keys(state)).toEqual(["projects", "sessions"]);
  });
});

describe("a lost sent map", () => {
  it("re-pushes everything once, and the second time it finds nothing new", () => {
    // Device A has pushed. A's map is then lost (storage cleared, a new profile).
    let relay = ledger();
    const a = ledger({ sessions: [rec("s1", 2), rec("s2", 3)], projects: [rec("p1", 1)] });
    const first = push(a, {});
    for (const b of first.batches) relay = applyBatch(relay, b, {}).state;

    const again = push(a, {}); // map gone
    expect(again.batches.flatMap((b) => b.changes)).toHaveLength(3);
    let applied = relay;
    for (const b of again.batches) applied = applyBatch(applied, b, {}).state;
    // Idempotent: the relay's copy is unchanged by the repeat.
    expect(applied).toBe(relay);
    // And once acknowledged there is nothing left.
    expect(pending(a, again.sent).changes).toEqual([]);
  });
});

describe("clocks that disagree", () => {
  it("never strands a local edit because a remote record had a later clock", () => {
    // The reason `sent` is per record and not one watermark: a phone whose clock
    // runs a day fast sends a record stamped tomorrow. A watermark would rise to
    // it and every edit here, stamped with the true time, would sit below it.
    const FAST = T + 24 * HOUR;
    const state = ledger({ sessions: [rec("mine", T, { v: "x" })] });
    const { sent: s0 } = push(state, {});
    const got = applyBatch(state, toBatch([{ k: "sessions", r: rec("phone", FAST) }]), s0);
    const edited = {
      ...got.state,
      sessions: got.state.sessions.map((s) => (s.id === "mine" ? { ...s, v: "y", updatedAt: T + 60_000 } : s)),
    };
    expect(ids(pending(edited, got.sent).changes)).toEqual(["sessions/mine"]);
  });
});

describe("deletes and records of newer builds", () => {
  it("carries a tombstone to the other device, which keeps it deleted", () => {
    const base = { projects: [project], sessions: [] };
    const made = stampChanges(base, startSession(base, project, { now: T, id: "s1" }), T);
    const stopped = stampChanges(made, stopSession(made, "s1", T + HOUR), T + HOUR);
    const desk = push(stopped, {});
    // The phone has it too, alive, from earlier.
    let phone = stopped;
    const deleted = stampChanges(stopped, deleteSession(stopped, "s1", T + 2 * HOUR), T + 2 * HOUR);
    const out = push(deleted, desk.sent);
    expect(out.batches).toHaveLength(1);
    for (const b of out.batches) phone = applyBatch(phone, b, {}).state;
    expect(phone.sessions[0].deletedAt).toBe(T + 2 * HOUR);
    // A late, stale copy of the live record cannot bring it back.
    const stale = applyBatch(phone, toBatch([{ k: "sessions", r: stopped.sessions[0] }]), {});
    expect(stale.state.sessions[0].deletedAt).toBe(T + 2 * HOUR);
    expect(stale.changed).toBe(false);
  });

  it("round-trips a collection this build has never heard of", () => {
    const newer = { ...ledger(), widgets: [rec("w1", 5, { colour: "red" })], lastBackupAt: 7 };
    const { batches } = push(newer, {});
    let older = ledger({ sessions: [rec("s1", 1)] });
    for (const b of batches) older = applyBatch(older, b, {}).state;
    expect(older.widgets).toEqual([rec("w1", 5, { colour: "red" })]);
    expect(older.lastBackupAt).toBe(7);
    // The older device edits the unknown record and sends it back unharmed:
    // the fields it does not understand are kept because the record is whole.
    const edited = { ...older, widgets: [{ ...older.widgets[0], updatedAt: 9 }] };
    const back = pending(edited, reconcile(ledger(), newer).sent).changes
      .filter(({ k }) => k === "widgets");
    expect(back).toEqual([{ k: "widgets", r: rec("w1", 9, { colour: "red" }) }]);
  });
});

describe("joining a snapshot", () => {
  it("marks only records the snapshot holds in this very version", () => {
    const snapshot = ledger({
      sessions: [rec("same", 5, { v: "a" }), rec("old", 3, { v: "snap" }), rec("new", 5, { v: "snap" })],
      lastBackupAt: 10,
    });
    const phone = ledger({
      sessions: [
        rec("same", 5, { v: "a" }),
        rec("old", 9, { v: "phone-newer" }),   // the phone is newer: pending
        rec("new", 2, { v: "phone-older" }),   // the snapshot is newer: adopted, sent
        rec("only", 4),                        // the snapshot has never heard of it: pending
      ],
    });
    const { state, sent } = reconcile(phone, snapshot);
    expect(ids(pending(state, sent).changes)).toEqual(["sessions/old", "sessions/only"]);
    expect(state.sessions.find((s) => s.id === "new").v).toBe("snap");
    expect(pending(state, sent).meta).toEqual({});
  });

  it("throws away a sent map that described some other relay", () => {
    const phone = ledger({ sessions: [rec("s1", 5)] });
    const stale = { "sessions/s1": 5 };
    expect(pending(phone, stale).changes).toEqual([]);
    const { state, sent } = reconcile(phone, ledger());
    expect(sent).toEqual({});
    expect(ids(pending(state, sent).changes)).toEqual(["sessions/s1"]);
  });

  it("converges two devices that each had work the other lacked", () => {
    const desk = ledger({ sessions: [rec("a", 1), rec("shared", 4, { v: "desk" })] });
    const phone = ledger({ sessions: [rec("b", 2), rec("shared", 6, { v: "phone" })] });
    const d = push(desk, {});
    let relay = ledger();
    for (const b of d.batches) relay = applyBatch(relay, b, {}).state;
    const joined = reconcile(phone, relay);
    const p = push(joined.state, joined.sent);
    for (const b of p.batches) relay = applyBatch(relay, b, {}).state;
    const deskNow = reconcile(desk, relay).state;
    const byId = (s) => [...s.sessions].sort((x, y) => (x.id < y.id ? -1 : 1));
    expect(byId(deskNow)).toEqual(byId(relay));
    expect(byId(joined.state)).toEqual(byId(relay));
    expect(mergeState(deskNow, joined.state).sessions).toHaveLength(3);
  });
});

describe("tidying the map", () => {
  it("forgets records the ledger no longer holds, and keeps the rest", () => {
    const state = ledger({ sessions: [rec("s1", 1)], lastBackupAt: 4 });
    const sent = { "sessions/s1": 1, "sessions/gone": 1, "@lastBackupAt": 4 };
    expect(pruneSent(state, sent)).toEqual({ "sessions/s1": 1, "@lastBackupAt": 4 });
  });
});
