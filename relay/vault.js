/**
 * One vault's side of the relay (DESIGN section 7 and M4), as plain logic over an
 * injected `sql`.
 *
 * `sql` has the shape of a Durable Object's `ctx.storage.sql`: `exec(query,
 * ...bindings)` returns a cursor with `toArray()`. The clock and the random
 * source are injected too, so the same code runs in the Durable Object that
 * hosts it, in a test over `node:sqlite`, and in a test with a frozen clock. The
 * DO class around it is only supposed to translate a `Request` into the
 * request-like object `handle` takes and the `{status, body}` it returns into a
 * `Response`.
 *
 * What it does NOT do, on purpose: read anything. Every blob (log entry,
 * snapshot part, wrapped key, device name) is ciphertext the relay stores and
 * hands back untouched; sizes and counts are all it can see.
 *
 * Atomicity. A Durable Object runs one request at a time and does not yield
 * inside a stretch of synchronous code, so a check followed by a write in that
 * stretch cannot interleave with another request. That is what makes the
 * compare-and-swap on the log real. The only awaits in `handle` are the SHA-256s
 * of what the request carries, and they happen BEFORE the synchronous part.
 * Multi-statement changes also go through the injected `transaction`, so a
 * failure half way leaves nothing half written.
 */
import {
  DAY_MS, HOUR_MS, Reject, bearerOf, checkClaim, checkJwk, intOf, isB64u, isDeviceId, isDigest,
  isPlainObject, normaliseHeaders, opaque, parseStored, parseTarget, reply, safeEqual, sha256b64u,
} from "./util.js";

export const SCHEMA_VERSION = 1;

export const DEFAULT_LIMITS = {
  /** M4: stored bytes (log + snapshot + keyboxes). */
  vaultBytes: 50 * 1024 * 1024,
  appendsPerDay: 2000,
  devices: 6,
  /** Hard stop on log rows; compaction is meant to keep it far below this. */
  logRows: 1000,
  batchBytes: 256 * 1024,
  partBytes: 1024 * 1024,
  maxParts: 8,
  /** Log entries kept behind a snapshot, so a device only slightly behind does
   *  not have to download the snapshot. */
  tail: 20,
  pageEntries: 100,
  pageBytes: 1024 * 1024,
  /** Counters are written to storage every this many appends, not every one. */
  persistEvery: 20,
  /** `seen_at` is written at most this often per device, to save row writes. */
  seenEveryMs: HOUR_MS,
  /** Per-device token bucket for writes: capacity, refilled over a minute. */
  writesPerMin: 60,
  pairAttemptsPerHour: 10,
  recoverPerHour: 5,
  /** Open join slots at once, a bound on junk rather than a feature. */
  openSlots: 5,
  pairOpenMs: 10 * 60_000,
  /** An approved slot stays collectable this long (DESIGN 7). */
  collectMs: 60 * 60_000,
  /** How long a lapsed slot is still answered as "expired" before it is swept. */
  sweepAfterMs: DAY_MS,
};

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v)",
  `CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
     pubkey TEXT NOT NULL, name_ct TEXT, added_at INTEGER, seen_at INTEGER)`,
  // AUTOINCREMENT so a pruned seq is never handed out twice; `head` in meta
  // survives the log being pruned to nothing.
  `CREATE TABLE IF NOT EXISTS log(seq INTEGER PRIMARY KEY AUTOINCREMENT, bid TEXT UNIQUE NOT NULL,
     dev TEXT NOT NULL, epoch INTEGER NOT NULL, blob TEXT NOT NULL, at INTEGER NOT NULL)`,
  "CREATE TABLE IF NOT EXISTS snapshot(upto INTEGER, part INTEGER, blob TEXT NOT NULL, PRIMARY KEY(upto, part))",
  "CREATE TABLE IF NOT EXISTS keybox(dev TEXT, epoch INTEGER, blob TEXT NOT NULL, PRIMARY KEY(dev, epoch))",
  // One row per join slot. `req` and `result` are JSON text: the request the
  // joiner made and the approver's answer.
  `CREATE TABLE IF NOT EXISTS pair(join_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, owner TEXT NOT NULL,
     open_proof TEXT NOT NULL, approver_pub TEXT NOT NULL, created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL, state TEXT NOT NULL, req TEXT, result TEXT)`,
];

