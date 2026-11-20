/**
 * The ▾ currency switcher beside every total, and the Work cards that follow
 * it. Drives the built artifact with a pre-seeded rates cache and a stubbed
 * fetch; nothing here reaches a real host.
 */
import { describe, it, expect } from "vitest";
import {
  ALL_TIME, boot, guardBuiltApp, settle, toProjects,
} from "./app.integration.helpers.js";

guardBuiltApp();

const T = Date.now();
const MIN = 60_000;
const sitting = (id, projectId, rate, currency) => ({
  id, projectId, kind: "billed", taskId: null, rate, currency, createdAt: T - 10 * MIN,
  closedAt: T - 4 * MIN, deletedAt: null,
  segments: [{ startedAt: T - 10 * MIN, endedAt: T - 4 * MIN }],
});
const project = (id, name, rate, currency) => ({
  id, name, currentRate: rate, currency, createdAt: T - 30 * 86_400_000,
  sessionGoal: null, overallGoal: null, tasks: [],
});
const pref = (id, value) => ({ id, value, createdAt: 1, updatedAt: 1, deletedAt: null });

// Orion: 6 min at $200/h = $20.00, plus a EUR 5.00 settlement. Sphinx: 6 min at
// EGP 1000/h = EGP 100.00, all in its own currency.
const ledger = (prefs = []) => ({
  projects: [project("o", "Orion", 200, "USD"), project("s", "Sphinx", 1000, "EGP")],
  sessions: [sitting("s1", "o", 200, "USD"), sitting("s2", "s", 1000, "EGP")],
  earnings: [{
    id: "e1", projectId: "o", taskId: null, kind: "piece", cents: 500, currency: "EUR",
    at: T - 5 * MIN, note: "", createdAt: T - 5 * MIN, deletedAt: null,
  }],
  // A pref passed in replaces the default of the same name.
  prefs: [pref("fxOn", true), pref("favourites", ["USD", "EGP", "EUR"])]
    .filter((d) => !prefs.some((p) => p.id === d.id)).concat(prefs),
});
const rates = (table = { USD: 1, EGP: 50, EUR: 0.9 }) => JSON.stringify({
  base: "USD", date: "2026-11-19", fetchedAt: Date.now() - 60_000, rates: table,
});

const STUB = "window.__calls = []; window.fetch = (u) => { window.__calls.push(u); return Promise.reject(new Error('no network in tests')); };";
const bootWith = async (prefs, settings = {}, state = ledger(prefs)) => {
  const dom = await boot(state, { ...ALL_TIME, "meter:rates": rates(), ...settings }, STUB);
  await settle();
  return dom;
};

const switchBtn = (d) => d.querySelector(".fx-btn");
const menu = (d) => d.querySelector("[role=menu]");
const item = (d, re) => [...d.querySelectorAll("[role=menuitemradio]")].find((b) => re.test(b.textContent));
const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
const choiceOf = (dom) => stored(dom).prefs.find((r) => r.id === "displayCurrency")?.value;
const todayHead = (d) => d.querySelector(".fx-head .eyebrow").textContent;
const grand = (d) => d.querySelector(".grand .grand-amt").textContent;
const card = (d, name) => [...d.querySelectorAll(".card")].find((c) => c.textContent.includes(name));
const amt = (d, name) => card(d, name).querySelector(".card-amt").textContent;
const key = (dom, el, k) => el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true }));

const choose = async (dom, re) => {
  const d = dom.window.document;
  switchBtn(d).click();
  await settle();
  item(d, re).click();
  await settle();
};

