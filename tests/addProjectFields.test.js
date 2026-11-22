/**
 * What the create card can tell `addProject`, beyond name, rate and currency.
 * Each field is written only when it says something, so a project made with
 * the short form is the record it always was.
 */
import { describe, it, expect } from "vitest";
import { addProject } from "../src/domain/projects.js";
import { currentLimit } from "../src/domain/terms.js";
import { bonusPerHour, perTask, rewardModel, REWARD } from "../src/domain/earnings.js";

const NOW = Date.UTC(2026, 10, 22, 12);
const base = { name: "Acme", rate: 40, currency: "USD" };
const made = (fields) => addProject({ projects: [] }, { ...base, ...fields }, NOW, "p1").projects[0];

describe("addProject with the create card's settings", () => {
  it("writes the short form exactly as before", () => {
    expect(made({})).toEqual({
      id: "p1", name: "Acme", currentRate: 40, currency: "USD", createdAt: NOW,
      sessionGoal: null, overallGoal: null,
    });
  });

  it("keeps the company, trimmed, and leaves an empty one out", () => {
    expect(made({ company: "  Alignerr " }).company).toBe("Alignerr");
    expect(made({ company: "   " })).not.toHaveProperty("company");
  });

  it("starts the project's terms with the time limit, in force for all of its work", () => {
    const p = made({ taskLimit: { ms: 2 * 3_600_000, factor: 0.3 } });
    expect(p.taskLimits).toEqual([{ from: null, ms: 7_200_000, factor: 0.3 }]);
    expect(currentLimit(p)).toMatchObject({ ms: 7_200_000, factor: 0.3 });
    expect(made({ taskLimit: { ms: 0, factor: 0 } })).not.toHaveProperty("taskLimits");
  });

  it("keeps one acceptance reward or the other", () => {
    const hour = made({ bonusPerHour: 10 });
    expect(bonusPerHour(hour)).toBe(10);
    expect(rewardModel(hour)).toBe(REWARD.PER_HOUR);
    const flat = made({ perTask: 25 });
    expect(perTask(flat)).toBe(25);
    expect(rewardModel(flat)).toBe(REWARD.PER_TASK);
    expect(flat.paysOnAcceptance).toBeUndefined();
  });

  it("keeps the goals it is given", () => {
    const p = made({
      sessionGoal: { type: "time", target: 90 },
      overallGoal: { type: "money", target: 500, period: "week" },
    });
    expect(p.sessionGoal).toEqual({ type: "time", target: 90 });
    expect(p.overallGoal).toEqual({ type: "money", target: 500, period: "week" });
  });

  it("gives off-the-clock time no company, reward or limit", () => {
    const p = made({
      offClock: true, rate: 0, company: "Acme", bonusPerHour: 5, taskLimit: { ms: 3_600_000, factor: 0 },
    });
    expect(p.offClock).toBe(true);
    expect(p).not.toHaveProperty("company");
    expect(p).not.toHaveProperty("bonusPerHour");
    expect(p).not.toHaveProperty("taskLimits");
  });
});
