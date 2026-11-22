/**
 * Small pieces the two relay cores share: hashing, the constant-time compare,
 * request parsing and body validation.
 *
 * Everything here is plain JS over WebCrypto (`crypto.subtle`), which Workers,
 * Durable Objects and Node all have, so the cores run unchanged in all three.
 * Nothing imports from src/: the relay is deployed on its own and must not drag
 * the app along, and the app must not bundle the relay.
 */

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** A request the core refuses, carrying the answer. Thrown inside a handler and
 *  turned into `{status, body}` by `handle`, so a check reads as one line. */
export class Reject extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.body = { code, ...extra };
  }
}

const encoder = new TextEncoder();

const b64u = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** SHA-256 of the UTF-8 of `text`, base64url. This is exactly the client's
 *  `tokenHash` (src/sync/crypto.js): the digest of the header string, so the
 *  relay can recognise a token it never stored. */
export const sha256b64u = async (text) =>
  b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));

/**
 * Equality that takes the same time wherever the strings differ. The loop never
 * exits early and always runs over the longer length, so neither a mismatch
 * position nor a length difference is visible in the timing. Used on digests
 * (fixed length), which is what makes comparing them character by character
 * enough.
 */
export const safeEqual = (a, b) => {
  const x = String(a ?? "");
  const y = String(b ?? "");
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
};

export const hexOf = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export const normaliseHeaders = (headers = {}) => {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
};

/** The token of `Authorization: Bearer <token>`, or null for anything that is
 *  not that shape. The charset and length bound are what a base64url token
 *  looks like; junk is rejected before it is hashed. */
export const bearerOf = (headers) => {
  const m = /^Bearer ([A-Za-z0-9_-]{16,200})$/.exec(headers.authorization ?? "");
  return m ? m[1] : null;
};

/** `/log?since=3` -> `{ path: "/log", query: { since: "3" } }`; trailing slash
 *  dropped, and an empty path is "/". */
export const parseTarget = (target) => {
  const raw = String(target ?? "");
  const q = raw.indexOf("?");
  let path = q < 0 ? raw : raw.slice(0, q);
  const query = {};
  if (q >= 0) for (const [k, v] of new URLSearchParams(raw.slice(q + 1))) query[k] = v;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return { path: path || "/", query };
};

export const reply = (status, body = {}) => ({ status, body });

export const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const isB64u = (s, min = 1, max = 4096) =>
  typeof s === "string" && s.length >= min && s.length <= max && /^[A-Za-z0-9_-]+$/.test(s);

/** A SHA-256 as the client sends it: 32 bytes of base64url, 43 characters. */
export const isDigest = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s);

export const isDeviceId = (s) => typeof s === "string" && /^[0-9a-f]{16}$/.test(s);

/** The public half of an ECDH P-256 key, normalised so what is stored and what is
 *  handed back is the same few fields in the same order. */
export const checkJwk = (k) => {
  if (!isPlainObject(k) || k.kty !== "EC" || k.crv !== "P-256" || !isB64u(k.x, 1, 100) || !isB64u(k.y, 1, 100)) {
    throw new Reject(400, "bad_request", { field: "pubkey" });
  }
  return { kty: "EC", crv: "P-256", x: k.x, y: k.y };
};

/**
 * Anything the relay stores but must not read (ciphertexts, wrapped keys, names)
 * is an opaque JSON value: a string or a plain object. It is stored as JSON text
 * and handed back parsed, so the client may send an envelope object or its
 * base64url string, whichever it prefers, and the relay never looks inside.
 * The text must be printable ASCII (which any base64url ciphertext is), so its
 * length IS its size in bytes and the byte quota cannot be dodged with
 * multi-byte characters.
 */
export const opaque = (value, max, field) => {
  if (typeof value !== "string" && !isPlainObject(value)) throw new Reject(400, "bad_request", { field });
  const text = JSON.stringify(value);
  if (text.length > max) throw new Reject(413, "too_large", { field, max });
  if (/[^\x20-\x7e]/.test(text)) throw new Reject(400, "bad_request", { field });
  return text;
};

export const parseStored = (text) => (text === null || text === undefined ? null : JSON.parse(text));

/** An integer from a query string or body, `fallback` when absent, NaN when it
 *  is present and not an integer (which every caller treats as a bad request). */
export const intOf = (v, fallback = null) => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
};

/**
 * The body of "make this vault": what the registry checks BEFORE it spends an
 * invite (so a malformed request never burns one) and the vault core checks again
 * when it claims. `deviceId` is the id the client already uses in its log
 * entries and its own bookkeeping; the relay takes it rather than inventing one
 * the device would not know.
 */
export const checkClaim = (body) => {
  if (!isPlainObject(body)) throw new Reject(400, "bad_request");
  if (!isDigest(body.tokenHash)) throw new Reject(400, "bad_request", { field: "tokenHash" });
  if (!isDigest(body.recoverHash)) throw new Reject(400, "bad_request", { field: "recoverHash" });
  if (body.deviceId !== undefined && !isDeviceId(body.deviceId)) throw new Reject(400, "bad_request", { field: "deviceId" });
  const nameCt = body.nameCt === undefined || body.nameCt === null ? null : opaque(body.nameCt, 2048, "nameCt");
  return {
    tokenHash: body.tokenHash,
    recoverHash: body.recoverHash,
    deviceId: body.deviceId ?? null,
    pubkey: checkJwk(body.pubkey),
    nameCt,
  };
};
