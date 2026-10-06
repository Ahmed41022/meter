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
import { fold, isOffClock } from "./projects.js";
import { rateFor, tasksFor } from "./tasks.js";
import { TASK, taskState } from "./taskState.js";
import { isCancelled, paysOnAcceptance, tasksOf } from "./earnings.js";
import { dayOnClock, payPeriodFor, paydayFor } from "./payPeriod.js";

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
 * The buckets as the panel reads them, biggest line first inside each.
 *
 * The key is prefixed with which list it came from, because a dated row and a
 * not-before row can agree on company, day and currency — which is the common
 * case, not a corner one — and anything keying off it would then treat the
 * two as the same row.
 *
 * `items` counts tasks and `rewards` the shared rewards beside them: a reward
 * covering six tasks is one payment, and counting it as a task, or as six,
 * would misreport what the row is made of.
 */
const rows = (map, kind) => [...map.values()]
  .map((row) => ({
    ...row,
    key: `${kind}|${row.key}`,
    items: row.tasks.filter((line) => line.kind === "task").length,
    rewards: row.tasks.filter((line) => line.kind === "reward").length,
    tasks: [...row.tasks].sort((a, b) => b.cents - a.cents),
  }))
  .sort((a, b) => a.at - b.at || a.company.localeCompare(b.company));

/**
 * When a task got as far as its money waits for, or null while it has not:
 * accepted, where the project pays once accepted; handed in, where it pays as
 * worked. An accepted task was handed in too, whether or not it was ever
 * marked so — answering stamps the hand-in where there was none.
 */
const reachedAt = (project, task) => {
  const status = taskState(task);
  if (paysOnAcceptance(project)) {
    return status === TASK.ACCEPTED && Number.isFinite(task.stateAt) ? task.stateAt : null;
  }
  return (status === TASK.SUBMITTED || status === TASK.ACCEPTED)
    && Number.isFinite(task.submittedAt) ? task.submittedAt : null;
};

/**
 * Money with a date, and money still waiting on somebody.
 *
 * Both are sorted soonest first and carry one row per company, day and
 * currency. A row's `date` is its payday as the client's own clock names it
 * ("2026-10-07"), which is what to print; `at` is that day's midnight on the
 * same clock, for ordering only. A `waiting` row's date is the earliest the
 * money could arrive, never a date it is expected on.
 */
export const upcomingPay = (state, now) => {
  const due = new Map();
  const waiting = new Map();
  const sessions = state.sessions ?? [];
  // Lines naming one task, by that task; lines naming several, by project.
  // The number of tasks a line names is what tells a task's own reward from
  // one shared across a batch, and the two are dated differently.
  const sole = new Map();
  const shared = new Map();
  for (const earning of state.earnings ?? []) {
    if (earning.deletedAt || isCancelled(earning)) continue;
    const named = tasksOf(earning);
    if (named.length === 1) {
      if (!sole.has(named[0])) sole.set(named[0], []);
      sole.get(named[0]).push(earning);
    } else if (named.length > 1) {
      if (!shared.has(earning.projectId)) shared.set(earning.projectId, []);
      shared.get(earning.projectId).push(earning);
    }
  }

  /*
   * One client however its name was typed. The schedule is already found by
   * the folded name — "Northwind" and "northwind " share one payday — so rows
   * keyed by the spelling split one payment into two lines on the same day.
   * Rows are keyed by the folded name and show the first spelling met.
   */
  const spelling = new Map();

  for (const project of state.projects ?? []) {
    if (project.deletedAt || isOffClock(project)) continue;
    const rule = payPeriodFor(state, project);
    if (!rule) continue;
    const named = (project.company ?? "").trim();
    const client = fold(named);
    if (!spelling.has(client)) spelling.set(client, named);
    const company = spelling.get(client);
    const currency = project.currency;
    // Today on the client's clock, which is the one its paydays are named on.
    // This device's clock disagrees for hours either side of midnight.
    const today = dayOnClock(rule, now);

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
      const pay = paydayFor(rule, pendingReview ? now : task.stateAt);
      if (pay === null || pay.date < today) continue;

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
      // Only lines naming this task alone. A reward shared across many tasks
      // is not this one's to date, and is dated on its own below.
      for (const earning of sole.get(task.id) ?? []) add(earning.currency, earning.cents);

      for (const [cur, cents] of owed) {
        const row = into(pendingReview ? waiting : due, `${client}|${pay.date}|${cur}`,
                         { company, at: pay.at, date: pay.date, currency: cur });
        row.cents += cents;
        row.tasks.push({
          key: `task:${task.id}`, kind: "task",
          taskId: task.id, label: task.label, project: project.name, cents, status,
        });
      }
    }

    /*
     * A reward shared across several tasks: "finish six and we pay you X".
     *
     * It is paid in the run for the period its LAST task got there — the
     * latest acceptance where the project pays once accepted, the latest
     * hand-in where it pays as worked — because that is when it was earned.
     * A rejected task is left out of the reckoning: it will never get there,
     * and the reward is still owed for the rest. Until every other task has
     * got there it has no date, only the same floor as work under review.
     * Ids naming no task this project still has are left out the same way.
     * A cancelled reward is not coming at all, and was dropped above; and,
     * as with a task's own lines, only money coming in is forecast.
     */
    for (const earning of shared.get(project.id) ?? []) {
      if (!(earning.cents > 0)) continue;
      const counted = tasksOf(earning)
        .map((id) => tasksFor(project).find((t) => t.id === id))
        .filter((task) => task && taskState(task) !== TASK.CANCELLED);
      if (counted.length === 0) continue;
      const times = counted.map((task) => reachedAt(project, task));
      const earned = times.every((t) => t !== null);
      const pay = paydayFor(rule, earned ? Math.max(...times) : now);
      if (pay === null || pay.date < today) continue;

      const row = into(earned ? due : waiting, `${client}|${pay.date}|${earning.currency}`,
                       { company, at: pay.at, date: pay.date, currency: earning.currency });
      row.cents += earning.cents;
      row.tasks.push({
        key: `reward:${earning.id}`, kind: "reward",
        label: earning.note || "Reward", covers: tasksOf(earning).length,
        project: project.name, cents: earning.cents,
      });
    }
  }

  return { due: rows(due, "due"), waiting: rows(waiting, "wait") };
};
