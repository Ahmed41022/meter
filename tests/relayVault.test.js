import { describe, it, expect } from "vitest";
import { DEFAULT_LIMITS, SCHEMA_VERSION, createVault } from "../relay/vault.js";
import { sha256b64u } from "../relay/util.js";
import { openSql, seededRandom } from "./relaySql.js";

const DAY = 86_400_000;
const MIN = 60_000;

/** A vault core over a fresh in-memory database, with a clock the test moves. */
async function world(limits = {}) {
  const db = await openSql();
  const clock = { t: Date.UTC(2026, 0, 5, 12, 0, 0) };
  const events = [];
  const make = (over = {}) => createVault({
    sql: db.sql, transaction: db.transaction, now: () => clock.t, random: seededRandom(7), limits,
    emit: (type, payload) => events.push([type, payload]), ...over,
  });
  return { ...db, clock, events, core: make(), make };
}

const pad = (s, n = 43) => s.padEnd(n, "x");
/** A device as a client would hold it: a token, its hash, an id and a public key. */
async function device(n) {
  const token = pad(`tok${n}`);
  return {
    n, token, id: String(n).padStart(16, "0").replace(/\d/g, (d) => "abcdef0123"[Number(d)]),
    hash: await sha256b64u(token),
    pub: { kty: "EC", crv: "P-256", x: pad(`px${n}`, 43), y: pad(`py${n}`, 43) },
  };
}

const RECOVER = "recover-auth-secret-0123456789";

const call = (w, method, path, { token, body, trusted = false, headers = {} } = {}) =>
  w.core.handle({
    method, path, body,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  }, { trusted });

const claim = async (w, dev, extra = {}) => call(w, "POST", "/claim", {
  trusted: true,
  body: {
    tokenHash: dev.hash, pubkey: dev.pub, nameCt: "name-ct", recoverHash: await sha256b64u(RECOVER),
    deviceId: dev.id, ...extra,
  },
});

/** A claimed vault with its first device. */
async function claimed(limits) {
  const w = await world(limits);
  const a = await device(1);
  const res = await claim(w, a);
  expect(res.status).toBe(200);
  return { w, a, mk: device };
}

const blob = (s = "x") => ({ v: 1, n: "nonce", ct: s.padEnd(20, "c") });
const push = (w, dev, expect, bid, b = blob(), epoch = 1) =>
  call(w, "POST", "/log", { token: dev.token, body: { epoch, expect, bid, blob: b } });
const bid = (i) => `bid-${String(i).padStart(8, "0")}`;
const parts = (s = "p") => [blob(`${s}1`), blob(`${s}2`)];
const put = (w, dev, expectUpto, upto, p = parts(), epoch = 1) =>
  call(w, "PUT", "/snapshot", { token: dev.token, body: { expectUpto, upto, epoch, parts: p } });

describe("schema", () => {
  it("is created with IF NOT EXISTS and a version, so a second start over the same storage is harmless", async () => {
    const w = await world();
    const a = await device(1);
    await claim(w, a);
    await push(w, a, 0, bid(1));
    const again = w.make();
    expect(again.state()).toMatchObject({ head: 1, epoch: 1 });
    expect(w.sql.exec("SELECT v FROM meta WHERE k = 'schema'").toArray()[0].v).toBe(SCHEMA_VERSION);
  });
});

