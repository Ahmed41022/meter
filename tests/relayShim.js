/**
 * A fetch-like front for the REAL relay cores, and the client-side transports
 * that talk to it, so the existing client code (sync/engine.js, sync/pairing.js)
 * can be driven against the real vault and registry logic instead of the
 * hand-written fakes.
 *
 * Two halves, both test-only:
 *
 *  - `createBackend` stands where the Worker will stand (step 3c): it routes
 *    `/v1/vaults`, `/v1/admin/*` and `/v1/v/<id>/...`, checks the vault id's mac
 *    before any vault is touched, creates one vault core per id, and makes the
 *    trusted claim call after the registry mints an id. It speaks `fetch`
 *    (`{status, json()}`), with every body crossing as JSON text, as on a wire.
 *
 *  - `httpEngineTransport` and the pairing transports are what step 3e's HTTP
 *    client will be: they put the engine's plain batches into encrypted
 *    envelopes and the engine's failures out of HTTP statuses. They are written
 *    here against the contract in DESIGN section 7 and, being the only place the
 *    two meet, are where any mismatch between the client and the core shows up.
 */
import { createRegistry } from "../relay/registry.js";
import { createVault } from "../relay/vault.js";
import { verifyVaultId } from "../relay/ids.js";
import { TransportError } from "../src/sync/engine.js";
import {
  b64uDecode, b64uEncode, deriveKeys, gunzip, gzip, openJson, open, seal, sealJson, snapCtx, tokenHash,
} from "../src/sync/crypto.js";
import { openSql, seededRandom } from "./relaySql.js";

export const ROUTE_KEY = "route-key-0123456789abcdef";
export const ADMIN_TOKEN = "admin-token-0123456789abcdef";
export const RELAY_URL = "https://relay.example.workers.dev";

const wire = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

