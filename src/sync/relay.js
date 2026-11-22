/**
 * The app's side of the relay over HTTP: the engine's transport (pull, push,
 * getSnapshot, putSnapshot), the two pairing transports pairing.js expects, and
 * the single calls around a vault (create, devices, recover, delete).
 *
 * Everything goes through an injected `fetch`, so the same code runs in the
 * browser, in Electron and in tests against the real Worker with no network.
 *
 * What lives here and nowhere else: sealing and opening. The engine deals in
 * plain batches and the relay in ciphertext; this is the one place the two
 * meet. A log entry is sealed under the vault key with AAD kind `log` and its
 * `bid` as context, so the relay cannot move it into another role or another
 * entry's place. A snapshot is gzipped FIRST and then sealed in parts, AAD kind
 * `snap` with `upto|part|parts`, so parts cannot be swapped or dropped. A device
 * name is kind `name` with the device id as context.
 *
 * Failures come out as the engine's `TransportError`, by one table (`failure`)
 * so the engine, pairing and the UI see the same vocabulary whatever the call.
 */
import { TransportError } from "./engine.js";
import {
  CryptoError, b64uDecode, b64uEncode, deriveKeys, gunzip, gzip, open, openJson, seal, sealJson, snapCtx, tokenHash,
} from "./crypto.js";
import { publicJwkOf } from "./vault.js";

const JSON_HEADER = { "content-type": "application/json" };
const bearer = (token) => ({ authorization: `Bearer ${token}` });

/**
 * One part of a snapshot holds this many compressed bytes. The relay refuses a
 * part whose JSON text is over 1 MiB, and a sealed part is the plaintext padded
 * to a power of two (crypto.js `pad`), then base64url (4/3). 512 KiB padded is
 * 683 KB of text: under the cap with room for the envelope. The next size up
 * would not fit, so parts are cut to exactly the largest size that pads to
 * 512 KiB (4 bytes of the pad are a length prefix).
 */
export const PART_BYTES = 512 * 1024 - 4;
/** The relay takes at most this many parts (DESIGN 7.2). */
export const MAX_PARTS = 8;

/** Per request. A request that never answers must not hold a sync round hostage;
 *  a snapshot upload is the one call that can honestly take a while. */
export const TIMEOUT_MS = 30_000;
export const SNAPSHOT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------- the table

/** Seconds in a Retry-After header, or milliseconds the relay put in the body. */
const retryAfterOf = (res, body) => {
  if (Number.isFinite(body?.retryAfterMs)) return body.retryAfterMs;
  const raw = res.headers?.get?.("retry-after");
  const h = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(h) && h >= 0 ? h * 1000 : undefined;
};

/**
 * An HTTP answer that was not a success, as the TransportError the engine knows.
 *
 *   409 epoch                   epoch      (the vault's key moved on)
 *   409 conflict                conflict   (the head or snapshot moved)
 *   410 gone                    gone       (behind the log kept: use the snapshot)
 *   410 deleted / vault_deleted deleted    (the vault no longer exists)
 *   401, 403                    auth       (`detail.code` says why: invite_invalid,
 *                                           invite_expired, invite_required, ...)
 *   429 vault_quota             quota      (`what`, `resetAt`)
 *   429 creation_limit          quota      (`what: "creation"`, `resetAt`)
 *   403 relay_full              quota      (`what: "relay_full"`): not a refusal of
 *                                           this person, so not "auth"
 *   429 anything else           paused     (rate limit; `retryAfterMs`)
 *   5xx                         paused     (relay down or over its daily limit)
 *   anything else               protocol   (a bug or a mismatched relay)
 */
