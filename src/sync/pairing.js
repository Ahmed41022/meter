/**
 * Adding a device, as two small state machines: the APPROVER (a device that
 * already holds the vault) and the JOINER (the new one). No React and no timers
 * in here. Each method does one step and returns a plain state object the UI
 * renders; the UI decides when to call `poll`.
 *
 * Trust, in one paragraph (DESIGN 5.1). The relay carries every message and is
 * assumed hostile, so nothing is believed because the relay said it. The join
 * code, which travels by camera or by hand, carries a secret S the relay never
 * sees. Everything that matters is MACed under a key derived from S: the
 * approver's public key when it opens the slot, the joiner's request, and the
 * approver's answer (the wrapped vault key). A relay that swaps a public key
 * cannot produce a matching MAC, so it is caught by the proof or the ack. The
 * six digits are derived from both public keys AND S too, so they match on the
 * two screens only when nobody interfered, but they are the owner's check that
 * this is the phone in their hand, not the only defence.
 *
 * Transports (built over HTTP in a later step; the fake in tests speaks the same
 * shapes, see DESIGN section 7). Failures are the engine's `TransportError`:
 * "gone" (slot unknown or expired), "conflict" (slot already used), "auth",
 * "network", "paused", "quota".
 *
 *   approver: open({joinId, joinTokenHash, openProof}) -> {expiresAt}
 *             pending() -> null | {joinId, deviceId, pubkey, tokenHash, proof}
 *             approve({joinId, wrapped, ack, epoch}) -> {deviceId}
 *             deny({joinId})
 *   joiner:   request({joinId, joinToken, deviceId, pubkey, tokenHash, proof})
 *             status({joinId, joinToken}) ->
 *               {state:"pending", approverPub, openProof}
 *             | {state:"approved", approverPub, openProof, wrapped, ack, epoch}
 *             | {state:"denied"} | {state:"expired"}
 */
import { TransportError } from "./engine.js";
import {
  b64uDecode, b64uEncode, comparisonCode, deriveJoinKeys, generateDeviceKeys, macSign, macVerify,
  pairingMessages, tokenHash, unwrapKey, wrapKey,
} from "./crypto.js";
import { CodeError, SECRET_BYTES, decodeJoin, encodeJoin, joinLink, relayUrlFor } from "./codes.js";
import { publicJwkOf } from "./vault.js";
import {
  clearJoinSession, loadJoinSession, loadVault, saveJoinSession, saveVault,
} from "./vaultStore.js";

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const randomOf = (env) => (n) =>
  (env.random ? env.random(n) : (env.crypto ?? globalThis.crypto).getRandomValues(new Uint8Array(n)));

const validPub = (k) => k && typeof k === "object" && k.kty === "EC" && k.crv === "P-256"
  && typeof k.x === "string" && typeof k.y === "string" && /^[A-Za-z0-9_-]+$/.test(k.x + k.y);

/** What the UI shows for a failed call. `retry` means the same step can simply
 *  be tried again: the state did not change. */
const describe = (e) => {
  if (!(e instanceof TransportError)) return { code: "unexpected", message: "Something went wrong.", retry: false };
  const code = e.code;
  const table = {
    network: ["No connection to the relay. Check the network and try again.", true],
    paused: ["The relay is busy or paused. Try again in a little while.", true],
    quota: ["The relay has reached a limit for now. Try again later.", true],
    auth: ["The relay refused this request.", false],
    gone: ["This code has expired or was already used. Start again on the other device.", false],
    conflict: ["This code has already been used by another device.", false],
  };
  const [message, retry] = table[code] ?? ["The relay returned an error.", false];
  return { code, message, retry };
};

// ------------------------------------------------------------------- approver

/**
 * `vault` is the saved identity of the device that holds the vault (K as
 * base64url, epoch, token, keys). `appOrigin` is the page address a link should
 * point at (null to give only the typed code).
 */
