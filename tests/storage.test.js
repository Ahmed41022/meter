import { describe, it, expect, vi } from "vitest";
import {
  createBackend, createStore, parseState, STORE_KEY, UNREADABLE_PREFIX,
} from "../src/storage/store.js";
import { SETTING, deviceId, loadSetting } from "../src/storage/settings.js";

const fakeLocalStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
  };
};

describe("backend selection", () => {
  it("prefers the artifact API when present", () => {
    const win = { storage: { get: vi.fn(), set: vi.fn() }, localStorage: fakeLocalStorage() };
    expect(createBackend(win).name).toBe("artifact");
  });

  it("falls back to localStorage", () => {
    expect(createBackend({ localStorage: fakeLocalStorage() }).name).toBe("local");
  });

  it("falls back to memory when storage is blocked, and says so", () => {
    const blocked = { localStorage: { setItem: () => { throw new Error("denied"); } } };
    const store = createStore(createBackend(blocked));
    expect(store.backend).toBe("memory");
    // This flag is what drives the "nothing is being saved" warning. Without
    // it the memory backend reports success and the user loses everything.
    expect(store.volatile).toBe(true);
  });
});

describe("round trip", () => {
  it("saves and reloads state", async () => {
    const store = createStore(createBackend({ localStorage: fakeLocalStorage() }));
    const state = { projects: [{ id: "p1", name: "A" }], sessions: [] };
    expect(await store.save(state)).toBe(true);
    expect(await store.load()).toEqual(state);
  });

  it("returns null for a fresh install", async () => {
    const store = createStore(createBackend({ localStorage: fakeLocalStorage() }));
    expect(await store.load()).toBeNull();
  });

  it("writes under the versioned key so a future schema can migrate", async () => {
    const ls = fakeLocalStorage();
    await createStore(createBackend({ localStorage: ls })).save({ projects: [], sessions: [] });
    expect(ls.getItem(STORE_KEY)).toBeTruthy();
    expect(STORE_KEY).toMatch(/:v\d+$/);
  });
});

describe("resilience", () => {
  it("treats corrupt JSON as absent instead of crashing on boot", () => {
    expect(parseState("{not json")).toBeNull();
  });

  it("rejects well-formed JSON of the wrong shape", () => {
    expect(parseState('{"foo":1}')).toBeNull();
    expect(parseState('{"projects":"nope","sessions":[]}')).toBeNull();
  });

  it("reports a write failure instead of throwing", async () => {
    const quotaFull = {
      localStorage: {
        setItem: vi.fn((k) => { if (k !== "__meter_probe__") throw new Error("QuotaExceeded"); }),
        getItem: () => null,
        removeItem: () => {},
      },
    };
    const store = createStore(createBackend(quotaFull));
    expect(await store.save({ projects: [], sessions: [] })).toBe(false);
  });
});

describe("artifact backend", () => {
  it("reads and writes through the artifact storage API", async () => {
    const held = new Map();
    const win = {
      storage: {
        get: async (k) => (held.has(k) ? { value: held.get(k) } : null),
        set: async (k, v) => held.set(k, v),
      },
    };
    const store = createStore(createBackend(win));
    expect(store.backend).toBe("artifact");
    expect(store.volatile).toBe(false);
    await store.save({ projects: [], sessions: [] });
    expect(await store.load()).toEqual({ projects: [], sessions: [] });
  });

  it("returns null when the artifact API has no entry yet", async () => {
    const win = { storage: { get: async () => null, set: async () => {} } };
    expect(await createStore(createBackend(win)).load()).toBeNull();
  });

  it("survives a backend that throws on read", async () => {
    const backend = { name: "flaky", get: async () => { throw new Error("boom"); }, set: async () => {} };
    expect(await createStore(backend).load()).toBeNull();
  });
});

