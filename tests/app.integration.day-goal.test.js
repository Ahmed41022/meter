/**
 * The goal for a day of work as a whole, on Today. Drives the built artifact.
 */
import { describe, it, expect } from "vitest";
import { boot, btn, guardBuiltApp, setValue, settle } from "./app.integration.helpers.js";

guardBuiltApp();

/** Two work projects and a life one, the first minute of today each, so the
 *  work falls on today whatever the hour the suite runs at. */
const seed = () => {
  const M = 60_000;
  const day = new Date().setHours(0, 0, 0, 0);
  const p = (id, name, rate, extra = {}) => ({
    id, name, currentRate: rate, currency: "USD", createdAt: 1, sessionGoal: null, overallGoal: null, ...extra,
  });
  const s = (id, projectId, rate, extra = {}) => ({
    id, projectId, taskId: null, kind: "billed", rate, currency: "USD", createdAt: day,
    segments: [{ startedAt: day, endedAt: day + M }], closedAt: day + M, deletedAt: null, ...extra,
  });
  return {
    projects: [p("a", "Alpha", 60), p("b", "Beta", 120), p("l", "Garden", 0, { offClock: true })],
    sessions: [s("1", "a", 60), s("2", "b", 120, { status: "pending" }), s("3", "a", 60, { kind: "idle" }), s("4", "l", 0)],
  };
};
const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1")).prefs?.find((r) => r.id === "dayGoal")?.value;
const box = (d) => d.querySelector(".daygoal");
const pick = async (d, re) => { [...box(d).querySelectorAll("button")].find((b) => re.test(b.textContent)).click(); await settle(); };

describe("the daily goal", () => {
  it("is set in time, counts every work project, and says what is left", async () => {
    const dom = await boot(seed());
    const d = dom.window.document;
    btn(d, /Set a daily goal/).click();
    await settle();
    const save = () => [...box(d).querySelectorAll("button")].find((b) => /Save goal/.test(b.textContent));
    expect(save().disabled).toBe(true);
    setValue(dom.window, box(d).querySelector("input"), "0,1");
    await settle();
    save().click();
    await settle();
    expect(stored(dom)).toEqual({ type: "time", target: 6 });
    // Two minutes of work. Idle and the life activity count for nothing.
    expect(box(d).textContent).toMatch(/2m \/ 6m/);
    expect(box(d).textContent).toMatch(/4m to go/);
  }, 30_000);

  it("is set in money, counts pending money, says when it is met, and can be taken off", async () => {
    const dom = await boot(seed());
    const d = dom.window.document;
    btn(d, /Set a daily goal/).click();
    await settle();
    await pick(d, /Money earned/);
    setValue(dom.window, box(d).querySelector("input"), "5");
    await settle();
    await pick(d, /Save goal/);
    expect(stored(dom)).toEqual({ type: "money", target: 5, currency: "USD" });
    expect(box(d).textContent).toMatch(/\$3\.00 \/ \$5\.00/);
    expect(box(d).textContent).toMatch(/\$2\.00 to go/);

    [...d.querySelectorAll("button")].find((b) => b.textContent === "Change").click();
    await settle();
    expect(box(d).querySelector("input").value).toBe("5");
    setValue(dom.window, box(d).querySelector("input"), "2");
    await settle();
    await pick(d, /Save goal/);
    expect(box(d).textContent).toMatch(/Met · \$1\.00 over/);

    [...d.querySelectorAll("button")].find((b) => b.textContent === "Change").click();
    await settle();
    await pick(d, /Remove goal/);
    expect(stored(dom)).toBeNull();
    expect(btn(d, /Set a daily goal/)).toBeTruthy();
  }, 30_000);
});
