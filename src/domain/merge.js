/**
 * Reconciling two copies of the ledger.
 *
 * Two devices both wrote. Neither copy is authoritative and neither may be
 * thrown away, so the merge happens RECORD BY RECORD rather than document by
 * document: taking the newer whole file would silently delete whatever the other
 * device did that day.
 *
 * This model is unusually safe to merge, for three reasons it did not acquire by
 * accident:
 *
 *  - Every record has a stable id, minted once and never reused.
 *  - Deletion is a field (`deletedAt`), not a removal. So a delete merges like
 *    any other edit, and the classic sync bug — a deleted record resurrected by
 *    the device that never saw the delete — cannot happen here.
 *  - NOTHING accumulates. Elapsed time is derived from segments and money from
 *    rate x elapsed, so there are no counters to add up wrongly. Last write wins
 *    is enough; no field needs a smarter rule.
 *
 * What it cannot do is invent a third answer. Where both devices changed the
 * SAME record, the later edit wins whole and the earlier one is lost. That is
 * the honest limit of last-write-wins, and the reason `overlaps` exists below:
 * the one collision that silently corrupts totals is two devices recording time
 * over the same hour, and that must be reported rather than absorbed.
 *
 * Like the rest of `domain/`, nothing here reads the clock or storage.
 */
import { overlapMs } from "./time.js";
import { isBilled } from "./sessions.js";

/** The lists this build KNOWS hold records with ids: what the UI counts and what
 *  a restore replaces. It is NOT what merging looks at — a list a newer build
 *  added is merged too (see `collectionKeys`), because filtering by this list
 *  made an older device drop, on its next sync, everything it did not
 *  recognise. */
export const COLLECTIONS = ["projects", "sessions", "objectives", "earnings", "companies", "todos", "payouts", "prefs"];

/** Absent means older than anything stamped, which is what every record written
 *  before sync existed is. It loses to a record that has been touched since, and
 *  that is the right way round: the stamped one is the one somebody changed. */
export const stampOf = (record) => {
  const at = Number(record?.updatedAt);
  return Number.isFinite(at) ? at : 0;
};

/**
 * Mark what this change actually touched.
 *
 * Reducers in `domain/` are pure and build new objects by spreading, so a record
 * the change did not touch comes back REFERENCE-IDENTICAL. That makes the diff a
 * pointer comparison over each list — O(n), no deep equality, and exactly right
 * for this codebase rather than approximately right for any codebase.
 */
const isRecord = (r) =>
  r !== null && typeof r === "object" && !Array.isArray(r)
  && (typeof r.id === "string" || Number.isFinite(r.id));

/** A list of records that can be merged by id. Empty counts: it is what a
 *  collection that has nothing in it yet looks like. */
const isRecordList = (value) => Array.isArray(value) && value.every(isRecord);

/**
 * Which top-level keys of these states are lists to merge record by record.
 *
 * Decided by SHAPE (an array of objects with ids), not by name, so a collection
 * a newer build introduced survives a device that has never heard of it. The
 * known `COLLECTIONS` only need to be arrays: they are trusted, and a record
 * with no id there is a bug to keep merging as before, not a reason to start
 * treating the list as a scalar. Every state must agree, otherwise a key that
 * is a list on one side and something else on the other is left to the scalar
 * rule rather than guessed at.
 */
export const collectionKeys = (...states) => {
  const keys = new Set();
  for (const state of states) for (const key of Object.keys(state ?? {})) keys.add(key);
  return [...keys].filter((key) => {
    const values = states.map((s) => s?.[key]).filter((v) => v !== undefined);
    if (!values.some(Array.isArray)) return false;
    return values.every((v) => (COLLECTIONS.includes(key) ? Array.isArray(v) : isRecordList(v)));
  });
};

/**
 * Mark what this change actually touched.
 *
 * Reducers in `domain/` are pure and build new objects by spreading, so a record
 * the change did not touch comes back REFERENCE-IDENTICAL. That makes the diff a
 * pointer comparison over each list — O(n), no deep equality, and exactly right
 * for this codebase rather than approximately right for any codebase.
 *
 * Over the same keys `mergeState` merges, so a list this build does not know
 * still gets its edits stamped and is not silently left out of sync.
 */
