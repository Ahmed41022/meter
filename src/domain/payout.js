/**
 * What is coming in, and when.
 *
 * Built from two facts the ledger already holds: the day a task changed state,
 * and the company's schedule. Nothing here is stored — a forecast that was
 * written down would be wrong the moment a schedule changed, and it would be
 * wrong silently.
 *
 * Money belongs to the period the work was SUBMITTED in. That is the
 * platforms' own rule, stated plainly: a task straddling two pay periods
 * counts toward the week you handed it in, not the week somebody got round to
 * reviewing it. With one exception, which is the whole subtlety: a decision
 * arriving after that period's money has already gone out cannot be in it,
 * and rides the next run that can still carry it.
 *
 * Which means an ANSWERED task has a date and an unanswered one does not, and
 * the reason is worth being exact about. The rule turns on where the review
 * falls relative to the payday, so until the review has happened the date is
 * a fact about the future. Submitted work pays on its submission week only if
 * somebody gets to it in time; miss that and it is the week after, or the one
 * after that. Printing the submission week's payday against it would be
 * forecasting somebody else's diary.
 *
 * So the panel reports two different things:
 *
 *   DUE      answered work. Accepted, dated, and as close to a promise as
 *            this app is willing to make.
 *   WAITING  submitted work, hours and reward together, because both turn on
 *            the same decision and splitting them put half a task's money
 *            under a confident date and half under none. It carries the
 *            EARLIEST day it could arrive rather than no date at all: that
 *            much is known — nothing can pay before its own period closes —
 *            and "not before Friday" is worth more than silence.
 *
 * Rejected work appears in neither. It earns nothing, so there is nothing to
 * date.
 *
 * Anything whose payday has already passed is left out. It arrived, or it is a
 * conversation with the client rather than a forecast.
 */
import { elapsedMs } from "./time.js";
import { earningsCents } from "./money.js";
import { isBilled } from "./sessions.js";
import { isOffClock } from "./projects.js";
import { rateFor, tasksFor } from "./tasks.js";
import { TASK, taskState } from "./taskState.js";
import { isCancelled, tasksOf } from "./earnings.js";
import { nextPayout, payPeriodFor } from "./payPeriod.js";

const startOfDay = (t) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** What the clock earned under one task, at whatever rate each sitting is
 *  valued at. Idle time is left out, as it is from every earnings figure, and
 *  so is work a rejection cancelled — there is no payday for money that is
 *  never coming. */
const hourlyCents = (sessions, project, taskId, now) => sessions
  .filter((s) => !s.deletedAt && s.projectId === project.id && s.taskId === taskId
    && isBilled(s) && !isCancelled(s))
  .reduce((total, s) => total + earningsCents(rateFor(project, s), elapsedMs(s, now)), 0);

/**
 * Sums into a keyed bucket, so several tasks landing on one payday read as
 * one payment — which is what the platform will actually send.
 *
 * Tasks are counted as a set rather than tallied, because one task files its
 * hours and its reward separately and both land here. Adding one each time
 * would report a single task as two.
 */
const into = (map, key, seed) => {
  if (!map.has(key)) map.set(key, { ...seed, cents: 0, tasks: new Set() });
  return map.get(key);
};

/** The bucket as the rest of the app reads it: a count, not a set. */
const rows = (map) => [...map.values()]
  .map(({ tasks, ...row }) => ({ ...row, items: tasks.size }))
  .sort((a, b) => a.at - b.at || a.company.localeCompare(b.company));

/**
 * When an accepted reward arrives.
 *
 * The payday of the period the work was SUBMITTED in — unless that payday had
 * already come by the time the answer did, in which case the money could not
 * have been on it and goes out on the next run after the decision.
 *
 * What matters is the PAYDAY, not the period. A period closing on Monday and
 * paying on Wednesday is shut by Monday lunchtime, but the money has not gone
 * anywhere yet: an acceptance that afternoon still makes that Wednesday.
 * Comparing the two periods instead would push it a week out, which is the
 * same off-by-one-payday mistake in a different place.
 *
 * A decision landing on the payday itself waits for the next run. Processing
 * takes the day, so it might just make it — but a forecast that promises
 * money early is worse than one that is a week pessimistic once.
 */
const rewardPayday = (rule, wentIn, answered) => {
  const onSubmission = nextPayout(rule, wentIn);
  if (onSubmission === null) return nextPayout(rule, answered);
  return answered <= onSubmission ? onSubmission : nextPayout(rule, answered);
};

/**
 * Money with a date, and money still waiting on somebody.
 *
 * Both are sorted soonest first and carry one row per company, day and
 * currency. A `waiting` row's `at` is the earliest the money could arrive,
 * never a date it is expected on.
 */
export const upcomingPay = (state, now) => {
  const due = new Map();
  const waiting = new Map();
  const today = startOfDay(now);
  const sessions = state.sessions ?? [];
  const earnings = (state.earnings ?? []).filter((e) => !e.deletedAt && !isCancelled(e));

  for (const project of state.projects ?? []) {
    if (project.deletedAt || isOffClock(project)) continue;
    const rule = payPeriodFor(state, project);
    if (!rule) continue;
    const company = (project.company ?? "").trim();
    const currency = project.currency;

    for (const task of tasksFor(project)) {
      const status = taskState(task);
      if (status === null || status === TASK.CANCELLED) continue;
      const wentIn = Number.isFinite(task.submittedAt) ? task.submittedAt : task.stateAt;
      const answered = task.stateAt;
      // Submitted and unanswered: the earliest it could land, which is its own
      // period's payday. A review arriving after that pushes it further out,
      // and there is no telling today which it will be.
      const pendingReview = status === TASK.SUBMITTED;

      /**
       * One task's money goes to one place.
       *
       * While it waits on a review, the hours and the reward hang on the same
       * answer, so they belong in the same row under the same caveat. Once it
       * is answered they are both dated, and the whole point of dating them
       * from submission is that they land together.
       */
      const file = (cents, cur, at) => {
        if (cents <= 0 || at === null || at < today) return;
        const [map, key] = pendingReview
          ? [waiting, `${company}|${at}|${cur}`]
          : [due, `${company}|${at}|${cur}`];
        const row = into(map, key, { company, at, currency: cur });
        row.cents += cents;
        row.tasks.add(task.id);
      };

      if (Number.isFinite(wentIn)) {
        file(hourlyCents(sessions, project, task.id, now), currency,
             nextPayout(rule, wentIn));
      }

      // One line per task: a reward shared across many is not this task's to
      // schedule, and `tasksOf` length is what tells them apart.
      for (const earning of earnings) {
        if (tasksOf(earning).length !== 1 || tasksOf(earning)[0] !== task.id) continue;
        if (pendingReview) {
          file(earning.cents, earning.currency, nextPayout(rule, wentIn));
        } else if (status === TASK.ACCEPTED && Number.isFinite(answered)) {
          file(earning.cents, earning.currency,
               rewardPayday(rule, Number.isFinite(wentIn) ? wentIn : answered, answered));
        }
      }
    }
  }

  return { due: rows(due), waiting: rows(waiting) };
};
