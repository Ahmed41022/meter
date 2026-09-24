import { describe, it, expect } from "vitest";
import {
  startSession, pauseSession, resumeSession, stopSession, recoverSession,
  deleteSession, restoreSession, heartbeat, currentSession, sessionsFor, liveSessions,
  allSessionsFor, idleSessionsFor, isBilled, isIdle, kindOf, utilisation, KIND,
  addManualSession, wasManual, overlappingSessions,
} from "../src/domain/sessions.js";
import { elapsedMs, isRunning, isOpen } from "../src/domain/time.js";
import { earningsCents } from "../src/domain/money.js";

const T = 1_700_000_000_000;
const HOUR = 3_600_000;
const project = { id: "p1", currentRate: 450, currency: "EGP" };
const empty = { projects: [project], sessions: [] };

describe("starting", () => {
  it("snapshots the project rate onto the session", () => {
    const s = startSession(empty, project, { now: T, id: "s1" });
    expect(s.sessions[0].rate).toBe(450);
  });

  it("closes anything still open on the project", () => {
    // Two open sessions on one project means the UI picks one and silently
    // under-bills the other. This is the guard against that.
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = startSession(s, project, { now: T + HOUR, id: "s2" });
    const open = sessionsFor(s, "p1").filter(isOpen);
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe("s2");
    expect(s.sessions.find((x) => x.id === "s1").closedAt).toBe(T + HOUR);
  });

  it("closes an open session on a DIFFERENT project too", () => {
    // One person cannot bill two projects at the same time. Two live meters
    // would double-count the same wall-clock hour.
    const other = { id: "p2", currentRate: 900, currency: "EGP" };
    let s = startSession({ projects: [project, other], sessions: [] }, project, { now: T, id: "s1" });
    s = startSession(s, other, { now: T + HOUR, id: "s2" });
    expect(s.sessions.find((x) => x.id === "s1").closedAt).toBe(T + HOUR);
    expect(s.sessions.filter(isOpen)).toHaveLength(1);
  });
});

describe("rate changes", () => {
  it("leaves a recorded session untouched when the project rate moves", () => {
    // The requirement: a new rate applies to new sessions only.
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = stopSession(s, "s1", T + HOUR);
    s = { ...s, projects: [{ ...project, currentRate: 900 }] };
    const session = s.sessions[0];
    expect(session.rate).toBe(450);
    expect(earningsCents(session.rate, elapsedMs(session, T + HOUR))).toBe(45_000);
  });

  it("leaves a RUNNING session untouched when the project rate moves", () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = { ...s, projects: [{ ...project, currentRate: 900 }] };
    expect(s.sessions[0].rate).toBe(450);
  });

  it("applies the new rate to the next session started", () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    const raised = { ...project, currentRate: 900 };
    s = startSession({ ...s, projects: [raised] }, raised, { now: T + HOUR, id: "s2" });
    expect(s.sessions.find((x) => x.id === "s2").rate).toBe(900);
  });
});

describe("pause and resume", () => {
  it("appends a segment instead of reopening the old one", () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = pauseSession(s, "s1", T + 1800_000);
    s = resumeSession(s, "s1", T + 5 * HOUR);
    expect(s.sessions[0].segments).toHaveLength(2);
  });

  it("excludes the paused gap from billable time", () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = pauseSession(s, "s1", T + 1800_000);        // worked 30 min
    s = resumeSession(s, "s1", T + 5 * HOUR);       // 4.5h break
    s = stopSession(s, "s1", T + 5 * HOUR + 900_000); // worked 15 more
    expect(elapsedMs(s.sessions[0], T + 6 * HOUR)).toBe(2700_000);
  });

  it("keeps a paused session as the current one", () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = pauseSession(s, "s1", T + 60_000);
    const cur = currentSession(s, "p1");
    expect(cur.id).toBe("s1");
    expect(isRunning(cur)).toBe(false);
  });

  it("ignores resume on a session that is already running", () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = resumeSession(s, "s1", T + 60_000);
    expect(s.sessions[0].segments).toHaveLength(1);
  });

  it("ignores pause on a session that is not running", () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = pauseSession(s, "s1", T + 60_000);
    const before = JSON.stringify(s);
    expect(JSON.stringify(pauseSession(s, "s1", T + 120_000))).toBe(before);
  });
});