export const stampChanges = (before, after, now) => {
  const out = { ...after };
  for (const key of collectionKeys(after)) {
    const old = new Map((Array.isArray(before?.[key]) ? before[key] : []).map((r) => [r?.id, r]));
    let touched = false;
    const list = after[key].map((record) => {
      if (old.get(record.id) === record) return record;
      touched = true;
      return { ...record, updatedAt: now };
    });
    if (touched) out[key] = list;
  }
  return out;
};

/**
 * Which of two versions of ONE record survives.
 *
 * The later stamp wins. On an exact tie the one whose JSON is greater wins,
 * which is arbitrary but the SAME on every device. This used to be "mine wins",
 * and that is the one rule that cannot converge: each device keeps its own copy
 * of a record both stamped in the same millisecond, and they disagree for ever.
 * Identical copies (the usual tie, after any sync) are kept as they are.
 */
const winner = (mine, theirs) => {
  const a = stampOf(mine);
  const b = stampOf(theirs);
  if (a !== b) return b > a ? theirs : mine;
  if (mine === theirs) return mine;
  const x = JSON.stringify(mine);
  const y = JSON.stringify(theirs);
  return y > x ? theirs : mine;
};

/**
 * One list reconciled.
 *
 * Mine keeps its order and theirs' newcomers are appended in theirs, so the
 * result is stable: merging twice gives the same list, and a sync does not
 * reshuffle what the reader was looking at. Order is therefore the one thing
 * the two directions of a merge do not share; the SET of records and every
 * record's content are the same either way.
 *
 * Theirs is indexed once. Looking each record up by scanning was quadratic, and
 * a ledger of a few thousand sessions made every sync pay for it.
 */
export const mergeList = (mine = [], theirs = []) => {
  const theirById = new Map();
  for (const record of theirs) if (!theirById.has(record.id)) theirById.set(record.id, record);
  const ours = new Set(mine.map((r) => r.id));
  const out = mine.map((record) => {
    const other = theirById.get(record.id);
    return other ? winner(record, other) : record;
  });
  for (const record of theirs) if (!ours.has(record.id)) out.push(record);
  return out;
};

/**
 * Two ledgers into one.
 *
 * Every top-level list of records is merged, known or not. Everything else is a
 * scalar, and a scalar has no stamp to say which edit is later, so the rule is
 * deliberately plain: `lastBackupAt` takes the later of the two (a file was
 * exported at that moment whichever device did it, and choosing the earlier
 * would nag for a backup that already exists); any other scalar keeps mine and
 * only adopts theirs where mine has nothing. That cannot be undone by a sync
 * and cannot make this device overwrite its own answer, at the price that two
 * devices which disagree about an unknown scalar keep disagreeing. A value
 * that needs to converge belongs in a record.
 */
export const mergeState = (mine, theirs) => {
  if (!theirs) return mine;
  if (!mine) return theirs;
  const out = { ...mine };
  const lists = new Set(collectionKeys(mine, theirs));
  for (const key of lists) out[key] = mergeList(mine[key] ?? [], theirs[key] ?? []);
  for (const key of Object.keys(theirs)) {
    if (lists.has(key) || key === "lastBackupAt") continue;
    if (mine[key] === undefined) out[key] = theirs[key];
  }
  const backups = [mine.lastBackupAt, theirs.lastBackupAt].filter((n) => Number.isFinite(n));
  if (backups.length) out.lastBackupAt = Math.max(...backups);
  return out;
};

/**
 * Billed time counted twice.
 *
 * The app refuses to CREATE an overlap, so one can only arrive by merge: the
 * meter was running on two devices at once. It has to be reported rather than
 * absorbed, because nothing else about the ledger looks wrong — the hours simply
 * read high, and the money with them.
 *
 * Idle time is left out: sleeping while a machine elsewhere logged a nap is not
 * a double-counted invoice.
 */
export const overlaps = (sessions = [], now = Infinity) => {
  const spans = [];
  for (const session of sessions) {
    if (session.deletedAt || !isBilled(session)) continue;
    for (const segment of session.segments ?? []) {
      const end = segment.endedAt ?? now;
      if (end > segment.startedAt) spans.push({ id: session.id, from: segment.startedAt, to: end });
    }
  }
  spans.sort((a, b) => a.from - b.from);
  const found = [];
  for (let i = 1; i < spans.length; i += 1) {
    const previous = spans[i - 1];
    const current = spans[i];
    const ms = overlapMs({ startedAt: current.from, endedAt: current.to }, previous.from, previous.to, previous.to);
    if (ms > 0) found.push({ a: previous.id, b: current.id, ms, at: current.from });
  }
  return found;
};

