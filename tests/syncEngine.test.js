import { describe, it, expect } from "vitest";
import { TransportError, backoff, createEngine } from "../src/sync/engine.js";
import { BATCH_VERSION, pending } from "../src/sync/changes.js";
import { mergeState } from "../src/domain/merge.js";
import { createFakeRelay } from "./syncFakeRelay.js";

const rec = (id, updatedAt, extra = {}) => ({ id, updatedAt, ...extra });
const ledger = (sessions = [], over = {}) => ({ projects: [], sessions, ...over });
const byId = (s) => Object.fromEntries(s.sessions.map((r) => [r.id, r]));

const memoryStore = () => {
  let held = null;
  return {
    load: async () => (held ? structuredClone(held) : null),
    save: async (meta) => { held = structuredClone(meta); },
    wipe: () => { held = null; },
    peek: () => held,
  };
};

/** One device: its own ledger, store and engine, with a clock all devices share. */
function world({ limits = {}, relayOptions } = {}) {
  const relay = createFakeRelay(relayOptions);
  const clock = { t: 1_000_000 };
  const sleeps = [];
  let bids = 0;
  const device = (id, state = ledger()) => {
    const d = { id, state, store: memoryStore(), transport: relay.transport(id) };
    d.engine = createEngine({
      transport: d.transport, store: d.store, device: id, now: () => clock.t,
      random: () => 0.5, sleep: async (ms) => { sleeps.push(ms); },
      newBid: () => `${id}-${(bids += 1)}`, limits,
    });
    d.sync = async (options) => {
      const out = await d.engine.sync(d.state, options);
      d.state = mergeState(d.state, out.state);
      return out;
    };
    d.put = (recordId, at, extra = {}) => {
      const next = rec(recordId, at, extra);
      d.state = { ...d.state, sessions: [...d.state.sessions.filter((r) => r.id !== recordId), next] };
    };
    return d;
  };
  return { relay, clock, sleeps, device };
}

describe("the first push", () => {
  it("is one snapshot, not a batch per request", async () => {
    const { relay, device } = world();
    const a = device("A", ledger(Array.from({ length: 40 }, (_, i) => rec(`s${i}`, 5))));
    const out = await a.sync();
    expect(out).toMatchObject({ status: "ok", uploaded: true, pushed: 40 });
    expect(relay.snapshot.upto).toBe(0);
    expect(relay.count("push")).toBe(0);
    expect(relay.log).toEqual([]);
    expect(pending(a.state, a.store.peek().sent).changes).toEqual([]);
  });

  it("is adopted whole by a device that joins, which then sends nothing back", async () => {
    const { relay, device } = world();
    await device("A", ledger([rec("s1", 5), rec("s2", 6)])).sync();
    const b = device("B");
    const out = await b.sync();
    expect(out).toMatchObject({ status: "ok", adopted: true, changed: true, pushed: 0 });
    expect(byId(b.state)).toEqual({ s1: rec("s1", 5), s2: rec("s2", 6) });
    expect(relay.count("push")).toBe(0);
  });

  it("sends only what differs when the joining device has work of its own", async () => {
    const { relay, device } = world();
    await device("A", ledger([rec("s1", 5)])).sync();
    const b = device("B", ledger([rec("s1", 5), rec("mine", 7)]));
    const out = await b.sync();
    expect(out.pushed).toBe(1);
    expect(relay.log).toHaveLength(1);
    expect(relay.log[0].batch.changes.map((c) => c.r.id)).toEqual(["mine"]);
  });
});

describe("devices converging", () => {
  it("brings three devices to the same ledger by way of the relay", async () => {
    const { device } = world();
    const a = device("A", ledger([rec("a1", 10)]));
    const b = device("B", ledger([rec("b1", 11)]));
    const c = device("C", ledger([rec("c1", 12)]));
    await a.sync(); await b.sync(); await c.sync();
    a.put("shared", 20, { v: "A" });
    b.put("shared", 30, { v: "B" });   // later: wins
    c.put("c2", 25);
    await a.sync(); await b.sync(); await c.sync();
    await a.sync(); await b.sync(); await c.sync();
    expect(byId(a.state)).toEqual(byId(b.state));
    expect(byId(b.state)).toEqual(byId(c.state));
    expect(byId(a.state).shared.v).toBe("B");
    expect(Object.keys(byId(a.state)).sort()).toEqual(["a1", "b1", "c1", "c2", "shared"]);
  });

  it("does not count its own pushes as news", async () => {
    const { device } = world();
    const a = device("A", ledger([rec("s1", 1)]));
    await a.sync();
    a.put("s2", 2);
    expect((await a.sync()).pulled).toBe(0);
    expect((await a.sync()).pulled).toBe(0);
  });

  it("pushes nothing for a heartbeat, which has no stamp", async () => {
    const { relay, device } = world();
    const a = device("A", ledger([rec("s1", 1, { segments: [{ startedAt: 1, endedAt: null, lastTick: 1 }] })]));
    await a.sync();
    a.put("s2", 2);
    await a.sync();
    const pushes = relay.count("push");
    a.state = {
      ...a.state,
      sessions: a.state.sessions.map((s) => (s.id === "s1"
        ? { ...s, segments: [{ startedAt: 1, endedAt: null, lastTick: 999 }] } : s)),
    };
    const out = await a.sync();
    expect(out.pushed).toBe(0);
    expect(relay.count("push")).toBe(pushes);
  });
});

