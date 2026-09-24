import { describe, it, expect } from "vitest";
import {
  actualMs, addObjective, allObjectives, dayKey, doneToday, editObjective,
  estimateFromHours, estimateRatio, focusObjective, isToday, liveObjectives,
  objectivesFor, orderObjectives, progress, removeObjective, restoreObjective,
  toggleObjective, todaysObjectives, unlinkTask,
} from "../src/domain/objectives.js";

const T = 1_700_000_000_000;
const HOUR = 3_600_000;
const base = { projects: [{ id: "p1" }], sessions: [] };

const withOne = (extra = {}) =>
  addObjective(base, "p1", { text: "Ship the report", ...extra }, T, "o1");

describe("adding", () => {
  it("records the text, unfinished and unpicked", () => {
    const o = allObjectives(withOne())[0];
    expect(o).toMatchObject({
      id: "o1", projectId: "p1", text: "Ship the report",
      done: false, doneAt: null, focusedOn: null, estimateMs: null, taskId: null,
    });
  });

  it("trims the text and refuses an empty one", () => {
    expect(allObjectives(addObjective(base, "p1", { text: "  Tidy up  " }, T, "o1"))[0].text)
      .toBe("Tidy up");
    expect(allObjectives(addObjective(base, "p1", { text: "   " }, T, "o1"))).toHaveLength(0);
  });

  it("reads a store written before objectives existed as having none", () => {
    // Absent means none, so no schema bump and nothing to migrate.
    expect(allObjectives({ projects: [], sessions: [] })).toEqual([]);
    expect(objectivesFor({ projects: [], sessions: [] }, "p1")).toEqual([]);
  });

  it("keeps each project's objectives to itself", () => {
    let s = withOne();
    s = addObjective(s, "p2", { text: "Sleep earlier" }, T, "o2");
    expect(objectivesFor(s, "p1").map((o) => o.id)).toEqual(["o1"]);
    expect(objectivesFor(s, "p2").map((o) => o.id)).toEqual(["o2"]);
  });
});

describe("estimates", () => {
  it("stores hours as milliseconds, the unit everything else uses", () => {
    expect(estimateFromHours(2)).toBe(2 * HOUR);
    expect(estimateFromHours("1.5")).toBe(1.5 * HOUR);
  });

  it("reads anything that is not a positive number as no estimate", () => {
    for (const bad of ["", null, undefined, 0, -3, "abc", NaN]) {
      expect(estimateFromHours(bad)).toBeNull();
    }
  });

  it("compares spent against estimated as a ratio", () => {
    expect(estimateRatio(2 * HOUR, 3 * HOUR)).toBe(1.5);
    expect(estimateRatio(2 * HOUR, 2 * HOUR)).toBe(1);
  });

  it("judges nothing when either side is missing", () => {
    // An estimate you never made cannot be over or under run.
    expect(estimateRatio(null, 3 * HOUR)).toBeNull();
    expect(estimateRatio(0, 3 * HOUR)).toBeNull();
    expect(estimateRatio(2 * HOUR, null)).toBeNull();
  });
});

describe("finishing", () => {
  it("records when it was ticked, not just that it was", () => {
    const s = toggleObjective(withOne(), "o1", T + HOUR);
    expect(allObjectives(s)[0]).toMatchObject({ done: true, doneAt: T + HOUR });
  });

  it("clears the timestamp when unticked, so it cannot claim a day it missed", () => {
    let s = toggleObjective(withOne(), "o1", T + HOUR);
    s = toggleObjective(s, "o1", T + 2 * HOUR);
    expect(allObjectives(s)[0]).toMatchObject({ done: false, doneAt: null });
  });

  it("counts what was finished on a given day", () => {
    let s = withOne();
    s = addObjective(s, "p1", { text: "Second" }, T, "o2");
    s = toggleObjective(s, "o1", T);
    expect(doneToday(s, dayKey(T)).map((o) => o.id)).toEqual(["o1"]);
    expect(doneToday(s, dayKey(T + 48 * HOUR))).toEqual([]);
  });
});

