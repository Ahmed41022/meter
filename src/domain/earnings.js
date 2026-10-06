/**
 * Money that is not an hour of work.
 *
 * Some work does not pay by the clock. A task can pay per accepted submission,
 * a month can end with a bonus, a platform can settle an adjustment. That money
 * is real and belongs in the totals, but it has NO duration — and the thing
 * this app is built on is that money comes from time, derived and never stored.
 *
 * So these are a separate record rather than a session with the hours left
 * blank. A session means "the meter watched this", and every figure the app
 * reports leans on that: elapsed time is recomputed from segments, money is
 * recomputed from rate times elapsed. A session carrying a stored amount and no
 * segments would be a lie in the one place the app cannot afford one, and every
 * reporting function would have to learn to skip it.
 *
 * Kept apart, the rule stays simple: sessions carry time and earn by the hour,
 * earnings carry money and no time, and any figure that divides money by hours
 * has to say which of the two it is dividing.
 */

import { earningsCents } from "./money.js";

/**
 * What kind of money it is. Presentational rather than structural — every kind
 * behaves identically in every total — but the distinction is what lets a
 * reader tell a $3,000 piece-rate settlement from a $30 bonus a year later.
 */
export const EARNING = {
  PIECE: "piece",       // paid per accepted item, not per hour
  BONUS: "bonus",       // a reward on top of the work
  ADJUSTMENT: "adjust", // a correction from whoever pays
};

/**
 * Whether money has actually landed.
 *
 * ABSENT MEANS SETTLED. Every session recorded before this existed counts
 * exactly as it always did, so nothing already stored changed meaning and there
 * is no migration. Only work that is genuinely waiting on someone else's
 * decision carries a status.
 *
 * Cancelled is kept rather than deleted. Work that was done and then rejected
 * is a fact about how the month went, and erasing it would leave the hours
 * sitting in the ledger with no explanation of where their money went.
 */
export const PAY = {
  PENDING: "pending",
  PAID: "paid",
  CANCELLED: "cancelled",
};

export const payStateOf = (record) => record?.status ?? PAY.PAID;
export const isPending = (record) => payStateOf(record) === PAY.PENDING;
export const isCancelled = (record) => payStateOf(record) === PAY.CANCELLED;
/** Money that counts as earned. Cancelled never does; pending is counted on its
 *  own line rather than in the headline, so it is not folded in here either. */
export const isSettled = (record) => payStateOf(record) === PAY.PAID;

/** A project whose work is only worth something once it is accepted. New
 *  sessions on one start out pending rather than counted. */
export const paysOnAcceptance = (project) => project?.paysOnAcceptance === true;

/**
 * What one accepted item pays, in whole currency units like `currentRate`.
 *
 * Absent means the project is not paid per item, which is what every project
 * written before this existed will say. A project can hold both this and an
 * hourly rate — some work pays by the hour and throws in per-item bonuses — so
 * neither field implies anything about the other.
 */
export const perTask = (project) => {
  const value = Number(project?.perTask);
  return Number.isFinite(value) && value > 0 ? value : null;
};

export const isPerTask = (project) => perTask(project) !== null;

/**
 * Paid per accepted item AND NOT by the hour.
 *
 * A project can be both: ten an hour for the time, seventy more when the item
 * is accepted. That one is hourly work with a per-item bonus, and it keeps
 * every hourly figure — the rate on its header, the minute rail, the money
 * accruing as the meter runs. Only work with no hourly rate at all should have
 * those hidden, which is what this distinguishes.
 */
export const isPieceOnly = (project) =>
  isPerTask(project) && !(Number(project?.currentRate) > 0);

/**
 * The EXTRA hourly rate an accepted task earns, on top of what the clock has
 * already paid. Not the total: a project at 80 with a bonus of 10 pays 90 an
 * hour for work that lands, and 80 for work that does not.
 *
 * This exists because the other shape of acceptance money — a flat amount per
 * item — is simply wrong for platforms that pay by the hour and then top up.
 * A flat 10 credits the same for a task that took twenty minutes and one that
 * took six hours, which is wrong in both directions at once.
 *
 * Absent means no hourly bonus, which is what every project written before
 * this existed says.
 */
export const bonusPerHour = (project) => {
  const value = Number(project?.bonusPerHour);
  return Number.isFinite(value) && value > 0 ? value : null;
};

export const REWARD = { PER_TASK: "perTask", PER_HOUR: "perHour" };

/**
 * Which acceptance reward a project pays, or null for neither.
 *
 * Exactly one, never both. A project holding a flat price AND an hourly bonus
 * would have two answers to "what does acceptance pay", and whichever this
 * picked would surprise somebody — the same reasoning that stops a task
 * holding both a rate and a percentage. The settings form is what keeps that
 * true on the way in, by always writing the other field null; this reads it
 * back, and prefers the hourly one so a project that somehow held both is
 * never silently priced by the model it is no longer using.
 */
