/**
 * Carrying the ledger across when the app stops being a file and becomes an
 * origin.
 *
 * Browsers key localStorage by origin, so moving the desktop app from
 * `file://` to `http://127.0.0.1:47823` does not move its data: the app would
 * open to an empty ledger with every session still sitting in the old store.
 * This copies it over once.
 *
 * Three rules, and each one exists to stop a specific way of losing work:
 *
 *  - It only ever writes into an EMPTY store. A ledger already at the new
 *    origin is the real one and is never overwritten.
 *  - It only copies keys it knows about, so an unrelated key cannot ride along.
 *  - It runs once, recorded by a flag the caller keeps. Without that, a store
 *    cleared for any reason months later would be refilled from a `file://`
 *    copy frozen at the day of the move — silently reverting everything since.
 *
 * Nothing is ever deleted from the old store. If any of this goes wrong the
 * original is still exactly where it was, and a backup still restores.
 */

/** The ledger, and the device's Google client id. Deliberately a list rather
 *  than "everything": storage is a shared namespace and only these two belong
 *  to the app's own state. */
const CARRY = ["meter:v1", "meter:google-client"];

/** The one that decides whether a store counts as occupied. The client id alone
 *  is configuration, not work, and must not make an empty app look lived-in. */
const LEDGER = "meter:v1";

const filled = (value) => typeof value === "string" && value.length > 0;

/**
 * What to write, given what each side holds. Returns `[key, value]` pairs, and
 * an empty list means "do nothing" — which is the answer in every doubtful
 * case, because doing nothing here is always recoverable.
 */
function migrationPlan(target = {}, source = {}) {
  if (filled(target[LEDGER])) return [];
  if (!filled(source[LEDGER])) return [];
  return CARRY
    .filter((key) => filled(source[key]) && !filled(target[key]))
    .map((key) => [key, source[key]]);
}

/** Reads the carried keys out of whichever origin the window is on. Built as a
 *  string because it is evaluated inside a renderer, not here. */
function readScript(keys = CARRY) {
  return `(() => {
    const out = {};
    for (const key of ${JSON.stringify(keys)}) {
      try { const v = localStorage.getItem(key); if (v !== null) out[key] = v; } catch {}
    }
    return out;
  })()`;
}

/** Writes them into the origin the window is on, reporting how many landed. */
function writeScript(entries) {
  return `(() => {
    let done = 0;
    for (const [key, value] of ${JSON.stringify(entries)}) {
      try { localStorage.setItem(key, value); done += 1; } catch {}
    }
    return done;
  })()`;
}

module.exports = { migrationPlan, readScript, writeScript, CARRY, LEDGER };
