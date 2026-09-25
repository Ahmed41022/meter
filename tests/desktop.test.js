/**
 * The desktop quit-guard reads persisted state directly rather than going
 * through the domain layer, because the Electron main process can't import
 * the app's ES modules. That duplication is exactly why it needs testing:
 * nothing else would notice if it drifted from the real rule.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const { hasRunningSession, STORE_KEY } = req("../desktop/running.js");
const { migrationPlan, readScript, writeScript } = req("../desktop/migrate.js");
const { start, createServer, PORT, MARKER } = req("../desktop/server.js");
const { isSignIn } = req("../desktop/popup.js");

const session = (over = {}) => ({
  id: "s1", projectId: "p1", deletedAt: null,
  segments: [{ startedAt: 1, endedAt: 2 }],
  ...over,
});

describe("detecting a running meter before quitting", () => {
  it("spots a segment still accruing", () => {
    const state = { sessions: [session({ segments: [{ startedAt: 1, endedAt: null }] })] };
    expect(hasRunningSession(JSON.stringify(state))).toBe(true);
  });

  it("accepts an object as well as a JSON string", () => {
    expect(hasRunningSession({ sessions: [session({ segments: [{ startedAt: 1, endedAt: null }] })] }))
      .toBe(true);
  });

  it("does not count a session that was only paused", () => {
    // Paused means every segment is closed, even though the session is open.
    const state = { sessions: [session({ closedAt: null })] };
    expect(hasRunningSession(JSON.stringify(state))).toBe(false);
  });

  it("does not count a stopped session", () => {
    expect(hasRunningSession(JSON.stringify({ sessions: [session({ closedAt: 2 })] }))).toBe(false);
  });

  it("ignores a deleted session that was left running", () => {
    const state = {
      sessions: [session({ deletedAt: 5, segments: [{ startedAt: 1, endedAt: null }] })],
    };
    expect(hasRunningSession(JSON.stringify(state))).toBe(false);
  });

  it("finds a running session among stopped ones", () => {
    const state = {
      sessions: [
        session({ closedAt: 2 }),
        session({ id: "s2", segments: [{ startedAt: 3, endedAt: null }] }),
      ],
    };
    expect(hasRunningSession(JSON.stringify(state))).toBe(true);
  });
});

describe("never trapping the user in the app", () => {
  it("says no on corrupt, empty or missing storage", () => {
    // Any doubt resolves to "not running" so the window always closes.
    for (const bad of ["{not json", "", null, undefined, "null", "[]", "{}"]) {
      expect(hasRunningSession(bad)).toBe(false);
    }
  });

  it("says no when sessions is the wrong shape", () => {
    expect(hasRunningSession(JSON.stringify({ sessions: "nope" }))).toBe(false);
    expect(hasRunningSession(JSON.stringify({ sessions: [{ id: "s1" }] }))).toBe(false);
  });

  it("uses the same storage key the app writes to", () => {
    expect(STORE_KEY).toBe("meter:v1");
  });
});

describe("carrying the ledger to the served origin", () => {
  const LEDGER = "meter:v1";
  const CLIENT = "meter:google-client";

  it("copies both keys into an empty store", () => {
    expect(migrationPlan({}, { [LEDGER]: "{}", [CLIENT]: "cid" }))
      .toEqual([[LEDGER, "{}"], [CLIENT, "cid"]]);
  });

  it("refuses to touch a store that already has a ledger", () => {
    // The live one. Overwriting it with a copy frozen at the day of the move is
    // the single worst thing this code could do.
    expect(migrationPlan({ [LEDGER]: "new" }, { [LEDGER]: "old" })).toEqual([]);
  });

  it("does not treat a client id as a ledger", () => {
    // Configuration is not work: a store holding only a client id is still empty.
    expect(migrationPlan({ [CLIENT]: "cid" }, { [LEDGER]: "old" }))
      .toEqual([[LEDGER, "old"]]);
    expect(migrationPlan({}, { [CLIENT]: "cid" })).toEqual([]);
  });

  it("leaves a client id already chosen here alone", () => {
    expect(migrationPlan({ [CLIENT]: "mine" }, { [LEDGER]: "old", [CLIENT]: "theirs" }))
      .toEqual([[LEDGER, "old"]]);
  });

  it("carries nothing it was not asked to carry", () => {
    const plan = migrationPlan({}, { [LEDGER]: "{}", "something:else": "no" });
    expect(plan.map(([k]) => k)).toEqual([LEDGER]);
  });

  it("treats an empty string as nothing", () => {
    expect(migrationPlan({ [LEDGER]: "" }, { [LEDGER]: "real" })).toEqual([[LEDGER, "real"]]);
    expect(migrationPlan({}, { [LEDGER]: "" })).toEqual([]);
  });

  /** The scripts run in a renderer, so they are strings here. Evaluating them
   *  against a fake store is the only way to know they are valid JS at all. */
  const run = (src, store) => {
    const localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
    };
    return new Function("localStorage", `return ${src}`)(localStorage);
  };

  it("reads only the keys it carries", () => {
    const store = { [LEDGER]: "{}", [CLIENT]: "cid", other: "x" };
    expect(run(readScript(), store)).toEqual({ [LEDGER]: "{}", [CLIENT]: "cid" });
  });

  it("writes what the plan asked for", () => {
    const store = {};
    expect(run(writeScript([[LEDGER, "{}"], [CLIENT, "cid"]]), store)).toBe(2);
    expect(store).toEqual({ [LEDGER]: "{}", [CLIENT]: "cid" });
  });

  it("survives a store that throws on every access", () => {
    // Blocked site data throws on access rather than returning empty, and a
    // migration that crashes would take the whole launch with it.
    const blocked = { getItem: () => { throw new Error("blocked"); },
                      setItem: () => { throw new Error("blocked"); } };
    const evaluate = (src) => new Function("localStorage", `return ${src}`)(blocked);
    expect(evaluate(readScript())).toEqual({});
    expect(evaluate(writeScript([[LEDGER, "{}"]]))).toBe(0);
  });
});

