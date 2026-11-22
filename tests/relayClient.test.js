/**
 * The existing client code (sync/engine.js, sync/pairing.js and the vault and
 * code helpers), driven against the REAL vault and registry cores through a
 * fetch-like shim, in place of the hand-written fakes. If a shape in the core
 * differed from what the client expects, it fails here.
 */
import { describe, it, expect } from "vitest";
import { createEngine } from "../src/sync/engine.js";
import { createApprover, createJoiner } from "../src/sync/pairing.js";
import { createLocalVault, withVaultId } from "../src/sync/vault.js";
import { loadVault } from "../src/sync/vaultStore.js";
import { decodeRecoveryCode, encodeRecoveryCode } from "../src/sync/codes.js";
import {
  b64uDecode, b64uEncode, deriveKeys, generateDeviceKeys, gzip, newVaultKey, seal, snapCtx, tokenHash,
} from "../src/sync/crypto.js";
import { mergeState } from "../src/domain/merge.js";
import {
  RELAY_URL, createBackend, httpApproverTransport, httpEngineTransport, httpJoinerTransportFor,
  TransportError, recoverProofOf, registerVault,
} from "./relayShim.js";

const ORIGIN = "https://ahmed41022.github.io/meter/";
const MIN = 60_000;

const rec = (id, updatedAt, extra = {}) => ({ id, updatedAt, ...extra });
const ledger = (sessions = []) => ({ projects: [], sessions });
const byId = (s) => Object.fromEntries(s.sessions.map((r) => [r.id, r]));

const memoryStore = () => {
  let held = null;
  return { load: async () => (held ? structuredClone(held) : null), save: async (m) => { held = structuredClone(m); }, peek: () => held };
};

const storage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => map.delete(k),
  };
};

/** A relay with an invite spent on device A's vault, and A's saved identity. */
async function setup({ limits, defaults } = {}) {
  const clock = { t: Date.UTC(2026, 0, 5, 12) };
  const be = await createBackend({ clock, limits, defaults });
  const inv = await be.admin("POST", "/invite", { label: "Ahmed" });
  const local = await createLocalVault({ relay: RELAY_URL, invite: inv.body.code });
  const reg = await registerVault({ fetch: be.fetch, vault: local, invite: local.invite });
  expect(reg.status).toBe(200);
  return { clock, be, invite: inv.body.code, A: withVaultId(local, reg.body.vaultId), local };
}

/** One device: a vault identity, a ledger, a store and an engine over the real core. */
async function engineDevice(world, vault, state = ledger(), engineLimits = {}) {
  const transport = await httpEngineTransport({ fetch: world.be.fetch, vault });
  const store = memoryStore();
  const engine = createEngine({
    transport, store, device: vault.deviceId, now: () => world.clock.t, random: () => 0.5,
    sleep: async () => {}, limits: engineLimits,
  });
  const d = { vault, state, store, engine, transport };
  d.sync = async () => {
    const out = await engine.sync(d.state, { force: true });
    d.state = mergeState(d.state, out.state);
    return out;
  };
  d.put = (id, at, extra = {}) => {
    d.state = { ...d.state, sessions: [...d.state.sessions.filter((r) => r.id !== id), rec(id, at, extra)] };
  };
  return d;
}

/** Runs the whole join: A opens a slot, B pastes the code, the digits match, A approves, B finishes. */
async function pairDevice(world, approverVault = world.A, win = { localStorage: storage() }) {
  const approver = createApprover({
    transport: httpApproverTransport({ fetch: world.be.fetch, vault: approverVault }),
    vault: approverVault, appOrigin: ORIGIN, now: () => world.clock.t,
  });
  const joiner = createJoiner({ transportFor: httpJoinerTransportFor(world.be.fetch), win });
  const started = await approver.start();
  expect(started.phase).toBe("waiting");
  const sent = await joiner.start(started.code);
  expect(sent.phase).toBe("waiting");
  const asked = await approver.poll();
  expect(asked.phase).toBe("confirm");
  const waiting = await joiner.poll();
  expect(waiting.phase).toBe("waiting");
  expect(waiting.digits).toBe(asked.digits);
  expect((await approver.approve()).phase).toBe("approved");
  const done = await joiner.poll();
  expect(done.phase).toBe("joined");
  return { approver, joiner, win, vault: loadVault(win), digits: asked.digits };
}

