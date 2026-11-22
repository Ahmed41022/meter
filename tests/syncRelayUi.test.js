/**
 * The pure parts behind the Meter Sync screens: what a link carries, what each
 * status and failure says, the relay constants, and the order of the steps that
 * make an account (against the real Worker, in-process, no network).
 */
import { describe, it, expect, vi } from "vitest";
import { TransportError } from "../src/sync/engine.js";
import { CodeError } from "../src/sync/codes.js";
import { DEFAULT_RELAY, OPERATOR, isDefaultRelay, operatorOf, relayFetch } from "../src/sync/relayConfig.js";
import { readFragment, stripFragment, withoutFragment } from "../src/sync/relayFragments.js";
import {
  cleanDeviceName, defaultDeviceName, explainFailure, pipState, secondsAgo, statusWords, timeOfDay,
} from "../src/sync/relayWords.js";
import {
  StorageError, acknowledgeRecovery, createAccount, leaveVault, recoveryCodeOf, recoveryPending,
} from "../src/sync/relayActions.js";
import { decodeRecoveryCode } from "../src/sync/codes.js";
import { b64uDecode } from "../src/sync/crypto.js";
import { SYNC_KEY, loadVault } from "../src/sync/vaultStore.js";
import { admin, world } from "./relayWorld.js";
import { RELAY_URL } from "./relayShim.js";

const storage = ({ failAfter = Infinity } = {}) => {
  const map = new Map();
  let writes = 0;
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      writes += 1;
      if (writes > failAfter) throw new Error("full");
      map.set(k, String(v));
    },
    removeItem: (k) => { map.delete(k); },
  };
};
const CODE = "MTR-0123456789ABCDEFGHJK";

