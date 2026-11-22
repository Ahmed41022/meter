import { describe, it, expect } from "vitest";
import { createApprover, createJoiner } from "../src/sync/pairing.js";
import { TransportError } from "../src/sync/engine.js";
import { createLocalVault, publicJwkOf, withVaultId } from "../src/sync/vault.js";
import { SYNC_KEY, loadJoinSession, loadVault } from "../src/sync/vaultStore.js";
import {
  b64uDecode, comparisonCode, deriveJoinKeys, generateDeviceKeys, macSign, macVerify,
  pairingMessages, tokenHash, wrapKey,
} from "../src/sync/crypto.js";
import { encodeJoin } from "../src/sync/codes.js";
import { COLLECT_MS, OPEN_MS, createFakePairingRelay } from "./syncFakePairing.js";

const VID = `${"ab".repeat(16)}.${"cd".repeat(8)}`;
const RELAY = "https://relay.example.workers.dev";
const ORIGIN = "https://ahmed41022.github.io/meter/";

const storage = (failWrites = false) => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { if (failWrites) throw new Error("full"); map.set(k, String(v)); },
    removeItem: (k) => map.delete(k),
    has: (k) => map.has(k),
  };
};

async function world() {
  const clock = { t: 5_000_000 };
  const now = () => clock.t;
  const relay = createFakePairingRelay({ now, vaultId: VID });
  const vaultA = withVaultId(await createLocalVault({ relay: RELAY }), VID);
  await relay.registerDevice({ token: vaultA.token, deviceId: vaultA.deviceId, privateJwk: vaultA.privateJwk });
  const approver = () => createApprover({ transport: relay.approverTransport(vaultA.token), vault: vaultA, appOrigin: ORIGIN, now });
  const winB = { localStorage: storage() };
  const joiner = (win = winB) => createJoiner({ transportFor: relay.joinerTransport(), win });
  return { clock, now, relay, vaultA, approver, joiner, winB };
}

/** A starts and B pastes the code, up to the point A has to decide. */
async function toConfirm(w, a = w.approver(), b = w.joiner()) {
  const started = await a.start();
  await b.start(started.code);
  const asked = await a.poll();
  return { a, b, started, asked };
}

describe("S-derived helpers", () => {
  const S = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

  it("derives the same join token, MAC key and digits input from the same S, and different ones from another", async () => {
    const a = await deriveJoinKeys(S);
    const b = await deriveJoinKeys(S);
    expect(a.joinToken).toBe(b.joinToken);
    expect(a.sasSecret).toEqual(b.sasSecret);
    expect(b64uDecode(a.joinToken)).toHaveLength(32);
    const other = await deriveJoinKeys(S.map((x) => x ^ 1));
    expect(other.joinToken).not.toBe(a.joinToken);
    expect(other.sasSecret).not.toEqual(a.sasSecret);
    // Both sides' MACs agree only under the same S.
    const m = await macSign(a.macKey, "hello");
    expect(await macVerify(b.macKey, "hello", m)).toBe(true);
    expect(await macVerify(other.macKey, "hello", m)).toBe(false);
    await expect(deriveJoinKeys(new Uint8Array(8))).rejects.toThrow();
  });

  it("does not let the join token stand in for S: it is not S, nor the MAC key's bytes", async () => {
    const { joinToken, sasSecret } = await deriveJoinKeys(S);
    expect(joinToken).not.toContain(Buffer.from(S).toString("base64url"));
    expect(sasSecret).not.toEqual(S);
  });

  it("rejects a MAC over a different message, a tampered MAC, and junk", async () => {
    const { macKey } = await deriveJoinKeys(S);
    const m = await macSign(macKey, "one");
    expect(await macVerify(macKey, "two", m)).toBe(false);
    expect(await macVerify(macKey, "one", m.slice(0, -2) + (m.endsWith("A") ? "BB" : "AA"))).toBe(false);
    expect(await macVerify(macKey, "one", "!!!")).toBe(false);
    expect(await macVerify(macKey, "one", undefined)).toBe(false);
  });

  it("tokenHash is the SHA-256 of the token string, 32 bytes in base64url", async () => {
    const h = await tokenHash("abc");
    expect(b64uDecode(h)).toHaveLength(32);
    expect(h).toBe(await tokenHash("abc"));
    expect(h).not.toBe(await tokenHash("abd"));
  });

  it("the signed messages bind every field they are about", async () => {
    const p = (await generateDeviceKeys()).publicJwk;
    const q = (await generateDeviceKeys()).publicJwk;
    const base = { joinId: "00".repeat(8), deviceId: "11".repeat(8), pubkey: p, tokenHash: "th" };
    const msg = pairingMessages.request(base);
    for (const alt of [{ joinId: "22".repeat(8) }, { deviceId: "33".repeat(8) }, { pubkey: q }, { tokenHash: "tx" }]) {
      expect(pairingMessages.request({ ...base, ...alt })).not.toBe(msg);
    }
    expect(pairingMessages.open({ joinId: "a", approverPub: p })).not.toBe(pairingMessages.open({ joinId: "a", approverPub: q }));
  });
});

