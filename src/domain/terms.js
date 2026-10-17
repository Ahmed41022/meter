import { isBilled, isIdle, overLimitMs, sessionCents } from "./sessions.js";
import { findTask, rateFor } from "./tasks.js";
import { taskState } from "./taskState.js";

/**
 * A project's terms: its rate, and how long a task may take before the time
 * over it pays less.
 *
 * Some platforms pay a task's time in full only up to a limit — two hours,
 * say — and the time over it at a share of the rate: 30%, or nothing at all.
 * The rule is the project's, kept as a HISTORY of the terms in force, so that
 * a change can be made "from now on" without repricing work already handed
 * in. A task already handed in is held to the terms in force when it went in,
 * because that is when the platform judged it; a task still open follows the
 * latest. A change made to "everything" replaces the history with one entry
 * that has always been in force.
 *
 * `taskLimits` is absent on every project that has never had a limit, and
 * absent means none. An entry is `{ from, ms, factor }`: `from` is when it
 * came into force, null for always; `ms` the limit, null for no limit from
 * then on; `factor` what an hour over the limit pays, as a share of the rate.
 * A task can carry its own `limitMs`, which replaces the project's limit and
 * keeps its share.
 *
 * None of this is stored as money. Which time is over the limit is derived
 * from the task's sittings in the order they happened, so correcting a
 * sitting, or deleting one, moves the line with it.
 */

export const limitHistory = (project) => project?.taskLimits ?? [];

/** The terms a change would be made over: the latest entry, or none. */
export const currentLimit = (project) => {
  const latest = limitHistory(project).at(-1);
  return latest && latest.ms > 0 ? latest : null;
};

/** When a task was handed in, or null while it is open. A task answered
 *  before `submittedAt` existed has only `stateAt`, and that is its hand-in. */
export const handedInAt = (task) => {
  if (!task || taskState(task) === null) return null;
  return Number.isFinite(task.submittedAt) ? task.submittedAt : task.stateAt;
};

/**
 * The limit a task is held to, as `{ ms, factor }`, or null for none.
 *
 * Handed in, it is the entry in force at the hand-in; open, the latest. A
 * task's own limit replaces the project's, but only where the project has a
 * limit in force for it at all: on its own it would have no share to pay.
 */
export const limitFor = (project, task) => {
  const history = limitHistory(project);
  if (history.length === 0) return null;
  const at = handedInAt(task);
  const rule = at === null || !Number.isFinite(at)
    ? history.at(-1)
    : [...history].reverse().find((r) => (r.from ?? -Infinity) <= at) ?? null;
  if (!rule || !(rule.ms > 0)) return null;
  const own = Number(task?.limitMs);
  return {
    ms: own > 0 ? own : rule.ms,
    factor: Number.isFinite(rule.factor) && rule.factor >= 0 ? rule.factor : 0,
  };
};

/**
 * The moment a task's billed time reached its limit, or null if it has not.
 *
 * Its sittings are laid end to end in the order they started, and the line
 * falls where their running total reaches the limit. A sitting still going
 * has no end yet, so the moment can be in the future: that is when it will
 * be over, and it is already true that time after it pays less.
 */
export const crossingAt = (sessions, limitMs) => {
  const segments = sessions
    .filter((s) => !s.deletedAt && !isIdle(s))
    .flatMap((s) => s.segments ?? [])
    .sort((a, b) => a.startedAt - b.startedAt);
  let total = 0;
  for (const seg of segments) {
    const length = seg.endedAt == null ? Infinity : Math.max(0, seg.endedAt - seg.startedAt);
    if (total + length >= limitMs) return seg.startedAt + (limitMs - total);
    total += length;
  }
  return null;
};

/**
 * What every money figure asks of a session: its rate, and from when its time
 * pays less.
 *
 * Returned as a function so that it fits every place a `rateOf` already went:
 * called, it is the rate a session is valued at, exactly as `rateFor` gives
 * it. `rateOf.terms(s)` is the limit the session's task is held to, with the
 * moment it was crossed (`at`, null while it has not been), and
 * `rateOf.limit(s)` the same only once it has — what `sessionCents` splits
 * at. Each task's line is worked out once, the first time it is asked for.
 */
export const pricer = (projects, sessions) => {
  const byId = new Map((projects ?? []).map((p) => [p.id, p]));
  const lines = new Map();
  const rateOf = (s) => {
    const project = byId.get(s.projectId);
    return project ? rateFor(project, s) : s.rate;
  };
  rateOf.terms = (s) => {
    if (!s?.taskId || isIdle(s)) return null;
    const key = `${s.projectId}|${s.taskId}`;
    if (!lines.has(key)) {
      const project = byId.get(s.projectId);
      const limit = project ? limitFor(project, findTask(project, s.taskId)) : null;
      lines.set(key, limit && {
        ...limit,
        at: crossingAt(
          (sessions ?? []).filter((x) => x.projectId === s.projectId && x.taskId === s.taskId),
          limit.ms),
      });
    }
    return lines.get(key);
  };
  rateOf.limit = (s) => {
    const terms = rateOf.terms(s);
    return terms && terms.at !== null ? terms : null;
  };
  return rateOf;
};

