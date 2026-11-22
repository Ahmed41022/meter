/**
 * The registry: the one place that decides who may create a vault and how many
 * exist (DESIGN M2, M3, M7). Plain logic over an injected `sql`, clock and random
 * source, like the vault core, and meant to be a single Durable Object.
 *
 * It sits on NO hot path. It is asked only to create a vault, by the admin CLI,
 * and (rarely) to forget a deleted or lately seen vault. Vault Durable Objects
 * never report to it; the stats an admin asks for are gathered on demand by
 * asking each vault, through the `fanOut` hook the Worker supplies.
 *
 * Why a Durable Object and not KV: single-use invites and a hard cap have to be
 * exact, and KV is eventually consistent with a small write allowance. Here
 * "consume the invite, check the cap, mint the id, record the vault" is one
 * synchronous transaction, so two people spending one invite at once cannot
 * both win.
 *
 * Nothing secret is stored in the clear: an invite is kept as its SHA-256 (the
 * code is shown once, when it is made), and a client address as a salted hash
 * whose salt changes every day, so counting creations per address does not
 * leave a log of addresses.
 */
import { mintVaultId } from "./ids.js";
import {
  DAY_MS, HOUR_MS, Reject, bearerOf, checkClaim, isPlainObject, intOf, normaliseHeaders,
  parseTarget, reply, safeEqual, sha256b64u,
} from "./util.js";

export const SCHEMA_VERSION = 1;

/** Defaults used until an admin call overrides them (wrangler `[vars]` can feed
 *  these). `openSignup` is off: a fresh relay creates nothing without an invite. */
export const DEFAULT_CONFIG = {
  openSignup: false,
  maxVaults: 25,
  vaultBytesCap: 50 * 1024 * 1024,
  dailyCreationCap: 50,
  ipDailyCap: 3,
};

const CONFIG_KEYS = {
  openSignup: "open_signup",
  maxVaults: "max_vaults",
  vaultBytesCap: "vault_bytes_cap",
  dailyCreationCap: "daily_creation_cap",
  ipDailyCap: "ip_daily_cap",
};

const INVITE = /^MTR-[0-9A-HJKMNP-TV-Z]{20}$/;
// The alphabet src/sync/codes.js uses, so a code made here parses there.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Invite ids shown to the admin: a prefix of the stored hash. Not secret (the
 *  hash is one-way) and long enough that two never collide in practice. */
const inviteId = (hash) => hash.slice(0, 12);

/** The canonical `MTR-...` of what arrived (case, spaces and dashes forgiven), or
 *  null when it is not an invite. The client already sends the canonical form;
 *  this only keeps a hand-typed `mtr abc...` from being a different invite. */
const canonicalInvite = (text) => {
  if (typeof text !== "string") return null;
  const c = text.toUpperCase().replace(/[\s-]/g, "").replace(/^MTR/, "MTR-");
  return INVITE.test(c) ? c : null;
};

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v)",
  `CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY, label TEXT, created_at INTEGER, expires_at INTEGER,
     used_at INTEGER, vault_id TEXT, token_hash TEXT, revoked_at INTEGER)`,
  // `token_hash` lets an open-mode retry find the vault it already made.
  `CREATE TABLE IF NOT EXISTS vaults(id TEXT PRIMARY KEY, created_at INTEGER, invite_hash TEXT, status TEXT,
     last_seen_at INTEGER, deleted_at INTEGER, token_hash TEXT)`,
  "CREATE TABLE IF NOT EXISTS creations(ip_hash TEXT, day INTEGER, n INTEGER, PRIMARY KEY(ip_hash, day))",
];

/**
 * @param sql           `{ exec(query, ...bindings) -> { toArray() } }`
 * @param adminToken    the ADMIN_TOKEN secret (shorter than 16 characters disables admin)
 * @param routeKey      the ROUTE_KEY secret that signs vault ids
 * @param defaults      overrides of DEFAULT_CONFIG (the deployment's [vars])
 * @param hooks         `fanOut(ids) -> Promise<array of {id, ...stats} | null>` and
 *                      `deleteVault(id) -> Promise`, both supplied by the Worker
 * @param transaction   (fn) -> fn() atomically; the DO passes `transactionSync`
 */