describe("creating a vault through the registry", () => {
  it("hands back a signed vault id the client accepts, and the device can use its token at once", async () => {
    const { be, A } = await setup();
    expect(A.vaultId).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{16}$/);
    const res = await be.fetch(`${RELAY_URL}/v1/v/${A.vaultId}/devices`, { headers: { authorization: `Bearer ${A.token}` } });
    expect(res.status).toBe(200);
    expect((await res.json()).devices[0].id).toBe(A.deviceId);
  });

  it("lets a client whose first attempt was lost try again with the same invite and get the same vault", async () => {
    const { be, A, local } = await setup();
    const again = await registerVault({ fetch: be.fetch, vault: local, invite: local.invite });
    expect(again).toEqual({ status: 200, body: { vaultId: A.vaultId } });
    expect(be.vaults.size).toBe(1);
  });

  it("needs an invite while the relay is closed, and not once it is open", async () => {
    const { be } = await setup();
    const bare = await createLocalVault({ relay: RELAY_URL });
    expect((await registerVault({ fetch: be.fetch, vault: bare })).body.code).toBe("invite_required");
    await be.admin("POST", "/config", { openSignup: true });
    expect((await registerVault({ fetch: be.fetch, vault: bare })).status).toBe(200);
  });

  it("never wakes a vault for an id it did not mint", async () => {
    const { be, A } = await setup();
    const before = be.vaults.size;
    const forged = `${"ab".repeat(16)}.${"cd".repeat(8)}`;
    const bad = A.vaultId.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    for (const id of [forged, bad, "junk"]) {
      const res = await be.fetch(`${RELAY_URL}/v1/v/${id}/log?since=0`, { headers: { authorization: `Bearer ${A.token}` } });
      expect(res.status).toBe(404);
    }
    expect(be.vaults.size).toBe(before);
  });
});

