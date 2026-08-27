import { describe, it, expect } from "vitest";
import { periodStart, goalProgress, isGoalMet, normaliseGoal, inPeriod } from "../src/domain/goals.js";

describe("period boundaries", () => {
  it("starts weeks on Monday at local midnight", () => {
    const wed = new Date(2024, 4, 15, 14, 30).getTime(); // Wed 15 May 2024
    const start = new Date(periodStart("week", wed));
    expect(start.getDay()).toBe(1);
    expect(start.getDate()).toBe(13);
    expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0]);
  });

  it("treats Sunday as the end of the week, not the start", () => {
    const sun = new Date(2024, 4, 19, 10, 0).getTime();
    expect(new Date(periodStart("week", sun)).getDate()).toBe(13);
  });

  it("does not move the boundary when the week is already Monday", () => {
    const mon = new Date(2024, 4, 13, 9, 0).getTime();
    expect(new Date(periodStart("week", mon)).getDate()).toBe(13);
  });

  it("starts months on the 1st at local midnight", () => {
    const start = new Date(periodStart("month", new Date(2024, 4, 15, 14, 30).getTime()));
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(4);
    expect(start.getHours()).toBe(0);
  });

  it("returns the epoch for a lifetime goal so nothing is filtered out", () => {
    expect(periodStart("lifetime", Date.now())).toBe(0);
  });

  it("lands on local midnight even across a DST transition", () => {
    // Egypt reintroduced DST in 2023. A boundary computed from wall-clock
    // strings would be an hour out; deriving it from a Date is not.
    for (const d of [new Date(2024, 3, 29), new Date(2024, 9, 28)]) {
      const start = new Date(periodStart("week", d.getTime()));
      expect(start.getHours()).toBe(0);
      expect(start.getDay()).toBe(1);
    }
  });
});

describe("progress", () => {
  it("clamps at 100% rather than overflowing the bar", () => {
    expect(goalProgress(150, 100)).toBe(1);
  });

  it("clamps negatives at zero", () => {
    expect(goalProgress(-5, 100)).toBe(0);
  });

  it("treats a zero or missing target as no goal", () => {
    expect(goalProgress(50, 0)).toBe(0);
    expect(goalProgress(50, null)).toBe(0);
    expect(isGoalMet(50, 0)).toBe(false);
  });

  it("marks a goal met on exact equality", () => {
    expect(isGoalMet(100, 100)).toBe(true);
  });
});

describe("goal validation", () => {
  it("rejects empty and non-numeric targets", () => {
    expect(normaliseGoal({ type: "money", target: "" })).toBeNull();
    expect(normaliseGoal({ type: "money", target: "abc" })).toBeNull();
    expect(normaliseGoal({ type: "money", target: -5 })).toBeNull();
    expect(normaliseGoal(null)).toBeNull();
  });

  it("coerces a numeric string from the input field", () => {
    expect(normaliseGoal({ type: "money", target: "500" })).toEqual({ type: "money", target: 500 });
  });
});

describe("period membership", () => {
  const startedAtOf = (s) => s.startedAt;

  it("includes a session started inside the period", () => {
    const now = new Date(2024, 4, 15, 12).getTime();
    const session = { startedAt: new Date(2024, 4, 14, 9).getTime() };
    expect(inPeriod(session, "week", now, startedAtOf)).toBe(true);
  });

  it("excludes a session from the previous period", () => {
    const now = new Date(2024, 4, 15, 12).getTime();
    const session = { startedAt: new Date(2024, 4, 10, 9).getTime() }; // previous week
    expect(inPeriod(session, "week", now, startedAtOf)).toBe(false);
  });

  it("includes everything for a lifetime goal", () => {
    expect(inPeriod({ startedAt: 1 }, "lifetime", Date.now(), startedAtOf)).toBe(true);
  });
});
