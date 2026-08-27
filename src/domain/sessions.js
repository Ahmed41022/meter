import { isOpen, isRunning, lastActivityAt } from "./time.js";

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

export const sessionsFor = (state, projectId) =>
  liveSessions(state.sessions).filter((s) => s.projectId === projectId);

/** The session the user hasn't stopped yet — running or paused. */
export const currentSession = (state, projectId) =>
  sessionsFor(state, projectId)
    .filter(isOpen)
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;

/**
 * Starting a session closes anything still open on that project. Without this
 * a project can accumulate several "open" sessions and the UI silently picks
 * one, which is how double-billing happens.
 *
 * The rate is SNAPSHOT here. Later edits to the project rate must never reach
 * a session already recorded.
 */
export const startSession = (state, project, now, id) => {
  const closed = state.sessions.map((s) =>
    s.projectId === project.id && !s.deletedAt && isOpen(s)
      ? { ...closeOpenSegments(s, now), closedAt: now }
      : s
  );
  return {
    ...state,
    sessions: [
      ...closed,
      {
        id,
        projectId: project.id,
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
