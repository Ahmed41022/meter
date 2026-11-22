/**
 * What has been paid, and when: the past of Upcoming payments.
 *
 * The forecast drops a payment once it is answered, which is right for a list
 * of what is coming and leaves no record of what came. This is that record,
 * and like the forecast it is derived and never stored: the paydays, their
 * lines and the dates come from the same row builder (`forecastRows`), so a
 * payment is on the same day here as it was on the list, and a schedule changed
 * since leaves past dates where they were (`paydayThrough`). What is added is
 * only what the owner said about each one — the answers in `payouts`, and the
 * lines marked paid one by one (paylines.js).
 *
 * A row is a payday of one client in one currency, as in the forecast, and is
 * in the history once it is no longer simply coming:
 *
 *   paid        closed, received as said. `differenceCents` is what came more
 *               or less than expected.
 *   partial     some came and the rest is still expected. Not closed, so it
 *               has no difference yet.
 *   cancelled   closed, and the money is not coming; `receivedCents` is what
 *               came regardless, usually nothing.
 *   unanswered  its day has passed on its client's clock and nobody has said
 *               what came, which is what the forecast calls overdue. A payment
 *               moved to a day that has since passed is this too, listed on
 *               the day it was moved to.
 *   lines-paid  every line of it was marked paid one by one, so there is no
 *               payment left to answer, only the lines.
 *
 * Answered payments are in whatever their date: "Already paid" a week early is
 * paid today. A payment moved to a day still ahead is not here, it is still
 * coming, and neither is one that is merely not due yet.
 *
 * Lines marked paid one by one are `paidLines` of the payday they belonged to,
 * kept apart from `lines`, which is what the payment itself is made of, so a
 * row's figures are the payment's and the paid lines' money is
 * `paidLinesCents`, on top. Where the day they were marked on was recorded
 * (`receivedOn`, the payday of the row they were on) that is the payday, and
 * where that payday no longer has a payment of its own they stand as a
 * `lines-paid` row on it. Where no day was recorded (a line marked before dates
 * were kept, or money added as "already paid") the payday the rules give it IS
 * its date: the payday worked out from its hand-in, its acceptance or the day
 * it was added, on the client's schedule as it stood then (`paydayThrough`).
 * Such a line has `receivedOn` set to that payday like any other, and
 * `inferred: true`, so an export can say which dates were recorded and which
 * were worked out. A client with no schedule has no payday to give, so its
 * money has no place in the history at all.
 *
 * Money in different currencies is never added together: every total is a map
 * by currency.
 *
 * Like the rest of `domain/`, nothing here reads the clock or storage.
 */
import { fold, isOffClock } from "./projects.js";
import { OUTCOME, answersByPayment, payoutKey } from "./payouts.js";
import { forecastRows, isClosed, listRow } from "./payout.js";
import { dayOnClock, isDay, payHistoryFor, payPeriodFor, paydayThrough } from "./payPeriod.js";
import { isBilled, sessionCents } from "./sessions.js";
import { tasksFor } from "./tasks.js";
import { taskState } from "./taskState.js";
import { pricer } from "./terms.js";
import { isCancelled, isPending, tasksOf } from "./earnings.js";

export const STATUS = {
  PAID: "paid", PARTIAL: "partial", CANCELLED: "cancelled",
  UNANSWERED: "unanswered", LINES_PAID: "lines-paid",
};

const byNewest = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)
  || a.company.localeCompare(b.company) || a.currency.localeCompare(b.currency);

/**
 * Every payday that is past, or answered, newest first.
 *
 * `now` only says what "past" is, on each client's own clock: a payday has
 * passed once that clock has moved beyond its day, as it does for overdue.
 */
