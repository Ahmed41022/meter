/**
 * What you have been doing lately, and what to start next.
 *
 * Every other reporting function here answers "how much" over a window. These
 * two answer "what happened", which is a different question and wants a
 * different shape: a list of events in the order they occurred, not a total.
 *
 * That difference decides how a session crossing midnight is handled, and it
 * is the one thing to be careful about in this file. Everywhere else in the
 * app a session is distributed across the days it TOUCHES, by overlap, so a
 * 23:30 → 00:30 sitting puts half an hour in each of two days. A list cannot
 * do that without showing the same work twice, so a session is listed under
 * the day it STARTED in, and only there.
 *
 * The two rules disagree on purpose, and callers must not mix them: the
 * figures beside a day heading have to come from `performanceIn` over that
 * day's window, the same way the Overview computes them, and never from
 * summing the rows this file grouped. Otherwise the same day reads two
 * different totals on two screens, which is the class of bug this codebase
 * spends most of its effort avoiding.
 *
 * Like the rest of `domain/`, nothing here reads the clock or storage.
 */
import { startedAt } from "./time.js";
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
 * Every day that has something in it, newest first, with its sessions.
 *
 * Days with no work are absent rather than present and empty: a fortnight off
 * would otherwise be fourteen rows saying nothing, between the two days you
 * wanted to compare.
 *
 * `dayEnd` is carried so a caller can hand the window straight to
 * `performanceIn` without re-deriving a boundary — and, more to the point,
 * without being tempted to total the rows instead. See the note at the top.
 */
export const daysOfWork = (sessions) => {
  const days = new Map();
  for (const session of sessions) {
    if (session.deletedAt) continue;
    const key = periodBoundary("day", startedAt(session), 0);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(session);
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
