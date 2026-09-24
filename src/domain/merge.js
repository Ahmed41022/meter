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

/** The lists that hold records with ids. Anything else on the state is a scalar
 *  and handled separately. */
export const COLLECTIONS = ["projects", "sessions", "objectives", "earnings"];

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
export const stampChanges = (before, after, now) => {
  const out = { ...after };
  for (const key of COLLECTIONS) {
    const next = after?.[key];
    if (!Array.isArray(next)) continue;
    const old = new Map((before?.[key] ?? []).map((r) => [r.id, r]));
    let touched = false;
    const list = next.map((record) => {
      if (old.get(record.id) === record) return record;
      touched = true;
      return { ...record, updatedAt: now };
    });
    if (touched) out[key] = list;
  }
  return out;
};

/**
 * One list reconciled.
 *
 * Mine keeps its order and theirs' newcomers are appended in theirs, so the
 * result is stable: merging twice gives the same list, and a sync does not
 * reshuffle what the reader was looking at.
 *
 * A tie goes to mine. Two devices stamping the same millisecond is vanishingly
 * unlikely, but "whichever arrived second" would make the merge depend on
 * network timing, and a merge that is not deterministic cannot be reasoned about.
 */
export const mergeList = (mine = [], theirs = []) => {
  const ours = new Map(mine.map((r) => [r.id, r]));
  const out = mine.map((record) => {
    const other = theirs.find((r) => r.id === record.id);
    if (!other) return record;
    return stampOf(other) > stampOf(record) ? other : record;
  });
  for (const record of theirs) if (!ours.has(record.id)) out.push(record);
  return out;
};

/**
 * Two ledgers into one.
 *
 * `lastBackupAt` takes the later of the two: a file was exported at that moment
 * whichever device did it, and choosing the earlier would nag for a backup that
 * already exists.
 */
export const mergeState = (mine, theirs) => {
  if (!theirs) return mine;
  if (!mine) return theirs;
  const out = { ...mine };
  for (const key of COLLECTIONS) {
    const a = mine[key];
    const b = theirs[key];
    if (!Array.isArray(a) && !Array.isArray(b)) continue;
    out[key] = mergeList(a ?? [], b ?? []);
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

