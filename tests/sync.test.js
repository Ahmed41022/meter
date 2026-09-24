/**
 * The sync transport, with no network and no Google account.
 *
 * `fetch` and the token source are arguments to the code under test, which is
 * what makes every branch here reachable — including the ones that only happen
 * when a token expires mid-sync or two devices write at once.
 */
import { describe, it, expect, vi } from "vitest";
import { FILE_NAME, SyncError, createDrive, syncOnce } from "../src/sync/drive.js";
import { SCOPE, createAuth, loadGis } from "../src/sync/google.js";
import { mergeState } from "../src/domain/merge.js";

const ok = (body, init = {}) => new Response(
  typeof body === "string" ? body : JSON.stringify(body),
  { status: 200, ...init },
);
const fail = (status, message = "nope") => new Response(
  JSON.stringify({ error: { message } }), { status },
);

const drive = (handler, token = "tok") =>
  createDrive({ getToken: async () => token, fetch: handler });

describe("talking to Drive", () => {
  it("looks for the file by name in the hidden app folder", async () => {
    const seen = [];
    const d = drive(async (url) => {
      seen.push(String(url));
      return ok({ files: [{ id: "f1", headRevisionId: "r1" }] });
    });
    const file = await d.find();
    expect(file).toMatchObject({ id: "f1", headRevisionId: "r1" });
    expect(seen[0]).toContain("spaces=appDataFolder");
    expect(seen[0]).toContain(encodeURIComponent(FILE_NAME));
    // URLSearchParams spells a space "+", not "%20".
    expect(seen[0]).toContain("trashed+%3D+false");
  });

  it("asks by name rather than a remembered id, so a reinstall finds the file", async () => {
    // Remembering an id locally would start a second ledger on a new device.
    const d = drive(async (url) => {
      expect(String(url)).toContain("q=");
      return ok({ files: [] });
    });
    expect(await d.find()).toBeNull();
  });

  it("takes the newest when a past race left two, and deletes neither", async () => {
    const calls = [];
    const d = drive(async (url, opt) => {
      calls.push([String(url), opt?.method ?? "GET"]);
      return ok({
        files: [
          { id: "old", modifiedTime: "2026-01-01T00:00:00Z" },
          { id: "new", modifiedTime: "2026-09-01T00:00:00Z" },
        ],
      });
    });
    expect((await d.find()).id).toBe("new");
    expect(calls.every(([, method]) => method === "GET")).toBe(true);
  });

  it("sends the token on every request", async () => {
    const d = drive(async (url, opt) => {
      expect(opt.headers.Authorization).toBe("Bearer tok");
      return ok({ files: [] });
    });
    await d.find();
  });

  it("reports an expired token as needing sign-in, not as a dead sync", async () => {
    for (const status of [401, 403]) {
      const d = drive(async () => fail(status, "expired"));
      await expect(d.find()).rejects.toMatchObject({ needsAuth: true, status });
    }
  });

  it("reports everything else as a failure to retry", async () => {
    const d = drive(async () => fail(500, "server sad"));
    await expect(d.find()).rejects.toMatchObject({ needsAuth: false, status: 500 });
    await expect(d.find()).rejects.toThrow(/server sad/);
  });

  it("refuses to sync when there is no token at all", async () => {
    const d = createDrive({ getToken: async () => null, fetch: async () => ok({}) });
    await expect(d.find()).rejects.toMatchObject({ needsAuth: true });
  });

  it("treats an unreadable file as an error rather than an empty ledger", async () => {
    // Parsing failure must never look like "Drive says you have no work".
    const d = drive(async () => ok("this is not json"));
    await expect(d.read("f1")).rejects.toBeInstanceOf(SyncError);
  });

  it("creates the file inside appDataFolder", async () => {
    let body = "";
    const d = drive(async (url, opt) => {
      body = opt.body;
      expect(String(url)).toContain("uploadType=multipart");
      expect(opt.method).toBe("POST");
      return ok({ id: "f1", headRevisionId: "r1" });
    });
    expect(await d.create('{"projects":[]}')).toMatchObject({ id: "f1" });
    expect(body).toContain('"parents":["appDataFolder"]');
    expect(body).toContain('"name":"meter.json"');
  });

  it("updates in place, keeping the same file", async () => {
    const d = drive(async (url, opt) => {
      expect(String(url)).toContain("/f1?uploadType=media");
      expect(opt.method).toBe("PATCH");
      return ok({ id: "f1", headRevisionId: "r2" });
    });
    expect(await d.update("f1", "{}")).toMatchObject({ headRevisionId: "r2" });
  });
});