describe("a stored ledger that cannot be read", () => {
  // Most of a real ledger, cut off mid-record: what a crash during a write or a
  // botched hand edit leaves behind.
  const CUT = '{"projects":[{"id":"p1","name":"Orion"}],"sessions":[{"id":"s1","projectId":"p1"';
  const AT = Date.UTC(2026, 9, 6, 8, 30);
  const asides = (ls) => Array.from({ length: ls.length }, (_, i) => ls.key(i))
    .filter((k) => k.startsWith(UNREADABLE_PREFIX));
  const holding = (raw) => {
    const ls = fakeLocalStorage();
    ls.setItem(STORE_KEY, raw);
    return ls;
  };

  it("is copied aside, byte for byte, before anything can be saved over it", async () => {
    const ls = holding(CUT);
    const store = createStore(createBackend({ localStorage: ls }));
    expect(await store.load(AT)).toBeNull();
    expect(store.unreadable).toEqual({
      raw: CUT, keptAs: `${UNREADABLE_PREFIX}2026-10-06T08:30:00.000Z`, at: AT,
    });
    expect(ls.getItem(store.unreadable.keptAs)).toBe(CUT);
    // The load itself writes nothing over the original.
    expect(ls.getItem(STORE_KEY)).toBe(CUT);
  });

  it("lets the new ledger be saved once the copy is safe, and never touches the copy", async () => {
    const ls = holding(CUT);
    const store = createStore(createBackend({ localStorage: ls }));
    await store.load(AT);
    expect(store.held).toBe(false);
    expect(await store.save({ projects: [{ id: "new" }], sessions: [] })).toBe(true);
    expect(JSON.parse(ls.getItem(STORE_KEY)).projects[0].id).toBe("new");
    expect(ls.getItem(store.unreadable.keptAs)).toBe(CUT);
  });

  it("counts well-formed JSON of the wrong shape as unreadable, not as nothing", async () => {
    // No sessions array. Opening this as an empty ledger is what threw the
    // original away: the first change saved a 221-byte ledger over it.
    const ls = holding('{"projects":[{"id":"p1"}]}');
    const store = createStore(createBackend({ localStorage: ls }));
    await store.load(AT);
    expect(store.unreadable.keptAs).toBeTruthy();
    expect(ls.getItem(store.unreadable.keptAs)).toBe('{"projects":[{"id":"p1"}]}');
  });

  it("is not copied again every time the app opens", async () => {
    // Until something is saved, the bad value is still there on every launch,
    // and a fresh copy each time would fill storage with the same bytes.
    const ls = holding(CUT);
    const first = createStore(createBackend({ localStorage: ls }));
    await first.load(AT);
    const second = createStore(createBackend({ localStorage: ls }));
    await second.load(AT + 60_000);
    expect(second.unreadable.keptAs).toBe(first.unreadable.keptAs);
    expect(asides(ls)).toHaveLength(1);
  });

  it("refuses every save while no copy could be kept, until released", async () => {
    // Storage too full to hold the ledger twice. The original is then the only
    // copy there is, so nothing may be written over it until the user has it
    // in a file.
    const ls = holding(CUT);
    const full = {
      ...ls,
      get length() { return ls.length; },
      setItem: (k, v) => {
        if (k.startsWith(UNREADABLE_PREFIX)) throw new Error("QuotaExceededError");
        ls.setItem(k, v);
      },
    };
    const store = createStore(createBackend({ localStorage: full }));
    await store.load(AT);
    expect(store.unreadable).toMatchObject({ raw: CUT, keptAs: null });
    expect(store.held).toBe(true);
    expect(await store.save({ projects: [], sessions: [] })).toBe(false);
    expect(ls.getItem(STORE_KEY)).toBe(CUT);

    store.release();
    expect(await store.save({ projects: [], sessions: [] })).toBe(true);
    expect(ls.getItem(STORE_KEY)).toBe('{"projects":[],"sessions":[]}');
  });

  it("keeps it aside through the artifact storage API as well", async () => {
    const held = new Map([[STORE_KEY, CUT]]);
    const win = {
      storage: {
        get: async (k) => (held.has(k) ? { value: held.get(k) } : null),
        set: async (k, v) => held.set(k, v),
      },
    };
    const store = createStore(createBackend(win));
    await store.load(AT);
    expect(held.get(store.unreadable.keptAs)).toBe(CUT);
    expect(store.held).toBe(false);
  });

  it("reports nothing for a readable ledger or an empty store", async () => {
    const fine = createStore(createBackend({ localStorage: holding('{"projects":[],"sessions":[]}') }));
    await fine.load(AT);
    expect(fine.unreadable).toBeNull();
    const fresh = createStore(createBackend({ localStorage: fakeLocalStorage() }));
    await fresh.load(AT);
    expect(fresh.unreadable).toBeNull();
    expect(fresh.held).toBe(false);
  });
});

describe("which device this is", () => {
  it("mints one once and keeps giving the same answer", () => {
    const win = { localStorage: fakeLocalStorage() };
    const first = deviceId(win);
    expect(first).toBeTruthy();
    expect(deviceId(win)).toBe(first);
    expect(loadSetting(SETTING.DEVICE, "", win)).toBe(first);
  });

  it("gives two devices two names", () => {
    expect(deviceId({ localStorage: fakeLocalStorage() }))
      .not.toBe(deviceId({ localStorage: fakeLocalStorage() }));
  });

  it("never lands in the ledger", () => {
    // It is the one fact about a device that must not travel with the data:
    // its whole job is to tell this copy apart from the others.
    const win = { localStorage: fakeLocalStorage() };
    deviceId(win);
    expect(SETTING.DEVICE).not.toBe(STORE_KEY);
    expect(win.localStorage.getItem(STORE_KEY)).toBeNull();
  });

  it("still answers where storage cannot be written", () => {
    // A private window throws on access. A device with no name at all would
    // make every session look like somebody else's.
    const blocked = {
      localStorage: {
        getItem: () => { throw new Error("denied"); },
        setItem: () => { throw new Error("denied"); },
        removeItem: () => {},
      },
    };
    expect(deviceId(blocked)).toBeTruthy();
  });
});
