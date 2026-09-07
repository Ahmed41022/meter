/**
 * The desktop quit-guard reads persisted state directly rather than going
 * through the domain layer, because the Electron main process can't import
 * the app's ES modules. That duplication is exactly why it needs testing:
 * nothing else would notice if it drifted from the real rule.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const { hasRunningSession, STORE_KEY } = createRequire(import.meta.url)("../desktop/running.js");

const session = (over = {}) => ({
  id: "s1", projectId: "p1", deletedAt: null,
  segments: [{ startedAt: 1, endedAt: 2 }],
  ...over,
});

describe("detecting a running meter before quitting", () => {
  it("spots a segment still accruing", () => {
    const state = { sessions: [session({ segments: [{ startedAt: 1, endedAt: null }] })] };
    expect(hasRunningSession(JSON.stringify(state))).toBe(true);
  });

  it("accepts an object as well as a JSON string", () => {
    expect(hasRunningSession({ sessions: [session({ segments: [{ startedAt: 1, endedAt: null }] })] }))
      .toBe(true);
  });

  it("does not count a session that was only paused", () => {
    // Paused means every segment is closed, even though the session is open.
    const state = { sessions: [session({ closedAt: null })] };
    expect(hasRunningSession(JSON.stringify(state))).toBe(false);
  });

  it("does not count a stopped session", () => {
    expect(hasRunningSession(JSON.stringify({ sessions: [session({ closedAt: 2 })] }))).toBe(false);
  });

  it("ignores a deleted session that was left running", () => {
    const state = {
      sessions: [session({ deletedAt: 5, segments: [{ startedAt: 1, endedAt: null }] })],
    };
    expect(hasRunningSession(JSON.stringify(state))).toBe(false);
  });

  it("finds a running session among stopped ones", () => {
    const state = {
      sessions: [
        session({ closedAt: 2 }),
        session({ id: "s2", segments: [{ startedAt: 3, endedAt: null }] }),
      ],
    };
    expect(hasRunningSession(JSON.stringify(state))).toBe(true);
  });
});

describe("never trapping the user in the app", () => {
  it("says no on corrupt, empty or missing storage", () => {
    // Any doubt resolves to "not running" so the window always closes.
    for (const bad of ["{not json", "", null, undefined, "null", "[]", "{}"]) {
      expect(hasRunningSession(bad)).toBe(false);
    }
  });

  it("says no when sessions is the wrong shape", () => {
    expect(hasRunningSession(JSON.stringify({ sessions: "nope" }))).toBe(false);
    expect(hasRunningSession(JSON.stringify({ sessions: [{ id: "s1" }] }))).toBe(false);
  });

  it("uses the same storage key the app writes to", () => {
    expect(STORE_KEY).toBe("meter:v1");
  });
});