describe("one round of syncing", () => {
  const rec = (id, updatedAt) => ({ id, updatedAt });
  const ledger = (over = {}) => ({
    projects: [], sessions: [], objectives: [], earnings: [], ...over,
  });
  const stub = ({ file = null, remote = null, onUpdate } = {}) => ({
    find: async () => file,
    read: async () => remote,
    create: vi.fn(async () => ({ id: "f1", headRevisionId: "r1" })),
    update: vi.fn(async (id, text) => { onUpdate?.(text); return { headRevisionId: "r2" }; }),
  });

  it("creates the file on a Drive that has never synced", async () => {
    const d = stub();
    const local = ledger({ sessions: [rec("s1", 5)] });
    const out = await syncOnce({ drive: d, local, merge: mergeState });
    expect(d.create).toHaveBeenCalledOnce();
    expect(out).toMatchObject({ created: true, pushed: true, pulled: false });
    expect(out.state).toBe(local);
  });

  it("reads before it writes, so it cannot overwrite unseen work", async () => {
    const order = [];
    const d = {
      find: async () => { order.push("find"); return { id: "f1", headRevisionId: "r1" }; },
      read: async () => { order.push("read"); return ledger({ sessions: [rec("theirs", 9)] }); },
      create: async () => ({}),
      update: async () => { order.push("update"); return { headRevisionId: "r2" }; },
    };
    await syncOnce({ drive: d, local: ledger({ sessions: [rec("mine", 9)] }), merge: mergeState });
    expect(order).toEqual(["find", "read", "update"]);
  });

  it("keeps both devices' work", async () => {
    let written = null;
    const d = stub({
      file: { id: "f1", headRevisionId: "r1" },
      remote: ledger({ sessions: [rec("phone", 2)] }),
      onUpdate: (text) => { written = JSON.parse(text); },
    });
    const out = await syncOnce({
      drive: d, local: ledger({ sessions: [rec("desk", 1)] }), merge: mergeState,
    });
    expect(out.state.sessions.map((s) => s.id)).toEqual(["desk", "phone"]);
    expect(written.sessions.map((s) => s.id)).toEqual(["desk", "phone"]);
    expect(out).toMatchObject({ pushed: true, pulled: true });
  });

  it("writes nothing when the two copies already agree", async () => {
    // A sync that says it found nothing to do is the most reassuring outcome,
    // and churning the file on every open would cost a revision each time.
    const same = ledger({ sessions: [rec("s1", 5)] });
    const d = stub({ file: { id: "f1", headRevisionId: "r1" }, remote: same });
    const out = await syncOnce({ drive: d, local: same, merge: mergeState });
    expect(d.update).not.toHaveBeenCalled();
    expect(out).toMatchObject({ pushed: false, pulled: false });
  });

  it("pulls without pushing when this device only received", async () => {
    const d = stub({
      file: { id: "f1", headRevisionId: "r1" },
      remote: ledger({ sessions: [rec("s1", 5), rec("s2", 6)] }),
    });
    const out = await syncOnce({
      drive: d, local: ledger({ sessions: [rec("s1", 5)] }), merge: mergeState,
    });
    expect(d.update).not.toHaveBeenCalled();
    expect(out).toMatchObject({ pushed: false, pulled: true });
    expect(out.state.sessions).toHaveLength(2);
  });

  it("notices that someone else wrote since this device last looked", async () => {
    const d = stub({
      file: { id: "f1", headRevisionId: "r9" },
      remote: ledger({ sessions: [rec("theirs", 2)] }),
    });
    const out = await syncOnce({
      drive: d, local: ledger({ sessions: [rec("mine", 1)] }), merge: mergeState, revision: "r1",
    });
    expect(out.raced).toBe(true);
    // and it still kept both, which is why a race is worth reporting not fearing
    expect(out.state.sessions).toHaveLength(2);
  });

  it("returns the new revision, so the next sync can tell a race from calm", async () => {
    const d = stub({
      file: { id: "f1", headRevisionId: "r1" },
      remote: ledger({ sessions: [rec("theirs", 2)] }),
    });
    const out = await syncOnce({
      drive: d, local: ledger({ sessions: [rec("mine", 1)] }), merge: mergeState, revision: "r1",
    });
    expect(out.revision).toBe("r2");
    expect(out.raced).toBe(false);
  });
});

