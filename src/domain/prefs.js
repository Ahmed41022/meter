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
};

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
  if (found && !found.deletedAt && found.value === value) return state;
  const next = found
    ? { ...found, value, deletedAt: null }
    : { id: key, value, createdAt: now, deletedAt: null };
  const list = state?.prefs ?? [];
  // Same position as before, so the list does not reshuffle on every change.
  const prefs = found ? list.map((r) => (r.id === key ? next : r)) : [...list, next];
  return { ...state, prefs };
};
