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
 *   ACCEPT   the decision came back yes. The reward is paid.
 *   REJECT   it came back no. The reward is cancelled; the hourly money is
 *            NOT clawed back, because submitting is what earned it.
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
  isCancelled, isPending, rewardModel, setPayStateMany, tasksOf,
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
 * The hourly settle and the reward are deliberately separate movements: one
 * says the clock money has landed, the other that a top-up is owed. A project
 * with no reward model at all still submits, still freezes, and still settles
 * its hours; it simply writes no extra line.
 */
export const submitTasks = (state, project, taskIds, now, nextId) => {
  const open = (taskIds ?? []).filter((id) => isOpenTask(findTask(project, id)));
  if (open.length === 0) return state;

  let next = state;
  const settling = [];

  for (const taskId of open) {
    const billedMs = billedMsForTask(next, project.id, taskId, now);
    // Every session under the task, pending or not. Marking an already
    // settled one paid is a no-op, and asking first would cost a second pass.
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
      }, now, nextId());
    }
  }

  next = setPayStateMany(next, settling, PAY.PAID);
  return setTaskStateMany(next, project.id, open, TASK.SUBMITTED, now);
};

/**
 * The answer came back.
 *
 * `TASK.ACCEPTED` pays the reward, `TASK.CANCELLED` cancels it. Only lines
 * still waiting are moved: a reward already marked paid by hand stays paid,
 * and one already cancelled is not resurrected by a stray second click.
 */
export const answerTasks = (state, project, taskIds, answer, now) => {
  const ids = taskIds ?? [];
  if (ids.length === 0) return state;
  const earnings = state.earnings ?? [];
  const moving = [];

  for (const taskId of ids) {
    for (const e of soleRewardsFor(earnings, taskId)) {
      if (answer === TASK.ACCEPTED && isPending(e)) moving.push(e.id);
      if (answer === TASK.CANCELLED && !isCancelled(e)) moving.push(e.id);
    }
  }

  const next = setPayStateMany(
    state, moving, answer === TASK.ACCEPTED ? PAY.PAID : PAY.CANCELLED,
  );
  return setTaskStateMany(next, project.id, ids, answer, now);
};

/**
 * Puts tasks back to open so they take time again.
 *
 * The money is left exactly where it is. Reopening says the work is not
 * finished after all, which is a statement about hours; what was already paid
 * for it is a separate fact, and quietly reversing a settled line would be
 * the ledger changing behind you.
 */
export const reopenTasks = (state, project, taskIds, now) =>
  setTaskStateMany(state, project.id, taskIds, null, now);
