/**
 * The strings people copy, type, scan and paste: the recovery code, the join
 * code and the invite code. Pure functions, no storage and no network.
 *
 * All three use Crockford base32 (digits and letters without I, L, O, U). It is
 * the right alphabet for things typed by hand: 0 and O, 1 and I and L are the
 * classic mix-ups, and a decoder can simply treat them as the same character
 * instead of failing. Case, spaces and dashes are ignored on the way in.
 *
 * Decoding is strict about everything else. A code that is the wrong length, has
 * a character outside the alphabet, or fails its checksum throws a `CodeError`
 * whose message says what to check; nothing is repaired by guessing, because a
 * guessed repair of a vault key would be worse than an error.
 *
 * What each code holds, and what it must never hold:
 *
 *  - Recovery code: the vault key K and a checksum. It IS the key, shown once to
 *    the owner and never sent anywhere.
 *  - Join code: where the vault is, which join slot, and a one-time secret S. It
 *    never contains K and S never reaches the relay (see DESIGN 5.1). It travels
 *    only in a URL FRAGMENT, which a browser does not send to any server; a
 *    query string would reach the host's access log, so a join code found in one
 *    is rejected outright.
 *  - Invite code: the right to create one empty vault on a relay. Low
 *    sensitivity (single use, expiring), but kept to the fragment as well.
 *
 * The checksums are 48 to 64 bits of FNV-1a. They catch typos and truncation;
 * they are not authentication, and nothing relies on them for security.
 */

export class CodeError extends Error {
  /** @param code "length", "char", "checksum", "format" or "version" */
  constructor(code, message) {
    super(message);
    this.name = "CodeError";
    this.code = code;
  }
}

// ----------------------------------------------------------------- base32

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const VALUE = new Map([...ALPHABET].map((c, i) => [c, i]));

export const base32Encode = (bytes) => {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
};

/** Upper-cases, drops spaces, dashes and underscores, and folds the look-alikes:
 *  O to 0, I and L to 1. What is left is either canonical or wrong. */
export const normalize = (text) => String(text ?? "")
  .toUpperCase().replace(/[\s\-_]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");

/** Decodes canonical base32 of a known length in characters. Only whole bytes
 *  are accepted: leftover bits must be zero, so one string has one meaning. */
const base32Decode = (canonical, label) => {
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < canonical.length; i += 1) {
    const v = VALUE.get(canonical[i]);
    if (v === undefined) {
      throw new CodeError("char", `${label}: "${canonical[i]}" is not a valid character (position ${i + 1}). Codes use digits and letters except U.`);
    }
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0) throw new CodeError("format", `${label}: the ending is not valid`);
  return Uint8Array.from(out);
};

const groups = (text, size, joiner = "-") => text.match(new RegExp(`.{1,${size}}`, "g")).join(joiner);

const bytesEqual = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** FNV-1a, 64 bit, over the given parts joined as bytes. */
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const checksum = (...parts) => {
  let h = FNV_OFFSET;
  for (const part of parts) {
    const bytes = typeof part === "string" ? new TextEncoder().encode(part) : part;
    for (const b of bytes) h = ((h ^ BigInt(b)) * FNV_PRIME) & 0xffffffffffffffffn;
  }
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i -= 1) { out[i] = Number(h & 255n); h >>= 8n; }
  return out;
};

// -------------------------------------------------------------- recovery code

export const KEY_BYTES = 32;
/** 32 bytes of K and 8 of checksum: 320 bits, exactly 64 characters. */
export const RECOVERY_CHARS = 64;

/** K as eight groups of eight, e.g. "7GQ2M4XA-...". Shown once, never sent. */
export function encodeRecoveryCode(K) {
  if (!(K instanceof Uint8Array) || K.length !== KEY_BYTES) {
    throw new CodeError("format", "recovery: the key must be 32 bytes");
  }
  const body = new Uint8Array(KEY_BYTES + 8);
  body.set(K);
  body.set(checksum("meter-v1-recovery|", K), KEY_BYTES);
  return groups(base32Encode(body), 8);
}

/** Returns K, or throws a CodeError that says what to check. */
export function decodeRecoveryCode(text) {
  const canonical = normalize(text);
  if (canonical.length < RECOVERY_CHARS) {
    throw new CodeError("length", `The recovery code is too short: ${canonical.length} of ${RECOVERY_CHARS} characters. Check that none were cut off.`);
  }
  if (canonical.length > RECOVERY_CHARS) {
    throw new CodeError("length", `The recovery code is too long: ${canonical.length} of ${RECOVERY_CHARS} characters.`);
  }
  const body = base32Decode(canonical, "Recovery code");
  const K = body.slice(0, KEY_BYTES);
  if (!bytesEqual(body.slice(KEY_BYTES), checksum("meter-v1-recovery|", K))) {
    throw new CodeError("checksum", "The recovery code does not match its checksum. A character is probably mistyped; check each group against the original.");
  }
  return K;
}