export function failure(res, body) {
  const code = body?.code;
  const detail = { status: res.status, code };
  const wait = retryAfterOf(res, body);
  if (res.status === 409 && code === "epoch") return new TransportError("epoch", { ...detail, epoch: body.epoch });
  if (res.status === 409) return new TransportError("conflict", { ...detail, ...body });
  if (res.status === 410 && code === "gone") return new TransportError("gone", { ...detail, snapshotUpto: body.snapshotUpto });
  if (res.status === 410 && (code === "deleted" || code === "vault_deleted")) return new TransportError("deleted", detail);
  if (res.status === 410) return new TransportError("gone", detail);
  if (res.status === 403 && code === "relay_full") return new TransportError("quota", { ...detail, what: "relay_full" });
  if (res.status === 401 || res.status === 403) return new TransportError("auth", detail);
  if (res.status === 429 && code === "vault_quota") {
    return new TransportError("quota", { ...detail, what: body.what, max: body.max, resetAt: body.resetAt ?? undefined });
  }
  if (res.status === 429 && code === "creation_limit") {
    return new TransportError("quota", { ...detail, what: "creation", resetAt: body.resetAt ?? undefined });
  }
  if (res.status === 429 || res.status >= 500) return new TransportError("paused", { ...detail, retryAfterMs: wait });
  return new TransportError("protocol", { ...detail, message: `The relay answered ${res.status}${code ? ` (${code})` : ""}.` });
}

/** A body that does not parse is, from a 5xx, a platform error page (the relay is
 *  paused), and from anything else a relay this build does not understand. */
const readBody = async (res) => {
  let text = "";
  try { text = await res.text(); } catch { return { ok: false, body: null }; }
  if (!text) return { ok: true, body: {} };
  try { return { ok: true, body: JSON.parse(text) }; } catch { return { ok: false, body: null }; }
};

/**
 * One request, answered as `{ res, body }`. A request that could not be made
 * (offline, DNS, timeout) is "network". `allow` lists statuses the CALLER wants
 * to inspect itself instead of having them thrown (a 409 conflict on a push, a
 * 404 on a missing snapshot).
 */
async function call(ctx, method, path, { token, body, allow = [], timeoutMs = TIMEOUT_MS } = {}) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  let parsed;
  try {
    res = await ctx.fetch(`${ctx.relay}${path}`, {
      method,
      headers: { ...(token ? bearer(token) : {}), ...(body === undefined ? {} : JSON_HEADER) },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    parsed = await readBody(res);
  } catch {
    throw new TransportError("network");
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res.ok) {
    if (!parsed.ok) throw new TransportError("protocol", { message: "The relay sent something that is not JSON." });
    return { res, body: parsed.body };
  }
  if (allow.includes(res.status) && parsed.ok) return { res, body: parsed.body };
  throw failure(res, parsed.ok ? parsed.body : {});
}

const vaultPath = (vault, path) => `/v1/v/${vault.vaultId}${path}`;

/** What failed to decrypt or parse is the relay's doing (or a corrupt vault), not
 *  a bug in the engine: say so, so one bad entry shows as a status and does not
 *  crash the round. */
const guarded = async (fn) => {
  try { return await fn(); } catch (e) {
    if (e instanceof CryptoError) throw new TransportError("protocol", { message: "An entry from the relay could not be opened.", cause: e.code });
    throw e;
  }
};

const concat = (chunks) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};

// -------------------------------------------------------------- the engine

/**
 * The engine's transport for one vault, plus what a live socket needs to open
 * and seal on the same key (`openEntry`, `sealPresence`, `openPresence`).
 * `vault` is the saved identity (vaultStore.js). The epoch is fixed at
 * construction: after a rotation the app builds a new one, and until then a
 * server that says the epoch moved makes every call fail with "epoch".
 */