export const paymentHistory = (state, now) => {
  const { due, clocks } = forecastRows(state, now);
  const answers = answersByPayment(state);
  // By the payment's own key (client, scheduled day, currency), which is what
  // an answer and a line's recorded day are both filed under.
  const index = new Map();
  const put = (scheduled, row) => {
    index.set(payoutKey(row.client, row.currency, scheduled), row);
    return row;
  };

  const base = (row, scheduled, lines = row.tasks ?? []) => ({
    key: `due|${payoutKey(row.client, row.currency, scheduled)}`,
    client: row.client, company: row.company, currency: row.currency,
    scheduled, moved: false, answeredAt: null,
    lines, paidLines: [], paidLinesCents: 0,
  });

  for (const row of due) {
    const { rule, today } = clocks.get(row.client);
    const answer = answers.get(payoutKey(row.client, row.currency, row.date));
    const out = base(row, row.date);
    if (isClosed(answer)) {
      const expected = answer.expectedCents ?? row.cents;
      const received = answer.receivedCents ?? (answer.outcome === OUTCOME.PAID ? expected : 0);
      put(row.date, {
        ...out, date: row.date, answeredAt: answer.answeredAt ?? null,
        status: answer.outcome === OUTCOME.PAID ? STATUS.PAID : STATUS.CANCELLED,
        expectedCents: expected, receivedCents: received, differenceCents: received - expected,
      });
      continue;
    }
    const listed = listRow(row, answer, rule);
    if (listed.partial) {
      put(row.date, {
        ...out, date: listed.date, moved: true, answeredAt: answer.answeredAt ?? null,
        status: STATUS.PARTIAL, expectedCents: listed.partial.expectedCents,
        receivedCents: listed.partial.receivedCents, differenceCents: null,
      });
    } else if (listed.date < today) {
      put(row.date, {
        ...out, date: listed.date, moved: listed.moved === true, answeredAt: answer?.answeredAt ?? null,
        status: STATUS.UNANSWERED, expectedCents: row.cents, receivedCents: 0, differenceCents: null,
      });
    }
  }

  /*
   * An answer whose payment the forecast no longer has: its tasks were
   * rejected or deleted afterwards. What was paid is still a fact, and what
   * the answer says is all there is left to show, so it stands without lines.
   */
  for (const answer of answers.values()) {
    const key = payoutKey(answer.client, answer.currency, answer.scheduled);
    if (index.has(key) || answer.outcome === OUTCOME.MOVED) continue;
    const client = fold(answer.client);
    const closed = isClosed(answer);
    if (!closed && !isDay(answer.movedTo)) continue;
    const expected = answer.expectedCents ?? 0;
    const received = answer.receivedCents ?? (answer.outcome === OUTCOME.PAID ? expected : 0);
    const out = base({ client, company: answer.client.trim(), currency: answer.currency }, answer.scheduled);
    put(answer.scheduled, {
      ...out, lines: [], answeredAt: answer.answeredAt ?? null,
      date: closed ? answer.scheduled : answer.movedTo, moved: !closed,
      status: answer.outcome === OUTCOME.PAID ? STATUS.PAID
        : answer.outcome === OUTCOME.CANCELLED ? STATUS.CANCELLED : STATUS.PARTIAL,
      expectedCents: expected, receivedCents: received,
      differenceCents: closed ? received - expected : null,
    });
  }

  addWorkedLines(state, now, index, base, clocks);

  /*
   * Lines marked paid one by one, each filed under the payday it belonged to.
   * The day recorded when it was marked is that payday; failing one, the
   * payday the line is worked out to be on now.
   */
  const settled = forecastRows(state, now, true);
  for (const row of [...settled.due, ...settled.waiting]) {
    for (const line of row.tasks) {
      const scheduled = line.receivedOn ?? row.date;
      let found = index.get(payoutKey(row.client, row.currency, scheduled));
      if (!found) {
        found = put(scheduled, {
          ...base(row, scheduled, []), date: scheduled, status: STATUS.LINES_PAID,
          expectedCents: 0, receivedCents: 0, differenceCents: null,
        });
      }
      // `scheduled` is the recorded day or, failing one, the row's payday, so
      // every paid line carries a date; `inferred` keeps where it came from.
      found.paidLines.push({ ...line, receivedOn: scheduled, inferred: line.receivedOn === null });
      found.paidLinesCents += line.cents;
    }
  }

  return [...index.values()].sort(byNewest);
};

/** When a sitting's work ended: its last block's end, or its close. */
const workEnd = (session) => {
  const ends = (session.segments ?? []).map((g) => g.endedAt).filter(Number.isFinite);
  return ends.length ? Math.max(...ends) : session.closedAt;
};

