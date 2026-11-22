/**
 * Everything the relay must never be able to read, in one place.
 *
 * WebCrypto only, no dependency. The relay is treated as hostile to content: it
 * stores and forwards, and what it gets is an authenticated ciphertext whose
 * length reveals only a size bucket. Nothing here touches the network or the
 * ledger; it turns bytes into envelopes and back.
 *
 * Shape of the scheme (the reasons are in the design doc, section 3):
 *
 *  - One random 32-byte vault key K per epoch. Two keys are DERIVED from it with
 *    HKDF rather than used directly, so the same secret is never asked to do two
 *    jobs: `encKey` encrypts data, `recoverAuth` proves possession of K to the
 *    relay after every device was lost (the relay keeps only its hash).
 *  - AES-GCM with a random 96-bit nonce per message. The additional data names
 *    the epoch, the kind of message and a context (which log entry, which
 *    snapshot part), so a hostile relay cannot move a valid ciphertext into a
 *    different role, epoch or position without it failing to open.
 *  - Padding to a power of two before encryption, so length leaks a bucket.
 *  - Each device has an ECDH P-256 pair. It exists only to hand K to a specific
 *    device (pairing, rotation): ephemeral-static ECDH, then HKDF, then AES-GCM.
 *
 * Every function that needs randomness or the platform's crypto takes them as
 * the last argument, `env = { crypto, random }`, and defaults to the global.
 * `random(n)` must return n random bytes; tests inject a counter so a nonce is
 * predictable. (Key pair generation inside WebCrypto cannot be seeded, so those
 * are always real.)
 */

export const ENVELOPE_VERSION = 1;

/** The roles a ciphertext can have. A kind outside this list is a bug in the
 *  caller, and refusing it keeps the AAD vocabulary closed. */
export const KINDS = Object.freeze(["log", "snap", "presence", "name", "keybox"]);

/** Smallest padded size. Below this a 40-byte edit and a 200-byte one would
 *  differ visibly for no benefit. */
export const MIN_PAD = 256;