export async function createTransport({ fetch, vault }) {
  const ctx = { fetch, relay: vault.relay };
  const { epoch } = vault;
  const { encKey } = await deriveKeys(b64uDecode(vault.K), epoch);
  const token = vault.token;
  const send = (method, path, opts = {}) => call(ctx, method, vaultPath(vault, path), { token, ...opts });

  const openEntry = ({ bid, blob }) => guarded(() => openJson(encKey, { epoch, kind: "log", ctx: bid }, blob));
  const read = (entries) => Promise.all(entries.map(async (e) => ({ seq: e.seq, dev: e.dev, bid: e.bid, batch: await openEntry(e) })));

  return {
    async pull(since) {
      const { body } = await send("GET", `/log?since=${since}&epoch=${epoch}`);
      return { head: body.head, snapshotUpto: body.snapshotUpto, entries: await read(body.entries) };
    },

    async push({ expect, bid, batch }) {
      const blob = await sealJson(encKey, { epoch, kind: "log", ctx: bid }, batch);
      const { res, body } = await send("POST", "/log", { body: { epoch, expect, bid, blob }, allow: [409] });
      if (res.status === 409) {
        // Somebody wrote first. The answer carries what was missed, so the
        // engine merges it without another round trip.
        if (body.code !== "conflict") throw failure(res, body);
        throw new TransportError("conflict", { head: body.head, entries: await read(body.entries) });
      }
      return { seq: body.seq };
    },

    async getSnapshot() {
      const { res, body } = await send("GET", `/snapshot?epoch=${epoch}`, { allow: [404], timeoutMs: SNAPSHOT_TIMEOUT_MS });
      if (res.status === 404) return null;
      const n = body.parts.length;
      return guarded(async () => {
        const chunks = [];
        for (let i = 0; i < n; i += 1) {
          chunks.push(await open(encKey, { epoch, kind: "snap", ctx: snapCtx(body.upto, i, n) }, body.parts[i]));
        }
        const text = new TextDecoder().decode(await gunzip(concat(chunks)));
        return { upto: body.upto, state: JSON.parse(text) };
      });
    },

    async putSnapshot({ expectUpto, upto, state }) {
      const packed = await gzip(new TextEncoder().encode(JSON.stringify(state)));
      const n = Math.max(1, Math.ceil(packed.length / PART_BYTES));
      if (n > MAX_PARTS) {
        // Refused here, before a byte is sent: the relay would only say no.
        throw new TransportError("quota", { what: "snapshot_size", message: "The ledger is too large to sync." });
      }
      const parts = [];
      for (let i = 0; i < n; i += 1) {
        parts.push(await seal(encKey, { epoch, kind: "snap", ctx: snapCtx(upto, i, n) }, packed.subarray(i * PART_BYTES, (i + 1) * PART_BYTES)));
      }
      await send("PUT", "/snapshot", { body: { expectUpto, upto, epoch, parts }, timeoutMs: SNAPSHOT_TIMEOUT_MS });
      return {};
    },

    // For the socket (socket.js). An entry arrives with its bid; presence is
    // bound to the SENDING device's id so one device's message cannot be passed
    // off as another's.
    openEntry,
    sealPresence: (payload) => sealJson(encKey, { epoch, kind: "presence", ctx: vault.deviceId }, payload),
    openPresence: ({ dev, blob }) => guarded(() => openJson(encKey, { epoch, kind: "presence", ctx: dev }, blob)),
  };
}

// ----------------------------------------------------------------- pairing

/** The approver side of the pairing contract (pairing.js), over HTTP. */
export function approverTransport({ fetch, vault }) {
  const ctx = { fetch, relay: vault.relay };
  const go = async (method, path, body) => (await call(ctx, method, vaultPath(vault, path), { token: vault.token, body })).body;
  return {
    open: (b) => go("POST", "/pair/open", b),
    pending: () => go("GET", "/pair/pending"),
    approve: (b) => go("POST", "/pair/approve", b),
    deny: (b) => go("DELETE", "/pair", b),
  };
}

/** The joiner side. The join token is the Bearer header, so the relay can check
 *  it without it being in a body that is logged or retried. */
export const joinerTransportFor = (fetch) => ({ relay, vaultId }) => {
  const ctx = { fetch, relay };
  const at = (path) => `/v1/v/${vaultId}${path}`;
  return {
    async request({ joinToken, ...rest }) {
      return (await call(ctx, "POST", at("/pair/request"), { token: joinToken, body: rest })).body;
    },
    async status({ joinId, joinToken }) {
      return (await call(ctx, "GET", at(`/pair/status?id=${joinId}`), { token: joinToken })).body;
    },
  };
};

// ------------------------------------------------------- single calls

/** The relay's public face: `{ v, open }`. Used to say, before anything is made,
 *  whether an invite will be needed. */
export async function getInfo({ fetch, relay }) {
  return (await call({ fetch, relay }, "GET", "/v1/info")).body;
}

