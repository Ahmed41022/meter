/**
 * The steps of Meter Sync that change what this device holds, as plain async
 * functions: no React, and `fetch` and the storage window are passed in, so the
 * order of the steps (which is the whole point of them) is tested without a page.
 */
import { b64uDecode } from "./crypto.js";
import { encodeRecoveryCode, parseInviteCode } from "./codes.js";
import { createLocalVault, withVaultId } from "./vault.js";
import { registerVault } from "./relay.js";
import {
  SYNC_KEY, clearVault, loadVault, saveVault,
} from "./vaultStore.js";
import { loadSetting, saveSetting } from "../storage/settings.js";

/** The device cannot keep the vault, so nothing may be made: a recovery code for
 *  a key this device then forgets is the failure this guards against. */
export class StorageError extends Error {
  constructor() {
    super("This device cannot save the account (storage is full or blocked), so it was not created. Free some space and try again.");
    this.name = "StorageError";
  }
}

/**
 * Makes an account on `relay`: identity first, saved; then registration; then
 * the vault id, saved. Returns the saved, registered vault.
 *
 * The order is what makes it safe to repeat. If the app closes, or the request
 * fails, after the first save, what exists is an identity with `vaultId: null`;
 * the next call finds it and registers THE SAME one (same token, same invite),
 * and the relay answers with the same vault. A different invite typed in the
 * meantime is taken instead of the saved one, since the saved one was never
 * bound to anything until the relay said yes.
 */
export async function createAccount({ fetch, win = globalThis, relay, invite = null, name = null }) {
  const code = invite ? parseInviteCode(invite) : null;
  let vault = loadVault(win);
  if (vault?.vaultId) throw new Error("This device already has an account.");
  if (vault && vault.relay === relay) {
    vault = { ...vault, invite: code ?? vault.invite ?? null };
  } else {
    vault = await createLocalVault({ relay, invite: code });
  }
  if (!saveVault(vault, win)) throw new StorageError();

  const { vaultId } = await registerVault({ fetch, vault, name });
  const registered = withVaultId(vault, vaultId);
  if (!saveVault(registered, win)) throw new StorageError();
  // From here until the person confirms, the recovery code is the next thing
  // this device shows, however they got away from the screen.
  saveSetting(SYNC_KEY.ACK, "pending", win);
  return registered;
}

/** The recovery code of a vault, in its eight groups. */
export const recoveryCodeOf = (vault) => encodeRecoveryCode(b64uDecode(vault.K));

export const recoveryPending = (win = globalThis) => loadSetting(SYNC_KEY.ACK, "", win) === "pending";

export const acknowledgeRecovery = (win = globalThis) => saveSetting(SYNC_KEY.ACK, null, win);

/** Forgets the vault on this device: identity, progress and any pairing in
 *  progress. The ledger is not touched, and nothing is said to the relay: the
 *  account stays for the other devices. */
export const leaveVault = (win = globalThis) => clearVault(win);
