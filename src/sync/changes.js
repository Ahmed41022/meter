/**
 * What goes over the wire: the difference between this ledger and what the relay
 * has been told, and how a difference from elsewhere is taken in.
 *
 * A change is a whole RECORD, `{ k: "sessions", r: {...} }`, never a patch to
 * one field. Merging is last-write-wins per record (see domain/merge.js), so a
 * record that arrives is judged by exactly the rule that judges it locally, and
 * the order batches arrive in cannot change where two devices end up. That is
 * also why a batch applied twice is harmless, and why nothing here needs a
 * clock or a transport: it is pure functions over a ledger and a `sent` map.
 *
 * `sent` is `{ "sessions/s1": 1700000000000, ... }`: for each record, the stamp
 * of the version the relay is known to hold. It is a CACHE of what the relay
 * acknowledged, and it fails in the safe direction. Lose it and every record is
 * pending again, so one idempotent re-push; the alternative of remembering a
 * "dirty" list written at each edit could fall out of step with the ledger on a
 * crash and strand an edit for ever.
 *
 * What is pending is decided by STAMP, which is what keeps the heartbeat out of
 * it. `lastTick` is written without an `updatedAt` (hooks/useHeartbeat), so a
 * ticking meter changes a record's content but not its stamp, and a record whose
 * stamp the relay already has is never pending.
 */
import { collectionKeys, mergeState, stampOf } from "../domain/merge.js";

/** The version of the batch layout this build writes and understands. A build
 *  that meets a NEWER one must stop and say so: guessing at a layout it has not
 *  seen is how a ledger gets quietly damaged. */
export const BATCH_VERSION = 1;

/** Plaintext bytes after which a batch is split. The relay's cap is on the
 *  encrypted body, which is larger (base64, padding, tag), so this stays well
 *  inside it. */
export const MAX_BATCH_BYTES = 150_000;

/** The batch is from a newer build than this one. The caller shows "update
 *  Meter" and must NOT advance past it, or the changes would be lost for good. */
export class UnsupportedBatch extends Error {
  constructor(version) {
    super("This sync data is from a newer version of Meter. Update the app to keep syncing.");
    this.name = "UnsupportedBatch";
    this.version = version;
  }
}

/** The key under which the scalar backup stamp is tracked. It cannot collide
 *  with a record key, which always has a "/". */
const BACKUP = "@lastBackupAt";

const keyOf = (collection, id) => `${collection}/${id}`;

/** Sent stamps are numbers; anything else (a hand-edited or damaged map) reads
 *  as "never sent", which only costs a re-push. */
const sentStamp = (sent, key) => {
  const at = sent?.[key];
  return Number.isFinite(at) ? at : null;
};

/**
 * Everything the relay has not been told: records whose stamp is later than the
 * one acknowledged, or that were never acknowledged at all.
 *
 * `meta` carries the scalar `lastBackupAt` the same way, so it is not stamped
 * but compared with what was sent.
 */
export const pending = (state, sent = {}) => {
  const changes = [];
  for (const k of collectionKeys(state)) {
    for (const r of state[k]) {
      const at = sentStamp(sent, keyOf(k, r.id));
      if (at === null || stampOf(r) > at) changes.push({ k, r });
    }
  }
  const meta = {};
  const backup = state?.lastBackupAt;
  if (Number.isFinite(backup) && (sentStamp(sent, BACKUP) ?? -Infinity) < backup) {
    meta.lastBackupAt = backup;
  }
  return { changes, meta };
};

/** One batch, as the plaintext that gets encrypted. */
export const toBatch = (changes, meta = {}) => ({ v: BATCH_VERSION, changes, meta });

/**
 * Pending work cut into batches of a bounded size, so a first push of a whole
 * ledger is several modest requests rather than one the relay would refuse.
 * The scalars ride in the first. Returns [] when there is nothing to say.
 */
export const toBatches = ({ changes, meta }, maxBytes = MAX_BATCH_BYTES) => {
  const hasMeta = Object.keys(meta ?? {}).length > 0;
  if (!changes.length && !hasMeta) return [];
  const batches = [];
  let run = [];
  let size = 0;
  for (const change of changes) {
    const bytes = JSON.stringify(change).length;
    if (run.length && size + bytes > maxBytes) {
      batches.push(run);
      run = [];
      size = 0;
    }
    run.push(change);
    size += bytes;
  }
  if (run.length || !batches.length) batches.push(run);
  return batches.map((list, i) => toBatch(list, i === 0 ? meta : {}));
};

/**
 * Record that the relay accepted this batch: each record is now known at the
 * stamp it had WHEN SENT. Taken from the batch rather than from the ledger as it
 * is now, because an edit made while the request was in flight has a later stamp
 * and must still read as pending.
 */
