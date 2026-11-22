/**
 * What the address bar can carry into the app: `#invite=MTR-...` (optionally
 * with `&relay=URL`) and `#join=host/CODE`. Pure functions over the hash string,
 * so the rules are tested without a page.
 *
 * Both live in the FRAGMENT on purpose: a browser never sends it to a server, so
 * a code in a link does not reach the host's access log (codes.js says the same
 * about query strings, which it rejects). The app reads it once, fills in the
 * matching screen, and removes it from the address (`stripFragment`) so a
 * bookmark, a screenshot of the address bar or a reload does not keep it.
 */
import { CodeError, parseInvite } from "./codes.js";

/**
 * @returns null when the hash is not ours, else one of
 *   { kind: "invite", code, relay }   relay is null when the link names none
 *   { kind: "join", text }            the value after `join=`, for the join screen
 *   { kind: "bad", what, message }    ours, but unusable: say so, do not guess
 */
export function readFragment(hash) {
  const h = String(hash ?? "");
  if (h.startsWith("#join=")) {
    try {
      return { kind: "join", text: decodeURIComponent(h.slice("#join=".length)) };
    } catch {
      return { kind: "bad", what: "join", message: "The join code in this link is damaged." };
    }
  }
  if (h.startsWith("#invite=")) {
    try {
      const { code, relay } = parseInvite(h);
      return { kind: "invite", code, relay };
    } catch (e) {
      if (e instanceof CodeError) return { kind: "bad", what: "invite", message: e.message };
      throw e;
    }
  }
  return null;
}

/** The address without its fragment. Keeps the path and the query, which are the
 *  app's own. */
export const withoutFragment = (location) => `${location.pathname}${location.search}`;

/** Removes the fragment in place, without adding a history entry or reloading.
 *  A page that cannot (no History API, a sandbox) simply keeps it: nothing
 *  depends on it being gone. */
export function stripFragment(win = globalThis) {
  try {
    win.history.replaceState(null, "", withoutFragment(win.location));
    return true;
  } catch {
    return false;
  }
}
