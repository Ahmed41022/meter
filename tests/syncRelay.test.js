/**
 * The app's transport (src/sync/relay.js) against the REAL Worker, its cores and
 * SQL, in-process: no network anywhere. Two devices are made, paired and synced
 * through the code that ships; what is not real is only the Durable Object
 * runtime (tests/relayWorld.js), the same stand-in the Worker's own tests use.
 *
 * Error mappings are checked twice over: the ones the real relay produces are
 * driven through the real relay, and the ones that are hard to provoke (a daily
 * quota, a platform HTML page, a timeout) through a scripted `fetch`.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { TransportError, createEngine } from "../src/sync/engine.js";
import { createApprover, createJoiner } from "../src/sync/pairing.js";
import { createLocalVault, withVaultId } from "../src/sync/vault.js";
import { loadVault } from "../src/sync/vaultStore.js";
import { mergeState } from "../src/domain/merge.js";
import { b64uDecode, deriveKeys, seal } from "../src/sync/crypto.js";
import {
  MAX_PARTS, PART_BYTES, approverTransport, createTransport, deleteVault, failure, getInfo, getRecoverEpoch,
  joinerTransportFor, listDevices, recoverDevice, registerVault, setDeviceName, socketUrl,
} from "../src/sync/relay.js";
import { admin, world } from "./relayWorld.js";
import { RELAY_URL } from "./relayShim.js";

const ORIGIN = "https://ahmed41022.github.io/meter/";
const rec = (id, updatedAt, extra = {}) => ({ id, updatedAt, ...extra });
const ledger = (sessions = []) => ({ projects: [], sessions });
const byId = (s) => Object.fromEntries(s.sessions.map((r) => [r.id, r]));
const storage = () => {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => map.delete(k) };
};
const memoryStore = () => {
  let held = null;
  return { load: async () => (held ? structuredClone(held) : null), save: async (m) => { held = structuredClone(m); }, peek: () => held };
};
const EMPTY = { v: 1, changes: [], meta: {} };

/** `fetch` that remembers what it was asked, as the Worker received it. */
function recording(w) {
  const seen = [];
  const fetch = async (url, init = {}) => {
    seen.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    return w.fetch(url, init);
  };
  return { fetch, seen };
}

/** A vault made the way the app makes one, through the real registration. */
async function newVault(w, fetch = w.fetch, name = "Laptop") {
  const inv = await admin(w, "/invite", { method: "POST", body: { label: "Ahmed" } });
  const local = await createLocalVault({ relay: RELAY_URL, invite: inv.body.code });
  const reg = await registerVault({ fetch, vault: local, name });
  return withVaultId(local, reg.vaultId);
}

async function pairDevice(w, approverVault, fetch = w.fetch) {
  const win = { localStorage: storage() };
  const approver = createApprover({
    transport: approverTransport({ fetch, vault: approverVault }), vault: approverVault, appOrigin: ORIGIN, now: () => w.clock.t,
  });
  const joiner = createJoiner({ transportFor: joinerTransportFor(fetch), win });
  const started = await approver.start();
  expect((await joiner.start(started.code)).phase).toBe("waiting");
  const asked = await approver.poll();
  expect(asked.phase).toBe("confirm");
  expect((await joiner.poll()).digits).toBe(asked.digits);
  expect((await approver.approve()).phase).toBe("approved");
  expect((await joiner.poll()).phase).toBe("joined");
  return loadVault(win);
}

/** One device: a ledger, a store, and the engine over the real transport. */
async function device(w, vault, state = ledger(), limits = {}) {
  const d = { vault, state, store: memoryStore(), transport: await createTransport({ fetch: w.fetch, vault }) };
  d.engine = createEngine({
    transport: d.transport, store: d.store, device: vault.deviceId, now: () => w.clock.t, random: () => 0.5,
    sleep: async () => {}, limits,
  });
  d.sync = async (options) => {
    const out = await d.engine.sync(d.state, options);
    d.state = mergeState(d.state, out.state);
    return out;
  };
  d.put = (id, at, extra = {}) => {
    d.state = { ...d.state, sessions: [...d.state.sessions.filter((r) => r.id !== id), rec(id, at, extra)] };
  };
  return d;
}

