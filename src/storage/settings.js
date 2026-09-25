/**
 * Settings that belong to this device rather than to the ledger.
 *
 * The Google client id is the only one so far, and it is deliberately NOT in the
 * synced state: it is configuration, not work. Putting it in the ledger would
 * mean the thing you need in order to sync could only arrive by syncing, and
 * would raise a merge question — whose client id wins — that has no useful
 * answer.
 *
 * Every read and write is guarded. A private window, blocked site data, or a
 * thumbnail render can each make storage throw on access rather than return
 * empty, and a settings read is never worth taking the app down for.
 */
export const SETTING = {
  CLIENT_ID: "meter:google-client",
  /** Light, dark, or follow the operating system. Per device on purpose: which
   *  theme suits a phone at night and a desktop at noon are different
   *  questions, and syncing the answer would make one of them wrong. */
  THEME: "meter:theme",
  /** Which span the Overview opens on. A view preference, not work — it does
   *  not belong in the ledger and does not want merging. */
  PERIOD: "meter:period",
};

export const THEME = { SYSTEM: "system", LIGHT: "light", DARK: "dark" };

export const loadSetting = (key, fallback = "", win = globalThis) => {
  try {
    return win.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

export const saveSetting = (key, value, win = globalThis) => {
  try {
    if (value === null || value === "") win.localStorage.removeItem(key);
    else win.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};