/**
 * @param sql          `{ exec(query, ...bindings) -> { toArray() } }`
 * @param now          () -> ms
 * @param random       (n) -> Uint8Array of n random bytes
 * @param limits       overrides of DEFAULT_LIMITS
 * @param emit         (type, payload) called for what a socket would be told:
 *                     entry, rotated, devices, pair_request, revoked. Never throws into a request.
 * @param transaction  (fn) -> fn() run atomically; the DO passes `transactionSync`
 */
export function createVault({
  sql, now = Date.now, random, limits = {}, emit = () => {}, transaction = (fn) => fn(),
}) {
  let L = { ...DEFAULT_LIMITS, ...limits };
  const q = (query, ...bind) => sql.exec(query, ...bind).toArray();
  const run = (query, ...bind) => { sql.exec(query, ...bind).toArray(); };
  const tell = (type, payload) => { try { emit(type, payload); } catch { /* a dead socket is not this request's problem */ } };

  // ----------------------------------------------------------------- state
  for (const stmt of SCHEMA) run(stmt);

  const getMeta = (k) => { const r = q("SELECT v FROM meta WHERE k = ?", k); return r.length ? r[0].v : null; };
  const setMeta = (k, v) => run("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  if (getMeta("schema") === null) setMeta("schema", SCHEMA_VERSION);

  const st = {
    epoch: getMeta("epoch") ?? 1,
    head: getMeta("head") ?? 0,
    snapshotUpto: getMeta("snapshot_upto"),
    recoverHash: getMeta("recover_hash"),
    claimedAt: getMeta("claimed_at"),
    deletedAt: getMeta("deleted_at"),
    day: getMeta("day") ?? 0,
    writes: getMeta("writes_today") ?? 0,
    bytes: 0,
    dirty: 0,
  };

  /** Stored bytes, recounted from the tables whenever something other than an
   *  append changes them. Never persisted: it is derived, so it cannot drift. */
  const recount = () => {
    const r = q(`SELECT (SELECT COALESCE(SUM(length(blob)), 0) FROM log)
      + (SELECT COALESCE(SUM(length(blob)), 0) FROM snapshot)
      + (SELECT COALESCE(SUM(length(blob)), 0) FROM keybox) AS n`);
    st.bytes = r[0].n;
  };
  recount();

  /** Today's append counter, rolled over at 00:00 UTC. */
  const rollDay = () => {
    const day = Math.floor(now() / DAY_MS);
    if (st.day !== day) { st.day = day; st.writes = 0; persistCounters(); }
    return day;
  };
  const persistCounters = () => {
    setMeta("day", st.day);
    setMeta("writes_today", st.writes);
    st.dirty = 0;
  };
  const resetAt = () => (Math.floor(now() / DAY_MS) + 1) * DAY_MS;

  // ----------------------------------------------------------- rate limits
  const buckets = new Map(); // device id -> { tokens, at }
  /** A token bucket per device: `writesPerMin` writes, refilled continuously.
   *  Held in memory, so an eviction forgives; that is fine for abuse control
   *  and is why it is not used for the quota. */
  const take = (devId) => {
    const t = now();
    const cap = L.writesPerMin;
    const b = buckets.get(devId) ?? { tokens: cap, at: t };
    b.tokens = Math.min(cap, b.tokens + ((t - b.at) * cap) / 60_000);
    b.at = t;
    if (b.tokens < 1) {
      buckets.set(devId, b);
      throw new Reject(429, "rate", { retryAfterMs: Math.ceil(((1 - b.tokens) * 60_000) / cap) });
    }
    b.tokens -= 1;
    buckets.set(devId, b);
  };

  /** Attempts inside a sliding hour, for pairing and recovery. */
  const windows = { pair: [], recover: [] };
  const attempt = (name, max) => {
    const t = now();
    const w = windows[name].filter((x) => x > t - HOUR_MS);
    if (w.length >= max) {
      windows[name] = w;
      throw new Reject(429, "rate", { retryAfterMs: w[0] + HOUR_MS - t });
    }
    w.push(t);
    windows[name] = w;
  };

  // ---------------------------------------------------------------- devices
  const allDevices = () => q("SELECT id, token_hash, pubkey, name_ct, added_at, seen_at FROM devices ORDER BY added_at, id");
  const deviceCount = () => q("SELECT COUNT(*) AS n FROM devices")[0].n;

  /** The device a token belongs to. Every registered hash is compared (there
   *  are at most six) with a compare that does not stop at the first
   *  difference, instead of an indexed lookup whose timing says which prefix
   *  matched. */
  const authed = (ctx) => {
    if (!ctx.tokenHash) throw new Reject(401, "auth");
    let found = null;
    for (const d of allDevices()) if (safeEqual(d.token_hash, ctx.tokenHash)) found = d;
    if (!found) throw new Reject(401, "auth");
    if (!found.seen_at || now() - found.seen_at >= L.seenEveryMs) {
      run("UPDATE devices SET seen_at = ? WHERE id = ?", now(), found.id);
    }
    return found;
  };

  const newDeviceId = () => [...random(8)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const addDevice = ({ id, tokenHash, pubkey, nameCt }) => {
    if (deviceCount() >= L.devices) throw new Reject(429, "vault_quota", { what: "devices", max: L.devices, resetAt: null });
    run("INSERT INTO devices(id, token_hash, pubkey, name_ct, added_at, seen_at) VALUES(?, ?, ?, ?, ?, ?)",
      id, tokenHash, JSON.stringify(pubkey), nameCt, now(), now());
  };

  // ------------------------------------------------------------------ guards
  const checkEpoch = (given) => {
    if (given !== st.epoch) throw new Reject(409, "epoch", { epoch: st.epoch, rotated: true });
  };

  const entriesAfter = (seq, max) => {
    const out = [];
    let size = 0;
    for (const r of q("SELECT seq, bid, dev, blob FROM log WHERE seq > ? ORDER BY seq LIMIT ?", seq, max)) {
      size += r.blob.length;
      // The first entry is always sent, so one big entry cannot stall a reader.
      if (out.length && size > L.pageBytes) break;
      out.push({ seq: r.seq, dev: r.dev, bid: r.bid, blob: parseStored(r.blob) });
    }
    return out;
  };

  const oldestSeq = () => {
    const r = q("SELECT MIN(seq) AS s FROM log");
    return r[0].s ?? st.head + 1;
  };

  const snapshotParts = (body, field = "parts") => {
    const parts = body?.[field];
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > L.maxParts) throw new Reject(400, "bad_request", { field });
    return parts.map((p) => opaque(p, L.partBytes, field));
  };

  const overBytes = (extra) => {
    if (st.bytes + extra > L.vaultBytes) throw new Reject(429, "vault_quota", { what: "bytes", max: L.vaultBytes, resetAt: null });
  };

  // -------------------------------------------------------------- endpoints
  const handlers = {};

  /** Initialises a vault. Only the Worker may call this (`trusted`), right after
   *  the registry minted the id; a stranger who knew a valid id still could not
   *  reach it. Repeating it with the same token hash is a no-op, which is what
   *  lets a client whose first attempt died halfway just try again. */
  handlers["POST /claim"] = (ctx) => {
    if (!ctx.trusted) throw new Reject(404, "not_found");
    const c = checkClaim(ctx.body);
    if (st.claimedAt !== null) {
      const same = allDevices().find((d) => safeEqual(d.token_hash, c.tokenHash));
      if (same && (c.deviceId === null || c.deviceId === same.id)) return reply(200, { deviceId: same.id, epoch: st.epoch });
      throw new Reject(409, "claimed");
    }
    const id = c.deviceId ?? newDeviceId();
    transaction(() => {
      addDevice({ id, tokenHash: c.tokenHash, pubkey: c.pubkey, nameCt: c.nameCt });
      setMeta("epoch", 1);
      setMeta("head", 0);
      setMeta("recover_hash", c.recoverHash);
      setMeta("claimed_at", now());
    });
    st.epoch = 1; st.head = 0; st.recoverHash = c.recoverHash; st.claimedAt = now();
    return reply(200, { deviceId: id, epoch: 1 });
  };

  /** Numbers for the registry's stats fan-out. Trusted only; never content. */
  handlers["GET /stats"] = (ctx) => {
    if (!ctx.trusted) throw new Reject(404, "not_found");
    rollDay();
    const seen = q("SELECT MAX(seen_at) AS s FROM devices")[0].s;
    return reply(200, {
      claimedAt: st.claimedAt, seenAt: seen, bytes: st.bytes, devices: deviceCount(),
      writesToday: st.writes, head: st.head, epoch: st.epoch,
    });
  };

  /** The epoch, before anyone is authenticated: a device recovering from the
   *  recovery code needs it to derive the proof, and it is not secret. */
  handlers["GET /recover"] = () => reply(200, { epoch: st.epoch });

  handlers["POST /recover"] = (ctx) => {
    attempt("recover", L.recoverPerHour);
    const b = ctx.body;
    if (!isPlainObject(b) || typeof b.recoverProof !== "string" || b.recoverProof.length > 200 || !isDigest(b.tokenHash)) {
      throw new Reject(400, "bad_request");
    }
    const pubkey = checkJwk(b.pubkey);
    const nameCt = b.nameCt == null ? null : opaque(b.nameCt, 2048, "nameCt");
    if (b.deviceId !== undefined && !isDeviceId(b.deviceId)) throw new Reject(400, "bad_request", { field: "deviceId" });
    if (!safeEqual(ctx.proofHash, st.recoverHash)) throw new Reject(401, "auth");
    const id = b.deviceId ?? newDeviceId();
    transaction(() => addDevice({ id, tokenHash: b.tokenHash, pubkey, nameCt }));
    tell("devices", {});
    return reply(200, { deviceId: id, epoch: st.epoch });
  };

  /** Who a token belongs to, for the host to authenticate a WebSocket upgrade
   *  with: a socket carries no headers, so the Durable Object turns the token it
   *  was handed into a Bearer call and keeps the device id from the answer. */
  handlers["GET /ws"] = (ctx) => {
    const dev = authed(ctx);
    return reply(200, { deviceId: dev.id, epoch: st.epoch, head: st.head });
  };

  handlers["GET /devices"] = (ctx) => {
    authed(ctx);
    return reply(200, {
      devices: allDevices().map((d) => ({
        id: d.id, pubkey: JSON.parse(d.pubkey), nameCt: parseStored(d.name_ct), addedAt: d.added_at, seenAt: d.seen_at,
      })),
    });
  };

  /** A device's name, sent once it holds the key (a joiner cannot encrypt one
   *  before that, so it is set after joining). */
  handlers["PUT /device"] = (ctx) => {
    const dev = authed(ctx);
    const nameCt = ctx.body?.nameCt == null ? null : opaque(ctx.body.nameCt, 2048, "nameCt");
    run("UPDATE devices SET name_ct = ? WHERE id = ?", nameCt, dev.id);
    tell("devices", {});
    return reply(200, {});
  };

  handlers["GET /log"] = (ctx) => {
    authed(ctx);
    const since = intOf(ctx.query.since, 0);
    const limit = intOf(ctx.query.limit, L.pageEntries);
    const epoch = intOf(ctx.query.epoch);
    if (Number.isNaN(since) || since < 0 || Number.isNaN(limit) || Number.isNaN(epoch)) throw new Reject(400, "bad_request");
    if (epoch !== null) checkEpoch(epoch);
    // A reader that fell behind the part of the log kept has to start from the
    // snapshot. With no snapshot nothing was ever pruned, so there is no gap.
    if (st.snapshotUpto !== null && since + 1 < oldestSeq()) {
      return reply(410, { code: "gone", snapshotUpto: st.snapshotUpto });
    }
    return reply(200, {
      epoch: st.epoch, head: st.head, snapshotUpto: st.snapshotUpto,
      entries: entriesAfter(since, Math.max(1, Math.min(limit, L.pageEntries))),
    });
  };

  handlers["POST /log"] = (ctx) => {
    const dev = authed(ctx);
    take(dev.id);
    const b = ctx.body;
    if (!isPlainObject(b) || !Number.isInteger(b.expect) || b.expect < 0 || !Number.isInteger(b.epoch) || !isB64u(b.bid, 8, 64)) {
      throw new Reject(400, "bad_request");
    }
    const blob = opaque(b.blob, L.batchBytes, "blob");
    // A repeated bid is a retry after a lost answer: give back what is there,
    // whatever `expect` says and whatever the quota is now.
    const seen = q("SELECT seq FROM log WHERE bid = ?", b.bid);
    if (seen.length) return reply(200, { seq: seen[0].seq });
    checkEpoch(b.epoch);
    rollDay();
    if (st.writes >= L.appendsPerDay) throw new Reject(429, "vault_quota", { what: "appends", max: L.appendsPerDay, resetAt: resetAt() });
    overBytes(blob.length);
    if (q("SELECT COUNT(*) AS n FROM log")[0].n >= L.logRows) {
      throw new Reject(429, "vault_quota", { what: "log_rows", max: L.logRows, resetAt: null });
    }
    if (b.expect !== st.head) {
      return reply(409, { code: "conflict", head: st.head, entries: entriesAfter(b.expect, L.pageEntries) });
    }
    const seq = st.head + 1;
    transaction(() => {
      run("INSERT INTO log(seq, bid, dev, epoch, blob, at) VALUES(?, ?, ?, ?, ?, ?)", seq, b.bid, dev.id, st.epoch, blob, now());
      setMeta("head", seq);
    });
    st.head = seq;
    st.bytes += blob.length;
    st.writes += 1;
    st.dirty += 1;
    if (st.dirty >= L.persistEvery) persistCounters();
    tell("entry", { seq, dev: dev.id, blob: parseStored(blob) });
    return reply(200, { seq });
  };

  handlers["GET /snapshot"] = (ctx) => {
    authed(ctx);
    const epoch = intOf(ctx.query.epoch);
    if (Number.isNaN(epoch)) throw new Reject(400, "bad_request");
    if (epoch !== null) checkEpoch(epoch);
    if (st.snapshotUpto === null) throw new Reject(404, "none");
    const parts = q("SELECT blob FROM snapshot WHERE upto = ? ORDER BY part", st.snapshotUpto);
    return reply(200, { upto: st.snapshotUpto, epoch: st.epoch, parts: parts.map((p) => parseStored(p.blob)) });
  };

  /** Compaction. The swap is conditional on `expectUpto`, so two devices that
   *  both decided to compact cannot both win: the second is told "conflict" and
   *  treats it as done. */
  handlers["PUT /snapshot"] = (ctx) => {
    const dev = authed(ctx);
    take(dev.id);
    const b = ctx.body;
    if (!isPlainObject(b) || !Number.isInteger(b.upto) || b.upto < 0 || !Number.isInteger(b.epoch)
      || !(b.expectUpto === null || Number.isInteger(b.expectUpto))) {
      throw new Reject(400, "bad_request");
    }
    const parts = snapshotParts(b);
    checkEpoch(b.epoch);
    if (b.expectUpto !== st.snapshotUpto) throw new Reject(409, "conflict", { snapshotUpto: st.snapshotUpto });
    if (b.upto > st.head || (st.snapshotUpto !== null && b.upto < st.snapshotUpto)) throw new Reject(400, "bad_request", { field: "upto" });
    const added = parts.reduce((n, p) => n + p.length, 0);
    const old = q("SELECT COALESCE(SUM(length(blob)), 0) AS n FROM snapshot")[0].n;
    // Judged on what the vault holds AFTER the swap: the old snapshot goes and
    // so do the log rows the prune below deletes. Judging before would refuse
    // exactly the compaction that frees space, and a vault near its cap could
    // never get out of it. (Like the log-rows cap, this PUT is not refused for
    // the log being full: it is the way out of that too.)
    const freed = q("SELECT COALESCE(SUM(length(blob)), 0) AS n FROM log WHERE seq <= ?", b.upto - L.tail)[0].n;
    if (st.bytes - old - freed + added > L.vaultBytes) throw new Reject(429, "vault_quota", { what: "bytes", max: L.vaultBytes, resetAt: null });
    transaction(() => {
      run("DELETE FROM snapshot");
      parts.forEach((p, i) => run("INSERT INTO snapshot(upto, part, blob) VALUES(?, ?, ?)", b.upto, i, p));
      setMeta("snapshot_upto", b.upto);
      // Keep a short tail so a device a few entries behind skips the download.
      run("DELETE FROM log WHERE seq <= ?", b.upto - L.tail);
    });
    st.snapshotUpto = b.upto;
    recount();
    return reply(200, { upto: b.upto });
  };

  handlers["GET /keybox"] = (ctx) => {
    const dev = authed(ctx);
    const r = q("SELECT blob FROM keybox WHERE dev = ? AND epoch = ?", dev.id, st.epoch);
    if (!r.length) throw new Reject(404, "none");
    return reply(200, { epoch: st.epoch, blob: parseStored(r[0].blob) });
  };

  /**
   * Key rotation, optionally removing a device (DESIGN 3.6). One transaction:
   * the removed device's token stops working at once, the epoch moves on, the
   * snapshot is replaced by the one the caller built under the new key, the whole
   * log is dropped (it was under the old key) and the keyboxes for the others
   * are stored. Pairing slots are dropped too: an approval in flight would
   * deliver the OLD key.
   */
  handlers["POST /rotate"] = (ctx) => {
    const dev = authed(ctx);
    take(dev.id);
    const b = ctx.body;
    if (!isPlainObject(b) || !Number.isInteger(b.expectEpoch) || !isDigest(b.recoverHash)
      || !isPlainObject(b.keyboxes) || !isPlainObject(b.snapshot)) {
      throw new Reject(400, "bad_request");
    }
    const parts = snapshotParts(b.snapshot);
    checkEpoch(b.expectEpoch);
    const remove = b.removeDevice ?? null;
    if (remove !== null && !isDeviceId(remove)) throw new Reject(400, "bad_request", { field: "removeDevice" });
    if (remove === dev.id) throw new Reject(400, "bad_request", { field: "removeDevice" });
    const devices = allDevices();
    if (remove !== null && !devices.some((d) => d.id === remove)) throw new Reject(404, "no_device");
    const keep = devices.filter((d) => d.id !== remove).map((d) => d.id);
    const boxes = {};
    for (const [id, blob] of Object.entries(b.keyboxes)) {
      if (!keep.includes(id) || id === dev.id) throw new Reject(400, "bad_request", { field: "keyboxes" });
      boxes[id] = opaque(blob, 4096, "keyboxes");
    }
    // Every other remaining device must get the new key, or it would be locked
    // out with a valid token and nothing to open the data with.
    for (const id of keep) if (id !== dev.id && !boxes[id]) throw new Reject(400, "bad_request", { field: "keyboxes", missing: id });
    const added = parts.reduce((n, p) => n + p.length, 0) + Object.values(boxes).reduce((n, p) => n + p.length, 0);
    if (added > L.vaultBytes) throw new Reject(429, "vault_quota", { what: "bytes", max: L.vaultBytes, resetAt: null });

    const epoch = st.epoch + 1;
    transaction(() => {
      if (remove !== null) run("DELETE FROM devices WHERE id = ?", remove);
      run("DELETE FROM pair");
      run("DELETE FROM log");
      run("DELETE FROM snapshot");
      run("DELETE FROM keybox");
      parts.forEach((p, i) => run("INSERT INTO snapshot(upto, part, blob) VALUES(?, ?, ?)", st.head, i, p));
      for (const [id, blob] of Object.entries(boxes)) run("INSERT INTO keybox(dev, epoch, blob) VALUES(?, ?, ?)", id, epoch, blob);
      setMeta("epoch", epoch);
      setMeta("snapshot_upto", st.head);
      setMeta("recover_hash", b.recoverHash);
    });
    st.epoch = epoch;
    st.snapshotUpto = st.head;
    st.recoverHash = b.recoverHash;
    recount();
    if (remove !== null) tell("revoked", { dev: remove });
    tell("rotated", { epoch });
    return reply(200, { epoch, upto: st.head });
  };

  /** Deleting the vault (DESIGN M5). The tombstone is all that is kept: it is
   *  how another device that still holds a token learns, with a 410, that the
   *  vault is gone and not merely unreachable. */
  const wipe = () => {
    transaction(() => {
      for (const t of ["devices", "log", "snapshot", "keybox", "pair"]) run(`DELETE FROM ${t}`);
      setMeta("deleted_at", now());
      setMeta("recover_hash", null);
    });
    st.deletedAt = now();
    st.recoverHash = null;
    st.snapshotUpto = null;
    recount();
    tell("deleted", {});
  };

  handlers["DELETE /"] = (ctx) => {
    authed(ctx);
    if (ctx.body?.confirm !== "delete") throw new Reject(400, "confirm_required");
    wipe();
    return reply(200, {});
  };

  /** The admin's delete (DESIGN M3): the registry asks through the Worker, and an
   *  admin holds no device token, so this is trusted-only. It also works on a
   *  vault that was never claimed (a creation that died half way) and on one
   *  already deleted, so an admin can always finish the job. */
  handlers["POST /purge"] = (ctx) => {
    if (!ctx.trusted) throw new Reject(404, "not_found");
    if (st.deletedAt === null) wipe();
    return reply(200, {});
  };

  // ---------------------------------------------------------------- pairing
  const sweepSlots = () => run("DELETE FROM pair WHERE expires_at < ?", now() - L.sweepAfterMs);
  const slotOf = (joinId) => {
    if (!isDeviceId(joinId)) return null;
    const r = q("SELECT * FROM pair WHERE join_id = ?", joinId);
    return r.length ? r[0] : null;
  };
  /** A slot that exists and has not lapsed; otherwise "gone", as the client expects. */
  const liveSlot = (joinId) => {
    const slot = slotOf(joinId);
    if (!slot || now() >= slot.expires_at) throw new Reject(410, "gone");
    return slot;
  };
  /** The joiner presents the join token, as a Bearer header or (as the fake
   *  does) a `joinToken` field. Only its hash is compared. */
  const joinerOf = (slot, ctx, { counted = false } = {}) => {
    if (!ctx.joinHash || !safeEqual(ctx.joinHash, slot.token_hash)) {
      // Wrong guesses are rationed: the token is 256 bits, but nothing else is.
      // A request was already counted when it arrived, so it is not counted twice.
      if (!counted) attempt("pair", L.pairAttemptsPerHour);
      throw new Reject(401, "auth");
    }
  };

  handlers["POST /pair/open"] = (ctx) => {
    const dev = authed(ctx);
    const b = ctx.body;
    if (!isPlainObject(b) || !isDeviceId(b.joinId) || !isDigest(b.joinTokenHash) || !isB64u(b.openProof, 8, 200)) {
      throw new Reject(400, "bad_request");
    }
    if (deviceCount() >= L.devices) throw new Reject(429, "vault_quota", { what: "devices", max: L.devices, resetAt: null });
    sweepSlots();
    if (slotOf(b.joinId)) throw new Reject(409, "conflict");
    const live = q("SELECT COUNT(*) AS n FROM pair WHERE state = 'pending' AND expires_at > ?", now())[0].n;
    if (live >= L.openSlots) throw new Reject(429, "rate", { what: "slots" });
    const expiresAt = now() + L.pairOpenMs;
    transaction(() => {
      // Starting again replaces this device's own unfinished slot, so a
      // forgotten code cannot keep a request pending against the new one.
      run("UPDATE pair SET expires_at = ? WHERE owner = ? AND state = 'pending' AND expires_at > ?", now(), dev.id, now());
      run(`INSERT INTO pair(join_id, token_hash, owner, open_proof, approver_pub, created_at, expires_at, state)
        VALUES(?, ?, ?, ?, ?, ?, ?, 'pending')`, b.joinId, b.joinTokenHash, dev.id, b.openProof, dev.pubkey, now(), expiresAt);
    });
    return reply(200, { expiresAt });
  };

  handlers["GET /pair/pending"] = (ctx) => {
    const dev = authed(ctx);
    const r = q(`SELECT join_id, req FROM pair WHERE owner = ? AND state = 'pending' AND req IS NOT NULL
      AND expires_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, dev.id, now());
    if (!r.length) return reply(200, null);
    return reply(200, { joinId: r[0].join_id, ...JSON.parse(r[0].req) });
  };

  handlers["POST /pair/request"] = (ctx) => {
    attempt("pair", L.pairAttemptsPerHour);
    const b = ctx.body;
    if (!isPlainObject(b) || !isDeviceId(b.joinId) || !isDeviceId(b.deviceId) || !isDigest(b.tokenHash)
      || !isB64u(b.proof, 8, 200)) {
      throw new Reject(400, "bad_request");
    }
    const pubkey = checkJwk(b.pubkey);
    const slot = liveSlot(b.joinId);
    joinerOf(slot, ctx, { counted: true });
    const req = JSON.stringify({ deviceId: b.deviceId, pubkey, tokenHash: b.tokenHash, proof: b.proof });
    if (slot.req) {
      // The same device repeating itself (its answer was lost) is accepted; a
      // different one is not. Proof is not compared: it is a MAC over the rest.
      const was = JSON.parse(slot.req);
      const same = was.deviceId === b.deviceId && was.tokenHash === b.tokenHash
        && was.pubkey.x === pubkey.x && was.pubkey.y === pubkey.y;
      if (!same) throw new Reject(409, "conflict");
      return reply(200, {});
    }
    if (slot.state !== "pending") throw new Reject(409, "conflict");
    // One request waiting per vault at a time, and never a device that already exists.
    const waiting = q("SELECT COUNT(*) AS n FROM pair WHERE state = 'pending' AND req IS NOT NULL AND expires_at > ?", now())[0].n;
    if (waiting >= 1) throw new Reject(409, "busy");
    if (allDevices().some((d) => d.id === b.deviceId || safeEqual(d.token_hash, b.tokenHash))) throw new Reject(409, "conflict");
    run("UPDATE pair SET req = ? WHERE join_id = ?", req, slot.join_id);
    tell("pair_request", { joinId: slot.join_id, owner: slot.owner });
    return reply(200, {});
  };

  handlers["GET /pair/status"] = (ctx) => {
    const id = ctx.query.id;
    const slot = slotOf(id);
    if (!slot) throw new Reject(410, "gone");
    joinerOf(slot, ctx);
    if (now() >= slot.expires_at) return reply(200, { state: "expired" });
    if (slot.state === "denied") return reply(200, { state: "denied" });
    const res = { state: slot.state, approverPub: JSON.parse(slot.approver_pub), openProof: slot.open_proof };
    if (slot.state === "approved") Object.assign(res, JSON.parse(slot.result));
    return reply(200, res);
  };

  handlers["POST /pair/approve"] = (ctx) => {
    const dev = authed(ctx);
    const b = ctx.body;
    if (!isPlainObject(b) || !isDeviceId(b.joinId) || !isPlainObject(b.wrapped) || !isB64u(b.ack, 8, 200)
      || !Number.isInteger(b.epoch)) {
      throw new Reject(400, "bad_request");
    }
    const wrapped = opaque(b.wrapped, 4096, "wrapped");
    const slot = slotOf(b.joinId);
    // Repeating an approval that already went through (the answer was lost) is
    // accepted even after the slot lapsed: the device exists, nothing changes.
    if (slot && slot.owner === dev.id && slot.state === "approved") return reply(200, { deviceId: JSON.parse(slot.req).deviceId });
    liveSlot(b.joinId);
    if (slot.owner !== dev.id) throw new Reject(403, "forbidden");
    if (!slot.req || slot.state !== "pending") throw new Reject(409, "conflict");
    checkEpoch(b.epoch);
    const req = JSON.parse(slot.req);
    transaction(() => {
      addDevice({ id: req.deviceId, tokenHash: req.tokenHash, pubkey: req.pubkey, nameCt: null });
      run("UPDATE pair SET state = 'approved', result = ?, expires_at = ? WHERE join_id = ?",
        JSON.stringify({ wrapped: JSON.parse(wrapped), ack: b.ack, epoch: b.epoch }), now() + L.collectMs, slot.join_id);
    });
    tell("devices", {});
    return reply(200, { deviceId: req.deviceId });
  };

  handlers["DELETE /pair"] = (ctx) => {
    const dev = authed(ctx);
    const joinId = ctx.body?.joinId;
    if (!isDeviceId(joinId)) throw new Reject(400, "bad_request");
    const slot = liveSlot(joinId);
    if (slot.owner !== dev.id) throw new Reject(403, "forbidden");
    if (slot.state === "pending") run("UPDATE pair SET state = 'denied' WHERE join_id = ?", joinId);
    return reply(200, {});
  };

  // ----------------------------------------------------------------- handle
  /**
   * @param req   `{ method, path, headers, body }`; `path` is relative to the
   *              vault (`/log?since=3`), headers any case, body already parsed.
   * @param opts  `{ trusted }`: true only for the Worker's own calls (claim,
   *              stats); never for a request that came from outside.
   * @returns     `{ status, body }`
   */
  async function handle(req, { trusted = false } = {}) {
    try {
      const { path, query } = parseTarget(req.path);
      const method = String(req.method ?? "").toUpperCase();
      const headers = normaliseHeaders(req.headers);
      const body = req.body ?? null;
      const token = bearerOf(headers);
      // Everything that needs hashing is hashed here, before the synchronous
      // part, so nothing below awaits and the CAS cannot interleave.
      const tokenHash = token ? await sha256b64u(token) : null;
      const joinToken = token ?? (typeof body?.joinToken === "string" && body.joinToken.length <= 200 ? body.joinToken : null);
      const joinHash = joinToken ? (token ? tokenHash : await sha256b64u(joinToken)) : null;
      const proofHash = typeof body?.recoverProof === "string" && body.recoverProof.length <= 200
        ? await sha256b64u(body.recoverProof) : null;
      const ctx = { method, path, query, body, tokenHash, joinHash, proofHash, trusted };

      const handler = handlers[`${method} ${path}`];
      if (!handler) return reply(404, { code: "not_found" });
      const admin = trusted && (path === "/stats" || path === "/purge");
      if (st.deletedAt !== null && !admin) return reply(410, { code: "deleted" });
      if (st.claimedAt === null && path !== "/claim" && !admin) return reply(404, { code: "unclaimed" });
      return handler(ctx);
    } catch (e) {
      if (e instanceof Reject) return reply(e.status, e.body);
      throw e;
    }
  }

  return {
    handle,
    /** Writes the in-memory counters now. A host that can see its own eviction
     *  calls this; otherwise at most `persistEvery` appends of count are lost. */
    flush() { persistCounters(); },
    setLimits(next) { L = { ...L, ...next }; },
    get limits() { return L; },
    /** For tests and the stats fan-out. */
    state: () => ({ ...st }),
  };
}
