/**
 * The Companies & paydays section of the Settings tab: every client and its
 * payday in one list, with the schedule editable in place. Drives the built
 * artifact.
 */
import { describe, it, expect } from "vitest";
import { paydayFor } from "../src/domain/payPeriod.js";
import {
  boot, bootDash, bootPayments, btn, guardBuiltApp, setValue, settle, toProjects,
} from "./app.integration.helpers.js";

guardBuiltApp();

const HOUR = 3_600_000;
const WED = { kind: "weekly", cutoff: 1, payday: 3, after: 0, closesAt: 0, zone: null };
const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
const recordOf = (dom, name) => stored(dom).companies.find((c) => c.name === name);

/** A payday as the app prints it, so the expected date is worked out by the
 *  domain and not copied from the screen. */
const printed = (rule) => new Date(`${paydayFor(rule, Date.now()).date}T00:00:00Z`)
  .toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", day: "numeric", month: "long" });

const project = (id, company, extra = {}) => {
  const now = Date.now();
  return {
    id, name: `${id} work`, company, currentRate: 40, currency: "USD", createdAt: now - 80 * HOUR,
    sessionGoal: null, overallGoal: null,
    tasks: [{ id: `${id}-t`, label: `${id} task`, createdAt: now - 80 * HOUR,
              state: "accepted", stateAt: now - HOUR, submittedAt: now - 2 * HOUR }],
    ...extra,
  };
};
const ledger = (projects, rules = {}) => ({
  projects,
  sessions: projects.flatMap((p) => (p.offClock ? [] : p.tasks.map((t, i) => ({
    id: `s-${p.id}`, projectId: p.id, kind: "billed", taskId: t.id, rate: 40, currency: "USD",
    createdAt: Date.now() - (i + 3) * HOUR, closedAt: Date.now() - (i + 2) * HOUR, deletedAt: null,
    segments: [{ startedAt: Date.now() - (i + 3) * HOUR, endedAt: Date.now() - (i + 2) * HOUR }],
  })))),
  earnings: [],
  companies: Object.entries(rules).map(([name, payPeriod]) => ({
    id: `co:${name.toLowerCase()}`, name, payPeriod, createdAt: 1, deletedAt: null,
  })),
});

const open = async (seed) => {
  const dom = await boot(seed);
  const d = dom.window.document;
  await settle();
  await toProjects(d, "Settings");
  return { dom, d };
};
const section = (d) => d.querySelector("#settings-companies").parentElement;
const rows = (d) => [...section(d).querySelectorAll(".company-row")];
const rowOf = (d, name) => rows(d).find((r) => r.querySelector(".company-name").textContent === name);
const edit = async (d, name) => {
  btn(rowOf(d, name), /^Edit$/).click();
  await settle();
};
const control = (scope, label) => [...scope.querySelectorAll(".field")]
  .find((f) => new RegExp(`^${label}$`, "i").test(f.querySelector(".eyebrow")?.textContent ?? ""))
  ?.querySelector("input, select");
const payLabels = (d) => [...d.querySelectorAll(".payrow .trow-label")].map((e) => e.textContent);