describe("stopping", () => {
  it("closes the segment and the session together", () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = stopSession(s, "s1", T + HOUR);
    expect(s.sessions[0].closedAt).toBe(T + HOUR);
    expect(isRunning(s.sessions[0])).toBe(false);
    expect(currentSession(s, "p1")).toBeNull();
  });

  it("never ends a segment before it began", () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = stopSession(s, "s1", T - HOUR); // clock jumped backwards
    expect(elapsedMs(s.sessions[0], T)).toBe(0);
  });
});

describe("crash recovery", () => {
  it("bills to the last heartbeat, not the whole gap", () => {
    // Laptop slept at 02:00 with the meter running; reopened 9 hours later.
    const s = {
      projects: [project],
      sessions: [{
        id: "s1", projectId: "p1", rate: 450, currency: "EGP", createdAt: T,
        segments: [{ startedAt: T, endedAt: null, lastTick: T + 2 * HOUR }],
        closedAt: null, deletedAt: null,
      }],
    };
    const recovered = recoverSession(s, "s1");
    const session = recovered.sessions[0];
    expect(elapsedMs(session, T + 11 * HOUR)).toBe(2 * HOUR);
    expect(earningsCents(session.rate, elapsedMs(session, T + 11 * HOUR))).toBe(90_000);
    expect(session.closedAt).toBe(T + 2 * HOUR);
  });

  it("is a no-op on an unknown id", () => {
    expect(recoverSession(empty, "nope")).toEqual(empty);
  });

  it("advances the heartbeat only on running sessions", () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = pauseSession(s, "s1", T + 60_000);
    const before = JSON.stringify(s);
    expect(JSON.stringify(heartbeat(s, T + 120_000))).toBe(before);
  });
});

describe("deletion", () => {
  it("soft-deletes so the record can come back", () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = deleteSession(s, "s1", T + HOUR);
    expect(liveSessions(s.sessions)).toHaveLength(0);
    expect(s.sessions).toHaveLength(1); // still on disk
    s = restoreSession(s, "s1");
    expect(liveSessions(s.sessions)).toHaveLength(1);
  });

  it("removes deleted sessions from project totals", () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = stopSession(s, "s1", T + HOUR);
    s = deleteSession(s, "s1", T + HOUR);
    expect(sessionsFor(s, "p1")).toHaveLength(0);
  });
});

describe("idle time", () => {
  const startIdle = (state, now, id) => startSession(state, project, { now, id, kind: KIND.IDLE });

  it("records idle sessions under their own kind", () => {
    const s = startIdle(empty, T, "i1");
    expect(kindOf(s.sessions[0])).toBe("idle");
    expect(isIdle(s.sessions[0])).toBe(true);
  });

  it("keeps idle time out of the default accessor", () => {
    // The safety property: a caller that forgets about kind gets billed
    // sessions only, and can never accidentally inflate earnings.
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = stopSession(s, "s1", T + HOUR);
    s = startIdle(s, T + HOUR, "i1");
    s = stopSession(s, "i1", T + 2 * HOUR);

    expect(sessionsFor(s, "p1").map((x) => x.id)).toEqual(["s1"]);
    expect(idleSessionsFor(s, "p1").map((x) => x.id)).toEqual(["i1"]);
    expect(allSessionsFor(s, "p1")).toHaveLength(2);
  });

  it("never lets idle time reach an earnings total", () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = stopSession(s, "s1", T + HOUR);
    s = startIdle(s, T + HOUR, "i1");
    s = stopSession(s, "i1", T + 4 * HOUR); // 3 idle hours

    const billed = sessionsFor(s, "p1")
      .reduce((a, x) => a + earningsCents(x.rate, elapsedMs(x, T + 4 * HOUR)), 0);
    expect(billed).toBe(45_000); // one hour, not four
  });

  it("stops a running billed session when idle starts, and vice versa", () => {
    let s = startSession(empty, project, { now: T, id: "s1" });
    s = startIdle(s, T + HOUR, "i1");
    expect(s.sessions.find((x) => x.id === "s1").closedAt).toBe(T + HOUR);
    expect(currentSession(s, "p1").id).toBe("i1");

    s = startSession(s, project, { now: T + 2 * HOUR, id: "s2" });
    expect(s.sessions.find((x) => x.id === "i1").closedAt).toBe(T + 2 * HOUR);
    expect(currentSession(s, "p1").id).toBe("s2");
    expect(s.sessions.filter(isOpen)).toHaveLength(1);
  });

  it("snapshots the rate onto idle sessions too", () => {
    // Idle time valued at last year's rate is not a fair comparison.
    const s = startIdle(empty, T, "i1");
    expect(s.sessions[0].rate).toBe(450);
  });

  it("supports pause and resume on idle exactly like billed", () => {
    let s = startIdle(empty, T, "i1");
    s = pauseSession(s, "i1", T + 1800_000);
    s = resumeSession(s, "i1", T + 5 * HOUR);
    s = stopSession(s, "i1", T + 5 * HOUR + 900_000);
    expect(elapsedMs(s.sessions[0], T + 6 * HOUR)).toBe(2700_000);
  });

  it("recovers a crashed idle session at its last heartbeat", () => {
    const s = {
      projects: [project],
      sessions: [{
        id: "i1", projectId: "p1", kind: "idle", rate: 450, currency: "EGP", createdAt: T,
        segments: [{ startedAt: T, endedAt: null, lastTick: T + 2 * HOUR }],
        closedAt: null, deletedAt: null,
      }],
    };
    const recovered = recoverSession(s, "i1");
    expect(elapsedMs(recovered.sessions[0], T + 11 * HOUR)).toBe(2 * HOUR);
  });

  it("soft-deletes idle sessions like any other", () => {
    let s = startIdle(empty, T, "i1");
    s = deleteSession(s, "i1", T + HOUR);
    expect(idleSessionsFor(s, "p1")).toHaveLength(0);
    s = restoreSession(s, "i1");
    expect(idleSessionsFor(s, "p1")).toHaveLength(1);
  });
});

