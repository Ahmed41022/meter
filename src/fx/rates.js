/**
 * Today's exchange rates: fetching them, and keeping the last good copy on the
 * device.
 *
 * The feed is a free public one (CC0, no key), served from two hosts that
 * carry the same file. Only the rates travel: nothing from the ledger is ever
 * sent, and the request carries no cookies or credentials. The rates are public
 * data, so they live in this device's storage and not in the ledger.
 *
 * `fetch` and `now` are arguments so every branch is testable without a
 * network or a real clock, as in sync/drive.js.
 */
import { isRatesTable, normaliseRates } from "../domain/fx.js";
import { SETTING, loadSetting, saveSetting } from "../storage/settings.js";

export const PRIMARY_URL =
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json";
export const FALLBACK_URL = "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json";
/** The hosts, for the privacy line in Settings. */
export const HOSTS = ["cdn.jsdelivr.net", "latest.currency-api.pages.dev"];

export const TIMEOUT_MS = 10_000;
/** Older than this and the cache is due a refresh, even on the same day. */
export const MAX_AGE_MS = 12 * 3_600_000;

export class RatesError extends Error {
  constructor(message, attempts = []) {
    super(message);
    this.name = "RatesError";
    this.attempts = attempts;
  }
}

const hostOf = (url) => new URL(url).host;

/** One URL, once: the normalised table, or a thrown Error saying what failed. */
const attempt = async (url, doFetch, timeoutMs) => {
  const controller = new AbortController();
  let timer;
  // Raced, not just aborted: a fetch that ignores its signal must still lose.
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("timed out")); }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        // no-cache: jsDelivr tells browsers to keep the file for 7 days, which
        // would otherwise make "today's rate" a week old.
        const res = await doFetch(url, {
          cache: "no-cache", credentials: "omit", signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let body;
        try { body = await res.json(); } catch { throw new Error("not valid JSON"); }
        const table = normaliseRates(body);
        if (!table) throw new Error("unexpected shape");
        return table;
      })(),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The primary host, then the fallback. Resolves to `{ base, date, rates,
 * fetchedAt }`; rejects with a RatesError naming what each host said.
 */
export const fetchRates = async ({
  fetch: doFetch = (...args) => globalThis.fetch(...args),
  now = Date.now,
  timeoutMs = TIMEOUT_MS,
} = {}) => {
  const attempts = [];
  for (const url of [PRIMARY_URL, FALLBACK_URL]) {
    try {
      const table = await attempt(url, doFetch, timeoutMs);
      return { ...table, fetchedAt: now() };
    } catch (e) {
      attempts.push(`${hostOf(url)}: ${e?.message || "failed"}`);
    }
  }
  throw new RatesError(`Could not get rates (${attempts.join("; ")})`, attempts);
};

/** The saved copy, or null when there is none or it is not one this build can read. */
export const loadCache = (win = globalThis) => {
  try {
    const parsed = JSON.parse(loadSetting(SETTING.RATES, "", win));
    if (!isRatesTable(parsed) || !Number.isFinite(parsed.fetchedAt)) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const saveCache = (cache, win = globalThis) =>
  saveSetting(SETTING.RATES, JSON.stringify(cache), win);

const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/**
 * Whether the saved rates are due a refresh: none, fetched on an earlier day
 * (this device's calendar), 12 hours or more ago, or stamped in the future
 * (a clock that has since been set back is not evidence of freshness).
 */
export const isStale = (cache, now) => {
  if (!cache || !Number.isFinite(cache.fetchedAt)) return true;
  const age = now - cache.fetchedAt;
  return age < 0 || age >= MAX_AGE_MS || dayKey(cache.fetchedAt) !== dayKey(now);
};