// -------------------------------------------------------------------- vault id

/** `<128 random bits hex>.<mac, 16 hex>` as the relay mints it (DESIGN M1). The
 *  client cannot check the mac (the key is the relay's); it only checks shape. */
export const VAULT_ID = /^[0-9a-f]{32}\.[0-9a-f]{16}$/;
export const isVaultId = (v) => typeof v === "string" && VAULT_ID.test(v);

const hexBytes = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// -------------------------------------------------------------------- relay host

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const HOST = /^(localhost|127\.0\.0\.1|\[::1\]|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62})(?::(\d{1,5}))?$/;

/** A relay host as `name` or `name:port`, lower-cased, or throws. No scheme, no
 *  path, no credentials: a join code names a host, nothing more. */
export function checkHost(text) {
  const host = String(text ?? "").trim().toLowerCase();
  const m = HOST.exec(host);
  const port = m?.[2] === undefined ? 0 : Number(m[2]);
  if (!m || host.length > 253 || (m[2] !== undefined && (port < 1 || port > 65535))) {
    throw new CodeError("format", "The relay address is not valid. It should look like name.example.com, with no https:// and no path.");
  }
  return host;
}

/** https everywhere except a relay on this machine, which has no certificate. */
export const relayUrlFor = (host) => {
  const clean = checkHost(host);
  const name = clean.replace(/:\d+$/, "");
  return `${LOOPBACK.has(name) ? "http" : "https"}://${clean}`;
};

// ---------------------------------------------------------------------- join code

/** Version 1 body: version, vault id (16 + 8 bytes), join id (8), S (16), then
 *  a 6-byte checksum over the host as well as the body. 55 bytes, 88 characters. */
const JOIN_VERSION = 1;
const JOIN_BODY = 1 + 24 + 8 + 16;
export const JOIN_CHARS = 88;
export const SECRET_BYTES = 16;

const joinCheck = (host, body) => checksum("meter-v1-join|", host, "|", body).slice(0, 6);

/**
 * `{ host, vaultId, joinId, secret }` as `host/CODE`, where CODE is the 88
 * base32 characters, in groups of four with dashes for typing or without for a
 * link. `joinId` is 16 hex characters; `secret` is S, 16 random bytes that only
 * the two devices ever see.
 */
export function encodeJoin({ host, vaultId, joinId, secret }, { grouped = true } = {}) {
  const h = checkHost(host);
  if (!isVaultId(vaultId)) throw new CodeError("format", "join: bad vault id");
  if (typeof joinId !== "string" || !/^[0-9a-f]{16}$/.test(joinId)) throw new CodeError("format", "join: bad join id");
  if (!(secret instanceof Uint8Array) || secret.length !== SECRET_BYTES) throw new CodeError("format", "join: the secret must be 16 bytes");
  const body = new Uint8Array(JOIN_BODY);
  body[0] = JOIN_VERSION;
  body.set(hexBytes(vaultId.replace(".", "")), 1);
  body.set(hexBytes(joinId), 25);
  body.set(secret, 33);
  const full = new Uint8Array(JOIN_BODY + 6);
  full.set(body);
  full.set(joinCheck(h, body), JOIN_BODY);
  const code = base32Encode(full);
  return `${h}/${grouped ? groups(code, 4) : code}`;
}

