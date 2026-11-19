import {
  EARNING, PAY, addEarning, removeEarning, restoreEarning, setEarningTasks, setPayState,
  setPayStateMany,
} from "../../domain/earnings.js";
import { formatMoney } from "../../domain/money.js";
import {
  OUTCOME, answerPayouts, answersByPayment, largestProject, payoutKey, restorePayment, snapshotPayment,
} from "../../domain/payouts.js";
import { lineRefs, markLines, readMarks, writeMarks } from "../../domain/paylines.js";
import { payDay } from "../PaymentAnswer.jsx";
import { uid } from "./shared.js";

/**
 * What the project page does to money: recording what a piece earned, adding
 * and removing earnings, marking them paid, and a reward across a batch.
 */
export function moneyActions({ commit, flash, stateRef, project }) {
  return {
    onSettle: (sessionId, lines) => commit((s) => lines.reduce(
      // Pending, not paid. The work is submitted; whether it is
      // accepted is somebody else's decision and days away.
      (acc, line) => addEarning(acc, project, {
        cents: line.cents, kind: EARNING.PIECE, units: line.units,
        taskIds: line.taskId ? [line.taskId] : [], sessionId, status: PAY.PENDING,
      }, Date.now(), uid()),
      s,
    )),
    onAddEarning: (entry) =>
      commit((s) => addEarning(s, project, entry, Date.now(), uid())),
    onRemoveEarning: (id) => {
      commit((s) => removeEarning(s, id, Date.now()));
      flash("Removed.", "Undo", () => commit((s) => restoreEarning(s, id)));
    },
    onSetPayState: (id, status) => commit((s) => setPayState(s, id, status)),
    onSetEarningTasks: (id, taskIds) => commit((s) => setEarningTasks(s, id, taskIds)),
    onSetPayStateMany: (ids, status) => {
      if (!ids.length) return;
      const snapshot = stateRef.current;
      commit((s) => setPayStateMany(s, ids, status));
      flash(`${ids.length} marked ${status === PAY.PAID ? "paid" : status}.`, "Undo",
            () => commit(() => snapshot));
    },
    /* One payment for the whole batch — "finish fifty and we pay you
       X". It names every task without giving any of them a share:
       splitting it would invent a per-task price nobody quoted. */
    onRewardTasks: (taskIds, { cents, note }) => {
      const snapshot = stateRef.current;
      commit((s) => addEarning(s, project, {
        cents, kind: EARNING.BONUS, units: taskIds.length, taskIds,
        status: PAY.PENDING, note,
      }, Date.now(), uid()));
      flash(`Reward recorded across ${taskIds.length} tasks.`, "Undo",
            () => commit(() => snapshot));
    },
  };
}

/**
 * Answering paydays, from the notice and from the Overview. Kept apart from
 * the project page's money handlers because they act on payments across every
 * project, not on one.
 */
export function paymentActions({ commit, flash, stateRef }) {
  /**
   * Records what was said about one or many payments, as ONE change, with an
   * Undo that is itself an edit: a payment that had an answer before gets that
   * answer back, and one that had none has the new one tombstoned. Putting an
   * old copy of the list back instead would drop records without a stamp, and
   * the next sync would bring them back from the other device.
   */
  const recordAnswers = (answers, message) => {
    const keyOf = (a) => payoutKey(a.client, a.currency, a.scheduled);
    // What each payment's answer, and the adjustment it wrote, were before.
    const before = answers.map((a) => snapshotPayment(stateRef.current, a));
    commit((s) => answerPayouts(s, answers, Date.now(), uid));
    flash(message, "Undo", () => commit((s) => {
      const at = Date.now();
      return answers.reduce((acc, a, i) => restorePayment(acc, keyOf(a), before[i], at), s);
    }));
  };
  /** One row's answer, with the row's own figures: what it said was coming,
   *  and the project a difference is booked to. */
  const answerFor = (row, fields) => ({
    client: row.company, currency: row.currency, scheduled: row.scheduled,
    expectedCents: row.cents, projectId: largestProject(row), ...fields,
  });
  const answerPayment = (row, fields) => {
    const money = (c) => formatMoney(c, row.currency);
    const message = fields.outcome === OUTCOME.CANCELLED ? `Cancelled. ${money(row.cents)} off your earnings.`
      : fields.outcome === OUTCOME.PARTIAL ? `Received ${money(fields.receivedNow)}. The rest is on ${payDay(fields.movedTo)}.`
        : fields.receivedNow !== undefined && fields.receivedNow !== row.cents
          ? `Recorded ${money(fields.receivedNow)} received.` : "Marked as paid.";
    recordAnswers([answerFor(row, fields)], message);
  };
  const answerPayments = (rows, outcome, movedTo, message) =>
    recordAnswers(rows.map((row) => answerFor(row, { outcome, movedTo })), message);

  /**
   * Some lines of a payment, not the whole of it: marked paid, `{ received:
   * true }`, or moved to a day of their own, `{ payday }`. The Undo writes the
   * marks back as they were, as an edit. A move onto a day this client's
   * payment was already answered for is refused, because the lines would join
   * that answered payment and vanish with it; false says it was refused.
   */
  const markPaymentLines = (row, lines, change) => {
    if (change.payday) {
      const there = answersByPayment(stateRef.current).get(payoutKey(row.company, row.currency, change.payday));
      if (there) {
        flash(`The ${payDay(change.payday)} payment is already answered. Pick another day.`);
        return false;
      }
    }
    const before = readMarks(stateRef.current, lineRefs(lines));
    commit((s) => markLines(s, lines, change));
    const what = lines.length === 1 ? "1 line" : `${lines.length} lines`;
    flash(change.received ? `${what} marked as paid.` : `${what} moved to ${payDay(change.payday)}.`,
          "Undo", () => commit((s) => writeMarks(s, before)));
    return true;
  };

  return { answerPayment, answerPayments, markPaymentLines };
}
