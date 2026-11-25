import { periodBoundary } from "./goals.js";
import { performanceIn } from "./performance.js";
import { isIdle } from "./sessions.js";
import { isRunning } from "./time.js";

/**
 * What is left of today, and what a goal can still ask of it.
 *
 * `endsAt` is when the owner's day ends, in minutes after midnight on this
 * device's clock: the preference `dayEndsAt`, 0 for midnight. A time up to
 * noon is the NEXT morning, for somebody who works past midnight: their day
 * turns over then, and goals count until then toward the day before. A later
 * time is an evening: the day still turns over at midnight, and work after it
 * still counts, but none of it is called left.
 *
 * Only goals ask any of this. Every other figure in the app turns over at
 * midnight, and what a client pays goes by the client's own clock.
 *
 * Like the rest of `domain/`, nothing here reads the clock or storage.
 */
const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOON = 12 * 60;
/** Needing more than this share of the time left is cutting it fine. */
const TIGHT = 0.8;
/** How far back, and over how many hours, a rate is worth quoting. */
const RATE_DAYS = 30;
const RATE_HOURS = 5;

/** Minutes after midnight that a day of goals turns over. */
export const dayTurn = (endsAt) => (endsAt > 0 && endsAt <= NOON ? endsAt : 0);

/** The day now is in: where it starts and turns over, and how long is left. */
export const dayLeft = (now, endsAt = 0) => {
  const turn = dayTurn(endsAt);
  const from = periodBoundary("day", now, 0, turn);
  const to = periodBoundary("day", now, 1, turn);
  const d = new Date(from);
  const until = endsAt > NOON
    ? Math.min(to, new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, endsAt).getTime())
    : to;
  return { from, to, until, endsAt, leftMs: Math.max(0, until - now), over: now >= until };
};

/** The meters running on billed work among these sessions. */
export const metersOn = (sessions) =>
  sessions.filter((s) => !s.deletedAt && !isIdle(s) && isRunning(s)).length;

/** What an hour of this work has been earning lately, in whole units, or null
 *  where there is too little of it to say. `read` turns totals into
 *  `{ value, ms }`: the money, and the hours it came from. */
export const recentRate = (sessions, earnings, now, rateOf, read) => {
  const from = periodBoundary("day", now, -RATE_DAYS);
  const { value, ms } = read(performanceIn(sessions, from, now, now, rateOf, earnings));
  return ms >= RATE_HOURS * HOUR && value > 0 ? value / (ms / HOUR) : null;
};

/**
 * Today's part of a goal. `type` is the goal's, and every figure is in its own
 * units (minutes, or whole currency units).
 *
 * A day's goal is all today's. A week's or a month's share of today is settled
 * as the day starts: what was left then, over the days left then. So it stands
 * still while it is worked through, rather than shrinking with every hour done.
 * What today can no longer hold moves to the days after it (`then`, for each).
 *
 * `state`: "done"; "over" once the day has ended; "short" where what is left
 * to do is more than what is left of the day, "tight" where it is most of it,
 * "fits" where it is not; and "open" where nobody can say, which is money with
 * no recent rate. Two meters on the goal's work do two hours in one, so what a
 * day holds goes by how many are running.
 */
export const todayOf = ({ type, target, value, valueToday = value, pacing = null, day, meters = 0, perHour = null, now }) => {
  if (pacing && (pacing.met || pacing.closed || pacing.daysLeft === 0)) return null;
  const share = pacing ? (target - (value - valueToday)) / pacing.daysLeft : target;
  if (!(share > 0)) return null;
  const toGo = Math.max(0, share - valueToday);
  const lanes = Math.max(1, meters);
  const holds = type === "time" ? (day.leftMs / MINUTE) * lanes
    : perHour > 0 ? (day.leftMs / HOUR) * perHour * lanes : null;
  const state = toGo <= 0 ? "done"
    : day.over ? "over"
    : holds === null ? "open"
    : toGo > holds ? "short"
    : toGo > holds * TIGHT ? "tight" : "fits";
  const fits = Math.min(toGo, day.over ? 0 : holds ?? toGo);
  const after = pacing ? pacing.daysLeft - 1 : 0;
  const finishAt = type === "time" && !pacing && meters > 0 && toGo > 0 ? now + (toGo * MINUTE) / meters : null;
  return {
    kind: pacing ? "share" : "day",
    share, done: valueToday, toGo, state, leftMs: day.leftMs, endsAt: day.endsAt,
    then: after > 0 ? Math.max(0, pacing.remaining - fits) / after : null,
    // At what the work has been earning, how long the rest of it takes; or,
    // where that is not known, what an hour would have to earn.
    atRateMs: type === "money" && perHour > 0 ? (toGo / perHour) * HOUR : null,
    needPerHour: type === "money" && !(perHour > 0) && day.leftMs >= MINUTE ? toGo / (day.leftMs / HOUR) : null,
    // Only while a meter is on it, and only if that is still today.
    finishAt: finishAt !== null && finishAt < day.to ? finishAt : null,
  };
};
