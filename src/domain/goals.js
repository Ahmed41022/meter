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
 * Weeks begin Monday, and years on 1 January. Lifetime has no boundary, so it
 * stays at the epoch.
 */
export const periodBoundary = (period, now, n = 0) => {
  const d = new Date(now);
  if (period === "year") return new Date(d.getFullYear() + n, 0, 1).getTime();
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

/**
 * The calendar days covering [from, to), as the instant each one ends.
 *
 * Days, not 24-hour slices: a goal week that contains a DST shift has one day
 * of 23 or 25 hours in it, and that day is still one day of your week. Walking
 * calendar boundaries is also what makes the ends tile the window exactly —
 * the last one is clamped to `to`, so nothing spills past the period.
 */
export const dayEnds = (from, to) => {
  const ends = [];
  for (let at = from; at < to; ) {
    const next = Math.min(periodBoundary("day", at, 1), to);
    ends.push(next);
    at = next;
  }
  return ends;
};

/** Below this share of a day's worth, being off the line is noise, not news.
 *  "$2 behind" on a $1,260 week is a true statement that tells you nothing. */
const EVEN_ENOUGH = 0.02;

/**
 * Pacing: not how far along a target is, but whether that is far enough by now.
 *
 * Progress alone cannot answer that. Half of a weekly goal is triumphant on
 * Tuesday and a crisis on Sunday, and the bar looks identical either way. So
 * this measures the value against the days that have actually FINISHED, and
 * says what the days remaining would each have to carry.
 *
 * Whole finished days is a deliberate choice over the fraction of the window
 * that has physically elapsed. Elapsed-time pacing declares you behind at
 * 09:00 on Monday for not having worked overnight, which is both useless and
 * insulting; it also makes the verdict depend on the hour you happen to open
 * the app. Judging on finished days is stable all day and matches how the
 * remaining work actually gets planned — by the day. It is generous early in a
 * period by design, which is why `needPerDay` is here too: that figure tells
 * you the truth Monday morning, when the drift cannot yet.
 *
 * `today` is not counted as done and not counted as gone: it is the first of
 * the days left, because it is still yours to use.
 *
 * Null when there is nothing to pace — no target, or a lifetime goal, which has
 * no end to be measured against.
 */
export const pace = ({ target, from, to }, value, now) => {
  if (!(target > 0) || !(to > from)) return null;
  const ends = dayEnds(from, to);
  const totalDays = ends.length;
  const daysDone = ends.filter((end) => end <= now).length;
  const daysLeft = totalDays - daysDone;

  const flatPerDay = target / totalDays;
  const expected = flatPerDay * daysDone;
  const remaining = Math.max(0, target - value);
  const met = value >= target;

  return {
    target, value, totalDays, daysDone, daysLeft,
    flatPerDay,
    expected,
    drift: value - expected,
    remaining,
    over: Math.max(0, value - target),
    met,
    closed: daysLeft === 0,
    // What each day that is left would have to carry. Null once there is
    // nothing left to carry it, or nothing left to do.
    needPerDay: met || daysLeft === 0 ? null : remaining / daysLeft,
  };
};

/** Pacing for a saved goal against its own current period. */
export const paceGoal = (goal, value, now) => {
  const g = normaliseGoal(goal);
  if (!g || g.period === "lifetime") return null;
  return pace(
    { target: g.target, from: periodBoundary(g.period, now, 0), to: periodBoundary(g.period, now, 1) },
    value, now,
  );
};

/**
 * Which of five things there is to say, decided once here so the wording layer
 * renders a state rather than re-deriving it from four fields and disagreeing
 * with the next screen that tries.
 */
export const paceState = (p) => {
  if (p == null) return null;
  if (p.met) return "met";
  if (p.closed) return "missed";
  const tolerance = p.flatPerDay * EVEN_ENOUGH;
  if (p.drift < -tolerance) return "behind";
  if (p.drift > tolerance) return "ahead";
  return "even";
};