/** The part after "#join=", or a bare `host/CODE`. Strict about everything. */
function joinValue(input) {
  const text = String(input ?? "").trim();
  if (text.includes("?")) {
    throw new CodeError("format", "A join code is never put in a query string. Use the code or link exactly as it was shown.");
  }
  const hash = text.indexOf("#");
  if (hash === -1) return text;
  const fragment = text.slice(hash + 1);
  if (!fragment.startsWith("join=")) throw new CodeError("format", "This link does not contain a join code.");
  let value;
  try { value = decodeURIComponent(fragment.slice(5)); } catch { throw new CodeError("format", "The join code in this link is damaged."); }
  if (/[&#=]/.test(value)) throw new CodeError("format", "The join code in this link is damaged.");
  return value;
}

/** Returns `{ host, vaultId, joinId, secret }`, or throws a CodeError. */
export function decodeJoin(input) {
  const value = joinValue(input);
  const slash = value.lastIndexOf("/");
  if (slash <= 0) throw new CodeError("format", "A join code looks like relay-address/CODE.");
  const host = checkHost(value.slice(0, slash));
  const canonical = normalize(value.slice(slash + 1));
  if (canonical.length !== JOIN_CHARS) {
    throw new CodeError("length", `The join code has ${canonical.length} characters; it should have ${JOIN_CHARS}. Check that none were cut off.`);
  }
  const full = base32Decode(canonical, "Join code");
  const body = full.slice(0, JOIN_BODY);
  if (!bytesEqual(full.slice(JOIN_BODY), joinCheck(host, body))) {
    throw new CodeError("checksum", "The join code does not match its checksum. A character is probably mistyped, or the relay address was changed.");
  }
  if (body[0] !== JOIN_VERSION) throw new CodeError("version", "This join code is from a newer version of Meter. Update Meter and try again.");
  const vid = toHex(body.slice(1, 25));
  return { host, vaultId: `${vid.slice(0, 32)}.${vid.slice(32)}`, joinId: toHex(body.slice(25, 33)), secret: body.slice(33, 49) };
}

/** `https://…/meter/#join=host/CODE`. `base` is the app's page address; it may
 *  not carry a query or a fragment of its own, so nothing can end up in either
 *  place by accident. */
export function joinLink(base, join) {
  if (/[?#]/.test(base)) throw new CodeError("format", "join link: the base address must not have a query or fragment");
  return `${base}#join=${encodeJoin(join, { grouped: false })}`;
}

// ---------------------------------------------------------------------- invite code

export const INVITE_PREFIX = "MTR-";
export const INVITE_CHARS = 20;

/** `MTR-` plus 20 characters (100 bits), from a random source `random(n)`.
 *  Canonical, which is what the relay hashes; `formatInvite` is for display. */
export function newInviteCode(random) {
  const bytes = random(INVITE_CHARS);
  return INVITE_PREFIX + Array.from(bytes, (b) => ALPHABET[b & 31]).join("");
}

export const formatInvite = (canonical) => `${INVITE_PREFIX}${groups(canonical.slice(INVITE_PREFIX.length), 5)}`;

/** Canonical `MTR-XXXXXXXXXXXXXXXXXXXX` from what a person typed or pasted, or
 *  throws. The prefix is checked after folding the look-alikes, so "mtr 1234..."
 *  works. */
export function parseInviteCode(text) {
  const raw = String(text ?? "").toUpperCase().replace(/[\s\-_]/g, "");
  if (!raw.startsWith("MTR")) throw new CodeError("format", "An invite code starts with MTR-.");
  const rest = normalize(raw.slice(3));
  if (rest.length !== INVITE_CHARS) {
    throw new CodeError("length", `The invite code has ${rest.length} characters after MTR-; it should have ${INVITE_CHARS}.`);
  }
  for (let i = 0; i < rest.length; i += 1) {
    if (!VALUE.has(rest[i])) {
      throw new CodeError("char", `Invite code: "${rest[i]}" is not a valid character (position ${i + 1}).`);
    }
  }
  return INVITE_PREFIX + rest;
}

/** A relay base URL from a link or a form: https, or http for this machine only,
 *  and nothing but an origin. */
export function checkRelayUrl(text) {
  let url;
  try { url = new URL(String(text ?? "").trim()); } catch { throw new CodeError("format", "The relay address is not a valid web address."); }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CodeError("format", "The relay address must start with https://.");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new CodeError("format", "The relay address should be just the site, such as https://name.example.com.");
  }
  checkHost(url.host);
  return url.origin;
}

/** Reads either a bare invite code or a link with `#invite=CODE&relay=URL`.
 *  Returns `{ code, relay }` with `relay` null when the link names none. A
 *  query-string invite is rejected: it would reach the host's logs. */
export function parseInvite(input) {
  const text = String(input ?? "").trim();
  const hash = text.indexOf("#");
  if (hash === -1 && !text.includes("?")) return { code: parseInviteCode(text), relay: null };
  if (text.includes("?") && (hash === -1 || text.indexOf("?") < hash)) {
    throw new CodeError("format", "An invite is never put in a query string. Use the code or link exactly as it was shown.");
  }
  const params = new URLSearchParams(text.slice(hash + 1));
  const keys = [...params.keys()];
  if (!params.has("invite") || keys.some((k) => k !== "invite" && k !== "relay") || keys.length !== new Set(keys).size) {
    throw new CodeError("format", "This link does not contain an invite code.");
  }
  return { code: parseInviteCode(params.get("invite")), relay: params.has("relay") ? checkRelayUrl(params.get("relay")) : null };
}

/** `base#invite=CODE&relay=URL` (the relay part is left out when not given). */
export function inviteLink(base, code, relay) {
  if (/[?#]/.test(base)) throw new CodeError("format", "invite link: the base address must not have a query or fragment");
  const canonical = parseInviteCode(code);
  const parts = [`invite=${canonical}`];
  if (relay) parts.push(`relay=${encodeURIComponent(checkRelayUrl(relay))}`);
  return `${base}#${parts.join("&")}`;
}
