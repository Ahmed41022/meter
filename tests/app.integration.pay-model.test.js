/**
 * "How it pays" in a project's settings. Drives the built artifact.
 */
import { describe, it, expect } from "vitest";
import { boot, btn, guardBuiltApp, setValue, settle, toProjects } from "./app.integration.helpers.js";

guardBuiltApp();

const H = 3_600_000;
const seed = (project = {}) => {
  const now = Date.now();
  const s = (id, taskId, extra = {}) => ({
    id, projectId: "p", taskId, kind: "billed", rate: project.currentRate ?? 20, currency: "USD", createdAt: now - 50 * H,
    segments: [{ startedAt: now - 50 * H, endedAt: now - 48 * H }], closedAt: now - 48 * H, deletedAt: null, ...extra,
  });
  return {
    projects: [{
      id: "p", name: "Gateway", currentRate: 20, currency: "USD", createdAt: 1, sessionGoal: null, overallGoal: null,
      tasks: [
        { id: "done", label: "Done", createdAt: 1, state: "accepted", stateAt: now - 40 * H, submittedAt: now - 45 * H },
        { id: "open", label: "Open", createdAt: 1 },
      ],
      ...project,
    }],
    sessions: [s("a", "done"), s("b", "open", { segments: [{ startedAt: now - 30 * H, endedAt: now - 29 * H }], closedAt: now - 29 * H })],
  };
};
const PER_TASK = { currentRate: 0, perTask: 500, paysOnAcceptance: true };
const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
const proj = (dom) => stored(dom).projects[0];
const section = (d) => [...d.querySelectorAll(".sec")].find((x) => /^Settings/.test(x.querySelector(".sec-head")?.textContent ?? ""));
const toggle = async (d) => { section(d).querySelector(".sec-head button").click(); await settle(); };
const open = async (state, tab = "Work") => {
  const dom = await boot(state);
  const d = dom.window.document;
  await toProjects(d, tab);
  d.querySelector(".card").click();
  await settle();
  await toggle(d);
  return { dom, d };
};
const choose = async (d, label, words) => {
  [...d.querySelectorAll(`[aria-label="${label}"] button`)].find((b) => b.textContent === words).click();
  await settle();
};
const model = (d, words) => choose(d, "How this project pays", words);
const reach = (d, words) => choose(d, "How far the change reaches", words);
const field = (d, label) => [...section(d).querySelectorAll("label.field")]
  .find((l) => l.querySelector(".eyebrow")?.textContent.startsWith(label))?.querySelector("input");
const type = async (dom, el, v) => { setValue(dom.window, el, v); await settle(); };
const save = (d) => [...section(d).querySelectorAll("button")].find((b) => /Save changes/.test(b.textContent));
const words = (d) => section(d).textContent;

