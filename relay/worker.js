/**
 * The Cloudflare side of the relay: a Worker that routes, and two Durable Object
 * classes that host the cores (DESIGN section 4, 6, 7 and M1-M7).
 *
 *   Worker      validates cheaply and forwards. It never holds state and never
 *               reads a ciphertext.
 *   VaultDO     one per vault, SQLite-backed; hosts relay/vault.js and the
 *               WebSockets of that vault (hibernation API).
 *   RegistryDO  one in total; hosts relay/registry.js.
 *
 * Why the Worker does so much before a Durable Object is touched: every
 * Durable Object request is billed and can wake an object, a Worker request that
 * stops at the door is not and cannot. So CORS, the path/method allowlist, body
 * size and type, the shape of the Authorization header and the vault id's mac
 * are all settled here, and junk costs a Worker request and nothing durable.
 *
 * Everything that is specific to the Workers runtime (the socket pair, a 101
 * response, the ping/pong auto-response) goes through `platform`, so the same
 * code runs under Node in tests with stand-ins. The classes are plain classes,
 * not `extends DurableObject` from "cloudflare:workers", for the same reason:
 * that module does not exist outside workerd, and nothing here uses RPC.
 */
/* global WebSocketPair, WebSocketRequestResponsePair */
import { createRegistry } from "./registry.js";
import { createVault } from "./vault.js";
import { verifyVaultId } from "./ids.js";
import { HOUR_MS, bearerOf, isPlainObject } from "./util.js";

const KB = 1024;
const MB = KB * KB;

/** Sub-protocol the client offers next to the token, and the one echoed back. */
export const WS_PROTOCOL = "meter.v1";
const REGISTRY_NAME = "registry";
const INTERNAL_URL = "https://relay.internal/call";

/** How long the registry's answer about limits is trusted. A cap changed by the
 *  admin reaches a vault within this long, and the registry is asked at most
 *  once per vault per period, only when that vault is written to. */
export const LIMITS_TTL_MS = 5 * 60_000;
/** Retry sooner than the full period when the registry could not be asked. */
const LIMITS_RETRY_MS = 30_000;
/** A socket: close codes in 4000-4999 are the application's own. */
export const CLOSE = { replaced: 4000, revoked: 4401, deleted: 4410, busy: 4429 };
const MAX_SOCKETS = 12; // six devices, one spare each
const PRESENCE_MAX = 4 * KB;
const PRESENCE_PER_MIN = 20; // the client sends one a minute

// ------------------------------------------------------------------ routing
/** `auth`: "bearer" needs a well-formed Authorization header, "optional" accepts
 *  one or none (the join token may also travel in the body), "none" needs none.
 *  `max`: the body size cap in bytes; a route without it takes no body. */
const VAULT_ROUTES = {
  "GET /recover": { auth: "none" },
  "POST /recover": { auth: "none", max: 8 * KB },
  "GET /devices": { auth: "bearer" },
  "PUT /device": { auth: "bearer", max: 4 * KB },
  "GET /log": { auth: "bearer" },
  // Batch <= 256 KB (DESIGN 7.2) plus the envelope around it.
  "POST /log": { auth: "bearer", max: 300 * KB },
  "GET /snapshot": { auth: "bearer" },
  // Eight parts of 1 MB, plus the envelopes.
  "PUT /snapshot": { auth: "bearer", max: 8 * MB + 256 * KB },
  "GET /keybox": { auth: "bearer" },
  "POST /rotate": { auth: "bearer", max: 8 * MB + 256 * KB },
  "DELETE /": { auth: "bearer", max: 2 * KB },
  "POST /pair/open": { auth: "bearer", max: 4 * KB },
  "GET /pair/pending": { auth: "bearer" },
  "POST /pair/request": { auth: "optional", max: 16 * KB },
  "GET /pair/status": { auth: "optional" },
  "POST /pair/approve": { auth: "bearer", max: 16 * KB },
  "DELETE /pair": { auth: "bearer", max: 2 * KB },
  "GET /ws": { auth: "none", socket: true },
};
// Deliberately absent: /claim, /stats and /purge. They exist in the core for the
// Worker's own trusted calls and are not a door an outsider can knock on.

