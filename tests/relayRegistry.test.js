import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, createRegistry } from "../relay/registry.js";
import { verifyVaultId } from "../relay/ids.js";
import { sha256b64u } from "../relay/util.js";
import { isVaultId, parseInviteCode } from "../src/sync/codes.js";
import { openSql, seededRandom } from "./relaySql.js";

const DAY = 86_400_000;
const ADMIN = "admin-token-0123456789abcdef";
const ROUTE = "route-key-0123456789abcdef";

async function world(options = {}) {
  const { defaults = {}, hooks = {} } = options;
  // `adminToken: undefined` is a case under test, so absence is checked by key.
  const adminToken = "adminToken" in options ? options.adminToken : ADMIN;
  const db = await openSql();
  const clock = { t: Date.UTC(2026, 0, 5, 12, 0, 0) };
  const make = () => createRegistry({
    sql: db.sql, transaction: db.transaction, now: () => clock.t, random: seededRandom(11),
    adminToken, routeKey: ROUTE, defaults, hooks,
  });
  return { ...db, clock, hooks, core: make(), make };
}

const pad = (s, n = 43) => s.padEnd(n, "x");
const pub = (n) => ({ kty: "EC", crv: "P-256", x: pad(`px${n}`), y: pad(`py${n}`) });

/** What a client sends to make a vault: its own token hash, key, name and recovery hash. */
async function body(n, extra = {}) {
  return {
    tokenHash: await sha256b64u(pad(`token${n}`)), pubkey: pub(n), nameCt: "name",
    recoverHash: await sha256b64u(`recover${n}`), deviceId: String(n).padStart(16, "a"), ...extra,
  };
}

const call = (w, method, path, { body: b, token, ip, trusted = false, headers = {} } = {}) =>
  w.core.handle({
    method, path, body: b, ip,
    headers: { ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }), ...headers },
  }, { trusted });
const admin = (w, method, path, b) => call(w, method, path, { body: b, token: ADMIN });
const create = (w, n, extra = {}, opts = {}) => (async () => call(w, "POST", "/vaults", { body: await body(n, extra), ...opts }))();

async function invite(w, label = "Sara", days) {
  const res = await admin(w, "POST", "/admin/invite", { label, days });
  expect(res.status).toBe(200);
  return res.body;
}

describe("admin authentication", () => {
  it("accepts only the ADMIN_TOKEN as a bearer token", async () => {
    const w = await world();
    expect((await admin(w, "GET", "/admin/invites")).status).toBe(200);
    expect((await call(w, "GET", "/admin/invites")).status).toBe(401);
    expect((await call(w, "GET", "/admin/invites", { token: pad("not-the-admin-token") })).status).toBe(401);
    expect((await call(w, "GET", "/admin/invites", { token: `${ADMIN}x` })).status).toBe(401);
    expect((await call(w, "GET", "/admin/invites", { headers: { Authorization: ADMIN } })).status).toBe(401);
  });

  it("is switched off, not open, when no real secret is set", async () => {
    for (const adminToken of [undefined, "", "short"]) {
      const w = await world({ adminToken });
      expect((await call(w, "GET", "/admin/invites", { token: adminToken ?? "x".repeat(20) })).status).toBe(503);
    }
  });

  it("locks out a guesser after twenty failures for fifteen minutes, then lets the real token back in", async () => {
    const w = await world();
    for (let i = 0; i < 20; i += 1) await call(w, "GET", "/admin/invites", { token: pad(`guess${i}`) });
    expect((await call(w, "GET", "/admin/invites", { token: pad("guess-again") })).status).toBe(429);
    expect((await admin(w, "GET", "/admin/invites")).status).toBe(429);
    w.clock.t += 16 * 60_000;
    expect((await admin(w, "GET", "/admin/invites")).status).toBe(200);
  });

  it("covers every admin route", async () => {
    const w = await world();
    for (const [m, p] of [["POST", "/admin/invite"], ["GET", "/admin/invites"], ["POST", "/admin/revoke-invite"],
      ["GET", "/admin/stats"], ["POST", "/admin/delete-vault"], ["GET", "/admin/config"], ["POST", "/admin/config"]]) {
      expect((await call(w, m, p, { body: {} })).status).toBe(401);
    }
  });
});

