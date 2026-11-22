import { describe, it, expect } from "vitest";
import { mintVaultId, verifyVaultId, VAULT_ID } from "../relay/ids.js";
import { safeEqual, sha256b64u } from "../relay/util.js";
import { isVaultId } from "../src/sync/codes.js";
import { tokenHash } from "../src/sync/crypto.js";
import { seededRandom } from "./relaySql.js";

const KEY = "route-key-0123456789abcdef";

describe("vault ids", () => {
  it("are minted in the shape the client's isVaultId accepts, and verify under the same key", async () => {
    const random = seededRandom(3);
    for (let i = 0; i < 20; i += 1) {
      const id = await mintVaultId(KEY, random);
      expect(isVaultId(id)).toBe(true);
      expect(VAULT_ID.source).toBe(/^[0-9a-f]{32}\.[0-9a-f]{16}$/.source);
      expect(await verifyVaultId(KEY, id)).toBe(true);
    }
  });

  it("are all different, and the same for the same random bytes", async () => {
    const ids = new Set();
    const random = seededRandom(9);
    for (let i = 0; i < 50; i += 1) ids.add(await mintVaultId(KEY, random));
    expect(ids.size).toBe(50);
    expect(await mintVaultId(KEY, seededRandom(1))).toBe(await mintVaultId(KEY, seededRandom(1)));
  });

  it("fail the mac check when the random part, the mac or the key is not the one that made them", async () => {
    const id = await mintVaultId(KEY, seededRandom(5));
    const [rand, mac] = id.split(".");
    const flip = (s) => (s[0] === "0" ? "1" : "0") + s.slice(1);
    expect(await verifyVaultId(KEY, `${flip(rand)}.${mac}`)).toBe(false);
    expect(await verifyVaultId(KEY, `${rand}.${flip(mac)}`)).toBe(false);
    expect(await verifyVaultId("another-route-key-0123456789", id)).toBe(false);
  });

  it("are false, never an error, for anything that is not an id", async () => {
    for (const junk of [undefined, null, 5, {}, "", "abc", `${"a".repeat(32)}.`, `${"a".repeat(32)}.${"b".repeat(15)}`,
      `${"A".repeat(32)}.${"b".repeat(16)}`, `${"a".repeat(32)}.${"b".repeat(16)}.x`, "../../etc/passwd"]) {
      expect(await verifyVaultId(KEY, junk)).toBe(false);
    }
  });

  it("refuse to work without a real secret", async () => {
    await expect(mintVaultId("short", seededRandom(1))).rejects.toThrow(/ROUTE_KEY/);
    await expect(verifyVaultId(undefined, "a".repeat(32) + "." + "b".repeat(16))).rejects.toThrow(/ROUTE_KEY/);
  });
});

describe("relay hashing", () => {
  it("hashes a token exactly as the client does, so the relay recognises what a device registered", async () => {
    for (const token of ["a".repeat(43), "tok-en_with-Chars0123456789abcdefghijklmnopqrs"]) {
      expect(await sha256b64u(token)).toBe(await tokenHash(token));
    }
  });
});

describe("safeEqual", () => {
  it("is plain equality, including for different lengths and non-strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("abcd", "abc")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual(null, "")).toBe(true);
    expect(safeEqual(undefined, "x")).toBe(false);
  });
});