const GLOBAL_ROUTES = {
  "GET /info": { auth: "none" },
  "POST /vaults": { auth: "none", max: 8 * KB },
  "POST /admin/invite": { auth: "bearer", max: 2 * KB },
  "GET /admin/invites": { auth: "bearer" },
  "POST /admin/revoke-invite": { auth: "bearer", max: 2 * KB },
  "GET /admin/config": { auth: "bearer" },
  "POST /admin/config": { auth: "bearer", max: 2 * KB },
  "GET /admin/stats": { auth: "bearer" },
  "POST /admin/delete-vault": { auth: "bearer", max: 2 * KB },
};

const CORS = {
  // Auth is a bearer header and there are no cookies, so CORS protects nothing
  // here and an allowlist would only force the Pages origin into the deployment.
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-max-age": "86400",
};

const respond = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    ...CORS, "content-type": "application/json", "cache-control": "no-store", ...extra,
  },
});

/** A refusal decided at the door, carrying its answer. */
class Refuse extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.body = { code, ...extra };
  }
}

/** Reads at most `cap` bytes of the body, stopping as soon as it is exceeded:
 *  a declared length is not trusted, and a chunked body has none. */
async function readCapped(request, cap) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) throw new Refuse(413, "too_large", { max: cap });
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new Refuse(413, "too_large", { max: cap });
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

const trimSlash = (p) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);

const methodsFor = (table, path) =>
  Object.keys(table).filter((k) => k.slice(k.indexOf(" ") + 1) === path).map((k) => k.slice(0, k.indexOf(" ")));

/** Which route a request is, or the refusal for one that is none. */
function lookup(table, method, path) {
  const route = table[`${method} ${path}`];
  if (route) return route;
  const allowed = methodsFor(table, path);
  if (allowed.length) throw new Refuse(405, "method_not_allowed", { allow: allowed });
  throw new Refuse(404, "not_found");
}

/** The shape of the Authorization header, never its value. */
function checkAuth(request, route) {
  const header = request.headers.get("authorization");
  if (header === null) {
    if (route.auth === "bearer") throw new Refuse(401, "auth");
    return;
  }
  if (!bearerOf({ authorization: header })) throw new Refuse(401, "auth");
}

/** The token of `Sec-WebSocket-Protocol: meter.v1, <token>`, or null. */
export function tokenFromProtocols(header) {
  const list = String(header ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.includes(WS_PROTOCOL)) return null;
  const rest = list.filter((p) => p !== WS_PROTOCOL);
  if (rest.length !== 1) return null;
  return bearerOf({ authorization: `Bearer ${rest[0]}` });
}

const cleanInternal = (envelope) => new Request(INTERNAL_URL, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope),
});

/** One call to a Durable Object, as `{status, body}`. The envelope is what the
 *  cores' `handle` takes plus `trusted`: it is set here, by the Worker, and
 *  nowhere a client can reach, because only the Worker can address the objects. */
async function callObject(stub, envelope) {
  const res = await stub.fetch(cleanInternal(envelope));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {}, retryAfter: res.headers.get("retry-after") };
}

const toResponse = ({ status, body, retryAfter }) =>
  respond(status, body, retryAfter ? { "retry-after": retryAfter } : {});

const defaultNumber = (v) => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** The deployment's [vars], as the registry's defaults. Absent means the core's own. */
const registryDefaults = (env) => {
  const out = {};
  if (env.OPEN_SIGNUP !== undefined) out.openSignup = ["1", "true", "on"].includes(String(env.OPEN_SIGNUP).toLowerCase());
  for (const [name, key] of [["maxVaults", "MAX_VAULTS"], ["vaultBytesCap", "VAULT_BYTES_CAP"],
    ["dailyCreationCap", "DAILY_CREATION_CAP"], ["ipDailyCap", "IP_DAILY_CAP"]]) {
    const n = defaultNumber(env[key]);
    if (n !== undefined) out[name] = n;
  }
  return out;
};