describe("info", () => {
  it("says the protocol version and whether open sign-up is on, and nothing else", async () => {
    const w = await world();
    expect(await call(w, "GET", "/info")).toEqual({ status: 200, body: { v: 1, open: false } });
    await admin(w, "POST", "/admin/config", { openSignup: true });
    expect((await call(w, "GET", "/info")).body.open).toBe(true);
  });
});

describe("invites", () => {
  it("are made with a code the client can parse, shown once, and stored only as a hash", async () => {
    const w = await world();
    const inv = await invite(w, "Sara", 3);
    expect(inv.code).toMatch(/^MTR-[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(parseInviteCode(inv.code)).toBe(inv.code);
    expect(inv.expiresAt).toBe(w.clock.t + 3 * DAY);
    const dump = JSON.stringify(w.sql.exec("SELECT * FROM invites").toArray());
    expect(dump).not.toContain(inv.code);
    expect(dump).toContain(await sha256b64u(inv.code));
    const list = (await admin(w, "GET", "/admin/invites")).body.invites;
    expect(list).toEqual([{
      id: inv.id, label: "Sara", createdAt: w.clock.t, expiresAt: inv.expiresAt, usedAt: null, vaultId: null, status: "active",
    }]);
  });

  it("default to seven days, and refuse nonsense", async () => {
    const w = await world();
    expect((await invite(w)).expiresAt).toBe(w.clock.t + 7 * DAY);
    for (const bad of [{ days: 0 }, { days: 400 }, { days: 1.5 }, { label: "x".repeat(81) }, { label: 5 }]) {
      expect((await admin(w, "POST", "/admin/invite", bad)).status).toBe(400);
    }
  });

  it("make a vault once: the id is signed, the invite is spent and bound to the vault", async () => {
    const w = await world();
    const inv = await invite(w);
    const res = await create(w, 1, { invite: inv.code });
    expect(res.status).toBe(200);
    expect(isVaultId(res.body.vaultId)).toBe(true);
    expect(await verifyVaultId(ROUTE, res.body.vaultId)).toBe(true);
    const list = (await admin(w, "GET", "/admin/invites")).body.invites;
    expect(list[0]).toMatchObject({ status: "used", vaultId: res.body.vaultId, usedAt: w.clock.t });
  });

  it("refuse a second person, but give the same person the same vault again", async () => {
    const w = await world();
    const inv = await invite(w);
    const first = await create(w, 1, { invite: inv.code });
    expect(await create(w, 2, { invite: inv.code })).toEqual({ status: 409, body: { code: "invite_used" } });
    expect(await create(w, 1, { invite: inv.code })).toEqual(first);
    const count = (await admin(w, "GET", "/admin/stats")).body.vaults.count;
    expect(count).toBe(1);
  });

  it("answer a retry the same even after the invite expired or the cap was reached", async () => {
    const w = await world({ defaults: { maxVaults: 1 } });
    const inv = await invite(w, "Sara", 1);
    const first = await create(w, 1, { invite: inv.code });
    w.clock.t += 3 * DAY;
    expect(await create(w, 1, { invite: inv.code })).toEqual(first);
  });

  it("let exactly one of two simultaneous claims win", async () => {
    const w = await world();
    const inv = await invite(w);
    const results = await Promise.all([create(w, 1, { invite: inv.code }), create(w, 2, { invite: inv.code })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await admin(w, "GET", "/admin/stats")).body.vaults.count).toBe(1);
  });

  it("expire", async () => {
    const w = await world();
    const inv = await invite(w, "Sara", 1);
    w.clock.t += DAY;
    expect(await create(w, 1, { invite: inv.code })).toEqual({ status: 403, body: { code: "invite_expired" } });
    expect((await admin(w, "GET", "/admin/invites")).body.invites[0].status).toBe("expired");
  });

  it("can be revoked before use, by id, but not after", async () => {
    const w = await world();
    const a = await invite(w, "A");
    const b = await invite(w, "B");
    expect((await admin(w, "POST", "/admin/revoke-invite", { id: a.id })).status).toBe(200);
    expect(await create(w, 1, { invite: a.code })).toEqual({ status: 403, body: { code: "invite_revoked" } });
    expect((await admin(w, "GET", "/admin/invites")).body.invites.find((i) => i.id === a.id).status).toBe("revoked");
    await create(w, 2, { invite: b.code });
    expect((await admin(w, "POST", "/admin/revoke-invite", { id: b.id })).status).toBe(409);
    expect((await admin(w, "POST", "/admin/revoke-invite", { id: "nosuchid0000" })).status).toBe(404);
    expect((await admin(w, "POST", "/admin/revoke-invite", { id: "x" })).status).toBe(400);
  });

  it("are refused when unknown, malformed, or missing in closed mode", async () => {
    const w = await world();
    expect(await create(w, 1, { invite: "MTR-00000000000000000000" })).toEqual({ status: 403, body: { code: "invite_invalid" } });
    expect((await create(w, 1, { invite: "hello" })).body.code).toBe("invite_invalid");
    expect(await create(w, 1)).toEqual({ status: 403, body: { code: "invite_required" } });
  });

  it("are accepted as typed: any case, spaces and dashes", async () => {
    const w = await world();
    const inv = await invite(w);
    const typed = inv.code.toLowerCase().replace("mtr-", "mtr ").replace(/(.{5})/g, "$1 ");
    expect((await create(w, 1, { invite: typed })).status).toBe(200);
  });

  it("are not spent by a request that is refused for another reason", async () => {
    const w = await world();
    const inv = await invite(w);
    expect((await create(w, 1, { invite: inv.code, tokenHash: "bad" })).status).toBe(400);
    expect((await create(w, 1, { invite: inv.code, pubkey: {} })).status).toBe(400);
    expect((await admin(w, "GET", "/admin/invites")).body.invites[0].status).toBe("active");
    expect((await create(w, 1, { invite: inv.code })).status).toBe(200);
  });

  it("are not spent when the cap is reached, and work once it is raised", async () => {
    const w = await world({ defaults: { maxVaults: 1 } });
    const a = await invite(w, "A");
    const b = await invite(w, "B");
    await create(w, 1, { invite: a.code });
    expect(await create(w, 2, { invite: b.code })).toEqual({ status: 403, body: { code: "relay_full" } });
    expect((await admin(w, "GET", "/admin/invites")).body.invites.find((i) => i.id === b.id).status).toBe("active");
    await admin(w, "POST", "/admin/config", { maxVaults: 2 });
    expect((await create(w, 2, { invite: b.code })).status).toBe(200);
  });

  it("are rolled back whole when recording the vault fails", async () => {
    const w = await world();
    const inv = await invite(w);
    const real = w.sql.exec.bind(w.sql);
    w.sql.exec = (query, ...bind) => {
      if (/UPDATE invites SET used_at/.test(query)) throw new Error("disk full");
      return real(query, ...bind);
    };
    await expect(create(w, 1, { invite: inv.code })).rejects.toThrow("disk full");
    w.sql.exec = real;
    expect(w.sql.exec("SELECT COUNT(*) AS n FROM vaults").toArray()[0].n).toBe(0);
    expect((await create(w, 1, { invite: inv.code })).status).toBe(200);
  });

  it("do not bring a deleted vault back for a retry", async () => {
    const w = await world();
    const inv = await invite(w);
    const made = await create(w, 1, { invite: inv.code });
    await call(w, "POST", "/vault-deleted", { body: { vaultId: made.body.vaultId }, trusted: true });
    expect(await create(w, 1, { invite: inv.code })).toEqual({ status: 410, body: { code: "vault_deleted" } });
  });
});

describe("open sign-up", () => {
  const openWorld = (defaults = {}) => world({ defaults: { openSignup: true, ...defaults } });

  it("is off by default and flipped by an admin call without a redeploy", async () => {
    expect(DEFAULT_CONFIG.openSignup).toBe(false);
    const w = await world();
    expect((await create(w, 1)).status).toBe(403);
    await admin(w, "POST", "/admin/config", { openSignup: true });
    expect((await create(w, 1)).status).toBe(200);
    await admin(w, "POST", "/admin/config", { openSignup: false });
    expect((await create(w, 2)).status).toBe(403);
  });

  it("limits creations per address per day, and each address separately", async () => {
    const w = await openWorld();
    for (let i = 1; i <= 3; i += 1) expect((await create(w, i, {}, { ip: "203.0.113.7" })).status).toBe(200);
    const blocked = await create(w, 4, {}, { ip: "203.0.113.7" });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ code: "creation_limit", resetAt: (Math.floor(w.clock.t / DAY) + 1) * DAY });
    expect((await create(w, 5, {}, { ip: "203.0.113.8" })).status).toBe(200);
    w.clock.t += DAY;
    expect((await create(w, 6, {}, { ip: "203.0.113.7" })).status).toBe(200);
  });

  it("limits creations per day across everyone", async () => {
    const w = await openWorld({ dailyCreationCap: 2, ipDailyCap: 10 });
    expect((await create(w, 1, {}, { ip: "198.51.100.1" })).status).toBe(200);
    expect((await create(w, 2, {}, { ip: "198.51.100.2" })).status).toBe(200);
    expect((await create(w, 3, {}, { ip: "198.51.100.3" })).status).toBe(429);
    w.clock.t += DAY;
    expect((await create(w, 3, {}, { ip: "198.51.100.3" })).status).toBe(200);
  });

  it("answers a retry with the same vault without using up the allowance", async () => {
    const w = await openWorld({ ipDailyCap: 1 });
    const first = await create(w, 1, {}, { ip: "203.0.113.7" });
    expect(await create(w, 1, {}, { ip: "203.0.113.7" })).toEqual(first);
    expect((await create(w, 2, {}, { ip: "203.0.113.7" })).status).toBe(429);
  });

  it("keeps no address: only a salted hash, with a salt that changes each day", async () => {
    const w = await openWorld();
    await create(w, 1, {}, { ip: "203.0.113.7" });
    const dump = () => JSON.stringify([w.sql.exec("SELECT * FROM creations").toArray(), w.sql.exec("SELECT * FROM meta").toArray(), w.sql.exec("SELECT * FROM vaults").toArray()]);
    expect(dump()).not.toContain("203.0.113.7");
    const hash1 = w.sql.exec("SELECT ip_hash FROM creations").toArray()[0].ip_hash;
    const salt1 = w.sql.exec("SELECT v FROM meta WHERE k = 'ip_salt'").toArray()[0].v;
    w.clock.t += DAY;
    await create(w, 2, {}, { ip: "203.0.113.7" });
    const rows = w.sql.exec("SELECT ip_hash FROM creations").toArray();
    // Yesterday's row is gone, and today's hash of the same address differs.
    expect(rows).toHaveLength(1);
    expect(rows[0].ip_hash).not.toBe(hash1);
    expect(w.sql.exec("SELECT v FROM meta WHERE k = 'ip_salt'").toArray()[0].v).not.toBe(salt1);
  });

  it("still honours an invite, which does not count against the address limit", async () => {
    const w = await openWorld({ ipDailyCap: 1 });
    await create(w, 1, {}, { ip: "203.0.113.7" });
    const inv = await invite(w);
    expect((await create(w, 2, { invite: inv.code }, { ip: "203.0.113.7" })).status).toBe(200);
  });

  it("still respects the vault cap", async () => {
    const w = await openWorld({ maxVaults: 1 });
    await create(w, 1, {}, { ip: "203.0.113.1" });
    expect((await create(w, 2, {}, { ip: "203.0.113.2" })).body).toEqual({ code: "relay_full" });
  });

  it("treats a missing address as one shared bucket rather than no limit", async () => {
    const w = await openWorld({ ipDailyCap: 1 });
    expect((await create(w, 1)).status).toBe(200);
    expect((await create(w, 2)).status).toBe(429);
  });
});

