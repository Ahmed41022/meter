import { describe, it, expect, vi } from "vitest";
import { createBackend, createStore, parseState, STORE_KEY } from "../src/storage/store.js";

const fakeLocalStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
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