describe("legacy data", () => {
  it("treats a session written before idle tracking as billed", () => {
    // No schema bump: a missing `kind` is unambiguous.
    const legacy = {
      id: "old", projectId: "p1", rate: 450, currency: "EGP", createdAt: T,
      segments: [{ startedAt: T, endedAt: T + HOUR }], closedAt: T + HOUR, deletedAt: null,
    };
    const s = { projects: [project], sessions: [legacy] };
    expect(kindOf(legacy)).toBe("billed");
    expect(isBilled(legacy)).toBe(true);
    expect(sessionsFor(s, "p1")).toHaveLength(1);
    expect(idleSessionsFor(s, "p1")).toHaveLength(0);
  });
});

describe("utilisation", () => {
  it("is the billable share of desk time", () => {
    expect(utilisation(6 * HOUR, 2 * HOUR)).toBeCloseTo(0.75, 6);
  });

  it("is 1 when no time was idled", () => {
    expect(utilisation(HOUR, 0)).toBe(1);
  });

  it("is 0 when nothing was billed but time was idled", () => {
    expect(utilisation(0, HOUR)).toBe(0);
  });

  it("is null with no data at all, which is not the same as 0%", () => {
    expect(utilisation(0, 0)).toBeNull();
  });
});

describe("sessions entered by hand", () => {
  const at = (h, m = 0) => T + h * HOUR + m * 60_000;
  const add = (s, window_, extra = {}) =>
    addManualSession(s, project, { ...window_, ...extra }, T, extra.id ?? "m1");

  it("records a closed block with the project's rate snapshotted", () => {
    const s = add(empty, { startedAt: at(9), endedAt: at(12) });
    const m = s.sessions[0];
    expect(m).toMatchObject({
      projectId: "p1", kind: KIND.BILLED, rate: 450, closedAt: at(12), manual: true,
    });
    expect(elapsedMs(m, at(20))).toBe(3 * HOUR);
    expect(isOpen(m)).toBe(false);
  });

  it("marks itself as typed in rather than measured", () => {
    // The app rests on being able to see what was actually recorded, and a
    // block you entered is different evidence from one the clock watched.
    const s = add(empty, { startedAt: at(9), endedAt: at(10) });
    expect(wasManual(s.sessions[0])).toBe(true);
    const timed = startSession(empty, project, { now: T, id: "s1" });
    expect(wasManual(timed.sessions[0])).toBe(false);
  });

  it("orders the window however it was given", () => {
    const s = add(empty, { startedAt: at(12), endedAt: at(9) });
    expect(elapsedMs(s.sessions[0], at(20))).toBe(3 * HOUR);
    expect(s.sessions[0].segments[0].startedAt).toBe(at(9));
  });

  it("records nothing for a zero-length block", () => {
    expect(add(empty, { startedAt: at(9), endedAt: at(9) }).sessions).toHaveLength(0);
  });

  it("leaves a running meter alone", () => {
    // Logging Tuesday afternoon is no reason to stop the clock running now.
    let s = startSession(empty, project, { now: at(14), id: "live" });
    s = add(s, { startedAt: at(9), endedAt: at(10) });
    const live = s.sessions.find((x) => x.id === "live");
    expect(isRunning(live)).toBe(true);
    expect(live.closedAt).toBeNull();
  });

  it("can be filed under a task and marked idle like any other", () => {
    const s = add(empty, { startedAt: at(9), endedAt: at(10) }, { kind: KIND.IDLE, taskId: "t1" });
    expect(s.sessions[0]).toMatchObject({ kind: KIND.IDLE, taskId: "t1" });
  });
});

