/**
 * What the owner has said about a payment that was forecast.
 *
 * Upcoming payments is derived: nothing in it is stored, because a stored
 * forecast is wrong the moment a schedule changes. But a person's word is not
 * derivable. "That one has arrived" and "they told me the 25th instead" are
 * facts about the world that the ledger could never work out, so they are
 * kept, as records of their own, beside what the forecast works out.
 *
 * A payment here is a ROW of the forecast: one client, one currency, one
 * scheduled date, which is what a platform actually sends. The answer is about
 * the whole payment and not about the tasks inside it, which is what a payout
 * is — a figure that either came or did not. The scheduled date is the one
 * the forecast gives BEFORE any answer, so that moving a payment does not
 * change which payment the answer belongs to. A payday is a date on the
 * client's clock, "2026-11-18", and travels as one.
 *
 * Outcomes:
 *
 *   paid       arrived, and the payment is closed. Without `receivedCents` it
 *              came exactly as forecast, which is what every answer written
 *              before amounts existed says; with it, that much came.
 *   cancelled  it is not coming, and is closed. `receivedCents` is what came
 *              regardless, usually nothing.
 *   moved      it will be on another day, `movedTo`. Nothing has come.
 *   partial    some of it has come, `receivedCents`, and the rest is expected
 *              on `movedTo`. Receiving more later adds to that total.
 *
 * `expectedCents` is what the forecast said at the FIRST answer, and later
 * answers keep it. The forecast is worked out from tasks that can change; what
 * was expected on the day the payment was first answered is a fact about that
 * day, and rewriting it would rewrite what the difference was a difference to.
 *
 * Money is only touched when a payment CLOSES. What came, less what was
 * expected, is written as an `adjust` earning in the payment's own currency,
 * so that the earnings totals tell the truth: a cancelled payment keeps its
 * hours and loses its money, as everywhere else in this app, and $101 against
 * an expected $100 is $1 more. That earning is marked `received`, so the
 * forecast never counts it as coming. It is linked from the answer by
 * `adjustmentId`, and an answer given again, or taken back, replaces or
 * restores both together.
 *
 * Like every record it is never removed, only stamped `deletedAt`, so an
 * undo syncs as an edit. There is at most one live answer per payment:
 * answering again replaces the old one in place, under the same id. An
 * absent field means what it meant before it existed.
 *
 * Like the rest of `domain/`, nothing here reads the clock or storage.
 */
import { EARNING, addEarning } from "./earnings.js";
import { formatMoney } from "./money.js";
import { dayOnClock, findCompany, isDay, normalisePeriod, paydayFor } from "./payPeriod.js";
import { fold } from "./projects.js";

export const OUTCOME = { PAID: "paid", MOVED: "moved", CANCELLED: "cancelled", PARTIAL: "partial" };
const OUTCOMES = new Set(Object.values(OUTCOME));

/** A store written before answers existed has no array, which reads as none. */
export const allPayouts = (state) => state?.payouts ?? [];
export const livePayouts = (state) => allPayouts(state).filter((p) => !p.deletedAt);

/** The payment an answer or a forecast row is about. The client is its folded
 *  name, so "Northwind" and "northwind " are the one payment they are. */
export const payoutKey = (client, currency, scheduled) =>
  `${fold(client)}|${scheduled}|${currency}`;

/** The live answers, by the payment each is about. */
export const answersByPayment = (state) => {
  const map = new Map();
  for (const p of livePayouts(state)) map.set(payoutKey(p.client, p.currency, p.scheduled), p);
  return map;
};

/** The project a payment is booked to: the one its lines add up to most. Ties
 *  go to the first met. Null for a row whose lines name none. */
export const largestProject = (row) => {
  const totals = new Map();
  for (const line of row?.tasks ?? []) {
    if (!line.projectId) continue;
    totals.set(line.projectId, (totals.get(line.projectId) ?? 0) + line.cents);
  }
  let best = null;
  for (const [id, cents] of totals) if (best === null || cents > best[1]) best = [id, cents];
  return best ? best[0] : null;
};

/** What the payment's client's own clock says at `now`: today, and the next
 *  payday from now, which is where a new date starts. Both are theirs, not
 *  this device's. */
export const clockFor = (state, row, now) => {
  const rule = normalisePeriod(findCompany(state, row.company)?.payPeriod);
  const today = dayOnClock(rule, now);
  return { today, next: paydayFor(rule, now)?.date ?? today };
};

const shortDay = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
  timeZone: "UTC", weekday: "short", day: "numeric", month: "short",
});

const whole = (n) => Number.isFinite(n) && n >= 0 ? Math.round(n) : null;

/**
 * Records an answer, replacing the one already there for this payment, and
 * writes the adjustment a closing answer needs, in one change.
 *
 * `receivedNow` is what came with THIS answer, in cents. Left out on `paid` it
 * means the rest of what was expected. The total received is that plus what a
 * partial answer had already recorded.
 *
 * Refused, returning the state as it was, for anything that would be stored
 * as a lie: a payment with no client, currency or real scheduled date, an
 * outcome that is not one of these, a move or partial with no real date to
 * move to, an amount that is not a sum of money, a partial that has already
 * received everything (that is `paid`), or a difference with no project to
 * book it to. `makeId` is called for each new record.
 */