describe("two devices against the real core", () => {
  it("pair, sync, conflict and converge", async () => {
    const w = await setup();
    const a = await engineDevice(w, w.A, ledger([rec("s1", 5), rec("s2", 6), rec("s3", 7)]));

    // The first push to an empty relay is one snapshot.
    expect(await a.sync()).toMatchObject({ status: "ok", uploaded: true, pushed: 3 });

    // B joins through the real pairing endpoints and holds the vault key afterwards.
    const joined = await pairDevice(w);
    expect(joined.vault).toMatchObject({ vaultId: w.A.vaultId, epoch: 1, K: w.A.K });
    expect(joined.vault.token).not.toBe(w.A.token);
    const devices = await (await w.be.fetch(`${RELAY_URL}/v1/v/${w.A.vaultId}/devices`, { headers: { authorization: `Bearer ${w.A.token}` } })).json();
    expect(devices.devices.map((d) => d.id).sort()).toEqual([w.A.deviceId, joined.vault.deviceId].sort());

    // B adopts the snapshot and has nothing to send back.
    const b = await engineDevice(w, joined.vault);
    expect(await b.sync()).toMatchObject({ status: "ok", adopted: true, pushed: 0 });
    expect(byId(b.state)).toEqual(byId(a.state));

    // A race: B has read the log, then A writes, then B writes. The relay says conflict,
    // B takes in A's entry and tries again.
    a.put("s1", 20, { note: "from A" });
    b.put("s2", 21, { note: "from B" });
    let hook = async () => { await a.sync(); };
    const realPush = b.transport.push;
    b.transport.push = async (args) => {
      if (hook) { const h = hook; hook = null; await h(); }
      return realPush(args);
    };
    const raced = await b.sync();
    expect(raced).toMatchObject({ status: "ok", raced: true, pushed: 1 });
    await a.sync();
    expect(byId(a.state)).toEqual(byId(b.state));
    expect(byId(a.state).s1.note).toBe("from A");
    expect(byId(a.state).s2.note).toBe("from B");

    // The same record edited on both: the later stamp wins everywhere.
    a.put("s3", 30, { note: "A late" });
    b.put("s3", 40, { note: "B later" });
    await a.sync();
    await b.sync();
    await a.sync();
    expect(byId(a.state).s3.note).toBe("B later");
    expect(byId(b.state)).toEqual(byId(a.state));

    // Nothing is left to send and the relay's head is where both stand.
    expect((await a.sync())).toMatchObject({ status: "ok", pushed: 0 });
    expect(a.store.peek().cursor).toBe(b.store.peek().cursor);
  });

  it("repeat a push whose answer was lost without storing it twice", async () => {
    const w = await setup();
    const a = await engineDevice(w, w.A, ledger([rec("s1", 5)]));
    await a.sync();
    const realPush = a.transport.push;
    let dropped = false;
    a.transport.push = async (args) => {
      const out = await realPush(args);
      if (!dropped) { dropped = true; throw new TransportError("network"); }
      return out;
    };
    a.put("s1", 9, { note: "x" });
    expect(await a.sync()).toMatchObject({ status: "network" });
    a.transport.push = realPush;
    const out = await a.sync();
    expect(out.status).toBe("ok");
    const log = await (await w.be.fetch(`${RELAY_URL}/v1/v/${w.A.vaultId}/log?since=0`, { headers: { authorization: `Bearer ${w.A.token}` } })).json();
    expect(log.entries).toHaveLength(1);
  });

  it("send a device that fell far behind to the snapshot, with the kept tail short", async () => {
    const w = await setup({ limits: { tail: 1, writesPerMin: 1000 } });
    const small = { COMPACT_AFTER: 3 };
    const a = await engineDevice(w, w.A, ledger([rec("s1", 5)]), small);
    await a.sync();
    const joined = await pairDevice(w);
    const b = await engineDevice(w, joined.vault, ledger(), small);
    await b.sync();

    for (let i = 1; i <= 6; i += 1) {
      a.put(`n${i}`, 100 + i, { i });
      await a.sync();
    }
    // A compacted along the way: the relay now holds a snapshot past B's cursor.
    const head = await (await w.be.fetch(`${RELAY_URL}/v1/v/${w.A.vaultId}/log?since=0`, { headers: { authorization: `Bearer ${w.A.token}` } }));
    expect(head.status).toBe(410);

    const caught = await b.sync();
    expect(caught).toMatchObject({ status: "ok", adopted: true });
    expect(byId(b.state)).toEqual(byId(a.state));
    expect(Object.keys(byId(b.state))).toHaveLength(7);
  });

  it("report a vault's daily allowance as a quota with its reset time, and recover after it", async () => {
    const w = await setup({ limits: { appendsPerDay: 1, writesPerMin: 1000 } });
    const a = await engineDevice(w, w.A, ledger([rec("s1", 5)]));
    await a.sync();
    a.put("s1", 6);
    expect((await a.sync()).status).toBe("ok");
    a.put("s1", 7);
    const out = await a.sync();
    const reset = (Math.floor(w.clock.t / 86_400_000) + 1) * 86_400_000;
    expect(out).toMatchObject({ status: "quota", retryAt: w.clock.t + 30 * MIN });
    expect(reset).toBeGreaterThan(w.clock.t);
    w.clock.t = reset;
    expect((await a.sync()).status).toBe("ok");
  });

  it("cut a removed device off at once and tell the others the key moved", async () => {
    const w = await setup();
    const a = await engineDevice(w, w.A, ledger([rec("s1", 5)]));
    await a.sync();
    const joined = await pairDevice(w);
    const b = await engineDevice(w, joined.vault);
    await b.sync();

    // Remove B: A makes the next key, seals its snapshot under it and rotates.
    const K2 = newVaultKey();
    const next = { ...w.A, K: b64uEncode(K2), epoch: 2 };
    const keys = await deriveKeys(K2, 2);
    const packed = await gzip(new TextEncoder().encode(JSON.stringify(a.state)));
    const part = await seal(keys.encKey, { epoch: 2, kind: "snap", ctx: snapCtx(0, 0, 1) }, packed);
    const res = await w.be.fetch(`${RELAY_URL}/v1/v/${w.A.vaultId}/rotate`, {
      method: "POST", headers: { authorization: `Bearer ${w.A.token}` },
      body: JSON.stringify({
        expectEpoch: 1, removeDevice: joined.vault.deviceId, snapshot: { parts: [part] }, keyboxes: {},
        recoverHash: await tokenHash(await recoverProofOf(next)),
      }),
    });
    expect(res.status).toBe(200);
    // The first snapshot was at position 0 and nothing was appended since.
    expect(await res.json()).toEqual({ epoch: 2, upto: 0 });

    // The removed device is refused outright.
    b.put("s1", 50);
    expect(await b.sync()).toMatchObject({ status: "auth" });
    // A device still on the old key is told to fetch the new one, and does not decrypt anything.
    const stale = await engineDevice(w, w.A);
    expect(await stale.sync()).toMatchObject({ status: "rekey" });
    // On the new key the vault carries on, from the snapshot A sealed.
    const a2 = await engineDevice(w, next, a.state);
    expect(await a2.sync()).toMatchObject({ status: "ok" });
    a2.put("s2", 60);
    expect(await a2.sync()).toMatchObject({ status: "ok", pushed: 1 });
  });

  it("let a new device in from the recovery code alone, and read the vault", async () => {
    const w = await setup();
    const a = await engineDevice(w, w.A, ledger([rec("s1", 5), rec("s2", 6)]));
    await a.sync();

    const K = decodeRecoveryCode(encodeRecoveryCode(b64uDecode(w.A.K)));
    const fresh = await createLocalVault({ relay: RELAY_URL });
    const base = `${RELAY_URL}/v1/v/${w.A.vaultId}`;
    const { epoch } = await (await w.be.fetch(`${base}/recover`)).json();
    const vault = { ...fresh, vaultId: w.A.vaultId, K: b64uEncode(K), epoch };
    const res = await w.be.fetch(`${base}/recover`, {
      method: "POST",
      body: JSON.stringify({
        recoverProof: await recoverProofOf(vault), tokenHash: await tokenHash(vault.token),
        pubkey: { kty: "EC", crv: "P-256", x: vault.privateJwk.x, y: vault.privateJwk.y }, deviceId: vault.deviceId,
      }),
    });
    expect(res.status).toBe(200);
    const d = await engineDevice(w, vault);
    expect(await d.sync()).toMatchObject({ status: "ok", adopted: true });
    expect(byId(d.state)).toEqual(byId(a.state));

    // The wrong code gets nowhere.
    const wrong = { ...vault, K: b64uEncode(newVaultKey()) };
    const bad = await w.be.fetch(`${base}/recover`, {
      method: "POST",
      body: JSON.stringify({ recoverProof: await recoverProofOf(wrong), tokenHash: await tokenHash(wrong.token), pubkey: { kty: "EC", crv: "P-256", x: vault.privateJwk.x, y: vault.privateJwk.y } }),
    });
    expect(bad.status).toBe(401);
  });
});

