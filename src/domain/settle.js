/**
 * Handing work in, and hearing back about it.
 *
 * This is the one operation that moves all three kinds of record at once — the
 * hours, the money and the task itself — so it lives here rather than in a
 * click handler, where the three steps could drift apart and leave a task
 * marked submitted whose sessions never moved with it.
 *
 * The lifecycle it implements is the one the platforms actually use:
 *
 *   SUBMIT   the hours stop forever, because the work was done and
 *            delivered. Where the project pays as worked they count as earned
 *            from here; where it pays once accepted they stay pending. The
 *            acceptance reward is written PENDING, because whether it lands is
 *            somebody else's decision and days away.
 *   ACCEPT   the decision came back yes. Everything the task earned is paid.
 *   REJECT   it came back no, and so nothing was earned: the reward is
 *            cancelled, and so are the hours.
 *
 * Rejection taking the hours with it is the platforms' rule rather than a
 * guess. Payment is per ACCEPTED task, and since the old split was
 * consolidated into one amount there is no half of it left to be paid out of:
 * work that does not pass review earns nothing. The hours themselves stay on
 * record either way — they happened, and they still count toward every time
 * figure. It is only the money that goes.
 *
 * That makes the answer the one destructive act in the app, so the task's
 * STATE is authoritative over its money and every transition is reversible.
 * Accepting a task that was rejected restores what the rejection took, rather
 * than leaving the hours paid and the reward dead; one wrong click on a batch
 * of fifty must not be able to zero a week's pay with no way back.
 *
 * A task has ONE acceptance reward, however many times it goes round. Handing
 * a task in again finds the reward it already has and puts that back to
 * pending, re-priced from the hours it has now, instead of writing a second
 * one beside it — two lines for one task is the task paid twice the moment it
 * is accepted.
 *
 * Reopening exists for the undo, and for the ordinary case of having ticked
 * the wrong row. Reopening an ANSWERED task takes back what the answer did:
 * its hours and its reward are pending until it is accepted again.
 */
import { elapsedMs } from "./time.js";
import { formatShortDuration } from "./money.js";
import { isBilled } from "./sessions.js";
import { findTask, taskLabel } from "./tasks.js";
import {
  TASK, isAccepted, isOpenTask, isRejected, setTaskStateMany,
} from "./taskState.js";
import {
  EARNING, PAY, REWARD, acceptanceCents, addEarning, bonusPerHour, earningsForTask,
  paysOnAcceptance, rewardModel, setPayStateMany, tasksOf,
} from "./earnings.js";

/** Sessions filed under one task of one project, live ones only. */
const sessionsUnder = (state, projectId, taskId) =>
  (state.sessions ?? []).filter(
    (s) => !s.deletedAt && s.projectId === projectId && s.taskId === taskId,
  );

/**
 * The project as the ledger holds it now.
 *
 * Callers pass the project they have to hand, which can be a click behind the
 * ledger — and where a task stands is what decides what may happen to its
 * money, so that is read from the ledger itself. A project the ledger does
 * not hold is taken as given.
 */
const liveProject = (state, project) =>
  (state.projects ?? []).find((p) => p.id === project?.id) ?? project;

/** Billed time recorded under a task. Idle is left out: idle minutes are not
 *  minutes anybody tops up, and they have never reached an earnings figure. */
export const billedMsForTask = (state, projectId, taskId, now) =>
  sessionsUnder(state, projectId, taskId)
    .filter(isBilled)
    .reduce((total, s) => total + elapsedMs(s, now), 0);

/**
 * Reward lines that belong to exactly ONE task.
 *
 * A reward covering fifty tasks is fifty tasks' worth of money, and accepting
 * one of them must not settle the other forty-nine. So a shared line is left
 * alone here for the same reason `taskPay` refuses to divide it.
 */
const soleRewardsFor = (earnings, taskId) =>
  earningsForTask(earnings, taskId).filter((e) => tasksOf(e).length === 1);

/**
 * Whether a line is money the task EARNED, as opposed to a correction filed
 * against it. A clawback recorded against one task is not that task's
 * acceptance reward, and must not stand in for it.
 */
const isReward = (earning) => earning.kind !== EARNING.ADJUSTMENT;

