/**
 * The rates feed and its on-device cache. Every fetch here is a stub: nothing
 * in this file may reach the network.
 */
import { describe, it, expect, vi } from "vitest";
import {
  FALLBACK_URL, MAX_AGE_MS, PRIMARY_URL, RatesError, fetchRates, isStale, loadCache, saveCache,
} from "../src/fx/rates.js";
import { SETTING } from "../src/storage/settings.js";

const BODY = { date: "2026-11-19", usd: { egp: 53.83, eur: 0.9118 } };
const ok = (body = BODY) => ({ ok: true, status: 200, json: async () => body });
const fail = (status) => ({ ok: false, status, json: async () => ({}) });
const NOW = new Date(2026, 10, 19, 10, 0, 0).getTime();   // local, so the day logic is stable
const HOUR = 3_600_000;

/** A fetch stub that answers by URL and records every call. */
const stub = (answers) => vi.fn(async (url) => {
  const a = answers[url];
  if (a instanceof Error) throw a;
  return typeof a === "function" ? a() : a;
});

/** A window-shaped object with a working localStorage. */
const storage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    localStorage: {
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => { data.set(k, String(v)); },
      removeItem: (k) => { data.delete(k); },
    },
    data,
  };
};

describe("fetchRates", () => {
  it("returns the normalised primary response, stamped with the time", async () => {
    const f = stub({ [PRIMARY_URL]: ok() });
    const out = await fetchRates({ fetch: f, now: () => NOW });
    expect(out).toEqual({
      base: "USD", date: "2026-11-19", fetchedAt: NOW, rates: { EGP: 53.83, EUR: 0.9118, USD: 1 },
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("asks without the browser cache and without credentials", async () => {
    const f = stub({ [PRIMARY_URL]: ok() });
    await fetchRates({ fetch: f, now: () => NOW });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(PRIMARY_URL);
    expect(init.cache).toBe("no-cache");
    expect(init.credentials).toBe("omit");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to the second host when the first fails", async () => {
    const f = stub({ [PRIMARY_URL]: fail(503), [FALLBACK_URL]: ok() });
    const out = await fetchRates({ fetch: f, now: () => NOW });
    expect(out.rates.EGP).toBe(53.83);
    expect(f.mock.calls.map((c) => c[0])).toEqual([PRIMARY_URL, FALLBACK_URL]);
  });

  it("falls back when the first host cannot be reached at all", async () => {
    const f = stub({ [PRIMARY_URL]: new TypeError("Failed to fetch"), [FALLBACK_URL]: ok() });
    expect((await fetchRates({ fetch: f, now: () => NOW })).date).toBe("2026-11-19");
  });

  it("throws a clear error naming both hosts when both fail", async () => {
    const f = stub({ [PRIMARY_URL]: fail(503), [FALLBACK_URL]: new TypeError("Failed to fetch") });
    const err = await fetchRates({ fetch: f, now: () => NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(RatesError);
    expect(err.message).toMatch(/cdn\.jsdelivr\.net: HTTP 503/);
    expect(err.message).toMatch(/latest\.currency-api\.pages\.dev: Failed to fetch/);
    expect(err.attempts).toHaveLength(2);
  });

  it("treats a body that is not JSON as a failure of that host", async () => {
    const bad = { ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } };
    const f = stub({ [PRIMARY_URL]: bad, [FALLBACK_URL]: ok() });
    expect((await fetchRates({ fetch: f, now: () => NOW })).date).toBe("2026-11-19");
    const both = stub({ [PRIMARY_URL]: bad, [FALLBACK_URL]: bad });
    await expect(fetchRates({ fetch: both, now: () => NOW })).rejects.toThrow(/not valid JSON/);
  });

  it.each([
    ["no date", { usd: { egp: 50 } }],
    ["no usd table", { date: "2026-11-19" }],
    ["only bad numbers", { date: "2026-11-19", usd: { egp: -1, eur: 0 } }],
    ["a bare array", []],
    ["null", null],
  ])("rejects a response with %s, and tries the fallback", async (_, body) => {
    const f = stub({ [PRIMARY_URL]: ok(body), [FALLBACK_URL]: ok(body) });
    await expect(fetchRates({ fetch: f, now: () => NOW })).rejects.toThrow(/unexpected shape/);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("gives up on a host that never answers, and moves on", async () => {
    // Ignores its signal on purpose: the timeout must not depend on the fetch's good manners.
    const f = stub({ [PRIMARY_URL]: () => new Promise(() => {}), [FALLBACK_URL]: ok() });
    const out = await fetchRates({ fetch: f, now: () => NOW, timeoutMs: 15 });
    expect(out.date).toBe("2026-11-19");
  });

  it("aborts the request it gave up on", async () => {
    const f = stub({ [PRIMARY_URL]: () => new Promise(() => {}), [FALLBACK_URL]: () => new Promise(() => {}) });
    const err = await fetchRates({ fetch: f, now: () => NOW, timeoutMs: 15 }).catch((e) => e);
    expect(err.message).toMatch(/timed out/);
    expect(f.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

describe("the cache", () => {
  const fresh = { base: "USD", date: "2026-11-19", fetchedAt: NOW, rates: { EGP: 53.83, USD: 1 } };

  it("round-trips, under its own per-device key", () => {
    const win = storage();
    expect(saveCache(fresh, win)).toBe(true);
    expect(win.data.has(SETTING.RATES)).toBe(true);
    expect(SETTING.RATES).toBe("meter:rates");
    expect(loadCache(win)).toEqual(fresh);
  });

  it("is null when nothing is saved", () => {
    expect(loadCache(storage())).toBeNull();
  });

  it.each([
    ["garbage", "{nope"],
    ["a table with no fetch time", JSON.stringify({ ...fresh, fetchedAt: undefined })],
    ["a damaged rate", JSON.stringify({ ...fresh, rates: { EGP: 0, USD: 1 } })],
    ["the wrong base", JSON.stringify({ ...fresh, base: "EUR" })],
    ["null", "null"],
  ])("ignores %s", (_, raw) => {
    expect(loadCache(storage({ [SETTING.RATES]: raw }))).toBeNull();
  });

  it("is null, not a crash, where storage throws", () => {
    const win = { localStorage: { getItem() { throw new Error("blocked"); } } };
    expect(loadCache(win)).toBeNull();
  });

  it("reports a failed save instead of throwing", () => {
    const win = { localStorage: { setItem() { throw new Error("full"); } } };
    expect(saveCache(fresh, win)).toBe(false);
  });
});

describe("isStale", () => {
  const at = (t) => ({ fetchedAt: t });

  it("is stale with no cache or a cache with no time", () => {
    expect(isStale(null, NOW)).toBe(true);
    expect(isStale({}, NOW)).toBe(true);
  });

  it("is fresh a little later the same day", () => {
    expect(isStale(at(NOW), NOW)).toBe(false);
    expect(isStale(at(NOW - 2 * HOUR), NOW)).toBe(false);
  });

  it("is stale once it is 12 hours old, even on the same day", () => {
    const late = new Date(2026, 10, 19, 23, 0, 0).getTime();
    const early = late - MAX_AGE_MS;     // 11:00 that day
    expect(isStale(at(early + 1), late)).toBe(false);
    expect(isStale(at(early), late)).toBe(true);
  });

  it("is stale on a new calendar day, however young it is", () => {
    const before = new Date(2026, 10, 19, 23, 50).getTime();
    const after = new Date(2026, 10, 20, 0, 10).getTime();
    expect(isStale(at(before), after)).toBe(true);
  });

  it("is stale when stamped in the future", () => {
    expect(isStale(at(NOW + HOUR), NOW)).toBe(true);
  });
});
