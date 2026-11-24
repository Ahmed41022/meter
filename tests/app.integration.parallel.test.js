/**
 * Meters running side by side: a project that allows parallel tasks, an
 * ordinary one, and a life activity. Drives the built artifact.
 */
import { describe, it, expect } from "vitest";
import {
  boot, btn, guardBuiltApp, setValue, settle, startMeter, toProjects, until,
} from "./app.integration.helpers.js";

guardBuiltApp();

const project = (id, name, extra = {}) => ({
  id, name, currentRate: 60, currency: "USD", createdAt: 1, sessionGoal: null, overallGoal: null,
  tasks: [{ id: `${id}1`, label: `${name} one`, createdAt: 1 }, { id: `${id}2`, label: `${name} two`, createdAt: 1 }],
  ...extra,
});
const seed = (extra = {}) => ({
  projects: [
    project("a", "Alpha"), project("b", "Beta", { parallelTasks: true }),
    project("c", "Gamma"), project("l", "Garden", { offClock: true }),
  ],
  sessions: [], ...extra,
});
/** A meter already going, fresh unless `ago` says when it was last heard from. */
const meter = (id, projectId, taskId, startedAgo = 60_000, ago = 1_000) => {
  const now = Date.now();
  return {
    id, projectId, taskId, kind: "billed", rate: 60, currency: "USD", createdAt: now - startedAgo,
    segments: [{ startedAt: now - startedAgo, endedAt: null, lastTick: now - ago }],
    closedAt: null, deletedAt: null,
  };
};
const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
const running = (dom) => stored(dom).sessions
  .filter((s) => !s.deletedAt && s.segments.some((g) => g.endedAt == null)).map((s) => s.taskId ?? s.projectId).sort();
const bars = (d) => [...d.querySelectorAll(".runbar")];
const picks = (d) => [...d.querySelectorAll(".meter-pick")];
const openCard = async (d, name, tab = "Work") => {
  btn(d, /All projects|^←/)?.click();
  await settle();
  await toProjects(d, tab);
  [...d.querySelectorAll(".card")].find((c) => c.textContent.includes(name)).click();
  await settle();
};