const hex = (n) => {
  let s = "";
  for (let left = n; left > 0; left -= 32768) s += Buffer.from(crypto.getRandomValues(new Uint8Array(Math.min(left, 32768) / 2))).toString("hex");
  return s;
};

afterEach(() => { vi.useRealTimers(); });

// =================================================================== real relay
describe("two devices through the real relay", () => {
  it("pair, and then edits flow both ways", async () => {
    const w = world();
    const A = await newVault(w);
    const B = await pairDevice(w, A);
    expect(B.vaultId).toBe(A.vaultId);
    const a = await device(w, A, ledger([rec("s1", 1, { note: "from A" })]));
    const b = await device(w, B);
    expect((await a.sync()).status).toBe("ok");
    expect((await b.sync()).status).toBe("ok");
    expect(byId(b.state).s1).toMatchObject({ note: "from A" });

    b.put("s2", 10, { note: "from B" });
    expect(await b.sync()).toMatchObject({ status: "ok", pushed: 1 });
    expect((await a.sync()).pulled).toBe(1);
    expect(byId(a.state).s2).toMatchObject({ note: "from B" });
    expect(byId(a.state)).toEqual(byId(b.state));
  });

  it("settle a race through the 409 the relay really sends, reading what the other wrote", async () => {
    const w = world();
    const A = await newVault(w);
    const B = await pairDevice(w, A);
    const a = await device(w, A);
    const b = await device(w, B);
    await a.sync();
    await b.sync();
    // Both are caught up at head 0 and each writes; the second push loses the CAS.
    await a.transport.push({ expect: 0, bid: "bid-from-a-0001", batch: { v: 1, changes: [{ k: "sessions", r: rec("x", 1) }], meta: {} } });
    const lost = await b.transport.push({ expect: 0, bid: "bid-from-b-0001", batch: EMPTY }).catch((e) => e);
    expect(lost).toBeInstanceOf(TransportError);
    expect(lost.code).toBe("conflict");
    expect(lost.detail.head).toBe(1);
    expect(lost.detail.entries).toMatchObject([{ seq: 1, dev: A.deviceId, bid: "bid-from-a-0001", batch: { changes: [{ r: { id: "x" } }] } }]);
  });

  it("repeat a push after a lost answer and get the same seq", async () => {
    const w = world();
    const A = await newVault(w);
    const t = await createTransport({ fetch: w.fetch, vault: A });
    const first = await t.push({ expect: 0, bid: "bid-retry-00001", batch: EMPTY });
    expect(await t.push({ expect: 5, bid: "bid-retry-00001", batch: EMPTY })).toEqual(first);
  });

  it("catch a device that fell far behind up through the snapshot, not the log", async () => {
    const w = world();
    const A = await newVault(w);
    const B = await pairDevice(w, A);
    const a = await device(w, A, ledger([rec("s0", 1)]), { COMPACT_AFTER: 5 });
    const b = await device(w, B);
    await a.sync();
    await b.sync();
    for (let i = 1; i <= 30; i += 1) { a.put(`s${i}`, 10 + i); await a.sync(); }
    const out = await b.sync();
    expect(out).toMatchObject({ status: "ok", adopted: true });
    expect(byId(b.state)).toEqual(byId(a.state));
  });

  it("send a snapshot larger than one part as several, and read it back whole", async () => {
    const w = world();
    const A = await newVault(w);
    const B = await pairDevice(w, A);
    const a = await device(w, A, ledger([rec("big", 1, { blob: hex(1_300_000) })]));
    await a.sync();
    const raw = await w.fetch(`${RELAY_URL}/v1/v/${A.vaultId}/snapshot`, { headers: { authorization: `Bearer ${A.token}` } });
    expect((await raw.json()).parts.length).toBeGreaterThan(1);
    const b = await device(w, B);
    expect((await b.sync()).adopted).toBe(true);
    expect(byId(b.state).big.blob).toBe(byId(a.state).big.blob);
  });

  it("send nothing readable: the relay's records hold neither the ledger nor a key", async () => {
    const w = world();
    const { fetch, seen } = recording(w);
    const A = await newVault(w, fetch);
    const B = await pairDevice(w, A, fetch);
    const a = await device(w, A, ledger([rec("s1", 1, { client: "CLIENT-NAME-IN-THE-CLEAR" })]));
    a.transport = await createTransport({ fetch, vault: A });
    a.engine = createEngine({ transport: a.transport, store: a.store, device: A.deviceId, now: () => w.clock.t, sleep: async () => {}, limits: { COMPACT_AFTER: 1 } });
    await a.sync();
    a.put("s2", 5, { client: "CLIENT-NAME-IN-THE-CLEAR" });
    await a.sync();
    const wire = seen.map((r) => String(r.body ?? "")).join("\n");
    expect(wire).not.toContain("CLIENT-NAME-IN-THE-CLEAR");
    for (const secret of [A.K, B.K, A.token, B.token, A.privateJwk.d]) expect(wire).not.toContain(secret);
    expect(seen.some((r) => r.url.includes("/log") && r.method === "POST")).toBe(true);
  });

  it("put the right headers on every call: a Bearer token, and JSON when there is a body", async () => {
    const w = world();
    const { fetch, seen } = recording(w);
    const A = await newVault(w, fetch);
    const B = await pairDevice(w, A, fetch);
    const a = await device(w, A, ledger([rec("s1", 1)]));
    a.transport = await createTransport({ fetch, vault: A });
    await a.transport.pull(0);
    await a.transport.push({ expect: 0, bid: "bid-headers-0001", batch: EMPTY });
    await listDevices({ fetch, vault: A });
    for (const r of seen) {
      if (r.body !== undefined) expect(r.headers["content-type"]).toBe("application/json");
      const m = /\/v1\/v\/[^/]+\/(.*)$/.exec(r.url);
      // The creation call and the info call have no token; every vault call does.
      if (m) expect(r.headers.authorization, `${r.method} ${r.url}`).toMatch(/^Bearer [A-Za-z0-9_-]{16,}$/);
    }
    // The join token travels as a header on both joiner calls, never in a body or a URL.
    const joinCalls = seen.filter((r) => /\/pair\/(request|status)/.test(r.url));
    expect(joinCalls.length).toBeGreaterThanOrEqual(2);
    const joinTokens = new Set(joinCalls.map((r) => r.headers.authorization.slice(7)));
    expect(joinTokens.size).toBe(1);
    const [joinToken] = joinTokens;
    expect(joinToken).not.toBe(B.token);
    for (const r of joinCalls) { expect(r.url).not.toContain(joinToken); expect(String(r.body ?? "")).not.toContain(joinToken); }
    expect(B.vaultId).toBe(A.vaultId);
  });
});