export const acknowledge = (sent, batch) => {
  const next = { ...sent };
  for (const { k, r } of batch.changes) next[keyOf(k, r.id)] = stampOf(r);
  if (Number.isFinite(batch.meta?.lastBackupAt)) next[BACKUP] = batch.meta.lastBackupAt;
  return next;
};

const check = (batch) => {
  if (!batch || typeof batch !== "object" || !Number.isInteger(batch.v)) {
    throw new Error("A sync batch was not readable.");
  }
  if (batch.v > BATCH_VERSION) throw new UnsupportedBatch(batch.v);
  if (!Array.isArray(batch.changes)) throw new Error("A sync batch was not readable.");
  for (const change of batch.changes) {
    const ok = typeof change?.k === "string" && change.k !== "__proto__"
      && change.r !== null && typeof change.r === "object"
      && (typeof change.r.id === "string" || Number.isFinite(change.r.id));
    if (!ok) throw new Error("A sync batch was not readable.");
  }
};

/** The same version of a record: identical content, not merely the same stamp.
 *  At a tie a different one may have won, and that one is NOT what the relay
 *  holds. */
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Takes the relay's version of each record in, by the merge's own rule, and
 * notes which of them the relay now holds.
 *
 * `sent` moves only for a record whose merged result IS the relay's copy. If the
 * local one won (a later edit, or a tie it wins) it stays as it was, so it is
 * still pending and goes back up. That one rule is also the whole of echo
 * suppression: a record that just arrived is never sent straight back.
 *
 * Returns `{ state, sent, changed }`. When nothing changed `state` is the very
 * object passed in, so a caller can skip a write and a render.
 */
export const applyBatch = (state, batch, sent = {}) => {
  check(batch);
  const incoming = {};
  for (const { k, r } of batch.changes) (incoming[k] ??= []).push(r);
  const lists = Object.keys(incoming);
  const base = state ?? {};
  const before = new Map();
  for (const k of lists) {
    for (const r of Array.isArray(base[k]) ? base[k] : []) before.set(keyOf(k, r.id), r);
  }
  const theirs = { ...incoming };
  const backup = batch.meta?.lastBackupAt;
  if (Number.isFinite(backup)) theirs.lastBackupAt = backup;

  const merged = mergeState(base, theirs);
  const next = { ...sent };
  let changed = false;
  for (const k of lists) {
    if (!Array.isArray(merged[k])) continue;
    const now = new Map(merged[k].map((r) => [r.id, r]));
    for (const r of incoming[k]) {
      const key = keyOf(k, r.id);
      const result = now.get(r.id);
      if (result !== before.get(key)) changed = true;
      if (result && same(result, r)) {
        next[key] = Math.max(stampOf(r), sentStamp(next, key) ?? -Infinity);
      }
    }
  }
  if (Number.isFinite(backup)) {
    if (merged.lastBackupAt !== base.lastBackupAt) changed = true;
    if (merged.lastBackupAt === backup) next[BACKUP] = backup;
  }
  return { state: changed ? merged : state, sent: next, changed };
};

/**
 * Joining the relay's copy: a new device, a far-behind one, one that has seen
 * the vault re-keyed, or a relay that was started again.
 *
 * Merges the snapshot in and REBUILDS `sent` from it. The old map is dropped on
 * purpose: it said what a relay we are no longer talking to once held, and
 * trusting it would strand any record the new relay never got. Rebuilt from the
 * snapshot, a record is "sent" only where the snapshot holds this very version;
 * everything newer, or absent from it, stays pending, so a phone with a ledger
 * of its own pushes only what differs rather than all of it.
 */
export const reconcile = (state, snapshot) => {
  const merged = mergeState(state, snapshot);
  const sent = {};
  for (const k of collectionKeys(snapshot)) {
    const mine = new Map((merged[k] ?? []).map((r) => [r.id, r]));
    for (const r of snapshot[k]) {
      if (same(mine.get(r.id), r)) sent[keyOf(k, r.id)] = stampOf(r);
    }
  }
  if (Number.isFinite(snapshot?.lastBackupAt) && merged.lastBackupAt === snapshot.lastBackupAt) {
    sent[BACKUP] = snapshot.lastBackupAt;
  }
  return { state: merged, sent };
};

/** Forgets what was sent for records the ledger no longer holds, such as after
 *  a restore replaced it. Records are tombstoned, not removed, so this is rare
 *  and only keeps the map from growing for ever. */
export const pruneSent = (state, sent = {}) => {
  const live = new Set([BACKUP]);
  for (const k of collectionKeys(state)) for (const r of state[k]) live.add(keyOf(k, r.id));
  return Object.fromEntries(Object.entries(sent).filter(([key]) => live.has(key)));
};
