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
 * Outcomes so far: `paid`, which takes it off the list, and `moved`, which
 * puts it on another date, `movedTo`. Anything the owner is asked later — an
 * amount received, say — is a further field on the same record, and an
 * absent field means what it meant before it existed.
 *
 * Like every record it is never removed, only stamped `deletedAt`, so an
 * undo syncs as an edit. There is at most one live answer per payment:
 * answering again replaces the old one in place, under the same id.
 *
 * Like the rest of `domain/`, nothing here reads the clock or storage.
 */
import { isDay } from "./payPeriod.js";
import { fold } from "./projects.js";

export const OUTCOME = { PAID: "paid", MOVED: "moved" };

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

/**
 * Records an answer, replacing the one already there for this payment.
 *
 * Refused, returning the state as it was, for anything that would be stored
 * as a lie: a payment with no client, currency or real scheduled date, an
 * outcome that is not one of these, or a move with no real date to move to.
 */
export const answerPayout = (state, { client, currency, scheduled, outcome, movedTo }, now, id) => {
  const name = String(client ?? "").trim();
  if (!name || !currency || !isDay(scheduled)) return state;
  if (outcome !== OUTCOME.PAID && outcome !== OUTCOME.MOVED) return state;
  if (outcome === OUTCOME.MOVED && !isDay(movedTo)) return state;
  const key = payoutKey(name, currency, scheduled);
  const found = livePayouts(state).find((p) => payoutKey(p.client, p.currency, p.scheduled) === key);
  const record = {
    id: found?.id ?? id,
    client: name, currency, scheduled, outcome,
    ...(outcome === OUTCOME.MOVED ? { movedTo } : {}),
    answeredAt: now,
    createdAt: found?.createdAt ?? now,
    deletedAt: null,
  };
  return {
    ...state,
    payouts: found
      ? allPayouts(state).map((p) => (p === found ? record : p))
      : [...allPayouts(state), record],
  };
};

/** Answers one payment, or many, as a single change: "mark them all". */
export const answerPayouts = (state, answers, now, newId) =>
  answers.reduce((acc, answer) => answerPayout(acc, answer, now, newId()), state);

export const removePayout = (state, id, now) => ({
  ...state,
  payouts: allPayouts(state).map((p) => (p.id === id ? { ...p, deletedAt: now } : p)),
});

export const restorePayout = (state, id) => ({
  ...state,
  payouts: allPayouts(state).map((p) => (p.id === id ? { ...p, deletedAt: null } : p)),
});