describe("overlapping time", () => {
  const at = (h) => T + h * HOUR;
  const block = (id, from, to) =>
    addManualSession(empty, project, { startedAt: at(from), endedAt: at(to) }, T, id);

  it("finds a record that collides with the window", () => {
    // Two records over the same wall-clock hour double-count it. The timer
    // cannot produce that; a block typed in after the fact can.
    const s = block("m1", 9, 12);
    expect(overlappingSessions(s, { startedAt: at(11), endedAt: at(13) }).map((x) => x.id))
      .toEqual(["m1"]);
    expect(overlappingSessions(s, { startedAt: at(10), endedAt: at(11) }).map((x) => x.id))
      .toEqual(["m1"]);
  });

  it("does not count blocks that merely touch end to end", () => {
    // 09:00-12:00 and 12:00-13:00 share an instant, not a minute.
    const s = block("m1", 9, 12);
    expect(overlappingSessions(s, { startedAt: at(12), endedAt: at(13) })).toEqual([]);
    expect(overlappingSessions(s, { startedAt: at(7), endedAt: at(9) })).toEqual([]);
  });

  it("looks across every project, not just this one", () => {
    // You cannot be working two projects at once either.
    const other = { id: "p2", currentRate: 90, currency: "USD" };
    const s = addManualSession(
      { projects: [project, other], sessions: [] }, other,
      { startedAt: at(9), endedAt: at(12) }, T, "elsewhere");
    expect(overlappingSessions(s, { startedAt: at(10), endedAt: at(11) }).map((x) => x.id))
      .toEqual(["elsewhere"]);
  });

  it("ignores deleted records", () => {
    const s = deleteSession(block("m1", 9, 12), "m1", T);
    expect(overlappingSessions(s, { startedAt: at(10), endedAt: at(11) })).toEqual([]);
  });

  it("can exclude the record being edited", () => {
    const s = block("m1", 9, 12);
    expect(overlappingSessions(s, { startedAt: at(10), endedAt: at(11) }, "m1")).toEqual([]);
  });

  it("catches a session that is still running", () => {
    const s = startSession(empty, project, { now: at(9), id: "live" });
    expect(overlappingSessions(s, { startedAt: at(10), endedAt: at(11) }).map((x) => x.id))
      .toEqual(["live"]);
  });

  it("does not flag a running session that started after the window", () => {
    const s = startSession(empty, project, { now: at(15) });
    expect(overlappingSessions(s, { startedAt: at(9), endedAt: at(10) })).toEqual([]);
  });

  it("skips the gap between two blocks of a paused session", () => {
    let s = startSession(empty, project, { now: at(9), id: "s1" });
    s = pauseSession(s, "s1", at(10));
    s = resumeSession(s, "s1", at(14));
    s = stopSession(s, "s1", at(15));
    // the break is not time worked, so nothing collides with it
    expect(overlappingSessions(s, { startedAt: at(11), endedAt: at(13) })).toEqual([]);
    expect(overlappingSessions(s, { startedAt: at(9, 30), endedAt: at(13) }).map((x) => x.id))
      .toEqual(["s1"]);
  });
});