describe("Companies & paydays", () => {
  it("sits between Defaults and Sync & backup", async () => {
    const { d } = await open(ledger([project("a", "Acme")]));
    expect([...d.querySelectorAll(".settings-title")].map((h) => h.textContent))
      .toEqual(["Appearance", "Defaults", "Currency", "Companies & paydays", "Sync & backup"]);
  }, 25_000);

  it("lists each client once, with its schedule in words, project count and next payday", async () => {
    const { d } = await open(ledger(
      [project("a", "Northwind"), project("b", "northwind"), project("c", "Acme")],
      { Northwind: WED },
    ));
    expect(rows(d).map((r) => r.querySelector(".company-name").textContent))
      .toEqual(["Acme", "Northwind"]);
    const north = rowOf(d, "Northwind").textContent;
    expect(north).toContain("Work in before Monday is paid the following Wednesday.");
    expect(north).toContain("2 projects");
    expect(north).toContain(`next payday ${printed(WED)}`);
  }, 25_000);

  it("says No schedule for a company that has none, and gives it no next payday", async () => {
    const { d } = await open(ledger([project("c", "Acme")]));
    const row = rowOf(d, "Acme").textContent;
    expect(row).toContain("No schedule");
    expect(row).toContain("1 project");
    expect(row).not.toMatch(/next payday/);
  }, 25_000);

  it("says what it is waiting for when there are no clients", async () => {
    const { d } = await open(ledger([project("a", undefined)]));
    expect(rows(d)).toHaveLength(0);
    expect(section(d).textContent).toMatch(/once a work project names a company/);
  }, 25_000);

  it("never lists off-clock projects", async () => {
    const { d } = await open(ledger([project("a", "Acme"), project("z", "Sleepco", { offClock: true })]));
    expect(rows(d).map((r) => r.querySelector(".company-name").textContent)).toEqual(["Acme"]);
  }, 25_000);

  it("edits a schedule in place, warns it is shared, and Payments moves to the new dates", async () => {
    const seed = ledger([project("a", "Acme"), project("b", "Acme")], { Acme: WED });
    const { dom, d } = await open(seed);
    await edit(d, "Acme");
    const row = rowOf(d, "Acme");
    expect(row.querySelector(".hint.warn").textContent)
      .toMatch(/shared by every Acme project \(2 of them\)/);
    // Nothing changed yet, so nothing to save.
    expect(btn(row, /^Save$/).disabled).toBe(true);
    setValue(dom.window, control(row, "Is paid on"), "5");
    await settle();
    expect(btn(row, /^Save$/).disabled).toBe(false);
    btn(row, /^Save$/).click();
    await settle();

    expect(recordOf(dom, "Acme").payPeriod).toMatchObject({ kind: "weekly", cutoff: 1, payday: 5 });
    expect(typeof recordOf(dom, "Acme").updatedAt).toBe("number");
    expect(d.querySelector(".toast").textContent).toMatch(/Payday saved for Acme/);
    // The editor closed and the row reads the new schedule.
    expect(rowOf(d, "Acme").querySelector(".company-edit")).toBeNull();
    expect(rowOf(d, "Acme").textContent).toContain("paid the following Friday");

    await toProjects(d, "Payments");
    expect(payLabels(d).length).toBeGreaterThan(0);
    expect(payLabels(d).every((l) => /^Fri/.test(l))).toBe(true);
  }, 30_000);

  it("keeps a payday that has passed where it was, and moves only those still to come", async () => {
    // One task paid on a Wednesday a few weeks back, still listed as overdue,
    // and one paid on the coming Wednesday.
    const DAY = 24 * HOUR;
    const old = project("o", "Acme");
    old.tasks[0] = { ...old.tasks[0], stateAt: Date.now() - 30 * DAY, submittedAt: Date.now() - 30 * DAY - HOUR };
    const seed = { ...ledger([old, project("a", "Acme")], { Acme: WED }), payouts: [] };
    const dom = await bootPayments(seed, { "meter:payouts-asked": "1" });
    const d = dom.window.document;
    const before = payLabels(d);
    const overdue = before.filter((l) => /^Overdue/.test(l));
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatch(/Wed/);

    await toProjects(d, "Settings");
    await edit(d, "Acme");
    expect(rowOf(d, "Acme").textContent).toMatch(/Paydays already passed keep their dates/);
    setValue(dom.window, control(rowOf(d, "Acme"), "Is paid on"), "5");
    await settle();
    btn(rowOf(d, "Acme"), /^Save$/).click();
    await settle();
    expect(recordOf(dom, "Acme").history).toHaveLength(1);

    await toProjects(d, "Payments");
    const after = payLabels(d);
    expect(after.filter((l) => /^Overdue/.test(l))).toEqual(overdue);
    expect(after.filter((l) => !/^Overdue/.test(l)).every((l) => /^Fri/.test(l))).toBe(true);
  }, 30_000);

  it("can switch a client from weekly to monthly", async () => {
    const { dom, d } = await open(ledger([project("a", "Acme")], { Acme: WED }));
    await edit(d, "Acme");
    btn(rowOf(d, "Acme"), /^Monthly$/).click();
    await settle();
    btn(rowOf(d, "Acme"), /^Save$/).click();
    await settle();
    expect(recordOf(dom, "Acme").payPeriod).toMatchObject({ kind: "monthly", cutoff: 1, payday: 15 });
  }, 25_000);

  it("Undo puts the old schedule back as a stamped edit, not a removal", async () => {
    const { dom, d } = await open(ledger([project("a", "Acme")], { Acme: WED }));
    await edit(d, "Acme");
    setValue(dom.window, control(rowOf(d, "Acme"), "Is paid on"), "5");
    await settle();
    btn(rowOf(d, "Acme"), /^Save$/).click();
    await settle();
    const stampedAfterSave = recordOf(dom, "Acme").updatedAt;
    btn(d.querySelector(".toast"), /^Undo$/).click();
    await settle();
    const record = recordOf(dom, "Acme");
    expect(record.payPeriod).toMatchObject({ kind: "weekly", cutoff: 1, payday: 3 });
    expect(record.deletedAt).toBeNull();
    expect(record.updatedAt).toBeGreaterThanOrEqual(stampedAfterSave);
    expect(rowOf(d, "Acme").textContent).toContain("paid the following Wednesday");
  }, 30_000);

  it("Undo of a first schedule leaves the client with none, and the record in place", async () => {
    const { dom, d } = await open(ledger([project("a", "Acme")]));
    await edit(d, "Acme");
    btn(rowOf(d, "Acme"), /^Weekly$/).click();
    await settle();
    btn(rowOf(d, "Acme"), /^Save$/).click();
    await settle();
    expect(recordOf(dom, "Acme").payPeriod.kind).toBe("weekly");
    btn(d.querySelector(".toast"), /^Undo$/).click();
    await settle();
    expect(recordOf(dom, "Acme").payPeriod).toBeNull();
    expect(rowOf(d, "Acme").textContent).toContain("No schedule");
  }, 30_000);

  it("Cancel discards the edit", async () => {
    const { dom, d } = await open(ledger([project("a", "Acme")], { Acme: WED }));
    const before = JSON.stringify(stored(dom));
    await edit(d, "Acme");
    setValue(dom.window, control(rowOf(d, "Acme"), "Is paid on"), "5");
    await settle();
    btn(rowOf(d, "Acme"), /^Cancel$/).click();
    await settle();
    expect(rowOf(d, "Acme").querySelector(".company-edit")).toBeNull();
    expect(JSON.stringify(stored(dom))).toBe(before);
    // Opened again, it starts from what is saved, not from the abandoned edit.
    await edit(d, "Acme");
    expect(control(rowOf(d, "Acme"), "Is paid on").value).toBe("3");
  }, 25_000);

  it("opens one editor at a time", async () => {
    const { d } = await open(ledger([project("a", "Acme"), project("b", "Beta")]));
    await edit(d, "Acme");
    await edit(d, "Beta");
    expect(section(d).querySelectorAll(".company-edit")).toHaveLength(1);
    expect(rowOf(d, "Beta").querySelector(".company-edit")).not.toBeNull();
  }, 25_000);
});

describe("the link from a project's settings", () => {
  it("opens the Settings tab and closes the project", async () => {
    const dom = await bootDash(ledger([project("a", "Acme")]));
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    btn(d, /^Open$/).click();
    await settle();
    expect(d.querySelector(".wrap").textContent).toMatch(/Every client.s payday is also listed in Settings\./);
    [...d.querySelectorAll(".linkish")].find((b) => b.textContent === "Settings").click();
    await settle();
    expect(d.querySelector("[role=tab][aria-selected=true]").textContent).toBe("Settings");
    expect(d.querySelector(".topbar .linkbtn")).toBeNull();
    expect(d.querySelector("#settings-companies")).not.toBeNull();
  }, 25_000);
});
