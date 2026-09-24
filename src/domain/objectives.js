import { elapsedMs } from "./time.js";

/**
 * Objectives: the things you mean to finish, as opposed to the time you spent.
 *
 * They are their own records rather than a flag on a task, because the two
 * answer different questions. A task is "which bucket does this time go in" —
 * it only exists once there is time to file. An objective is "I intend to do
 * this", and most of them are true before a single second has been tracked and
 * some never accrue any at all ("email the client back").
 *
 * Where an objective DOES correspond to tracked work it carries a `taskId`,
 * and then it can say what a plain checklist never can: how long the thing
 * actually took, against how long you thought it would.
 *
 * Objectives live at the top level of the store rather than inside a project,
 * so "what am I doing today" is one pass over one list instead of a walk
 * across every project.
 */

/**
 * Today is stored as a LOCAL calendar day, not a timestamp or a boolean.
 *
 * A boolean would still be set tomorrow morning and would need a nightly job
 * to clear it — the same accumulate-versus-derive mistake the timer avoids.
 * Storing the day it was chosen for means "is this today's" is derived on
 * read, expires by itself, and cannot rot while the app is closed.
 */
export const dayKey = (now) => {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Stores written before objectives existed have no array at all, and that
 *  absence reads as "none" rather than needing a schema bump. */
export const allObjectives = (state) => state.objectives ?? [];

export const liveObjectives = (state) => allObjectives(state).filter((o) => !o.deletedAt);

export const objectivesFor = (state, projectId) =>
  liveObjectives(state).filter((o) => o.projectId === projectId);

export const isDone = (objective) => !!objective.done;

/** Picked for the focus list on a given day. */
export const isToday = (objective, key) => objective.focusedOn === key;

/**
 * Everything picked for today, still open, across every project.
 *
 * Done items drop out rather than lingering ticked: the point of the list is
 * what is left, and a finished item has already been reported in the count.
 */
export const todaysObjectives = (state, key) =>
  liveObjectives(state).filter((o) => isToday(o, key) && !isDone(o));

export const doneToday = (state, key) =>
  liveObjectives(state).filter((o) => isDone(o) && o.doneAt != null && dayKey(o.doneAt) === key);

const mapObjectives = (state, fn) => ({
  ...state,
  objectives: allObjectives(state).map(fn),
});

export const normaliseText = (text) => String(text ?? "").trim();

/** An estimate is entered in hours and stored in milliseconds, so it is the
 *  same unit as everything else the app measures. Anything that isn't a
 *  positive number reads as no estimate. */
export const estimateFromHours = (hours) => {
  const parsed = Number(hours);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 3_600_000);
};

export const addObjective = (state, projectId, { text, estimateMs = null, taskId = null }, now, id) => {
  const clean = normaliseText(text);
  if (!clean) return state;
  return {
    ...state,
    objectives: [
      ...allObjectives(state),
      {
        id, projectId, text: clean,
        done: false, doneAt: null,
        createdAt: now,
        focusedOn: null,
        estimateMs,
        taskId,
        deletedAt: null,
      },
    ],
  };
};

/**
 * Ticking records WHEN, not just that.
 *
 * The timestamp is what lets a finished objective be counted into the day it
 * was actually finished; a bare boolean could only ever say "at some point".
 */
export const toggleObjective = (state, id, now) =>
  mapObjectives(state, (o) =>
    o.id === id ? { ...o, done: !o.done, doneAt: o.done ? null : now } : o
  );

export const editObjective = (state, id, patch) =>
  mapObjectives(state, (o) => {
    if (o.id !== id) return o;
    const next = { ...o, ...patch };
    if (patch.text !== undefined) {
      const clean = normaliseText(patch.text);
      if (!clean) return o; // a blank rename is a slip, not an instruction
      next.text = clean;
    }
    return next;
  });

/** Pick for, or drop from, a day's focus. Passing null clears it. */
export const focusObjective = (state, id, key) =>
  mapObjectives(state, (o) => (o.id === id ? { ...o, focusedOn: key } : o));

/** Soft delete, like sessions — the caller keeps the prior state for an undo. */
export const removeObjective = (state, id, now) =>
  mapObjectives(state, (o) => (o.id === id ? { ...o, deletedAt: now } : o));

export const restoreObjective = (state, id) =>
  mapObjectives(state, (o) => (o.id === id ? { ...o, deletedAt: null } : o));

/** Objectives are unfiled rather than destroyed when their task goes away, for
 *  the same reason sessions are: the intent outlives the bucket. */
export const unlinkTask = (state, taskId) =>
  mapObjectives(state, (o) => (o.taskId === taskId ? { ...o, taskId: null } : o));

/**
 * How long the linked task has actually taken.
 *
 * Null when nothing is linked, because "no time tracked" and "not measured"
 * are different statements — the same reason `utilisation` returns null rather
 * than zero when there is nothing to divide.
 */
export const actualMs = (objective, sessions, now) => {
  if (!objective.taskId) return null;
  const mine = sessions.filter((s) => !s.deletedAt && s.taskId === objective.taskId);
  return mine.length ? mine.reduce((total, s) => total + elapsedMs(s, now), 0) : 0;
};

/**
 * Spent against estimated, as a ratio. 1 is exactly on, 1.5 is half again as
 * long as planned. Null when either side is missing — an estimate you never
 * made cannot be judged.
 */
export const estimateRatio = (estimateMs, spentMs) =>
  estimateMs > 0 && spentMs != null ? spentMs / estimateMs : null;

/**
 * Open objectives first, then finished ones, each oldest first.
 *
 * Done items stay visible rather than disappearing, because seeing what you
 * finished is most of the reward, but they sink below what is still outstanding.
 */
export const orderObjectives = (objectives) =>
  [...objectives].sort(
    (a, b) => Number(a.done) - Number(b.done) || a.createdAt - b.createdAt
  );

/** Open and done counts for a set, for a heading that says "3 of 7". */
export const progress = (objectives) => ({
  done: objectives.filter(isDone).length,
  total: objectives.length,
});