describe("configuration", () => {
  it("shows the deployment defaults until an admin changes them, and keeps changes across a restart", async () => {
    const w = await world({ defaults: { maxVaults: 40 } });
    expect((await admin(w, "GET", "/admin/config")).body).toEqual({ ...DEFAULT_CONFIG, maxVaults: 40 });
    await admin(w, "POST", "/admin/config", { maxVaults: 7, vaultBytesCap: 1000, ipDailyCap: 1, dailyCreationCap: 9 });
    w.core = w.make();
    expect((await admin(w, "GET", "/admin/config")).body).toEqual({
      openSignup: false, maxVaults: 7, vaultBytesCap: 1000, dailyCreationCap: 9, ipDailyCap: 1,
    });
  });

  it("refuses unknown keys and bad values instead of ignoring them, changing nothing", async () => {
    const w = await world();
    for (const bad of [{}, { openSignup: "yes" }, { maxVaults: -1 }, { maxVaults: 1.5 }, { maxVaults: "5" }, { nope: 1 }]) {
      expect((await admin(w, "POST", "/admin/config", bad)).status).toBe(400);
    }
    expect((await admin(w, "POST", "/admin/config", { maxVaults: 3, nope: 1 })).status).toBe(400);
    expect((await admin(w, "GET", "/admin/config")).body.maxVaults).toBe(DEFAULT_CONFIG.maxVaults);
  });

  it("hands the Worker the per-vault byte cap, trusted callers only", async () => {
    const w = await world();
    expect((await call(w, "GET", "/limits")).status).toBe(404);
    await admin(w, "POST", "/admin/config", { vaultBytesCap: 12345 });
    expect(await call(w, "GET", "/limits", { trusted: true })).toEqual({ status: 200, body: { vaultBytes: 12345 } });
  });
});