const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** What only the Workers runtime has. */
export const workersPlatform = {
  now: () => Date.now(),
  pair: () => {
    const p = new WebSocketPair();
    return [p[0], p[1]];
  },
  upgraded: (client) => new Response(null, {
    status: 101, webSocket: client, headers: { "sec-websocket-protocol": WS_PROTOCOL },
  }),
  autoResponse: () => new WebSocketRequestResponsePair("ping", "pong"),
};

/**
 * @param platform  `{ now, pair, upgraded, autoResponse }`, see workersPlatform
 * @returns `{ worker, VaultDO, RegistryDO }`
 */
export function createRelay(platform = workersPlatform) {
  const { now } = platform;
  const registryStub = (env) => env.REGISTRY.get(env.REGISTRY.idFromName(REGISTRY_NAME));
  const vaultStub = (env, id) => env.VAULT.get(env.VAULT.idFromName(`v:${id}`));

  // ------------------------------------------------------------------ Worker
  async function route(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const path = trimSlash(url.pathname);
    const vm = /^\/v1\/v\/([^/]+)(\/.*)?$/.exec(url.pathname);
    let table = GLOBAL_ROUTES;
    let rest = path.replace(/^\/v1/, "") || "/";
    let vaultId = null;
    if (vm) {
      // Before anything else about the request is looked at: a forged id must
      // cost nothing, and a Durable Object comes into being merely by being named.
      if (!(await verifyVaultId(env.ROUTE_KEY, vm[1]))) throw new Refuse(404, "not_found");
      vaultId = vm[1];
      table = VAULT_ROUTES;
      rest = trimSlash(vm[2] ?? "/");
    } else if (!path.startsWith("/v1/")) {
      throw new Refuse(404, "not_found");
    }

    const spec = lookup(table, method, rest);
    checkAuth(request, spec);

    if (spec.socket) {
      if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") throw new Refuse(426, "upgrade_required");
      if (!tokenFromProtocols(request.headers.get("sec-websocket-protocol"))) throw new Refuse(401, "auth");
      // The upgrade goes to the object as it came: it carries the token in a
      // header the object reads itself, and the id in the path.
      const res = await vaultStub(env, vaultId).fetch(request);
      if (res.webSocket || res.status === 101) return res;
      return toResponse({ status: res.status, body: JSON.parse((await res.text()) || "{}"), retryAfter: res.headers.get("retry-after") });
    }

    let body = null;
    if (spec.max) {
      const text = await readCapped(request, spec.max);
      if (text.length) {
        if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) throw new Refuse(415, "unsupported_media_type");
        try { body = JSON.parse(text); } catch { throw new Refuse(400, "bad_json"); }
      }
    }
    const headers = {};
    const auth = request.headers.get("authorization");
    if (auth) headers.authorization = auth;
    const envelope = { method, path: rest + url.search, headers, body, trusted: false };

    if (vaultId) {
      return toResponse(await callObject(vaultStub(env, vaultId), { ...envelope, vaultId }));
    }
    const ip = request.headers.get("cf-connecting-ip") ?? undefined;
    if (rest === "/vaults") return createVault_(env, { ...envelope, ip });
    return toResponse(await callObject(registryStub(env), { ...envelope, ip }));
  }

  /** Creating a vault is two objects and one request: the registry decides and
   *  mints an id, then the vault is initialised with the same body. If the second
   *  step fails the invite is already bound to that id and token, so the client
   *  repeats the request and gets the same vault: nothing is stranded. */
  async function createVault_(env, envelope) {
    const made = await callObject(registryStub(env), envelope);
    if (made.status !== 200) return toResponse(made);
    const claimed = await callObject(vaultStub(env, made.body.vaultId), {
      method: "POST", path: "/claim", headers: {}, body: envelope.body, trusted: true, vaultId: made.body.vaultId,
    });
    return toResponse(claimed.status === 200 ? made : claimed);
  }

  const worker = {
    async fetch(request, env) {
      try {
        return await route(request, env);
      } catch (e) {
        if (e instanceof Refuse) {
          return respond(e.status, e.body, e.body.allow ? { allow: e.body.allow.join(", ") } : {});
        }
        // An object over its limits says so; the client treats any 5xx as "the
        // relay is paused" and backs off, which is the right answer to both.
        const overloaded = e && typeof e === "object" && e.overloaded === true;
        if (!overloaded) console.error("relay error", e?.message ?? e);
        return respond(overloaded ? 503 : 500, { code: overloaded ? "overloaded" : "internal" });
      }
    },
  };

  // ------------------------------------------------------------------ VaultDO
  class VaultDO {
    constructor(ctx, env) {
      this.ctx = ctx;
      this.env = env;
      const sql = ctx.storage.sql;
      // Host-level bookkeeping that is not the core's business: what the registry
      // last said about limits, and when it was last told this vault was seen.
      sql.exec("CREATE TABLE IF NOT EXISTS host(k TEXT PRIMARY KEY, v)").toArray();
      this.sql = sql;
      this.limitsAt = Number(this.hostGet("limits_at") ?? 0);
      const cached = this.hostGet("vault_bytes");
      this.seenAt = Number(this.hostGet("seen_at") ?? 0);
      this.unreported = this.hostGet("delete_unreported") === 1;
      this.deleted = false;
      this.presence = new Map();
      this.core = createVault({
        sql, now, random: randomBytes,
        transaction: (fn) => ctx.storage.transactionSync(fn),
        limits: cached === null ? {} : { vaultBytes: Number(cached) },
        emit: (type, payload) => this.onEvent(type, payload),
      });
      // Answered by the runtime without waking the object, so an idle socket
      // costs nothing and the object can hibernate.
      ctx.setWebSocketAutoResponse(platform.autoResponse());
    }

    hostGet(k) {
      const r = this.sql.exec("SELECT v FROM host WHERE k = ?", k).toArray();
      return r.length ? r[0].v : null;
    }

    hostSet(k, v) {
      this.sql.exec("INSERT INTO host(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v).toArray();
    }

    /** The cap the admin set. Asked of the registry lazily, kept for a few
     *  minutes and, so a wake-up does not ask again, kept in storage too. A
     *  registry that cannot be reached leaves the previous cap in force and is
     *  tried again soon; a request never waits on more than one attempt. */
    async refreshLimits() {
      const t = now();
      if (t - this.limitsAt < LIMITS_TTL_MS) return;
      try {
        const res = await callObject(registryStub(this.env), { method: "GET", path: "/limits", trusted: true });
        if (res.status === 200 && Number.isFinite(res.body.vaultBytes)) {
          this.core.setLimits({ vaultBytes: res.body.vaultBytes });
          this.hostSet("vault_bytes", res.body.vaultBytes);
          this.limitsAt = t;
          this.hostSet("limits_at", t);
          return;
        }
      } catch { /* fall through to the short retry */ }
      this.limitsAt = t - LIMITS_TTL_MS + LIMITS_RETRY_MS;
    }

    /** Last-seen for the registry, at most hourly. The registry itself writes it
     *  at most twice a day, so this only bounds the calls. */
    async noteSeen(vaultId) {
      const t = now();
      if (!vaultId || t - this.seenAt < HOUR_MS) return;
      this.seenAt = t;
      this.hostSet("seen_at", t);
      try {
        await callObject(registryStub(this.env), { method: "POST", path: "/vault-seen", body: { vaultId }, trusted: true });
      } catch { /* the count is a nicety; the next hour tries again */ }
    }

    /** A delete made by a device is reported to the registry so the count under
     *  the cap goes down. Awaited, because a Durable Object may stop as soon as
     *  the response is out. If the registry cannot be reached the fact is kept
     *  and retried on the next request, which is a 410 and so cheap. */
    async reportDeleted(vaultId) {
      try {
        const res = await callObject(registryStub(this.env), { method: "POST", path: "/vault-deleted", body: { vaultId }, trusted: true });
        if (res.status !== 200) throw new Error("registry refused");
        this.unreported = false;
        this.hostSet("delete_unreported", 0);
      } catch {
        this.unreported = true;
        this.hostSet("delete_unreported", 1);
      }
    }

    // ------------------------------------------------------------- sockets
    sockets() { return this.ctx.getWebSockets(); }

    send(ws, message) {
      try { ws.send(JSON.stringify(message)); } catch { /* a closed socket is not this request's problem */ }
    }

    closeSocket(ws, code, reason) {
      try { ws.close(code, reason); } catch { /* already closed */ }
    }

    deviceOf(ws) {
      try { return ws.deserializeAttachment()?.dev ?? null; } catch { return null; }
    }

    /** What the core says a socket should be told (vault.js `emit`). Runs inside
     *  the request that caused it, synchronously. */
    onEvent(type, payload) {
      switch (type) {
        case "entry":
          for (const ws of this.sockets()) this.send(ws, { t: "entry", seq: payload.seq, dev: payload.dev, blob: payload.blob });
          break;
        case "rotated":
          for (const ws of this.sockets()) this.send(ws, { t: "rotated", epoch: payload.epoch });
          break;
        case "devices":
          for (const ws of this.sockets()) this.send(ws, { t: "devices" });
          break;
        case "revoked":
          // Cut off at once; the removed device is not told about the new key.
          for (const ws of this.sockets()) if (this.deviceOf(ws) === payload.dev) this.closeSocket(ws, CLOSE.revoked, "revoked");
          break;
        case "pair_request":
          // Only the device that opened the slot can approve it.
          for (const ws of this.sockets()) if (this.deviceOf(ws) === payload.owner) this.send(ws, { t: "pair_request", joinId: payload.joinId });
          break;
        case "deleted":
          for (const ws of this.sockets()) { this.send(ws, { t: "deleted" }); this.closeSocket(ws, CLOSE.deleted, "deleted"); }
          this.deleted = true;
          break;
        default:
      }
    }

    // --------------------------------------------------------------- fetch
    async fetch(request) {
      if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") return this.upgrade(request);
      const env = await request.json();
      const trusted = env.trusted === true;
      if (this.unreported && env.vaultId) await this.reportDeleted(env.vaultId);
      // Reads do not need the cap; writes (and the claim) do.
      if (env.method !== "GET") await this.refreshLimits();
      this.deleted = false;
      const out = await this.core.handle({ method: env.method, path: env.path, headers: env.headers, body: env.body }, { trusted });
      // Only a delete made by a device: an admin's purge is the registry's own call.
      if (this.deleted && !trusted) await this.reportDeleted(env.vaultId);
      if (out.status === 200 && !trusted && env.headers?.authorization) await this.noteSeen(env.vaultId);
      const extra = out.body?.retryAfterMs ? { "retry-after": String(Math.ceil(out.body.retryAfterMs / 1000)) } : {};
      return new Response(JSON.stringify(out.body ?? {}), { status: out.status, headers: { "content-type": "application/json", ...extra } });
    }

    /** The WebSocket upgrade: authenticate through the core with the token that
     *  came as a sub-protocol, then hand the socket to the runtime's hibernation
     *  machinery. The device id is kept in the socket's attachment, which
     *  survives the object being evicted and recreated. */
    async upgrade(request) {
      const token = tokenFromProtocols(request.headers.get("sec-websocket-protocol"));
      const asJson = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (!token) return asJson(401, { code: "auth" });
      const out = await this.core.handle({ method: "GET", path: "/ws", headers: { authorization: `Bearer ${token}` } });
      if (out.status !== 200) return asJson(out.status, out.body);
      const dev = out.body.deviceId;
      // One live socket per device: a reconnect after a network flap would
      // otherwise leave the old one counting until it timed out.
      for (const ws of this.sockets()) if (this.deviceOf(ws) === dev) this.closeSocket(ws, CLOSE.replaced, "replaced");
      if (this.sockets().filter((ws) => this.deviceOf(ws) !== null).length >= MAX_SOCKETS) return asJson(429, { code: "too_many_sockets" });
      const [client, server] = platform.pair();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ dev });
      return platform.upgraded(client);
    }

    /** Presence (DESIGN 1.3) is passed on and forgotten: nothing is stored, and
     *  the only thing read is its size. */
    async webSocketMessage(ws, message) {
      if (typeof message !== "string" || message.length > PRESENCE_MAX) return;
      let m;
      try { m = JSON.parse(message); } catch { return; }
      if (!isPlainObject(m) || m.t !== "presence") return;
      if (typeof m.blob !== "string" && !isPlainObject(m.blob)) return;
      if (JSON.stringify(m.blob).length > PRESENCE_MAX) return;
      const dev = this.deviceOf(ws);
      if (!dev) return;
      // A device that is not the client it claims to be could otherwise turn
      // every message into a broadcast to the whole vault.
      const t = now();
      const w = (this.presence.get(dev) ?? []).filter((x) => x > t - 60_000);
      if (w.length >= PRESENCE_PER_MIN) { this.presence.set(dev, w); return; }
      w.push(t);
      this.presence.set(dev, w);
      for (const other of this.sockets()) if (other !== ws) this.send(other, { t: "presence", dev, blob: m.blob });
    }

    async webSocketClose(ws, code) {
      // Completes the closing handshake; 1005/1006 may not be sent back.
      this.closeSocket(ws, code >= 3000 && code <= 4999 ? code : 1000, "closing");
    }

    async webSocketError(ws) {
      this.closeSocket(ws, 1011, "error");
    }
  }

  // --------------------------------------------------------------- RegistryDO
  class RegistryDO {
    constructor(ctx, env) {
      this.ctx = ctx;
      this.env = env;
      this.registry = createRegistry({
        sql: ctx.storage.sql, now, random: randomBytes,
        adminToken: env.ADMIN_TOKEN, routeKey: env.ROUTE_KEY, defaults: registryDefaults(env),
        transaction: (fn) => ctx.storage.transactionSync(fn),
        hooks: {
          // On demand only, when an admin asks: no standing traffic to the vaults.
          fanOut: (ids) => Promise.all(ids.map(async (id) => {
            try {
              const r = await callObject(vaultStub(env, id), { method: "GET", path: "/stats", trusted: true, vaultId: id });
              return r.status === 200 ? { id, ...r.body } : null;
            } catch { return null; }
          })),
          deleteVault: async (id) => {
            const r = await callObject(vaultStub(env, id), { method: "POST", path: "/purge", trusted: true, vaultId: id });
            if (r.status !== 200) throw new Error(`vault would not be emptied (${r.status})`);
          },
        },
      });
    }

    async fetch(request) {
      const env = await request.json();
      const out = await this.registry.handle(
        { method: env.method, path: env.path, headers: env.headers, body: env.body, ip: env.ip },
        { trusted: env.trusted === true },
      );
      return new Response(JSON.stringify(out.body ?? {}), { status: out.status, headers: { "content-type": "application/json" } });
    }
  }

  return { worker, VaultDO, RegistryDO };
}

const relay = createRelay(workersPlatform);

// Declared as classes, not exported as constants, because the runtime finds them
// by the names in wrangler.toml.
export class VaultDO extends relay.VaultDO {}
export class RegistryDO extends relay.RegistryDO {}
export default relay.worker;
