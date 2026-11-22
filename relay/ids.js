/**
 * Vault ids (DESIGN M1): `<128 random bits as 32 hex>.<mac as 16 hex>` where
 * mac = the first 8 bytes of HMAC-SHA256(ROUTE_KEY, <the 32 hex characters>).
 *
 * Why a mac at all: a Durable Object is created by merely naming it, so without
 * this any string a stranger sends would wake or create one. The Worker checks
 * the mac FIRST, which costs a few microseconds of CPU and never touches a
 * Durable Object, so guessing ids costs the attacker a request and costs the
 * relay nothing durable. The shape is the one src/sync/codes.js `isVaultId`
 * expects; a test keeps the two in agreement.
 *
 * The HMAC is over the text of the random part (not its bytes) so the Worker
 * does no decoding before the check.
 */
import { hexOf, safeEqual } from "./util.js";

const encoder = new TextEncoder();
export const VAULT_ID = /^[0-9a-f]{32}\.[0-9a-f]{16}$/;

const hmacKey = (routeKey) => {
  if (typeof routeKey !== "string" || routeKey.length < 16) throw new Error("ROUTE_KEY must be a secret of at least 16 characters");
  return crypto.subtle.importKey("raw", encoder.encode(routeKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
};

const macOf = async (routeKey, rand) =>
  hexOf(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(routeKey), encoder.encode(rand))).slice(0, 8));

/** A new id. `random(n)` returns n random bytes. */
export async function mintVaultId(routeKey, random) {
  const rand = hexOf(random(16));
  return `${rand}.${await macOf(routeKey, rand)}`;
}

/** True only for an id this relay minted. Malformed input is false, never a throw. */
export async function verifyVaultId(routeKey, id) {
  if (typeof id !== "string" || !VAULT_ID.test(id)) return false;
  const [rand, mac] = id.split(".");
  return safeEqual(mac, await macOf(routeKey, rand));
}
