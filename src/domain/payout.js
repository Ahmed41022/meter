/**
 * What is coming in, and when.
 *
 * Built from two facts the ledger already holds: when a task was handed in or
 * answered, and the company's schedule. Nothing here is stored — a forecast
 * that was written down would be wrong the moment a schedule changed, and it
 * would be wrong silently.
 *
 * Which moment puts a task's money in a run depends on how its project pays,
 * and it carries the hours and the task's own reward together.
 *
 *   Paid once accepted: the ANSWER. A payout run covers the tasks accepted
 *   during a period, so a task handed in on the Sunday and accepted on the
 *   Wednesday missed the period that shut on the Monday, and rides the next
 *   run. The day it was handed in decides nothing about its own payday.
 *
 *   Paid as worked: the HAND-IN. There is no answer to wait for: the work is
 *   paid in the run for the period it was handed in, answered or not, and a
 *   rejection later takes it off the list along with the money.
 *
 * So the panel reports two different things:
 *
 *   DUE      work with a date: answered, where the project pays once
 *            accepted; handed in, where it pays as worked. As close to a
 *            promise as this app is willing to make.
 *   WAITING  work handed in on a project paid once accepted, hours and reward
 *            together, because both turn on the same decision and splitting
 *            them put half a task's money under a confident date and half
 *            under none. It carries the EARLIEST day it could arrive rather
 *            than no date at all: an answer cannot come before now, so the
 *            period we are in is the soonest it could make, and "not before
 *            Friday" is worth more than silence.
 *
 * A reward shared across several tasks is one payment, and is paid in the run
 * for the period its LAST task got there: the latest acceptance where the
 * project pays once accepted, the latest hand-in where it pays as worked.
 * Until the rest have all got there it waits, like unreviewed work. Rejected
 * tasks are left out of that reckoning.
 *
 * Money naming no task at all — a bonus for being around, a referral, a
 * correction — is dated by when it was ADDED: it rides the next payday after
 * that moment, as a task handed in then would. It has no task whose answer
 * could move it, so nothing else is asked. A person can say otherwise, with a
 * payday of their own choosing, and a payday is always a DATE ("2026-11-25"),
 * never "the next run": two code paths computing the same vague word is how
 * a picker once put two different choices on one day. Money marked received
 * has already landed and is not forecast; a task's own money and a shared
 * reward honour both of those too, so a bonus moved to another payday is on
 * that payday whether or not it names a task. Where a company has no
 * schedule there is nothing to date, and none of this applies: the money
 * simply counts in the earnings.
 *
 * Rejected work appears nowhere. It earns nothing, so there is nothing to
 * date — and a cancelled reward is not coming either.
 *
 * A payday is a DATE on the client's own clock, carried as one all the way to
 * the screen, and it has passed once that clock has moved past it; read on
 * this device's clock it can land on the day before. Rows are one per client,
 * day and currency, a client being its folded name, so "Northwind" and
 * "northwind" are the one payment they are.
 *
 * Each row carries what makes it up — its tasks, and any shared reward — so a
 * figure can be opened and accounted for rather than taken on trust. A task's
 * money is spread over a line for each KIND of it: what the clock earned, what
 * it was paid per accepted item, its bonuses, its adjustments. A bonus is a
 * different thing from an hour, and "where did that $40 come from" is the
 * question an opened row is there to answer. The split is only how the same
 * figure is shown: lines add up to the row's cents exactly, and nothing about
 * when the money arrives depends on it.
 *
 * A payment is a row, and what the owner has said about one is kept in
 * `payouts` (see payouts.js): that it was paid, which takes it off the list, or
 * that it moved to another date. A dated row whose day has passed with no word
 * is OVERDUE and listed as such, rather than dropped to look like it arrived.
 * Money still waiting on a review has no date to be late for, and a waiting
 * row whose floor has passed is left out as it always was.
 *
 * A single LINE can be marked too, on the record it is made of (paylines.js):
 * an earning's `received` and `payday`, as above, and for a task's hours the
 * task's own `hoursReceived` and `hoursPayday`. Hours moved that way leave the
 * task's other money on the task's payday. So that marking can find its
 * records, a task's line names the earnings it adds up (`earningIds`), and a
 * shared reward or task-less line the one it is (`earningId`).
 */
import { isBilled, sessionCents } from "./sessions.js";
import { fold, isOffClock } from "./projects.js";
import { tasksFor } from "./tasks.js";
import { pricer } from "./terms.js";
import { TASK, taskState } from "./taskState.js";
import { EARNING, isCancelled, isPending, paysOnAcceptance, tasksOf } from "./earnings.js";
import { OUTCOME, answersByPayment, payoutKey } from "./payouts.js";
import { dayOnClock, isDay, payPeriodFor, paydayFor, paydayOn } from "./payPeriod.js";