describe("parallel tasks", () => {
  it("runs two tasks of one project, the newest main and the other in the background", async () => {
    const dom = await boot(seed());
    const d = dom.window.document;
    await openCard(d, "Beta");
    await startMeter(dom, { existing: "Beta one" });
    btn(d, /Start another task/).click();
    await settle();
    // No task is what the box starts on, and it is free; the one going is not.
    const select = d.querySelector(".prompt select");
    setValue(dom.window, select, "b1");
    await settle();
    expect(d.querySelector(".prompt").textContent).toMatch(/“Beta one” already has a meter going/);
    expect(btn(d, /^Start the meter$/).disabled).toBe(true);
    setValue(dom.window, select, "b2");
    await settle();
    btn(d, /^Start the meter$/).click();
    await until(() => running(dom).length === 2, { what: "both meters" });
    await settle();
    expect(running(dom)).toEqual(["b1", "b2"]);
    expect(bars(d).map((b) => [/Beta (one|two)/.exec(b.textContent)[0], /background/.test(b.textContent)]))
      .toEqual([["Beta two", false], ["Beta one", true]]);
    expect(picks(d).map((p) => p.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(d.querySelector(".state").textContent).toBe("Running");

    // The page shows the one picked, says what it is, and can make it main.
    picks(d)[1].click();
    await settle();
    expect(d.querySelector(".state").textContent).toBe("Working in background");
    btn(d, /Make it the main task/).click();
    await settle();
    expect(d.querySelector(".state").textContent).toBe("Running");
    expect(bars(d)[0].textContent).toMatch(/Beta one/);

    // Pause and stop act on the one shown, and leave the other going.
    btn(d, /^Pause$/).click();
    await settle();
    expect(running(dom)).toEqual(["b2"]);
    btn(d, /^Resume$/).click();
    await settle();
    expect(running(dom)).toEqual(["b1", "b2"]);
    btn(d, /Stop and save/).click();
    await settle();
    expect(running(dom)).toEqual(["b2"]);
    expect(picks(d)).toEqual([]);
  }, 30_000);

  it("runs it behind an ordinary project, which another ordinary one still replaces", async () => {
    const dom = await boot(seed());
    const d = dom.window.document;
    await openCard(d, "Alpha");
    await startMeter(dom, { existing: "Alpha one" });
    expect(btn(d, /Start another task/)).toBeUndefined();
    await openCard(d, "Beta");
    btn(d, /Start the meter/).click();
    await settle();
    setValue(dom.window, d.querySelector(".prompt select"), "b1");
    btn(d, /Start the meter/).click();
    await until(() => running(dom).length === 2, { what: "both meters" });
    await settle();
    // Started last, and still the one in the background: the other cannot be.
    expect(d.querySelector(".state").textContent).toBe("Working in background");
    expect(btn(d, /Make it the main task/)).toBeUndefined();
    expect(bars(d)[0].textContent).toMatch(/Alpha/);
    await openCard(d, "Gamma");
    await startMeter(dom, { existing: "Gamma one" });
    expect(running(dom)).toEqual(["b1", "c1"]);
  }, 30_000);

  it("runs a life activity beside work, without calling it background work", async () => {
    const dom = await boot(seed());
    const d = dom.window.document;
    await openCard(d, "Alpha");
    await startMeter(dom, { existing: "Alpha one" });
    await openCard(d, "Garden", "Life");
    btn(d, /Start tracking/).click();
    await settle();
    btn(d, /Start tracking/).click();
    await until(() => running(dom).length === 2, { what: "both meters" });
    await settle();
    expect(bars(d).map((b) => /background/.test(b.textContent))).toEqual([false, false]);
    expect(bars(d)[0].textContent).toMatch(/Alpha/);
    expect(d.querySelector(".state").textContent).toBe("Running");
  }, 30_000);

  it("stops each from its own bar", async () => {
    const dom = await boot(seed({ sessions: [meter("s1", "b", "b1"), meter("s2", "b", "b2", 30_000)] }));
    const d = dom.window.document;
    await settle();
    expect(bars(d).length).toBe(2);
    [...bars(d)[1].querySelectorAll("button")].find((b) => b.textContent === "Stop").click();
    await settle();
    expect(running(dom)).toEqual(["b2"]);
  }, 30_000);

  it("offers on Today only what can start without stopping a meter", async () => {
    const past = (id, projectId, taskId) => {
      const now = Date.now();
      return { ...meter(id, projectId, taskId), createdAt: now - 7_200_000, closedAt: now - 3_600_000,
        segments: [{ startedAt: now - 7_200_000, endedAt: now - 3_600_000 }] };
    };
    const dom = await boot(seed({ sessions: [
      past("p1", "c", "c1"), past("p2", "b", "b1"), past("p3", "b", "b2"), past("p4", "l", "l1"),
      meter("s1", "a", "a1"), meter("s2", "b", "b1"),
    ] }));
    const d = dom.window.document;
    await settle();
    expect([...d.querySelectorAll(".again-task")].map((x) => x.textContent).sort())
      .toEqual(["Beta two", "Garden one"]);
  }, 30_000);

  it("asks about every meter left running, one after another", async () => {
    const dom = await boot(seed({ sessions: [
      meter("s1", "b", "b1", 7_200_000, 3_600_000), meter("s2", "b", "b2", 7_100_000, 3_600_000),
    ] }));
    const d = dom.window.document;
    await settle();
    const asked = () => [...d.querySelectorAll(".banner")].filter((b) => /Meter left running/.test(b.textContent)).length;
    expect(asked()).toBe(1);
    btn(d, /^Stop at/).click();
    await settle();
    expect(running(dom)).toHaveLength(1);
    expect(asked()).toBe(1);
    btn(d, /Keep counting/).click();
    await settle();
    expect(asked()).toBe(0);
    expect(running(dom)).toHaveLength(1);
  }, 30_000);

  it("is turned on in a project's settings", async () => {
    const dom = await boot(seed());
    const d = dom.window.document;
    await openCard(d, "Alpha");
    const group = () => d.querySelector("[aria-label=\"Whether this project's tasks can run in parallel\"]");
    [...d.querySelectorAll(".sec-head")].find((h) => /^Settings/.test(h.textContent))
      .querySelector("button").click();
    await settle();
    [...group().querySelectorAll("button")].find((b) => b.textContent === "Allowed").click();
    await settle();
    expect(stored(dom).projects.find((p) => p.id === "a").parallelTasks).toBe(true);
  }, 30_000);
});
