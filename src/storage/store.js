/**
 * The only module that knows where data lives. Swap `createBackend` for
 * IndexedDB or an HTTP client and nothing above this file changes.
 */

export const STORE_KEY = "meter:v1";
export const EMPTY = { projects: [], sessions: [] };

/** Where a stored ledger that could not be read is copied before anything can
 *  be saved over it. The rest of the key is the moment it was found, as an ISO
 *  time, so a second bad value never lands on top of the first. */
export const UNREADABLE_PREFIX = `${STORE_KEY}:unreadable:`;

/** Picks a backend once, at load. Exposed as `name` so the UI can warn the
 *  user when storage is volatile — a silent memory fallback loses a day's work
 *  without ever reporting a failure.
 *
 *  Each one reads and writes the ledger's key unless handed another, which
 *  only the copy of an unreadable ledger ever is. */
export function createBackend(win = typeof window !== "undefined" ? window : undefined) {
  if (win?.storage?.get) {
    return {
      name: "artifact",
      get: async (key = STORE_KEY) => (await win.storage.get(key, false))?.value ?? null,
      set: async (v, key = STORE_KEY) => { await win.storage.set(key, v, false); },
    };
  }
  try {
    const probe = "__meter_probe__";
    win.localStorage.setItem(probe, "1");
    win.localStorage.removeItem(probe);
    return {
      name: "local",
      get: async (key = STORE_KEY) => win.localStorage.getItem(key),
      set: async (v, key = STORE_KEY) => win.localStorage.setItem(key, v),
      keys: async () => Array.from({ length: win.localStorage.length ?? 0 },
        (_, i) => win.localStorage.key(i)),
    };
  } catch {
    const held = new Map();
    return {
      name: "memory",
      get: async (key = STORE_KEY) => held.get(key) ?? null,
      set: async (v, key = STORE_KEY) => { held.set(key, v); },
    };
  }
}

/** Anything that isn't a well-formed store reads as null, so corrupt data can
 *  never crash the boot. Absent and unreadable are not the same thing, though:
 *  `load` tells them apart, and keeps an unreadable one safe. */
export const parseState = (raw) => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.projects) || !Array.isArray(parsed?.sessions)) return null;
    return parsed;
  } catch {
    return null;
  }
};

/**
 * Copies a value that could not be read to a key of its own, and reads the
 * copy back to prove it landed. Returns that key, or null if no copy could be
 * made — the usual reason being storage too full to hold the ledger twice.
 *
 * A copy an earlier load already made, of these exact bytes, is reused rather
 * than doubled: until something is saved over it, the unreadable value is
 * still there every time the app opens.
 */
const keepAside = async (backend, raw, at) => {
  try {
    for (const key of (await backend.keys?.()) ?? []) {
      if (key?.startsWith(UNREADABLE_PREFIX) && (await backend.get(key)) === raw) return key;
    }
    const key = UNREADABLE_PREFIX + new Date(at).toISOString();
    await backend.set(raw, key);
    return (await backend.get(key)) === raw ? key : null;
  } catch {
    return null;
  }
};

/**
 * A ledger that is stored but cannot be read is never written over.
 *
 * It used to be treated as absent: the app opened an empty ledger and the
 * first change saved that over the original for good. Cut-off JSON is usually
 * most of a ledger, and a shape this version does not recognise may be one a
 * later version wrote, so neither is safe to throw away.
 *
 * So `load` copies it aside before anything can be saved. If no copy can be
 * made, the store holds instead: every save is refused until `release()`,
 * which the app calls once the user has the value in a file of their own.
 */
export function createStore(backend = createBackend()) {
  let unreadable = null;
  let held = false;
  return {
    backend: backend.name,
    volatile: backend.name === "memory",
    /** `{ raw, keptAs, at }` when what was stored could not be read: the value
     *  exactly as found, the key its copy is under (null if there is none),
     *  and when it was found. Null when the load found a ledger or nothing. */
    get unreadable() { return unreadable; },
    /** True while a save would destroy the only copy of an unreadable value. */
    get held() { return held; },
    async load(at = Date.now()) {
      let raw;
      try {
        raw = await backend.get();
      } catch {
        return null;
      }
      const state = parseState(raw);
      if (state || !raw) return state;
      const keptAs = await keepAside(backend, raw, at);
      unreadable = { raw, keptAs, at };
      held = keptAs === null;
      return null;
    },
    release() { held = false; },
    /** Returns false rather than throwing — a failed save must surface in the
     *  UI, not take the app down mid-session. */
    async save(state) {
      if (held) return false;
      try {
        await backend.set(JSON.stringify(state));
        return true;
      } catch {
        return false;
      }
    },
  };
}