describe("today's focus", () => {
  const today = dayKey(T);

  it("is a calendar day, so it expires on its own", () => {
    // A boolean would still be set tomorrow and would need a nightly job to
    // clear it. Deriving it from the stored day cannot rot while the app is shut.
    const s = focusObjective(withOne(), "o1", today);
    expect(isToday(allObjectives(s)[0], today)).toBe(true);
    expect(isToday(allObjectives(s)[0], dayKey(T + 24 * HOUR))).toBe(false);
    expect(todaysObjectives(s, dayKey(T + 24 * HOUR))).toEqual([]);
  });

  it("gathers today's picks across every project at once", () => {
    let s = focusObjective(withOne(), "o1", today);
    s = addObjective(s, "p2", { text: "Walk" }, T, "o2");
    s = focusObjective(s, "o2", today);
    s = addObjective(s, "p1", { text: "Not today" }, T, "o3");
    expect(todaysObjectives(s, today).map((o) => o.id)).toEqual(["o1", "o2"]);
  });

  it("drops an item from today once it is finished", () => {
    // What is left is the point; a ticked row has already been counted.
    let s = focusObjective(withOne(), "o1", today);
    s = toggleObjective(s, "o1", T);
    expect(todaysObjectives(s, today)).toEqual([]);
  });

  it("can be unpicked", () => {
    let s = focusObjective(withOne(), "o1", today);
    s = focusObjective(s, "o1", null);
    expect(todaysObjectives(s, today)).toEqual([]);
  });

  it("uses local days, so late-evening work lands on the day you lived", () => {
    const late = new Date(2026, 8, 24, 23, 30).getTime();
    const justAfter = new Date(2026, 8, 25, 0, 30).getTime();
    expect(dayKey(late)).toBe("2026-09-24");
    expect(dayKey(justAfter)).toBe("2026-09-25");
  });
});

describe("editing and removing", () => {
  it("changes the text, estimate and link", () => {
    const s = editObjective(withOne(), "o1",
      { text: "Ship it", estimateMs: 3 * HOUR, taskId: "t1" });
    expect(allObjectives(s)[0]).toMatchObject(
      { text: "Ship it", estimateMs: 3 * HOUR, taskId: "t1" });
  });

  it("ignores a blank rename rather than wiping the row", () => {
    const s = editObjective(withOne(), "o1", { text: "   " });
    expect(allObjectives(s)[0].text).toBe("Ship the report");
  });

  it("soft deletes so it can be undone", () => {
    const s = removeObjective(withOne(), "o1", T);
    expect(liveObjectives(s)).toEqual([]);
    expect(allObjectives(s)).toHaveLength(1);
    expect(liveObjectives(restoreObjective(s, "o1"))).toHaveLength(1);
  });

  it("unfiles an objective when its task is deleted rather than losing it", () => {
    // The intent outlives the bucket, exactly as a session's hours do.
    const s = unlinkTask(editObjective(withOne(), "o1", { taskId: "t1" }), "t1");
    expect(allObjectives(s)[0].taskId).toBeNull();
    expect(allObjectives(s)[0].text).toBe("Ship the report");
  });
});

describe("time actually spent", () => {
  const sessions = [
    { id: "s1", taskId: "t1", segments: [{ startedAt: T, endedAt: T + 2 * HOUR }] },
    { id: "s2", taskId: "t1", segments: [{ startedAt: T, endedAt: T + HOUR }] },
    { id: "s3", taskId: "t2", segments: [{ startedAt: T, endedAt: T + 5 * HOUR }] },
    { id: "s4", taskId: "t1", deletedAt: T, segments: [{ startedAt: T, endedAt: T + 9 * HOUR }] },
  ];

  it("sums the linked task's sessions and ignores deleted ones", () => {
    const linked = allObjectives(editObjective(withOne(), "o1", { taskId: "t1" }))[0];
    expect(actualMs(linked, sessions, T)).toBe(3 * HOUR);
  });

  it("reports nothing measured when no task is linked", () => {
    // Different from zero: an unlinked objective was never being measured.
    expect(actualMs(allObjectives(withOne())[0], sessions, T)).toBeNull();
  });

  it("reports zero for a linked task that has no time yet", () => {
    const linked = allObjectives(editObjective(withOne(), "o1", { taskId: "t9" }))[0];
    expect(actualMs(linked, sessions, T)).toBe(0);
  });
});

describe("ordering and counting", () => {
  it("puts what is left above what is finished, each oldest first", () => {
    const rows = orderObjectives([
      { id: "a", done: true, createdAt: 1 },
      { id: "b", done: false, createdAt: 3 },
      { id: "c", done: false, createdAt: 2 },
      { id: "d", done: true, createdAt: 0 },
    ]);
    expect(rows.map((o) => o.id)).toEqual(["c", "b", "d", "a"]);
  });

  it("counts done against total", () => {
    expect(progress([{ done: true }, { done: false }, { done: true }]))
      .toEqual({ done: 2, total: 3 });
    expect(progress([])).toEqual({ done: 0, total: 0 });
  });
});
