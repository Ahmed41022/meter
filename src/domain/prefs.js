/**
 * Preferences that follow the ledger from device to device.
 *
 * A preference is a fact about how the owner likes the app to behave, so it
 * should be the same on the phone and the desktop — which is why these live in
 * the ledger and sync, unlike the per-device settings in storage/settings.js
 * (theme, the period last looked at).
 *
 * One record per KEY, not one record holding them all. The merge is
 * last-writer-wins per record, so with one big record a change to the list sort
 * on the phone and a change to the home currency on the desktop would collide
 * and one of them would be lost. Per key, both survive.
 *
 * Records look like every other: `{ id, value, createdAt, deletedAt }`, with
 * `updatedAt` added by `stampChanges` like anything else the user changes. The
 * id is the key.
 *
 * Like the rest of `domain/`, nothing here reads the clock or storage.
 */
import { PERIODS } from "./performance.js";
import { isDayGoal } from "./dayGoal.js";
import {
  BY_COMPANY_ORDERS, BY_PROJECT_ORDERS, CARD_ORDERS, EARNINGS_ORDERS, LIFE_ORDERS,
  SESSION_ORDERS, keysOf,
} from "./order.js";

/**
 * A preference naming which order a list opens in. It stores the order's key
 * and NOT its direction: each order opens the way it is first read (biggest or
 * latest first, names A to Z), and turning it round is a question for the
 * moment, so a stored direction would only double the choices for a default
 * nobody wants ("smallest earner first, always").
 */
const sortPref = (orders, fallback) => {
  const keys = keysOf(orders);
  return { default: fallback, valid: (v) => keys.includes(v) };
};

const isCode = (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v);

/** Equal as stored: lists and records by what they hold, all else by identity. */
const sameValue = (a, b) =>
  a === b || (a !== null && b !== null && typeof a === "object" && typeof b === "object"
    && JSON.stringify(a) === JSON.stringify(b));

/**
 * Every preference this build knows: its default, and what counts as a valid
 * value. Adding one is one line here.
 *
 * `overviewPeriod`: "last" keeps the per-device behaviour (open on the span
 * this device last looked at); a period means every device opens on that.
 */
export const PREFS = {
  overviewPeriod: {
    default: "last",
    valid: (v) => v === "last" || PERIODS.includes(v),
  },
  // Work project cards. Today's order is the order added.
  cardsSort: sortPref(CARD_ORDERS, "added"),
  // Life cards have their own key because Earned is a value Work can hold and
  // Life cannot: one shared key would make a Work default of Earned mean
  // something else (or nothing) on Life.
  lifeSort: sortPref(LIFE_ORDERS, "added"),
  byProjectSort: sortPref(BY_PROJECT_ORDERS, "time"),
  byCompanySort: sortPref(BY_COMPANY_ORDERS, "earned"),
  earningsSort: sortPref(EARNINGS_ORDERS, "newest"),
  sessionsSort: sortPref(SESSION_ORDERS, "newest"),
  // A goal for each day of work, over every project: see dayGoal.js.
  dayGoal: { default: null, valid: (v) => v === null || isDayGoal(v) },
  // Live exchange rates (domain/fx.js, fx/rates.js). Off until asked for, so
  // an app that never turns it on never touches the network.
  fxOn: { default: false, valid: (v) => typeof v === "boolean" },
  // The one currency every total is shown in, or "earned": each currency as
  // it was earned, never added together.
  displayCurrency: { default: "USD", valid: (v) => v === "earned" || isCode(v) },
  // The currencies offered in the switcher, in the owner's order. Never empty,
  // so the switcher always has something to offer besides "As earned".
  favourites: {
    default: Object.freeze(["USD"]),
    valid: (v) => Array.isArray(v) && v.length > 0 && v.every(isCode)
      && new Set(v).size === v.length,
  },
};

/** The preferences that name a list's order, for the Defaults section. */
export const SORT_PREFS = [
  "cardsSort", "lifeSort", "byProjectSort", "byCompanySort", "earningsSort", "sessionsSort",
];

const record = (state, key) => (state?.prefs ?? []).find((r) => r.id === key);

/**
 * The value in force. Anything unusable falls back to the default: no
 * collection, no record, a deleted one, or a value that an older or newer
 * build wrote and this one does not understand. A preference must never be
 * able to leave the app in a state it cannot display.
 */
export const prefOf = (state, key) => {
  const known = PREFS[key];
  if (!known) return undefined;
  const found = record(state, key);
  if (!found || found.deletedAt || !known.valid(found.value)) return known.default;
  return found.value;
};

/**
 * Sets one preference. Returns the state itself, unchanged, for an unknown key
 * or an invalid value, and when the value already stands — so a no-op is not
 * stamped as an edit and does not send a sync for nothing.
 *
 * An existing record keeps its id and createdAt; a deleted one is revived.
 */
export const setPref = (state, key, value, now) => {
  const known = PREFS[key];
  if (!known || !known.valid(value)) return state;
  const found = record(state, key);
  if (found && !found.deletedAt && sameValue(found.value, value)) return state;
  const next = found
    ? { ...found, value, deletedAt: null }
    : { id: key, value, createdAt: now, deletedAt: null };
  const list = state?.prefs ?? [];
  // Same position as before, so the list does not reshuffle on every change.
  const prefs = found ? list.map((r) => (r.id === key ? next : r)) : [...list, next];
  return { ...state, prefs };
};