describe("vault records", () => {
  it("keep when each was created and, rarely, when it was last seen", async () => {
    const w = await world();
    const inv = await invite(w);
    const made = (await create(w, 1, { invite: inv.code })).body.vaultId;
    const seen = () => w.sql.exec("SELECT last_seen_at FROM vaults").toArray()[0].last_seen_at;
    const created = w.clock.t;
    w.clock.t += 6 * 3_600_000;
    await call(w, "POST", "/vault-seen", { body: { vaultId: made }, trusted: true });
    expect(seen()).toBe(created);
    w.clock.t += 7 * 3_600_000;
    await call(w, "POST", "/vault-seen", { body: { vaultId: made }, trusted: true });
    expect(seen()).toBe(w.clock.t);
  });

  it("are forgotten when the Worker says the vault was deleted, which frees a place under the cap", async () => {
    const w = await world({ defaults: { maxVaults: 1 } });
    const a = await invite(w, "A");
    const b = await invite(w, "B");
    const made = (await create(w, 1, { invite: a.code })).body.vaultId;
    expect((await create(w, 2, { invite: b.code })).status).toBe(403);
    expect((await call(w, "POST", "/vault-deleted", { body: { vaultId: made } })).status).toBe(404);
    expect((await call(w, "POST", "/vault-deleted", { body: { vaultId: made }, trusted: true })).status).toBe(200);
    expect((await call(w, "POST", "/vault-deleted", { body: { vaultId: made }, trusted: true })).status).toBe(200);
    expect((await create(w, 2, { invite: b.code })).status).toBe(200);
    expect((await call(w, "POST", "/vault-seen", { body: {}, trusted: true })).status).toBe(400);
    expect((await call(w, "POST", "/vault-seen", { body: { vaultId: "x" } })).status).toBe(404);
  });
});

