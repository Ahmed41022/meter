import { describe, it, expect } from "vitest";
import {
  correctSession, revertCorrection, wasCorrected, startSession, stopSession,
  pauseSession, resumeSession, deleteSession, KIND,
} from "../src/domain/sessions.js";
import { elapsedMs, isOpen } from "../src/domain/time.js";
import { earningsCents } from "../src/domain/money.js";

const T = 1_700_000_000_000;
const HOUR = 3_600_000;
const project = { id: "p1", currentRate: 450, currency: "EGP", tasks: [] };
const empty = { projects: [project], sessions: [] };

/** A session left running for 9 hours that should have been 2. */
const forgotten = () => {
  let s = startSession(empty, project, { now: T, id: "s1" });
  return stopSession(s, "s1", T + 9 * HOUR);
};

describe("correcting a session you forgot to stop", () => {
  it("trims it to the time actually worked", () => {
    let s = forgotten();
    expect(elapsedMs(s.sessions[0], T + 9 * HOUR)).toBe(9 * HOUR);

    s = correctSession(s, "s1", { startedAt: T, endedAt: T + 2 * HOUR }, T + 9 * HOUR);
    expect(elapsedMs(s.sessions[0], T + 9 * HOUR)).toBe(2 * HOUR);
    expect(earningsCents(s.sessions[0].rate, elapsedMs(s.sessions[0], T + 9 * HOUR))).toBe(90_000);
  });

  it("moves closedAt to the corrected end", () => {
    const s = correctSession(forgotten(), "s1", { startedAt: T, endedAt: T + 2 * HOUR }, T);
    expect(s.sessions[0].closedAt).toBe(T + 2 * HOUR);
  });

  it("keeps what the meter actually recorded", () => {
    const before = forgotten().sessions[0];
    const s = correctSession(forgotten(), "s1", { startedAt: T, endedAt: T + 2 * HOUR }, T + 9 * HOUR);
    expect(wasCorrected(s.sessions[0])).toBe(true);
    expect(s.sessions[0].original.segments).toEqual(before.segments);
    expect(s.sessions[0].original.closedAt).toBe(T + 9 * HOUR);
    expect(s.sessions[0].original.correctedAt).toBe(T + 9 * HOUR);
  });

  it("still holds the measurement after a second correction, not the first guess", () => {
    let s = correctSession(forgotten(), "s1", { startedAt: T, endedAt: T + 3 * HOUR }, T);
    s = correctSession(s, "s1", { startedAt: T, endedAt: T + 2 * HOUR }, T);
    expect(elapsedMs(s.sessions[0], T + 9 * HOUR)).toBe(2 * HOUR);
    expect(s.sessions[0].original.closedAt).toBe(T + 9 * HOUR); // the recorded one
  });

  it("can move the start as well, for a meter started too early", () => {
    const s = correctSession(forgotten(), "s1",
      { startedAt: T + HOUR, endedAt: T + 3 * HOUR }, T);
    expect(elapsedMs(s.sessions[0], T + 9 * HOUR)).toBe(2 * HOUR);
    expect(s.sessions[0].segments[0].startedAt).toBe(T + HOUR);
  });

  it("can extend a session that was stopped too early", () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = stopSession(s, "s1", T + HOUR);
    s = correctSession(s, "s1", { startedAt: T, endedAt: T + 3 * HOUR }, T);
    expect(elapsedMs(s.sessions[0], T + 4 * HOUR)).toBe(3 * HOUR);
  });

  it("tolerates the two times being given the wrong way round", () => {
    const s = correctSession(forgotten(), "s1", { startedAt: T + 2 * HOUR, endedAt: T }, T);
    expect(elapsedMs(s.sessions[0], T + 9 * HOUR)).toBe(2 * HOUR);
  });
});

describe("corrections and pauses", () => {
  /** 30m worked, 4h break, then left running for hours. */
  const paused = () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = pauseSession(s, "s1", T + 1800_000);
    s = resumeSession(s, "s1", T + 5 * HOUR);
    return stopSession(s, "s1", T + 12 * HOUR);
  };

  it("never bills the break when the end is corrected", () => {
    // Collapsing start→end here would charge 5.5h instead of 45m.
    let s = paused();
    s = correctSession(s, "s1", { startedAt: T, endedAt: T + 5 * HOUR + 900_000 }, T);
    expect(elapsedMs(s.sessions[0], T + 12 * HOUR)).toBe(2700_000); // 45m
    expect(s.sessions[0].segments).toHaveLength(2);
  });

  it("drops segments that fall outside the corrected window", () => {
    let s = paused();
    s = correctSession(s, "s1", { startedAt: T, endedAt: T + 1800_000 }, T);
    expect(s.sessions[0].segments).toHaveLength(1);
    expect(elapsedMs(s.sessions[0], T + 12 * HOUR)).toBe(1800_000);
  });
});

describe("what cannot be corrected", () => {
  it("refuses a session that is still running", () => {
    // Stop it first — editing a live segment while it accrues is a race
    // with no upside.
    const s = startSession(empty, project, { now: T, id: "s1" });
    const after = correctSession(s, "s1", { startedAt: T, endedAt: T + HOUR }, T);
    expect(isOpen(after.sessions[0])).toBe(true);
    expect(after.sessions[0].original).toBeUndefined();
  });

  it("refuses a paused session", () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = pauseSession(s, "s1", T + HOUR);
    expect(correctSession(s, "s1", { startedAt: T, endedAt: T + HOUR }, T).sessions[0].original)
      .toBeUndefined();
  });

  it("refuses a deleted session", () => {
    let s = deleteSession(forgotten(), "s1", T);
    s = correctSession(s, "s1", { startedAt: T, endedAt: T + HOUR }, T);
    expect(s.sessions[0].original).toBeUndefined();
  });

  it("is a no-op on an unknown id", () => {
    const s = forgotten();
    expect(correctSession(s, "nope", { startedAt: T, endedAt: T }, T)).toEqual(s);
  });

  it("leaves the rate, task and kind alone", () => {
    let s = startSession(empty, project, { now: T, id: "i1", kind: KIND.IDLE, taskId: "t1" });
    s = stopSession(s, "i1", T + 9 * HOUR);
    const after = correctSession(s, "i1", { startedAt: T, endedAt: T + HOUR }, T).sessions[0];
    expect(after.rate).toBe(450);
    expect(after.taskId).toBe("t1");
    expect(after.kind).toBe("idle");
  });
});

describe("reverting", () => {
  it("puts back exactly what the meter recorded", () => {
    const before = forgotten().sessions[0];
    let s = correctSession(forgotten(), "s1", { startedAt: T, endedAt: T + 2 * HOUR }, T);
    s = revertCorrection(s, "s1");
    expect(s.sessions[0].segments).toEqual(before.segments);
    expect(s.sessions[0].closedAt).toBe(before.closedAt);
    expect(wasCorrected(s.sessions[0])).toBe(false);
    expect("original" in s.sessions[0]).toBe(false);
  });

  it("is a no-op on a session that was never corrected", () => {
    const s = forgotten();
    expect(revertCorrection(s, "s1")).toEqual(s);
  });
});
