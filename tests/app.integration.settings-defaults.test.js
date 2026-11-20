/**
 * The Defaults section of the Settings tab: a synced preference that decides
 * which period the Overview opens on. Drives the built artifact.
 */
import { describe, it, expect } from "vitest";
import {
  boot, btn, guardBuiltApp, setValue, settle, toProjects,
} from "./app.integration.helpers.js";

guardBuiltApp();

const seed = {
  projects: [{
    id: "a", name: "Orion", currentRate: 20, currency: "USD",
    createdAt: Date.now() - 86_400_000, sessionGoal: null, overallGoal: null, tasks: [],
  }],
  sessions: [],
};
const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
const section = (d) => d.querySelector("#settings-defaults").parentElement;
const chosen = (d) => d.querySelector(".dash-head [role=tab][aria-selected=true]")?.textContent;

const setDefault = async (dom, value) => {
  const d = dom.window.document;
  await toProjects(d, "Settings");
  setValue(dom.window, section(d).querySelector("select"), value);
  await settle();
};

describe("the Defaults section", () => {
  it("sits between Appearance and Sync & backup, and says it is shared", async () => {
    const dom = await boot(seed);
    const d = dom.window.document;
    await settle();
    await toProjects(d, "Settings");
    expect([...d.querySelectorAll(".settings-title")].map((h) => h.textContent))
      .toEqual(["Appearance", "Defaults", "Currency", "Companies & paydays", "Sync & backup"]);
    expect(section(d).textContent).toMatch(/Shared by every device that syncs/);
  }, 25_000);

  it("offers the last-used choice first, then each period", async () => {
    const dom = await boot(seed);
    const d = dom.window.document;
    await settle();
    await toProjects(d, "Settings");
    const select = section(d).querySelector("select");
    expect([...select.options].map((o) => o.textContent))
      .toEqual(["The last one used on this device", "Day", "Week", "Month", "Year", "All"]);
    expect(select.value).toBe("last");
  }, 25_000);

  it("opens the Overview on the chosen period after a reload, over this device's own memory", async () => {
    const dom = await boot(seed, { "meter:period": "week" });
    await settle();
    await setDefault(dom, "month");
    // A reload: a fresh page over the same stored ledger and device settings.
    const again = await boot(stored(dom), { "meter:period": "week" });
    await settle();
    await toProjects(again.window.document, "Overview");
    expect(chosen(again.window.document)).toBe("Month");
  }, 30_000);

  it("keeps this device's remembered period while the default is last", async () => {
    const dom = await boot(seed, { "meter:period": "year" });
    await settle();
    await toProjects(dom.window.document, "Overview");
    expect(chosen(dom.window.document)).toBe("Year");
  }, 25_000);

  it("still remembers a period picked on the Overview, whatever the default", async () => {
    const dom = await boot({
      ...seed,
      prefs: [{ id: "overviewPeriod", value: "month", createdAt: 1, updatedAt: 1, deletedAt: null }],
    });
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Overview");
    expect(chosen(d)).toBe("Month");
    btn(d, /^Day$/).click();
    await settle();
    expect(dom.window.localStorage.getItem("meter:period")).toBe("day");
  }, 25_000);

  it("is stored in the ledger, stamped, and carried by an exported backup", async () => {
    const dom = await boot(seed);
    const d = dom.window.document;
    await settle();
    await setDefault(dom, "year");
    const record = stored(dom).prefs.find((r) => r.id === "overviewPeriod");
    expect(record).toMatchObject({ value: "year", deletedAt: null });
    expect(typeof record.updatedAt).toBe("number");

    const written = [];
    const RealBlob = dom.window.Blob;
    dom.window.Blob = function Caught(parts, opts) {
      written.push(parts.map(String).join(""));
      return new RealBlob(parts, opts);
    };
    dom.window.URL.createObjectURL = () => "blob:x";
    dom.window.URL.revokeObjectURL = () => {};
    btn(d, /^Export backup$/).click();
    await settle();
    dom.window.Blob = RealBlob;
    expect(JSON.parse(written[0]).prefs.find((r) => r.id === "overviewPeriod").value).toBe("year");
  }, 25_000);

  it("does not make a backup look overdue or count as a record", async () => {
    const dom = await boot({ ...seed, lastBackupAt: Date.now() - 30 * 86_400_000 });
    const d = dom.window.document;
    await settle();
    await setDefault(dom, "week");
    expect(d.querySelector(".backup-note").textContent).not.toMatch(/since/);
    expect([...d.querySelectorAll(".banner")].some((b) => /backed up/i.test(b.textContent)))
      .toBe(false);
  }, 25_000);
});