export function createApprover({ transport, vault, appOrigin = null, now = Date.now, env = {} }) {
  const random = randomOf(env);
  const approverPub = publicJwkOf(vault);
  let session = null; // { S, joinId, keys, expiresAt }
  let request = null; // the verified request awaiting a decision
  let state = { role: "approver", phase: "idle", error: null };

  const set = (patch) => { state = { role: "approver", error: null, ...patch }; return state; };
  const withError = (e) => { state = { ...state, error: describe(e) }; return state; };
  const finish = (phase, extra = {}) => { session = null; request = null; return set({ phase, ...extra }); };

  const expired = () => session && now() >= session.expiresAt;

  return {
    get state() { return state; },

    /** Opens a join slot and returns the code to show. */
    async start() {
      if (!vault?.vaultId) return set({ phase: "failed", reason: "not_registered", error: { code: "state", message: "This device has no vault on the relay yet.", retry: false } });
      const S = random(SECRET_BYTES);
      const joinId = hex(random(8));
      const keys = await deriveJoinKeys(S, env);
      const openProof = await macSign(keys.macKey, pairingMessages.open({ joinId, approverPub }), env);
      let opened;
      try {
        opened = await transport.open({ joinId, joinTokenHash: await tokenHash(keys.joinToken, env), openProof });
      } catch (e) {
        return set({ phase: "idle", error: describe(e) });
      }
      session = { S, joinId, keys, expiresAt: opened.expiresAt };
      const join = { host: new URL(vault.relay).host, vaultId: vault.vaultId, joinId, secret: S };
      return set({
        phase: "waiting", joinId, expiresAt: opened.expiresAt,
        code: encodeJoin(join), link: appOrigin ? joinLink(appOrigin, join) : null,
      });
    },

    /** Looks for a request. Safe to call on a timer, or when a socket says one arrived. */
    async poll() {
      if (!session || state.phase !== "waiting") return state;
      if (expired()) return finish("expired");
      let got;
      try {
        got = await transport.pending();
      } catch (e) {
        if (e instanceof TransportError && e.code === "gone") return finish("expired");
        return withError(e);
      }
      if (!got) return set({ phase: "waiting", joinId: state.joinId, expiresAt: state.expiresAt, code: state.code, link: state.link });
      const ok = got.joinId === session.joinId && validPub(got.pubkey)
        && /^[0-9a-f]{16}$/.test(got.deviceId ?? "") && typeof got.tokenHash === "string"
        && await macVerify(session.keys.macKey, pairingMessages.request({ ...got, joinId: session.joinId }), got.proof, env);
      if (!ok) {
        // Only the holder of S can make a valid request, so this came from the
        // relay or from nowhere. Close the slot and say so; never show it.
        try { await transport.deny({ joinId: session.joinId }); } catch { /* the slot is dead to us either way */ }
        return finish("failed", { reason: "bad_proof", error: { code: "bad_proof", message: "A request arrived that did not come from this code, so it was refused. If this keeps happening, the relay may be interfering.", retry: false } });
      }
      request = got;
      const digits = await comparisonCode(approverPub, got.pubkey, { secret: session.keys.sasSecret }, env);
      return set({
        phase: "confirm", joinId: session.joinId, expiresAt: session.expiresAt, digits,
        joiner: { deviceId: got.deviceId, publicJwk: got.pubkey },
      });
    },

    /** The owner saw matching digits: send the key. */
    async approve() {
      if (state.phase !== "confirm" || !request) return state;
      if (expired()) return finish("expired");
      const { joinId, keys } = session;
      const wrapped = await wrapKey({ K: b64uDecode(vault.K), epoch: vault.epoch }, request.pubkey,
        { ctx: request.deviceId }, env);
      const ack = await macSign(keys.macKey, pairingMessages.ack({
        joinId, deviceId: request.deviceId, approverPub, pubkey: request.pubkey, epoch: vault.epoch, wrapped,
      }), env);
      try {
        const res = await transport.approve({ joinId, wrapped, ack, epoch: vault.epoch });
        return finish("approved", { joiner: { deviceId: res?.deviceId ?? request.deviceId } });
      } catch (e) {
        if (e instanceof TransportError && e.code === "gone") return finish("expired");
        return withError(e);
      }
    },

    async deny() {
      if (!session) return state;
      const { joinId } = session;
      try {
        await transport.deny({ joinId });
      } catch (e) {
        if (!(e instanceof TransportError && e.code === "gone")) return withError(e);
      }
      return finish("denied");
    },

    /** Walking away from the screen: the slot is left to expire. */
    cancel() { return finish("cancelled"); },
  };
}