describe("how a project pays, in its settings", () => {
  it("moves an hourly project to per task, from now on, and refuses it without a price", async () => {
    const { dom, d } = await open(seed());
    await model(d, "Per task");
    expect(field(d, "Hourly rate")).toBeUndefined();
    expect(words(d)).not.toMatch(/Acceptance reward/);
    expect(save(d).disabled).toBe(true);
    expect(words(d)).toMatch(/What does one task pay\?/);
    await type(dom, field(d, "Per accepted task"), "0");
    expect(save(d).disabled).toBe(true);
    await type(dom, field(d, "Per accepted task"), "500");
    expect(words(d)).toMatch(/Apply the new way it pays/);
    save(d).click();
    await settle();
    expect(proj(dom)).toMatchObject({ currentRate: 0, perTask: 500, paysOnAcceptance: true, bonusPerHour: null });
    expect(stored(dom).sessions.map((s) => s.rate)).toEqual([20, 0]);
    expect(words(d)).toMatch(/Saved/);
    // What was earned by the hour before is still there to be seen.
    const row = (label) => [...d.querySelectorAll(".trow")].find((x) => x.querySelector(".trow-label")?.textContent.startsWith(label));
    expect(row("Done").querySelector(".trow-amt").textContent).toBe("$40.00");
    expect(row("Open").querySelector(".trow-amt")).toBeNull();
  }, 30_000);

  it("reaches the past when asked, and can be undone", async () => {
    const { dom, d } = await open(seed());
    await model(d, "Per task");
    await type(dom, field(d, "Per accepted task"), "500");
    await reach(d, "Past included");
    expect(words(d)).toMatch(/Hours already recorded stop paying/);
    save(d).click();
    await settle();
    expect(stored(dom).sessions.map((s) => s.rate)).toEqual([0, 0]);
    expect(stored(dom).earnings.map((e) => [e.taskIds[0], e.cents, e.status])).toEqual([["done", 50_000, "paid"]]);
    btn(d, /^Undo$/).click();
    await settle();
    expect(proj(dom)).toMatchObject({ currentRate: 20 });
    expect(proj(dom).perTask ?? null).toBeNull();
    expect(stored(dom).sessions.map((s) => s.rate)).toEqual([20, 20]);
    expect((stored(dom).earnings ?? []).length).toBe(0);
  }, 30_000);

  it("shows a per-task project as one, with no false warning, and never saves it without a price", async () => {
    const { dom, d } = await open(seed(PER_TASK));
    const on = () => d.querySelector('[aria-label="How this project pays"] [aria-selected="true"]').textContent;
    expect(on()).toBe("Per task");
    expect(words(d)).not.toMatch(/has to be a number above zero|What does/);
    await type(dom, field(d, "Per accepted task"), "");
    expect(save(d).disabled).toBe(true);
    await type(dom, field(d, "Per accepted task"), "600");
    save(d).click();
    await settle();
    expect(proj(dom)).toMatchObject({ perTask: 600, currentRate: 0 });
  }, 30_000);

  it("moves it back by the hour, needing a rate, and drops the price unless a flat amount is chosen", async () => {
    const { dom, d } = await open(seed(PER_TASK));
    await model(d, "By the hour");
    expect(save(d).disabled).toBe(true);
    expect(words(d)).toMatch(/What does an hour pay\?/);
    await type(dom, field(d, "Hourly rate"), "0");
    expect(save(d).disabled).toBe(true);
    await type(dom, field(d, "Hourly rate"), "30");
    save(d).click();
    await settle();
    expect(proj(dom)).toMatchObject({ currentRate: 30, perTask: null, paysOnAcceptance: true });
    expect(stored(dom).sessions.map((s) => s.rate)).toEqual([0, 30]);
  }, 30_000);

  it("keeps a flat amount on top of the hours when that is chosen", async () => {
    const { dom, d } = await open(seed(PER_TASK));
    await model(d, "By the hour");
    await type(dom, field(d, "Hourly rate"), "30");
    await choose(d, "What acceptance pays", "A flat amount");
    expect(field(d, "Per accepted task").value).toBe("500");
    save(d).click();
    await settle();
    expect(proj(dom)).toMatchObject({ currentRate: 30, perTask: 500 });
  }, 30_000);

  it("is part of the form: discarded, kept as a draft, and nothing unsaved when put back", async () => {
    const { dom, d } = await open(seed(PER_TASK));
    const on = () => d.querySelector('[aria-label="How this project pays"] [aria-selected="true"]').textContent;
    await model(d, "By the hour");
    await model(d, "Per task");
    expect(save(d)).toBeUndefined();
    await model(d, "By the hour");
    await toggle(d);
    await toggle(d);
    expect(on()).toBe("By the hour");
    expect(words(d)).toMatch(/Unsaved/);
    btn(d, /^Discard$/).click();
    await settle();
    expect(on()).toBe("Per task");
    expect(proj(dom)).toMatchObject(PER_TASK);
  }, 30_000);

  it("points an hourly project at a control that exists", async () => {
    const { dom, d } = await open(seed());
    await type(dom, field(d, "Hourly rate"), "0");
    expect(words(d)).toMatch(/choose Per task above/);
    save(d).click();
    await settle();
    expect(proj(dom).currentRate).toBe(20);
  }, 30_000);

  it("is not offered off the clock", async () => {
    const { d } = await open(seed({ offClock: true, currentRate: 0 }), "Life");
    expect(d.querySelector('[aria-label="How this project pays"]')).toBeNull();
    expect(words(d)).not.toMatch(/What does/);
  }, 30_000);
});