describe("stats", () => {
  it("count vaults and merge in what each vault reports through the fan-out hook", async () => {
    const asked = [];
    const hooks = {
      fanOut: async (ids) => { asked.push(ids); return ids.map((id, i) => (i === 0 ? { id, bytes: 99, devices: 2, writesToday: 5 } : null)); },
    };
    const w = await world({ hooks });
    const a = await invite(w, "A");
    const b = await invite(w, "B");
    const v1 = (await create(w, 1, { invite: a.code }, { ip: "203.0.113.1" })).body.vaultId;
    const v2 = (await create(w, 2, { invite: b.code })).body.vaultId;
    const res = await admin(w, "GET", "/admin/stats");
    expect(asked).toEqual([[v1, v2]]);
    expect(res.body.vaults).toEqual({ count: 2, max: DEFAULT_CONFIG.maxVaults });
    expect(res.body.open).toBe(false);
    expect(res.body.perVault[0]).toMatchObject({ id: v1, status: "active", bytes: 99, devices: 2, writesToday: 5 });
    expect(res.body.perVault[1]).toEqual({ id: v2, status: "active", createdAt: w.clock.t, lastSeenAt: w.clock.t });
  });

  it("work with no hook, and are not asked of a vault that no longer exists", async () => {
    const w = await world();
    const a = await invite(w);
    const v = (await create(w, 1, { invite: a.code })).body.vaultId;
    expect((await admin(w, "GET", "/admin/stats")).body.perVault).toHaveLength(1);
    await call(w, "POST", "/vault-deleted", { body: { vaultId: v }, trusted: true });
    const res = await admin(w, "GET", "/admin/stats");
    expect(res.body.vaults.count).toBe(0);
    expect(res.body.perVault[0].status).toBe("deleted");
  });
});

