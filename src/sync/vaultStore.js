/**
 * What this device keeps about its sync vault, under `meter:sync*`.
 *
 * Like the Google client id this is per device and never part of the ledger:
 * it holds the vault key, which is the one thing that must not ride along in a
 * backup file or in a synced state. The JSON export serialises the ledger
 * object only and nothing here is reachable from it; a test pins that.
 *
 * Three keys, split by how often they change and how much it costs to lose them:
 *
 *  - `meter:sync` is who this device is: relay, vault id, epoch, the vault key
 *    K, device id and token, the ECDH private key. Rarely written, and losing it
 *    means rejoining, so it is never overwritten with something half-valid.
 *  - `meter:sync:meta` is the cursor, the snapshot position and the batch that
 *    was in flight. Small, written after every round.
 *  - `meter:sync:sent` is the map of what the relay has acknowledged. It is the
 *    big one (about 30 bytes per record), so it has its own key and is rewritten
 *    only when it changed. Losing it is safe by design: every record becomes
 *    pending and is pushed once more, which the relay merges harmlessly.
 *
 * Reads and writes go through the guarded helpers of settings.js, so blocked or
 * full storage reads as "nothing there" and writes report false instead of
 * throwing. A value that no longer parses is treated as absent and left in place
 * rather than removed: a corrupt `meter:sync` might still be readable by hand.
 */
import { loadSetting, saveSetting } from "../storage/settings.js";

export const SYNC_KEY = {
  VAULT: "meter:sync",
  META: "meter:sync:meta",
  SENT: "meter:sync:sent",
};

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && v.length > 0;

const readJson = (key, win) => {
  const raw = loadSetting(key, "", win);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

/** Enough to be usable; anything less is treated as no vault at all, because
 *  syncing with a missing key or token could only fail confusingly. `vaultId`
 *  may be null: a vault is minted on this device first and gets its id from the
 *  relay afterwards, and an app closed between the two must come back to it. The
 *  invite that is being spent is kept too (also optional), so a retry presents
 *  the same one. */
const validVault = (v) =>
  isObject(v) && text(v.relay) && (v.vaultId === null || text(v.vaultId))
  && (v.invite === undefined || v.invite === null || text(v.invite))
  && Number.isInteger(v.epoch) && v.epoch >= 1
  && text(v.K) && text(v.deviceId) && text(v.token)
  && isObject(v.privateJwk) && text(v.privateJwk.d);

/** The saved identity, or null if there is none or it cannot be trusted. */
export const loadVault = (win = globalThis) => {
  const v = readJson(SYNC_KEY.VAULT, win);
  return validVault(v) ? v : null;
};

/** Returns false when it could not be stored. Callers that have just minted a
 *  key MUST check: showing a recovery code for a vault this device then forgets
 *  is the failure this guards against. */
export const saveVault = (vault, win = globalThis) => {
  if (!validVault(vault)) return false;
  return saveSetting(SYNC_KEY.VAULT, JSON.stringify(vault), win);
};

/** Leaves the vault on this device: identity and progress, never the ledger. */
export const clearVault = (win = globalThis) => {
  for (const key of Object.values(SYNC_KEY)) saveSetting(key, null, win);
};

const FRESH = () => ({ cursor: null, sent: {}, inflight: null, snapshotUpto: null });

/**
 * The `{ load, save }` the engine wants for this device's progress. A bad or
 * missing value reads as a fresh start (no cursor, nothing sent), which makes
 * the next round pull from the snapshot and re-push everything: slower, never
 * wrong.
 */
export const progressStore = (win = globalThis) => {
  // What was last written, so an unchanged map is not rewritten every round.
  let lastSent = null;
  let lastMeta = null;
  return {
    load() {
      const meta = readJson(SYNC_KEY.META, win);
      const sent = readJson(SYNC_KEY.SENT, win);
      const out = FRESH();
      if (isObject(meta)) {
        if (Number.isInteger(meta.cursor) && meta.cursor >= 0) out.cursor = meta.cursor;
        if (Number.isInteger(meta.snapshotUpto) && meta.snapshotUpto >= 0) out.snapshotUpto = meta.snapshotUpto;
        if (isObject(meta.inflight) && text(meta.inflight.bid) && isObject(meta.inflight.batch)) {
          out.inflight = meta.inflight;
        }
      }
      if (isObject(sent)) out.sent = sent;
      return out;
    },
    save(meta) {
      const small = JSON.stringify({
        cursor: meta.cursor ?? null,
        snapshotUpto: meta.snapshotUpto ?? null,
        inflight: meta.inflight ?? null,
      });
      const big = JSON.stringify(meta.sent ?? {});
      let ok = true;
      if (small !== lastMeta) {
        ok = saveSetting(SYNC_KEY.META, small, win) && ok;
        if (ok) lastMeta = small;
      }
      if (big !== lastSent) {
        const wrote = saveSetting(SYNC_KEY.SENT, big, win);
        if (wrote) lastSent = big;
        ok = wrote && ok;
      }
      return ok;
    },
  };
};