/** What the relay stores to recognise the recovery secret: the digest of the
 *  base64url text of the HKDF output for this epoch. */
export async function recoverProofOf(vault) {
  return b64uEncode((await deriveKeys(b64uDecode(vault.K), vault.epoch)).recoverAuth);
}

const sealName = async (vault, name) => {
  if (name === null || name === undefined) return null;
  const { encKey } = await deriveKeys(b64uDecode(vault.K), vault.epoch);
  return sealJson(encKey, { epoch: vault.epoch, kind: "name", ctx: vault.deviceId }, String(name));
};

/**
 * Registers a vault minted locally (vaultStore/vault.js `createLocalVault`) and
 * returns `{ vaultId }`. Repeating it with the same identity and invite returns
 * the same vault, which is what makes a retry after a lost answer safe. `name`
 * is this device's name, sealed, or omitted.
 */
export async function registerVault({ fetch, vault, name = null }) {
  const body = {
    ...(vault.invite ? { invite: vault.invite } : {}),
    tokenHash: await tokenHash(vault.token),
    pubkey: publicJwkOf(vault),
    nameCt: await sealName(vault, name),
    recoverHash: await tokenHash(await recoverProofOf(vault)),
    deviceId: vault.deviceId,
  };
  return (await call({ fetch, relay: vault.relay }, "POST", "/v1/vaults", { body })).body;
}

/** The devices of the vault, their names opened where they can be (a name that
 *  does not open reads as null: it is shown as "unnamed", never as an error). */
export async function listDevices({ fetch, vault }) {
  const ctx = { fetch, relay: vault.relay };
  const { body } = await call(ctx, "GET", vaultPath(vault, "/devices"), { token: vault.token });
  const { encKey } = await deriveKeys(b64uDecode(vault.K), vault.epoch);
  return Promise.all(body.devices.map(async (d) => {
    let name = null;
    if (d.nameCt) {
      try { name = await openJson(encKey, { epoch: vault.epoch, kind: "name", ctx: d.id }, d.nameCt); } catch { /* shown unnamed */ }
    }
    return { id: d.id, pubkey: d.pubkey, name, addedAt: d.addedAt, seenAt: d.seenAt };
  }));
}

/** This device's name, set once it holds the key (a joiner cannot seal one before). */
export async function setDeviceName({ fetch, vault, name }) {
  const ctx = { fetch, relay: vault.relay };
  await call(ctx, "PUT", vaultPath(vault, "/device"), { token: vault.token, body: { nameCt: await sealName(vault, name) } });
}

/** The vault's current epoch, which a device that only has the recovery code
 *  needs before it can derive the proof. Not secret. */
export async function getRecoverEpoch({ fetch, relay, vaultId }) {
  return (await call({ fetch, relay }, "GET", `/v1/v/${vaultId}/recover`)).body.epoch;
}

/**
 * Registers a NEW device after every device was lost, proving possession of K
 * through the recovery proof. `vault` is a fresh identity for this device (new
 * token and keys, like createLocalVault) with `K` from the recovery code and
 * `vaultId` and `epoch` of the vault being recovered. Returns the saved shape's
 * `{ deviceId, epoch }`.
 */
export async function recoverDevice({ fetch, vault, name = null }) {
  const body = {
    recoverProof: await recoverProofOf(vault),
    tokenHash: await tokenHash(vault.token),
    pubkey: publicJwkOf(vault),
    nameCt: await sealName(vault, name),
    deviceId: vault.deviceId,
  };
  return (await call({ fetch, relay: vault.relay }, "POST", vaultPath(vault, "/recover"), { body })).body;
}

/** Deletes the vault on the relay. The caller has already had the person type
 *  the confirmation; `confirm` is the word the relay checks as well. */
export async function deleteVault({ fetch, vault }) {
  await call({ fetch, relay: vault.relay }, "DELETE", vaultPath(vault, ""), { token: vault.token, body: { confirm: "delete" } });
}

/** The WebSocket address for this vault: wss for https, ws for the local http relay. */
export const socketUrl = (vault) => `${vault.relay.replace(/^http/, "ws")}${vaultPath(vault, "/ws")}`;
