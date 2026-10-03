/**
 * Handing work in, and hearing back about it.
 *
 * This is the one operation that moves all three kinds of record at once — the
 * hours, the money and the task itself — so it lives here rather than in a
 * click handler, where the three steps could drift apart and leave a task
 * marked submitted whose sessions were never settled.
 *
 * The lifecycle it implements is the one the platforms actually use:
 *
 *   SUBMIT   the hours stop forever and are settled, because the work was
 *            done and delivered. The acceptance reward is written PENDING,
 *            because whether it lands is somebody else's decision and days
 *            away.
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
 * Reopening exists for the undo, and for the ordinary case of having ticked
 * the wrong row.
 */
import { elapsedMs } from "./time.js";
import { formatShortDuration } from "./money.js";
import { isBilled } from "./sessions.js";
import { findTask, taskLabel } from "./tasks.js";
import { TASK, isOpenTask, setTaskStateMany } from "./taskState.js";
import {
  EARNING, PAY, REWARD, acceptanceCents, addEarning, bonusPerHour, earningsForTask,
  isCancelled, paysOnAcceptance, rewardModel, setPayStateMany, tasksOf,
} from "./earnings.js";

/** Sessions filed under one task of one project, live ones only. */
const sessionsUnder = (state, projectId, taskId) =>
  (state.sessions ?? []).filter(
    (s) => !s.deletedAt && s.projectId === projectId && s.taskId === taskId,
  );

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

/** What the reward line should say it was for, so the ledger reads without
 *  having to be cross-referenced against the task list. */
const rewardNote = (project, taskId, billedMs) => {
  const label = taskLabel(project, taskId);
  if (rewardModel(project) !== REWARD.PER_HOUR) return `Accepted · ${label}`;
  const rate = bonusPerHour(project);
  return `Accepted · ${label} · ${formatShortDuration(billedMs)} at ${rate}/hr`;
};

/**
 * Hands a batch of tasks in.
 *
 * Tasks already in a state are skipped rather than recorded twice — ticking a
 * row that was submitted last week should not write it a second reward.
 *
 * Whether the hours are SETTLED here or merely frozen is the project's own
 * answer. Where it is paid as worked, handing the work in is the last event
 * that could matter and the money lands. Where it is paid once accepted,
 * nothing has been earned yet: the work is delivered and under review, which
 * is precisely what pending means, and calling it earned would book money
 * that a rejection is about to take straight back out again.
 *
 * The reward is a separate movement either way, and always pending — whether
 * a top-up lands is somebody else's decision and days away.
 *
 * `at` is the day the work actually went in; `now` is the clock. They are
 * separate because they answer different questions — `now` values the hours,
 * `at` decides which pay period the money falls in. Stamping the moment the
 * box was ticked put work delivered on a Saturday into the following week
 * whenever the box was ticked after the Monday cutoff: a whole payday late,
 * for a reason nothing on screen explained.
 */
export const submitTasks = (state, project, taskIds, now, nextId, at = now) => {
  const open = (taskIds ?? []).filter((id) => isOpenTask(findTask(project, id)));
  if (open.length === 0) return state;

  let next = state;
  const settling = [];

  for (const taskId of open) {
    const billedMs = billedMsForTask(next, project.id, taskId, now);
    // Every session under the task, whatever state it is in. The task's state
    // decides what its money is worth, so moving them all leaves no row behind
    // disagreeing with the rest of the batch.
    for (const s of sessionsUnder(next, project.id, taskId)) settling.push(s.id);

    const cents = acceptanceCents(project, findTask(project, taskId), billedMs);
    if (cents !== null) {
      next = addEarning(next, project, {
        cents,
        kind: rewardModel(project) === REWARD.PER_HOUR ? EARNING.BONUS : EARNING.PIECE,
        // Hours, not items: a count of one would read as one accepted item and
        // print a per-item price the platform never quoted.
        units: rewardModel(project) === REWARD.PER_HOUR ? null : 1,
        taskIds: [taskId],
        status: PAY.PENDING,
        note: rewardNote(project, taskId, billedMs),
      }, at, nextId());
    }
  }

  next = setPayStateMany(
    next, settling, paysOnAcceptance(project) ? PAY.PENDING : PAY.PAID,
  );
  return setTaskStateMany(next, project.id, open, TASK.SUBMITTED, at);
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
 * Settled money is left exactly where it is. Reopening says the work is not
 * finished after all, which is a statement about hours; what was already paid
 * for it is a separate fact, and quietly reversing a settled line would be
 * the ledger changing behind you.
 *
 * Hours a REJECTION cancelled are the exception, and they come back. An open
 * task is one being worked on, and leaving its sessions cancelled would show
 * live work as worth nothing — the rejection that zeroed them is precisely
 * what reopening undoes. They return to what a session on this project
 * starts as, which is pending where the project is paid on acceptance and
 * settled where it is not.
 *
 * The reward stays cancelled, because submitting again writes a fresh one;
 * restoring this one too would leave the task owed twice.
 */
export const reopenTasks = (state, project, taskIds, now) => {
  const undo = (taskIds ?? []).flatMap((taskId) =>
    sessionsUnder(state, project.id, taskId).filter(isCancelled).map((s) => s.id));
  const next = undo.length === 0 ? state : setPayStateMany(
    state, undo, paysOnAcceptance(project) ? PAY.PENDING : PAY.PAID,
  );
  return setTaskStateMany(next, project.id, taskIds, null, now);
};