export class CryptoError extends Error {
  /** @param code "format" (not an envelope we understand), "decrypt" (wrong
   *  key, wrong AAD or tampered), "input" (the caller passed something unusable)
   *  or "unsupported" (the platform lacks a primitive). */
  constructor(code, message) {
    super(message);
    this.name = "CryptoError";
    this.code = code;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const utf8 = (s) => enc.encode(s);
export const fromUtf8 = (b) => dec.decode(b);

// ---------------------------------------------------------------- base64url

/** Chunked so a multi-megabyte snapshot does not blow the argument limit of
 *  `String.fromCharCode`. */
export const b64uEncode = (bytes) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const b64uDecode = (text) => {
  if (typeof text !== "string" || /[^A-Za-z0-9_-]/.test(text) || text.length % 4 === 1) {
    throw new CryptoError("format", "not base64url");
  }
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

// -------------------------------------------------------------- environment

const subtleOf = (env) => {
  const subtle = (env.crypto ?? globalThis.crypto)?.subtle;
  if (!subtle) throw new CryptoError("unsupported", "WebCrypto is not available here");
  return subtle;
};

const randomBytes = (env, n) => {
  if (env.random) return env.random(n);
  const c = env.crypto ?? globalThis.crypto;
  if (!c?.getRandomValues) throw new CryptoError("unsupported", "no random source");
  return c.getRandomValues(new Uint8Array(n));
};

/**
 * Whether sync can work on this page at all. `crypto.subtle` exists only in a
 * secure context: https, and also http://127.0.0.1 and localhost, which Chromium
 * treats as potentially trustworthy (this is what the packaged desktop app and a
 * dev server rely on; `selfTest` below is for confirming it on a real build).
 * On a plain http page `subtle` is simply undefined, so the UI should say that
 * sync needs a secure page rather than failing on the first call.
 */
export const cryptoAvailable = (env = {}) => {
  const c = env.crypto ?? globalThis.crypto;
  const secure = (env.isSecureContext ?? globalThis.isSecureContext) !== false;
  return Boolean(secure && c?.subtle && typeof c.getRandomValues === "function");
};

/** True when gzip is available without a fallback. Checked separately because a
 *  page can have WebCrypto and still lack the stream compressors. */
export const compressionAvailable = () =>
  typeof CompressionStream === "function" && typeof DecompressionStream === "function";

// ------------------------------------------------------------------- hashing

export const sha256 = async (bytes, env = {}) =>
  new Uint8Array(await subtleOf(env).digest("SHA-256", bytes));

// ------------------------------------------------------------------- vault key

export const KEY_BYTES = 32;

export const newVaultKey = (env = {}) => randomBytes(env, KEY_BYTES);

const checkKey = (K) => {
  if (!(K instanceof Uint8Array) || K.length !== KEY_BYTES) {
    throw new CryptoError("input", "the vault key must be 32 bytes");
  }
};

const checkEpoch = (epoch) => {
  if (!Number.isInteger(epoch) || epoch < 1) throw new CryptoError("input", "bad epoch");
};

const SALT = utf8("meter-v1");

/**
 * The two keys K stands for in one epoch. Deterministic: the same K and epoch
 * always give the same keys, which is how every device agrees without talking.
 * `encKey` is non-extractable, so nothing that holds it can leak the bytes.
 * Returns `recoverAuth` as bytes because the caller sends it as the proof and
 * the relay hashes it (`sha256`) to compare.
 */
export async function deriveKeys(K, epoch, env = {}) {
  checkKey(K);
  checkEpoch(epoch);
  const subtle = subtleOf(env);
  const base = await subtle.importKey("raw", K, "HKDF", false, ["deriveKey", "deriveBits"]);
  const params = (info) => ({ name: "HKDF", hash: "SHA-256", salt: SALT, info: utf8(info) });
  const encKey = await subtle.deriveKey(params(`enc|${epoch}`), base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const recoverAuth = new Uint8Array(await subtle.deriveBits(params(`recover|${epoch}`), base, 256));
  return { encKey, recoverAuth };
}

// ------------------------------------------------------------------- AAD

/**
 * The additional data bound into every ciphertext:
 * "meter|v1|" + epoch + "|" + kind + "|" + ctx.
 * `ctx` is a string, or a list joined with "|" (a snapshot part is
 * [upto, part, parts], so truncating or reordering parts breaks the tag). A part
 * may not contain "|", otherwise two different lists could build one string.
 */
export const aadFor = (epoch, kind, ctx = "") => {
  checkEpoch(epoch);
  if (!KINDS.includes(kind)) throw new CryptoError("input", `unknown kind ${kind}`);
  const parts = Array.isArray(ctx) ? ctx.map(String) : [String(ctx)];
  if (parts.some((p) => p.includes("|"))) throw new CryptoError("input", "ctx may not contain |");
  return utf8(`meter|v1|${epoch}|${kind}|${parts.join("|")}`);
};

/** The ctx of one snapshot part. */
export const snapCtx = (upto, part, parts) => [upto, part, parts];

// ------------------------------------------------------------------- padding

/**
 * The padded size for n bytes of content: a 4-byte length prefix plus the
 * content, rounded up to the next power of two, at least MIN_PAD.
 */
export const paddedSize = (n) => {
  let size = MIN_PAD;
  while (size < n + 4) size *= 2;
  return size;
};

export const pad = (bytes) => {
  const out = new Uint8Array(paddedSize(bytes.length));
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
};

export const unpad = (padded) => {
  if (padded.length < MIN_PAD || paddedSize(padded.length - 4) !== padded.length) {
    throw new CryptoError("format", "bad padding");
  }
  const n = new DataView(padded.buffer, padded.byteOffset, 4).getUint32(0);
  if (n > padded.length - 4) throw new CryptoError("format", "bad length");
  // Strictly zero padding, so a ciphertext has exactly one valid plaintext.
  for (let i = 4 + n; i < padded.length; i += 1) {
    if (padded[i] !== 0) throw new CryptoError("format", "bad padding");
  }
  return padded.subarray(4, 4 + n);
};

// ------------------------------------------------------------------- envelope

/**
 * Encrypts bytes into `{ v, n, ct }` (base64url). `where` is `{ epoch, kind,
 * ctx }`, the three things the AAD is made of; opening needs the same three.
 */
export async function seal(encKey, where, plaintext, env = {}) {
  const subtle = subtleOf(env);
  const additionalData = aadFor(where.epoch, where.kind, where.ctx);
  const nonce = randomBytes(env, 12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData }, encKey, pad(plaintext));
  return { v: ENVELOPE_VERSION, n: b64uEncode(nonce), ct: b64uEncode(new Uint8Array(ct)) };
}

export async function open(encKey, where, envelope, env = {}) {
  const subtle = subtleOf(env);
  if (!envelope || envelope.v !== ENVELOPE_VERSION) throw new CryptoError("format", "unknown envelope");
  const nonce = b64uDecode(envelope.n);
  if (nonce.length !== 12) throw new CryptoError("format", "bad nonce");
  const ct = b64uDecode(envelope.ct);
  const additionalData = aadFor(where.epoch, where.kind, where.ctx);
  let padded;
  try {
    padded = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData }, encKey, ct));
  } catch {
    // One message for every cause on purpose: telling a wrong key from a wrong
    // AAD from tampering would only help someone probing.
    throw new CryptoError("decrypt", "could not decrypt");
  }
  return unpad(padded);
}