describe("deleting a vault as admin", () => {
  it("empties the vault through the hook first, then forgets it", async () => {
    const deleted = [];
    const w = await world({ hooks: { deleteVault: async (id) => { deleted.push(id); } } });
    const a = await invite(w);
    const v = (await create(w, 1, { invite: a.code })).body.vaultId;
    expect((await admin(w, "POST", "/admin/delete-vault", { vaultId: v })).status).toBe(200);
    expect(deleted).toEqual([v]);
    expect((await admin(w, "GET", "/admin/stats")).body.vaults.count).toBe(0);
    // Repeating it does not call the vault again.
    expect((await admin(w, "POST", "/admin/delete-vault", { vaultId: v })).status).toBe(200);
    expect(deleted).toEqual([v]);
  });

  it("leaves the vault listed when emptying it failed, so the admin can try again", async () => {
    const w = await world({ hooks: { deleteVault: async () => { throw new Error("vault unreachable"); } } });
    const a = await invite(w);
    const v = (await create(w, 1, { invite: a.code })).body.vaultId;
    await expect(admin(w, "POST", "/admin/delete-vault", { vaultId: v })).rejects.toThrow("vault unreachable");
    expect((await admin(w, "GET", "/admin/stats")).body.vaults.count).toBe(1);
  });

  it("refuses an unknown vault and a malformed request", async () => {
    const w = await world();
    expect((await admin(w, "POST", "/admin/delete-vault", { vaultId: "a".repeat(32) })).status).toBe(404);
    expect((await admin(w, "POST", "/admin/delete-vault", {})).status).toBe(400);
  });
});

describe("the registry as a whole", () => {
  it("creates its schema with IF NOT EXISTS and a version, and survives a restart over the same storage", async () => {
    const w = await world();
    const a = await invite(w);
    await create(w, 1, { invite: a.code });
    w.core = w.make();
    expect((await admin(w, "GET", "/admin/stats")).body.vaults.count).toBe(1);
    expect(w.sql.exec("SELECT v FROM meta WHERE k = 'schema'").toArray()[0].v).toBe(1);
  });

  it("answers unknown routes 404 and keeps the Worker-only routes closed to everyone else", async () => {
    const w = await world();
    expect((await call(w, "GET", "/nope")).status).toBe(404);
    expect((await call(w, "DELETE", "/vaults")).status).toBe(404);
    expect((await call(w, "POST", "/vaults", { body: "text" })).status).toBe(400);
  });
});
