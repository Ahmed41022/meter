/**
 * The Worker and its two Durable Object classes (relay/worker.js), run in Node
 * against fake bindings.
 *
 * What is real: worker.js itself, the vault and registry cores, SQL (node:sqlite
 * through relaySql.js) and the client code (engine, pairing) on the other end of
 * `fetch`. What is a stand-in: the Durable Object runtime. Each fake stub owns a
 * database and one live instance of the class, which a test can drop (`evict`)
 * to imitate hibernation, and a `ctx` with the few members the code uses. A
 * test can therefore prove what the Worker does, and how the classes behave
 * given the runtime's documented contract. It cannot prove the contract itself;
 * SMOKE.md lists what only `wrangler dev` can.
 */
import { describe, it, expect, vi } from "vitest";
import worker_, { RegistryDO, VaultDO } from "../relay/worker.js";
import { LIMITS_TTL_MS, WS_PROTOCOL, tokenFromProtocols } from "../relay/worker.js";
import { admin, read, request, world } from "./relayWorld.js";
import { mintVaultId } from "../relay/ids.js";
import { createEngine } from "../src/sync/engine.js";
import { createApprover, createJoiner } from "../src/sync/pairing.js";
import { createLocalVault, withVaultId } from "../src/sync/vault.js";
import { loadVault } from "../src/sync/vaultStore.js";
import { mergeState } from "../src/domain/merge.js";
import {
  RELAY_URL, ROUTE_KEY, httpApproverTransport, httpEngineTransport, httpJoinerTransportFor, registerVault,
} from "./relayShim.js";

const MIN = 60_000;
const DIGEST = "d".repeat(43);

const forgedId = async () => mintVaultId(ROUTE_KEY, (n) => crypto.getRandomValues(new Uint8Array(n)));

// ------------------------------------------------------------- client pieces
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
  return { load: async () => (held ? structuredClone(held) : null), save: async (m) => { held = structuredClone(m); } };
};

/** A vault made the way the app makes one: an invite, a local identity, the registration. */
async function newVault(w) {
  const inv = await admin(w, "/invite", { method: "POST", body: { label: "Ahmed" } });
  expect(inv.status).toBe(200);
  const local = await createLocalVault({ relay: RELAY_URL, invite: inv.body.code });
  const reg = await registerVault({ fetch: w.fetch, vault: local, invite: local.invite });
  expect(reg.status).toBe(200);
  return { A: withVaultId(local, reg.body.vaultId), local, invite: inv.body.code };
}

async function pairDevice(w, approverVault) {
  const win = { localStorage: storage() };
  const approver = createApprover({
    transport: httpApproverTransport({ fetch: w.fetch, vault: approverVault }),
    vault: approverVault, appOrigin: ORIGIN, now: () => w.clock.t,
  });
  const joiner = createJoiner({ transportFor: httpJoinerTransportFor(w.fetch), win });
  const started = await approver.start();
  expect((await joiner.start(started.code)).phase).toBe("waiting");
  const asked = await approver.poll();
  expect(asked.phase).toBe("confirm");
  expect((await joiner.poll()).digits).toBe(asked.digits);
  expect((await approver.approve()).phase).toBe("approved");
  expect((await joiner.poll()).phase).toBe("joined");
  return loadVault(win);
}

const connect = (w, vault, { protocols, headers = {} } = {}) =>
  w.fetch(`${RELAY_URL}/v1/v/${vault.vaultId}/ws`, {
    headers: { upgrade: "websocket", "sec-websocket-protocol": protocols ?? `${WS_PROTOCOL}, ${vault.token}`, ...headers },
  });

/** A connected socket: the server end the object holds, whose `sent` is what the client receives. */
async function openSocket(w, vault) {
  const res = await connect(w, vault);
  expect(res.status).toBe(101);
  return res.webSocket.peer;
}

const rawLog = (w, vault, expect_, bid, blob = "blob-ciphertext") =>
  request(w, `/v1/v/${vault.vaultId}/log`, { method: "POST", token: vault.token, body: { epoch: 1, expect: expect_, bid, blob } });