// ============================================================ real relay errors
describe("errors the real relay produces", () => {
  it("a wrong token is auth", async () => {
    const w = world();
    const A = await newVault(w);
    const t = await createTransport({ fetch: w.fetch, vault: { ...A, token: "x".repeat(43) } });
    await expect(t.pull(0)).rejects.toMatchObject({ code: "auth" });
  });

  it("a key epoch the vault has moved past is epoch, carrying the relay's", async () => {
    const w = world();
    const A = await newVault(w);
    const t = await createTransport({ fetch: w.fetch, vault: { ...A, epoch: 2 } });
    await expect(t.pull(0)).rejects.toMatchObject({ code: "epoch", detail: { epoch: 1 } });
    await expect(t.push({ expect: 0, bid: "bid-epoch-00001", batch: EMPTY })).rejects.toMatchObject({ code: "epoch" });
  });

  it("a snapshot that does not exist reads as none", async () => {
    const w = world();
    const A = await newVault(w);
    const t = await createTransport({ fetch: w.fetch, vault: A });
    expect(await t.getSnapshot()).toBeNull();
  });

  it("writing faster than the relay allows is paused, with how long to wait", async () => {
    const w = world();
    const A = await newVault(w);
    const t = await createTransport({ fetch: w.fetch, vault: A });
    let err = null;
    for (let i = 0; i < 61 && !err; i += 1) {
      err = await t.push({ expect: i, bid: `bid-rate-${String(i).padStart(6, "0")}`, batch: EMPTY }).then(() => null, (e) => e);
    }
    expect(err).toMatchObject({ code: "paused", detail: { status: 429, code: "rate" } });
    expect(err.detail.retryAfterMs).toBeGreaterThan(0);
  });

  it("a deleted vault is deleted for the device that asks next, not gone and not auth", async () => {
    const w = world();
    const A = await newVault(w);
    const B = await pairDevice(w, A);
    const b = await device(w, B);
    await deleteVault({ fetch: w.fetch, vault: A });
    await expect(b.transport.pull(0)).rejects.toMatchObject({ code: "deleted" });
    expect(await b.sync()).toMatchObject({ status: "deleted", retryAt: Infinity });
    const stats = await admin(w, "/stats");
    expect(stats.body.perVault[0].status).toBe("deleted");
  });

  it("registering: a repeat is the same vault; a spent, bad or missing invite says which", async () => {
    const w = world();
    const inv = await admin(w, "/invite", { method: "POST", body: {} });
    const local = await createLocalVault({ relay: RELAY_URL, invite: inv.body.code });
    const first = await registerVault({ fetch: w.fetch, vault: local });
    expect(await registerVault({ fetch: w.fetch, vault: local })).toEqual(first);

    const other = await createLocalVault({ relay: RELAY_URL, invite: inv.body.code });
    await expect(registerVault({ fetch: w.fetch, vault: other })).rejects.toMatchObject({ code: "conflict", detail: { code: "invite_used" } });
    const forged = await createLocalVault({ relay: RELAY_URL, invite: "MTR-AAAAAAAAAAAAAAAAAAAA" });
    await expect(registerVault({ fetch: w.fetch, vault: forged })).rejects.toMatchObject({ code: "auth", detail: { code: "invite_invalid" } });
    const none = await createLocalVault({ relay: RELAY_URL });
    await expect(registerVault({ fetch: w.fetch, vault: none })).rejects.toMatchObject({ code: "auth", detail: { code: "invite_required" } });
  });

  it("a full relay is quota, not a refusal of the person", async () => {
    const w = world();
    await admin(w, "/config", { method: "POST", body: { maxVaults: 1 } });
    await newVault(w);
    const inv = await admin(w, "/invite", { method: "POST", body: {} });
    const local = await createLocalVault({ relay: RELAY_URL, invite: inv.body.code });
    await expect(registerVault({ fetch: w.fetch, vault: local })).rejects.toMatchObject({ code: "quota", detail: { what: "relay_full" } });
  });

  it("info says whether an invite is needed", async () => {
    const w = world();
    expect(await getInfo({ fetch: w.fetch, relay: RELAY_URL })).toEqual({ v: 1, open: false });
  });
});