describe("a compare-and-swap that lost", () => {
  it("takes in what the other device wrote, rebuilds and goes again", async () => {
    const { device } = world();
    const a = device("A", ledger([rec("base", 1)]));
    const b = device("B");
    await a.sync(); await b.sync();
    a.put("from-a", 10);
    b.put("from-b", 11);
    // B has pulled and is about to push when A gets in first.
    let injected = false;
    const bPush = b.transport.push;
    b.transport.push = async (request) => {
      if (!injected) {
        injected = true;
        await a.sync();
      }
      return bPush(request);
    };
    const out = await b.sync();
    expect(out).toMatchObject({ status: "ok", raced: true });
    expect(byId(b.state)["from-a"]).toBeDefined();
    await a.sync();
    expect(byId(a.state)).toEqual(byId(b.state));
    expect(Object.keys(byId(b.state))).toEqual(expect.arrayContaining(["from-a", "from-b"]));
  });

  it("waits a little and a little longer, never past the cap, then says busy", async () => {
    const { relay, sleeps, device } = world();
    const a = device("A", ledger([rec("s1", 1)]));
    await a.sync();
    a.put("s2", 2);
    relay.alwaysConflict = true;
    const before = relay.count("push");
    const out = await a.sync();
    expect(out.status).toBe("busy");
    // The first attempt plus MAX_CONFLICTS retries, and not one more.
    expect(relay.count("push") - before).toBe(4);
    expect(sleeps).toEqual([187.5, 375, 750]);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(5_000);
    // The edit is still pending, so nothing was lost by giving up.
    expect(pending(a.state, a.store.peek().sent).changes).toHaveLength(1);
  });

  it("has a backoff that grows and stops growing", () => {
    const waits = [0, 1, 2, 3, 10, 40].map((n) => backoff(n, 250, 5_000, () => 1));
    expect(waits).toEqual([250, 500, 1_000, 2_000, 5_000, 5_000]);
  });
});

describe("a response that never arrived", () => {
  it("is sent again under the same bid and stored once", async () => {
    const { relay, clock, device } = world();
    const a = device("A", ledger([rec("s1", 1)]));
    await a.sync();
    a.put("s2", 2);
    relay.failNext("push", new TransportError("network"), { afterStore: true });
    const first = await a.sync();
    expect(first.status).toBe("network");
    expect(relay.log).toHaveLength(1);                 // it WAS stored
    expect(a.store.peek().inflight.bid).toBe(relay.log[0].bid);
    clock.t = first.retryAt + 1;
    const second = await a.sync();
    expect(second.status).toBe("ok");
    expect(relay.log).toHaveLength(1);                 // not twice
    expect(a.store.peek().inflight).toBeNull();
    expect(pending(a.state, a.store.peek().sent).changes).toEqual([]);
  });

  it("is dropped, and rebuilt from the ledger, if it was never stored after all", async () => {
    const { relay, clock, device } = world();
    const a = device("A", ledger([rec("s1", 1)]));
    const b = device("B");
    await a.sync(); await b.sync();
    a.put("s2", 2);
    relay.failNext("push", new TransportError("network"));   // lost BEFORE storing
    const first = await a.sync();
    b.put("b1", 5);
    await b.sync();                                           // the head moves on
    clock.t = first.retryAt + 1;
    const second = await a.sync();
    expect(second.status).toBe("ok");
    expect(byId(a.state).b1).toBeDefined();
    await b.sync();
    expect(byId(b.state)).toEqual(byId(a.state));
    expect(pending(a.state, a.store.peek().sent).changes).toEqual([]);
  });
});

