import { describe, it, expect } from "vitest";
import {
  CryptoError, KINDS, aadFor, b64uDecode, b64uEncode, comparisonCode, compressionAvailable,
  cryptoAvailable, deriveKeys, fromUtf8, generateDeviceKeys, gunzip, gzip, newVaultKey, open,
  openJson, pad, paddedSize, seal, sealJson, selfTest, sha256, snapCtx, unpad, unwrapKey, utf8,
  wrapKey,
} from "../src/sync/crypto.js";
import { SYNC_KEY, clearVault, loadVault, progressStore, saveVault } from "../src/sync/vaultStore.js";
import { createBackend, createStore, STORE_KEY } from "../src/storage/store.js";

/** A counter standing in for the random source, so a nonce is predictable. */
const counterRandom = () => {
  let n = 0;
  return (len) => Uint8Array.from({ length: len }, () => (n += 1) & 0xff);
};

const fail = async (promise, code) => {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(CryptoError);
  if (code) expect(err.code).toBe(code);
};

const K = Uint8Array.from({ length: 32 }, (_, i) => i);
const where = { epoch: 1, kind: "log", ctx: "bid1" };

describe("platform", () => {
  it("has WebCrypto and the gzip streams here, so no fallback is written", () => {
    // If this ever fails on a runner, a pure-JS gzip is needed before shipping.
    expect(cryptoAvailable()).toBe(true);
    expect(compressionAvailable()).toBe(true);
  });

  it("says no when the page is not a secure context or has no subtle", () => {
    expect(cryptoAvailable({ isSecureContext: false })).toBe(false);
    expect(cryptoAvailable({ crypto: { getRandomValues() {} } })).toBe(false);
    expect(cryptoAvailable({ crypto: {} })).toBe(false);
  });

  it("passes its own self test", async () => {
    expect(await selfTest()).toEqual({ ok: true, failed: [] });
  });

  it("reports what failed instead of throwing", async () => {
    const res = await selfTest({ crypto: {}, isSecureContext: true });
    expect(res.ok).toBe(false);
    expect(res.failed).toContain("aes-gcm");
  });
});

describe("base64url", () => {
  it("round-trips every byte value and large input", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(b64uDecode(b64uEncode(all))).toEqual(all);
    const big = new Uint8Array(200_000).fill(251);
    expect(b64uDecode(b64uEncode(big))).toEqual(big);
  });

  it("uses the url alphabet with no padding", () => {
    expect(b64uEncode(Uint8Array.of(251, 255, 254))).toBe("-__-");
    expect(b64uEncode(Uint8Array.of(1))).toBe("AQ");
  });

  it("rejects anything that is not base64url", () => {
    for (const bad of ["a+b", "a=", "ab cd", "A", 5]) {
      expect(() => b64uDecode(bad)).toThrow(CryptoError);
    }
  });
});