export const rewardModel = (project) => {
  if (bonusPerHour(project) !== null) return REWARD.PER_HOUR;
  if (perTask(project) !== null) return REWARD.PER_TASK;
  return null;
};

export const hasReward = (project) => rewardModel(project) !== null;

/**
 * What one accepted item pays under a given task.
 *
 * A project's `perTask` is the default; a task's own `price` overrides it, the
 * same way a task rate overrides a session's snapshot. That is what lets one
 * project hold "1,500 per accepted task" and "300 per accepted CL" at once
 * instead of forcing two projects for one piece of work.
 */
export const priceFor = (project, task) => {
  // `!= null` before the number check, and >= 0 after it. A task priced at
  // zero is a real answer — unpaid onboarding on a paid project — and testing
  // truthiness would silently fall back to the project's price instead.
  if (task?.price != null) {
    const own = Number(task.price);
    if (Number.isFinite(own) && own >= 0) return own;
  }
  return perTask(project);
};

/** What `units` accepted items come to, in cents, under an optional task. Null
 *  where there is no price to multiply, rather than a confident zero. */
export const perTaskCents = (project, units, task = null) => {
  const each = priceFor(project, task);
  const n = Number(units);
  if (each === null || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(each * 100 * n);
};

/**
 * What acceptance pays for one task, in cents.
 *
 * `billedMs` is time actually worked under the task — billed only, never idle,
 * because idle minutes are not minutes anybody tops up. The flat model ignores
 * it: that one is priced per item and does not care how long it took.
 *
 * Null where there is nothing to record — no reward model, no price to
 * multiply, or no billed time under an hourly bonus — rather than a confident
 * zero, which would write a ledger line worth nothing.
 */
export const acceptanceCents = (project, task, billedMs = 0) => {
  const model = rewardModel(project);
  if (model === REWARD.PER_HOUR) {
    const cents = earningsCents(bonusPerHour(project), billedMs);
    return cents > 0 ? cents : null;
  }
  if (model === REWARD.PER_TASK) return perTaskCents(project, 1, task);
  return null;
};

/**
 * Which tasks an earning is for.
 *
 * A LIST, because one payment can cover many. A platform that pays a reward
 * for finishing fifty tasks writes one line, not fifty — and those fifty still
 * need to know they were paid for, or they read as work nobody credited. The
 * ordinary case is a batch of one.
 *
 * `taskId` is the singular field earlier builds wrote. It is read here and
 * never written again, so no record can hold two different answers to the same
 * question. An older build reading a newer ledger sees an earning with no
 * task, which is what it already showed for every earning it had.
 */
export const tasksOf = (earning) => {
  const many = earning?.taskIds;
  if (Array.isArray(many)) return many.filter(Boolean);
  return earning?.taskId ? [earning.taskId] : [];
};

export const namesTask = (earning, taskId) =>
  !!taskId && tasksOf(earning).includes(taskId);

export const liveEarnings = (state) => (state.earnings ?? []).filter((e) => !e.deletedAt);

export const earningsFor = (state, projectId) =>
  liveEarnings(state).filter((e) => e.projectId === projectId);

/** Every live earning that names this task, whether or not it names others. */
export const earningsForTask = (earnings, taskId) =>
  (earnings ?? []).filter((e) => !e.deletedAt && namesTask(e, taskId));

/**
 * Where one task stands with the money.
 *
 * `claimed` is the question that made this exist: has anything at all been
 * recorded for this task, or is it work that is done and not yet credited?
 * Past a few dozen tasks that is not a question you can answer by reading down
 * a column of amounts.
 *
 * Money is attributed only where a line names this task AND NOTHING ELSE. A
 * reward for fifty tasks is fifty tasks' worth of money and none of it is this
 * one's; dividing by fifty would print a per-task price nobody ever quoted. So
 * a shared line is counted and named rather than split.
 */
export const taskPay = (earnings, taskId) => {
  let settled = 0, pending = 0, shared = 0, cancelled = 0, claims = 0;
  for (const e of earningsForTask(earnings, taskId)) {
    if (isCancelled(e)) { cancelled += 1; continue; }
    claims += 1;
    if (tasksOf(e).length > 1) { shared += 1; continue; }
    if (isPending(e)) pending += e.cents;
    else settled += e.cents;
  }
  return { claimed: claims > 0, claims, settled, pending, shared, cancelled };
};

/** Inside a half-open window, by when the money was earned. A single instant,
 *  not a span — there are no hours to overlap. */
/** Everything a given stretch of tracked time earned. */
export const earningsForSession = (state, sessionId) =>
  sessionId ? liveEarnings(state).filter((e) => e.sessionId === sessionId) : [];

/**
 * What a session earned, from a list of earnings already to hand.
 *
 * Pending money counts — it was earned, it just has not landed. Cancelled
 * money does not, because it never will.
 */
export const earnedFrom = (earnings, sessionId) =>
  !sessionId ? 0 : (earnings ?? [])
    .filter((e) => e.sessionId === sessionId && !e.deletedAt && !isCancelled(e))
    .reduce((sum, e) => sum + e.cents, 0);

/** The same, reading the ledger. */
export const sessionEarnedCents = (state, sessionId) =>
  earnedFrom(liveEarnings(state), sessionId);

export const earningsIn = (earnings, from, to) =>
  earnings.filter((e) => e.at >= from && e.at < to);

export const addEarning = (state, project, { cents, kind = EARNING.BONUS, at, note = "", status, taskIds = [], units = null, sessionId = null }, now, id) => {
  const amount = Math.round(cents);
  if (!Number.isFinite(amount) || amount === 0) return state;
  // An earning has no span, only this instant, so without one it belongs to
  // no period: every total that should include it reads short, and a
  // spreadsheet dates it 1970. Absent still means now; anything that is not
  // a time is refused rather than stored.
  const when = at ?? now;
  if (!Number.isFinite(when)) return state;
  const tasks = (taskIds ?? []).filter(Boolean);
  return {
    ...state,
    earnings: [
      ...(state.earnings ?? []),
      {
        id,
        projectId: project.id,
        // Omitted rather than written empty, so absent keeps meaning what it
        // has always meant here: money this project earned that no one task
        // can be pointed at.
        ...(tasks.length ? { taskIds: tasks } : {}),
        kind,
        cents: amount,
        currency: project.currency,
        at: when,
        note: note.trim(),
        // How many accepted items this covers, when that is what it is. Kept
        // because "6 tasks at $500" is the fact; "$3,000" is the consequence.
        ...(units ? { units } : {}),
        // Which stretch of tracked time this money is for. One session can
        // produce several earnings — a task and a changelist are paid
        // separately for the same sitting — so the link points this way, from
        // the many to the one, and no list has to be kept in step.
        ...(sessionId ? { sessionId } : {}),
        ...(status ? { status } : {}),
        createdAt: now,
        deletedAt: null,
      },
    ],
  };
};

export const removeEarning = (state, id, now) => ({
  ...state,
  earnings: (state.earnings ?? []).map((e) => (e.id === id ? { ...e, deletedAt: now } : e)),
});

export const restoreEarning = (state, id) => ({
  ...state,
  earnings: (state.earnings ?? []).map((e) => (e.id === id ? { ...e, deletedAt: null } : e)),
});

/**
 * Re-files an earning under a different set of tasks.
 *
 * An empty list clears the link, which is the honest shape for money that no
 * one task can be pointed at — a monthly adjustment, a referral, a bonus for
 * being around. The singular `taskId` an older build may have written is
 * dropped here rather than left behind to disagree with the list.
 */
export const setEarningTasks = (state, id, taskIds) => ({
  ...state,
  earnings: (state.earnings ?? []).map((e) => {
    if (e.id !== id) return e;
    const next = { ...e };
    delete next.taskId;
    const tasks = (taskIds ?? []).filter(Boolean);
    if (tasks.length) next.taskIds = tasks;
    else delete next.taskIds;
    return next;
  }),
});

/**
 * Moves sessions and earnings between pay states, any number at once. `null`
 * clears back to settled, which is what absent has always meant.
 *
 * Plural because that is how work paid on acceptance actually gets approved —
 * a batch is marked off in one go, and doing it one record at a time would be
 * one write, one stamp and one upload per row.
 */
export const setPayStateMany = (state, ids, status) => {
  const wanted = new Set(ids);
  const move = (record) => (wanted.has(record.id) ? withStatus(record, status) : record);
  return {
    ...state,
    sessions: state.sessions.map(move),
    earnings: (state.earnings ?? []).map(move),
  };
};

export const setPayState = (state, id, status) => setPayStateMany(state, [id], status);

const withStatus = (record, status) => {
  const next = { ...record };
  if (status == null || status === PAY.PAID) delete next.status;
  else next.status = status;
  return next;
};

/** Per-currency totals for a list of earnings, split the same way money is
 *  split everywhere else: settled money and pending money never share a field,
 *  so no caller can add them by accident. */
export const earningTotals = (earnings) => {
  const settled = {};
  const pending = {};
  for (const e of earnings) {
    if (isCancelled(e)) continue;
    const into = isPending(e) ? pending : settled;
    into[e.currency] = (into[e.currency] || 0) + e.cents;
  }
  return { settled, pending };
};