/** What the clock earned under one task, at whatever rate each sitting is
 *  valued at, time over a limit at its share. Idle time is left out, as it
 *  is from every earnings figure, and so is work a rejection cancelled —
 *  there is no payday for money that is never coming. */
const hourlyCents = (byTask, project, taskId, now) => {
  const mine = byTask.get(`${project.id}|${taskId}`) ?? [];
  const price = pricer([project], mine);
  return mine
    .filter((s) => isBilled(s) && !isCancelled(s))
    .reduce((total, s) => total + sessionCents(s, -Infinity, Infinity, now, price), 0);
};

/**
 * Sums into a keyed bucket, so several tasks landing on one payday read as
 * one payment — which is what the platform will actually send.
 *
 * A task's money is added up by kind before it gets here and arrives as one
 * line per kind and currency, so however many records it is written on, a
 * kind is one line and the task is still one task.
 */
const into = (map, key, seed) => {
  if (!map.has(key)) map.set(key, { ...seed, key, cents: 0, tasks: [] });
  return map.get(key);
};

/** Where a task's own lines sit among themselves: the clock first, then the
 *  kinds of earning in the order Earnings lists them, anything else last. */
const PARTS = ["hours", EARNING.PIECE, EARNING.BONUS, EARNING.ADJUSTMENT];
const partRank = (part) => {
  const at = PARTS.indexOf(part);
  return at === -1 ? PARTS.length : at;
};

/**
 * The buckets as the panel reads them.
 *
 * Inside a row, a task's lines stay TOGETHER, and the groups run biggest
 * first — a task by everything it is owed, a shared reward by its own amount.
 * Sorting every line by its own size would scatter one task's hours and
 * bonus between other tasks' lines, and the point of opening a row is to read
 * a task's money as one thing. Within a task the order is fixed, hours then
 * item, bonus, adjustment, so the same task reads the same way every time.
 *
 * The key is prefixed with which list it came from, because a dated row and a
 * not-before row can agree on company, day and currency — which is the common
 * case, not a corner one — and anything keying off it would then treat the
 * two as the same row.
 *
 * `items` counts tasks and `rewards` the shared rewards beside them: a reward
 * covering six tasks is one payment, and counting it as a task, or as six,
 * would misreport what the row is made of. A task with three kinds of money
 * is three lines and one item. Money named for no task is `extras`, a count
 * of its own, because it is neither.
 */