export const sealJson = (encKey, where, value, env = {}) =>
  seal(encKey, where, utf8(JSON.stringify(value)), env);

export const openJson = async (encKey, where, envelope, env = {}) => {
  const bytes = await open(encKey, where, envelope, env);
  try {
    return JSON.parse(fromUtf8(bytes));
  } catch {
    throw new CryptoError("format", "not JSON");
  }
};

// ------------------------------------------------------------------- gzip

/** Compress-then-encrypt is acceptable here: nobody supplies chosen plaintext
 *  to this ledger, and the relay sees only a padded length. */
async function through(bytes, stream) {
  const writer = stream.writable.getWriter();
  // Started, not awaited: a large input fills the stream's buffer and the write
  // only finishes once the reader below drains it, so awaiting first deadlocks.
  const writing = (async () => { await writer.write(bytes); await writer.close(); })();
  // If the stream fails, the reader below throws first. These keep the writer's
  // own rejections from surfacing as unhandled ones on top of that.
  writing.catch(() => {});
  writer.closed.catch(() => {});
  const chunks = [];
  const reader = stream.readable.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await writing;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export async function gzip(bytes) {
  if (!compressionAvailable()) throw new CryptoError("unsupported", "no gzip here");
  return through(bytes, new CompressionStream("gzip"));
}

export async function gunzip(bytes) {
  if (!compressionAvailable()) throw new CryptoError("unsupported", "no gzip here");
  try {
    return await through(bytes, new DecompressionStream("gzip"));
  } catch {
    throw new CryptoError("format", "not gzip");
  }
}

// ------------------------------------------------------------------- ECDH

const CURVE = { name: "ECDH", namedCurve: "P-256" };

const pubOf = (jwk) => ({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y });

/** A device's pair as plain JWKs, trimmed to the fields that matter so what is
 *  stored and sent does not carry platform flags that differ between engines. */
export async function generateDeviceKeys(env = {}) {
  const pair = await subtleOf(env).generateKey(CURVE, true, ["deriveBits"]);
  const priv = await subtleOf(env).exportKey("jwk", pair.privateKey);
  return { publicJwk: pubOf(priv), privateJwk: { ...pubOf(priv), d: priv.d } };
}

const importPublic = (jwk, env) => {
  if (jwk?.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new CryptoError("input", "not a P-256 public key");
  }
  return subtleOf(env).importKey("jwk", { ...pubOf(jwk), ext: true }, CURVE, true, []);
};

const importPrivate = (jwk, env) => {
  if (jwk?.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || !jwk.d) {
    throw new CryptoError("input", "not a P-256 private key");
  }
  return subtleOf(env).importKey("jwk", { ...pubOf(jwk), d: jwk.d, ext: true }, CURVE, false, ["deriveBits"]);
};

const canon = (jwk) => `${jwk.x}.${jwk.y}`;

/** The AES key for one wrap: the ECDH secret run through HKDF, with both public
 *  keys in `info` so the key is tied to this exact sender and recipient. */
async function wrapKeyFor(secretBits, epk, recipient, env) {
  const subtle = subtleOf(env);
  const base = await subtle.importKey("raw", secretBits, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8("meter-v1-wrap"), info: utf8(`wrap|${canon(epk)}|${canon(recipient)}`) },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/**
 * Seals `{ K, epoch }` so only the holder of `recipientPublicJwk`'s private half
 * can open it. A fresh ephemeral key per call means a leaked device key cannot
 * open wraps it never received, and the sender needs no stored identity.
 * `ctx` (a device id) goes in the AAD as kind "keybox", so a wrap made for one
 * device cannot be handed to another.
 */
export async function wrapKey({ K, epoch }, recipientPublicJwk, { ctx = "" } = {}, env = {}) {
  checkKey(K);
  checkEpoch(epoch);
  const subtle = subtleOf(env);
  const recipient = pubOf(recipientPublicJwk);
  const theirs = await importPublic(recipient, env);
  const eph = await subtle.generateKey(CURVE, true, ["deriveBits"]);
  const epk = pubOf(await subtle.exportKey("jwk", eph.publicKey));
  const secret = await subtle.deriveBits({ name: "ECDH", public: theirs }, eph.privateKey, 256);
  const key = await wrapKeyFor(secret, epk, recipient, env);
  const nonce = randomBytes(env, 12);
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aadFor(epoch, "keybox", ctx) },
    key, utf8(JSON.stringify({ K: b64uEncode(K), epoch })));
  return { v: ENVELOPE_VERSION, epk, n: b64uEncode(nonce), ct: b64uEncode(new Uint8Array(ct)) };
}

