import { goalValue } from "./performance.js";
import { normaliseGoal, pace, paceState, periodBoundary } from "./goals.js";
import { dayLeft, dayTurn, metersOn, recentRate, todayOf } from "./hoursLeft.js";

/**
 * Where a project's own weekly or monthly goal stands: what it has come to,
 * its pace, and its part of today. Asked by the project page and by the
 * Overview's Targets, so one goal cannot read two ways on two screens.
 *
 * `sessions` and `earnings` are the project's own. Null where there is no goal
 * with an end to it.
 */
export const projectGoalStanding = (project, goal, { sessions, earnings, now, rateOf, endsAt = 0 }) => {
  const g = normaliseGoal(goal);
  if (!g || g.period === "lifetime") return null;
  const turn = dayTurn(endsAt);
  const from = periodBoundary(g.period, now, 0, turn);
  const to = periodBoundary(g.period, now, 1, turn);
  const day = dayLeft(now, endsAt);
  const read = (a, b) => goalValue(g, project, sessions, earnings, a, b, now, rateOf);
  const value = read(from, to);
  const pacing = pace({ target: g.target, from, to, turn }, value, now);
  const perHour = g.type === "money" ? recentRate(sessions, earnings, now, rateOf, (t) => ({
    value: ((t.billedCents[project.currency] ?? 0) + (t.pendingCents[project.currency] ?? 0)) / 100,
    ms: t.billedMsByCurrency[project.currency] ?? 0,
  })) : null;
  return {
    goal: g, from, to, value, pacing, state: paceState(pacing),
    today: todayOf({
      type: g.type === "money" ? "money" : "time", target: g.target, value,
      valueToday: read(day.from, day.to), pacing, day, meters: metersOn(sessions), perHour, now,
    }),
  };
};