// ===================================================== names, recover, presence
describe("devices, names, recovery and presence", () => {
  it("names are sealed, shown unsealed, and a joiner names itself after joining", async () => {
    const w = world();
    const { fetch, seen } = recording(w);
    const A = await newVault(w, fetch, "Laptop");
    const B = await pairDevice(w, A, fetch);
    let list = await listDevices({ fetch, vault: A });
    expect(list.map((d) => d.name).sort((x, y) => String(x).localeCompare(String(y)))).toEqual(["Laptop", null]);
    await setDeviceName({ fetch, vault: B, name: "Phone" });
    list = await listDevices({ fetch, vault: A });
    expect(list.find((d) => d.id === B.deviceId).name).toBe("Phone");
    expect(seen.map((r) => String(r.body ?? "")).join("\n")).not.toContain("Phone");
  });

  it("a name sealed for one device does not open as another's", async () => {
    const w = world();
    const A = await newVault(w, w.fetch, "Laptop");
    const B = await pairDevice(w, A);
    await setDeviceName({ fetch: w.fetch, vault: B, name: "Phone" });
    // The relay could swap the two sealed names; each is bound to its device id.
    const raw = await (await w.fetch(`${RELAY_URL}/v1/v/${A.vaultId}/devices`, { headers: { authorization: `Bearer ${A.token}` } })).json();
    const [x, y] = raw.devices;
    const swapped = vi.fn(async () => new Response(JSON.stringify({ devices: [{ ...x, nameCt: y.nameCt }, { ...y, nameCt: x.nameCt }] }), { status: 200 }));
    const list = await listDevices({ fetch: swapped, vault: A });
    expect(list.map((d) => d.name)).toEqual([null, null]);
  });

  it("a device with only the recovery code gets back in, and the wrong code does not", async () => {
    const w = world();
    const A = await newVault(w);
    const a = await device(w, A, ledger([rec("s1", 1)]));
    await a.sync();
    const epoch = await getRecoverEpoch({ fetch: w.fetch, relay: RELAY_URL, vaultId: A.vaultId });
    const fresh = await createLocalVault({ relay: RELAY_URL });
    const back = { ...fresh, vaultId: A.vaultId, K: A.K, epoch };
    const got = await recoverDevice({ fetch: w.fetch, vault: back, name: "New laptop" });
    expect(got).toEqual({ deviceId: back.deviceId, epoch: 1 });
    const d = await device(w, back);
    expect((await d.sync()).status).toBe("ok");
    expect(byId(d.state)).toHaveProperty("s1");

    const wrong = await createLocalVault({ relay: RELAY_URL });
    await expect(recoverDevice({ fetch: w.fetch, vault: { ...wrong, vaultId: A.vaultId, epoch } })).rejects.toMatchObject({ code: "auth" });
  });

  it("presence opens only for the device it came from", async () => {
    const w = world();
    const A = await newVault(w);
    const B = await pairDevice(w, A);
    const ta = await createTransport({ fetch: w.fetch, vault: A });
    const tb = await createTransport({ fetch: w.fetch, vault: B });
    const blob = await ta.sealPresence({ sessionId: "s1", tick: 123 });
    expect(await tb.openPresence({ dev: A.deviceId, blob })).toEqual({ sessionId: "s1", tick: 123 });
    await expect(tb.openPresence({ dev: B.deviceId, blob })).rejects.toMatchObject({ code: "protocol" });
  });

  it("an entry opens only under its own bid, so it cannot be moved to another's place", async () => {
    const w = world();
    const A = await newVault(w);
    const t = await createTransport({ fetch: w.fetch, vault: A });
    await t.push({ expect: 0, bid: "bid-binding-0001", batch: EMPTY });
    const raw = await (await w.fetch(`${RELAY_URL}/v1/v/${A.vaultId}/log?since=0`, { headers: { authorization: `Bearer ${A.token}` } })).json();
    const entry = raw.entries[0];
    expect(await t.openEntry(entry)).toEqual(EMPTY);
    await expect(t.openEntry({ bid: "bid-binding-0002", blob: entry.blob })).rejects.toMatchObject({ code: "protocol" });
  });

  it("turns the relay's address into the socket's", () => {
    expect(socketUrl({ relay: "https://r.example.workers.dev", vaultId: "ID" })).toBe("wss://r.example.workers.dev/v1/v/ID/ws");
    expect(socketUrl({ relay: "http://127.0.0.1:8787", vaultId: "ID" })).toBe("ws://127.0.0.1:8787/v1/v/ID/ws");
  });
});