describe("a device that is far behind", () => {
  it("falls back to the snapshot when the log it wants has been pruned", async () => {
    const { relay, device } = world({ limits: { COMPACT_AFTER: 5 }, relayOptions: { tail: 1 } });
    const a = device("A", ledger([rec("s0", 1)]));
    const b = device("B");
    await a.sync();
    await b.sync();
    for (let i = 1; i <= 14; i += 1) {
      a.put(`s${i}`, 10 + i);
      await a.sync();
    }
    expect(relay.snapshot.upto).toBeGreaterThan(0);
    const out = await b.sync();
    expect(out).toMatchObject({ status: "ok", adopted: true });
    expect(Object.keys(byId(b.state))).toHaveLength(15);
    expect(byId(b.state)).toEqual(byId(a.state));
  });

  it("brings a brand new device up to date from the snapshot and the tail", async () => {
    const { relay, device } = world({ limits: { COMPACT_AFTER: 3 }, relayOptions: { tail: 1 } });
    const a = device("A", ledger([rec("s0", 1)]));
    await a.sync();
    for (let i = 1; i <= 8; i += 1) {
      a.put(`s${i}`, 10 + i);
      await a.sync();
    }
    const fresh = device("N");
    const out = await fresh.sync();
    expect(out.adopted).toBe(true);
    expect(byId(fresh.state)).toEqual(byId(a.state));
    expect(relay.count("getSnapshot")).toBe(1);
  });

  it("will not compact while something is still unsent", async () => {
    const { relay, device } = world({ limits: { COMPACT_AFTER: 1 } });
    const a = device("A", ledger([rec("s0", 1)]));
    await a.sync();
    a.put("s1", 2);
    await a.sync();
    a.put("s2", 3);
    relay.alwaysConflict = true;
    const snapshots = relay.count("putSnapshot");
    await a.sync();
    expect(relay.count("putSnapshot")).toBe(snapshots);
  });

  it("starts again from nothing if the relay now holds less than it has seen", async () => {
    const { device } = world();
    const a = device("A", ledger([rec("s0", 1)]));
    await a.sync();
    a.put("s1", 2);
    await a.sync();
    // The relay is wiped (a new deployment, a restore): a fresh one, empty.
    const fresh = world();
    a.engine = createEngine({
      transport: fresh.relay.transport("A"), store: a.store, device: "A", now: () => fresh.clock.t,
      random: () => 0.5, sleep: async () => {}, newBid: () => "again",
    });
    const out = await a.sync();
    expect(out).toMatchObject({ status: "ok", uploaded: true });
    expect(fresh.relay.snapshot.state.sessions.map((s) => s.id).sort()).toEqual(["s0", "s1"]);
  });
});

describe("a batch from a newer build", () => {
  const newerEntry = (relay, seq) => {
    relay.head = seq;
    relay.log.push({ seq, dev: "X", bid: `n${seq}`, batch: { v: BATCH_VERSION + 1, changes: [], meta: {} } });
  };

  it("stops there, keeps what came before it, and does not pass it", async () => {
    const { relay, clock, device } = world();
    const a = device("A", ledger([rec("s1", 1)]));
    const b = device("B");
    await a.sync(); await b.sync();
    a.put("ok", 5);
    await a.sync();                      // seq 1: understood
    newerEntry(relay, 2);
    const out = await b.sync();
    expect(out.status).toBe("needs-update");
    expect(out.retryAt).toBe(Infinity);
    expect(byId(b.state).ok).toBeDefined();    // seq 1 was taken in
    expect(b.store.peek().cursor).toBe(1);     // and seq 2 was not skipped
    // Nothing is asked of the relay again until the app is updated or forced.
    const calls = relay.calls.length;
    clock.t += 10 * 60_000;
    expect((await b.sync()).status).toBe("backoff");
    expect(relay.calls.length).toBe(calls);
  });
});

