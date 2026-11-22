/**
 * Where Meter Sync lives by default, in one place.
 *
 * The built-in relay is the owner's own deployment. It is a constant and not a
 * setting because it is what a fresh install uses; anyone can point a device at
 * a relay of their own instead (the "Use my own relay" choice), which is saved
 * with the vault, not here.
 */
import { checkRelayUrl } from "./codes.js";

export const DEFAULT_RELAY = "https://meter-sync.ahmedsaad41022.workers.dev";

/** Who runs the default relay, as the privacy notice names them (DESIGN M5). */
export const OPERATOR = "Meter Sync";

/** The page a join or invite link opens. Matches scripts/lib/relayAdmin.mjs, so
 *  a link made by the admin tool and one made by the app land in the same place. */
export const APP_URL = "https://ahmed41022.github.io/meter/";

/** True for the built-in relay, however its URL happens to be written. */
export const isDefaultRelay = (url) => {
  try { return checkRelayUrl(url) === DEFAULT_RELAY; } catch { return false; }
};

/** The operator line of the notice: the named service for the default relay, and
 *  for any other relay the only honest thing to say, that it is run by whoever
 *  owns that address. */
export const operatorOf = (relay) => {
  if (isDefaultRelay(relay)) return OPERATOR;
  try { return `the owner of ${new URL(relay).host}`; } catch { return "the owner of this relay"; }
};

/** The page's own fetch, looked up when called rather than captured, so the
 *  browser's real one is used in the app and a stub put in place before the app
 *  loads is used in a test. */
export const relayFetch = (url, init) => globalThis.fetch(url, init);
