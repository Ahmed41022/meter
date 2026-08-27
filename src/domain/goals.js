/**
 * Goal periods are bucketed in LOCAL time — a "week" means the user's week —
 * while the timestamps themselves stay UTC epoch integers. Deriving the
 * boundary from a Date object is what keeps this correct across DST shifts.
 */

/** Start of the current period, in epoch ms. Weeks begin Monday. */
export const periodStart = (period, now) => {
  const d = new Date(now);
  if (period === "week") {
    const dayFromMonday = (d.getDay() + 6) % 7;
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - dayFromMonday);
    return d.getTime();
  }
  if (period === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return 0; // lifetime
};

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
