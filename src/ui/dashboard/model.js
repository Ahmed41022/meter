import { activeProjects } from "../../domain/projects.js";
import { dailyTotals, heatRange } from "../../domain/performance.js";
import { projectGoalStanding } from "../../domain/projectGoal.js";

/**
 * What the Overview works out from the ledger before drawing: the year of
 * days for the calendar, how far back it goes, and the pacing of each goal.
 * Plain functions of their inputs, so the view's one memo can call them.
 */
/** A year of days for one register, ready to shade. */
export const calendarFor = (sessions, now, back = 0) => {
  const { from, to } = heatRange(now, 53, back);
  const byDay = dailyTotals(sessions, from, to, now);
  return { from, to, byDay };
};

/** The first instant anything was recorded, so the calendar knows how far
 *  back there is anything to look at. */
export const earliestOf = (sessions) => Math.min(
  ...sessions.flatMap((s) => (s.segments ?? []).map((g) => g.startedAt)), Infinity);

/**
 * Every work goal that has a deadline, paced against its own period.
 *
 * Deliberately NOT tied to the period control above it. A goal resets when it
 * resets — asking "am I on for this week?" is a question about now, and the
 * answer must not change because the reader stepped the report back to look at
 * last month. Each row therefore says which period it is measuring.
 *
 * Lifetime goals are absent for the same reason they have no pacing: a target
 * with no end cannot be late. Off-clock goals are absent because sleep is not
 * a work target, and they are paced on their own page instead. Paused and
 * finished projects are absent because a target you are not working towards
 * is not news — it is a number that can only ever get worse.
 *
 * Ordered by how many days' worth off the line each one is — unit-free, so a
 * money goal and an hours goal can be compared, and the one needing attention
 * is at the top.
 *
 * A money goal counts what the headline counts, the settled money no clock
 * measured included; `projectGoalStanding` is the one place that reads it, shared
 * with the project page's own goal.
 */
export const targetsFor = (projects, work, now, rateOf, earnings, endsAt = 0) =>
  activeProjects(projects)
    .map((project) => {
      const at = projectGoalStanding(project, project.overallGoal, {
        sessions: work.filter((s) => s.projectId === project.id),
        earnings: earnings.filter((e) => e.projectId === project.id), now, rateOf, endsAt,
      });
      return at && { id: project.id, name: project.name, project, currency: project.currency, ...at };
    })
    .filter(Boolean)
    .sort((a, b) => a.pacing.drift / a.pacing.flatPerDay - b.pacing.drift / b.pacing.flatPerDay);
