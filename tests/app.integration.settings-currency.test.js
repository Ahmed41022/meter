/**
 * The Currency section of the Settings tab, and the rule that matters most
 * about it: with live rates off, which is the default, the app never touches
 * the network. Drives the built artifact. The page's fetch is a stub that
 * records its calls; nothing here reaches a real host.
 */
import { describe, it, expect } from "vitest";
import {
  boot, btn, guardBuiltApp, setValue, settle, toProjects, until,
} from "./app.integration.helpers.js";

guardBuiltApp();

const seed = {
  projects: [{
    id: "a", name: "Orion", currentRate: 20, currency: "USD",
    createdAt: Date.now() - 86_400_000, sessionGoal: null, overallGoal: null, tasks: [],
  }],
  sessions: [],
};
const on = { id: "fxOn", value: true, createdAt: 1, updatedAt: 1, deletedAt: null };
const seedOn = { ...seed, prefs: [on] };

/** Installed before the bundle runs. `window.__mode` picks what the feed says. */
const STUB = `
  window.__calls = [];
  window.__mode = "ok";
  window.fetch = (url, init) => {
    window.__calls.push({ url, init });
    if (window.__mode === "fail") return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ date: "2026-11-19", usd: { egp: 53.83, eur: 0.9118, gbp: 0.78, jpy: 150 } }),
    });
  };`;
const FAILING = STUB.replace('"ok"', '"fail"');

const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
const pref = (dom, key) => stored(dom).prefs?.find((r) => r.id === key)?.value;
const section = (d) => d.querySelector("#settings-currency").parentElement;
const calls = (dom) => dom.window.__calls;
const favs = (d) => [...section(d).querySelectorAll(".fav-code")]
  .map((e) => e.childNodes[0].textContent);
const byLabel = (d, label) => [...section(d).querySelectorAll("button")]
  .find((b) => b.getAttribute("aria-label") === label);
const bootCurrency = async (ledger = seed, settings = null, script = STUB) => {
  const dom = await boot(ledger, settings, script);
  await settle();
  await toProjects(dom.window.document, "Settings");
  return dom;
};
const switchEl = (d) => section(d).querySelector("input[type=checkbox]");
const ratesShown = (d) => until(() => /Rates from/.test(section(d).textContent), { what: "the rate date" });

describe("the Currency section", () => {
  it("sits after Defaults, off, with the privacy note and the credit", async () => {
    const dom = await bootCurrency();
    const d = dom.window.document;
    expect([...d.querySelectorAll(".settings-title")].map((h) => h.textContent))
      .toEqual(["Appearance", "Defaults", "Currency", "Companies & paydays", "Sync & backup"]);
    expect(switchEl(d).checked).toBe(false);
    expect(section(d).textContent).toMatch(/Off\. Totals show each currency as earned/);
    expect(btn(section(d), /^Refresh now$/).disabled).toBe(true);
    expect(section(d).textContent).toMatch(/cdn\.jsdelivr\.net/);
    expect(section(d).textContent).toMatch(/Nothing from your\s+ledger is sent/);
    expect(section(d).textContent).toMatch(/CC0/);
    expect(favs(d)).toEqual(["USD"]);
  }, 25_000);

  it("turning it on fetches once, shows the rate date and saves the choice and the rates", async () => {
    const dom = await bootCurrency();
    const d = dom.window.document;
    switchEl(d).click();
    await ratesShown(d);
    expect(calls(dom)).toHaveLength(1);
    expect(calls(dom)[0].url).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/.*usd\.min\.json$/);
    expect(calls(dom)[0].init.cache).toBe("no-cache");
    expect(section(d).textContent).toMatch(/Rates from .*2026/);
    expect(pref(dom, "fxOn")).toBe(true);
    const cache = JSON.parse(dom.window.localStorage.getItem("meter:rates"));
    expect(cache.date).toBe("2026-11-19");
    expect(cache.rates.EGP).toBe(53.83);
    // Rates are public data for this device: not in the ledger.
    expect(JSON.stringify(stored(dom))).not.toMatch(/53\.83/);
  }, 25_000);

  it("Refresh now fetches again", async () => {
    const dom = await bootCurrency(seedOn);
    const d = dom.window.document;
    await ratesShown(d);
    expect(calls(dom)).toHaveLength(1);
    btn(section(d), /^Refresh now$/).click();
    await until(() => calls(dom).length === 2, { what: "the second fetch" });
    await settle();
    expect(section(d).textContent).toMatch(/Rates from/);
  }, 25_000);

  it("shows the error when both hosts fail, and says only As earned works", async () => {
    const dom = await bootCurrency(seedOn, null, FAILING);
    const d = dom.window.document;
    await until(() => /Could not get rates/.test(section(d).textContent), { what: "the error" });
    expect(calls(dom).map((c) => new URL(c.url).host)).toEqual([
      "cdn.jsdelivr.net", "latest.currency-api.pages.dev",
    ]);
    expect(section(d).textContent).toMatch(/HTTP 503/);
    expect(section(d).textContent).toMatch(/only “As earned” works/);
    expect(btn(section(d), /^Refresh now$/).disabled).toBe(false);
  }, 25_000);

  it("keeps the saved rates, with their age, when a refresh fails", async () => {
    const saved = {
      base: "USD", date: "2026-11-18", fetchedAt: Date.now() - 20 * 3_600_000,
      rates: { USD: 1, EGP: 50 },
    };
    const dom = await bootCurrency(seedOn, { "meter:rates": JSON.stringify(saved) }, FAILING);
    const d = dom.window.document;
    await until(() => /Could not get rates/.test(section(d).textContent), { what: "the error" });
    expect(section(d).textContent)
      .toMatch(/Using the saved ones: Rates from .*2026, fetched 20 hours ago/);
  }, 25_000);

  it("uses fresh saved rates without fetching, and fetches when they are stale", async () => {
    const make = (age) => JSON.stringify({
      base: "USD", date: "2026-11-19", fetchedAt: Date.now() - age, rates: { USD: 1, EGP: 50 },
    });
    const fresh = await bootCurrency(seedOn, { "meter:rates": make(60_000) });
    expect(section(fresh.window.document).textContent).toMatch(/Rates from/);
    expect(calls(fresh)).toHaveLength(0);

    const stale = await boot(seedOn, { "meter:rates": make(13 * 3_600_000) }, STUB);
    await until(() => calls(stale).length === 1, { what: "a refresh of old rates" });
  }, 30_000);
});

