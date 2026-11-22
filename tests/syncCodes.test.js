import { describe, it, expect } from "vitest";
import {
  CodeError, INVITE_CHARS, JOIN_CHARS, RECOVERY_CHARS, base32Encode, checkHost, checkRelayUrl,
  decodeJoin, decodeRecoveryCode, encodeJoin, encodeRecoveryCode, formatInvite, inviteLink,
  isVaultId, joinLink, newInviteCode, normalize, parseInvite, parseInviteCode, relayUrlFor,
} from "../src/sync/codes.js";
import {
  createLocalVault, isRegistered, publicJwkOf, tokenHashOf, withVaultId,
} from "../src/sync/vault.js";
import { b64uDecode } from "../src/sync/crypto.js";
import { loadVault, saveVault } from "../src/sync/vaultStore.js";

const seq = (start = 1) => (n) => Uint8Array.from({ length: n }, (_, i) => (start + i * 7) & 0xff);
const real = (n) => crypto.getRandomValues(new Uint8Array(n));
const K = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 3) & 0xff);
const VID = `${"0123456789abcdef".repeat(2)}.fedcba9876543210`;
const join = () => ({
  host: "meter-relay.example.workers.dev", vaultId: VID, joinId: "00ff00ff00ff00ff",
  secret: Uint8Array.from({ length: 16 }, (_, i) => 200 - i),
});
const throwsCode = (fn, code) => {
  let err;
  try { fn(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(CodeError);
  if (code) expect(err.code).toBe(code);
  return err;
};
const same = (a, b) => expect([...a]).toEqual([...b]);
const flip = (c) => (c === "A" ? "B" : "A");

describe("base32 and normalising", () => {
  it("encodes with the Crockford alphabet, which has no I, L, O or U", () => {
    expect(base32Encode(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff))).toBe("ZZZZZZZZ");
    expect(base32Encode(Uint8Array.of(0, 0, 0, 0, 0))).toBe("00000000");
    expect(base32Encode(new Uint8Array(40).map((_, i) => i * 6))).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  it("ignores case, spaces, dashes and underscores, and folds O, I and L", () => {
    expect(normalize(" a-b_c d ")).toBe("ABCD");
    expect(normalize("oOiIlL")).toBe("001111");
  });
});

describe("recovery code", () => {
  it("is 64 characters in eight groups of eight", () => {
    const code = encodeRecoveryCode(K);
    expect(RECOVERY_CHARS).toBe(64);
    expect(code).toMatch(/^([0-9A-Z]{8}-){7}[0-9A-Z]{8}$/);
    expect(code).toHaveLength(71);
  });

  it("round-trips, and is stable for one key", () => {
    same(decodeRecoveryCode(encodeRecoveryCode(K)), K);
    expect(encodeRecoveryCode(K)).toBe(encodeRecoveryCode(K.slice()));
    for (let i = 0; i < 30; i += 1) {
      const key = seq(i + 9)(32);
      same(decodeRecoveryCode(encodeRecoveryCode(key)), key);
    }
  });

  it("accepts lower case, spaces, no separators and other dashes", () => {
    const code = encodeRecoveryCode(K);
    for (const form of [code.toLowerCase(), code.replace(/-/g, " "), code.replace(/-/g, ""), ` ${code}\n`, code.replace(/-/g, "--")]) {
      same(decodeRecoveryCode(form), K);
    }
  });

  it("tolerates the O/0 and I/1/L mix-ups", () => {
    // A key whose code has both a 0 and a 1, so the swap is really exercised.
    let key;
    let code;
    for (let i = 0; i < 200; i += 1) {
      key = seq(i)(32);
      code = encodeRecoveryCode(key);
      if (code.includes("0") && code.includes("1")) break;
    }
    expect(code).toMatch(/0/);
    expect(code).toMatch(/1/);
    same(decodeRecoveryCode(code.replace(/0/g, "O")), key);
    same(decodeRecoveryCode(code.replace(/1/g, "I")), key);
    same(decodeRecoveryCode(code.replace(/1/g, "l")), key);
  });

  it("rejects a changed character in every position, with a clear message", () => {
    const canonical = encodeRecoveryCode(K).replace(/-/g, "");
    for (let i = 0; i < canonical.length; i += 1) {
      const bent = canonical.slice(0, i) + flip(canonical[i]) + canonical.slice(i + 1);
      const err = throwsCode(() => decodeRecoveryCode(bent));
      expect(["checksum", "format"]).toContain(err.code);
    }
    const msg = throwsCode(() => decodeRecoveryCode(canonical.slice(0, 10) + flip(canonical[10]) + canonical.slice(11)), "checksum").message;
    expect(msg).toMatch(/mistyped/);
  });

  it("catches a transposition of two characters", () => {
    const c = encodeRecoveryCode(K).replace(/-/g, "");
    const i = [...c].findIndex((ch, j) => ch !== c[j + 1]);
    throwsCode(() => decodeRecoveryCode(c.slice(0, i) + c[i + 1] + c[i] + c.slice(i + 2)), "checksum");
  });

  it("rejects wrong length, characters outside the alphabet, and non-strings", () => {
    const code = encodeRecoveryCode(K);
    expect(throwsCode(() => decodeRecoveryCode(code.slice(0, -1)), "length").message).toMatch(/too short: 63 of 64/);
    throwsCode(() => decodeRecoveryCode(`${code}A`), "length");
    throwsCode(() => decodeRecoveryCode(""), "length");
    throwsCode(() => decodeRecoveryCode(null), "length");
    throwsCode(() => decodeRecoveryCode(code.replace(/^./, "U")), "char");
    throwsCode(() => decodeRecoveryCode(code.replace(/^./, "!")), "char");
    throwsCode(() => decodeRecoveryCode(code.replace(/^./, "é")), "char");
  });

  it("refuses to encode anything but 32 bytes", () => {
    throwsCode(() => encodeRecoveryCode(new Uint8Array(16)), "format");
    throwsCode(() => encodeRecoveryCode("nope"), "format");
  });

  it("rejects a key joined to another key's checksum", () => {
    const a = encodeRecoveryCode(K).replace(/-/g, "");
    const b = encodeRecoveryCode(seq(3)(32)).replace(/-/g, "");
    throwsCode(() => decodeRecoveryCode(a.slice(0, 52) + b.slice(52)), "checksum");
  });
});

describe("relay host", () => {
  it("accepts names, ports and this machine, lower-casing them", () => {
    expect(checkHost("Relay.Example.Workers.dev")).toBe("relay.example.workers.dev");
    expect(checkHost("a-b.example.com:8443")).toBe("a-b.example.com:8443");
    expect(checkHost("localhost:8787")).toBe("localhost:8787");
    expect(checkHost("127.0.0.1:47823")).toBe("127.0.0.1:47823");
  });

  it("rejects schemes, paths, credentials, bad ports and junk", () => {
    for (const bad of ["https://a.example.com", "a.example.com/x", "u@a.example.com", "a.example.com:0",
      "a.example.com:70000", "a.example.com:", "example", "-a.example.com", "a..example.com", "", null,
      "a b.example.com", "1.2.3.4", "10.0.0.1:80", `${"a".repeat(64)}.example.com`]) {
      throwsCode(() => checkHost(bad), "format");
    }
  });

  it("makes https urls, and http only for this machine", () => {
    expect(relayUrlFor("r.example.com")).toBe("https://r.example.com");
    expect(relayUrlFor("r.example.com:8443")).toBe("https://r.example.com:8443");
    expect(relayUrlFor("localhost:8787")).toBe("http://localhost:8787");
    expect(relayUrlFor("127.0.0.1")).toBe("http://127.0.0.1");
  });
});

describe("join code", () => {
  it("round-trips host, vault id, join id and secret", () => {
    const j = join();
    const out = decodeJoin(encodeJoin(j));
    expect(out.host).toBe(j.host);
    expect(out.vaultId).toBe(j.vaultId);
    expect(out.joinId).toBe(j.joinId);
    same(out.secret, j.secret);
  });

  it("has an 88 character code: grouped by four to type, bare in a link", () => {
    expect(JOIN_CHARS).toBe(88);
    const typed = encodeJoin(join());
    const slash = typed.indexOf("/");
    expect(typed.slice(0, slash)).toBe(join().host);
    expect(typed.slice(slash + 1)).toMatch(/^([0-9A-Z]{4}-){21}[0-9A-Z]{4}$/);
    expect(encodeJoin(join(), { grouped: false })).toMatch(/\/[0-9A-Z]{88}$/);
  });

  it("is a URL fragment, and decodes from a full link, a bare fragment or typed text", () => {
    const j = join();
    const link = joinLink("https://ahmed41022.github.io/meter/", j);
    expect(link.startsWith("https://ahmed41022.github.io/meter/#join=")).toBe(true);
    expect(link).not.toContain("?");
    const typed = encodeJoin(j);
    for (const form of [link, link.slice(link.indexOf("#")), typed, typed.toLowerCase(), typed.replace(/-(?=[0-9A-Z]{4})/g, " ")]) {
      expect(decodeJoin(form).vaultId).toBe(j.vaultId);
    }
    // Some messengers percent-encode the slash in a fragment.
    expect(decodeJoin(link.replace(/\/(?=[0-9A-Z]{88}$)/, "%2F")).host).toBe(j.host);
  });

  it("never contains the vault key", () => {
    const link = joinLink("https://x.example/meter/", join());
    // The body is version, vault id, join id, S and a checksum: 55 bytes, so
    // there is no room for a 32-byte key beside them, and the link does not
    // carry the recovery code form of one either.
    expect(link.slice(link.lastIndexOf("/") + 1)).toHaveLength(88);
    expect(link).not.toContain(encodeRecoveryCode(K).replace(/-/g, ""));
    expect(link).not.toContain(base32Encode(K));
    expect(Object.keys(decodeJoin(link)).sort()).toEqual(["host", "joinId", "secret", "vaultId"]);
  });

  it("builds links with a fragment only, and refuses a base that has a query or fragment", () => {
    const link = joinLink("https://ahmed41022.github.io/meter/", join());
    expect(new URL(link).search).toBe("");
    expect(new URL(link).hash.startsWith("#join=")).toBe(true);
    throwsCode(() => joinLink("https://x.example/?a=1", join()), "format");
    throwsCode(() => joinLink("https://x.example/#a", join()), "format");
  });

  it("rejects a join code that arrives in a query string, however it is dressed", () => {
    const code = encodeJoin(join(), { grouped: false });
    for (const bad of [`https://x.example/meter/?join=${code}`, `https://x.example/meter/?x=1#join=${code}`,
      `?join=${code}`, `${code}?x`, `https://x.example/meter/#join=${code}?x=1`]) {
      throwsCode(() => decodeJoin(bad), "format");
    }
  });

  it("rejects every malformed input", () => {
    const good = encodeJoin(join(), { grouped: false });
    const code = good.slice(good.indexOf("/") + 1);
    const host = join().host;
    const bads = [
      ["", "format"], [null, "format"], [undefined, "format"], ["nonsense", "format"], [host, "format"],
      [`/${code}`, "format"], [`${host}/`, "length"], [`${host}/${code.slice(1)}`, "length"],
      [`${host}/${code}A`, "length"], [`https://${host}/${code}`, "format"],
      [`${host}/${code.replace(/^./, "U")}`, "char"], [`${host}/${code.replace(/^./, "!")}`, "char"],
      [`#nojoin=${host}/${code}`, "format"], [`#join=${host}/${code}&x=1`, "format"],
      ["#join=%E0%A4%A", "format"], [`#join=${host}/${code}#more`, "format"],
      [`other.example.com/${code}`, "checksum"], [`${host}/${code.replace(/^./, flip(code[0]))}`, "checksum"],
      [`${host.toUpperCase()}:99999/${code}`, "format"],
    ];
    for (const [bad, kind] of bads) throwsCode(() => decodeJoin(bad), kind);
  });

  it("detects a changed character anywhere in the code", () => {
    const good = encodeJoin(join(), { grouped: false });
    for (let i = good.indexOf("/") + 1; i < good.length; i += 1) {
      throwsCode(() => decodeJoin(good.slice(0, i) + flip(good[i]) + good.slice(i + 1)));
    }
  });

  it("refuses to encode bad parts", () => {
    const j = join();
    throwsCode(() => encodeJoin({ ...j, host: "https://x.example.com" }), "format");
    throwsCode(() => encodeJoin({ ...j, vaultId: "abc" }), "format");
    throwsCode(() => encodeJoin({ ...j, joinId: "xyz" }), "format");
    throwsCode(() => encodeJoin({ ...j, secret: new Uint8Array(15) }), "format");
  });

  it("accepts the relay on this machine", () => {
    expect(decodeJoin(encodeJoin({ ...join(), host: "127.0.0.1:8787" })).host).toBe("127.0.0.1:8787");
  });
});

describe("invite code", () => {
  it("is MTR- plus 20 characters, generated from the random source", () => {
    expect(newInviteCode(seq())).toMatch(/^MTR-[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(INVITE_CHARS).toBe(20);
    expect(newInviteCode(real)).not.toBe(newInviteCode(real));
  });

  it("formats in groups of five and parses back", () => {
    const code = newInviteCode(seq(5));
    const shown = formatInvite(code);
    expect(shown).toMatch(/^MTR-([0-9A-Z]{5}-){3}[0-9A-Z]{5}$/);
    expect(parseInviteCode(shown)).toBe(code);
    expect(parseInviteCode(shown.toLowerCase())).toBe(code);
    expect(parseInviteCode(shown.replace(/-/g, " "))).toBe(code);
    expect(parseInviteCode(code.replace("MTR-", "mtr"))).toBe(code);
  });

  it("folds O, I and L in the body but not in the prefix", () => {
    expect(parseInviteCode("MTR-OIL0000000000000000O")).toBe("MTR-01100000000000000000");
    throwsCode(() => parseInviteCode("MT0-00000000000000000000"), "format");
  });

  it("rejects malformed codes", () => {
    for (const [bad, kind] of [["", "format"], [null, "format"], ["MTR-", "length"], ["MTR-123", "length"],
      ["MTR-000000000000000000000", "length"], ["XYZ-00000000000000000000", "format"],
      ["MTR-0000000000000000000U", "char"], ["MTR-0000000000000000000!", "char"]]) {
      throwsCode(() => parseInviteCode(bad), kind);
    }
  });

  it("builds and reads a fragment link, with or without a relay", () => {
    const code = newInviteCode(seq(2));
    const link = inviteLink("https://ahmed41022.github.io/meter/", code, "https://relay.example.workers.dev");
    expect(link).toBe(`https://ahmed41022.github.io/meter/#invite=${code}&relay=https%3A%2F%2Frelay.example.workers.dev`);
    expect(new URL(link).search).toBe("");
    expect(parseInvite(link)).toEqual({ code, relay: "https://relay.example.workers.dev" });
    expect(parseInvite(link.slice(link.indexOf("#")))).toEqual({ code, relay: "https://relay.example.workers.dev" });
    expect(parseInvite(inviteLink("https://x.example/meter/", code))).toEqual({ code, relay: null });
    expect(parseInvite(formatInvite(code))).toEqual({ code, relay: null });
  });

  it("rejects an invite in a query string, stray or repeated parameters, and bad relays", () => {
    const code = newInviteCode(seq(2));
    for (const bad of [`https://x.example/meter/?invite=${code}`, `https://x.example/?a=1#invite=${code}`,
      "#relay=https%3A%2F%2Fr.example.com", `#invite=${code}&other=1`, `#invite=${code}&invite=${code}`,
      `#invite=${code}&relay=http%3A%2F%2Fr.example.com`, `#invite=${code}&relay=https%3A%2F%2Fr.example.com%2Fpath`,
      `#invite=${code}&relay=https%3A%2F%2Fu%3Ap%40r.example.com`, `#invite=${code}&relay=ftp%3A%2F%2Fr.example.com`,
      `#invite=${code}&relay=junk`, "#invite=MTR-short", "#"]) {
      throwsCode(() => parseInvite(bad));
    }
    expect(checkRelayUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(checkRelayUrl("https://r.example.com/")).toBe("https://r.example.com");
    throwsCode(() => inviteLink("https://x.example/?q", code), "format");
  });
});

describe("no secret in a query string", () => {
  it("every link builder puts things after # and none before", () => {
    const code = newInviteCode(seq());
    const links = [joinLink("https://x.example/meter/", join()), inviteLink("https://x.example/meter/", code, "https://r.example.com")];
    for (const l of links) {
      expect(l.includes("?")).toBe(false);
      expect(new URL(l).search).toBe("");
      expect(l.slice(0, l.indexOf("#"))).toBe("https://x.example/meter/");
    }
  });
});

describe("a local vault", () => {
  const relay = "https://relay.example.workers.dev";

  it("is made with K, epoch 1, device id, token and an ECDH pair, and no vault id yet", async () => {
    const v = await createLocalVault({ relay });
    expect(v.vaultId).toBeNull();
    expect(isRegistered(v)).toBe(false);
    expect(v.epoch).toBe(1);
    expect(b64uDecode(v.K)).toHaveLength(32);
    expect(b64uDecode(v.token)).toHaveLength(32);
    expect(v.deviceId).toMatch(/^[0-9a-f]{16}$/);
    expect(v.privateJwk.d).toBeTruthy();
    expect(publicJwkOf(v).d).toBeUndefined();
    expect(v.relay).toBe(relay);
    expect(v.invite).toBeNull();
  });

  it("is different every time, and predictable with an injected random source", async () => {
    const a = await createLocalVault({ relay });
    const b = await createLocalVault({ relay });
    expect(a.K).not.toBe(b.K);
    expect(a.token).not.toBe(b.token);
    const c = await createLocalVault({ relay }, { random: seq() });
    const d = await createLocalVault({ relay }, { random: seq() });
    expect({ ...c, privateJwk: 0 }).toEqual({ ...d, privateJwk: 0 });
  });

  it("keeps the invite canonical and checks the relay address", async () => {
    const code = newInviteCode(seq());
    expect((await createLocalVault({ relay, invite: formatInvite(code).toLowerCase() })).invite).toBe(code);
    await expect(createLocalVault({ relay: "http://evil.example.com" })).rejects.toBeInstanceOf(CodeError);
    await expect(createLocalVault({ relay, invite: "bad" })).rejects.toBeInstanceOf(CodeError);
  });

  it("survives being saved before registration and registers with the same identity", async () => {
    const ls = new Map();
    const win = { localStorage: { getItem: (k) => ls.get(k) ?? null, setItem: (k, x) => ls.set(k, String(x)), removeItem: (k) => ls.delete(k) } };
    const made = await createLocalVault({ relay, invite: newInviteCode(seq()) });
    expect(saveVault(made, win)).toBe(true);
    const back = loadVault(win);
    expect(back).toEqual(made);
    expect(await tokenHashOf(back)).toBe(await tokenHashOf(made));
    const done = withVaultId(back, VID);
    expect(done.vaultId).toBe(VID);
    expect(done.invite).toBeNull();
    expect(isRegistered(done)).toBe(true);
    expect(done.K).toBe(made.K);
    expect(saveVault(done, win)).toBe(true);
    expect(loadVault(win).vaultId).toBe(VID);
  });

  it("rejects a malformed vault id from the relay", async () => {
    const v = await createLocalVault({ relay });
    for (const bad of ["", "abc", `${VID}x`, VID.toUpperCase(), null, 5]) throwsCode(() => withVaultId(v, bad), "format");
    expect(isVaultId(VID)).toBe(true);
  });

  it("hashes the token the way the relay will see it, as 32 bytes in base64url", async () => {
    const v = await createLocalVault({ relay });
    expect(b64uDecode(await tokenHashOf(v))).toHaveLength(32);
    expect(await tokenHashOf(v)).not.toContain(v.token);
  });
});
