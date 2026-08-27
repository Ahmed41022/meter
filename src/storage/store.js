/**
 * The only module that knows where data lives. Swap `createBackend` for
 * IndexedDB or an HTTP client and nothing above this file changes.
 */

export const STORE_KEY = "meter:v1";
export const EMPTY = { projects: [], sessions: [] };

/** Picks a backend once, at load. Exposed as `name` so the UI can warn the
 *  user when storage is volatile — a silent memory fallback loses a day's work
 *  without ever reporting a failure. */
export function createBackend(win = typeof window !== "undefined" ? window : undefined) {
  if (win?.storage?.get) {
    return {
      name: "artifact",
      get: async () => (await win.storage.get(STORE_KEY, false))?.value ?? null,
      set: async (v) => { await win.storage.set(STORE_KEY, v, false); },
    };
  }
  try {
    const probe = "__meter_probe__";
    win.localStorage.setItem(probe, "1");
    win.localStorage.removeItem(probe);
    return {
      name: "local",
      get: async () => win.localStorage.getItem(STORE_KEY),
      set: async (v) => win.localStorage.setItem(STORE_KEY, v),
    };
  } catch {
    let held = null;
    return { name: "memory", get: async () => held, set: async (v) => { held = v; } };
  }
}

/** Anything that isn't a well-formed store is treated as absent. Better to
 *  start clean than to crash on boot with corrupt data. */
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

export function createStore(backend = createBackend()) {
  return {
    backend: backend.name,
    volatile: backend.name === "memory",
    async load() {
      try {
        return parseState(await backend.get()) ?? null;
      } catch {
        return null;
      }
    },
    /** Returns false rather than throwing — a failed save must surface in the
     *  UI, not take the app down mid-session. */
    async save(state) {
      try {
        await backend.set(JSON.stringify(state));
        return true;
      } catch {
        return false;
      }
    },
  };
}