export const answerPayout = (state, answer, now, makeId) => {
  const { client, currency, scheduled, outcome, movedTo, projectId, receivedNow } = answer;
  const name = String(client ?? "").trim();
  if (!name || !currency || !isDay(scheduled) || !OUTCOMES.has(outcome)) return state;
  const away = outcome === OUTCOME.MOVED || outcome === OUTCOME.PARTIAL;
  if (away && !isDay(movedTo)) return state;
  if (receivedNow != null && whole(receivedNow) === null) return state;

  const key = payoutKey(name, currency, scheduled);
  const found = livePayouts(state).find((p) => payoutKey(p.client, p.currency, p.scheduled) === key);
  // Only a partial answer has already received anything to add to.
  const before = found?.outcome === OUTCOME.PARTIAL ? (found.receivedCents ?? 0) : 0;
  const forecast = whole(answer.expectedCents);
  const expected = found?.expectedCents ?? (forecast === null ? null : forecast + before);
  const got = receivedNow == null ? null : whole(receivedNow);

  let received = null;
  // Paid with no amount said is paid exactly as expected, whatever that was.
  const exact = outcome === OUTCOME.PAID && got === null;
  if (exact) received = expected;
  else if (outcome === OUTCOME.PAID) received = before + got;
  else if (outcome === OUTCOME.CANCELLED) received = before + (got ?? 0);
  else if (outcome === OUTCOME.PARTIAL) received = before + (got ?? 0);
  if (outcome === OUTCOME.PARTIAL && (expected === null || received >= expected)) return state;

  // The adjustment, only when the payment closes, and only when it differs.
  const closing = outcome === OUTCOME.PAID || outcome === OUTCOME.CANCELLED;
  const gap = closing && expected !== null && received !== null ? received - expected : 0;
  const project = gap !== 0 ? (state.projects ?? []).find((p) => p.id === projectId && !p.deletedAt) : null;
  if (gap !== 0 && !project) return state;

  // Whatever adjustment this payment already had is taken back first.
  let next = found?.adjustmentId ? tombstoneEarning(state, found.adjustmentId, now) : state;
  let adjustmentId = null;
  if (gap !== 0) {
    adjustmentId = makeId();
    const note = outcome === OUTCOME.CANCELLED
      ? `Cancelled: received ${formatMoney(received, currency)} of ${formatMoney(expected, currency)}`
      : `Received ${formatMoney(received, currency)} of ${formatMoney(expected, currency)}`;
    next = addEarning(next, project, {
      cents: gap, kind: EARNING.ADJUSTMENT, at: now, currency, received: true,
      note: `${note} · ${name}, ${shortDay(scheduled)}`,
    }, now, adjustmentId);
  }

  const record = {
    id: found?.id ?? makeId(),
    client: name, currency, scheduled, outcome,
    ...(away ? { movedTo } : {}),
    ...(expected !== null ? { expectedCents: expected } : {}),
    // Absent on `paid` means exactly as expected, so it is written only when
    // it was not. The other outcomes always say what came.
    ...(outcome === OUTCOME.PAID ? (exact || received === expected ? {} : { receivedCents: received })
      : outcome === OUTCOME.MOVED ? {} : { receivedCents: received }),
    ...(adjustmentId ? { adjustmentId } : {}),
    answeredAt: now,
    createdAt: found?.createdAt ?? now,
    deletedAt: null,
  };
  return {
    ...next,
    payouts: found
      ? allPayouts(next).map((p) => (p === found ? record : p))
      : [...allPayouts(next), record],
  };
};

const tombstoneEarning = (state, id, now) => ({
  ...state,
  earnings: (state.earnings ?? []).map((e) => (e.id === id && !e.deletedAt ? { ...e, deletedAt: now } : e)),
});

/** Answers one payment, or many, as a single change: "mark them all". */
export const answerPayouts = (state, answers, now, makeId) =>
  answers.reduce((acc, answer) => answerPayout(acc, answer, now, makeId), state);

/**
 * What a payment's answer and adjustment are now, to hand back to
 * `restorePayment` should it be taken back. The records themselves, whole,
 * because that is all an undo needs to put them as they were.
 */
export const snapshotPayment = (state, { client, currency, scheduled }) => {
  const answer = answersByPayment(state).get(payoutKey(client, currency, scheduled)) ?? null;
  const adjustment = answer?.adjustmentId
    ? (state.earnings ?? []).find((e) => e.id === answer.adjustmentId) ?? null : null;
  return { answer, adjustment };
};

/**
 * Puts one payment back as `snapshotPayment` found it: its earlier answer and
 * adjustment given back, or, where there was none, whatever has been written
 * since taken away by tombstone. Every change is a rebuilt or tombstoned record,
 * never a removed one, so the sync sees an edit and not a record that vanished
 * — which another device would simply bring back.
 */
export const restorePayment = (state, key, snap, now) => {
  const current = answersByPayment(state).get(key) ?? null;
  let next = state;
  if (snap.answer) {
    next = { ...next, payouts: allPayouts(next).map((p) => (p.id === snap.answer.id ? { ...snap.answer } : p)) };
  } else if (current) {
    next = { ...next, payouts: allPayouts(next).map((p) => (p.id === current.id ? { ...p, deletedAt: now } : p)) };
  }
  // The adjustment written since, if it is not the one being given back, goes.
  if (current?.adjustmentId && current.adjustmentId !== snap.adjustment?.id) {
    next = tombstoneEarning(next, current.adjustmentId, now);
  }
  if (snap.adjustment) {
    next = {
      ...next,
      earnings: (next.earnings ?? []).map((e) => (e.id === snap.adjustment.id ? { ...snap.adjustment } : e)),
    };
  }
  return next;
};

export const removePayout = (state, id, now) => ({
  ...state,
  payouts: allPayouts(state).map((p) => (p.id === id ? { ...p, deletedAt: now } : p)),
});

export const restorePayout = (state, id) => ({
  ...state,
  payouts: allPayouts(state).map((p) => (p.id === id ? { ...p, deletedAt: null } : p)),
});