// ------------------------------------------------------------------- joiner

/**
 * `transportFor({ relay, vaultId })` builds the joiner's transport once the code
 * is decoded. Progress is kept in storage (`win`), so `resume()` can carry on
 * after the app was closed, including after the other device has approved.
 */
export function createJoiner({ transportFor, win = globalThis, env = {} }) {
  const random = randomOf(env);
  let session = null;
  let keys = null;
  let transport = null;
  let state = { role: "joiner", phase: "idle", error: null };

  const set = (patch) => { state = { role: "joiner", error: null, ...patch }; return state; };
  const withError = (e) => { state = { ...state, error: describe(e) }; return state; };
  const end = (phase, extra = {}) => { clearJoinSession(win); session = null; keys = null; return set({ phase, ...extra }); };
  const bad = (reason, message) => end("failed", { reason, error: { code: reason, message, retry: false } });
  const myPub = () => publicJwkOf(session);

  /** The digits are shown once the approver's key is known and vouched for. */
  const digitsFor = (approverPub) =>
    comparisonCode(approverPub, myPub(), { secret: keys.sasSecret }, env);

  async function load(next) {
    session = next;
    keys = await deriveJoinKeys(b64uDecode(session.S), env);
    transport = transportFor({ relay: session.relay, vaultId: session.vaultId });
  }

  async function sendRequest() {
    const th = await tokenHash(session.token, env);
    const req = { joinId: session.joinId, deviceId: session.deviceId, pubkey: myPub(), tokenHash: th };
    try {
      await transport.request({ ...req, joinToken: keys.joinToken, proof: await macSign(keys.macKey, pairingMessages.request(req), env) });
    } catch (e) {
      if (e instanceof TransportError && (e.code === "gone" || e.code === "conflict" || e.code === "auth")) {
        const d = describe(e);
        return end("failed", { reason: e.code === "gone" ? "expired" : e.code === "conflict" ? "used" : "refused", error: d });
      }
      return set({ phase: "requesting", error: describe(e) });
    }
    return set({ phase: "waiting", digits: session.approverPub ? await digitsFor(session.approverPub) : null });
  }

  /** The approver's key is trusted only with its MAC under S. */
  const vouched = (approverPub, openProof) => validPub(approverPub)
    && macVerify(keys.macKey, pairingMessages.open({ joinId: session.joinId, approverPub }), openProof, env);

  return {
    get state() { return state; },

    /** Takes what the person pasted or scanned and sends the request. */
    async start(codeText) {
      if (loadVault(win)?.vaultId) {
        return set({ phase: "failed", reason: "has_vault", error: { code: "has_vault", message: "This device already has a vault. Leave it in Settings before joining another.", retry: false } });
      }
      let join;
      try {
        join = decodeJoin(codeText);
      } catch (e) {
        if (e instanceof CodeError) return set({ phase: "failed", reason: "bad_code", error: { code: e.code, message: e.message, retry: false } });
        throw e;
      }
      const pair = await generateDeviceKeys(env);
      try {
        await load({
          relay: relayUrlFor(join.host), vaultId: join.vaultId, joinId: join.joinId,
          S: b64uEncode(join.secret), deviceId: hex(random(8)), token: b64uEncode(random(32)),
          privateJwk: pair.privateJwk, approverPub: null,
        });
      } catch (e) {
        if (e instanceof TransportError) return set({ phase: "failed", reason: "expired", error: describe(e) });
        throw e;
      }
      // Saved before anything is sent: see saveJoinSession.
      if (!saveJoinSession(session, win)) {
        session = null;
        return set({ phase: "failed", reason: "storage", error: { code: "storage", message: "This device cannot save the pairing in progress, so it cannot be completed here.", retry: false } });
      }
      set({ phase: "requesting" });
      return sendRequest();
    },

    /** Picks up a pairing left in storage. Idle when there is none. */
    async resume() {
      const saved = loadJoinSession(win);
      if (!saved) return set({ phase: "idle" });
      await load(saved);
      set({ phase: "requesting" });
      return sendRequest();
    },

    /** One look at the relay: pending, approved (and finishing), denied or expired. */
    async poll() {
      if (!session) return state;
      if (state.phase === "requesting") {
        const sent = await sendRequest();
        if (sent.phase !== "waiting") return sent;
      }
      let r;
      try {
        r = await transport.status({ joinId: session.joinId, joinToken: keys.joinToken });
      } catch (e) {
        if (e instanceof TransportError && e.code === "gone") return end("expired", { error: describe(e) });
        if (e instanceof TransportError && e.code === "auth") return end("failed", { reason: "refused", error: describe(e) });
        return withError(e);
      }
      if (r.state === "denied") return end("denied");
      if (r.state === "expired") return end("expired");

      // Whatever the state, the approver's key must be vouched for, and must be
      // the same one as before: a key that changes mid-way is an attack.
      if (!(await vouched(r.approverPub, r.openProof))) {
        return bad("bad_proof", "The other device's key could not be verified, so nothing was shared. If this keeps happening, the relay may be interfering.");
      }
      if (session.approverPub && (session.approverPub.x !== r.approverPub.x || session.approverPub.y !== r.approverPub.y)) {
        return bad("bad_proof", "The other device's key changed while pairing, so nothing was shared.");
      }
      if (!session.approverPub) {
        session = { ...session, approverPub: { kty: "EC", crv: "P-256", x: r.approverPub.x, y: r.approverPub.y } };
        saveJoinSession(session, win);
      }
      if (r.state === "pending") return set({ phase: "waiting", digits: await digitsFor(session.approverPub) });
      if (r.state !== "approved") return bad("relay_error", "The relay sent something Meter does not understand.");

      const message = pairingMessages.ack({
        joinId: session.joinId, deviceId: session.deviceId, approverPub: session.approverPub,
        pubkey: myPub(), epoch: r.epoch, wrapped: r.wrapped ?? {},
      });
      let K;
      try {
        if (!Number.isInteger(r.epoch) || r.epoch < 1 || !(await macVerify(keys.macKey, message, r.ack, env))) throw new Error("ack");
        ({ K } = await unwrapKey(r.wrapped, session.privateJwk, { epoch: r.epoch, ctx: session.deviceId }, env));
      } catch {
        return bad("bad_ack", "The key that arrived did not come from the other device, so it was thrown away. Nothing was shared; try again.");
      }
      const vault = {
        relay: session.relay, vaultId: session.vaultId, invite: null, epoch: r.epoch, K: b64uEncode(K),
        deviceId: session.deviceId, token: session.token, privateJwk: session.privateJwk,
      };
      // The session is kept until the vault is really saved: losing K here would
      // strand a device the approver has already registered.
      if (!saveVault(vault, win)) {
        return set({ phase: "waiting", digits: state.digits ?? null, error: { code: "storage", message: "This device could not save the vault. Free some space and try again.", retry: true } });
      }
      return end("joined", { vaultId: vault.vaultId, epoch: vault.epoch });
    },

    cancel() { return end("cancelled"); },
  };
}