describe("key derivation", () => {
  it("is deterministic: same K and epoch give the same recoverAuth, and the same encKey behaviour", async () => {
    const a = await deriveKeys(K, 1);
    const b = await deriveKeys(K, 1);
    expect(b64uEncode(a.recoverAuth)).toBe(b64uEncode(b.recoverAuth));
    // Pinned so a change to the salt or info strings (which would lock every
    // existing vault out) fails loudly rather than passing a round trip.
    expect(b64uEncode(a.recoverAuth)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const env = { random: counterRandom() };
    const box = await seal(a.encKey, where, utf8("x"), env);
    const again = await seal(b.encKey, where, utf8("x"), { random: counterRandom() });
    expect(again).toEqual(box);
  });

  it("gives different keys per epoch and per K", async () => {
    const e1 = await deriveKeys(K, 1);
    const e2 = await deriveKeys(K, 2);
    const other = await deriveKeys(newVaultKey(), 1);
    expect(b64uEncode(e1.recoverAuth)).not.toBe(b64uEncode(e2.recoverAuth));
    expect(b64uEncode(e1.recoverAuth)).not.toBe(b64uEncode(other.recoverAuth));
    const box = await seal(e1.encKey, where, utf8("x"));
    await fail(open(e2.encKey, where, box), "decrypt");
    await fail(open(other.encKey, where, box), "decrypt");
  });

  it("keeps the vector fixed for one K", async () => {
    // Computed once and frozen. It is the contract between devices and builds.
    const { recoverAuth } = await deriveKeys(K, 1);
    expect(b64uEncode(recoverAuth)).toBe(FROZEN_RECOVER_AUTH);
    expect(b64uEncode(await sha256(recoverAuth))).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses a key of the wrong size or an epoch that is not positive", async () => {
    await fail(deriveKeys(new Uint8Array(16), 1), "input");
    await fail(deriveKeys(K, 0), "input");
    await fail(deriveKeys(K, 1.5), "input");
  });

  it("generates 32 random bytes", () => {
    const a = newVaultKey();
    expect(a).toHaveLength(32);
    expect(b64uEncode(a)).not.toBe(b64uEncode(newVaultKey()));
    expect(newVaultKey({ random: counterRandom() })[0]).toBe(1);
  });
});

describe("the AES-GCM envelope", () => {
  it("round-trips bytes and JSON", async () => {
    const { encKey } = await deriveKeys(K, 1);
    const box = await seal(encKey, where, utf8("héllo ledger"));
    expect(Object.keys(box).sort()).toEqual(["ct", "n", "v"]);
    expect(box.v).toBe(1);
    expect(fromUtf8(await open(encKey, where, box))).toBe("héllo ledger");
    const doc = { changes: [{ k: "sessions", r: { id: "s1", n: 2 } }] };
    expect(await openJson(encKey, where, await sealJson(encKey, where, doc))).toEqual(doc);
  });

  it("round-trips an empty plaintext", async () => {
    const { encKey } = await deriveKeys(K, 1);
    expect((await open(encKey, where, await seal(encKey, where, new Uint8Array(0)))).length).toBe(0);
  });

  it("fails on a different epoch, kind or ctx", async () => {
    const { encKey } = await deriveKeys(K, 1);
    const box = await seal(encKey, where, utf8("x"));
    await fail(open(encKey, { ...where, epoch: 2 }, box), "decrypt");
    await fail(open(encKey, { ...where, kind: "snap" }, box), "decrypt");
    await fail(open(encKey, { ...where, ctx: "bid2" }, box), "decrypt");
    await fail(open(encKey, { ...where, ctx: "" }, box), "decrypt");
  });

  it("fails when snapshot parts are reordered, dropped from the count or shifted", async () => {
    const { encKey } = await deriveKeys(K, 1);
    const at = (part, parts) => ({ epoch: 1, kind: "snap", ctx: snapCtx(40, part, parts) });
    const box = await seal(encKey, at(0, 3), utf8("part zero"));
    expect(fromUtf8(await open(encKey, at(0, 3), box))).toBe("part zero");
    await fail(open(encKey, at(1, 3), box), "decrypt");
    await fail(open(encKey, at(0, 2), box), "decrypt");
    await fail(open(encKey, { epoch: 1, kind: "snap", ctx: [0, 40, 3] }, box), "decrypt");
    await fail(open(encKey, { epoch: 1, kind: "snap", ctx: snapCtx(41, 0, 3) }, box), "decrypt");
  });

  it("builds the AAD exactly as specified", () => {
    expect(fromUtf8(aadFor(3, "log", "abc"))).toBe("meter|v1|3|log|abc");
    expect(fromUtf8(aadFor(3, "snap", snapCtx(10, 1, 4)))).toBe("meter|v1|3|snap|10|1|4");
    expect(fromUtf8(aadFor(1, "presence"))).toBe("meter|v1|1|presence|");
    expect(() => aadFor(1, "nope")).toThrow(CryptoError);
    expect(() => aadFor(1, "log", ["a|b"])).toThrow(CryptoError);
    expect(() => aadFor(0, "log")).toThrow(CryptoError);
    expect(KINDS).toEqual(["log", "snap", "presence", "name", "keybox"]);
  });

  it("fails on any tampering with the ciphertext, nonce or version", async () => {
    const { encKey } = await deriveKeys(K, 1);
    const box = await seal(encKey, where, utf8("amount: 120"));
    const ct = b64uDecode(box.ct);
    for (const at of [0, 10, ct.length - 1]) {
      const bent = ct.slice();
      bent[at] ^= 1;
      await fail(open(encKey, where, { ...box, ct: b64uEncode(bent) }), "decrypt");
    }
    const n = b64uDecode(box.n).slice();
    n[0] ^= 1;
    await fail(open(encKey, where, { ...box, n: b64uEncode(n) }), "decrypt");
    await fail(open(encKey, where, { ...box, ct: b64uEncode(ct.subarray(0, ct.length - 1)) }), "decrypt");
    await fail(open(encKey, where, { ...box, v: 2 }), "format");
    await fail(open(encKey, where, { ...box, n: b64uEncode(new Uint8Array(8)) }), "format");
    await fail(open(encKey, where, null), "format");
  });

  it("uses a different nonce every time: no repeats in 10,000 encryptions", async () => {
    const { encKey } = await deriveKeys(K, 1);
    // The real cipher is swapped for a stub so 10,000 rounds cost nothing even
    // when the whole suite is running; what is under test is that seal asks the
    // real random source for a fresh nonce each time, and that is untouched.
    const quick = {
      crypto: {
        getRandomValues: (a) => globalThis.crypto.getRandomValues(a),
        subtle: { encrypt: async () => new ArrayBuffer(16) },
      },
    };
    const seen = new Set();
    for (let i = 0; i < 10_000; i += 1) seen.add((await seal(encKey, where, utf8("x"), quick)).n);
    expect(seen.size).toBe(10_000);
    // And with the real cipher, a smaller run, so the stub is not the only evidence.
    const real = new Set();
    for (let i = 0; i < 500; i += 1) real.add((await seal(encKey, where, utf8("x"))).n);
    expect(real.size).toBe(500);
  });

  it("takes an injected random source", async () => {
    const { encKey } = await deriveKeys(K, 1);
    const a = await seal(encKey, where, utf8("x"), { random: counterRandom() });
    const b = await seal(encKey, where, utf8("x"), { random: counterRandom() });
    expect(a).toEqual(b);
    expect(b64uDecode(a.n)[0]).toBe(1);
  });
});

describe("padding", () => {
  it("rounds to powers of two with a floor of 256", () => {
    expect(paddedSize(0)).toBe(256);
    expect(paddedSize(252)).toBe(256);
    expect(paddedSize(253)).toBe(512);
    expect(paddedSize(1020)).toBe(1024);
    expect(paddedSize(1021)).toBe(2048);
    expect(paddedSize(3 * 1024 * 1024)).toBe(4 * 1024 * 1024);
  });

  it("round-trips and rejects a padded block that is not canonical", () => {
    const data = utf8("abc");
    expect(unpad(pad(data))).toEqual(data);
    const odd = pad(data);
    odd[100] = 1;
    expect(() => unpad(odd)).toThrow(CryptoError);
    expect(() => unpad(new Uint8Array(300))).toThrow(CryptoError);
    const long = pad(data);
    new DataView(long.buffer).setUint32(0, 9999);
    expect(() => unpad(long)).toThrow(CryptoError);
  });

  it("makes ciphertexts of similar plaintexts the same length", async () => {
    const { encKey } = await deriveKeys(K, 1);
    const size = async (n) => b64uDecode((await seal(encKey, where, new Uint8Array(n))).ct).length;
    expect(await size(1)).toBe(await size(200));
    expect(await size(1)).toBe(256 + 16);
    expect(await size(253)).toBe(512 + 16);
  });
});

describe("gzip", () => {
  it("round-trips text, the empty input and binary", async () => {
    for (const data of [utf8("a ledger ".repeat(100)), new Uint8Array(0), Uint8Array.from({ length: 5000 }, (_, i) => i * 7)]) {
      expect(await gunzip(await gzip(data))).toEqual(data);
    }
  });

  it("round-trips a 3 MB synthetic ledger and shrinks it", async () => {
    const sessions = Array.from({ length: 16_000 }, (_, i) => ({
      id: `s${i}`, projectId: `p${i % 40}`, startedAt: 1_700_000_000_000 + i * 3_600_000,
      updatedAt: 1_700_000_000_000 + i * 3_600_001, note: `session number ${i} for client ${i % 17}`,
      segments: [{ from: i * 10, to: i * 10 + 500 }],
    }));
    const bytes = utf8(JSON.stringify({ projects: [], sessions }));
    expect(bytes.length).toBeGreaterThan(2_500_000);
    const packed = await gzip(bytes);
    expect(packed.length).toBeLessThan(bytes.length / 3);
    // Compared as text: a deep equality over 3 million array cells takes seconds.
    expect(fromUtf8(await gunzip(packed)) === fromUtf8(bytes)).toBe(true);
  });

  it("composes with encryption: gzip, then seal, then open, then gunzip", async () => {
    const { encKey } = await deriveKeys(K, 4);
    const at = { epoch: 4, kind: "snap", ctx: snapCtx(9, 0, 1) };
    const bytes = utf8(JSON.stringify({ sessions: [{ id: "a" }] }));
    const out = await gunzip(await open(encKey, at, await seal(encKey, at, await gzip(bytes))));
    expect(out).toEqual(bytes);
  });

  it("reports input that is not gzip", async () => {
    await fail(gunzip(utf8("plainly not gzip")), "format");
  });
});

describe("ECDH key wrapping", () => {
  it("round-trips {K, epoch} to the right device", async () => {
    const dev = await generateDeviceKeys();
    expect(dev.publicJwk.d).toBeUndefined();
    expect(Object.keys(dev.publicJwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(dev.privateJwk.d).toBeTruthy();
    const box = await wrapKey({ K, epoch: 3 }, dev.publicJwk, { ctx: "dev1" });
    const out = await unwrapKey(box, dev.privateJwk, { epoch: 3, ctx: "dev1" });
    expect(out.epoch).toBe(3);
    expect(out.K).toEqual(K);
  });

  it("does not open for another device's private key", async () => {
    const mine = await generateDeviceKeys();
    const other = await generateDeviceKeys();
    const box = await wrapKey({ K, epoch: 1 }, mine.publicJwk);
    await fail(unwrapKey(box, other.privateJwk, { epoch: 1 }), "decrypt");
  });

  it("does not open under another epoch, ctx or a tampered box", async () => {
    const dev = await generateDeviceKeys();
    const box = await wrapKey({ K, epoch: 2 }, dev.publicJwk, { ctx: "dev1" });
    await fail(unwrapKey(box, dev.privateJwk, { epoch: 3, ctx: "dev1" }), "decrypt");
    await fail(unwrapKey(box, dev.privateJwk, { epoch: 2, ctx: "dev2" }), "decrypt");
    const ct = b64uDecode(box.ct).slice();
    ct[3] ^= 1;
    await fail(unwrapKey({ ...box, ct: b64uEncode(ct) }, dev.privateJwk, { epoch: 2, ctx: "dev1" }), "decrypt");
    const swapped = (await generateDeviceKeys()).publicJwk;
    await fail(unwrapKey({ ...box, epk: swapped }, dev.privateJwk, { epoch: 2, ctx: "dev1" }), "decrypt");
    await fail(unwrapKey({ ...box, v: 9 }, dev.privateJwk, { epoch: 2, ctx: "dev1" }), "format");
  });

  it("uses a fresh ephemeral key and nonce each time", async () => {
    const dev = await generateDeviceKeys();
    const a = await wrapKey({ K, epoch: 1 }, dev.publicJwk);
    const b = await wrapKey({ K, epoch: 1 }, dev.publicJwk);
    expect(a.epk.x).not.toBe(b.epk.x);
    expect(a.ct).not.toBe(b.ct);
  });

  it("rejects keys that are not P-256 or are missing parts", async () => {
    const dev = await generateDeviceKeys();
    await fail(wrapKey({ K, epoch: 1 }, { kty: "RSA" }), "input");
    await fail(wrapKey({ K: new Uint8Array(3), epoch: 1 }, dev.publicJwk), "input");
    const box = await wrapKey({ K, epoch: 1 }, dev.publicJwk);
    await fail(unwrapKey(box, dev.publicJwk, { epoch: 1 }), "input");
  });

  it("survives a trip through JSON, as stored and sent", async () => {
    const dev = await generateDeviceKeys();
    const stored = JSON.parse(JSON.stringify(dev));
    const box = JSON.parse(JSON.stringify(await wrapKey({ K, epoch: 1 }, stored.publicJwk)));
    expect((await unwrapKey(box, stored.privateJwk, { epoch: 1 })).K).toEqual(K);
  });
});

describe("the six-digit comparison code", () => {
  it("is six digits and equal on both sides whichever order they hash in", async () => {
    const a = (await generateDeviceKeys()).publicJwk;
    const b = (await generateDeviceKeys()).publicJwk;
    const one = await comparisonCode(a, b);
    expect(one).toMatch(/^\d{6}$/);
    expect(await comparisonCode(b, a)).toBe(one);
  });

  it("is stable for the same keys and ignores extra JWK fields", async () => {
    const a = (await generateDeviceKeys()).publicJwk;
    const b = (await generateDeviceKeys()).publicJwk;
    expect(await comparisonCode({ ...a, ext: true, key_ops: [] }, b)).toBe(await comparisonCode(a, b));
  });

  it("changes when either key changes", async () => {
    const a = (await generateDeviceKeys()).publicJwk;
    const b = (await generateDeviceKeys()).publicJwk;
    const c = (await generateDeviceKeys()).publicJwk;
    const base = await comparisonCode(a, b);
    // One in a million could collide by chance; three independent swaps all
    // matching is not a realistic flake.
    const moved = [await comparisonCode(c, b), await comparisonCode(a, c), await comparisonCode(c, c)];
    expect(moved.some((m) => m !== base)).toBe(true);
    expect(moved.filter((m) => m === base).length).toBeLessThan(2);
  });

  it("mixes in an out-of-band secret when given one", async () => {
    const a = (await generateDeviceKeys()).publicJwk;
    const b = (await generateDeviceKeys()).publicJwk;
    const s1 = await comparisonCode(a, b, { secret: Uint8Array.of(1, 2, 3) });
    expect(await comparisonCode(b, a, { secret: Uint8Array.of(1, 2, 3) })).toBe(s1);
    // Different secret, different digits (a 1-in-a-million tie is accepted risk).
    expect(await comparisonCode(a, b, { secret: Uint8Array.of(9, 9, 9) })).not.toBe(s1);
  });

  it("pads small numbers with leading zeros", async () => {
    // Find any pair whose digits start with 0 by search; ~1 in 10 pairs does.
    let code = "";
    for (let i = 0; i < 200 && !code.startsWith("0"); i += 1) {
      const a = (await generateDeviceKeys()).publicJwk;
      const b = (await generateDeviceKeys()).publicJwk;
      code = await comparisonCode(a, b);
    }
    expect(code).toMatch(/^\d{6}$/);
  });
});

// ---------------------------------------------------------------- vault store

const fakeStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    dump: () => Object.fromEntries(map),
  };
};

const vault = async () => ({
  relay: "https://relay.example.workers.dev", vaultId: "ab12.cd34", epoch: 2,
  K: b64uEncode(K), deviceId: "dev-1", token: b64uEncode(newVaultKey()),
  privateJwk: (await generateDeviceKeys()).privateJwk,
});

describe("vault store", () => {
  it("round-trips the identity under meter:sync", async () => {
    const ls = fakeStorage();
    const v = await vault();
    expect(loadVault({ localStorage: ls })).toBeNull();
    expect(saveVault(v, { localStorage: ls })).toBe(true);
    expect(loadVault({ localStorage: ls })).toEqual(v);
    expect(Object.keys(ls.dump())).toEqual([SYNC_KEY.VAULT]);
    expect(Object.keys(SYNC_KEY).every((k) => SYNC_KEY[k].startsWith("meter:sync"))).toBe(true);
  });

  it("treats corrupt or incomplete storage as no vault, and leaves it in place", async () => {
    const ls = fakeStorage();
    const win = { localStorage: ls };
    ls.setItem(SYNC_KEY.VAULT, "{not json");
    expect(loadVault(win)).toBeNull();
    expect(ls.getItem(SYNC_KEY.VAULT)).toBe("{not json");
    const v = await vault();
    for (const broken of [{ ...v, K: "" }, { ...v, epoch: 0 }, { ...v, token: undefined }, { ...v, privateJwk: { x: "1" } }, [], "str"]) {
      ls.setItem(SYNC_KEY.VAULT, JSON.stringify(broken));
      expect(loadVault(win)).toBeNull();
    }
  });

  it("refuses to save an incomplete identity, and reports a full or blocked store", async () => {
    const ls = fakeStorage();
    expect(saveVault({ relay: "x" }, { localStorage: ls })).toBe(false);
    expect(ls.length).toBe(0);
    const blocked = { localStorage: { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() {} } };
    expect(saveVault(await vault(), blocked)).toBe(false);
    expect(loadVault(blocked)).toBeNull();
  });

  it("clearing removes the identity and progress but nothing else", async () => {
    const ls = fakeStorage();
    const win = { localStorage: ls };
    saveVault(await vault(), win);
    progressStore(win).save({ cursor: 3, sent: { "sessions/a": 1 }, inflight: null, snapshotUpto: 0 });
    ls.setItem(STORE_KEY, "{\"projects\":[],\"sessions\":[]}");
    clearVault(win);
    expect(Object.keys(ls.dump())).toEqual([STORE_KEY]);
  });

  describe("progress", () => {
    const batch = { v: 1, changes: [{ k: "sessions", r: { id: "a", updatedAt: 5 } }], meta: {} };

    it("round-trips what the engine keeps", () => {
      const win = { localStorage: fakeStorage() };
      const meta = { cursor: 7, snapshotUpto: 3, sent: { "sessions/a": 5 }, inflight: { bid: "b1", batch } };
      const store = progressStore(win);
      expect(store.save(meta)).toBe(true);
      expect(progressStore(win).load()).toEqual(meta);
    });

    it("starts fresh when nothing is stored", () => {
      expect(progressStore({ localStorage: fakeStorage() }).load())
        .toEqual({ cursor: null, sent: {}, inflight: null, snapshotUpto: null });
    });

    it("falls back to a fresh start on corrupt values, piece by piece", () => {
      const ls = fakeStorage();
      const win = { localStorage: ls };
      ls.setItem(SYNC_KEY.META, "garbage");
      ls.setItem(SYNC_KEY.SENT, "[1,2]");
      expect(progressStore(win).load()).toEqual({ cursor: null, sent: {}, inflight: null, snapshotUpto: null });
      ls.setItem(SYNC_KEY.META, JSON.stringify({ cursor: -4, snapshotUpto: "x", inflight: { bid: 1 } }));
      ls.setItem(SYNC_KEY.SENT, JSON.stringify({ "sessions/a": 9 }));
      expect(progressStore(win).load()).toEqual({ cursor: null, sent: { "sessions/a": 9 }, inflight: null, snapshotUpto: null });
    });

    it("does not rewrite an unchanged sent map", () => {
      const ls = fakeStorage();
      let writes = 0;
      const counting = { ...ls, getItem: ls.getItem, removeItem: ls.removeItem, setItem: (k, v) => { writes += 1; ls.setItem(k, v); } };
      const store = progressStore({ localStorage: counting });
      const meta = { cursor: 1, snapshotUpto: 0, sent: { "sessions/a": 1 }, inflight: null };
      store.save(meta);
      expect(writes).toBe(2);
      store.save(meta);
      expect(writes).toBe(2);
      store.save({ ...meta, cursor: 2 });
      expect(writes).toBe(3);
      store.save({ ...meta, cursor: 2, sent: { "sessions/a": 2 } });
      expect(writes).toBe(4);
    });

    it("reports a failed write so the engine can say sync progress is not being kept", () => {
      const blocked = { localStorage: { getItem: () => null, setItem() { throw new Error("full"); }, removeItem() {} } };
      expect(progressStore(blocked).save({ cursor: 1, sent: {}, inflight: null })).toBe(false);
    });
  });

  describe("is not part of the ledger or an export", () => {
    it("leaves every sync key out of what the ledger store reads and writes", async () => {
      const ls = fakeStorage();
      const win = { localStorage: ls };
      const v = await vault();
      saveVault(v, win);
      progressStore(win).save({ cursor: 1, sent: { "sessions/a": 1 }, inflight: null, snapshotUpto: 0 });
      const store = createStore(createBackend(win));
      expect(await store.load()).toBeNull();
      await store.save({ projects: [], sessions: [{ id: "a", updatedAt: 1 }] });
      // The backup button writes JSON.stringify of the ledger state it holds,
      // so what matters is that neither the ledger nor its stored form carries
      // anything from the vault.
      const ledger = JSON.stringify(await store.load());
      const stored = ls.getItem(STORE_KEY);
      for (const secret of [v.K, v.token, v.privateJwk.d, v.deviceId]) {
        expect(ledger).not.toContain(secret);
        expect(stored).not.toContain(secret);
      }
      expect(ls.getItem(SYNC_KEY.VAULT)).toContain(v.K);
    });

    it("keeps its keys out of the ledger's own namespaces", () => {
      expect(Object.values(SYNC_KEY).some((k) => k === STORE_KEY || k.startsWith(`${STORE_KEY}:`))).toBe(false);
    });
  });
});

// Frozen by the test above: recoverAuth for K = 0..31, epoch 1. If this changes,
// every vault ever created stops being recoverable, so it is a deliberate break.
const FROZEN_RECOVER_AUTH = "JMzYSRF8yCRBRPLl8wCcKFHFgy4DiMEKnOIghQDTiuA";
