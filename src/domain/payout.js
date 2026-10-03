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
 * Which means an ANSWERED task has a date and an unanswered one does not. A
 * payout run covers the tasks accepted during a period, so the acceptance is
 * the event that puts money in a particular run; until somebody has reviewed
 * it, which run it makes is a fact about the future.
 *
 * So the panel reports two different things:
 *
 *   DUE      answered work, dated from the period its answer fell in, and as
 *            close to a promise as this app is willing to make.
 *   WAITING  submitted work, hours and reward together, because both turn on
 *            the same decision and splitting them put half a task's money
 *            under a confident date and half under none. It carries the
 *            EARLIEST day it could arrive rather than no date at all: an
 *            answer cannot come before now, so the period we are in is the
 *            soonest it could make, and "not before Friday" is worth more
 *            than silence.
 *
 * Rejected work appears in neither. It earns nothing, so there is nothing to
 * date.
 *
 * Each row carries the tasks behind it, so a figure can be opened and
 * accounted for rather than taken on trust.
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
  if (!map.has(key)) map.set(key, { ...seed, key, cents: 0, tasks: [] });
  return map.get(key);
};

/**
 * The buckets as the panel reads them, biggest task first inside each.
 *
 * The key is prefixed with which list it came from, because a dated row and a
 * not-before row can agree on company, day and currency — which is the common
 * case, not a corner one — and anything keying off it would then treat the
 * two as the same row.
 */
const rows = (map, kind) => [...map.values()]
  .map((row) => ({
    ...row,
    key: `${kind}|${row.key}`,
    items: row.tasks.length,
    tasks: [...row.tasks].sort((a, b) => b.cents - a.cents),
  }))
  .sort((a, b) => a.at - b.at || a.company.localeCompare(b.company));

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
      const pendingReview = status === TASK.SUBMITTED;

      /*
       * The payday is the one for the period the ANSWER fell in.
       *
       * Not the period the work was handed in during, which is the mistake
       * this replaces. A task submitted on the Sunday and accepted on the
       * Wednesday missed its own period: that period shut on the Monday, and
       * the run it pays belongs to the batch that was already closed. Dating
       * it from submission put the money on a payday that had been and gone,
       * so it dropped off this panel as though it had already arrived.
       *
       * Nobody has answered a submitted task yet, so there is no such period
       * to find. The earliest one there could be is the period we are in now,
       * which makes its payday a floor — the soonest the money could land,
       * never a date it is expected on.
       */
      const at = pendingReview
        ? nextPayout(rule, now)
        : nextPayout(rule, task.stateAt);
      if (at === null || at < today) continue;

      /*
       * What this task is owed, by currency, because a reward recorded in one
       * currency cannot be added to hours in another. Hours and reward
       * together: under a single per-accepted payment they are one piece of
       * money that happens to be written down in two places, and they land on
       * the same day for the same reason.
       */
      const owed = new Map();
      const add = (cur, cents) => {
        if (cents > 0) owed.set(cur, (owed.get(cur) ?? 0) + cents);
      };
      add(currency, hourlyCents(sessions, project, task.id, now));
      // A reward shared across many tasks is not this one's to schedule, and
      // the number of tasks it names is what tells them apart.
      for (const earning of earnings) {
        if (tasksOf(earning).length !== 1 || tasksOf(earning)[0] !== task.id) continue;
        add(earning.currency, earning.cents);
      }

      for (const [cur, cents] of owed) {
        const row = into(pendingReview ? waiting : due, `${company}|${at}|${cur}`,
                         { company, at, currency: cur });
        row.cents += cents;
        row.tasks.push({
          taskId: task.id, label: task.label, project: project.name, cents, status,
        });
      }
    }
  }

  return { due: rows(due, "due"), waiting: rows(waiting, "wait") };
};
