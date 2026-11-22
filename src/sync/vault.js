/**
 * A vault's identity on this device, before and after the relay knows about it.
 *
 * Creating one is local first: the key, the device's own keys and a token are
 * made here and saved, and only then does the relay get asked to register the
 * vault, which is when it hands back the vault id (DESIGN M1). That order is the
 * point. If the app closes, or the request fails, between the two, what exists is
 * a saved identity with `vaultId: null`, and the next attempt registers that
 * same identity (same token hash, same invite) instead of minting a second vault
 * and stranding the first.
 *
 * Plain data in, plain data out, so it is testable without storage; the caller
 * saves it with vaultStore.
 */
import {
  b64uEncode, generateDeviceKeys, newVaultKey, sha256,
} from "./crypto.js";
import { CodeError, checkRelayUrl, isVaultId, parseInviteCode } from "./codes.js";

/** A new, unregistered vault: epoch 1 and a fresh K, device id, token and ECDH
 *  pair. `invite` is the canonical code being spent, if the relay needs one.
 *  The device id is random and its own: the per-origin id sessions use says
 *  where a meter is running and must not change if the vault is left or rejoined. */
export async function createLocalVault({ relay, invite = null }, env = {}) {
  const keys = await generateDeviceKeys(env);
  const random = (n) => (env.random ? env.random(n) : globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const deviceBytes = random(8);
  return {
    relay: checkRelayUrl(relay),
    vaultId: null,
    invite: invite ? parseInviteCode(invite) : null,
    epoch: 1,
    K: b64uEncode(newVaultKey(env)),
    deviceId: [...deviceBytes].map((b) => b.toString(16).padStart(2, "0")).join(""),
    token: b64uEncode(random(32)),
    privateJwk: keys.privateJwk,
  };
}

export const isRegistered = (vault) => Boolean(vault?.vaultId);

/** The vault with the id the relay returned. Refuses a malformed id rather than
 *  saving something every later request would 404 on, and the invite is spent so
 *  it is dropped. */
export function withVaultId(vault, vaultId) {
  if (!isVaultId(vaultId)) throw new CodeError("format", "The relay returned a vault id in a form Meter does not recognise.");
  return { ...vault, vaultId, invite: null };
}

/** The public half of this device's pair, which is all the relay ever sees. */
export const publicJwkOf = (vault) => ({
  kty: "EC", crv: "P-256", x: vault.privateJwk.x, y: vault.privateJwk.y,
});

/** What the relay stores to recognise this device's token: the digest, never the
 *  token. base64url, as it goes in the request body. */
export const tokenHashOf = async (vault, env = {}) =>
  b64uEncode(await sha256(new TextEncoder().encode(vault.token), env));