/**
 * Work on tasks that were never handed in or answered, dated by when it was
 * done.
 *
 * The forecast dates a task's money by its hand-in or its answer, and a task
 * still open has neither, so it has no payday and never reached the history.
 * Most of a ledger kept before tasks were handed in and answered is exactly
 * that: years of sittings on open tasks, or on none, under clients whose
 * schedules were set later. Those were worked, and paid, so each sitting is
 * dated the way work paid as it is done is dated: by the period it was done in,
 * on its client's schedule as it stood then (`paydayThrough`). Only paydays
 * already past are history; this period's open work is still to be handed in.
 *
 * Money in these rows is taken as paid on that payday unless the owner said
 * otherwise for it: a payday with an answer keeps the answer's figures and only
 * gains the lines that make it up; one already listed as not answered gains the
 * money too; one with nothing yet becomes a paid row marked `inferred`, as a
 * line dated by the rules is. Earnings naming one open task go with it, dated
 * by the day they were added. Pending and cancelled money is left out, as it
 * is everywhere, and only money coming in is listed.
 */
const addWorkedLines = (state, now, index, base, clocks) => {
  const projects = (state.projects ?? []).filter((p) => !p.deletedAt && !isOffClock(p));
  const answerAdjustments = new Set(
    (state.payouts ?? []).filter((p) => !p.deletedAt).map((p) => p.adjustmentId).filter(Boolean),
  );
  const sessionsOf = new Map();
  for (const s of state.sessions ?? []) {
    if (s.deletedAt || !isBilled(s) || s.closedAt == null) continue;
    if (!sessionsOf.has(s.projectId)) sessionsOf.set(s.projectId, []);
    sessionsOf.get(s.projectId).push(s);
  }
  const rows = new Map();

  for (const project of projects) {
    const rule = payPeriodFor(state, project);
    if (!rule) continue;
    const history = payHistoryFor(state, project);
    const named = (project.company ?? "").trim();
    const client = fold(named);
    const today = clocks.get(client)?.today ?? dayOnClock(rule, now);
    const tasks = new Map(tasksFor(project).map((t) => [t.id, t]));
    // Open means no hand-in and no answer: such a task's money is dated here,
    // and every other task's by the forecast, so nothing is counted twice.
    const open = (taskId) => !taskId || !tasks.has(taskId) || taskState(tasks.get(taskId)) === null;
    const mine = (sessionsOf.get(project.id) ?? []).filter((s) => open(s.taskId));
    const price = pricer([project], mine);

    const add = (at, currency, line) => {
      const pay = paydayThrough(history, rule, at);
      if (!pay || !(pay.date < today) || !(line.cents > 0)) return;
      const key = payoutKey(client, currency, pay.date);
      if (!rows.has(key)) rows.set(key, { client, company: named, currency, date: pay.date, lines: new Map() });
      const lines = rows.get(key).lines;
      const id = `${line.key}`;
      if (lines.has(id)) lines.get(id).cents += line.cents;
      else lines.set(id, { ...line });
    };

    for (const s of mine) {
      if (isCancelled(s) || isPending(s)) continue;
      const task = s.taskId ? tasks.get(s.taskId) : null;
      add(workEnd(s), s.currency, {
        key: `task:${s.taskId ?? "none"}:hours`, kind: "task", part: "hours",
        taskId: s.taskId ?? null, label: task?.label ?? "No task", project: project.name, projectId: project.id,
        cents: sessionCents(s, -Infinity, Infinity, now, price), status: null,
      });
    }
    for (const e of state.earnings ?? []) {
      if (e.deletedAt || e.projectId !== project.id || isCancelled(e) || isPending(e)) continue;
      if (answerAdjustments.has(e.id) || isDay(e.payday)) continue;
      const named = tasksOf(e);
      if (named.length !== 1 || !tasks.has(named[0]) || !open(named[0])) continue;
      const task = tasks.get(named[0]);
      add(e.at, e.currency, {
        key: `task:${task.id}:${e.kind || "other"}`, kind: "task", part: e.kind || "other",
        taskId: task.id, label: task.label, project: project.name, projectId: project.id, cents: e.cents, status: null,
      });
    }
  }

  for (const [key, row] of rows) {
    const lines = [...row.lines.values()];
    const cents = lines.reduce((n, l) => n + l.cents, 0);
    const found = index.get(key);
    if (found) {
      /*
       * Paid on top of whatever was said about the payday, like a line marked
       * paid one by one. An answer given before this work was dated could only
       * have been about what the forecast listed then, often a lone bonus, so
       * its figures say nothing about these hours. Folding the hours into the
       * answer's own figures, or leaving them out of the totals, put thousands
       * of dollars of paid work in the lines and nowhere in what was received.
       */
      found.paidLines.push(...lines.map((l) => ({ ...l, receivedOn: row.date, inferred: true, worked: true })));
      found.paidLinesCents += cents;
      continue;
    }
    index.set(key, {
      ...base(row, row.date, lines), date: row.date, status: STATUS.PAID, inferred: true,
      expectedCents: cents, receivedCents: cents, differenceCents: 0,
    });
  }
};