const rows = (map, kind) => [...map.values()]
  .map((row) => {
    const group = (line) => (line.kind === "task" ? `task:${line.taskId}` : line.key);
    const worth = new Map();
    for (const line of row.tasks) worth.set(group(line), (worth.get(group(line)) ?? 0) + line.cents);
    return {
      ...row,
      key: `${kind}|${row.key}`,
      items: new Set(row.tasks.filter((line) => line.kind === "task").map((line) => line.taskId)).size,
      rewards: row.tasks.filter((line) => line.kind === "reward").length,
      extras: row.tasks.filter((line) => line.kind === "extra").length,
      tasks: [...row.tasks].sort((a, b) =>
        worth.get(group(b)) - worth.get(group(a))
        || (group(a) < group(b) ? -1 : group(a) > group(b) ? 1 : 0)
        || partRank(a.part) - partRank(b.part)),
    };
  })
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
  /*
   * Live sittings by project and task, gathered in one pass. Now that a past
   * payday is listed as overdue rather than skipped, every task in the ledger
   * is priced on every call, and searching the whole session list once per
   * task made that a pause of most of a second on a ledger a few years deep.
   */
  const byTask = new Map();
  for (const s of state.sessions ?? []) {
    if (s.deletedAt) continue;
    const key = `${s.projectId}|${s.taskId}`;
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key).push(s);
  }
  // Lines naming one task, by that task; lines naming several, by project;
  // lines with a date of their own, or naming nothing, by project too. The
  // number of tasks a line names is what tells a task's own reward from one
  // shared across a batch, and the two are dated differently.
  const sole = new Map();
  const shared = new Map();
  const loose = new Map();
  const file = (map, key, earning) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(earning);
  };
  for (const earning of state.earnings ?? []) {
    if (earning.deletedAt || isCancelled(earning) || earning.received === true) continue;
    const named = tasksOf(earning);
    if (named.length === 0) {
      if (earning.cents > 0) file(loose, earning.projectId, earning);
    } else if (named.length === 1) {
      // Moved to a payday by hand, it leaves its task and stands on its own.
      if (!isDay(earning.payday)) file(sole, named[0], earning);
      else if (earning.cents > 0) file(loose, earning.projectId, earning);
    } else {
      file(shared, earning.projectId, earning);
    }
  }

  /*
   * One client however its name was typed. The schedule is already found by
   * the folded name — "Northwind" and "northwind " share one payday — so rows
   * keyed by the spelling split one payment into two lines on the same day.
   * Rows are keyed by the folded name and show the first spelling met.
   */
  const spelling = new Map();
  // Each client's rule and today on its clock, for dating the answers below.
  const clocks = new Map();

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
    clocks.set(client, { rule, today });

    const byAnswer = paysOnAcceptance(project);
    for (const task of tasksFor(project)) {
      const status = taskState(task);
      if (status === null || status === TASK.CANCELLED) continue;
      const pendingReview = byAnswer && status === TASK.SUBMITTED;

      /*
       * Where the project pays once accepted, the payday is the one for the
       * period the ANSWER fell in.
       *
       * Not the period the work was handed in during, which is the mistake
       * that rule replaced. A task submitted on the Sunday and accepted on the
       * Wednesday missed its own period: that period shut on the Monday, and
       * the run it pays belongs to the batch that was already closed. Dating
       * it from submission put the money on a payday that had been and gone,
       * so it dropped off this panel as though it had already arrived.
       *
       * Nobody has answered a submitted task yet, so there is no such period
       * to find. The earliest one there could be is the period we are in now,
       * which makes its payday a floor — the soonest the money could land,
       * never a date it is expected on.
       *
       * Where it pays as worked, nothing waits on an answer: the period the
       * work was HANDED IN pays it, accepted or not yet answered alike. An
       * answer to a task never marked submitted stamps the hand-in, so the
       * answer itself only stands in where a ledger somehow lacks one.
       */
      const handedIn = Number.isFinite(task.submittedAt) ? task.submittedAt : task.stateAt;
      const pay = paydayFor(rule, pendingReview ? now : byAnswer ? task.stateAt : handedIn);
      if (pay === null) continue;

      /*
       * What this task is owed, by currency and then by kind, because a reward
       * recorded in one currency cannot be added to hours in another. Hours
       * and reward together in the row's figure: under a single per-accepted
       * payment they are one piece of money that happens to be written down in
       * two places, and they land on the same day for the same reason. Kept
       * apart as lines, because an hour and a bonus are not the same thing.
       *
       * Only money coming in is counted, a record at a time. A negative
       * adjustment is not taken off the task's other lines: it was never
       * netted here, and a forecast that began to would move every figure it
       * had already given. It stays in the ledger and in the totals, and is
       * left off a payday it would only have made look smaller.
       */
      const owed = new Map();
      const add = (when, cur, part, cents, earningId) => {
        if (when === null || !(cents > 0)) return;
        const at = `${when.date}|${cur}`;
        if (!owed.has(at)) owed.set(at, { when, cur, parts: new Map() });
        const parts = owed.get(at).parts;
        if (!parts.has(part)) parts.set(part, { cents: 0, earningIds: [] });
        const line = parts.get(part);
        line.cents += cents;
        if (earningId) line.earningIds.push(earningId);
      };
      /*
       * The hours as one line of their own may have been marked (paylines.js):
       * already paid, which leaves them off, or moved to a day of their own,
       * which dates them there and leaves the rest of the task where it was.
       */
      if (task.hoursReceived !== true) {
        const hoursPay = isDay(task.hoursPayday) ? paydayOn(rule, task.hoursPayday) : pay;
        add(hoursPay, currency, "hours", hourlyCents(byTask, project, task.id, now));
      }
      // Only lines naming this task alone. A reward shared across many tasks
      // is not this one's to date, and is dated on its own below.
      for (const earning of sole.get(task.id) ?? []) {
        add(pay, earning.currency, earning.kind || "other", earning.cents, earning.id);
      }

      for (const { when, cur, parts } of owed.values()) {
        // Work under review has a floor, not a date; one moved to a day that
        // has since gone is left out, as a waiting floor that passed always was.
        if (pendingReview && when.date < today) continue;
        const row = into(pendingReview ? waiting : due, `${client}|${when.date}|${cur}`,
                         { client, company, at: when.at, date: when.date, currency: cur });
        for (const [part, { cents, earningIds }] of parts) {
          row.cents += cents;
          row.tasks.push({
            key: `task:${task.id}:${part}`, kind: "task", part,
            taskId: task.id, label: task.label, project: project.name, projectId: project.id,
            cents, status, ...(earningIds.length ? { earningIds } : {}),
          });
        }
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
      // A payday chosen by hand settles the date, and with it the question of
      // whether the tasks have all got there. Only a pending reward still waits.
      const chosen = isDay(earning.payday);
      const earned = chosen ? !isPending(earning) : times.every((t) => t !== null);
      const pay = chosen ? paydayOn(rule, earning.payday)
        : paydayFor(rule, earned ? Math.max(...times) : now);
      // A dated payment whose day has gone stays, as overdue, until somebody
      // answers it. Waiting money has no date to be late for, only a floor.
      if (pay === null || (!earned && pay.date < today)) continue;

      const row = into(earned ? due : waiting, `${client}|${pay.date}|${earning.currency}`,
                       { client, company, at: pay.at, date: pay.date, currency: earning.currency });
      row.cents += earning.cents;
      row.tasks.push({
        key: `reward:${earning.id}`, kind: "reward", earningId: earning.id,
        label: earning.note || "Reward", covers: tasksOf(earning).length,
        project: project.name, projectId: project.id, cents: earning.cents,
      });
    }

    /*
     * Money with no task to ride with: named for none, or moved to a payday of
     * its own. One line each, because each is a payment somebody chose to
     * record, and none of them is a task.
     *
     * It is dated from when it was ADDED unless a payday was picked, and a
     * pending one waits, with the date as a floor, like work under review. A
     * correction is as likely to take money off as to add it, and as with a
     * task's lines only money coming in is forecast.
     */
    for (const earning of loose.get(project.id) ?? []) {
      const pay = isDay(earning.payday) ? paydayOn(rule, earning.payday) : paydayFor(rule, earning.at);
      if (pay === null || (isPending(earning) && pay.date < today)) continue;
      const task = tasksOf(earning).length === 1
        ? tasksFor(project).find((t) => t.id === tasksOf(earning)[0]) : null;
      // Moved to a payday of its own, a task's bonus still goes with the
      // task's answer: a rejected task's money is not coming, whatever date
      // it was given.
      if (task && taskState(task) === TASK.CANCELLED) continue;
      const row = into(isPending(earning) ? waiting : due, `${client}|${pay.date}|${earning.currency}`,
                       { client, company, at: pay.at, date: pay.date, currency: earning.currency });
      row.cents += earning.cents;
      row.tasks.push({
        key: `extra:${earning.id}`, kind: "extra", part: earning.kind || "other",
        earningId: earning.id, label: earning.note || "", project: project.name,
        projectId: project.id, cents: earning.cents,
        ...(task ? { taskId: task.id, taskLabel: task.label } : {}),
      });
    }
  }

  /*
   * The answers, applied last, to the rows exactly as they were built. A row
   * is a payment, and an answer is about the whole of it: `paid` takes it off
   * the list; `moved` keeps it as the same row, under the same key, on the date
   * it was moved to, so it is never folded into another payment that happens
   * to fall there. `scheduled` is the date the forecast gave it, which is what
   * an answer is filed under, and `date` is where it is listed now.
   *
   * What is dated before today on its client's clock, answered or not, is
   * OVERDUE: it should have arrived and nobody has said it did. It is listed,
   * oldest first, instead of dropped, because a payment that quietly vanishes
   * when its day passes is indistinguishable from one that was paid.
   */
  const answers = answersByPayment(state);
  const upcoming = [];
  const late = [];
  for (const row of rows(due, "due")) {
    const { rule, today } = clocks.get(row.client);
    const answer = answers.get(payoutKey(row.client, row.currency, row.date));
    // Closed, whatever came: the money is in the earnings, or never will be.
    if (answer?.outcome === OUTCOME.PAID || answer?.outcome === OUTCOME.CANCELLED) continue;
    const away = answer?.outcome === OUTCOME.MOVED || answer?.outcome === OUTCOME.PARTIAL;
    const moved = away ? paydayOn(rule, answer.movedTo) : null;
    let listed = moved
      ? { ...row, scheduled: row.date, moved: true, date: moved.date, at: moved.at }
      : { ...row, scheduled: row.date };
    // Partly received: only the rest is still coming, and the row says so. The
    // figure is worked from what was expected on the day it was first
    // answered, which is what the amount received was measured against.
    if (moved && answer.outcome === OUTCOME.PARTIAL) {
      const expected = answer.expectedCents ?? row.cents;
      const got = answer.receivedCents ?? 0;
      listed = { ...listed, cents: Math.max(0, expected - got), partial: { expectedCents: expected, receivedCents: got } };
    }
    (listed.date < today ? late : upcoming).push(listed);
  }
  const byDay = (a, b) => a.at - b.at || a.company.localeCompare(b.company);
  return {
    due: upcoming.sort(byDay),
    waiting: rows(waiting, "wait").map((row) => ({ ...row, scheduled: row.date })),
    overdue: late.sort(byDay),
  };
};
