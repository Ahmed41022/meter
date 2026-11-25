import { formatShortDuration } from "../../domain/money.js";
import { isDone, isPaused } from "../../domain/projects.js";

/** How a goal is spoken of, in one place, for Today, the Overview and the notice. */
export const PERIOD_WORD = { day: "today", week: "this week", month: "this month" };
export const EVERY_WORD = { day: "Daily", week: "Weekly", month: "Monthly" };
export const A_WORD = { day: "a day", week: "a week", month: "a month" };
const MANY = { day: "days", week: "weeks", month: "months" };

/** A time of day as this device writes it. */
export const clockOf = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
/** And one given in minutes after midnight. */
export const clockOfMinutes = (m) => clockOf(new Date(2000, 0, 1, 0, m));

/** How long is left, never a "0m" that is still a little. */
export const leftWords = (ms) => formatShortDuration(Math.max(60_000, ms));

/** Today's line is amber when the day cannot hold it, or only just. */
export const todayTone = (t) =>
  (t.state === "done" ? "met" : ["tight", "short", "over"].includes(t.state) ? "behind" : "even");

/**
 * Today's part of a goal, and what is left of the day for it (`todayOf`).
 * `show` is the goal's own formatter.
 */
export const todayWords = (t, show) => {
  const then = t.then === null ? "" : `then ${show(t.then)}/day`;
  const said = (...parts) => parts.filter(Boolean).join(" · ");
  const day = t.kind === "day";
  if (t.state === "done") return said(`Today’s ${show(t.share)} done`, then);
  const ended = `your day ended at ${clockOfMinutes(t.endsAt)}`;
  if (t.state === "over") {
    return day ? said(`${show(t.toGo)} short`, ended) : said(`Today ${show(t.done)} of ${show(t.share)}`, ended, then);
  }
  const short = t.state === "short";
  return said(
    day ? `${show(t.toGo)} to go` : `Today ${show(t.done)} of ${show(t.share)}`,
    // Longer than a day says nothing about today that "only" does not.
    t.atRateMs !== null && t.atRateMs <= 86_400_000 && `≈ ${leftWords(t.atRateMs)} at your recent rate`,
    t.needPerHour !== null && `${show(t.needPerHour)} per hour needed`,
    `${short ? "only " : ""}${leftWords(t.leftMs)} left today`,
    // Where today can hold its share, the days after are asked the same.
    short && then,
    t.finishAt !== null && `met around ${clockOf(t.finishAt)}`,
  );
};

/** Why a goal is not being worked towards: its own pause, or its projects'. */
export const restWords = (goal, projects, paused) => {
  if (paused) return "paused";
  if (goal.scope.kind === "company") return "no active project";
  const project = projects.find((p) => p.id === goal.scope.projectId);
  if (!project) return "project removed";
  return isDone(project) ? "project done" : isPaused(project) ? "project paused" : "not work";
};

/** "Met 4 of the last 5 weeks", or nothing before there is one to speak of. */
export const resultWords = (results, period) => {
  if (results.length === 0) return "";
  const met = results.filter((r) => r.met).length;
  const one = { day: "day", week: "week", month: "month" }[period];
  return results.length === 1
    ? `${met ? "Met" : "Missed"} the ${one} before`
    : `Met ${met} of the last ${results.length} ${MANY[period]}`;
};