describe("the favourites", () => {
  it("adds from the built-in list when nothing is cached, and stores a synced pref", async () => {
    const dom = await bootCurrency();
    const d = dom.window.document;
    const select = section(d).querySelector("select[aria-label='Currency to add']");
    expect([...select.options].map((o) => o.value)).not.toContain("USD");
    expect([...select.options].map((o) => o.value)).toContain("EGP");
    setValue(dom.window, select, "EGP");
    await settle();
    btn(section(d), /^Add$/).click();
    await settle();
    expect(favs(d)).toEqual(["USD", "EGP"]);
    expect(pref(dom, "favourites")).toEqual(["USD", "EGP"]);
    expect(stored(dom).prefs.find((r) => r.id === "favourites").updatedAt).toBeGreaterThan(0);
    expect(calls(dom)).toHaveLength(0);
  }, 25_000);

  it("offers the cached feed's currencies once there are rates", async () => {
    const dom = await bootCurrency(seedOn);
    const d = dom.window.document;
    await ratesShown(d);
    const values = [...section(d).querySelector("select[aria-label='Currency to add']").options]
      .map((o) => o.value);
    expect(values).toEqual(["EGP", "EUR", "GBP", "JPY"]);
  }, 25_000);

  it("reorders and removes, and always keeps one", async () => {
    const ledger = {
      ...seed,
      prefs: [{ id: "favourites", value: ["USD", "EGP", "EUR"], createdAt: 1, updatedAt: 1, deletedAt: null }],
    };
    const dom = await bootCurrency(ledger);
    const d = dom.window.document;
    expect(favs(d)).toEqual(["USD", "EGP", "EUR"]);
    expect(byLabel(d, "Move USD up").disabled).toBe(true);
    expect(byLabel(d, "Move EUR down").disabled).toBe(true);
    byLabel(d, "Move EUR up").click();
    await settle();
    expect(favs(d)).toEqual(["USD", "EUR", "EGP"]);
    expect(pref(dom, "favourites")).toEqual(["USD", "EUR", "EGP"]);
    byLabel(d, "Move USD down").click();
    await settle();
    expect(pref(dom, "favourites")).toEqual(["EUR", "USD", "EGP"]);
    byLabel(d, "Remove USD").click();
    await settle();
    expect(pref(dom, "favourites")).toEqual(["EUR", "EGP"]);
    byLabel(d, "Remove EGP").click();
    await settle();
    expect(pref(dom, "favourites")).toEqual(["EUR"]);
    expect(byLabel(d, "Remove EUR").disabled).toBe(true);
  }, 30_000);

  it("chooses the display currency from the favourites or As earned", async () => {
    const ledger = {
      ...seed,
      prefs: [{ id: "favourites", value: ["USD", "EGP"], createdAt: 1, updatedAt: 1, deletedAt: null }],
    };
    const dom = await bootCurrency(ledger);
    const d = dom.window.document;
    const select = [...section(d).querySelectorAll("select")]
      .find((s) => s.getAttribute("aria-label") !== "Currency to add");
    expect([...select.options].map((o) => o.value)).toEqual(["USD", "EGP", "earned"]);
    expect(select.value).toBe("USD");
    setValue(dom.window, select, "EGP");
    await settle();
    expect(pref(dom, "displayCurrency")).toBe("EGP");
    setValue(dom.window, select, "earned");
    await settle();
    expect(pref(dom, "displayCurrency")).toBe("earned");
  }, 25_000);
});

describe("with live rates off", () => {
  it("never calls fetch while booting and walking every tab", async () => {
    const dom = await boot(seed, null, STUB);
    const d = dom.window.document;
    await settle();
    for (const tab of ["Overview", "Work", "Life", "Settings", "Today"]) {
      await toProjects(d, tab);
    }
    // Past the app's own timers too, so a quiet fetch on a timer would show.
    await new Promise((r) => setTimeout(r, 250));
    expect(calls(dom)).toHaveLength(0);
    expect(dom.window.localStorage.getItem("meter:rates")).toBeNull();
  }, 40_000);

  it("ignores a saved cache: no fetch, no rates shown", async () => {
    const saved = JSON.stringify({ base: "USD", date: "2026-11-19", fetchedAt: 1, rates: { USD: 1 } });
    const dom = await bootCurrency(seed, { "meter:rates": saved });
    expect(calls(dom)).toHaveLength(0);
    expect(section(dom.window.document).textContent).not.toMatch(/Rates from/);
  }, 25_000);

  it("stops asking when it is turned off again", async () => {
    const dom = await bootCurrency(seedOn);
    const d = dom.window.document;
    await ratesShown(d);
    switchEl(d).click();
    await settle();
    expect(pref(dom, "fxOn")).toBe(false);
    expect(section(d).textContent).toMatch(/Off\./);
    expect(calls(dom)).toHaveLength(1);
  }, 25_000);
});
