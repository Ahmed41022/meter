/**
 * Does the stored state have a meter still running?
 *
 * Kept as its own CommonJS module so the desktop quit-guard can be tested.
 * It reads the same shape the app persists, and mirrors the domain rule: a
 * segment with no endedAt is accruing time.
 */
function hasRunningSession(raw) {
  let state;
  try {
    state = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return false;
  }
  if (!state || !Array.isArray(state.sessions)) return false;
  return state.sessions.some(
    (s) => !s.deletedAt && Array.isArray(s.segments) && s.segments.some((g) => g.endedAt == null)
  );
}

module.exports = { hasRunningSession, STORE_KEY: "meter:v1" };