// ======================================================================= tests
describe("module", () => {
  it("is importable outside workerd and exports what wrangler.toml names", () => {
    expect(typeof worker_.fetch).toBe("function");
    expect(typeof VaultDO).toBe("function");
    expect(typeof RegistryDO).toBe("function");
  });

  it("reads the token from the sub-protocol list, and only in the exact shape", () => {
    const tok = "t".repeat(43);
    expect(tokenFromProtocols(`meter.v1, ${tok}`)).toBe(tok);
    expect(tokenFromProtocols(`${tok},meter.v1`)).toBe(tok);
    expect(tokenFromProtocols(tok)).toBeNull();
    expect(tokenFromProtocols("meter.v1")).toBeNull();
    expect(tokenFromProtocols(`meter.v1, ${tok}, extra`)).toBeNull();
    expect(tokenFromProtocols("meter.v1, short")).toBeNull();
    expect(tokenFromProtocols(null)).toBeNull();
  });
});

describe("CORS", () => {
  it("answers a preflight itself, for any path, and never touches a Durable Object", async () => {
    const w = world();
    const id = await forgedId();
    for (const path of ["/v1/vaults", "/v1/info", `/v1/v/${id}/log`, "/v1/v/not-even-an-id/ws", "/v1/admin/stats", "/"]) {
      const res = await request(w, path, { method: "OPTIONS", headers: { origin: "https://ahmed41022.github.io", "access-control-request-method": "POST" } });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
      expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
    }
    expect(w.touched()).toEqual([]);
  });

  it("puts the headers on real answers and errors too, and never lets a response be cached", async () => {
    const w = world();
    for (const path of ["/v1/info", "/v1/nope"]) {
      const res = await request(w, path, { headers: { origin: "http://127.0.0.1:47823" } });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("what is stopped before any Durable Object", () => {
  it("answers 404 for a forged vault id and creates nothing", async () => {
    const w = world();
    const good = await forgedId();
    const [rand] = good.split(".");
    const other = await mintVaultId("a-different-route-key-0123456789", (n) => crypto.getRandomValues(new Uint8Array(n)));
    for (const id of [`${rand}.${"0".repeat(16)}`, other, "x".repeat(49), rand, "../admin", `${rand}.${"0".repeat(16)}%2Fx`]) {
      for (const [method, path] of [["GET", "/log"], ["GET", "/devices"], ["POST", "/log"], ["GET", "/ws"], ["POST", "/pair/request"]]) {
        const res = await request(w, `/v1/v/${id}${path}`, { method, token: "t".repeat(43), body: method === "POST" ? {} : undefined });
        expect(res.status).toBe(404);
      }
    }
    expect(w.touched()).toEqual([]);
    expect(w.env.VAULT.entries.size).toBe(0);
  });

  it("answers 404 and 405 from its own allowlist, so a made-up path or method costs nothing", async () => {
    const w = world();
    const id = await forgedId(); // a valid id: only the allowlist stands in the way
    const tok = "t".repeat(43);
    for (const path of ["/v1/v/" + id + "/nothing", "/v1/v/" + id + "/log/extra", "/v1/nope", "/v1", "/", "/v1/admin/unknown", "/v1/vaults/x"]) {
      expect((await request(w, path, { token: tok })).status).toBe(404);
    }
    const wrong = await request(w, `/v1/v/${id}/devices`, { method: "POST", token: tok, body: {} });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");
    expect((await request(w, "/v1/info", { method: "POST", body: {} })).status).toBe(405);
    // The core's trusted-only calls are not a door: not even with a valid id.
    for (const [method, path] of [["POST", "/claim"], ["GET", "/stats"], ["POST", "/purge"]]) {
      expect((await request(w, `/v1/v/${id}${path}`, { method, token: tok, body: method === "POST" ? {} : undefined })).status).toBe(404);
    }
    expect(w.touched()).toEqual([]);
  });

  it("checks the Authorization header's shape on every route that needs it", async () => {
    const w = world();
    const id = await forgedId();
    const base = `/v1/v/${id}`;
    expect((await request(w, `${base}/devices`)).status).toBe(401);
    for (const bad of ["Bearer short", "Basic dXNlcjpwYXNz", `Bearer ${"t".repeat(300)}`, `Bearer ${"t".repeat(20)} extra`, "t".repeat(43), `Bearer ${"t".repeat(20)}!`]) {
      const res = await request(w, `${base}/devices`, { headers: { authorization: bad } });
      expect(res.status, bad).toBe(401);
    }
    // A route that takes the token in either place accepts none, but not a malformed one.
    expect((await request(w, `${base}/pair/status?id=1`, { headers: { authorization: "Bearer x" } })).status).toBe(401);
    expect((await request(w, "/v1/admin/stats")).status).toBe(401);
    expect(w.touched()).toEqual([]);
  });

  it("enforces body size, content type and JSON before an object is woken", async () => {
    const w = world();
    const id = await forgedId();
    const tok = "t".repeat(43);
    const log = `/v1/v/${id}/log`;
    // Declared too big.
    const declared = await request(w, log, { method: "POST", token: tok, body: {}, headers: { "content-length": String(400 * 1024) } });
    expect(declared.status).toBe(413);
    // Not declared (chunked): counted as it arrives, and the read stops.
    let pulled = 0;
    const stream = new ReadableStream({
      pull(c) { pulled += 1; c.enqueue(new Uint8Array(100 * 1024).fill(97)); if (pulled > 50) c.close(); },
    });
    const chunked = await w.fetch(`${RELAY_URL}${log}`, {
      method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: stream, duplex: "half",
    });
    expect(chunked.status).toBe(413);
    expect(pulled).toBeLessThan(10);
    // Vault creation is capped far lower than a snapshot.
    expect((await request(w, "/v1/vaults", { method: "POST", body: { pad: "x".repeat(9 * 1024) } })).status).toBe(413);
    const snap = await request(w, `/v1/v/${id}/snapshot`, { method: "PUT", token: tok, body: {}, headers: { "content-length": String(9 * 1024 * 1024) } });
    expect(snap.status).toBe(413);
    // Content type.
    const plain = await w.fetch(`${RELAY_URL}${log}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "text/plain" }, body: "{}" });
    expect(plain.status).toBe(415);
    const none = await w.fetch(`${RELAY_URL}${log}`, { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: new Uint8Array([123, 125]) });
    expect(none.status).toBe(415);
    const ok = await w.fetch(`${RELAY_URL}${log}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json; charset=utf-8" }, body: "{not json" });
    expect(ok.status).toBe(400);
    expect((await read(ok)).body.code).toBe("bad_json");
    expect(w.touched()).toEqual([]);
  });

  it("answers 500 without touching an object when the deployment has no usable ROUTE_KEY", async () => {
    const w = world({ ROUTE_KEY: "short" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(w, `/v1/v/${"a".repeat(32)}.${"b".repeat(16)}/devices`, { token: "t".repeat(43) });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(w.touched()).toEqual([]);
  });
});

describe("creating a vault", () => {
  it("makes the id in the registry, initialises the vault, and answers a retry with the same vault", async () => {
    const w = world();
    const { A, local, invite } = await newVault(w);
    expect(A.vaultId).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{16}$/);
    const again = await registerVault({ fetch: w.fetch, vault: local, invite });
    expect(again).toEqual({ status: 200, body: { vaultId: A.vaultId } });
    expect(w.env.VAULT.entries.size).toBe(1);
    const devices = await read(await request(w, `/v1/v/${A.vaultId}/devices`, { token: A.token }));
    expect(devices.body.devices.map((d) => d.id)).toEqual([A.deviceId]);
  });

  it("lets a second person's attempt with a spent invite fail without creating a vault", async () => {
    const w = world();
    const { invite } = await newVault(w);
    const other = await createLocalVault({ relay: RELAY_URL, invite });
    const res = await registerVault({ fetch: w.fetch, vault: other, invite });
    expect(res).toMatchObject({ status: 409, body: { code: "invite_used" } });
    expect(w.env.VAULT.entries.size).toBe(1);
  });

  it("refuses without an invite while closed, and passes the caller's address to the registry", async () => {
    const w = world();
    const bare = await createLocalVault({ relay: RELAY_URL });
    expect((await registerVault({ fetch: w.fetch, vault: bare })).body.code).toBe("invite_required");
    await admin(w, "/config", { method: "POST", body: { openSignup: true, ipDailyCap: 1 } });

    const post = async (vault, ip) => {
      const { publicJwkOf } = await import("../src/sync/vault.js");
      const { tokenHash } = await import("../src/sync/crypto.js");
      const { recoverHashOf } = await import("./relayShim.js");
      return read(await request(w, "/v1/vaults", {
        method: "POST", ip,
        body: { tokenHash: await tokenHash(vault.token), pubkey: publicJwkOf(vault), nameCt: null, recoverHash: await recoverHashOf(vault), deviceId: vault.deviceId },
      }));
    };
    const a = await createLocalVault({ relay: RELAY_URL });
    const b = await createLocalVault({ relay: RELAY_URL });
    expect((await post(a, "203.0.113.7")).status).toBe(200);
    expect((await post(b, "203.0.113.7")).body.code).toBe("creation_limit");
    expect((await post(b, "203.0.113.8")).status).toBe(200);
    expect(w.registryCalls("/vaults").map((c) => c.ip)).toEqual([undefined, "203.0.113.7", "203.0.113.7", "203.0.113.8"]);
  });
});

describe("admin", () => {
  it("is routed to the registry with its own secret and nothing else", async () => {
    const w = world();
    expect((await admin(w, "/invites", { token: "wrong-token-0123456789" })).status).toBe(401);
    const inv = await admin(w, "/invite", { method: "POST", body: { label: "Sara", days: 3 } });
    expect(inv).toMatchObject({ status: 200, body: { label: "Sara" } });
    expect(inv.body.code).toMatch(/^MTR-[0-9A-Z]{20}$/);
    const list = await admin(w, "/invites");
    expect(list.body.invites).toHaveLength(1);
    expect(list.body.invites[0]).toMatchObject({ label: "Sara", status: "active" });
    expect((await admin(w, "/revoke-invite", { method: "POST", body: { id: inv.body.id } })).status).toBe(200);
    expect((await admin(w, "/invites")).body.invites[0].status).toBe("revoked");
    const set = await admin(w, "/config", { method: "POST", body: { maxVaults: 3 } });
    expect(set.body.maxVaults).toBe(3);
    expect((await admin(w, "/config")).body.maxVaults).toBe(3);
    expect(w.env.VAULT.gets).toEqual([]);
  });

  it("is switched off, not open, on a deployment without an ADMIN_TOKEN", async () => {
    const w = world({ ADMIN_TOKEN: undefined });
    expect((await admin(w, "/invites")).status).toBe(503);
  });

  it("gathers stats by asking each vault, and deletes a vault by emptying it first", async () => {
    const w = world();
    const { A } = await newVault(w);
    await rawLog(w, A, 0, "bid-000000001");
    const stats = await admin(w, "/stats");
    expect(stats.body.vaults).toMatchObject({ count: 1 });
    expect(stats.body.perVault[0]).toMatchObject({ id: A.vaultId, status: "active", devices: 1, head: 1 });
    expect(stats.body.perVault[0].bytes).toBeGreaterThan(0);
    // Never content.
    expect(JSON.stringify(stats.body)).not.toContain("ciphertext");

    const del = await admin(w, "/delete-vault", { method: "POST", body: { vaultId: A.vaultId } });
    expect(del.status).toBe(200);
    expect((await request(w, `/v1/v/${A.vaultId}/devices`, { token: A.token })).status).toBe(410);
    const after = await admin(w, "/stats");
    expect(after.body.vaults.count).toBe(0);
    expect(after.body.perVault[0].status).toBe("deleted");
    // An admin's purge is the registry's own call: the vault does not report it back.
    expect(w.registryCalls("/vault-deleted")).toEqual([]);
  });
});

describe("a client through the Worker", () => {
  it("syncs two devices with the real engine, pairing and encryption", async () => {
    const w = world();
    const { A } = await newVault(w);
    const device = async (vault, state) => {
      const d = {
        state,
        engine: createEngine({
          transport: await httpEngineTransport({ fetch: w.fetch, vault }), store: memoryStore(), device: vault.deviceId,
          now: () => w.clock.t, random: () => 0.5, sleep: async () => {},
        }),
      };
      d.sync = async () => { const out = await d.engine.sync(d.state, { force: true }); d.state = mergeState(d.state, out.state); return out; };
      return d;
    };
    const a = await device(A, ledger([rec("s1", 5), rec("s2", 6)]));
    expect((await a.sync()).status).toBe("ok");

    const B = await pairDevice(w, A);
    const b = await device(B, ledger());
    expect(await b.sync()).toMatchObject({ status: "ok", adopted: true });
    expect(byId(b.state)).toEqual(byId(a.state));

    b.state = { ...b.state, sessions: [...b.state.sessions, rec("s3", 9)] };
    expect((await b.sync()).status).toBe("ok");
    expect((await a.sync()).status).toBe("ok");
    expect(Object.keys(byId(a.state)).sort()).toEqual(["s1", "s2", "s3"]);
    // One vault, one registry, and nothing else was ever created.
    expect([...w.env.VAULT.entries.keys()]).toEqual([`v:${A.vaultId}`]);
    expect(w.env.REGISTRY.entries.size).toBe(1);
  });
});

describe("WebSocket", () => {
  it("accepts an upgrade authenticated by the sub-protocol token, keeps the device in the attachment and echoes meter.v1", async () => {
    const w = world();
    const { A } = await newVault(w);
    const res = await connect(w, A);
    expect(res.status).toBe(101);
    expect(res.headers.get("sec-websocket-protocol")).toBe(WS_PROTOCOL);
    const server = res.webSocket.peer;
    expect(server.deserializeAttachment()).toEqual({ dev: A.deviceId });
    const entry = await w.env.VAULT.entry(w.vaultName(A));
    expect(entry.ctx.getWebSockets()).toEqual([server]);
    // Ping and pong are answered by the runtime, set up so the object never wakes for them.
    expect(entry.ctx.auto).toEqual({ request: "ping", response: "pong" });
  });

  it("refuses a bad or missing token, a missing sub-protocol and a plain GET, and accepts no socket", async () => {
    const w = world();
    const { A } = await newVault(w);
    const entry = await w.env.VAULT.entry(w.vaultName(A));
    const before = w.touched().length;

    expect((await connect(w, A, { protocols: `${WS_PROTOCOL}, ${"z".repeat(43)}` })).status).toBe(401); // well formed, wrong
    expect(w.touched().length).toBeGreaterThan(before);
    const marker = w.touched().length;
    expect((await connect(w, A, { protocols: WS_PROTOCOL })).status).toBe(401); // no token at all
    expect((await connect(w, A, { protocols: A.token })).status).toBe(401); // token without meter.v1
    expect((await connect(w, A, { protocols: `${WS_PROTOCOL}, short` })).status).toBe(401);
    expect((await w.fetch(`${RELAY_URL}/v1/v/${A.vaultId}/ws`, { headers: { authorization: `Bearer ${A.token}` } })).status).toBe(426);
    expect(w.touched().length).toBe(marker); // those five never reached an object
    expect(entry.ctx.sockets).toHaveLength(0);
    // Forged id: the upgrade dies at the door too.
    const id = `${(await forgedId()).split(".")[0]}.${"0".repeat(16)}`;
    expect((await w.fetch(`${RELAY_URL}/v1/v/${id}/ws`, { headers: { upgrade: "websocket", "sec-websocket-protocol": `${WS_PROTOCOL}, ${A.token}` } })).status).toBe(404);
    expect(w.touched().length).toBe(marker);
  });

  it("keeps one socket per device: a reconnect replaces the old one", async () => {
    const w = world();
    const { A } = await newVault(w);
    const first = await openSocket(w, A);
    const second = await openSocket(w, A);
    expect(first.closed).toEqual({ code: 4000, reason: "replaced" });
    expect(second.closed).toBeNull();
  });

  it("fans presence out to the vault's other sockets, never back to the sender, and stores nothing", async () => {
    const w = world();
    const { A } = await newVault(w);
    const B = await pairDevice(w, A);
    const sa = await openSocket(w, A);
    const sb = await openSocket(w, B);
    const name = w.vaultName(A);
    const entry = await w.env.VAULT.entry(name);
    const changes = () => entry.db.db.prepare("SELECT total_changes() AS n").get().n;
    const rows = () => Object.fromEntries(["devices", "log", "snapshot", "keybox", "pair", "meta", "host"].map((t) => [t, entry.db.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
    const written = changes();
    const tables = rows();

    await w.env.VAULT.socketMessage(name, sa, JSON.stringify({ t: "presence", blob: "sealed-presence" }));
    expect(sb.messages).toEqual([{ t: "presence", dev: A.deviceId, blob: "sealed-presence" }]);
    expect(sa.messages).toEqual([]);
    expect(changes()).toBe(written);
    expect(rows()).toEqual(tables);

    // Everything that is not a small presence message is dropped without a reply.
    sb.sent.length = 0;
    for (const junk of ["not json", JSON.stringify({ t: "entry", seq: 1 }), JSON.stringify({ t: "presence" }), JSON.stringify({ t: "presence", blob: "x".repeat(5000) }), new ArrayBuffer(8), JSON.stringify([1])]) {
      await w.env.VAULT.socketMessage(name, sa, junk);
    }
    expect(sb.sent).toEqual([]);
    expect(changes()).toBe(written);
  });

  it("rations presence per device, so one client cannot turn into a firehose", async () => {
    const w = world();
    const { A } = await newVault(w);
    const B = await pairDevice(w, A);
    const sa = await openSocket(w, A);
    const sb = await openSocket(w, B);
    for (let i = 0; i < 30; i += 1) await w.env.VAULT.socketMessage(w.vaultName(A), sa, JSON.stringify({ t: "presence", blob: `p${i}` }));
    expect(sb.sent).toHaveLength(20);
    w.clock.t += 61_000;
    await w.env.VAULT.socketMessage(w.vaultName(A), sa, JSON.stringify({ t: "presence", blob: "later" }));
    expect(sb.sent).toHaveLength(21);
  });

  it("broadcasts an entry, a device change and a new key to every socket", async () => {
    const w = world();
    const { A } = await newVault(w);
    const B = await pairDevice(w, A);
    const sa = await openSocket(w, A);
    const sb = await openSocket(w, B);
    sa.sent.length = 0; sb.sent.length = 0;

    expect((await rawLog(w, A, 0, "bid-000000001", "first-blob")).status).toBe(200);
    for (const s of [sa, sb]) expect(s.messages).toEqual([{ t: "entry", seq: 1, dev: A.deviceId, bid: "bid-000000001", blob: "first-blob" }]);

    sa.sent.length = 0; sb.sent.length = 0;
    expect((await request(w, `/v1/v/${A.vaultId}/device`, { method: "PUT", token: A.token, body: { nameCt: "new-name" } })).status).toBe(200);
    for (const s of [sa, sb]) expect(s.messages).toEqual([{ t: "devices" }]);
  });

  it("sends a pair request only to the device that opened the slot", async () => {
    const w = world();
    const { A } = await newVault(w);
    const B = await pairDevice(w, A);
    const sa = await openSocket(w, A);
    const sb = await openSocket(w, B);
    sa.sent.length = 0; sb.sent.length = 0;

    const approver = createApprover({
      transport: httpApproverTransport({ fetch: w.fetch, vault: A }), vault: A, appOrigin: ORIGIN, now: () => w.clock.t,
    });
    const started = await approver.start();
    const joiner = createJoiner({ transportFor: httpJoinerTransportFor(w.fetch), win: { localStorage: storage() } });
    await joiner.start(started.code);
    expect(sa.messages.filter((m) => m.t === "pair_request")).toHaveLength(1);
    expect(sb.messages.filter((m) => m.t === "pair_request")).toEqual([]);
  });

  it("closes a removed device's socket at once and tells the rest about the new key, not the removed one", async () => {
    const w = world();
    const { A } = await newVault(w);
    const B = await pairDevice(w, A);
    const sa = await openSocket(w, A);
    const sb = await openSocket(w, B);
    sa.sent.length = 0; sb.sent.length = 0;

    const res = await request(w, `/v1/v/${A.vaultId}/rotate`, {
      method: "POST", token: A.token,
      body: { expectEpoch: 1, removeDevice: B.deviceId, snapshot: { parts: ["sealed-snapshot"] }, keyboxes: {}, recoverHash: DIGEST },
    });
    expect(res.status).toBe(200);
    expect(sb.closed).toEqual({ code: 4401, reason: "revoked" });
    expect(sb.messages).toEqual([]);
    expect(sa.closed).toBeNull();
    expect(sa.messages).toEqual([{ t: "rotated", epoch: 2 }]);
    // Its token is dead too, so it cannot simply reconnect.
    expect((await connect(w, B)).status).toBe(401);
  });

  it("survives the object being evicted: sockets, their device ids and the handlers carry on", async () => {
    const w = world();
    const { A } = await newVault(w);
    const B = await pairDevice(w, A);
    const sa = await openSocket(w, A);
    const sb = await openSocket(w, B);
    sa.sent.length = 0; sb.sent.length = 0;
    const name = w.vaultName(A);

    await w.env.VAULT.evict(name); // hibernation: no instance, same storage and sockets
    expect((await rawLog(w, A, 0, "bid-000000001", "after-wake")).status).toBe(200);
    expect(sb.messages).toEqual([{ t: "entry", seq: 1, dev: A.deviceId, bid: "bid-000000001", blob: "after-wake" }]);

    await w.env.VAULT.evict(name);
    await w.env.VAULT.socketMessage(name, sa, JSON.stringify({ t: "presence", blob: "hello" }));
    expect(sb.messages.at(-1)).toEqual({ t: "presence", dev: A.deviceId, blob: "hello" });

    await w.env.VAULT.evict(name);
    await w.env.VAULT.socketClose(name, sb, 1005); // a code that may not be echoed
    expect(sb.closed).toEqual({ code: 1000, reason: "closing" });
    await w.env.VAULT.evict(name);
    await w.env.VAULT.socketClose(name, sa, 4000);
    expect(sa.closed.code).toBe(4000);
  });
});

describe("deleting a vault", () => {
  it("closes the sockets, reports to the registry, keeps the tombstone and answers 410 from then on", async () => {
    const w = world();
    const { A } = await newVault(w);
    const B = await pairDevice(w, A);
    const sa = await openSocket(w, A);
    const sb = await openSocket(w, B);
    sa.sent.length = 0; sb.sent.length = 0;

    expect((await request(w, `/v1/v/${A.vaultId}`, { method: "DELETE", token: A.token, body: { confirm: "delete" } })).status).toBe(200);
    for (const s of [sa, sb]) {
      expect(s.messages).toEqual([{ t: "deleted" }]);
      expect(s.closed).toEqual({ code: 4410, reason: "deleted" });
    }
    expect(w.registryCalls("/vault-deleted")).toHaveLength(1);
    expect((await admin(w, "/stats")).body.perVault[0].status).toBe("deleted");

    // The other device learns it with a 410, over HTTP and when it tries a socket.
    expect(await read(await request(w, `/v1/v/${A.vaultId}/log?since=0`, { token: B.token }))).toMatchObject({ status: 410, body: { code: "deleted" } });
    expect((await connect(w, B)).status).toBe(410);
    // The tombstone is still in storage (deleteAll would have thrown).
    const entry = await w.env.VAULT.entry(w.vaultName(A));
    expect(entry.db.db.prepare("SELECT v FROM meta WHERE k = 'deleted_at'").all()).toHaveLength(1);
    // It stays so after a wake-up.
    await w.env.VAULT.evict(w.vaultName(A));
    expect((await request(w, `/v1/v/${A.vaultId}/devices`, { token: A.token })).status).toBe(410);
  });

  it("is still deleted when the registry cannot be told, and tells it on the next request", async () => {
    const w = world();
    const { A } = await newVault(w);
    w.env.REGISTRY.failNext = 1;
    expect((await request(w, `/v1/v/${A.vaultId}`, { method: "DELETE", token: A.token, body: { confirm: "delete" } })).status).toBe(200);
    expect((await admin(w, "/stats")).body.vaults.count).toBe(1); // the registry has not heard
    expect((await request(w, `/v1/v/${A.vaultId}/devices`, { token: A.token })).status).toBe(410);
    expect((await admin(w, "/stats")).body.vaults.count).toBe(0);
  });
});

describe("limits and last-seen", () => {
  it("asks the registry for the byte cap lazily, caches it for a few minutes, then asks again", async () => {
    const w = world();
    await admin(w, "/config", { method: "POST", body: { vaultBytesCap: 600 } });
    const { A } = await newVault(w); // the claim is the first write, so the first ask
    expect(w.registryCalls("/limits")).toHaveLength(1);
    const big = "b".repeat(1000);

    const over = await rawLog(w, A, 0, "bid-000000001", big);
    expect(over).toMatchObject({ status: 429 });
    expect((await read(over)).body).toMatchObject({ code: "vault_quota", what: "bytes", max: 600 });

    // The admin raises the cap; the vault does not know yet.
    await admin(w, "/config", { method: "POST", body: { vaultBytesCap: 100_000 } });
    w.clock.t += LIMITS_TTL_MS - MIN;
    expect((await rawLog(w, A, 0, "bid-000000001", big)).status).toBe(429);
    expect(w.registryCalls("/limits")).toHaveLength(1);

    w.clock.t += 2 * MIN;
    expect((await rawLog(w, A, 0, "bid-000000001", big)).status).toBe(200);
    expect(w.registryCalls("/limits")).toHaveLength(2);
    // Every ask is trusted, and reads (GET) never trigger one.
    expect(w.registryCalls("/limits").every((c) => c.trusted === true)).toBe(true);
    w.clock.t += 10 * MIN;
    await request(w, `/v1/v/${A.vaultId}/log?since=0`, { token: A.token });
    expect(w.registryCalls("/limits")).toHaveLength(2);
  });

  it("keeps the cap it had, and tries again soon, when the registry cannot be reached", async () => {
    const w = world();
    await admin(w, "/config", { method: "POST", body: { vaultBytesCap: 600 } });
    const { A } = await newVault(w);
    w.clock.t += LIMITS_TTL_MS + MIN;
    w.env.REGISTRY.failNext = 1;
    expect((await rawLog(w, A, 0, "bid-000000001", "b".repeat(1000))).status).toBe(429); // old cap still in force
    const asked = w.registryCalls("/limits").length;
    // Soon, not a full period later and not on every request.
    expect((await rawLog(w, A, 0, "bid-000000001", "b".repeat(1000))).status).toBe(429);
    expect(w.registryCalls("/limits")).toHaveLength(asked);
    w.clock.t += 31_000;
    await admin(w, "/config", { method: "POST", body: { vaultBytesCap: 100_000 } });
    expect((await rawLog(w, A, 0, "bid-000000001", "b".repeat(1000))).status).toBe(200);
  });

  it("remembers the cap across a wake-up, so waking does not ask the registry again", async () => {
    const w = world();
    await admin(w, "/config", { method: "POST", body: { vaultBytesCap: 600 } });
    const { A } = await newVault(w);
    await w.env.VAULT.evict(w.vaultName(A));
    w.clock.t += MIN;
    expect((await rawLog(w, A, 0, "bid-000000001", "b".repeat(1000))).status).toBe(429);
    expect(w.registryCalls("/limits")).toHaveLength(1);
  });

  it("tells the registry a vault was seen at most once an hour", async () => {
    const w = world();
    const { A } = await newVault(w);
    const get = () => request(w, `/v1/v/${A.vaultId}/devices`, { token: A.token });
    expect((await get()).status).toBe(200);
    expect(w.registryCalls("/vault-seen")).toHaveLength(1);
    await get();
    w.clock.t += 59 * MIN;
    await get();
    expect(w.registryCalls("/vault-seen")).toHaveLength(1);
    w.clock.t += 2 * MIN;
    await get();
    expect(w.registryCalls("/vault-seen")).toHaveLength(2);
    // A failed or unauthenticated request is not a sighting, and a wake-up does not reset the hour.
    await request(w, `/v1/v/${A.vaultId}/devices`, { token: "z".repeat(43) });
    await w.env.VAULT.evict(w.vaultName(A));
    await get();
    expect(w.registryCalls("/vault-seen")).toHaveLength(2);
  });
});
