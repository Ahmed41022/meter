/**
 * Tasks with a minimum time: the clock counts down to it, and says when it is
 * met. Drives the built artifact.
 */
import { describe, it, expect } from "vitest";
import { boot, btn, guardBuiltApp, setValue, settle, toProjects, until, wait } from "./app.integration.helpers.js";

guardBuiltApp();

const H = 3_600_000;
const seed = ({ project = {}, task = {}, done = 0, running = null } = {}) => {
  const now = Date.now();
  const s = (id, segments, closedAt) => ({
    id, projectId: "p", taskId: "t1", kind: "billed", rate: 60, currency: "USD", createdAt: segments[0].startedAt,
    segments, closedAt, deletedAt: null,
  });
  return {
    projects: [{
      id: "p", name: "Long haul", currentRate: 60, currency: "USD", createdAt: 1, sessionGoal: null,
      overallGoal: null, tasks: [{ id: "t1", label: "Eight hours", createdAt: 1, ...task }], ...project,
    }],
    sessions: [
      ...(done ? [s("d", [{ startedAt: now - 30 * H, endedAt: now - 30 * H + done }], now - 30 * H + done)] : []),
      ...(running !== null ? [s("r", [{ startedAt: now - running, endedAt: null, lastTick: now }], null)] : []),
    ],
  };
};
const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
const secs = (text) => {
  const [h, m, s] = /(\d+):(\d\d):(\d\d)/.exec(text).slice(1).map(Number);
  return h * 3600 + m * 60 + s;
};
const open = async (dom) => {
  const d = dom.window.document;
  await toProjects(d);
  d.querySelector(".card").click();
  await settle();
  return d;
};
const field = (root, label) => [...root.querySelectorAll("label.field")]
  .find((l) => l.querySelector(".eyebrow")?.textContent.startsWith(label))?.querySelector("input");

describe("a task with a minimum", () => {
  it("counts down across its sittings, on the bar and on its page", async () => {
    const dom = await boot(seed({ project: { taskMinMs: 8 * H }, done: 2 * H, running: H }));
    const d = await open(dom);
    const bar = () => d.querySelector(".runbar-time").textContent;
    expect(Math.abs(secs(bar()) - 5 * 3600)).toBeLessThan(15);
    expect(d.querySelector(".runbar").textContent).toMatch(/to go of 8h/);
    expect(Math.abs(secs(d.querySelector(".clock-main").textContent) - 5 * 3600)).toBeLessThan(15);
    expect(d.querySelector(".clock-note").textContent).toMatch(/to go of 8h minimum/);
    const before = secs(bar());
    await wait(2200);
    expect(secs(bar())).toBeLessThan(before);
    expect([...d.querySelectorAll(".trow-sub")].map((x) => x.textContent).join("|")).toMatch(/5h 00m to go of 8h minimum|4h 59m to go of 8h minimum/);
  }, 30_000);

  it("says so once it is met, and goes back to counting up", async () => {
    const dom = await boot(seed({ task: { minMs: 2 * H }, done: H, running: H - 1500 }));
    const d = await open(dom);
    await until(() => /Eight hours has met its 2h minimum/.test(d.querySelector(".toast")?.textContent ?? ""),
      { what: "the notice", timeout: 8_000 });
    expect(d.querySelector(".runbar").textContent).toMatch(/2h min met/);
    expect(Math.abs(secs(d.querySelector(".runbar-time").textContent) - 3600)).toBeLessThan(15);
    expect(d.querySelector(".clock-note").textContent).toMatch(/2h minimum met/);
  }, 30_000);

  it("warns on handing one in short, and lets it go in", async () => {
    const dom = await boot(seed({ project: { taskMinMs: 8 * H }, done: 2 * H }));
    const d = await open(dom);
    d.querySelector(".sec input[type=checkbox]").click();
    await settle();
    expect([...d.querySelectorAll(".hint.warn")].map((x) => x.textContent).join("|"))
      .toMatch(/“Eight hours” is 6h 00m short of its 8h minimum/);
    btn(d, /^Submit 1$/).click();
    await settle();
    expect(stored(dom).projects[0].tasks[0].state).toBe("submitted");
    expect([...d.querySelectorAll(".trow-sub")].map((x) => x.textContent).join("|")).not.toMatch(/minimum/);
  }, 30_000);

  it("is set on a project, on a new task and on one task", async () => {
    const dom = await boot(seed({ done: H }));
    const d = await open(dom);
    const saved = () => stored(dom).projects[0];
    [...d.querySelectorAll(".sec-head")].find((h) => /^Settings/.test(h.textContent)).querySelector("button").click();
    await settle();
    setValue(dom.window, field(d, "Minimum time per task"), "8");
    await settle();
    btn(d, /Save changes/).click();
    await settle();
    expect(saved().taskMinMs).toBe(8 * H);

    // One task, told it has none.
    btn(d, /^edit$/).click();
    await settle();
    setValue(dom.window, field(d.querySelector(".prompt"), "Minimum time"), "nope");
    await settle();
    btn(d, /^Save$/).click();
    await settle();
    expect("minMs" in saved().tasks[0]).toBe(false);
    setValue(dom.window, field(d.querySelector(".prompt"), "Minimum time"), "0");
    await settle();
    btn(d, /^Save$/).click();
    await settle();
    expect(saved().tasks[0].minMs).toBe(0);

    // A new one, with its own.
    btn(d, /Start the meter/).click();
    await settle();
    btn(d, /^New task$/).click();
    await settle();
    setValue(dom.window, d.querySelector(".prompt input"), "Fresh");
    setValue(dom.window, field(d.querySelector(".prompt"), "Minimum time"), "1,5");
    await settle();
    [...d.querySelectorAll(".prompt button")].find((b) => /Start the meter/.test(b.textContent)).click();
    await until(() => d.querySelector(".runbar"), { what: "the meter" });
    expect(saved().tasks[1].minMs).toBe(1.5 * H);
    expect(d.querySelector(".runbar").textContent).toMatch(/01:(30:00|29:5\d).*to go of 1.5h/);

    // And taken off the project again.
    setValue(dom.window, field(d, "Minimum time per task"), "");
    await settle();
    btn(d, /Save changes/).click();
    await settle();
    expect(saved().taskMinMs).toBeNull();
  }, 40_000);
});
