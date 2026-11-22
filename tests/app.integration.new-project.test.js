/**
 * The create card: company and its payday up front, the rest of a project's
 * settings under "More settings". Drives the built artifact.
 */
import { describe, it, expect } from "vitest";
import {
  boot, btn, guardBuiltApp, setValue, settle, toProjects,
} from "./app.integration.helpers.js";

guardBuiltApp();

const WEEKLY = { kind: "weekly", cutoff: 1, payday: 5, after: 0, closesAt: 180, zone: null };
const seed = () => ({
  projects: [{
    id: "a", name: "Gateway", company: "Alignerr", currentRate: 40, currency: "USD",
    createdAt: 1, sessionGoal: null, overallGoal: null,
  }],
  sessions: [],
  companies: [{ id: "co:alignerr", name: "Alignerr", payPeriod: WEEKLY, createdAt: 1, deletedAt: null }],
});
const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
const card = (d) => d.querySelector(".newproject");
const input = (d, label) => [...card(d).querySelectorAll("label.field")]
  .find((l) => l.querySelector(".eyebrow")?.textContent.startsWith(label))?.querySelector("input, select");

const open = async (tab = "Work", state = seed()) => {
  const dom = await boot(state);
  const d = dom.window.document;
  await toProjects(d, tab);
  btn(d, /^New (project|activity|thing)/i)?.click() ?? btn(d, /^New /).click();
  await settle();
  return { dom, d, win: dom.window };
};

describe("the create card", () => {
  it("files a new project under a client that has a payday, and says which", async () => {
    const { dom, d, win } = await open();
    setValue(win, input(d, "Name"), "Onboarding");
    setValue(win, input(d, "Hourly rate"), "90");
    setValue(win, input(d, "Company"), "alignerr");
    await settle();
    expect(card(d).textContent).toMatch(/Paid on Alignerr's payday: Work in before Monday/);
    // A client with a payday keeps it: no schedule boxes to change it from here.
    expect(card(d).textContent).not.toMatch(/has no payday yet/);
    btn(d, /^Add project$/).click();
    await settle();
    const p = stored(dom).projects.find((x) => x.name === "Onboarding");
    // Filed under the client's own spelling, not as a second client.
    expect(p).toMatchObject({ company: "Alignerr", currentRate: 90 });
    // Its company's record is untouched.
    expect(stored(dom).companies).toHaveLength(1);
    expect(stored(dom).companies[0].payPeriod).toEqual(WEEKLY);
  }, 30_000);

  it("gives a new client the payday set on the card", async () => {
    const { dom, d, win } = await open();
    setValue(win, input(d, "Name"), "Labels");
    setValue(win, input(d, "Hourly rate"), "20");
    setValue(win, input(d, "Company"), "Fernhill");
    await settle();
    expect(card(d).textContent).toMatch(/Fernhill has no payday yet/);
    btn(card(d), /^Weekly$/).click();
    await settle();
    btn(d, /^Add project$/).click();
    await settle();
    const s = stored(dom);
    expect(s.projects.find((x) => x.name === "Labels").company).toBe("Fernhill");
    expect(s.companies.find((c) => c.name === "Fernhill").payPeriod).toMatchObject({ kind: "weekly" });
  }, 30_000);

  it("adds a new client with no payday when none is chosen", async () => {
    const { dom, d, win } = await open();
    setValue(win, input(d, "Name"), "Labels");
    setValue(win, input(d, "Hourly rate"), "20");
    setValue(win, input(d, "Company"), "Fernhill");
    await settle();
    btn(d, /^Add project$/).click();
    await settle();
    const s = stored(dom);
    expect(s.projects.find((x) => x.name === "Labels").company).toBe("Fernhill");
    expect(s.companies.some((c) => c.name === "Fernhill")).toBe(false);
  }, 30_000);

  it("keeps the time limit, the acceptance reward and the goals from More settings", async () => {
    const { dom, d, win } = await open();
    setValue(win, input(d, "Name"), "Tasks");
    setValue(win, input(d, "Hourly rate"), "80");
    btn(card(d), /More settings/).click();
    await settle();
    setValue(win, input(d, "Time limit per task"), "2");
    await settle();
    setValue(win, input(d, "Time over it pays"), "30");
    btn(card(d), /^More per hour$/).click();
    await settle();
    setValue(win, input(d, "Extra per hour"), "10");
    const targets = [...card(d).querySelectorAll("label.field")]
      .filter((l) => l.querySelector(".eyebrow")?.textContent === "Target")
      .map((l) => l.querySelector("input"));
    setValue(win, targets[0], "120");
    await settle();
    btn(d, /^Add project$/).click();
    await settle();
    const p = stored(dom).projects.find((x) => x.name === "Tasks");
    expect(p.taskLimits).toEqual([{ from: null, ms: 7_200_000, factor: 0.3 }]);
    expect(p.bonusPerHour).toBe(10);
    expect(p.sessionGoal).toMatchObject({ type: "money", target: 120 });
    expect(p.overallGoal).toBeNull();
  }, 30_000);

  it("refuses a time limit that is not hours above zero, and opens More settings to say so", async () => {
    const { dom, d, win } = await open();
    setValue(win, input(d, "Name"), "Tasks");
    setValue(win, input(d, "Hourly rate"), "80");
    btn(card(d), /More settings/).click();
    await settle();
    setValue(win, input(d, "Time limit per task"), "-1");
    btn(card(d), /More settings/).click();
    await settle();
    btn(d, /^Add project$/).click();
    await settle();
    expect(card(d).querySelector(".err").textContent).toMatch(/time limit/i);
    expect(btn(card(d), /More settings/).getAttribute("aria-expanded")).toBe("true");
    expect(stored(dom)?.projects?.some((x) => x.name === "Tasks") ?? false).toBe(false);
  }, 30_000);

  it("asks for no company off the clock", async () => {
    const { d } = await open("Life");
    expect(input(d, "Company")).toBeUndefined();
    btn(card(d), /More settings/).click();
    await settle();
    expect(card(d).textContent).not.toMatch(/Time limit|Acceptance reward/);
    expect(card(d).textContent).toMatch(/Session goal/);
  }, 30_000);
});
