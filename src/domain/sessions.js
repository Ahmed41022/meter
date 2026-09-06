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

/**
 * Re-file sessions under a different task — open or closed, one or many.
 *
 * This is the one field a finished session will let you change, and the
 * distinction is deliberate: `segments` and `rate` are the audit trail, so
 * editing them would falsify what you actually worked and earned. `taskId` is
 * a label on that record. Moving it changes which bucket the same hours report
 * under, not the hours themselves. Immutability protects the measurement, not
 * the filing.
 */
export const assignTaskToMany = (state, sessionIds, taskId) => {
  const ids = new Set(sessionIds);
  return mapSessions(state, (s) => (ids.has(s.id) && !s.deletedAt ? { ...s, taskId } : s));
};

export const assignTask = (state, sessionId, taskId) =>
  assignTaskToMany(state, [sessionId], taskId);

/**
 * Correct a finished session's start and end.
 *
 * Immutability was there to stop a record drifting by accident, but a session
 * you forgot to stop is already wrong, and a wrong number you cannot fix is
 * worse than one you can. What deserves protecting is not that the figure
 * never moves — it's that you can always see what the meter actually recorded.
 * So a correction keeps the original segments alongside the new ones rather
 * than overwriting them, and only the FIRST correction captures it: edit twice
 * and `original` still holds what was measured, not your previous guess.
 *
 * Pause structure is preserved rather than collapsed. Collapsing a session
 * with a four-hour break into one start→end block would silently bill the
 * break, which is the exact failure this app is built to avoid.
 */
export const correctSession = (state, sessionId, { startedAt, endedAt }, now) =>
  mapSessions(state, (s) => {
    if (s.id !== sessionId || s.deletedAt || isOpen(s)) return s;

    const start = Math.min(startedAt, endedAt);
    const end = Math.max(startedAt, endedAt);
    const ordered = [...s.segments].sort((a, b) => a.startedAt - b.startedAt);

    const rebuilt = ordered
      .map((seg, i) => ({
        ...seg,
        startedAt: i === 0 ? start : Math.max(seg.startedAt, start),
        endedAt: i === ordered.length - 1 ? end : Math.min(seg.endedAt ?? end, end),
      }))
      .filter((seg) => seg.endedAt > seg.startedAt);

    return {
      ...s,
      segments: rebuilt.length ? rebuilt : [{ startedAt: start, endedAt: end }],
      closedAt: end,
      original: s.original ?? { segments: s.segments, closedAt: s.closedAt, correctedAt: now },
    };
  });

export const wasCorrected = (session) => !!session.original;

/** Put back exactly what the meter recorded. */
export const revertCorrection = (state, sessionId) =>
  mapSessions(state, (s) => {
    if (s.id !== sessionId || !s.original) return s;
    const { original, ...rest } = s; // destructured to drop the key entirely
    return { ...rest, segments: original.segments, closedAt: original.closedAt };
  });
