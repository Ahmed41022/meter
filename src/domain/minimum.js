import { elapsedMs } from "./time.js";
import { isBilled, isIdle } from "./sessions.js";
import { isOffClock } from "./projects.js";
import { findTask } from "./tasks.js";
import { isOpenTask } from "./taskState.js";
import { crossingAt } from "./terms.js";

/**
 * The least time a task has to take.
 *
 * The opposite of a time limit (terms.js): a limit says when time stops paying
 * in full, a minimum says how much there still has to be. So its clock counts
 * DOWN, from the minimum to nothing, over all of the task's sittings. It is a
 * requirement, not a price: no figure of money reads it, and for that reason
 * it keeps no history either. A task handed in is past needing one.
 *
 * `taskMinMs` on a project is the minimum for every one of its tasks; `minMs`
 * on a task replaces it, and 0 there says this task has none. Both are absent
 * where nothing was set. Work filed under no task has no minimum to meet, and
 * nor has anything off the clock. Idle time does not count towards it.
 */
const positive = (ms) => (Number.isFinite(ms) && ms > 0 ? ms : null);

/** The minimum a project asks of each of its tasks, or null. */
export const projectMinimum = (project) =>
  (isOffClock(project) ? null : positive(project?.taskMinMs));

/** The minimum one task is held to, in milliseconds, or null for none. */
export const minimumFor = (project, task) => {
  if (!project || !task || isOffClock(project) || !isOpenTask(task)) return null;
  return Number.isFinite(task.minMs) ? positive(task.minMs) : projectMinimum(project);
};

/** The billed sittings of one task. */
const sittings = (sessions, projectId, taskId) => (sessions ?? []).filter((s) =>
  !s.deletedAt && isBilled(s) && s.projectId === projectId && s.taskId === taskId);

/**
 * Where a task stands against its minimum, as
 * `{ ms, doneMs, leftMs, at }`, or null where it has none. `at` is the moment
 * the minimum was met, which is in the future while a sitting is going and
 * null when it has not been met and nothing is.
 */
export const minimumState = (project, taskId, sessions, now) => {
  const ms = taskId ? minimumFor(project, findTask(project, taskId)) : null;
  if (ms === null) return null;
  const mine = sittings(sessions, project.id, taskId);
  const doneMs = mine.reduce((total, s) => total + elapsedMs(s, now), 0);
  return { ms, doneMs, leftMs: Math.max(0, ms - doneMs), at: crossingAt(mine, ms) };
};

/** The same for a sitting: null while it is idle, which counts towards nothing. */
export const minimumOf = (project, session, sessions, now) =>
  (session && !isIdle(session) ? minimumState(project, session.taskId, sessions, now) : null);

/** A countdown in whole seconds, rounded up, so it reads zero only once the
 *  minimum is met and adds up with an elapsed time rounded down. */
export const countdownMs = (leftMs) => Math.ceil(leftMs / 1000) * 1000;

/** Hours as typed, in milliseconds: null for an empty box, NaN for one that
 *  cannot be read. A decimal comma is read as the pay boxes read it. */
export const readHours = (text) => {
  const clean = String(text ?? "").trim().replace(",", ".");
  if (!clean) return null;
  const hours = Number(clean);
  return Number.isFinite(hours) && hours >= 0 ? Math.round(hours * 3_600_000) : NaN;
};

/** Milliseconds as the hours a box shows. */
export const hoursText = (ms) => (Number.isFinite(ms) ? String(+(ms / 3_600_000).toFixed(4)) : "");

/** One task's own minimum: null to follow the project's, 0 for none at all. */
export const setOwnMinimum = (state, projectId, taskId, ms) => ({
  ...state,
  projects: state.projects.map((p) => (p.id !== projectId ? p : {
    ...p,
    tasks: (p.tasks ?? []).map((t) => {
      if (t.id !== taskId) return t;
      const next = { ...t, minMs: ms };
      if (!Number.isFinite(ms) || ms < 0) delete next.minMs;
      return next;
    }),
  })),
});
