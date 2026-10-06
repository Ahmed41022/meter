/**
 * What you have been doing lately, and what to start next.
 *
 * Every other reporting function here answers "how much" over a window. These
 * two answer "what happened", which is a different question and wants a
 * different shape: a list of events in the order they occurred, not a total.
 *
 * That difference decides how a session crossing midnight is handled, and it
 * is the one thing to be careful about in this file. Everywhere in the app a
 * session is distributed across the days it TOUCHES, by overlap, so a
 * 23:30 → 00:30 sitting puts half an hour in each of two days. The list
 * follows the same rule rather than one of its own: the sitting is listed
 * under both days, and each listing stands for that day's half of it. Filed
 * whole under the day it started, the rows under a heading could not add up
 * to the heading, which counts by overlap like every other figure.
 *
 * The figures beside a day heading still come from `performanceIn` over that
 * day's window, the same way the Overview computes them, and never from
 * summing the rows grouped here. That keeps the heading equal to the same
 * day on every other screen by construction; a caller measures each row over
 * the same window, so the rows agree with the heading as well.
 *
 * Like the rest of `domain/`, nothing here reads the clock or storage.
 */
import { overlapMs, startedAt } from "./time.js";
import { periodBoundary } from "./goals.js";
import { acceptsTime } from "./projects.js";
import { takesTimeIn } from "./taskState.js";

/**
 * The last few things you were working on, newest first, one row per
 * project-and-task pair.
 *
 * Deduplicated, because the value of this list is that it is short: eight
 * sittings on the same task yesterday should offer one way to resume it, not
 * eight identical buttons. The task is part of the identity — going back to a
 * project usually means going back to the particular thing in it — so the same
 * project under two tasks is two rows.
 *
 * A project that will not take new time is left out. Offering to start a meter
 * that `startSession` refuses would be a button that does nothing, and worse,
 * starting one CLOSES whatever else is open, so a start that should not have
 * happened does not merely fail.
 */
export const recentPicks = (sessions, projects, limit = 5) => {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const seen = new Set();
  const picks = [];
  const ordered = sessions
    .filter((s) => !s.deletedAt)
    .sort((a, b) => startedAt(b) - startedAt(a));

  for (const session of ordered) {
    if (picks.length >= limit) break;
    const project = byId.get(session.projectId);
    if (!project || !acceptsTime(project)) continue;
    // A handed-in task takes no more hours either, and the same reasoning
    // applies: this list must not offer a start that does nothing.
    if (!takesTimeIn(project, session.taskId)) continue;
    const key = `${session.projectId}|${session.taskId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push({ project, taskId: session.taskId ?? null, kind: session.kind, at: startedAt(session) });
  }
  return picks;
};

/**
 * Every day that has something in it, newest first, with the sessions that
 * touched it.
 *
 * A session is listed under the day it started and under every later day it
 * was still going into, so one that ran past midnight appears under each of
 * its days. Only days it actually ran on: a sitting paused overnight and
 * resumed two days later is not listed under the day in between. A running
 * session reaches as far as `now`; without one it is listed under the day it
 * started, which is also where a session with no time in it yet belongs.
 *
 * Days with no work are absent rather than present and empty: a fortnight off
 * would otherwise be fourteen rows saying nothing, between the two days you
 * wanted to compare.
 *
 * `dayEnd` is carried so a caller can hand the window straight to
 * `performanceIn` without re-deriving a boundary — and, more to the point,
 * without being tempted to total the rows instead. See the note at the top.
 */
export const daysOfWork = (sessions, now) => {
  const days = new Map();
  const file = (dayStart, session) => {
    if (!days.has(dayStart)) days.set(dayStart, []);
    const list = days.get(dayStart);
    if (!list.includes(session)) list.push(session);
  };
  for (const session of sessions) {
    if (session.deletedAt) continue;
    file(periodBoundary("day", startedAt(session), 0), session);
    for (const segment of session.segments ?? []) {
      const end = segment.endedAt ?? now;
      // Day by day along the calendar rather than in steps of 24 hours, so a
      // 23- or 25-hour day is still one day.
      for (let day = periodBoundary("day", segment.startedAt, 0); day < end; ) {
        const next = periodBoundary("day", day, 1);
        if (overlapMs(segment, day, next, now) > 0) file(day, session);
        day = next;
      }
    }
  }
  return [...days.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([dayStart, list]) => ({
      dayStart,
      dayEnd: periodBoundary("day", dayStart, 1),
      sessions: list.sort((a, b) => startedAt(b) - startedAt(a)),
    }));
};

/** Whether a session ran past the end of the day it is listed under — the one
 *  case where a row's own duration is not all attributed to the day above it. */
export const spillsPast = (session, dayEnd, now) => {
  const last = session.segments?.[session.segments.length - 1];
  if (!last) return false;
  return (last.endedAt ?? now) > dayEnd;
};