describe("holding a Google token", () => {
  /** A fake GIS that hands out tokens without a browser or an account. */
  const fakeGoogle = (behaviour) => {
    const client = { callback: () => {}, requestAccessToken: () => {} };
    client.requestAccessToken = (opts) => behaviour(client, opts);
    return {
      accounts: {
        oauth2: {
          initTokenClient: () => client,
          revoke: (t, done) => done?.({ successful: true }),
        },
      },
      __client: client,
    };
  };
  const auth = (behaviour, { now } = {}) => {
    const google = fakeGoogle(behaviour);
    let clock = 1_000_000;
    return {
      google,
      tick: (ms) => { clock += ms; },
      api: createAuth({
        clientId: "cid", load: async () => google, now: now ?? (() => clock),
      }),
    };
  };
  const grants = (value = "tok", expires = 3600) => (client) =>
    client.callback({ access_token: value, expires_in: expires });

  it("asks for only the hidden app folder", () => {
    expect(SCOPE).toBe("https://www.googleapis.com/auth/drive.appdata");
  });

  it("hands out a token and then reuses it", async () => {
    let asked = 0;
    const { api } = auth((client) => { asked += 1; grants()(client); });
    expect(await api.getToken()).toBe("tok");
    expect(await api.getToken()).toBe("tok");
    expect(asked).toBe(1);
    expect(api.hasToken()).toBe(true);
  });

  it("renews before expiry rather than at it", async () => {
    // A token that dies mid-request reads to the user as a sync that failed for
    // no reason.
    let asked = 0;
    const { api, tick } = auth((client) => { asked += 1; grants(`t${asked}`, 300)(client); });
    expect(await api.getToken()).toBe("t1");
    tick(200_000); // 100s left of a 300s token: inside the early-renewal window
    expect(await api.getToken()).toBe("t2");
    expect(asked).toBe(2);
  });

  it("stays quiet in the background instead of popping a dialog", async () => {
    // A background sync must not throw a consent window at someone who did not
    // press anything.
    const { api } = auth((client) => client.callback({ error: "interaction_required" }));
    expect(await api.getToken()).toBeNull();
  });

  it("surfaces the failure when the user did press the button", async () => {
    const { api } = auth((client) => client.callback({
      error: "access_denied", error_description: "user said no",
    }));
    await expect(api.signIn()).rejects.toThrow(/user said no/);
  });

  it("never runs two consent requests at once", async () => {
    // The second popup would be blocked by the browser.
    let asked = 0;
    const { api } = auth((client) => {
      asked += 1;
      setTimeout(() => grants()(client), 5);
    });
    const [a, b] = await Promise.all([api.getToken(), api.getToken()]);
    expect([a, b]).toEqual(["tok", "tok"]);
    expect(asked).toBe(1);
  });

  it("really lets go on sign-out", async () => {
    const { api } = auth(grants());
    await api.getToken();
    expect(api.hasToken()).toBe(true);
    await api.signOut();
    expect(api.hasToken()).toBe(false);
  });

  it("does not cache a failed script load", async () => {
    // Someone who fixes their connection and presses again must get a fresh try.
    const win = {
      google: undefined,
      document: {
        head: { appendChild: (el) => setTimeout(() => el.onerror(), 0) },
        createElement: () => ({}),
      },
    };
    await expect(loadGis(win, "x")).rejects.toThrow(/Could not reach/);
    expect(win.__meterGis).toBeNull();
  });

  it("gives up on a script that never loads and never errors", async () => {
    // A tracker blocker does exactly that: the tag is appended, nothing happens,
    // and without a timeout the sign-in button spins for ever with no reason.
    const win = {
      google: undefined,
      document: { head: { appendChild: () => {} }, createElement: () => ({}) },
    };
    await expect(loadGis(win, "x", 10)).rejects.toThrow(/blocker or a firewall/);
    expect(win.__meterGis).toBeNull();
  });

  it("loads the script once for many callers", async () => {
    let made = 0;
    const win = {
      google: undefined,
      document: {
        head: {
          appendChild: (el) => setTimeout(() => {
            win.google = { accounts: { oauth2: {} } };
            el.onload();
          }, 0),
        },
        createElement: () => { made += 1; return {}; },
      },
    };
    const [a, b] = await Promise.all([loadGis(win, "x"), loadGis(win, "x")]);
    expect(a).toBe(b);
    expect(made).toBe(1);
  });
});
