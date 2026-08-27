import { describe, it, expect } from "vitest";
import {
  segmentMs, elapsedMs, isRunning, isOpen, lastActivityAt, isStale, startedAt,
} from "../src/domain/time.js";

const T = 1_700_000_000_000; // fixed epoch — no ambient clock in tests
const HOUR = 3_600_000;

describe("elapsed time", () => {
  it("measures a closed segment from its own timestamps", () => {
    expect(segmentMs({ startedAt: T, endedAt: T + HOUR }, T)).toBe(HOUR);
  });

  it("measures an open segment against now, not a counter", () => {
    expect(segmentMs({ startedAt: T, endedAt: null }, T + 600_000)).toBe(600_000);
  });

  it("sums segments across a pause without billing the gap", () => {
    const session = {
      segments: [
        { startedAt: T, endedAt: T + 1800_000 },              // 30 min
        { startedAt: T + 5 * HOUR, endedAt: T + 5 * HOUR + 900_000 }, // 15 min
      ],
    };
    expect(elapsedMs(session, T + 6 * HOUR)).toBe(2700_000); // 45 min, not 5h45
  });

  it("survives a backwards clock jump instead of subtracting time", () => {
    const session = { segments: [{ startedAt: T, endedAt: null }] };
    expect(elapsedMs(session, T - 500_000)).toBe(0);
  });

  it("is unaffected by how long the tab was backgrounded", () => {
    // The whole point of deriving from timestamps: no ticker ran for 8 hours,
    // and the answer is still exactly 8 hours.
    const session = { segments: [{ startedAt: T, endedAt: null }] };
    expect(elapsedMs(session, T + 8 * HOUR)).toBe(8 * HOUR);
  });
});

describe("session state", () => {
  const running = { segments: [{ startedAt: T, endedAt: null }], closedAt: null };
  const paused  = { segments: [{ startedAt: T, endedAt: T + 60_000 }], closedAt: null };
  const stopped = { segments: [{ startedAt: T, endedAt: T + 60_000 }], closedAt: T + 60_000 };

  it("distinguishes paused from stopped", () => {
    expect(isRunning(paused)).toBe(false);
    expect(isOpen(paused)).toBe(true);   // paused is still the current session
    expect(isOpen(stopped)).toBe(false);
  });

  it("treats a running session as both running and open", () => {
    expect(isRunning(running)).toBe(true);
    expect(isOpen(running)).toBe(true);
  });

  it("falls back to createdAt when a session has no segments", () => {
    expect(startedAt({ segments: [], createdAt: T })).toBe(T);
  });
});

describe("crash detection", () => {
  it("reports the last heartbeat, not the start, for a running session", () => {
    const session = { segments: [{ startedAt: T, endedAt: null, lastTick: T + HOUR }] };
    expect(lastActivityAt(session)).toBe(T + HOUR);
  });

  it("flags a session that stopped checking in", () => {
    const session = { segments: [{ startedAt: T, endedAt: null, lastTick: T }] };
    expect(isStale(session, T + 10 * 60_000, 150_000)).toBe(true);
  });

  it("does not flag a session that is checking in normally", () => {
    const session = { segments: [{ startedAt: T, endedAt: null, lastTick: T + 60_000 }] };
    expect(isStale(session, T + 90_000, 150_000)).toBe(false);
  });

  it("never flags a stopped session however old it is", () => {
    const session = { segments: [{ startedAt: T, endedAt: T + HOUR }], closedAt: T + HOUR };
    expect(isStale(session, T + 400 * HOUR, 150_000)).toBe(false);
  });
});

describe("edge cases with missing data", () => {
  it("falls back to createdAt when a session has no closed segments", () => {
    expect(lastActivityAt({ segments: [], createdAt: T })).toBe(T);
  });

  it("uses the segment start when a running segment has no heartbeat yet", () => {
    expect(lastActivityAt({ segments: [{ startedAt: T, endedAt: null }], createdAt: 0 })).toBe(T);
  });

  it("picks the latest end across several closed segments", () => {
    const session = {
      segments: [
        { startedAt: T, endedAt: T + 1000 },
        { startedAt: T + 5000, endedAt: T + 9000 },
      ],
      createdAt: T,
    };
    expect(lastActivityAt(session)).toBe(T + 9000);
  });

  it("treats a session with no segments array as zero elapsed", () => {
    expect(elapsedMs({ createdAt: T }, T + HOUR)).toBe(0);
  });
});