describe("pairing against the real core", () => {
  it("matches the digits on both screens and registers the joiner with its own token", async () => {
    const w = await setup();
    const joined = await pairDevice(w);
    expect(joined.digits).toMatch(/^\d{6}$/);
    expect(loadVault(joined.win).K).toBe(w.A.K);
  });

  it("refuses a second device on the same code", async () => {
    const w = await setup();
    const approver = createApprover({ transport: httpApproverTransport({ fetch: w.be.fetch, vault: w.A }), vault: w.A, appOrigin: ORIGIN, now: () => w.clock.t });
    const started = await approver.start();
    const first = createJoiner({ transportFor: httpJoinerTransportFor(w.be.fetch), win: { localStorage: storage() } });
    const second = createJoiner({ transportFor: httpJoinerTransportFor(w.be.fetch), win: { localStorage: storage() } });
    expect((await first.start(started.code)).phase).toBe("waiting");
    const late = await second.start(started.code);
    expect(late).toMatchObject({ phase: "failed", reason: "used" });
  });

  it("shows the joiner a denial", async () => {
    const w = await setup();
    const approver = createApprover({ transport: httpApproverTransport({ fetch: w.be.fetch, vault: w.A }), vault: w.A, appOrigin: ORIGIN, now: () => w.clock.t });
    const joiner = createJoiner({ transportFor: httpJoinerTransportFor(w.be.fetch), win: { localStorage: storage() } });
    const started = await approver.start();
    await joiner.start(started.code);
    await approver.poll();
    expect((await approver.deny()).phase).toBe("denied");
    expect((await joiner.poll()).phase).toBe("denied");
  });

  it("lets a code lapse after ten minutes", async () => {
    const w = await setup();
    const approver = createApprover({ transport: httpApproverTransport({ fetch: w.be.fetch, vault: w.A }), vault: w.A, appOrigin: ORIGIN, now: () => w.clock.t });
    const joiner = createJoiner({ transportFor: httpJoinerTransportFor(w.be.fetch), win: { localStorage: storage() } });
    const started = await approver.start();
    w.clock.t += 11 * MIN;
    const sent = await joiner.start(started.code);
    expect(sent).toMatchObject({ phase: "failed", reason: "expired" });
  });

  it("lets a joiner that crashed after approval finish within the hour, and not after it", async () => {
    const w = await setup();
    const win = { localStorage: storage() };
    const approver = createApprover({ transport: httpApproverTransport({ fetch: w.be.fetch, vault: w.A }), vault: w.A, appOrigin: ORIGIN, now: () => w.clock.t });
    const joiner = createJoiner({ transportFor: httpJoinerTransportFor(w.be.fetch), win });
    const started = await approver.start();
    await joiner.start(started.code);
    await approver.poll();
    await approver.approve();
    // The joiner is gone; a new process picks the pairing up from storage.
    w.clock.t += 50 * MIN;
    const back = createJoiner({ transportFor: httpJoinerTransportFor(w.be.fetch), win });
    const resumed = await back.resume();
    expect(["waiting", "joined"]).toContain(resumed.phase);
    const done = resumed.phase === "joined" ? resumed : await back.poll();
    expect(done.phase).toBe("joined");
    expect(loadVault(win).K).toBe(w.A.K);

    // A second joiner that resumes after the hour finds the slot gone.
    const w2 = await setup();
    const win2 = { localStorage: storage() };
    const ap2 = createApprover({ transport: httpApproverTransport({ fetch: w2.be.fetch, vault: w2.A }), vault: w2.A, appOrigin: ORIGIN, now: () => w2.clock.t });
    const j2 = createJoiner({ transportFor: httpJoinerTransportFor(w2.be.fetch), win: win2 });
    const s2 = await ap2.start();
    await j2.start(s2.code);
    await ap2.poll();
    await ap2.approve();
    w2.clock.t += 61 * MIN;
    const late = createJoiner({ transportFor: httpJoinerTransportFor(w2.be.fetch), win: win2 });
    // Its repeated request meets a lapsed slot, which the client reports as expired.
    expect(await late.resume()).toMatchObject({ phase: "failed", reason: "expired" });
  });

  it("is not fooled by a request that did not come from the code: the approver drops it", async () => {
    const w = await setup();
    const approver = createApprover({ transport: httpApproverTransport({ fetch: w.be.fetch, vault: w.A }), vault: w.A, appOrigin: ORIGIN, now: () => w.clock.t });
    const started = await approver.start();
    // Someone with only the relay and the slot's join token (not S) files a request with a made-up proof.
    const stranger = await generateDeviceKeys();
    const { decodeJoin } = await import("../src/sync/codes.js");
    const { deriveJoinKeys } = await import("../src/sync/crypto.js");
    const join = decodeJoin(started.code);
    const keys = await deriveJoinKeys(join.secret);
    const res = await w.be.fetch(`${RELAY_URL}/v1/v/${w.A.vaultId}/pair/request`, {
      method: "POST", headers: { authorization: `Bearer ${keys.joinToken}` },
      body: JSON.stringify({
        joinId: join.joinId, deviceId: "0123456789abcdef", pubkey: stranger.publicJwk, tokenHash: await tokenHash("x".repeat(43)),
        proof: "not-a-valid-mac-at-all",
      }),
    });
    expect(res.status).toBe(200);
    const seen = await approver.poll();
    expect(seen).toMatchObject({ phase: "failed", reason: "bad_proof" });
    });
});