describe("no retry storms", () => {
  it("asks a relay that is down once, then not again until the wait is over", async () => {
    const { clock, device } = world();
    const a = device("A", ledger([rec("s1", 1)]));
    const calls = { n: 0 };
    a.engine = createEngine({
      transport: { pull: async () => { calls.n += 1; throw new TransportError("network"); } },
      store: a.store, device: "A", now: () => clock.t, random: () => 0.5, sleep: async () => {},
    });
    const first = await a.sync();
    expect(first.status).toBe("network");
    expect(calls.n).toBe(1);
    // Fifty attempts inside the wait: the engine declines every one.
    for (let i = 0; i < 50; i += 1) {
      clock.t += 10;
      expect((await a.sync()).status).toBe("backoff");
    }
    expect(calls.n).toBe(1);
    // After the wait it tries once more, and waits longer.
    const firstWait = first.retryAt - 1_000_000;
    clock.t = first.retryAt + 1;
    const second = await a.sync();
    expect(calls.n).toBe(2);
    expect(second.retryAt - clock.t).toBeGreaterThan(firstWait);
  });

  it("lets a person who pressed Sync try again at once", async () => {
    const { relay, device } = world();
    const a = device("A", ledger([rec("s1", 1)]));
    relay.failNext("pull", new TransportError("network"));
    expect((await a.sync()).status).toBe("network");
    expect((await a.sync()).status).toBe("backoff");
    expect((await a.sync({ force: true })).status).toBe("ok");
  });

  it("waits out a daily limit until the reset, and for ever on a removed device", async () => {
    const { relay, clock, device } = world();
    const a = device("A", ledger([rec("s1", 1)]));
    const resetAt = clock.t + 120_000;
    relay.failNext("pull", new TransportError("quota", { resetAt }));
    expect(await a.sync()).toMatchObject({ status: "quota", retryAt: resetAt });
    clock.t = resetAt + 1_000;
    relay.failNext("pull", new TransportError("auth"));
    expect(await a.sync()).toMatchObject({ status: "auth", retryAt: Infinity });
    clock.t += 7 * 24 * 3_600_000;
    expect((await a.sync()).status).toBe("backoff");
  });

  it("makes room itself when the relay's log is full, then pushes once more", async () => {
    const { relay, device } = world();
    const a = device("A", ledger([rec("s1", 1)]));
    await a.sync();
    a.put("s2", 2);
    relay.failNext("push", new TransportError("quota", { what: "log_rows" }));
    const out = await a.sync();
    expect(out).toMatchObject({ status: "ok", pushed: 1 });
    // The snapshot was taken BEFORE the retry, covering the head it had caught up to.
    expect(relay.count("putSnapshot")).toBe(2); // the first upload, then this one
    expect(relay.count("push")).toBe(2);
    expect(relay.log.map((e) => e.batch.changes[0].r.id)).toEqual(["s2"]);
  });

  it("tries that once only: a log still full afterwards is a plain quota, and other quotas never compact", async () => {
    const { relay, device } = world();
    const a = device("A", ledger([rec("s1", 1)]));
    await a.sync();
    a.put("s2", 2);
    relay.failNext("push", new TransportError("quota", { what: "log_rows" }));
    relay.failNext("push", new TransportError("quota", { what: "log_rows" }));
    expect((await a.sync()).status).toBe("quota");
    expect(relay.count("putSnapshot")).toBe(2);

    const { relay: r2, device: d2 } = world();
    const b = d2("B", ledger([rec("s1", 1)]));
    await b.sync();
    b.put("s2", 2);
    r2.failNext("push", new TransportError("quota", { what: "appends", resetAt: 5_000_000 }));
    expect((await b.sync({ force: true })).status).toBe("quota");
    expect(r2.count("putSnapshot")).toBe(1); // only the first upload
  });

  it("caps a daily-limit wait, so a far-off reset is looked at again", async () => {
    const { relay, clock, device } = world();
    const a = device("A", ledger([rec("s1", 1)]));
    const start = clock.t;
    relay.failNext("pull", new TransportError("quota", { resetAt: start + 20 * 3_600_000 }));
    const out = await a.sync();
    expect(out.retryAt - start).toBe(30 * 60_000);
  });

  it("reports a re-keyed vault so the app can fetch the new key", async () => {
    const { relay, device } = world();
    const a = device("A", ledger([rec("s1", 1)]));
    relay.failNext("pull", new TransportError("epoch"));
    expect((await a.sync()).status).toBe("rekey");
  });

  it("does not hide a bug as a network failure", async () => {
    const { clock, device } = world();
    const a = device("A", ledger([rec("s1", 1)]));
    a.engine = createEngine({
      transport: { pull: async () => { throw new TypeError("oops"); } },
      store: a.store, now: () => clock.t,
    });
    await expect(a.sync()).rejects.toThrow("oops");
  });
});

describe("losing the sent map", () => {
  it("re-sends and leaves the relay and every device where they were", async () => {
    const { device } = world();
    const a = device("A", ledger([rec("s1", 1)]));
    await a.sync();
    a.put("s2", 2);
    await a.sync();
    a.store.wipe();
    expect((await a.sync()).status).toBe("ok");
    expect((await a.sync()).pushed).toBe(0);
    const b = device("B");
    await b.sync();
    expect(byId(b.state)).toEqual(byId(a.state));
  });
});
