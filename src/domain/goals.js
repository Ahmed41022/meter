/**
 * Goal periods are bucketed in LOCAL time — a "week" means the user's week —
 * while the timestamps themselves stay UTC epoch integers. Deriving the
 * boundary from a Date object is what keeps this correct across DST shifts.
 */

/**
 * Start of the period `n` whole periods from the one containing `now`.
 *
 * Built from calendar FIELDS, never by adjusting an instant. That distinction
 * is load-bearing: in a zone that springs forward at midnight (Africa/Cairo
 * does) local 00:00 does not exist on that date, so `setHours(0,0,0,0)`
 * normalises to 01:00 — and carrying that hour into `setDate` put the start of
 * the week an hour late, quietly dropping work done just after midnight on the
 * Monday. Constructing each boundary from its own calendar date cannot drift;
 * Date normalises a missing midnight forward for us, which is the answer we
 * want. Month arithmetic is safe for the same reason: it always lands on the
 * 1st, so it can never overflow the way `setMonth` on the 31st does.
 *
 * Weeks begin Monday. Lifetime has no boundary, so it stays at the epoch.
 */
export const periodBoundary = (period, now, n = 0) => {
  const d = new Date(now);
  if (period === "month") return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime();
  if (period === "week" || period === "day") {
    const fromMonday = period === "week" ? (d.getDay() + 6) % 7 : 0;
    const step = period === "week" ? 7 : 1;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - fromMonday + n * step).getTime();
  }
  return 0; // lifetime
};

/** Start of the current period, in epoch ms. Weeks begin Monday. */
export const periodStart = (period, now) => periodBoundary(period, now, 0);

export const inPeriod = (session, period, now, startedAtOf) =>
  startedAtOf(session) >= periodStart(period, now);

/** Progress as a 0..1 ratio, clamped. A goal of 0 or less is no goal. */
export const goalProgress = (value, target) => {
  if (!target || target <= 0) return 0;
  return Math.min(1, Math.max(0, value / target));
};

export const isGoalMet = (value, target) => target > 0 && value >= target;

export const normaliseGoal = (goal) => {
  if (!goal) return null;
  const target = Number(goal.target);
  if (!Number.isFinite(target) || target <= 0) return null;
  return { ...goal, target };
};