/**
 * Opens a wrap with this device's private JWK. The caller says which epoch and
 * ctx it expects (the relay tells it the epoch, and the relay is not trusted):
 * a wrong claim fails the tag instead of installing the wrong key.
 */
export async function unwrapKey(box, privateJwk, { epoch, ctx = "" }, env = {}) {
  const subtle = subtleOf(env);
  if (!box || box.v !== ENVELOPE_VERSION) throw new CryptoError("format", "unknown envelope");
  const mine = await importPrivate(privateJwk, env);
  const theirs = await importPublic(box.epk, env);
  const nonce = b64uDecode(box.n);
  if (nonce.length !== 12) throw new CryptoError("format", "bad nonce");
  const ct = b64uDecode(box.ct);
  let plain;
  try {
    const secret = await subtle.deriveBits({ name: "ECDH", public: theirs }, mine, 256);
    const key = await wrapKeyFor(secret, pubOf(box.epk), pubOf(privateJwk), env);
    plain = await subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aadFor(epoch, "keybox", ctx) }, key, ct);
  } catch (e) {
    if (e instanceof CryptoError) throw e;
    throw new CryptoError("decrypt", "could not decrypt");
  }
  let body;
  try { body = JSON.parse(fromUtf8(new Uint8Array(plain))); } catch { throw new CryptoError("format", "not JSON"); }
  const K = b64uDecode(body.K ?? "");
  checkKey(K);
  if (body.epoch !== epoch) throw new CryptoError("decrypt", "epoch mismatch");
  return { K, epoch };
}

/**
 * The six digits both screens show while a device is being added. It is a hash
 * of the two public keys in sorted order, so each side computes the same thing
 * without agreeing who goes first, and swapping either key changes it.
 *
 * `secret` is optional and is the part that makes this strong. Six digits are
 * only ~20 bits: a relay that sees both public keys could try keys until the two
 * codes agree. If the pairing code that travels by camera or by hand carries a
 * secret the relay never sees, mixing it in here leaves that search nothing to
 * aim at. Without it, treat the digits as a guard against mistakes, not against
 * a malicious relay.
 */
export async function comparisonCode(pubA, pubB, { secret } = {}, env = {}) {
  const [first, second] = [canon(pubA), canon(pubB)].sort();
  const parts = [utf8(`meter|v1|sas|${first}|${second}`)];
  if (secret) parts.push(utf8("|"), secret);
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  const digest = await sha256(all, env);
  const n = new DataView(digest.buffer).getUint32(0);
  return String(n % 1_000_000).padStart(6, "0");
}

// ------------------------------------------------------------------- self test

/**
 * Runs each primitive once and reports which fail. For confirming, on a real
 * packaged build, that the page is allowed to use WebCrypto and gzip: it
 * returns `{ ok, failed: [name...] }` and never throws.
 */
export async function selfTest(env = {}) {
  const failed = [];
  const check = async (name, fn) => {
    try { if (!(await fn())) failed.push(name); } catch { failed.push(name); }
  };
  await check("secure-context", () => cryptoAvailable(env));
  await check("aes-gcm", async () => {
    const { encKey } = await deriveKeys(newVaultKey(env), 1, env);
    const where = { epoch: 1, kind: "log", ctx: "t" };
    return fromUtf8(await open(encKey, where, await seal(encKey, where, utf8("ok"), env), env)) === "ok";
  });
  await check("ecdh-p256", async () => {
    const dev = await generateDeviceKeys(env);
    const K = newVaultKey(env);
    const out = await unwrapKey(await wrapKey({ K, epoch: 1 }, dev.publicJwk, {}, env), dev.privateJwk, { epoch: 1 }, env);
    return b64uEncode(out.K) === b64uEncode(K);
  });
  await check("gzip", async () => fromUtf8(await gunzip(await gzip(utf8("ok")))) === "ok");
  return { ok: failed.length === 0, failed };
}