describe("claim", () => {
  it("is for the Worker only: an outside caller gets a plain 404", async () => {
    const w = await world();
    const a = await device(1);
    const res = await call(w, "POST", "/claim", { body: { tokenHash: a.hash } });
    expect(res).toEqual({ status: 404, body: { code: "not_found" } });
  });

  it("registers the first device, and answers a repeat with the same token hash the same way", async () => {
    const w = await world();
    const a = await device(1);
    expect(await claim(w, a)).toEqual({ status: 200, body: { deviceId: a.id, epoch: 1 } });
    expect(await claim(w, a)).toEqual({ status: 200, body: { deviceId: a.id, epoch: 1 } });
    const list = await call(w, "GET", "/devices", { token: a.token });
    expect(list.body.devices).toHaveLength(1);
    expect(list.body.devices[0]).toMatchObject({ id: a.id, pubkey: a.pub, nameCt: "name-ct" });
  });

  it("refuses a second claim with a different token", async () => {
    const w = await world();
    await claim(w, await device(1));
    expect((await claim(w, await device(2))).status).toBe(409);
  });

  it("takes a device id from the relay when the client sends none", async () => {
    const w = await world();
    const a = await device(1);
    const res = await claim(w, a, { deviceId: undefined });
    expect(res.body.deviceId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects malformed claims before storing anything", async () => {
    const w = await world();
    const a = await device(1);
    for (const bad of [{ tokenHash: "short" }, { recoverHash: 5 }, { pubkey: { kty: "RSA" } }, { deviceId: "zz" }]) {
      expect((await claim(w, a, bad)).status).toBe(400);
    }
    expect((await call(w, "GET", "/devices", { token: a.token })).status).toBe(404);
  });

  it("means every other endpoint answers 'unclaimed' until it has happened", async () => {
    const w = await world();
    const a = await device(1);
    expect(await call(w, "GET", "/log?since=0", { token: a.token })).toEqual({ status: 404, body: { code: "unclaimed" } });
  });
});

describe("authentication", () => {
  it("accepts only a registered token, found by the SHA-256 of the header string", async () => {
    const { w, a } = await claimed();
    expect((await call(w, "GET", "/devices", { token: a.token })).status).toBe(200);
    expect((await call(w, "GET", "/devices", { token: pad("someone-else") })).status).toBe(401);
    expect((await call(w, "GET", "/devices")).status).toBe(401);
    expect((await call(w, "GET", "/devices", { headers: { Authorization: a.token } })).status).toBe(401);
    expect((await call(w, "GET", "/devices", { headers: { Authorization: `Basic ${a.token}` } })).status).toBe(401);
    expect((await call(w, "GET", "/devices", { headers: { authorization: `Bearer ${a.token}` } })).status).toBe(200);
    expect(a.hash).toBe(w.sql.exec("SELECT token_hash FROM devices").toArray()[0].token_hash);
  });

  it("updates seen_at at most once an hour per device", async () => {
    const { w, a } = await claimed();
    const seen = () => w.sql.exec("SELECT seen_at FROM devices").toArray()[0].seen_at;
    const first = seen();
    w.clock.t += 30 * MIN;
    await call(w, "GET", "/devices", { token: a.token });
    expect(seen()).toBe(first);
    w.clock.t += 31 * MIN;
    await call(w, "GET", "/devices", { token: a.token });
    expect(seen()).toBe(w.clock.t);
  });

  it("answers an unknown route 404 and never throws on junk", async () => {
    const { w, a } = await claimed();
    expect((await call(w, "GET", "/nope", { token: a.token })).status).toBe(404);
    expect((await call(w, "PATCH", "/log", { token: a.token })).status).toBe(404);
    expect((await call(w, "POST", "/log", { token: a.token, body: "text" })).status).toBe(400);
    expect((await call(w, "POST", "/log", { token: a.token })).status).toBe(400);
  });
});

describe("the log", () => {
  it("assigns seqs in order and returns entries after a cursor", async () => {
    const { w, a } = await claimed();
    expect((await push(w, a, 0, bid(1), blob("one"))).body).toEqual({ seq: 1 });
    expect((await push(w, a, 1, bid(2), blob("two"))).body).toEqual({ seq: 2 });
    const all = await call(w, "GET", "/log?since=0", { token: a.token });
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ epoch: 1, head: 2, snapshotUpto: null });
    expect(all.body.entries.map((e) => [e.seq, e.dev, e.bid])).toEqual([[1, a.id, bid(1)], [2, a.id, bid(2)]]);
    expect(all.body.entries[0].blob).toEqual(blob("one"));
    const tail = await call(w, "GET", "/log?since=1", { token: a.token });
    expect(tail.body.entries.map((e) => e.seq)).toEqual([2]);
    const none = await call(w, "GET", "/log?since=2", { token: a.token });
    expect(none.body.entries).toEqual([]);
  });

  it("pages by entry count and the first entry is always sent", async () => {
    const { w, a } = await claimed({ pageEntries: 2 });
    for (let i = 0; i < 5; i += 1) await push(w, a, i, bid(i + 1));
    const page = await call(w, "GET", "/log?since=0&limit=50", { token: a.token });
    expect(page.body.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(page.body.head).toBe(5);
    const small = await call(w, "GET", "/log?since=0&limit=1", { token: a.token });
    expect(small.body.entries).toHaveLength(1);
  });

  it("pages by size too, but never returns an empty page when there is something", async () => {
    const { w, a } = await claimed({ pageBytes: 10 });
    await push(w, a, 0, bid(1));
    await push(w, a, 1, bid(2));
    const page = await call(w, "GET", "/log?since=0", { token: a.token });
    expect(page.body.entries.map((e) => e.seq)).toEqual([1]);
  });

  it("answers a push at the wrong place with 409 and the entries it missed, in the shape the engine reads", async () => {
    const { w, a, mk } = await claimed();
    const b = await mk(2);
    await call(w, "POST", "/pair/open", { token: a.token, body: { joinId: "1111111111111111", joinTokenHash: await sha256b64u(pad("join")), openProof: "open-proof-1" } });
    // Put B on the vault directly, as a recovery would.
    await call(w, "POST", "/recover", { body: { recoverProof: RECOVER, tokenHash: b.hash, pubkey: b.pub, deviceId: b.id } });
    await push(w, a, 0, bid(1), blob("A1"));
    await push(w, a, 1, bid(2), blob("A2"));
    const lost = await push(w, b, 0, bid(3), blob("B1"));
    expect(lost.status).toBe(409);
    expect(lost.body.code).toBe("conflict");
    expect(lost.body.head).toBe(2);
    expect(lost.body.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(lost.body.entries[0]).toEqual({ seq: 1, dev: a.id, bid: bid(1), blob: blob("A1") });
    // Nothing was stored for the loser.
    expect(w.sql.exec("SELECT COUNT(*) AS n FROM log").toArray()[0].n).toBe(2);
    // With the right expectation the same push goes through.
    expect((await push(w, b, 2, bid(3), blob("B1"))).body).toEqual({ seq: 3 });
  });

  it("treats a repeated bid as the same push, whatever expect says", async () => {
    const { w, a } = await claimed();
    expect((await push(w, a, 0, bid(1))).body.seq).toBe(1);
    await push(w, a, 1, bid(2));
    const again = await push(w, a, 0, bid(1));
    expect(again).toEqual({ status: 200, body: { seq: 1 } });
    expect(w.sql.exec("SELECT COUNT(*) AS n FROM log").toArray()[0].n).toBe(2);
    expect(w.core.state().writes).toBe(2);
  });

  it("answers the wrong epoch 409 with the current one marked as a rotation", async () => {
    const { w, a } = await claimed();
    const res = await push(w, a, 0, bid(1), blob(), 7);
    expect(res).toEqual({ status: 409, body: { code: "epoch", epoch: 1, rotated: true } });
    const read = await call(w, "GET", "/log?since=0&epoch=2", { token: a.token });
    expect(read.status).toBe(409);
  });

  it("validates what it is given", async () => {
    const { w, a } = await claimed({ batchBytes: 100 });
    const post = (body) => call(w, "POST", "/log", { token: a.token, body });
    expect((await post({ epoch: 1, expect: 0, bid: "short", blob: blob() })).status).toBe(400);
    expect((await post({ epoch: 1, expect: -1, bid: bid(1), blob: blob() })).status).toBe(400);
    expect((await post({ epoch: 1, expect: 0, bid: bid(1), blob: 5 })).status).toBe(400);
    expect((await post({ epoch: 1, expect: 0, bid: bid(1), blob: "café" })).status).toBe(400);
    expect((await post({ epoch: 1, expect: 0, bid: bid(1), blob: "z".repeat(200) })).status).toBe(413);
    expect((await call(w, "GET", "/log?since=abc", { token: a.token })).status).toBe(400);
    expect((await call(w, "GET", "/log?since=-1", { token: a.token })).status).toBe(400);
  });

  it("tells a connected socket about each new entry", async () => {
    const { w, a } = await claimed();
    await push(w, a, 0, bid(1), blob("hello"));
    expect(w.events).toContainEqual(["entry", { seq: 1, dev: a.id, blob: blob("hello") }]);
  });

  it("does not let a failing socket hook break the request", async () => {
    const w = await world();
    const bad = w.make({ emit: () => { throw new Error("socket closed"); } });
    const a = await device(1);
    w.core = bad;
    await claim(w, a);
    expect((await push(w, a, 0, bid(1))).status).toBe(200);
  });
});

describe("snapshots and compaction", () => {
  it("has none until one is put, and the first is expected as null", async () => {
    const { w, a } = await claimed();
    expect((await call(w, "GET", "/snapshot", { token: a.token })).status).toBe(404);
    expect((await put(w, a, 0, 0)).status).toBe(409);
    expect((await put(w, a, null, 0)).status).toBe(200);
    const got = await call(w, "GET", "/snapshot", { token: a.token });
    expect(got.body).toEqual({ upto: 0, epoch: 1, parts: parts() });
    const log = await call(w, "GET", "/log?since=0", { token: a.token });
    expect(log.body.snapshotUpto).toBe(0);
  });

  it("is swapped only by a caller who knows the current one, so two compactors cannot both win", async () => {
    const { w, a } = await claimed({ tail: 2 });
    await put(w, a, null, 0);
    for (let i = 0; i < 6; i += 1) await push(w, a, i, bid(i + 1));
    expect((await put(w, a, 0, 6, parts("new"))).status).toBe(200);
    const late = await put(w, a, 0, 6, parts("late"));
    expect(late).toEqual({ status: 409, body: { code: "conflict", snapshotUpto: 6 } });
    expect((await call(w, "GET", "/snapshot", { token: a.token })).body.parts).toEqual(parts("new"));
  });

  it("prunes the log behind it but keeps a short tail", async () => {
    const { w, a } = await claimed({ tail: 2 });
    await put(w, a, null, 0);
    for (let i = 0; i < 6; i += 1) await push(w, a, i, bid(i + 1));
    await put(w, a, 0, 6);
    const left = w.sql.exec("SELECT seq FROM log ORDER BY seq").toArray().map((r) => r.seq);
    expect(left).toEqual([5, 6]);
    // The head survives the pruning and seqs are not reused.
    expect((await push(w, a, 6, bid(7))).body.seq).toBe(7);
  });

  it("answers 410 with the snapshot position to a reader that fell behind the kept tail, and not to one inside it", async () => {
    const { w, a } = await claimed({ tail: 2 });
    await put(w, a, null, 0);
    for (let i = 0; i < 6; i += 1) await push(w, a, i, bid(i + 1));
    await put(w, a, 0, 6);
    const far = await call(w, "GET", "/log?since=2", { token: a.token });
    expect(far).toEqual({ status: 410, body: { code: "gone", snapshotUpto: 6 } });
    const near = await call(w, "GET", "/log?since=4", { token: a.token });
    expect(near.status).toBe(200);
    expect(near.body.entries.map((e) => e.seq)).toEqual([5, 6]);
    expect((await call(w, "GET", "/log?since=6", { token: a.token })).body.entries).toEqual([]);
  });

  it("refuses positions that make no sense", async () => {
    const { w, a } = await claimed();
    await put(w, a, null, 0);
    expect((await put(w, a, 0, 5)).status).toBe(400); // beyond head
    await push(w, a, 0, bid(1));
    await put(w, a, 0, 1);
    expect((await put(w, a, 1, 0)).status).toBe(400); // backwards
    expect((await put(w, a, 1, 1, [])).status).toBe(400);
    expect((await put(w, a, 1, 1, Array.from({ length: 9 }, () => blob()))).status).toBe(400);
    expect((await put(w, a, 1, 1, parts(), 4)).status).toBe(409);
  });

  it("caps a part's size", async () => {
    const { w, a } = await claimed({ partBytes: 50 });
    const big = [{ v: 1, n: "n", ct: "c".repeat(100) }];
    expect((await put(w, a, null, 0, big)).status).toBe(413);
  });
});

describe("quotas", () => {
  it("stops appends at the daily cap with a reset time, and starts again at 00:00 UTC", async () => {
    const { w, a } = await claimed({ appendsPerDay: 3, writesPerMin: 1000 });
    for (let i = 0; i < 3; i += 1) expect((await push(w, a, i, bid(i + 1))).status).toBe(200);
    const over = await push(w, a, 3, bid(4));
    const reset = (Math.floor(w.clock.t / DAY) + 1) * DAY;
    expect(over).toEqual({ status: 429, body: { code: "vault_quota", what: "appends", max: 3, resetAt: reset } });
    // A retry of something already stored still answers.
    expect((await push(w, a, 0, bid(1))).status).toBe(200);
    w.clock.t = reset;
    expect((await push(w, a, 3, bid(4))).status).toBe(200);
  });

  it("counts in memory and persists every few appends, losing at most that few on eviction", async () => {
    const { w, a } = await claimed({ persistEvery: 3, writesPerMin: 1000 });
    const stored = () => w.sql.exec("SELECT v FROM meta WHERE k = 'writes_today'").toArray()[0]?.v ?? 0;
    await push(w, a, 0, bid(1));
    await push(w, a, 1, bid(2));
    expect(stored()).toBe(0);
    await push(w, a, 2, bid(3));
    expect(stored()).toBe(3);
    await push(w, a, 3, bid(4));
    expect(w.core.state().writes).toBe(4);
    // A restart reads what was persisted; flush() writes the rest on demand.
    expect(w.make().state().writes).toBe(3);
    w.core.flush();
    expect(w.make().state().writes).toBe(4);
  });

  it("ignores yesterday's persisted count", async () => {
    const { w, a } = await claimed({ appendsPerDay: 2, persistEvery: 1, writesPerMin: 1000 });
    await push(w, a, 0, bid(1));
    await push(w, a, 1, bid(2));
    expect((await push(w, a, 2, bid(3))).status).toBe(429);
    w.clock.t += DAY;
    const fresh = w.make();
    w.core = fresh;
    expect((await push(w, a, 2, bid(3))).status).toBe(200);
  });

  it("refuses to store beyond the byte cap, for a log entry and for a snapshot", async () => {
    const { w, a } = await claimed({ vaultBytes: 300, writesPerMin: 1000 });
    expect((await push(w, a, 0, bid(1), blob("a".repeat(100)))).status).toBe(200);
    const over = await push(w, a, 1, bid(2), blob("b".repeat(250)));
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ code: "vault_quota", what: "bytes", max: 300, resetAt: null });
    const huge = await put(w, a, null, 0, [blob("c".repeat(280))]);
    expect(huge.body).toMatchObject({ code: "vault_quota", what: "bytes" });
  });

  it("counts a snapshot's replacement, not its sum, against the cap", async () => {
    const { w, a } = await claimed({ vaultBytes: 400 });
    expect((await put(w, a, null, 0, [blob("a".repeat(150))])).status).toBe(200);
    expect((await put(w, a, 0, 0, [blob("b".repeat(150))])).status).toBe(200);
    expect(w.core.state().bytes).toBeLessThan(300);
  });

  it("limits the vault to six devices, at joining and at opening a slot", async () => {
    const { w, a, mk } = await claimed({ devices: 3 });
    for (const n of [2, 3]) {
      const d = await mk(n);
      expect((await call(w, "POST", "/recover", { body: { recoverProof: RECOVER, tokenHash: d.hash, pubkey: d.pub, deviceId: d.id } })).status).toBe(200);
    }
    const d4 = await mk(4);
    const full = await call(w, "POST", "/recover", { body: { recoverProof: RECOVER, tokenHash: d4.hash, pubkey: d4.pub, deviceId: d4.id } });
    expect(full).toEqual({ status: 429, body: { code: "vault_quota", what: "devices", max: 3, resetAt: null } });
    const open = await call(w, "POST", "/pair/open", { token: a.token, body: { joinId: "1111111111111111", joinTokenHash: await sha256b64u(pad("j")), openProof: "open-proof-1" } });
    expect(open.status).toBe(429);
    expect(DEFAULT_LIMITS.devices).toBe(6);
    expect(DEFAULT_LIMITS.appendsPerDay).toBe(2000);
    expect(DEFAULT_LIMITS.vaultBytes).toBe(50 * 1024 * 1024);
  });

  it("stops at the log row cap, which compaction is meant to keep far away", async () => {
    const { w, a } = await claimed({ logRows: 2, writesPerMin: 1000 });
    await push(w, a, 0, bid(1));
    await push(w, a, 1, bid(2));
    expect((await push(w, a, 2, bid(3))).body).toMatchObject({ code: "vault_quota", what: "log_rows" });
  });

  it("rate-limits a device's writes with a bucket that refills", async () => {
    const { w, a } = await claimed({ writesPerMin: 3 });
    for (let i = 0; i < 3; i += 1) expect((await push(w, a, i, bid(i + 1))).status).toBe(200);
    const limited = await push(w, a, 3, bid(4));
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate");
    expect(limited.body.retryAfterMs).toBeGreaterThan(0);
    w.clock.t += 21 * 1000;
    expect((await push(w, a, 3, bid(4))).status).toBe(200);
  });

  it("gives each device its own bucket", async () => {
    const { w, a, mk } = await claimed({ writesPerMin: 1 });
    const b = await mk(2);
    await call(w, "POST", "/recover", { body: { recoverProof: RECOVER, tokenHash: b.hash, pubkey: b.pub, deviceId: b.id } });
    expect((await push(w, a, 0, bid(1))).status).toBe(200);
    expect((await push(w, a, 1, bid(2))).status).toBe(429);
    expect((await push(w, b, 1, bid(3))).status).toBe(200);
  });
});