/**
 * How every reward line this file writes begins, which is what tells one
 * apart from a line somebody typed. Only these are ever re-priced: an amount
 * you entered yourself is a fact you were told, not arithmetic to redo.
 */
const WRITTEN = "Accepted · ";
const writtenHere = (earning) => String(earning?.note ?? "").startsWith(WRITTEN);

/** What the reward line should say it was for, so the ledger reads without
 *  having to be cross-referenced against the task list. */
const rewardNote = (project, taskId, billedMs) => {
  const label = taskLabel(project, taskId);
  if (rewardModel(project) !== REWARD.PER_HOUR) return `${WRITTEN}${label}`;
  const rate = bonusPerHour(project);
  return `${WRITTEN}${label} · ${formatShortDuration(billedMs)} at ${rate}/hr`;
};

/**
 * What acceptance should pay for one task right now, as the fields of its
 * reward line, or null where there is nothing to record — no reward model, no
 * price, or no billed time under an hourly bonus.
 */
const rewardLine = (project, taskId, billedMs) => {
  const cents = acceptanceCents(project, findTask(project, taskId), billedMs);
  // Zero as well as null: a line worth nothing is not written, here or by
  // `addEarning`, which refuses one.
  if (!cents) return null;
  const hourly = rewardModel(project) === REWARD.PER_HOUR;
  return {
    cents,
    kind: hourly ? EARNING.BONUS : EARNING.PIECE,
    // Hours, not items: a count of one would read as one accepted item and
    // print a per-item price the platform never quoted.
    units: hourly ? null : 1,
    note: rewardNote(project, taskId, billedMs),
  };
};

/**
 * The reward a task already has, brought up to date for a second hand-in.
 *
 * The hours may have changed since it was written — that is usually why the
 * task was reopened — so the line written here is re-priced and re-dated the
 * way a fresh one would be. Where the price now comes to nothing the line
 * goes, because a fresh hand-in would not write one.
 *
 * Only one written line is kept. A ledger can already hold two for one task,
 * from builds that wrote a fresh line on every hand-in, and keeping both
 * would pay the task twice; the others are deleted the ordinary way, with a
 * tombstone. Lines somebody typed are left exactly as they are.
 */
const repriceReward = (state, project, taskId, billedMs, own, now, at) => {
  const [keep, ...extra] = own.filter(writtenHere);
  if (!keep) return state;
  const line = rewardLine(project, taskId, billedMs);
  const gone = new Set(extra.map((e) => e.id));
  if (!line) gone.add(keep.id);
  return {
    ...state,
    earnings: (state.earnings ?? []).map((e) => {
      if (gone.has(e.id)) return { ...e, deletedAt: now };
      if (e.id !== keep.id) return e;
      const fresh = { ...e, cents: line.cents, kind: line.kind, note: line.note, at };
      if (line.units) fresh.units = line.units;
      else delete fresh.units;
      return fresh;
    }),
  };
};

/**
 * Hands a batch of tasks in.
 *
 * Tasks already in a state are skipped rather than recorded twice — ticking a
 * row that was submitted last week should not write it a second reward.
 *
 * Whether the hours count as earned here or merely freeze is the project's
 * own answer. Where it is paid as worked, handing the work in is what the
 * money waits for, and it lands — until a rejection, which takes it back.
 * Where it is paid once accepted, nothing has been earned yet: the work is
 * delivered and under review, which is precisely what pending means, and
 * calling it earned would book money that a rejection is about to take
 * straight back out again.
 *
 * The reward is a separate movement either way, and always pending — whether
 * a top-up lands is somebody else's decision and days away. A task that
 * already has a reward of its own (it was handed in before, and reopened)
 * gets no second one: what it has goes back to pending, and the line written
 * here is re-priced. A reward somebody recorded against the task by hand
 * counts as its reward too, and keeps the amount it was given; an adjustment
 * does not count, and is left where it is.
 *
 * `at` is the day the work actually went in; `now` is the clock. They are
 * separate because they answer different questions — `now` values the hours,
 * `at` dates the hand-in. Stamping the moment the box was ticked put work
 * delivered on a Saturday into the following week whenever the box was ticked
 * after the Monday cutoff, for a reason nothing on screen explained.
 */
