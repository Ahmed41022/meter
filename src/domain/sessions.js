import { isOpen, isRunning, lastActivityAt } from "./time.js";

/**
 * A session is either billable work or time at the desk that wasn't worked.
 * Both use the same state machine — segments, pause/resume, rate snapshot,
 * crash recovery — they differ only in which total they land in.
 */
export const KIND = { BILLED: "billed", IDLE: "idle" };

/** Sessions written before idle tracking existed have no `kind`. That absence
 *  is unambiguous, so it reads as billed rather than needing a schema bump. */
export const kindOf = (session) => session.kind ?? KIND.BILLED;
export const isBilled = (session) => kindOf(session) === KIND.BILLED;
export const isIdle = (session) => kindOf(session) === KIND.IDLE;

/**
 * Pure state transitions. Every one takes (state, ..., now) and returns a new
 * state. No Date.now(), no random IDs, no storage — so every rule below can be
 * asserted in a test without mocking the clock.
 */

const mapSessions = (state, fn) => ({ ...state, sessions: state.sessions.map(fn) });

const closeOpenSegments = (session, at) => ({
  ...session,
  segments: session.segments.map((s) =>
    s.endedAt == null ? { ...s, endedAt: Math.max(s.startedAt, at) } : s
  ),
});

export const liveSessions = (sessions) => sessions.filter((s) => !s.deletedAt);

/** Every live session on a project, both kinds. For the ledger. */
export const allSessionsFor = (state, projectId) =>
  liveSessions(state.sessions).filter((s) => s.projectId === projectId);

/**
 * Billable sessions only — this is deliberately the DEFAULT accessor.
 * If a caller forgets to think about kind, it under-reports idle time
 * (harmless) instead of inflating earnings (the expensive failure).
 * Idle time must always be asked for by name.
 */
export const sessionsFor = (state, projectId) =>
  allSessionsFor(state, projectId).filter(isBilled);

export const idleSessionsFor = (state, projectId) =>
  allSessionsFor(state, projectId).filter(isIdle);

/** The session the user hasn't stopped yet, of either kind. */
export const currentSession = (state, projectId) =>
  allSessionsFor(state, projectId)
    .filter(isOpen)
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;

/** Share of desk time that was billable, 0..1. Null when nothing is recorded,
 *  because 0% and "no data" mean very different things. */
export const utilisation = (billedMs, idleMs) => {
  const total = billedMs + idleMs;
  return total > 0 ? billedMs / total : null;
};

/**
 * Starting a session closes EVERY other open session, on any project, of
 * either kind. One person cannot be billing two projects at once, and cannot
 * be working and idle at once — two live meters double-count wall-clock time.
 *
 * The rate is SNAPSHOT here. Later edits to the project rate must never reach
 * a session already recorded, and idle time is valued at the rate that was
 * current when it happened. The task is a reference, not a copy, so renaming
 * a task updates every session that points at it.
 */
export const startSession = (state, project, { now, id, kind = KIND.BILLED, taskId = null }) => {
  const closed = state.sessions.map((s) =>
    !s.deletedAt && isOpen(s) ? { ...closeOpenSegments(s, now), closedAt: now } : s
  );
  return {
    ...state,
    sessions: [
      ...closed,
      {
        id,
        projectId: project.id,
        kind,
        taskId,
        rate: project.currentRate,
        currency: project.currency,
        createdAt: now,
        segments: [{ startedAt: now, endedAt: null, lastTick: now }],
        closedAt: null,
        deletedAt: null,
      },
    ],
  };
};

/** Pause ends the current segment but leaves the session open. */
export const pauseSession = (state, id, now) =>
  mapSessions(state, (s) => (s.id === id && isRunning(s) ? closeOpenSegments(s, now) : s));

/** Resume appends a new segment rather than reopening the old one, so the
 *  gap is preserved and never billed. */
export const resumeSession = (state, id, now) =>
  mapSessions(state, (s) =>
    s.id === id && isOpen(s) && !isRunning(s)
      ? { ...s, segments: [...s.segments, { startedAt: now, endedAt: null, lastTick: now }] }
      : s
  );

/** Stop closes the segment AND the session. */
export const stopSession = (state, id, at) =>
  mapSessions(state, (s) =>
    s.id === id ? { ...closeOpenSegments(s, at), closedAt: at } : s
  );

/** Crash recovery: bill only up to the last heartbeat, not the whole gap. */
export const recoverSession = (state, id) => {
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return state;
  return stopSession(state, id, lastActivityAt(session));
};

/** Soft delete. Hard-deleting financial records with no undo is a decision
 *  you regret exactly once. */
export const deleteSession = (state, id, now) =>
  mapSessions(state, (s) => (s.id === id ? { ...s, deletedAt: now } : s));

export const restoreSession = (state, id) =>
  mapSessions(state, (s) => (s.id === id ? { ...s, deletedAt: null } : s));

/** Periodic proof-of-life written into the open segment. */
export const heartbeat = (state, now) =>
  mapSessions(state, (s) =>
    !s.deletedAt && isRunning(s)
      ? { ...s, segments: s.segments.map((g) => (g.endedAt == null ? { ...g, lastTick: now } : g)) }
      : s
  );

/** Re-point an OPEN session at a different task. Closed sessions are immutable
 *  — correcting a finished record is session editing, which this app doesn't
 *  do yet, and doing it here by accident would be worse than not doing it. */
export const assignTask = (state, sessionId, taskId) =>
  mapSessions(state, (s) => (s.id === sessionId && isOpen(s) ? { ...s, taskId } : s));