describe("devices", () => {
  it("lists them without anything secret, and lets a device set its encrypted name", async () => {
    const { w, a } = await claimed();
    const put1 = await call(w, "PUT", "/device", { token: a.token, body: { nameCt: blob("new-name") } });
    expect(put1.status).toBe(200);
    const list = (await call(w, "GET", "/devices", { token: a.token })).body.devices;
    expect(list[0].nameCt).toEqual(blob("new-name"));
    expect(Object.keys(list[0]).sort()).toEqual(["addedAt", "id", "nameCt", "pubkey", "seenAt"]);
    expect((await call(w, "PUT", "/device", { token: a.token, body: { nameCt: 5 } })).status).toBe(400);
  });
});

describe("pairing", () => {
  const JOIN_ID = "1111111111111111";
  const JOIN_TOKEN = "join-token-aaaaaaaaaaaaaa";
  const WRAPPED = { epk: { x: "ex", y: "ey" }, n: "nonce", ct: "wrapped-ct" };

  async function paired(limits) {
    const base = await claimed(limits);
    const b = await device(2);
    const openSlot = async (id = JOIN_ID, token = JOIN_TOKEN, as = base.a) =>
      call(base.w, "POST", "/pair/open", { token: as.token, body: { joinId: id, joinTokenHash: await sha256b64u(token), openProof: "open-proof-1" } });
    const request = (over = {}, token = JOIN_TOKEN, dev = b) => call(base.w, "POST", "/pair/request", {
      token, body: { joinId: JOIN_ID, deviceId: dev.id, pubkey: dev.pub, tokenHash: dev.hash, proof: "req-proof-xxxx", ...over },
    });
    const status = (id = JOIN_ID, token = JOIN_TOKEN) => call(base.w, "GET", `/pair/status?id=${id}`, { token });
    const approve = (over = {}) => call(base.w, "POST", "/pair/approve", {
      token: base.a.token, body: { joinId: JOIN_ID, wrapped: WRAPPED, ack: "ack-proof-xx", epoch: 1, ...over },
    });
    const pending = (dev = base.a) => call(base.w, "GET", "/pair/pending", { token: dev.token });
    return { ...base, b, openSlot, request, status, approve, pending };
  }

  it("opens a slot for ten minutes and refuses a repeated join id", async () => {
    const p = await paired();
    const res = await p.openSlot();
    expect(res).toEqual({ status: 200, body: { expiresAt: p.w.clock.t + 10 * MIN } });
    expect((await p.openSlot()).status).toBe(409);
  });

  it("needs a registered device to open a slot and rejects a malformed one", async () => {
    const p = await paired();
    expect((await call(p.w, "POST", "/pair/open", { body: { joinId: JOIN_ID } })).status).toBe(401);
    expect((await call(p.w, "POST", "/pair/open", { token: p.a.token, body: { joinId: "zz" } })).status).toBe(400);
  });

  it("starts a slot as pending and tells the joiner the approver's registered public key and proof", async () => {
    const p = await paired();
    await p.openSlot();
    expect((await p.status()).body).toEqual({ state: "pending", approverPub: p.a.pub, openProof: "open-proof-1" });
    expect((await p.pending()).body).toBeNull();
  });

  it("holds the joiner's request for the approver, in the shape the client reads, and pushes a notice", async () => {
    const p = await paired();
    await p.openSlot();
    expect((await p.request()).status).toBe(200);
    const waiting = await p.pending();
    expect(waiting.body).toEqual({ joinId: JOIN_ID, deviceId: p.b.id, pubkey: p.b.pub, tokenHash: p.b.hash, proof: "req-proof-xxxx" });
    expect(p.w.events).toContainEqual(["pair_request", { joinId: JOIN_ID, owner: p.a.id }]);
  });

  it("accepts the same device repeating its request and refuses a different one", async () => {
    const p = await paired();
    await p.openSlot();
    await p.request();
    expect((await p.request()).status).toBe(200);
    const other = await device(3);
    expect((await p.request({}, JOIN_TOKEN, other)).status).toBe(409);
    expect((await p.request({ deviceId: "ffffffffffffffff" })).status).toBe(409);
    expect((await p.pending()).body.deviceId).toBe(p.b.id);
  });

  it("accepts the join token as a request field, as the client fake does", async () => {
    const p = await paired();
    await p.openSlot();
    const res = await call(p.w, "POST", "/pair/request", {
      body: { joinId: JOIN_ID, joinToken: JOIN_TOKEN, deviceId: p.b.id, pubkey: p.b.pub, tokenHash: p.b.hash, proof: "req-proof-xxxx" },
    });
    expect(res.status).toBe(200);
  });

  it("refuses a wrong join token, a device that already exists, and an unknown slot", async () => {
    const p = await paired();
    await p.openSlot();
    expect((await p.request({}, pad("wrong-token"))).status).toBe(401);
    expect((await p.request({ deviceId: p.a.id })).status).toBe(409);
    expect((await p.request({ joinId: "2222222222222222" })).status).toBe(410);
    expect((await p.status("2222222222222222")).status).toBe(410);
    expect((await p.status(JOIN_ID, pad("wrong-token"))).status).toBe(401);
    expect((await p.request({ pubkey: { kty: "RSA" } })).status).toBe(400);
    expect((await p.request({ proof: "x" })).status).toBe(400);
  });

  it("keeps a second request out while one is waiting (one at a time per vault)", async () => {
    const p = await paired();
    const c = await device(3);
    await call(p.w, "POST", "/recover", { body: { recoverProof: RECOVER, tokenHash: c.hash, pubkey: c.pub, deviceId: c.id } });
    await p.openSlot();
    await p.openSlot("3333333333333333", pad("other-join-token"), c);
    await p.request();
    const other = await device(4);
    const res = await call(p.w, "POST", "/pair/request", {
      token: pad("other-join-token"),
      body: { joinId: "3333333333333333", deviceId: other.id, pubkey: other.pub, tokenHash: other.hash, proof: "req-proof-xxxx" },
    });
    expect(res).toEqual({ status: 409, body: { code: "busy" } });
  });

  it("opening again retires this device's own unfinished slot", async () => {
    const p = await paired();
    await p.openSlot();
    await p.request();
    await p.openSlot("4444444444444444", pad("second-join-token"));
    expect((await p.pending()).body).toBeNull();
    expect((await p.status()).body).toEqual({ state: "expired" });
  });

  it("approves: registers the joiner, keeps the answer, and the joiner gets wrapped, ack and epoch", async () => {
    const p = await paired();
    await p.openSlot();
    await p.request();
    const res = await p.approve();
    expect(res).toEqual({ status: 200, body: { deviceId: p.b.id } });
    const list = (await call(p.w, "GET", "/devices", { token: p.a.token })).body.devices;
    expect(list.map((d) => d.id)).toEqual([p.a.id, p.b.id]);
    expect(list[1].nameCt).toBeNull();
    // The joiner's token now works for ordinary calls.
    expect((await call(p.w, "GET", "/log?since=0", { token: p.b.token })).status).toBe(200);
    expect((await p.status()).body).toEqual({
      state: "approved", approverPub: p.a.pub, openProof: "open-proof-1", wrapped: WRAPPED, ack: "ack-proof-xx", epoch: 1,
    });
    expect((await p.pending()).body).toBeNull();
  });

  it("accepts a repeated approval and refuses one that is not the owner's, early, or for another epoch", async () => {
    const p = await paired();
    await p.openSlot();
    expect((await p.approve()).status).toBe(409); // no request yet
    await p.request();
    expect((await p.approve({ epoch: 3 })).body.code).toBe("epoch");
    await p.approve();
    expect(await p.approve()).toEqual({ status: 200, body: { deviceId: p.b.id } });
    const list = (await call(p.w, "GET", "/devices", { token: p.a.token })).body.devices;
    expect(list).toHaveLength(2);
  });

  it("lets only the opening device approve or deny", async () => {
    const p = await paired();
    const c = await device(3);
    await call(p.w, "POST", "/recover", { body: { recoverProof: RECOVER, tokenHash: c.hash, pubkey: c.pub, deviceId: c.id } });
    await p.openSlot();
    await p.request();
    const steal = await call(p.w, "POST", "/pair/approve", { token: c.token, body: { joinId: JOIN_ID, wrapped: WRAPPED, ack: "ack-proof-xx", epoch: 1 } });
    expect(steal.status).toBe(403);
    expect((await call(p.w, "DELETE", "/pair", { token: c.token, body: { joinId: JOIN_ID } })).status).toBe(403);
    expect((await p.pending(c)).body).toBeNull();
  });

  it("denies: the joiner sees denied, and a denied slot cannot be approved", async () => {
    const p = await paired();
    await p.openSlot();
    await p.request();
    expect((await call(p.w, "DELETE", "/pair", { token: p.a.token, body: { joinId: JOIN_ID } })).status).toBe(200);
    expect((await p.status()).body).toEqual({ state: "denied" });
    expect((await p.approve()).status).toBe(409);
    expect((await p.pending()).body).toBeNull();
    expect((await call(p.w, "DELETE", "/pair", { token: p.a.token, body: { joinId: "5555555555555555" } })).status).toBe(410);
  });

  it("lets an open slot lapse after ten minutes", async () => {
    const p = await paired();
    await p.openSlot();
    p.w.clock.t += 10 * MIN;
    expect((await p.request()).status).toBe(410);
    expect((await p.status()).body).toEqual({ state: "expired" });
    expect((await p.approve()).status).toBe(410);
  });

  it("keeps an approved slot collectable for sixty minutes from approval, not from opening", async () => {
    const p = await paired();
    await p.openSlot();
    await p.request();
    p.w.clock.t += 9 * MIN;
    await p.approve();
    p.w.clock.t += 59 * MIN;
    expect((await p.status()).body.state).toBe("approved");
    p.w.clock.t += 2 * MIN;
    expect((await p.status()).body).toEqual({ state: "expired" });
    // An approval repeated after that is still an answer, not an error.
    expect((await p.approve()).status).toBe(200);
  });

  it("sweeps slots long after they lapsed", async () => {
    const p = await paired();
    await p.openSlot();
    p.w.clock.t += 2 * DAY;
    await p.openSlot("6666666666666666", pad("later-join-token"));
    expect((await p.status()).status).toBe(410);
  });

  it("rations pairing attempts to ten an hour", async () => {
    const p = await paired();
    await p.openSlot();
    for (let i = 0; i < 10; i += 1) expect((await p.request({}, pad(`guess${i}`))).status).toBe(401);
    const blocked = await p.request();
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("rate");
    p.w.clock.t += 61 * MIN;
    await p.openSlot("8888888888888888", pad("fresh-join-token"));
    expect((await p.request({ joinId: "8888888888888888" }, pad("fresh-join-token"))).status).toBe(200);
  });

  it("caps live open slots", async () => {
    const p = await paired({ openSlots: 1 });
    await p.openSlot();
    const c = await device(3);
    await call(p.w, "POST", "/recover", { body: { recoverProof: RECOVER, tokenHash: c.hash, pubkey: c.pub, deviceId: c.id } });
    const res = await call(p.w, "POST", "/pair/open", { token: c.token, body: { joinId: "7777777777777777", joinTokenHash: await sha256b64u(pad("jt")), openProof: "open-proof-1" } });
    expect(res.status).toBe(429);
  });
});