export const submitTasks = (state, project, taskIds, now, nextId, at = now) => {
  const owner = liveProject(state, project);
  const open = (taskIds ?? []).filter((id) => isOpenTask(findTask(owner, id)));
  if (open.length === 0) return state;

  let next = state;
  const settling = [];
  const rewards = [];

  for (const taskId of open) {
    const billedMs = billedMsForTask(next, owner.id, taskId, now);
    // Every session under the task, whatever state it is in. The task's state
    // decides what its money is worth, so moving them all leaves no row behind
    // disagreeing with the rest of the batch.
    for (const s of sessionsUnder(next, owner.id, taskId)) settling.push(s.id);

    const own = soleRewardsFor(next.earnings, taskId).filter(isReward);
    if (own.length > 0) {
      for (const e of own) rewards.push(e.id);
      next = repriceReward(next, owner, taskId, billedMs, own, now, at);
      continue;
    }
    const line = rewardLine(owner, taskId, billedMs);
    if (line) {
      next = addEarning(next, owner, {
        ...line, taskIds: [taskId], status: PAY.PENDING,
      }, at, nextId());
    }
  }

  next = setPayStateMany(
    next, settling, paysOnAcceptance(owner) ? PAY.PENDING : PAY.PAID,
  );
  next = setPayStateMany(next, rewards, PAY.PENDING);
  return setTaskStateMany(next, owner.id, open, TASK.SUBMITTED, at);
};

/**
 * The answer came back.
 *
 * Both the reward and the hours move with it, in the same direction, because
 * under a single per-accepted payment they are one piece of money that
 * happens to be recorded in two places. Yes pays them; no cancels them.
 *
 * Everything the task owns moves, including records already in the state
 * being asked for — which is what makes a wrong answer undoable. Re-answering
 * is idempotent rather than cumulative, so a second click changes nothing and
 * the opposite click puts it all back.
 *
 * A reward shared across many tasks is the one exception, as always: it is
 * not this task's to settle or to cancel, and `soleRewardsFor` leaves it be.
 */
export const answerTasks = (state, project, taskIds, answer, at) => {
  const ids = taskIds ?? [];
  if (ids.length === 0) return state;
  const earnings = state.earnings ?? [];
  const moving = [];

  for (const taskId of ids) {
    for (const e of soleRewardsFor(earnings, taskId)) moving.push(e.id);
    for (const s of sessionsUnder(state, project.id, taskId)) moving.push(s.id);
  }

  const next = setPayStateMany(
    state, moving, answer === TASK.ACCEPTED ? PAY.PAID : PAY.CANCELLED,
  );
  return setTaskStateMany(next, project.id, ids, answer, at);
};

/**
 * Puts tasks back to open so they take time again.
 *
 * Reopening a task that was ANSWERED takes back what the answer did. An
 * acceptance paid the hours and the reward because the work had been taken,
 * and a rejection cancelled them because it had not; a task that is open
 * again has no answer, so neither stands. Its sessions and its own reward go
 * back to pending — owed, not earned — and stay there until it is accepted
 * again. Reopening an accepted task by mistake therefore subtracts what the
 * acceptance added, rather than leaving that money counted against work that
 * is officially unfinished.
 *
 * The reward is kept, not cancelled or dropped: handing the task in again
 * finds it and re-prices it rather than writing a second one, so the task is
 * never owed twice.
 *
 * A task that was only handed in has had no answer to take back. Its money is
 * left exactly where submitting put it.
 *
 * A reward shared across many tasks is not this task's to withdraw, the same
 * as it is not this task's to settle.
 */
export const reopenTasks = (state, project, taskIds, now) => {
  const ids = taskIds ?? [];
  const owner = liveProject(state, project);
  const withdrawn = [];
  for (const taskId of ids) {
    const task = findTask(owner, taskId);
    if (!isAccepted(task) && !isRejected(task)) continue;
    for (const s of sessionsUnder(state, owner.id, taskId)) withdrawn.push(s.id);
    for (const e of soleRewardsFor(state.earnings, taskId)) withdrawn.push(e.id);
  }
  const next = withdrawn.length === 0 ? state : setPayStateMany(state, withdrawn, PAY.PENDING);
  return setTaskStateMany(next, owner.id, ids, null, now);
};
