/**
 * The Settings tab: where the theme, backup, restore, CSV and Sync controls
 * live now that they are off the footer and the Work tab. Drives the built
 * artifact like the other app.integration files.
 */
import { describe, it, expect } from "vitest";
import { boot, btn, guardBuiltApp, settle, toProjects, wait } from "./app.integration.helpers.js";

guardBuiltApp();

const seed = {
  projects: [{
    id: "a", name: "Orion", currentRate: 20, currency: "USD",
    createdAt: Date.now() - 86_400_000, sessionGoal: null, overallGoal: null, tasks: [],
  }],
  sessions: [],
};

const tabNames = (d) => [...d.querySelectorAll("[role=tab]")]
  .filter((t) => t.closest(".tabs")).map((t) => t.textContent);
const CONTROLS = [/^Export backup$/, /^Restore$/, /^Export CSV$/];

describe("the Settings tab", () => {
  it("is the fifth tab, after Life, and opens its own view", async () => {
    const dom = await boot(seed);
    const d = dom.window.document;
    await settle();
    expect(tabNames(d)).toEqual(["Today", "Overview", "Work", "Life", "Settings"]);
    await toProjects(d, "Settings");
    expect(d.querySelector("[role=tab][aria-selected=true]").textContent).toBe("Settings");
    const titles = [...d.querySelectorAll(".settings-title")].map((h) => h.textContent);
    expect(titles).toEqual(["Appearance", "Defaults", "Companies & paydays", "Sync & backup"]);
  }, 25_000);

  it("holds the theme switch, which is no longer in the footer", async () => {
    const dom = await boot(seed);
    const d = dom.window.document;
    await settle();
    expect(d.querySelector(".foot .theme")).toBeNull();
    expect(d.querySelector(".theme")).toBeNull();
    await toProjects(d, "Settings");
    expect(d.querySelector(".theme")).not.toBeNull();
    expect(d.querySelector(".foot .theme")).toBeNull();
    // The footer keeps the version line.
    expect(d.querySelector(".foot .version").textContent).toMatch(/^Meter v/);
  }, 25_000);

  it("still saves the theme choice, per device", async () => {
    const dom = await boot(seed);
    const d = dom.window.document;
    await settle();
    await toProjects(d, "Settings");
    d.querySelector('.theme [aria-label="Dark"]').click();
    await settle();
    expect(d.querySelector(".mtr").getAttribute("data-theme")).toBe("dark");
    expect(dom.window.localStorage.getItem("meter:theme")).toBe("dark");
  }, 25_000);

  it("has Export backup, Restore and Export CSV, and Work and Life have none of them", async () => {
    const dom = await boot(seed);
    const d = dom.window.document;
    await settle();
    await toProjects(d, "Settings");
    for (const re of CONTROLS) expect(btn(d, re), String(re)).toBeTruthy();
    expect(d.querySelector(".backup-note")).not.toBeNull();
    for (const tab of ["Work", "Life"]) {
      await toProjects(d, tab);
      for (const re of CONTROLS) expect(btn(d, re), `${tab}: ${re}`).toBeUndefined();
      expect(d.querySelector("input[type=file]"), tab).toBeNull();
      expect(d.querySelector(".backup-note"), tab).toBeNull();
    }
  }, 25_000);

  it("renders the sync block, and not on the Work tab any more", async () => {
    const dom = await boot(seed);
    const d = dom.window.document;
    await settle();
    const sync = () => [...d.querySelectorAll(".sec")]
      .find((x) => /^Sync/.test(x.querySelector(".eyebrow")?.textContent ?? ""));
    await toProjects(d, "Settings");
    expect(sync()).toBeTruthy();
    expect(sync().textContent).toMatch(/client ID/i);
    await toProjects(d, "Work");
    expect(sync()).toBeUndefined();
  }, 25_000);

  it("can confirm a restore from Settings, and stays there afterwards", async () => {
    const dom = await boot(seed);
    const d = dom.window.document;
    await settle();
    await toProjects(d, "Settings");
    const file = { projects: [{ ...seed.projects[0], id: "x", name: "Gateway" }], sessions: [] };
    const input = d.querySelector("input[type=file]");
    const chosen = new dom.window.File([JSON.stringify(file)], "b.json", { type: "application/json" });
    Object.defineProperty(input, "files", { value: [chosen], configurable: true });
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    for (let waited = 0; waited < 5000 && !d.querySelector(".restore"); waited += 50) await wait(50);
    expect(d.querySelector(".restore")).not.toBeNull();
    btn(d.querySelector(".restore"), /^Replace my ledger$/).click();
    await settle();
    expect(d.querySelector(".restore")).toBeNull();
    expect(d.querySelector(".toast").textContent).toMatch(/Backup restored/);
    expect(d.querySelector("[role=tab][aria-selected=true]").textContent).toBe("Settings");
    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.projects.map((p) => p.name)).toEqual(["Gateway"]);
    // The controls are back in place of the confirmation.
    expect(btn(d, /^Restore$/)).toBeTruthy();
  }, 25_000);
});