describe("recovery", () => {
  it("tells anyone the epoch, which a recovering device needs to derive its proof", async () => {
    const { w } = await claimed();
    expect(await call(w, "GET", "/recover")).toEqual({ status: 200, body: { epoch: 1 } });
  });

  it("registers a new device for whoever proves the recovery secret", async () => {
    const { w, a, mk } = await claimed();
    const b = await mk(2);
    const res = await call(w, "POST", "/recover", { body: { recoverProof: RECOVER, tokenHash: b.hash, pubkey: b.pub, nameCt: "n", deviceId: b.id } });
    expect(res).toEqual({ status: 200, body: { deviceId: b.id, epoch: 1 } });
    expect((await call(w, "GET", "/devices", { token: b.token })).body.devices).toHaveLength(2);
    expect(w.events).toContainEqual(["devices", {}]);
    void a;
  });

  it("refuses a wrong proof, and the token is not the proof", async () => {
    const { w, a, mk } = await claimed();
    const b = await mk(2);
    const bad = await call(w, "POST", "/recover", { body: { recoverProof: "nope", tokenHash: b.hash, pubkey: b.pub } });
    expect(bad.status).toBe(401);
    const token = await call(w, "POST", "/recover", { body: { recoverProof: a.token, tokenHash: b.hash, pubkey: b.pub } });
    expect(token.status).toBe(401);
  });

  it("is limited to five attempts an hour, right or wrong", async () => {
    const { w, mk } = await claimed();
    for (let i = 0; i < 5; i += 1) {
      const d = await mk(10 + i);
      expect((await call(w, "POST", "/recover", { body: { recoverProof: `wrong${i}`, tokenHash: d.hash, pubkey: d.pub } })).status).toBe(401);
    }
    const d = await mk(20);
    const limited = await call(w, "POST", "/recover", { body: { recoverProof: RECOVER, tokenHash: d.hash, pubkey: d.pub } });
    expect(limited.status).toBe(429);
    w.clock.t += 61 * MIN;
    expect((await call(w, "POST", "/recover", { body: { recoverProof: RECOVER, tokenHash: d.hash, pubkey: d.pub } })).status).toBe(200);
  });

  it("validates its body", async () => {
    const { w, mk } = await claimed({ recoverPerHour: 100 });
    const b = await mk(2);
    expect((await call(w, "POST", "/recover", { body: { tokenHash: b.hash, pubkey: b.pub } })).status).toBe(400);
    expect((await call(w, "POST", "/recover", { body: { recoverProof: RECOVER, tokenHash: "x", pubkey: b.pub } })).status).toBe(400);
    expect((await call(w, "POST", "/recover", { body: { recoverProof: RECOVER, tokenHash: b.hash, pubkey: b.pub, deviceId: "no" } })).status).toBe(400);
  });
});