describe("a full pairing", () => {
  it("leaves both devices with the same K and epoch, and saves the joiner's vault", async () => {
    const w = await world();
    const { a, b, started, asked } = await toConfirm(w);
    expect(started.phase).toBe("waiting");
    expect(started.code).toMatch(/^relay\.example\.workers\.dev\//);
    expect(started.link.startsWith(`${ORIGIN}#join=`)).toBe(true);
    expect(asked.phase).toBe("confirm");
    expect(asked.digits).toMatch(/^\d{6}$/);
    expect(asked.joiner.deviceId).toMatch(/^[0-9a-f]{16}$/);

    const waiting = await b.poll();
    expect(waiting.phase).toBe("waiting");
    // The same six digits on both screens, before anything is approved.
    expect(waiting.digits).toBe(asked.digits);
    expect(loadVault(w.winB)).toBeNull();

    expect((await a.approve()).phase).toBe("approved");
    const done = await b.poll();
    expect(done).toMatchObject({ phase: "joined", vaultId: VID, epoch: w.vaultA.epoch });
    const saved = loadVault(w.winB);
    expect(saved.K).toBe(w.vaultA.K);
    expect(saved.epoch).toBe(w.vaultA.epoch);
    expect(saved.vaultId).toBe(VID);
    expect(saved.relay).toBe(RELAY);
    // Its own identity, not a copy of the approver's.
    expect(saved.deviceId).not.toBe(w.vaultA.deviceId);
    expect(saved.token).not.toBe(w.vaultA.token);
    expect(saved.privateJwk.d).not.toBe(w.vaultA.privateJwk.d);
    // The relay now knows the new device, and the in-progress record is gone.
    expect(w.relay.deviceIds()).toContain(saved.deviceId);
    expect(loadJoinSession(w.winB)).toBeNull();
    expect(w.winB.localStorage.has(SYNC_KEY.JOIN)).toBe(false);
  });

  it("works from the link as well as the typed code", async () => {
    const w = await world();
    const a = w.approver();
    const { link } = await a.start();
    const b = w.joiner();
    expect((await b.start(link)).phase).toBe("waiting");
    await a.poll();
    await a.approve();
    expect((await b.poll()).phase).toBe("joined");
  });

  it("never lets K or S reach the relay", async () => {
    const w = await world();
    const seen = [];
    w.relay.hooks.request = (r) => { seen.push(JSON.stringify(r)); return r; };
    w.relay.hooks.status = (r) => { seen.push(JSON.stringify(r)); return r; };
    const { a, b } = await toConfirm(w);
    await a.approve();
    await b.poll();
    const wire = [...seen, JSON.stringify([...w.relay.slots.values()])].join("");
    const S = Buffer.from(b64uDecode(JSON.parse(w.winB.localStorage.getItem(SYNC_KEY.VAULT)).K)).toString("base64url");
    expect(wire).not.toContain(S);
    expect(wire).not.toContain(w.vaultA.K);
  });
});

describe("a relay in the middle", () => {
  it("is caught by the proof when it swaps the joiner's public key", async () => {
    const w = await world();
    const attacker = await generateDeviceKeys();
    w.relay.hooks.pending = (req) => ({ ...req, pubkey: attacker.publicJwk });
    const { asked } = await toConfirm(w);
    // The approver never reaches a screen with digits: the proof fails first.
    expect(asked.phase).toBe("failed");
    expect(asked.reason).toBe("bad_proof");
    expect(asked.digits).toBeUndefined();
    expect(w.relay.count("deny")).toBe(1);
  });

  it("is caught when it rewrites the joiner's token hash or device id", async () => {
    for (const patch of [{ tokenHash: "evil" }, { deviceId: "ee".repeat(8) }]) {
      const w = await world();
      w.relay.hooks.pending = (req) => ({ ...req, ...patch });
      expect((await toConfirm(w)).asked.reason).toBe("bad_proof");
    }
  });

  it("is caught by the joiner when it hands over its own key as the approver's", async () => {
    const w = await world();
    const attacker = await generateDeviceKeys();
    w.relay.hooks.status = (r) => (r.approverPub ? { ...r, approverPub: attacker.publicJwk } : r);
    const { b } = await toConfirm(w);
    const res = await b.poll();
    expect(res).toMatchObject({ phase: "failed", reason: "bad_proof" });
    expect(loadVault(w.winB)).toBeNull();
    expect(loadJoinSession(w.winB)).toBeNull();
  });

  it("is caught when it swaps the approver's key only at the end, after a good first answer", async () => {
    const w = await world();
    const attacker = await generateDeviceKeys();
    const { a, b } = await toConfirm(w);
    expect((await b.poll()).phase).toBe("waiting");
    await a.approve();
    w.relay.hooks.status = (r) => ({ ...r, approverPub: attacker.publicJwk });
    expect(await b.poll()).toMatchObject({ phase: "failed", reason: "bad_proof" });
    expect(loadVault(w.winB)).toBeNull();
  });

  it("is caught by the ack when it replaces the wrapped key with one of its own", async () => {
    const w = await world();
    const { a, b } = await toConfirm(w);
    await b.poll();
    await a.approve();
    // The relay learns B's public key from the request, so it can wrap ITS key to B perfectly.
    const slot = [...w.relay.slots.values()][0];
    const evilK = new Uint8Array(32).fill(7);
    const evilWrap = await wrapKey({ K: evilK, epoch: w.vaultA.epoch }, slot.request.pubkey, { ctx: slot.request.deviceId });
    w.relay.hooks.status = (r) => (r.state === "approved" ? { ...r, wrapped: evilWrap } : r);
    const res = await b.poll();
    expect(res).toMatchObject({ phase: "failed", reason: "bad_ack" });
    expect(loadVault(w.winB)).toBeNull();
  });

  it("is caught by the ack when it changes the epoch, or forges an ack", async () => {
    // The forged ack must differ from the real one: replacing the last two
    // characters with a fixed "AA" left it unchanged whenever the real one
    // already ended that way (about one run in 256), and the pairing then
    // rightly succeeded. Flip the second-to-last character instead.
    const flip = (ack) => `${ack.slice(0, -2)}${ack.at(-2) === "B" ? "C" : "B"}${ack.at(-1)}`;
    for (const tamper of [(r) => ({ ...r, epoch: r.epoch + 1 }), (r) => ({ ...r, ack: flip(r.ack) }), (r) => ({ ...r, ack: undefined })]) {
      const w = await world();
      const { a, b } = await toConfirm(w);
      await b.poll();
      await a.approve();
      w.relay.hooks.status = (r) => (r.state === "approved" ? tamper(r) : r);
      expect(await b.poll()).toMatchObject({ phase: "failed", reason: "bad_ack" });
      expect(loadVault(w.winB)).toBeNull();
    }
  });

  it("cannot forge a request even though it knows the join token, the vault id and the slot", async () => {
    const w = await world();
    const a = w.approver();
    const { joinId } = await a.start();
    // What the relay holds: the join token's hash only. It forges everything else,
    // signing with a MAC key from a guessed S.
    const guess = await deriveJoinKeys(new Uint8Array(16).fill(9));
    const mine = await generateDeviceKeys();
    const req = { joinId, deviceId: "ab".repeat(8), pubkey: mine.publicJwk, tokenHash: await tokenHash("x") };
    const slot = w.relay.slots.get(joinId);
    slot.request = { ...req, proof: await macSign(guess.macKey, pairingMessages.request(req)) };
    expect((await a.poll()).reason).toBe("bad_proof");
  });

  it("refuses a replayed request from an earlier pairing", async () => {
    const w = await world();
    const first = await toConfirm(w);
    const old = { ...[...w.relay.slots.values()][0].request, joinId: [...w.relay.slots.keys()][0] };
    await first.a.approve();
    await first.b.poll();

    // A second pairing; the relay injects the old, once-valid request into it.
    const a2 = w.approver();
    await a2.start();
    w.relay.hooks.pending = () => old;
    // Slot has to have a request for the fake to answer; give it one.
    [...w.relay.slots.values()].at(-1).request = { ...old };
    expect((await a2.poll()).reason).toBe("bad_proof");

    // And with the old request's joinId rewritten to the new slot: the MAC covers it.
    const a3 = w.approver();
    const s3 = await a3.start();
    w.relay.hooks.pending = () => ({ ...old, joinId: s3.joinId });
    [...w.relay.slots.values()].at(-1).request = { ...old };
    expect((await a3.poll()).reason).toBe("bad_proof");
  });

  it("makes the digits differ when the relay interferes with any key", async () => {
    const w = await world();
    const { asked } = await toConfirm(w);
    const attacker = await generateDeviceKeys();
    const sas = (await deriveJoinKeys(new Uint8Array(16).fill(1))).sasSecret;
    expect(await comparisonCode(publicJwkOf(w.vaultA), attacker.publicJwk, { secret: sas })).not.toBe(asked.digits);
  });
});

describe("comparison digits", () => {
  it("match on both sides only when S and both keys match", async () => {
    const w = await world();
    const { a, b, asked } = await toConfirm(w);
    const joiner = (await b.poll()).digits;
    expect(joiner).toBe(asked.digits);
    const session = loadJoinSession(w.winB);
    const keys = await deriveJoinKeys(b64uDecode(session.S));
    const pubA = publicJwkOf(w.vaultA);
    const pubB = publicJwkOf(session);
    expect(await comparisonCode(pubA, pubB, { secret: keys.sasSecret })).toBe(asked.digits);
    // Wrong S, a changed key on either side, or no S at all: different digits.
    const wrong = await deriveJoinKeys(new Uint8Array(16).fill(3));
    const other = (await generateDeviceKeys()).publicJwk;
    const variants = [
      await comparisonCode(pubA, pubB, { secret: wrong.sasSecret }),
      await comparisonCode(other, pubB, { secret: keys.sasSecret }),
      await comparisonCode(pubA, other, { secret: keys.sasSecret }),
      await comparisonCode(pubA, pubB),
    ];
    expect(variants.filter((v) => v === asked.digits).length).toBeLessThanOrEqual(1);
    expect(new Set(variants).size).toBeGreaterThan(2);
    void a;
  });
});

describe("slots", () => {
  it("expire: a joiner after ten minutes is told so, and so is the approver", async () => {
    const w = await world();
    const a = w.approver();
    const { code } = await a.start();
    w.clock.t += OPEN_MS + 1;
    const b = w.joiner();
    const res = await b.start(code);
    expect(res).toMatchObject({ phase: "failed", reason: "expired" });
    expect(loadJoinSession(w.winB)).toBeNull();
    expect((await a.poll()).phase).toBe("expired");
  });

  it("expire between the request and the approval", async () => {
    const w = await world();
    const { a, b } = await toConfirm(w);
    w.clock.t += OPEN_MS + 1;
    expect((await a.approve()).phase).toBe("expired");
    expect((await b.poll()).phase).toBe("expired");
    expect(loadVault(w.winB)).toBeNull();
  });

  it("can be used once: a second device with the same code is refused", async () => {
    const w = await world();
    const a = w.approver();
    const { code } = await a.start();
    const first = w.joiner();
    expect((await first.start(code)).phase).toBe("waiting");
    const winC = { localStorage: storage() };
    const second = w.joiner(winC);
    expect(await second.start(code)).toMatchObject({ phase: "failed", reason: "used" });
    expect(loadJoinSession(winC)).toBeNull();
    // The first device is unaffected.
    await a.poll();
    await a.approve();
    expect((await first.poll()).phase).toBe("joined");
  });

  it("are refused once approved, and a collected answer is kept for an hour then dropped", async () => {
    const w = await world();
    const { a, b } = await toConfirm(w);
    await a.approve();
    w.clock.t += OPEN_MS + 5_000; // past the open window, inside the collect window
    expect((await b.poll()).phase).toBe("joined");

    const w2 = await world();
    const t = await toConfirm(w2);
    await t.a.approve();
    w2.clock.t += COLLECT_MS + 1;
    expect((await t.b.poll()).phase).toBe("expired");
  });
});

describe("a wrong code", () => {
  it("with a wrong S is refused by the relay's join-token check", async () => {
    const w = await world();
    const a = w.approver();
    const { code } = await a.start();
    const real = (await import("../src/sync/codes.js")).decodeJoin(code);
    const wrong = encodeJoin({ ...real, secret: real.secret.map((x) => x ^ 0xff) });
    const b = w.joiner();
    expect(await b.start(wrong)).toMatchObject({ phase: "failed", reason: "refused" });
    expect(loadVault(w.winB)).toBeNull();
    expect((await a.poll()).phase).toBe("waiting");
  });

  it("with a typo, a cut-off or junk never reaches the network", async () => {
    const w = await world();
    const { code } = await w.approver().start();
    const before = w.relay.calls.length;
    for (const bad of [code.slice(0, -3), `${code.slice(0, -1)}${code.endsWith("A") ? "B" : "A"}`, "", "junk", `${code}?x=1`]) {
      const res = await w.joiner({ localStorage: storage() }).start(bad);
      expect(res).toMatchObject({ phase: "failed", reason: "bad_code" });
      expect(res.error.message.length).toBeGreaterThan(10);
    }
    expect(w.relay.calls.length).toBe(before);
  });

  it("for a vault the relay does not have is reported as expired", async () => {
    const w = await world();
    const { code } = await w.approver().start();
    const other = encodeJoin({ ...(await import("../src/sync/codes.js")).decodeJoin(code), vaultId: `${"11".repeat(16)}.${"22".repeat(8)}` });
    expect(await w.joiner().start(other)).toMatchObject({ phase: "failed", reason: "expired" });
  });
});

describe("denial", () => {
  it("is shown to the joiner and leaves nothing behind", async () => {
    const w = await world();
    const { a, b } = await toConfirm(w);
    expect((await a.deny()).phase).toBe("denied");
    expect(await b.poll()).toMatchObject({ phase: "denied" });
    expect(loadVault(w.winB)).toBeNull();
    expect(loadJoinSession(w.winB)).toBeNull();
    expect(w.relay.deviceIds()).toEqual([w.vaultA.deviceId]);
  });

  it("cannot be undone by approving afterwards", async () => {
    const w = await world();
    const { a } = await toConfirm(w);
    await a.deny();
    expect((await a.approve()).phase).toBe("denied");
    expect(w.relay.deviceIds()).toHaveLength(1);
  });
});

describe("a joiner that crashes", () => {
  it("after approval picks up where it left off and finishes", async () => {
    const w = await world();
    const { a, b } = await toConfirm(w);
    await b.poll();
    await a.approve();
    // "Crash": the first joiner object is gone; only storage survives.
    const reborn = w.joiner();
    expect(reborn.state.phase).toBe("idle");
    expect((await reborn.resume()).phase).toBe("waiting");
    expect((await reborn.poll()).phase).toBe("joined");
    expect(loadVault(w.winB).K).toBe(w.vaultA.K);
    // Resuming again afterwards finds nothing to do.
    expect((await w.joiner().resume()).phase).toBe("idle");
    void b;
  });

  it("before its request got through sends the same request again", async () => {
    const w = await world();
    const a = w.approver();
    const { code } = await a.start();
    w.relay.failNext("request", new TransportError("network"));
    const b = w.joiner();
    const first = await b.start(code);
    expect(first.phase).toBe("requesting");
    expect(first.error).toMatchObject({ code: "network", retry: true });
    expect(loadJoinSession(w.winB)).not.toBeNull();
    const reborn = w.joiner();
    expect((await reborn.resume()).phase).toBe("waiting");
    await a.poll();
    await a.approve();
    expect((await reborn.poll()).phase).toBe("joined");
  });

  it("after its request was stored but the answer was lost does not look like a second device", async () => {
    const w = await world();
    const a = w.approver();
    const { code } = await a.start();
    w.relay.failNext("request", new TransportError("network"), { afterStore: true });
    await w.joiner().start(code);
    const reborn = w.joiner();
    expect((await reborn.resume()).phase).toBe("waiting");
    expect((await a.poll()).phase).toBe("confirm");
  });

  it("keeps its progress when the vault cannot be saved yet, and finishes on retry", async () => {
    const w = await world();
    const full = { localStorage: storage() };
    const b = w.joiner(full);
    const a = w.approver();
    const { code } = await a.start();
    await b.start(code);
    await a.poll();
    await a.approve();
    // Writes start failing only now, as when storage fills up mid-way.
    const set = full.localStorage.setItem;
    full.localStorage.setItem = (k, v) => { if (k === SYNC_KEY.VAULT) throw new Error("full"); set(k, v); };
    const stuck = await b.poll();
    expect(stuck.error).toMatchObject({ code: "storage", retry: true });
    expect(loadJoinSession(full)).not.toBeNull();
    full.localStorage.setItem = set;
    expect((await b.poll()).phase).toBe("joined");
  });

  it("refuses to start if the pairing cannot be saved at all", async () => {
    const w = await world();
    const { code } = await w.approver().start();
    const res = await w.joiner({ localStorage: storage(true) }).start(code);
    expect(res).toMatchObject({ phase: "failed", reason: "storage" });
    expect(w.relay.count("request")).toBe(0);
  });

  it("is not allowed when the device already has a vault", async () => {
    const w = await world();
    const paired = { localStorage: storage() };
    const t = await toConfirm(w, w.approver(), w.joiner(paired));
    await t.a.approve();
    await t.b.poll();
    const next = await w.approver().start();
    expect(await w.joiner(paired).start(next.code)).toMatchObject({ phase: "failed", reason: "has_vault" });
  });
});

describe("an approver that goes offline", () => {
  it("keeps its place when polling fails, and carries on when the network is back", async () => {
    const w = await world();
    const a = w.approver();
    const { code } = await a.start();
    await w.joiner().start(code);
    w.relay.failNext("pending", new TransportError("network"));
    const bad = await a.poll();
    expect(bad.phase).toBe("waiting");
    expect(bad.error).toMatchObject({ code: "network", retry: true });
    expect(bad.code).toBe(code);
    expect((await a.poll()).phase).toBe("confirm");
  });

  it("can retry an approval whose response was lost, without registering the device twice", async () => {
    const w = await world();
    const { a, b } = await toConfirm(w);
    w.relay.failNext("approve", new TransportError("network"), { afterStore: true });
    const lost = await a.approve();
    expect(lost.phase).toBe("confirm");
    expect(lost.error.retry).toBe(true);
    expect((await a.approve()).phase).toBe("approved");
    expect(w.relay.deviceIds()).toHaveLength(2);
    expect((await b.poll()).phase).toBe("joined");
  });

  it("can disappear after approving: the joiner still finishes", async () => {
    const w = await world();
    const { a, b } = await toConfirm(w);
    await a.approve();
    w.relay.failNext("pending", new TransportError("network")); // A is gone from here on
    expect((await b.poll()).phase).toBe("joined");
  });

  it("can cancel, leaving the slot to expire", async () => {
    const w = await world();
    const a = w.approver();
    const { code } = await a.start();
    expect(a.cancel().phase).toBe("cancelled");
    expect((await a.poll()).phase).toBe("cancelled");
    // The slot is still there until it times out, but nobody is listening.
    const b = w.joiner();
    expect((await b.start(code)).phase).toBe("waiting");
    w.clock.t += OPEN_MS + 1;
    expect((await b.poll()).phase).toBe("expired");
  });

  it("cannot start without a registered vault, or when the relay is down", async () => {
    const w = await world();
    const unregistered = { ...w.vaultA, vaultId: null };
    const a0 = createApprover({ transport: w.relay.approverTransport(w.vaultA.token), vault: unregistered });
    expect((await a0.start()).reason).toBe("not_registered");
    w.relay.failNext("open", new TransportError("network"));
    const a = w.approver();
    const res = await a.start();
    expect(res.phase).toBe("idle");
    expect(res.error.retry).toBe(true);
    expect((await a.start()).phase).toBe("waiting");
  });

  it("is refused by the relay with a device token it does not know", async () => {
    const w = await world();
    const a = createApprover({ transport: w.relay.approverTransport("nope"), vault: w.vaultA });
    const res = await a.start();
    expect(res.phase).toBe("idle");
    expect(res.error.code).toBe("auth");
  });
});