describe("serving the app on loopback", () => {
  const page = new URL("../desktop/bridge.html", import.meta.url).pathname.replace(/^\//, "");

  const listening = async () => start({ "/": page, "/bridge": page }, { port: 0 });

  it("serves a mapped route and names itself in the headers", async () => {
    const s = await listening();
    try {
      const res = await fetch(`${s.origin}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get(MARKER)).toBe("1");
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      // A cached copy would be yesterday's app reading today's ledger.
      expect(res.headers.get("cache-control")).toBe("no-store");
    } finally {
      await s.close();
    }
  });

  it("answers nothing outside its map", async () => {
    const s = await listening();
    try {
      // There is no directory behind this, so there is no path to climb out of.
      for (const path of ["/nope", "/../running.js", "/meter.html"]) {
        expect((await fetch(`${s.origin}${path}`)).status).toBe(404);
      }
    } finally {
      await s.close();
    }
  });

  it("ignores a query string when matching", async () => {
    const s = await listening();
    try {
      expect((await fetch(`${s.origin}/bridge?x=1`)).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it("refuses anything but a read", async () => {
    const s = await listening();
    try {
      const res = await fetch(`${s.origin}/`, { method: "POST" });
      expect(res.status).toBe(405);
    } finally {
      await s.close();
    }
  });

  it("reports a taken port rather than quietly moving", async () => {
    // Moving would open a second, empty localStorage and strand the real
    // ledger on the old origin.
    const first = await listening();
    try {
      await expect(start({ "/": page }, { port: first.port })).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await first.close();
    }
  });

  it("keeps the fixed port below the ephemeral range", () => {
    // Above 49152 Windows may hand it out to something else between launches,
    // and the port is part of the origin Google authorises.
    expect(PORT).toBeLessThan(49152);
    expect(createServer({ "/": page })).toBeDefined();
  });
});

describe("which pop-ups stay inside the app", () => {
  it("keeps Google's sign-in window as a child of the app", () => {
    // It hands the token back by talking to the window that opened it. Sent to
    // the system browser there is no such window, and the token arrives nowhere.
    expect(isSignIn("https://accounts.google.com/o/oauth2/auth?client_id=x")).toBe(true);
  });

  it("sends everything else to the real browser", () => {
    expect(isSignIn("https://github.com/Ahmed41022/meter")).toBe(false);
    expect(isSignIn("https://console.cloud.google.com/apis")).toBe(false);
  });

  it("is not fooled by a host that merely contains the name", () => {
    expect(isSignIn("https://accounts.google.com.example.com/o/oauth2/auth")).toBe(false);
    expect(isSignIn("https://evil.com/?x=accounts.google.com")).toBe(false);
  });

  it("refuses a sign-in offered over anything but https", () => {
    expect(isSignIn("http://accounts.google.com/o/oauth2/auth")).toBe(false);
  });

  it("treats anything unparseable as a link, not a sign-in", () => {
    for (const bad of ["", "not a url", "javascript:alert(1)", null, undefined]) {
      expect(isSignIn(bad)).toBe(false);
    }
  });
});