describe("rotation", () => {
  const NEW_RECOVER = "new-recover-secret-9876543210";

  async function threeDevices() {
    const base = await claimed({ tail: 2, writesPerMin: 1000 });
    const b = await device(2);
    const c = await device(3);
    for (const d of [b, c]) {
      await call(base.w, "POST", "/recover", { body: { recoverProof: RECOVER, tokenHash: d.hash, pubkey: d.pub, deviceId: d.id } });
    }
    return { ...base, b, c };
  }
  const rotate = async (w, dev, over = {}) => call(w, "POST", "/rotate", {
    token: dev.token,
    body: {
      expectEpoch: 1, snapshot: { parts: parts("rot") }, keyboxes: {}, recoverHash: await sha256b64u(NEW_RECOVER), ...over,
    },
  });

  it("bumps the epoch, drops the log, replaces the snapshot, stores keyboxes and cuts the removed device off", async () => {
    const { w, a, b, c } = await threeDevices();
    await put(w, a, null, 0);
    for (let i = 0; i < 3; i += 1) await push(w, a, i, bid(i + 1));
    const res = await rotate(w, a, { removeDevice: b.id, keyboxes: { [c.id]: blob("box-c") } });
    expect(res).toEqual({ status: 200, body: { epoch: 2, upto: 3 } });

    expect((await call(w, "GET", "/devices", { token: b.token })).status).toBe(401);
    expect(w.events).toContainEqual(["revoked", { dev: b.id }]);
    expect(w.events).toContainEqual(["rotated", { epoch: 2 }]);

    expect(w.sql.exec("SELECT COUNT(*) AS n FROM log").toArray()[0].n).toBe(0);
    const snap = await call(w, "GET", "/snapshot", { token: a.token });
    expect(snap.body).toEqual({ upto: 3, epoch: 2, parts: parts("rot") });

    const box = await call(w, "GET", "/keybox", { token: c.token });
    expect(box.body).toEqual({ epoch: 2, blob: blob("box-c") });
    // The device that rotated made the key, so it has no keybox.
    expect((await call(w, "GET", "/keybox", { token: a.token })).status).toBe(404);
  });

  it("makes a device that is slightly behind learn it from a 409, and one far behind from a 410, never old data", async () => {
    const { w, a, b, c } = await threeDevices();
    for (let i = 0; i < 3; i += 1) await push(w, a, i, bid(i + 1));
    await rotate(w, a, { keyboxes: { [b.id]: blob("box-b"), [c.id]: blob("box-c") } });
    expect((await push(w, c, 3, bid(9), blob(), 1)).body).toEqual({ code: "epoch", epoch: 2, rotated: true });
    expect((await call(w, "GET", "/log?since=1", { token: c.token })).status).toBe(410);
    // Caught up to the rotation point it reads on normally, in the new epoch.
    expect((await push(w, c, 3, bid(9), blob(), 2)).status).toBe(200);
  });

  it("replaces the recovery secret, so the old one stops working", async () => {
    const { w, a, b, c, mk } = await threeDevices();
    await rotate(w, a, { keyboxes: { [b.id]: blob("box-b"), [c.id]: blob("box-c") } });
    const d = await mk(9);
    const old = await call(w, "POST", "/recover", { body: { recoverProof: RECOVER, tokenHash: d.hash, pubkey: d.pub } });
    expect(old.status).toBe(401);
    expect((await call(w, "GET", "/recover")).body.epoch).toBe(2);
  });

  it("can rotate without removing anyone, as long as every other device gets a keybox", async () => {
    const { w, a, b, c } = await threeDevices();
    const missing = await rotate(w, a, { keyboxes: { [b.id]: blob("box-b") } });
    expect(missing.status).toBe(400);
    expect(missing.body.missing).toBe(c.id);
    expect((await rotate(w, a, { keyboxes: { [b.id]: blob("b"), [c.id]: blob("c") } })).status).toBe(200);
    expect((await call(w, "GET", "/devices", { token: b.token })).status).toBe(200);
  });

  it("refuses removing itself, an unknown device, a keybox for a stranger, and a stale epoch", async () => {
    const { w, a, b, c } = await threeDevices();
    expect((await rotate(w, a, { removeDevice: a.id })).status).toBe(400);
    expect((await rotate(w, a, { removeDevice: "ffffffffffffffff", keyboxes: { [b.id]: blob(), [c.id]: blob() } })).status).toBe(404);
    expect((await rotate(w, a, { keyboxes: { [b.id]: blob(), [c.id]: blob(), ffffffffffffffff: blob() } })).status).toBe(400);
    expect((await rotate(w, a, { removeDevice: b.id, keyboxes: { [b.id]: blob(), [c.id]: blob() } })).status).toBe(400);
    expect((await rotate(w, a, { expectEpoch: 5, keyboxes: { [b.id]: blob(), [c.id]: blob() } })).body.code).toBe("epoch");
    expect((await rotate(w, a, { recoverHash: "short" })).status).toBe(400);
    // Nothing changed through all of that.
    expect(w.core.state().epoch).toBe(1);
    expect((await call(w, "GET", "/devices", { token: b.token })).status).toBe(200);
  });

  it("drops open pairing slots, which would otherwise deliver the old key", async () => {
    const { w, a } = await threeDevices();
    await call(w, "POST", "/pair/open", { token: a.token, body: { joinId: "1111111111111111", joinTokenHash: await sha256b64u(pad("j")), openProof: "open-proof-1" } });
    await rotate(w, a, { keyboxes: { [(await device(2)).id]: blob(), [(await device(3)).id]: blob() } });
    expect((await call(w, "GET", "/pair/status?id=1111111111111111", { token: pad("j") })).status).toBe(410);
  });

  it("is atomic: a failure part way leaves the vault as it was", async () => {
    const { w, a, b, c } = await threeDevices();
    const real = w.sql.exec.bind(w.sql);
    let n = 0;
    w.sql.exec = (query, ...bind) => {
      if (/INSERT INTO keybox/.test(query)) { n += 1; throw new Error("disk full"); }
      return real(query, ...bind);
    };
    await expect(rotate(w, a, { removeDevice: b.id, keyboxes: { [c.id]: blob("c") } })).rejects.toThrow("disk full");
    w.sql.exec = real;
    expect(n).toBe(1);
    expect(w.sql.exec("SELECT COUNT(*) AS n FROM devices").toArray()[0].n).toBe(3);
    expect(w.sql.exec("SELECT v FROM meta WHERE k = 'epoch'").toArray()[0].v).toBe(1);
  });
});