describe("the switcher", () => {
  it("opens with the favourites, named, then As earned, and marks the current choice", async () => {
    const dom = await bootWith();
    const d = dom.window.document;
    const b = switchBtn(d);
    expect(b.getAttribute("aria-haspopup")).toBe("menu");
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(menu(d)).toBeNull();
    b.click();
    await settle();
    expect(b.getAttribute("aria-expanded")).toBe("true");
    const items = [...d.querySelectorAll("[role=menuitemradio]")];
    expect(items.map((i) => i.textContent.replace(/[✓]/, "").trim()).map((t) => t.split(" · ")[0]))
      .toEqual(["USD", "EGP", "EUR", "As earned"]);
    expect(items[0].textContent).toMatch(/USD · /);
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]);
    expect(items.every((i) => !i.disabled)).toBe(true);
    expect(d.querySelector(".fx-why")).toBeNull();
  }, 25_000);

  it("switches every total on every tab to the chosen currency, marked approximate with the date", async () => {
    const dom = await bootWith();
    const d = dom.window.document;
    await choose(dom, /^EGP/);
    expect(choiceOf(dom)).toBe("EGP");
    // 20 USD + 5 EUR + 100 EGP at 50 EGP and 0.9 EUR to the dollar.
    expect(todayHead(d)).toMatch(/^≈ EGP.1,377\.78 at (19 Nov|Nov 19) rates/);
    await toProjects(d, "Overview");
    expect(grand(d)).toMatch(/^≈ EGP.1,377\.78/);
    expect(d.querySelector(".grand .fx-date").textContent).toMatch(/^at (19 Nov|Nov 19) rates$/);
    await toProjects(d, "Work");
    expect(grand(d)).toMatch(/^≈ EGP.1,377\.78/);
    expect(d.querySelector(".grand .fx-date").textContent).toMatch(/^at (19 Nov|Nov 19) rates$/);
    // And the project page's own total: its sessions only, as it always was.
    card(d, "Orion").click();
    await settle();
    expect(d.querySelector(".sec-head .fx-btn")).not.toBeNull();
    expect(d.body.textContent).toMatch(/≈ EGP.1,000\.00 at (19 Nov|Nov 19) rates/);
  }, 40_000);

  it("keeps the choice when it is picked from a different total", async () => {
    const dom = await bootWith();
    const d = dom.window.document;
    await toProjects(d, "Work");
    await choose(dom, /^EGP/);
    await toProjects(d, "Today");
    expect(todayHead(d)).toMatch(/^≈ EGP/);
  }, 30_000);

  it("As earned puts the per-currency figures back", async () => {
    const dom = await bootWith([pref("displayCurrency", "EGP")]);
    const d = dom.window.document;
    expect(todayHead(d)).toMatch(/≈/);
    await choose(dom, /^As earned/);
    expect(choiceOf(dom)).toBe("earned");
    expect(todayHead(d)).not.toMatch(/≈/);
    expect(todayHead(d)).toMatch(/EGP.100\.00 · \$20\.00 · €5\.00 · 12m/);
    await toProjects(d, "Work");
    const figures = [...d.querySelectorAll(".grand .grand-amt")].map((e) => e.textContent);
    expect(figures).toHaveLength(3);
    expect(figures.join("|")).toMatch(/\$20\.00/);
    expect(figures.join("|")).toMatch(/€5\.00/);
    expect(figures.join("|")).toMatch(/EGP.100\.00/);
  }, 30_000);

  it("shows a mixed-currency card as separate figures, or one approximate figure", async () => {
    const dom = await bootWith([pref("displayCurrency", "earned")]);
    const d = dom.window.document;
    await toProjects(d, "Work");
    expect(amt(d, "Orion")).toBe("$20.00 · €5.00");
    expect(amt(d, "Sphinx")).toMatch(/^EGP.100\.00$/);
    await choose(dom, /^EGP/);
    expect(amt(d, "Orion")).toMatch(/^≈ EGP.1,277\.78$/);
    // Money already in the chosen currency is not converted, so no ≈.
    expect(amt(d, "Sphinx")).toMatch(/^EGP.100\.00$/);
    await choose(dom, /^USD/);
    expect(amt(d, "Orion")).toMatch(/^≈ \$25\.56$/);
  }, 40_000);

  it("leaves a single-currency card as it was with rates off", async () => {
    const dom = await boot(ledger([pref("fxOn", false)]), ALL_TIME, STUB);
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Work");
    expect(amt(d, "Sphinx")).toMatch(/^EGP.100\.00$/);
    expect(amt(d, "Orion")).toBe("$20.00 · €5.00");
  }, 30_000);

  it("disables the favourites with rates off, says why, and the link opens Settings", async () => {
    const dom = await boot(ledger([pref("fxOn", false)]), ALL_TIME, STUB);
    await settle();
    const d = dom.window.document;
    switchBtn(d).click();
    await settle();
    const items = [...d.querySelectorAll("[role=menuitemradio]")];
    expect(items.map((i) => i.disabled)).toEqual([true, true, true, false]);
    expect(d.querySelector(".fx-why").textContent).toMatch(/Live rates are off — turn them on in Settings → Currency/);
    d.querySelector(".fx-why .linkish").click();
    await settle();
    expect(d.querySelector("[role=tab][aria-selected=true]").textContent).toBe("Settings");
    expect(d.querySelector("#settings-currency")).not.toBeNull();
    expect(menu(d)).toBeNull();
  }, 30_000);

  it("says there are no rates yet when rates are on but none have arrived", async () => {
    const dom = await boot(ledger(), ALL_TIME, STUB);
    await settle();
    const d = dom.window.document;
    switchBtn(d).click();
    await settle();
    expect(d.querySelector(".fx-why").textContent).toMatch(/No rates yet/);
    expect([...d.querySelectorAll("[role=menuitemradio]")].map((i) => i.disabled))
      .toEqual([true, true, true, false]);
    // And the totals stay as earned.
    expect(todayHead(d)).not.toMatch(/≈/);
  }, 30_000);

  it("falls back to each currency, naming the one with no rate", async () => {
    const dom = await bootWith([pref("displayCurrency", "EGP")], {
      "meter:rates": rates({ USD: 1, EGP: 50 }),     // no EUR
    });
    const d = dom.window.document;
    expect(todayHead(d)).not.toMatch(/≈/);
    expect(todayHead(d)).toMatch(/€5\.00/);
    switchBtn(d).click();
    await settle();
    expect(d.querySelector(".fx-why").textContent).toMatch(/No rate for EUR/);
    // The favourite the feed does not know cannot be picked.
    expect(item(d, /^EUR/).disabled).toBe(true);
    expect(item(d, /^EGP/).disabled).toBe(false);
  }, 30_000);

  it("works from the keyboard, and Escape and an outside click close it", async () => {
    const dom = await bootWith();
    const d = dom.window.document;
    const b = switchBtn(d);
    b.focus();
    key(dom, b, "ArrowDown");
    await settle();
    expect(menu(d)).not.toBeNull();
    // Opens on the current choice.
    expect(d.activeElement.textContent).toMatch(/^USD/);
    key(dom, d.activeElement, "ArrowDown");
    expect(d.activeElement.textContent).toMatch(/^EGP/);
    key(dom, d.activeElement, "ArrowUp");
    key(dom, d.activeElement, "ArrowUp");           // wraps to the last
    expect(d.activeElement.textContent).toMatch(/^As earned/);
    key(dom, d.activeElement, "Home");
    expect(d.activeElement.textContent).toMatch(/^USD/);
    key(dom, d.activeElement, "End");
    expect(d.activeElement.textContent).toMatch(/^As earned/);

    key(dom, d.activeElement, "Escape");
    await settle();
    expect(menu(d)).toBeNull();
    expect(d.activeElement).toBe(b);

    b.click();
    await settle();
    expect(menu(d)).not.toBeNull();
    d.body.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
    await settle();
    expect(menu(d)).toBeNull();
    expect(choiceOf(dom)).toBeUndefined();          // nothing was chosen
  }, 30_000);

  it("keeps the menu on a 375px screen", async () => {
    const dom = await bootWith();
    const d = dom.window.document;
    switchBtn(d).click();
    await settle();
    const css = [...d.querySelectorAll("style")].map((s) => s.textContent).join("");
    expect(css).toMatch(/\.fx-pop\{[^}]*max-width:min\(300px,calc\(100vw - 32px\)\)/);
    expect(css).toMatch(/\.fx-pop\{[^}]*right:0/);
  }, 25_000);

  it("never fetches while live rates are off, even with the menu open", async () => {
    const dom = await boot(ledger([pref("fxOn", false)]), ALL_TIME, STUB);
    await settle();
    const d = dom.window.document;
    switchBtn(d).click();
    await settle();
    for (const tab of ["Overview", "Work", "Life", "Settings", "Today"]) await toProjects(d, tab);
    expect(dom.window.__calls).toEqual([]);
  }, 40_000);
});