export async function createBackend({ clock, limits = {}, defaults = {} } = {}) {
  const t = clock ?? { t: Date.UTC(2026, 0, 5, 12) };
  const now = () => t.t;
  const regDb = await openSql();
  const registry = createRegistry({
    sql: regDb.sql, transaction: regDb.transaction, now, random: seededRandom(21),
    adminToken: ADMIN_TOKEN, routeKey: ROUTE_KEY, defaults,
  });
  const vaults = new Map();
  const events = [];
  let seed = 100;
  const vaultFor = async (id) => {
    if (!vaults.has(id)) {
      const db = await openSql();
      vaults.set(id, createVault({
        sql: db.sql, transaction: db.transaction, now, random: seededRandom((seed += 1)), limits,
        emit: (type, payload) => events.push([id, type, payload]),
      }));
    }
    return vaults.get(id);
  };

  const respond = ({ status, body }) => ({ status, ok: status >= 200 && status < 300, json: async () => wire(body) });

  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const headers = init.headers ?? {};
    const body = init.body ? JSON.parse(init.body) : undefined;
    const path = u.pathname;

    if (path === "/v1/info") return respond(await registry.handle({ method, path: "/info", headers }));
    if (path.startsWith("/v1/admin/")) {
      return respond(await registry.handle({ method, path: path.slice(3), headers, body }));
    }
    if (path === "/v1/vaults" && method === "POST") {
      const made = await registry.handle({ method, path: "/vaults", headers, body, ip: "203.0.113.9" });
      if (made.status !== 200) return respond(made);
      const vault = await vaultFor(made.body.vaultId);
      const claimed = await vault.handle({ method: "POST", path: "/claim", body }, { trusted: true });
      return respond(claimed.status === 200 ? made : claimed);
    }
    const m = /^\/v1\/v\/([^/]+)(\/.*)?$/.exec(path);
    if (m) {
      // The mac is checked before a vault is created or woken: junk ids stop here.
      if (!(await verifyVaultId(ROUTE_KEY, m[1]))) return respond({ status: 404, body: { code: "not_found" } });
      const vault = await vaultFor(m[1]);
      return respond(await vault.handle({ method, path: (m[2] ?? "/") + u.search, headers, body }));
    }
    return respond({ status: 404, body: { code: "not_found" } });
  }

  const admin = async (method, path, body) => {
    const res = await fetch(`${RELAY_URL}/v1/admin${path}`, {
      method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  return { fetch, clock: t, registry, vaults, events, admin, vaultFor };
}

// ------------------------------------------------------------------ transports

/** The real Worker refuses a body that is not declared as JSON (415). */
const JSON_HEADER = { "content-type": "application/json" };
const bearer = (token) => ({ authorization: `Bearer ${token}` });

/** HTTP status and body to the engine's failure vocabulary. */
function fail(res, body) {
  const code = body?.code;
  if (res.status === 409 && code === "epoch") return new TransportError("epoch", { epoch: body.epoch });
  if (res.status === 409) return new TransportError("conflict", body);
  if (res.status === 410 && code === "gone") return new TransportError("gone", { snapshotUpto: body.snapshotUpto });
  if (res.status === 410) return new TransportError("gone", body);
  if (res.status === 401 || res.status === 403) return new TransportError("auth", body);
  if (res.status === 429 && code === "vault_quota") return new TransportError("quota", { resetAt: body.resetAt ?? undefined, what: body.what });
  if (res.status === 429) return new TransportError("paused", body);
  if (res.status >= 500) return new TransportError("paused", body);
  return new TransportError("network", body);
}

async function send(fetch, base, vaultId, method, path, { token, body } = {}) {
  let res;
  try {
    res = await fetch(`${base}/v1/v/${vaultId}${path}`, {
      method, headers: { ...(token ? bearer(token) : {}), ...(body === undefined ? {} : JSON_HEADER) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new TransportError("network");
  }
  const parsed = await res.json();
  return { res, body: parsed };
}

/**
 * The engine's transport over HTTP. Batches are sealed into envelopes under the
 * vault key: AAD kind `log` with the bid as context (so an entry cannot be moved
 * to another role), and a snapshot as gzip-then-seal in one part, AAD kind `snap`
 * with `upto|part|parts`. It reads the epoch from the vault it is built from; a
 * server that says the epoch moved makes it fail with "epoch".
 */
export async function httpEngineTransport({ fetch, vault }) {
  const base = vault.relay;
  const id = vault.vaultId;
  const { encKey } = await deriveKeys(b64uDecode(vault.K), vault.epoch);
  const call = async (method, path, body) => {
    const { res, body: out } = await send(fetch, base, id, method, path, { token: vault.token, body });
    return { res, out };
  };
  const ok = (res, out, allow = []) => { if (!res.ok && !allow.includes(res.status)) throw fail(res, out); };
  const opened = (entry) => openJson(encKey, { epoch: vault.epoch, kind: "log", ctx: entry.bid }, entry.blob);
  const read = async (entries) => Promise.all(entries.map(async (e) => ({ seq: e.seq, dev: e.dev, bid: e.bid, batch: await opened(e) })));

  return {
    async pull(since) {
      const { res, out } = await call("GET", `/log?since=${since}&epoch=${vault.epoch}`);
      ok(res, out);
      return { head: out.head, snapshotUpto: out.snapshotUpto, entries: await read(out.entries) };
    },
    async push({ expect, bid, batch }) {
      const blob = await sealJson(encKey, { epoch: vault.epoch, kind: "log", ctx: bid }, batch);
      const { res, out } = await call("POST", "/log", { epoch: vault.epoch, expect, bid, blob });
      if (res.status === 409 && out.code === "conflict") {
        throw new TransportError("conflict", { head: out.head, entries: await read(out.entries) });
      }
      ok(res, out);
      return { seq: out.seq };
    },
    async getSnapshot() {
      const { res, out } = await call("GET", `/snapshot?epoch=${vault.epoch}`);
      if (res.status === 404) return null;
      ok(res, out);
      const n = out.parts.length;
      const chunks = [];
      for (let i = 0; i < n; i += 1) {
        chunks.push(await open(encKey, { epoch: vault.epoch, kind: "snap", ctx: snapCtx(out.upto, i, n) }, out.parts[i]));
      }
      const bytes = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
      let at = 0;
      for (const c of chunks) { bytes.set(c, at); at += c.length; }
      return { upto: out.upto, state: JSON.parse(new TextDecoder().decode(await gunzip(bytes))) };
    },
    async putSnapshot({ expectUpto, upto, state }) {
      const packed = await gzip(new TextEncoder().encode(JSON.stringify(state)));
      const part = await seal(encKey, { epoch: vault.epoch, kind: "snap", ctx: snapCtx(upto, 0, 1) }, packed);
      const { res, out } = await call("PUT", "/snapshot", { expectUpto, upto, epoch: vault.epoch, parts: [part] });
      ok(res, out);
      return {};
    },
  };
}

/** What the recovery secret is on the wire: the HKDF output for this epoch, as
 *  base64url text. The relay stores the digest of that text. */
export const recoverProofOf = async (vault) =>
  b64uEncode((await deriveKeys(b64uDecode(vault.K), vault.epoch)).recoverAuth);
export const recoverHashOf = async (vault) => tokenHash(await recoverProofOf(vault));

export async function registerVault({ fetch, vault, invite }) {
  const { publicJwkOf } = await import("../src/sync/vault.js");
  const res = await fetch(`${vault.relay}/v1/vaults`, {
    method: "POST",
    headers: JSON_HEADER,
    body: JSON.stringify({
      invite, tokenHash: await tokenHash(vault.token), pubkey: publicJwkOf(vault), nameCt: null,
      recoverHash: await recoverHashOf(vault), deviceId: vault.deviceId,
    }),
  });
  return { status: res.status, body: await res.json() };
}

/** The approver side of the pairing contract (sync/pairing.js) over HTTP. */
export function httpApproverTransport({ fetch, vault }) {
  const call = async (method, path, body) => {
    const { res, out } = await (async () => {
      const r = await send(fetch, vault.relay, vault.vaultId, method, path, { token: vault.token, body });
      return { res: r.res, out: r.body };
    })();
    if (!res.ok) throw fail(res, out);
    return out;
  };
  return {
    open: (b) => call("POST", "/pair/open", b),
    pending: () => call("GET", "/pair/pending"),
    approve: (b) => call("POST", "/pair/approve", b),
    deny: (b) => call("DELETE", "/pair", b),
  };
}

/** The joiner side. The join token goes as a Bearer header here, as it will in
 *  the real client; the core also accepts it as a body field. */
export function httpJoinerTransportFor(fetch) {
  return ({ relay, vaultId }) => ({
    async request({ joinToken, ...rest }) {
      const { res, body } = await send(fetch, relay, vaultId, "POST", "/pair/request", { token: joinToken, body: rest });
      if (!res.ok) throw fail(res, body);
      return body;
    },
    async status({ joinId, joinToken }) {
      const { res, body } = await send(fetch, relay, vaultId, "GET", `/pair/status?id=${joinId}`, { token: joinToken });
      if (!res.ok) throw fail(res, body);
      return body;
    },
  });
}

export { TransportError };