describe("deleting the vault", () => {
  it("needs a device and the typed confirmation, then empties everything", async () => {
    const { w, a } = await claimed();
    await push(w, a, 0, bid(1));
    expect((await call(w, "DELETE", "/")).status).toBe(401);
    expect((await call(w, "DELETE", "/", { token: a.token })).status).toBe(400);
    expect((await call(w, "DELETE", "/", { token: a.token, body: { confirm: "yes" } })).status).toBe(400);
    expect((await call(w, "DELETE", "/", { token: a.token, body: { confirm: "delete" } })).status).toBe(200);
    for (const t of ["devices", "log", "snapshot", "keybox", "pair"]) {
      expect(w.sql.exec(`SELECT COUNT(*) AS n FROM ${t}`).toArray()[0].n).toBe(0);
    }
    expect(w.events).toContainEqual(["deleted", {}]);
  });

  it("answers every later request 410 deleted, so another device learns it is gone", async () => {
    const { w, a, mk } = await claimed();
    const b = await mk(2);
    await call(w, "POST", "/recover", { body: { recoverProof: RECOVER, tokenHash: b.hash, pubkey: b.pub, deviceId: b.id } });
    await call(w, "DELETE", "/", { token: a.token, body: { confirm: "delete" } });
    expect(await call(w, "GET", "/log?since=0", { token: b.token })).toEqual({ status: 410, body: { code: "deleted" } });
    expect((await call(w, "POST", "/recover", { body: { recoverProof: RECOVER, tokenHash: b.hash, pubkey: b.pub } })).status).toBe(410);
    // It stays deleted after a restart, and cannot be claimed again.
    w.core = w.make();
    expect((await call(w, "GET", "/devices", { token: b.token })).status).toBe(410);
    expect((await claim(w, a)).status).toBe(410);
  });
});

describe("stats for the registry", () => {
  it("are for the Worker only and carry numbers, never content", async () => {
    const { w, a } = await claimed({ writesPerMin: 1000 });
    await push(w, a, 0, bid(1));
    expect((await call(w, "GET", "/stats")).status).toBe(404);
    const stats = await call(w, "GET", "/stats", { trusted: true });
    expect(stats.status).toBe(200);
    expect(Object.keys(stats.body).sort()).toEqual(["bytes", "claimedAt", "devices", "epoch", "head", "seenAt", "writesToday"]);
    expect(stats.body).toMatchObject({ devices: 1, head: 1, writesToday: 1, epoch: 1 });
    expect(stats.body.bytes).toBeGreaterThan(0);
  });

  it("report today's writes as zero after midnight", async () => {
    const { w, a } = await claimed({ writesPerMin: 1000 });
    await push(w, a, 0, bid(1));
    w.clock.t += DAY;
    expect((await call(w, "GET", "/stats", { trusted: true })).body.writesToday).toBe(0);
  });
});
