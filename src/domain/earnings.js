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
 * What one accepted item pays under a given task.
 *
 * A project's `perTask` is the default; a task's own `price` overrides it, the
 * same way a task rate overrides a session's snapshot. That is what lets one
 * project hold "1,500 per accepted task" and "300 per accepted CL" at once
 * instead of forcing two projects for one piece of work.
 */
export const priceFor = (project, task) => {
  const own = Number(task?.price);
  if (Number.isFinite(own) && own > 0) return own;
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

export const liveEarnings = (state) => (state.earnings ?? []).filter((e) => !e.deletedAt);

export const earningsFor = (state, projectId) =>
  liveEarnings(state).filter((e) => e.projectId === projectId);

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

export const addEarning = (state, project, { cents, kind = EARNING.BONUS, at, note = "", status, taskId = null, units = null, sessionId = null }, now, id) => {
  const amount = Math.round(cents);
  if (!Number.isFinite(amount) || amount === 0) return state;
  return {
    ...state,
    earnings: [
      ...(state.earnings ?? []),
      {
        id,
        projectId: project.id,
        taskId,
        kind,
        cents: amount,
        currency: project.currency,
        at: at ?? now,
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

/** Moves a session or an earning between pay states. `null` clears it back to
 *  settled, which is what absent has always meant. */
export const setPayState = (state, id, status) => ({
  ...state,
  sessions: state.sessions.map((s) => (s.id === id ? withStatus(s, status) : s)),
  earnings: (state.earnings ?? []).map((e) => (e.id === id ? withStatus(e, status) : e)),
});

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