/**
 * How much of one task's billed time was over its limit, and at what share.
 *
 * What an hourly bonus on acceptance is priced from: an hour over the limit
 * pays its share of the bonus as it does of the rate. Null where the task has
 * no limit, or has not reached it.
 */
export const overLimitFor = (project, sessions, now) => {
  const price = pricer([project], sessions);
  const billed = sessions.filter((s) => !s.deletedAt && isBilled(s));
  const limit = billed.length ? price.limit(billed[0]) : null;
  if (!limit) return null;
  const ms = billed.reduce((total, s) => total + overLimitMs(s, -Infinity, Infinity, now, price), 0);
  return ms > 0 ? { ms, factor: limit.factor, limitMs: limit.ms } : null;
};

/**
 * What a sitting would come to if the ledger held it as given: a correction
 * not yet saved, or a block of time not yet added. It takes the place of the
 * session with its id, so its task's limit falls where it would.
 */
export const centsAsIf = (project, sessions, session, now) => {
  const others = (sessions ?? []).filter((s) => s.id !== session.id);
  const price = pricer(project ? [project] : [], [...others, session]);
  return sessionCents(session, -Infinity, Infinity, now, price);
};

/* ── changing the terms ───────────────────────────────────────────────────── */

/** How far back a change reaches. */
export const SCOPE = {
  /** Tasks already handed in keep what they were handed in under. */
  FORWARD: "forward",
  /** Everything on the project, the past included. */
  ALL: "all",
};

const editProject = (state, projectId, fn) => ({
  ...state,
  projects: state.projects.map((p) => (p.id === projectId ? fn(p) : p)),
});

/**
 * A new limit for a project's tasks, or none (`ms` null).
 *
 * From now on, it is added to the history at `now`, so a task handed in
 * before then still finds the entry it went in under. Everywhere, the history
 * becomes this one entry, in force from the start. A task's own limit is
 * left alone either way: it was set on purpose.
 */
export const setTaskLimit = (state, projectId, { ms, factor }, scope, now) =>
  editProject(state, projectId, (p) => {
    const entry = ms > 0
      ? { ms, factor: Number.isFinite(factor) && factor >= 0 ? factor : 0 }
      : { ms: null, factor: null };
    if (scope === SCOPE.ALL) {
      const next = { ...p, taskLimits: [{ from: null, ...entry }] };
      if (entry.ms === null) delete next.taskLimits;
      return next;
    }
    return { ...p, taskLimits: [...limitHistory(p), { from: now, ...entry }] };
  });

/** One task's own limit, in milliseconds, or null to follow the project's. */
export const setOwnLimit = (state, projectId, taskId, ms) =>
  editProject(state, projectId, (p) => ({
    ...p,
    tasks: (p.tasks ?? []).map((t) => {
      if (t.id !== taskId) return t;
      const next = { ...t, limitMs: ms };
      if (!(ms > 0)) delete next.limitMs;
      return next;
    }),
  }));

/**
 * A new hourly rate for a project.
 *
 * Every session carries the rate it was recorded at, and a change reaches
 * exactly the sessions it should by rewriting that. From now on, it reaches
 * the work of tasks still open — the platform prices a task when it is handed
 * in, so those are not past yet — along with whatever is recorded from here.
 * Everywhere, it reaches every session on the project. Work filed under no
 * task keeps its rate either way unless the change is to everything: it was
 * done at the rate it was recorded at, with no hand-in still to come.
 *
 * A task with a rate of its own is left alone: its sessions are valued at
 * that rate whatever they recorded. A task paid a share of the rate follows
 * the new one, which is what a share means.
 */
export const setProjectRate = (state, projectId, rate, scope) => {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project || !(rate > 0)) return state;
  const reaches = (s) => {
    if (s.projectId !== projectId || s.deletedAt) return false;
    const task = s.taskId ? findTask(project, s.taskId) : null;
    if (task?.rate != null) return false;
    if (scope === SCOPE.ALL) return true;
    return task !== null && taskState(task) === null;
  };
  return {
    ...editProject(state, projectId, (p) => ({ ...p, currentRate: rate })),
    sessions: state.sessions.map((s) => (reaches(s) && s.rate !== rate ? { ...s, rate } : s)),
  };
};