const inPeriod = (date, { from, to } = {}) =>
  !(isDay(from) && date < from) && !(isDay(to) && date > to);

/** The figures of a set of rows, one currency each. Nothing here crosses a
 *  currency: the map is the only thing the rows are summed into. */
const blank = () => ({ expected: 0, received: 0, outstanding: 0, cancelled: 0, difference: 0 });

/**
 * Adds one row to its currency's totals.
 *
 * Lines paid one by one count as expected and received alike, because they
 * came as listed. `outstanding` is what is still to come: all of an
 * unanswered payment and the rest of a partial one. `cancelled` is what a
 * cancelled payment did not bring. `difference` is the more or less that
 * closed payments came to, so a cancellation, which has its own figure, is not
 * in it twice.
 */
const tally = (totals, row) => {
  const t = (totals[row.currency] ??= blank());
  const expected = row.expectedCents + row.paidLinesCents;
  t.expected += expected;
  t.received += row.receivedCents + row.paidLinesCents;
  if (row.status === STATUS.UNANSWERED) t.outstanding += row.expectedCents;
  else if (row.status === STATUS.PARTIAL) t.outstanding += Math.max(0, row.expectedCents - row.receivedCents);
  else if (row.status === STATUS.CANCELLED) t.cancelled += Math.max(0, row.expectedCents - row.receivedCents);
  else if (row.status === STATUS.PAID) t.difference += row.differenceCents;
};

export const totalsOf = (rows) => {
  const totals = {};
  for (const row of rows) tally(totals, row);
  return totals;
};

/**
 * The history grouped by payday, newest first: each date with its rows and a
 * subtotal for each currency, and each month the same over its dates. The
 * dates are the rows' own, on their clients' clocks, so a period's edges are
 * days and not instants. `from` and `to` are inclusive and either may be left
 * out.
 */
export const historyByPayday = (history, period = {}) => {
  const days = new Map();
  for (const row of history ?? []) {
    if (!inPeriod(row.date, period)) continue;
    if (!days.has(row.date)) days.set(row.date, []);
    days.get(row.date).push(row);
  }
  const dated = [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, rows]) => ({ date, rows, totals: totalsOf(rows) }));
  const months = new Map();
  for (const day of dated) {
    const month = day.date.slice(0, 7);
    if (!months.has(month)) months.set(month, { month, dates: [], rows: [] });
    const m = months.get(month);
    m.dates.push(day.date);
    m.rows.push(...day.rows);
  }
  return {
    days: dated,
    months: [...months.values()].map(({ month, dates, rows }) => ({ month, dates, totals: totalsOf(rows) })),
  };
};

/**
 * One company's account of itself over a period: per currency, what was
 * expected, what came, what is still outstanding, what was cancelled and the
 * sum of the differences, and the paydays behind those figures, newest first,
 * each with its lines. `client` is matched by its folded name, as everywhere.
 */
export const companyStatement = (history, client, period = {}) => {
  const key = fold(client);
  const paydays = (history ?? []).filter((row) => row.client === key && inPeriod(row.date, period));
  return {
    client: key,
    company: paydays[0]?.company ?? String(client ?? "").trim(),
    totals: totalsOf(paydays),
    paydays,
  };
};
