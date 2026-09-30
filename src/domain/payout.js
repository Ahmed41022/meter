/**
 * What is coming in, and when.
 *
 * Built from two facts the ledger already holds: the day a task changed state,
 * and the company's schedule. Nothing here is stored — a forecast that was
 * written down would be wrong the moment a schedule changed, and it would be
 * wrong silently.
 *
 * The two kinds of money ride different clocks, because they are earned by
 * different events:
 *
 *   HOURLY  earned by SUBMITTING. The work was done and delivered, so it is
 *           scheduled from the day it went in, whatever anyone later decides
 *           about it.
 *   REWARD  earned by ACCEPTANCE. It is scheduled from the day the answer came
 *           back, because until then there is no money to schedule and a date
 *           printed against it would be a promise nobody made.
 *
 * A reward still waiting on a decision therefore has no date at all, and is
 * reported apart rather than folded into a total that reads as expected
 * income. That distinction is the point of the panel: "owed on Wednesday" and
 * "owed if they say yes" are different kinds of hope.
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
import { isCancelled, isPending, tasksOf } from "./earnings.js";
import { nextPayout, payPeriodFor } from "./payPeriod.js";

const startOfDay = (t) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** What the clock earned under one task, at whatever rate each sitting is
 *  valued at. Idle time is left out, as it is from every earnings figure. */
const hourlyCents = (sessions, project, taskId, now) => sessions
  .filter((s) => !s.deletedAt && s.projectId === project.id && s.taskId === taskId && isBilled(s))
  .reduce((total, s) => total + earningsCents(rateFor(project, s), elapsedMs(s, now)), 0);

/** Sums into a keyed bucket, so several tasks landing on one payday read as
 *  one payment — which is what the platform will actually send. */
const into = (map, key, seed) => {
  if (!map.has(key)) map.set(key, { ...seed, cents: 0, items: 0 });
  return map.get(key);
};

/**
 * Money with a date, and money still waiting on somebody.
 *
 * `due` is sorted soonest first and carries one row per company, payday and
 * currency. `waiting` is one row per company and currency, with no date,
 * because there is nothing honest to put there.
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
      if (!status) continue;
      // Two dates, deliberately. The hours were earned by handing the work in;
      // the reward by the answer coming back. A task that sat three weeks in
      // review is paid for on two different days, and using one date for both
      // would move money into a period it was never part of.
      const wentIn = Number.isFinite(task.submittedAt) ? task.submittedAt : task.stateAt;
      const answered = task.stateAt;

      // The clock's money, scheduled from the day the work went in. Rejected
      // work counts: submitting is what earned it, and being turned down does
      // not claw back the hours.
      const worked = hourlyCents(sessions, project, task.id, now);
      if (worked > 0 && Number.isFinite(wentIn)) {
        const at = nextPayout(rule, wentIn);
        if (at !== null && at >= today) {
          const row = into(due, `${company}|${at}|${currency}`, { company, at, currency });
          row.cents += worked;
          row.items += 1;
        }
      }

      // The reward, scheduled from the day the answer came back — and only
      // then. One line per task, since a reward shared across many is not
      // this task's to schedule.
      for (const earning of earnings) {
        if (tasksOf(earning).length !== 1 || tasksOf(earning)[0] !== task.id) continue;
        if (isPending(earning)) {
          if (status === TASK.SUBMITTED) {
            const row = into(waiting, `${company}|${earning.currency}`,
                             { company, currency: earning.currency });
            row.cents += earning.cents;
            row.items += 1;
          }
          continue;
        }
        if (status !== TASK.ACCEPTED || !Number.isFinite(answered)) continue;
        const at = nextPayout(rule, answered);
        if (at === null || at < today) continue;
        const row = into(due, `${company}|${at}|${earning.currency}`,
                         { company, at, currency: earning.currency });
        row.cents += earning.cents;
        row.items += 1;
      }
    }
  }

  return {
    due: [...due.values()].sort((a, b) => a.at - b.at || a.company.localeCompare(b.company)),
    waiting: [...waiting.values()].sort((a, b) => b.cents - a.cents),
  };
};
