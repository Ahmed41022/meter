/**
 * Time is always DERIVED from stored timestamps, never accumulated by a ticker.
 * Every function takes `now` as an argument rather than calling Date.now()
 * internally — that is what makes this layer deterministic and testable.
 */

/** Duration of one segment. Clamped at 0 so a backwards clock jump (NTP
 *  correction, manual clock change) can never subtract billable time. */
export const segmentMs = (segment, now) =>
  Math.max(0, (segment.endedAt ?? now) - segment.startedAt);

export const elapsedMs = (session, now) =>
  (session.segments || []).reduce((total, s) => total + segmentMs(s, now), 0);

/** The segment currently accruing time, if any. */
export const openSegment = (session) =>
  (session.segments || []).find((s) => s.endedAt == null);

/** Running = actively accruing. */
export const isRunning = (session) => !!openSegment(session);

/** Open = the user hasn't pressed Stop. A paused session is open, not running. */
export const isOpen = (session) => !session.closedAt;

export const startedAt = (session) =>
  session.segments?.[0]?.startedAt ?? session.createdAt;

/** Last moment we have evidence the session was alive. Crash recovery uses
 *  this to close a lost session at the right time instead of billing the gap. */
export const lastActivityAt = (session) => {
  const open = openSegment(session);
  if (open) return open.lastTick ?? open.startedAt;
  const ends = (session.segments || []).map((s) => s.endedAt).filter(Boolean);
  return ends.length ? Math.max(...ends) : session.createdAt;
};

/** Claims to be running but stopped checking in — the tab died. */
export const isStale = (session, now, thresholdMs) =>
  isRunning(session) && now - lastActivityAt(session) > thresholdMs;