// ================================================================ scripted fetch
const forgedVault = async () => {
  const local = await createLocalVault({ relay: RELAY_URL });
  return withVaultId(local, `${"a".repeat(32)}.${"b".repeat(16)}`);
};
const answering = (status, body, headers = {}) => async () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

describe("every status becomes the engine's vocabulary", () => {
  const pullWith = async (fetch) => {
    const t = await createTransport({ fetch, vault: await forgedVault() });
    return t.pull(0).then(() => null, (e) => e);
  };

  const table = [
    ["409 epoch", [409, { code: "epoch", epoch: 4 }], "epoch", { epoch: 4 }],
    ["410 gone", [410, { code: "gone", snapshotUpto: 9 }], "gone", { snapshotUpto: 9 }],
    ["410 deleted", [410, { code: "deleted" }], "deleted", {}],
    ["410 vault_deleted (registry)", [410, { code: "vault_deleted" }], "deleted", {}],
    ["401", [401, { code: "auth" }], "auth", { status: 401 }],
    ["403", [403, { code: "invite_expired" }], "auth", { code: "invite_expired" }],
    ["429 vault_quota", [429, { code: "vault_quota", what: "appends", max: 2000, resetAt: 86_400_000 }], "quota", { what: "appends", resetAt: 86_400_000 }],
    ["429 vault_quota, no reset", [429, { code: "vault_quota", what: "bytes", resetAt: null }], "quota", { what: "bytes", resetAt: undefined }],
    ["429 vault_quota, log rows", [429, { code: "vault_quota", what: "log_rows" }], "quota", { what: "log_rows" }],
    ["429 creation_limit", [429, { code: "creation_limit", resetAt: 5 }], "quota", { what: "creation", resetAt: 5 }],
    ["403 relay_full", [403, { code: "relay_full" }], "quota", { what: "relay_full" }],
    ["429 rate, Retry-After header", [429, { code: "rate" }, { "retry-after": "7" }], "paused", { retryAfterMs: 7000 }],
    ["429 rate, body", [429, { code: "rate", retryAfterMs: 1500 }], "paused", { retryAfterMs: 1500 }],
    ["429 rate, nothing said", [429, { code: "rate" }], "paused", { retryAfterMs: undefined }],
    ["500", [500, { code: "internal" }], "paused", { status: 500 }],
    ["503, Retry-After", [503, { code: "overloaded" }, { "retry-after": "30" }], "paused", { retryAfterMs: 30_000 }],
    ["502 with a platform HTML page", [502, "<html>Bad gateway</html>"], "paused", {}],
    ["404", [404, { code: "not_found" }], "protocol", { status: 404 }],
    ["400", [400, { code: "bad_request" }], "protocol", { status: 400 }],
    ["200 that is not JSON", [200, "<html>captive portal</html>"], "protocol", {}],
  ];
  for (const [name, [status, body, headers], code, detail] of table) {
    it(`${name} -> ${code}`, async () => {
      const err = await pullWith(answering(status, body, headers));
      expect(err).toBeInstanceOf(TransportError);
      expect(err.code).toBe(code);
      expect(err.detail).toMatchObject(detail);
    });
  }

  it("a failure to reach the relay at all is network", async () => {
    const err = await pullWith(async () => { throw new TypeError("fetch failed"); });
    expect(err).toMatchObject({ code: "network" });
  });

  it("a request that never answers is cut off and is network, not a hung round", async () => {
    const hang = (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const t = await createTransport({ fetch: hang, vault: await forgedVault() });
    vi.useFakeTimers();
    const pending = t.pull(0).then(() => null, (e) => e);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await pending).toMatchObject({ code: "network" });
  });

  it("a conflict whose answer is not a conflict is not mistaken for one", async () => {
    const t = await createTransport({ fetch: answering(409, { code: "epoch", epoch: 2 }), vault: await forgedVault() });
    await expect(t.push({ expect: 0, bid: "bid-mistaken-001", batch: EMPTY })).rejects.toMatchObject({ code: "epoch" });
  });

  it("a ledger too big for eight parts is refused before anything is sent", async () => {
    const fetch = vi.fn();
    const t = await createTransport({ fetch, vault: await forgedVault() });
    // Random text does not compress much: about 4.9 MB of it stays over eight parts.
    const noise = Array.from({ length: 100 }, () => Buffer.from(crypto.getRandomValues(new Uint8Array(49_152))).toString("base64")).join("");
    const big = ledger([rec("big", 1, { noise })]);
    await expect(t.putSnapshot({ expectUpto: null, upto: 0, state: big })).rejects.toMatchObject({ code: "quota", detail: { what: "snapshot_size" } });
    expect(fetch).not.toHaveBeenCalled();
  }, 30_000);

  it("cuts snapshot parts so a sealed one fits the relay's 1 MiB cap, and eight of them stay in the request cap", async () => {
    const { K } = await forgedVault();
    const { encKey } = await deriveKeys(b64uDecode(K), 1);
    const part = await seal(encKey, { epoch: 1, kind: "snap", ctx: [0, 0, 1] }, new Uint8Array(PART_BYTES));
    expect(JSON.stringify(part).length).toBeLessThan(1024 * 1024);
    expect(MAX_PARTS * JSON.stringify(part).length).toBeLessThan(8 * 1024 * 1024 + 256 * 1024);
    // One byte more pads to the next power of two and would not fit.
    const over = await seal(encKey, { epoch: 1, kind: "snap", ctx: [0, 0, 1] }, new Uint8Array(PART_BYTES + 1));
    expect(JSON.stringify(over).length).toBeGreaterThan(1024 * 1024);
  });

  it("a quota failure from the relay passes `what` and `resetAt` through the engine's own rules", () => {
    const e = failure({ status: 429, headers: new Headers() }, { code: "vault_quota", what: "appends", resetAt: 7 });
    expect(e).toMatchObject({ code: "quota", detail: { what: "appends", resetAt: 7 } });
  });
});