describe("the relay constants", () => {
  it("names the owner's relay as the default and Meter Sync as who runs it", () => {
    expect(DEFAULT_RELAY).toBe("https://meter-sync.ahmedsaad41022.workers.dev");
    expect(OPERATOR).toBe("Meter Sync");
    expect(isDefaultRelay(DEFAULT_RELAY)).toBe(true);
    expect(isDefaultRelay(`${DEFAULT_RELAY}/`)).toBe(true);
    expect(isDefaultRelay("https://other.example.workers.dev")).toBe(false);
    expect(isDefaultRelay("not a url")).toBe(false);
  });

  it("names whoever runs any other relay by its address", () => {
    expect(operatorOf(DEFAULT_RELAY)).toBe("Meter Sync");
    expect(operatorOf("https://my.example.workers.dev")).toBe("the owner of my.example.workers.dev");
    expect(operatorOf("garbage")).toBe("the owner of this relay");
  });

  it("looks the page's fetch up when called, so a stub put in place later is used", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => "stubbed");
    try {
      expect(await relayFetch("https://x.example", {})).toBe("stubbed");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("what the address bar can carry", () => {
  it("reads an invite, with or without a relay", () => {
    expect(readFragment(`#invite=${CODE}`)).toEqual({ kind: "invite", code: CODE, relay: null });
    const link = `#invite=${CODE}&relay=${encodeURIComponent("https://r.example.workers.dev")}`;
    expect(readFragment(link)).toEqual({ kind: "invite", code: CODE, relay: "https://r.example.workers.dev" });
  });

  it("reads a join code, decoded, without judging it", () => {
    expect(readFragment("#join=relay.example.workers.dev/AAAA-BBBB")).toEqual({ kind: "join", text: "relay.example.workers.dev/AAAA-BBBB" });
    expect(readFragment("#join=a%2Fb")).toEqual({ kind: "join", text: "a/b" });
  });

  it("calls a damaged one bad and says why, and ignores anything that is not ours", () => {
    expect(readFragment("#invite=MTR-NOPE")).toMatchObject({ kind: "bad", what: "invite" });
    expect(readFragment(`#invite=${CODE}&evil=1`)).toMatchObject({ kind: "bad", what: "invite" });
    expect(readFragment("#invite=MTR-0123456789ABCDEFGHJK&relay=http://insecure.example.com")).toMatchObject({ kind: "bad" });
    expect(readFragment("#join=%E0%A4%A")).toMatchObject({ kind: "bad", what: "join" });
    for (const h of ["", "#", "#top", "#section=1", null, undefined]) expect(readFragment(h)).toBeNull();
  });

  it("removes the fragment and keeps the path and the query", () => {
    expect(withoutFragment({ pathname: "/meter/", search: "?x=1" })).toBe("/meter/?x=1");
    const calls = [];
    const win = { location: { pathname: "/meter/", search: "" }, history: { replaceState: (...a) => calls.push(a) } };
    expect(stripFragment(win)).toBe(true);
    expect(calls).toEqual([[null, "", "/meter/"]]);
  });

  it("does not mind a page that cannot rewrite its address", () => {
    expect(stripFragment({ location: { pathname: "/", search: "" }, history: { replaceState() { throw new Error("sandbox"); } } })).toBe(false);
    expect(stripFragment({})).toBe(false);
  });
});

describe("failures in words", () => {
  const t = (code, detail) => new TransportError(code, detail);

  it("tells each way an invite can be refused apart", () => {
    const says = (e) => explainFailure(e).message;
    expect(says(t("auth", { code: "invite_invalid" }))).toMatch(/not valid/);
    expect(says(t("auth", { code: "invite_revoked" }))).toMatch(/cancelled/);
    expect(says(t("auth", { code: "invite_expired" }))).toMatch(/expired/);
    expect(says(t("auth", { code: "invite_required" }))).toMatch(/needs? .*invite|only creates accounts for people with an invite/i);
    expect(says(t("conflict", { code: "invite_used" }))).toMatch(/already been used/);
    expect(explainFailure(t("auth", { code: "invite_used" })).field).toBe("invite");
    expect(explainFailure(t("auth", {})).message).toMatch(/refused/);
  });

  it("tells a full relay and a creation limit apart from a refusal of the person", () => {
    expect(explainFailure(t("quota", { what: "relay_full" })).message).toMatch(/relay is full/);
    const limited = explainFailure(t("quota", { what: "creation", resetAt: new Date(2026, 0, 6, 0, 0).getTime() }));
    expect(limited.message).toMatch(/Too many accounts.+opens again at 00:00/);
    expect(explainFailure(t("quota", { what: "creation" })).message).not.toMatch(/opens again/);
    expect(explainFailure(t("quota", {})).retry).toBe(true);
  });

  it("separates what can simply be tried again from what cannot", () => {
    expect(explainFailure(t("network"))).toMatchObject({ retry: true });
    expect(explainFailure(t("paused"))).toMatchObject({ retry: true });
    expect(explainFailure(t("deleted"))).toMatchObject({ retry: false });
    expect(explainFailure(t("gone"))).toMatchObject({ retry: false });
    expect(explainFailure(t("protocol", { message: "The relay answered 418." })).message).toBe("The relay answered 418.");
    expect(explainFailure(t("protocol")).message).toMatch(/does not understand/);
    expect(explainFailure(t("conflict", {})).retry).toBe(true);
  });

  it("passes a code error's own message through, and keeps an unknown failure calm", () => {
    expect(explainFailure(new CodeError("length", "Too short."))).toMatchObject({ message: "Too short.", field: "code" });
    expect(explainFailure(new Error("boom")).message).toMatch(/Nothing was lost/);
  });
});

describe("status in words", () => {
  const now = Date.UTC(2026, 0, 5, 12, 0, 0);

  it("calls a good round ok, with how long ago", () => {
    const w = statusWords({ state: "ok", at: now - 12_000 }, now);
    expect(w).toMatchObject({ tone: "ok", label: "Synced 12 s ago" });
    expect(statusWords({ state: "ok", at: null }, now).label).toBe("Synced");
  });

  it("says what each stoppage means and what to do", () => {
    const s = (state, extra = {}) => statusWords({ state, ...extra }, now);
    expect(s("auth")).toMatchObject({ tone: "bad", label: "Device removed" });
    expect(s("auth").detail).toMatch(/This device was removed from the account/);
    expect(s("deleted").detail).toMatch(/The account was deleted/);
    expect(s("rekey").detail).toMatch(/needs the new key/);
    expect(s("rekey").detail).toMatch(/later update/);
    expect(s("needs-update").detail).toMatch(/newer format/);
    expect(s("paused").detail).toMatch(/nothing is lost/);
    expect(s("network").label).toBe("Offline, will retry");
    expect(s("backoff").label).toBe("Offline, will retry");
    expect(s("busy").tone).toBe("busy");
    expect(s("syncing").label).toBe("Syncing…");
    expect(s("idle").label).toBe("Starting…");
    expect(s("unsupported", { message: "No crypto." }).detail).toBe("No crypto.");
    expect(s("whatever").label).toBe("Sync problem");
  });

  it("says when it will try again, only if that is still ahead", () => {
    const later = new Date(now + 5 * 60_000);
    expect(statusWords({ state: "network", retryAt: now + 5 * 60_000 }, now).detail).toContain(`Trying again at ${timeOfDay(later.getTime())}`);
    expect(statusWords({ state: "network", retryAt: now - 1 }, now).detail).not.toMatch(/Trying again/);
    expect(statusWords({ state: "network", retryAt: Infinity }, now).detail).not.toMatch(/Trying again/);
  });

  it("says what a quota is about, and when it resets", () => {
    const at = new Date(2026, 0, 6, 3, 5).getTime();
    expect(statusWords({ state: "quota", detail: { what: "appends", resetAt: at } }, now).detail)
      .toMatch(/Your sync allowance for today is used\. It resets at 03:05/);
    expect(statusWords({ state: "quota", detail: { what: "bytes" } }, now).detail).toMatch(/storage limit/);
    expect(statusWords({ state: "quota", detail: { what: "snapshot_size" } }, now).detail).toMatch(/too large/);
    expect(statusWords({ state: "quota", detail: { what: "devices" } }, now).detail).toMatch(/most devices/);
    expect(statusWords({ state: "quota" }, now).detail).toMatch(/reached a limit/);
  });

  it("maps a tone to the footer's existing dot", () => {
    expect(pipState("ok", "ok")).toBe("ok");
    expect(pipState("busy", "syncing")).toBe("syncing");
    expect(pipState("busy", "idle")).toBe("idle");
    expect(pipState("warn", "network")).toBe("error");
    expect(pipState("bad", "auth")).toBe("error");
  });

  it("formats ages", () => {
    expect(secondsAgo(1000, 1000)).toBe("0 s ago");
    expect(secondsAgo(0, 59_000)).toBe("59 s ago");
    expect(secondsAgo(0, 120_000)).toBe("2 min ago");
    expect(secondsAgo(0, 3 * 3_600_000)).toBe("3 h ago");
    expect(secondsAgo(0, 3 * 86_400_000)).toBe("3 d ago");
    expect(secondsAgo(10_000, 0)).toBe("0 s ago");
  });
});

describe("device names", () => {
  const win = (userAgent, hostname = "example.com") => ({ navigator: { userAgent }, location: { hostname } });

  it("starts from words a person would recognise", () => {
    expect(defaultDeviceName(win("Mozilla/5.0 Electron/30"))).toBe("Meter desktop");
    expect(defaultDeviceName(win("Mozilla/5.0 (Linux; Android 14; Pixel) Chrome"))).toBe("Android phone");
    expect(defaultDeviceName(win("Mozilla/5.0 (iPhone; CPU iPhone OS 17)"))).toBe("iPhone or iPad");
    expect(defaultDeviceName(win("Mozilla/5.0 Chrome", "127.0.0.1"))).toBe("This computer (local)");
    expect(defaultDeviceName(win("Mozilla/5.0 Chrome"))).toBe("Browser");
    expect(defaultDeviceName({})).toBe("Browser");
  });

  it("trims, collapses, caps and never returns nothing", () => {
    expect(cleanDeviceName("  Kitchen   laptop ")).toBe("Kitchen laptop");
    expect(cleanDeviceName("x".repeat(100))).toHaveLength(40);
    expect(cleanDeviceName("   ")).toBe("This device");
    expect(cleanDeviceName(null, "Phone")).toBe("Phone");
  });
});

describe("making an account", () => {
  const setup = async () => {
    const w = world();
    const invite = (await admin(w, "/invite", { method: "POST", body: { label: "t" } })).body.code;
    return { w, invite };
  };

  it("saves the identity first, then registers, then saves the vault id and sets the recovery gate", async () => {
    const { w, invite } = await setup();
    const ls = storage();
    const order = [];
    const fetch = async (url, init) => {
      order.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      // At the moment the relay is asked, the identity is already on this device.
      if (new URL(url).pathname === "/v1/vaults") order.push(`saved-before: ${loadVault({ localStorage: ls })?.vaultId === null}`);
      return w.fetch(url, init);
    };
    const vault = await createAccount({ fetch, win: { localStorage: ls }, relay: RELAY_URL, invite, name: "Laptop" });
    expect(order).toEqual(["POST /v1/vaults", "saved-before: true"]);
    expect(vault.vaultId).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{16}$/);
    expect(vault.invite).toBeNull();
    expect(loadVault({ localStorage: ls })).toEqual(vault);
    expect(recoveryPending({ localStorage: ls })).toBe(true);
    acknowledgeRecovery({ localStorage: ls });
    expect(recoveryPending({ localStorage: ls })).toBe(false);
  });

  it("registers the same identity again after a lost answer, and spends the invite once", async () => {
    const { w, invite } = await setup();
    const ls = storage();
    const win = { localStorage: ls };
    let lose = true;
    const flaky = async (url, init) => {
      const res = await w.fetch(url, init);
      if (lose && new URL(url).pathname === "/v1/vaults") throw new Error("the answer was lost");
      return res;
    };
    await expect(createAccount({ fetch: flaky, win, relay: RELAY_URL, invite })).rejects.toMatchObject({ code: "network" });
    const first = loadVault(win);
    expect(first.vaultId).toBeNull();
    lose = false;
    const vault = await createAccount({ fetch: flaky, win, relay: RELAY_URL, invite });
    expect(vault.token).toBe(first.token);
    expect(vault.K).toBe(first.K);
    expect((await admin(w, "/stats")).body.vaults.count).toBe(1);
  });

  it("takes a different invite on a retry, since the first was never bound to anything", async () => {
    const { w, invite } = await setup();
    const win = { localStorage: storage() };
    await expect(createAccount({ fetch: w.fetch, win, relay: RELAY_URL, invite: "MTR-0123456789ABCDEFGHJK" })).rejects.toMatchObject({ code: "auth" });
    const first = loadVault(win);
    expect(first.invite).toBe("MTR-0123456789ABCDEFGHJK");
    const vault = await createAccount({ fetch: w.fetch, win, relay: RELAY_URL, invite });
    expect(vault.token).toBe(first.token);
    expect(vault.vaultId).toBeTruthy();
  });

  it("makes a new identity when the saved unregistered one was for another relay", async () => {
    const { w, invite } = await setup();
    const win = { localStorage: storage() };
    await expect(createAccount({ fetch: async () => { throw new Error("down"); }, win, relay: "https://old.example.workers.dev", invite })).rejects.toBeTruthy();
    const old = loadVault(win);
    const vault = await createAccount({ fetch: w.fetch, win, relay: RELAY_URL, invite });
    expect(vault.token).not.toBe(old.token);
    expect(vault.relay).toBe(RELAY_URL);
  });

  it("makes nothing when this device cannot keep the key", async () => {
    const { w, invite } = await setup();
    const fetch = vi.fn(w.fetch);
    await expect(createAccount({ fetch, win: { localStorage: storage({ failAfter: 0 }) }, relay: RELAY_URL, invite })).rejects.toBeInstanceOf(StorageError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the identity, unconfirmed, when only the second save fails", async () => {
    const { w, invite } = await setup();
    const ls = storage({ failAfter: 1 });
    const win = { localStorage: ls };
    await expect(createAccount({ fetch: w.fetch, win, relay: RELAY_URL, invite })).rejects.toBeInstanceOf(StorageError);
    expect(loadVault(win).vaultId).toBeNull();
    // Retried with room, it finds the same vault: the relay already has it.
    const fresh = storage();
    fresh.map.set(SYNC_KEY.VAULT, ls.map.get(SYNC_KEY.VAULT));
    const vault = await createAccount({ fetch: w.fetch, win: { localStorage: fresh }, relay: RELAY_URL, invite });
    expect((await admin(w, "/stats")).body.vaults.count).toBe(1);
    expect(vault.vaultId).toBeTruthy();
  });

  it("refuses a second account on a device that has one", async () => {
    const { w, invite } = await setup();
    const win = { localStorage: storage() };
    await createAccount({ fetch: w.fetch, win, relay: RELAY_URL, invite });
    await expect(createAccount({ fetch: w.fetch, win, relay: RELAY_URL, invite })).rejects.toThrow(/already has an account/);
  });

  it("reports a bad invite or relay address as a code error, before the network", async () => {
    const fetch = vi.fn();
    const win = { localStorage: storage() };
    await expect(createAccount({ fetch, win, relay: RELAY_URL, invite: "nope" })).rejects.toBeInstanceOf(CodeError);
    await expect(createAccount({ fetch, win, relay: "http://example.com", invite: CODE })).rejects.toBeInstanceOf(CodeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("derives a recovery code that decodes to the key, and leaving clears the vault and the gate", async () => {
    const { w, invite } = await setup();
    const win = { localStorage: storage() };
    const vault = await createAccount({ fetch: w.fetch, win, relay: RELAY_URL, invite });
    const code = recoveryCodeOf(vault);
    expect(code.split("-")).toHaveLength(8);
    expect([...decodeRecoveryCode(code)]).toEqual([...b64uDecode(vault.K)]);
    leaveVault(win);
    expect(loadVault(win)).toBeNull();
    expect(recoveryPending(win)).toBe(false);
    expect([...win.localStorage.map.keys()]).toEqual([]);
  });
});
