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
  /** Which machine this is. Minted once and never synced — it is the one fact
   *  about a device that must NOT travel with the ledger, because its whole
   *  job is to tell this copy apart from the others. */
  DEVICE: "meter:device",
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

/**
 * A stable name for this device, minted on first use.
 *
 * It exists so a session can say where it is running. Without it, a meter
 * started on a laptop and seen from a phone is indistinguishable from a meter
 * that crashed: both look like a session whose heartbeat stopped arriving, and
 * the phone would offer to close it at a timestamp that is simply wrong.
 *
 * Falls back to a fresh id every call where storage cannot be written, which
 * reads as "a device that has never been seen before" — the safe answer, since
 * it only ever costs the caller a heartbeat it was not entitled to write.
 */
export const deviceId = (win = globalThis) => {
  const found = loadSetting(SETTING.DEVICE, "", win);
  if (found) return found;
  const minted = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  saveSetting(SETTING.DEVICE, minted, win);
  return minted;
};