export function createRegistry({
  sql, now = Date.now, random, adminToken, routeKey, defaults = {}, hooks = {}, transaction = (fn) => fn(),
}) {
  const q = (query, ...bind) => sql.exec(query, ...bind).toArray();
  const run = (query, ...bind) => { sql.exec(query, ...bind).toArray(); };
  for (const stmt of SCHEMA) run(stmt);

  const getMeta = (k) => { const r = q("SELECT v FROM meta WHERE k = ?", k); return r.length ? r[0].v : null; };
  const setMeta = (k, v) => run("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  if (getMeta("schema") === null) setMeta("schema", SCHEMA_VERSION);

  const base = { ...DEFAULT_CONFIG, ...defaults };
  /** The settings in force: what an admin set, else the deployment default. */
  const config = () => {
    const out = {};
    for (const [name, key] of Object.entries(CONFIG_KEYS)) {
      const v = getMeta(key);
      out[name] = v === null ? base[name] : name === "openSignup" ? v === 1 : v;
    }
    return out;
  };

  const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

  /** `salt + address`, hashed. The salt is replaced each UTC day, so a stored
   *  hash from yesterday cannot be matched to an address today. */
  const dailySalt = () => {
    const day = Math.floor(now() / DAY_MS);
    if (getMeta("salt_day") !== day) {
      setMeta("ip_salt", hex(random(16)));
      setMeta("salt_day", day);
    }
    return getMeta("ip_salt");
  };
  const ipHashOf = (ip) => sha256b64u(`${dailySalt()}|${ip ?? "unknown"}`);

  // ------------------------------------------------------------- admin auth
  let adminFails = [];
  const adminOk = (ctx) => {
    if (typeof adminToken !== "string" || adminToken.length < 16) throw new Reject(503, "admin_disabled");
    const t = now();
    adminFails = adminFails.filter((x) => x > t - 15 * 60_000);
    if (adminFails.length >= 20) throw new Reject(429, "rate", { retryAfterMs: adminFails[0] + 15 * 60_000 - t });
    if (!ctx.bearer || !safeEqual(ctx.bearerHash, ctx.adminHash)) {
      adminFails.push(t);
      throw new Reject(401, "auth");
    }
  };

  const inviteStatus = (i) => {
    if (i.revoked_at !== null) return "revoked";
    if (i.used_at !== null) return "used";
    if (i.expires_at <= now()) return "expired";
    return "active";
  };

  const activeVaults = () => q("SELECT COUNT(*) AS n FROM vaults WHERE status = 'active'")[0].n;

  // --------------------------------------------------------------- handlers
  const handlers = {};

  handlers["GET /info"] = () => reply(200, { v: 1, open: config().openSignup });

  /**
   * Makes a vault id and records the vault, or returns the one a retry already
   * made. It does NOT initialise the vault: the Worker does that next, with
   * `claim`, which is idempotent for the same token hash. If that step fails the
   * invite is already bound to this vault id and token hash, so the client
   * retries the same request and gets the same vault: nothing is stranded.
   */
  handlers["POST /vaults"] = (ctx) => {
    const c = checkClaim(ctx.body);
    const invite = ctx.body.invite;
    const cfg = config();
    const t = now();
    const day = Math.floor(t / DAY_MS);
    const code = canonicalInvite(invite);
    if (invite !== undefined && invite !== null && !code) throw new Reject(403, "invite_invalid");

    const result = transaction(() => {
      let inviteHash = null;
      if (code) {
        inviteHash = ctx.inviteHash;
        const i = q("SELECT * FROM invites WHERE hash = ?", inviteHash)[0];
        if (!i) throw new Reject(403, "invite_invalid");
        if (i.used_at !== null) {
          // The same client asking again gets the same vault, even when the cap
          // has been reached since or the invite has now expired.
          if (i.token_hash === c.tokenHash) {
            const v = q("SELECT status FROM vaults WHERE id = ?", i.vault_id)[0];
            if (v && v.status !== "active") throw new Reject(410, "vault_deleted");
            return { vaultId: i.vault_id, fresh: false };
          }
          throw new Reject(409, "invite_used");
        }
        if (i.revoked_at !== null) throw new Reject(403, "invite_revoked");
        if (i.expires_at <= t) throw new Reject(403, "invite_expired");
      } else {
        if (!cfg.openSignup) throw new Reject(403, "invite_required");
        const again = q("SELECT id FROM vaults WHERE token_hash = ? AND invite_hash IS NULL AND status = 'active'", c.tokenHash)[0];
        if (again) return { vaultId: again.id, fresh: false };
        const mine = q("SELECT n FROM creations WHERE ip_hash = ? AND day = ?", ctx.ipHash, day)[0]?.n ?? 0;
        const all = q("SELECT COALESCE(SUM(n), 0) AS n FROM creations WHERE day = ?", day)[0].n;
        if (mine >= cfg.ipDailyCap || all >= cfg.dailyCreationCap) {
          throw new Reject(429, "creation_limit", { resetAt: (day + 1) * DAY_MS });
        }
      }
      // The cap comes after the invite checks and before any write, so an
      // invite is never spent on a vault that was not made.
      if (activeVaults() >= cfg.maxVaults) throw new Reject(403, "relay_full");
      run("INSERT INTO vaults(id, created_at, invite_hash, status, last_seen_at, token_hash) VALUES(?, ?, ?, 'active', ?, ?)",
        ctx.newVaultId, t, inviteHash, t, c.tokenHash);
      if (inviteHash) {
        run("UPDATE invites SET used_at = ?, vault_id = ?, token_hash = ? WHERE hash = ?", t, ctx.newVaultId, c.tokenHash, inviteHash);
      } else {
        run("INSERT INTO creations(ip_hash, day, n) VALUES(?, ?, 1) ON CONFLICT(ip_hash, day) DO UPDATE SET n = n + 1", ctx.ipHash, day);
        // Yesterday's counts have no use once their day is over.
        run("DELETE FROM creations WHERE day < ?", day);
      }
      return { vaultId: ctx.newVaultId, fresh: true };
    });
    return reply(200, { vaultId: result.vaultId });
  };

  /** The Worker reports a deleted vault so the count under the cap goes down. */
  handlers["POST /vault-deleted"] = (ctx) => {
    if (!ctx.trusted) throw new Reject(404, "not_found");
    const id = ctx.body?.vaultId;
    if (typeof id !== "string") throw new Reject(400, "bad_request");
    run("UPDATE vaults SET status = 'deleted', deleted_at = COALESCE(deleted_at, ?) WHERE id = ?", now(), id);
    return reply(200, {});
  };

  /** Last-seen, written rarely: only when the stored one is at least 12 hours
   *  old, so even a Worker that reports on every request costs a few rows a day. */
  handlers["POST /vault-seen"] = (ctx) => {
    if (!ctx.trusted) throw new Reject(404, "not_found");
    const id = ctx.body?.vaultId;
    if (typeof id !== "string") throw new Reject(400, "bad_request");
    const t = now();
    run("UPDATE vaults SET last_seen_at = ? WHERE id = ? AND status = 'active' AND (last_seen_at IS NULL OR last_seen_at <= ?)", t, id, t - 12 * HOUR_MS);
    return reply(200, {});
  };

  /** What the Worker needs to configure a vault with. Trusted only. */
  handlers["GET /limits"] = (ctx) => {
    if (!ctx.trusted) throw new Reject(404, "not_found");
    return reply(200, { vaultBytes: config().vaultBytesCap });
  };

  // ------------------------------------------------------------------ admin
  handlers["POST /admin/invite"] = (ctx) => {
    adminOk(ctx);
    const b = ctx.body ?? {};
    const label = b.label === undefined ? "" : b.label;
    const days = intOf(b.days, 7);
    if (typeof label !== "string" || label.length > 80 || Number.isNaN(days) || days < 1 || days > 365) {
      throw new Reject(400, "bad_request");
    }
    const t = now();
    const expiresAt = t + days * DAY_MS;
    run("INSERT INTO invites(hash, label, created_at, expires_at) VALUES(?, ?, ?, ?)", ctx.newInviteHash, label, t, expiresAt);
    return reply(200, { id: inviteId(ctx.newInviteHash), code: ctx.newInviteCode, label, expiresAt });
  };

  handlers["GET /admin/invites"] = (ctx) => {
    adminOk(ctx);
    return reply(200, {
      invites: q("SELECT * FROM invites ORDER BY created_at DESC, rowid DESC").map((i) => ({
        id: inviteId(i.hash), label: i.label, createdAt: i.created_at, expiresAt: i.expires_at,
        usedAt: i.used_at, vaultId: i.vault_id, status: inviteStatus(i),
      })),
    });
  };

  handlers["POST /admin/revoke-invite"] = (ctx) => {
    adminOk(ctx);
    const id = ctx.body?.id;
    if (typeof id !== "string" || id.length < 6 || id.length > 12) throw new Reject(400, "bad_request");
    const i = q("SELECT * FROM invites WHERE substr(hash, 1, ?) = ?", id.length, id)[0];
    if (!i) throw new Reject(404, "no_invite");
    // A used invite already made its vault; revoking it would change nothing
    // and the admin would think it had, so say so.
    if (i.used_at !== null) throw new Reject(409, "invite_used");
    run("UPDATE invites SET revoked_at = COALESCE(revoked_at, ?) WHERE hash = ?", now(), i.hash);
    return reply(200, {});
  };

  handlers["GET /admin/config"] = (ctx) => {
    adminOk(ctx);
    return reply(200, config());
  };

  /** Changes settings without a redeploy. Unknown keys are refused, not ignored,
   *  so a typo does not look like it worked. */
  handlers["POST /admin/config"] = (ctx) => {
    adminOk(ctx);
    const b = ctx.body;
    if (!isPlainObject(b) || !Object.keys(b).length) throw new Reject(400, "bad_request");
    const next = [];
    for (const [name, value] of Object.entries(b)) {
      if (!(name in CONFIG_KEYS)) throw new Reject(400, "bad_request", { field: name });
      if (name === "openSignup") {
        if (typeof value !== "boolean") throw new Reject(400, "bad_request", { field: name });
        next.push([CONFIG_KEYS[name], value ? 1 : 0]);
      } else {
        if (!Number.isInteger(value) || value < 0 || value > 1e12) throw new Reject(400, "bad_request", { field: name });
        next.push([CONFIG_KEYS[name], value]);
      }
    }
    for (const [k, v] of next) setMeta(k, v);
    return reply(200, config());
  };

  handlers["GET /admin/stats"] = async (ctx) => {
    adminOk(ctx);
    const cfg = config();
    const day = Math.floor(now() / DAY_MS);
    const list = q("SELECT id, created_at, last_seen_at, status FROM vaults ORDER BY created_at, rowid");
    const live = list.filter((v) => v.status === "active");
    const fan = hooks.fanOut ? await hooks.fanOut(live.map((v) => v.id)) : [];
    const byId = new Map((fan ?? []).filter(Boolean).map((s) => [s.id, s]));
    return reply(200, {
      vaults: { count: live.length, max: cfg.maxVaults }, open: cfg.openSignup,
      creationsToday: q("SELECT COALESCE(SUM(n), 0) AS n FROM creations WHERE day = ?", day)[0].n,
      perVault: list.map((v) => ({
        id: v.id, status: v.status, createdAt: v.created_at, lastSeenAt: v.last_seen_at, ...(byId.get(v.id) ?? {}),
      })),
    });
  };

  handlers["POST /admin/delete-vault"] = async (ctx) => {
    adminOk(ctx);
    const id = ctx.body?.vaultId;
    if (typeof id !== "string") throw new Reject(400, "bad_request");
    const v = q("SELECT status FROM vaults WHERE id = ?", id)[0];
    if (!v) throw new Reject(404, "no_vault");
    // The vault is emptied first: marking it deleted before that succeeded
    // would leave data behind that nothing in the registry points at.
    if (v.status === "active" && hooks.deleteVault) await hooks.deleteVault(id);
    run("UPDATE vaults SET status = 'deleted', deleted_at = COALESCE(deleted_at, ?) WHERE id = ?", now(), id);
    return reply(200, {});
  };

  // ----------------------------------------------------------------- handle
  /**
   * @param req   `{ method, path, headers, body, ip }`; `ip` is the client
   *              address the Worker read from CF-Connecting-IP.
   * @param opts  `{ trusted }`: the Worker's own calls (forget, seen, limits).
   * @returns     `{ status, body }`
   */
  async function handle(req, { trusted = false } = {}) {
    try {
      const { path, query } = parseTarget(req.path);
      const method = String(req.method ?? "").toUpperCase();
      const headers = normaliseHeaders(req.headers);
      const body = req.body ?? null;
      const handler = handlers[`${method} ${path}`];
      if (!handler) return reply(404, { code: "not_found" });
      const ctx = { method, path, query, body, trusted };
      if (path.startsWith("/admin/")) {
        // Both sides are hashed first so the compare is over fixed-length
        // digests, whatever length the guess was.
        ctx.bearer = bearerOf(headers);
        ctx.bearerHash = ctx.bearer ? await sha256b64u(ctx.bearer) : null;
        ctx.adminHash = typeof adminToken === "string" ? await sha256b64u(adminToken) : null;
      }
      if (path === "/admin/invite") {
        // Made here, once, so the hash that is stored and the code that is shown
        // are the same invite and the handler stays synchronous.
        ctx.newInviteCode = `MTR-${Array.from(random(20), (x) => ALPHABET[x & 31]).join("")}`;
        ctx.newInviteHash = await sha256b64u(ctx.newInviteCode);
      }
      if (path === "/vaults" && method === "POST") {
        const invite = canonicalInvite(body?.invite);
        ctx.inviteHash = invite ? await sha256b64u(invite) : null;
        ctx.ipHash = await ipHashOf(req.ip);
        ctx.newVaultId = await mintVaultId(routeKey, random);
      }
      return await handler(ctx);
    } catch (e) {
      if (e instanceof Reject) return reply(e.status, e.body);
      throw e;
    }
  }

  return { handle, config };
}
