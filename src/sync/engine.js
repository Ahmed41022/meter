/**
 * One round of syncing, independent of where the other end lives.
 *
 * The engine knows the SHAPE of the conversation and nothing about the wire: a
 * `transport` is handed to it, built from a base URL, a vault id and credentials
 * and nothing else, and it deals in plain batches. Encrypting them, putting them
 * in a request and finding the right vault are the transport's business. That
 * keeps this testable end to end against an in-memory fake, and means a relay
 * run by one person for one vault and a relay run for many are the same thing to
 * it.
 *
 * What a transport offers (all async; failures are `TransportError`s):
 *
 *   pull(since)          -> { head, snapshotUpto, entries:[{ seq, dev, bid, batch }] }
 *                           snapshotUpto is null when the relay holds no snapshot.
 *                           Throws "gone" when `since` is older than the log kept.
 *   push({expect,bid,batch}) -> { seq }
 *                           Throws "conflict" ({ head, entries }) unless `expect`
 *                           is the current head; a `bid` seen before returns the
 *                           seq it already has, whatever `expect` says.
 *   getSnapshot()        -> { upto, state } | null
 *   putSnapshot({expectUpto,upto,state})  throws "conflict" when it lost a race.
 *
 * The order below is the whole design: PULL, so everything this device has not
 * seen is merged in first; then PUSH what is still pending; then, now and then,
 * COMPACT. Writing first would be possible (merging does not care about order),
 * but a device that has not looked cannot warn about two meters running at once.
 *
 * Failure is made cheap rather than hidden. Local use never waits on this, so a
 * failed round only has to say what happened and when to try again, and it will
 * not try again sooner than that on its own: a transport that is down must
 * produce a few requests, not a storm.
 */
import {
  UnsupportedBatch, acknowledge, applyBatch, pending, reconcile, toBatches,
} from "./changes.js";

/** Every way the far end can fail that the engine acts on. `code` is one of
 *  conflict, gone, epoch, auth, quota, paused, network; `detail` carries what
 *  the code needs (the entries of a conflict, a quota's `resetAt`). */
export class TransportError extends Error {
  constructor(code, detail = {}) {
    super(detail.message ?? code);
    this.name = "TransportError";
    this.code = code;
    this.detail = detail;
  }
}

export const LIMITS = {
  /** Conflicts retried inside one round before it gives up as "busy". */
  MAX_CONFLICTS: 3,
  /** Pages of the log read in one round; a bound, not an expectation. */
  MAX_PAGES: 50,
  /** Snapshots adopted in one round. Two is "behind, then it moved"; more is a
   *  relay that cannot make up its mind. */
  MAX_SNAPSHOTS: 2,
  /** Log entries after the snapshot that make a new one worth uploading. */
  COMPACT_AFTER: 200,
  CONFLICT_BASE_MS: 250,
  CONFLICT_CAP_MS: 5_000,
  FAIL_BASE_MS: 1_000,
  FAIL_CAP_MS: 60_000,
  /** The longest a daily limit is ever waited out in one go. */
  QUOTA_CAP_MS: 30 * 60_000,
  BUSY_MS: 5_000,
};

const defaultBid = () => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits that grow and never exceed a cap, with jitter so two devices that
 *  failed together do not come back together. */
export const backoff = (attempt, base, cap, random = Math.random) =>
  Math.min(cap, base * 2 ** attempt) * (0.5 + random() * 0.5);

/** A log entry that does not follow the cursor: the part between was pruned. */
class Gap extends Error {}

/**
 * @param transport   see above
 * @param store       `{ load(), save(meta) }`, sync or async. Holds `{ cursor,
 *                    sent, inflight, snapshotUpto }` for this device and vault.
 *                    Losing it is safe (everything is pushed again, idempotently).
 * @param device      this device's id, only to tell news from its own echo
 */
export function createEngine({
  transport, store, device = null, now = () => Date.now(), random = Math.random,
  sleep = sleepFor, newBid = defaultBid, limits = {},
}) {
  const L = { ...LIMITS, ...limits };
  let failures = 0;
  let retryAt = 0;

  /**
   * Brings `local` and the relay to the same place.
   *
   * The returned `state` is the merged ledger and may be ahead of `local` even
   * when the round failed part way: whatever was taken in is kept. A caller that
   * edited meanwhile must merge it into its CURRENT state rather than replace
   * it (`mergeState(current, out.state)` is safe: the merge is idempotent), and
   * must write it without stamping, as a pulled state always has been.
   *
   * `status` is "ok" or why not: "backoff" (too soon, nothing was asked),
   * "network", "paused" (the relay is down or over its daily limit), "quota"
   * (this vault's allowance), "auth" (this device was removed), "rekey" (the
   * vault's key moved on), "needs-update" (written by a newer Meter), "busy"
   * (kept losing races). `retryAt` says when trying again is reasonable;
   * Infinity means "not until something changes".
   */
  async function sync(local, { force = false } = {}) {
    const at = now();
    if (!force && at < retryAt) {
      return result({ status: "backoff", state: local, retryAt });
    }

    const saved = (await store.load()) ?? {};
    const meta = {
      cursor: saved.cursor ?? null,
      sent: saved.sent ?? {},
      inflight: saved.inflight ?? null,
      snapshotUpto: saved.snapshotUpto ?? null,
    };
    let state = local;
    const out = {
      state, changed: false, pushed: 0, pulled: 0, adopted: false, uploaded: false,
      raced: false, head: null,
    };
    const save = async () => { await store.save(meta); };
    const ahead = () => (meta.cursor ?? 0);

    const takeEntries = async (entries) => {
      // Saved even when an entry stops the loop: what was taken in BEFORE a
      // batch this build cannot read must not be forgotten, or the cursor would
      // sit behind work that is already in the ledger.
      try {
        for (const entry of entries) {
          if (entry.seq <= ahead()) continue;
          if (entry.seq !== ahead() + 1) throw new Gap();
          const applied = applyBatch(state, entry.batch, meta.sent);
          state = applied.state;
          meta.sent = applied.sent;
          if (applied.changed) out.changed = true;
          meta.cursor = entry.seq;
          if (entry.dev !== device) out.pulled += 1;
        }
      } finally {
        await save();
      }
    };

    let snapshots = 0;
    const adoptSnapshot = async () => {
      snapshots += 1;
      if (snapshots > L.MAX_SNAPSHOTS) {
        throw new TransportError("paused", { message: "The relay keeps asking for a snapshot." });
      }
      const snap = await transport.getSnapshot();
      if (!snap) throw new TransportError("paused", { message: "The relay has no snapshot to give." });
      const joined = reconcile(state, snap.state);
      if (JSON.stringify(joined.state) !== JSON.stringify(state)) out.changed = true;
      state = joined.state;
      meta.sent = joined.sent;
      meta.cursor = snap.upto;
      meta.snapshotUpto = snap.upto;
      out.adopted = true;
      await save();
    };

    const catchUp = async () => {
      for (let page = 0; page < L.MAX_PAGES; page += 1) {
        let res;
        try {
          res = await transport.pull(ahead());
        } catch (e) {
          if (e instanceof TransportError && e.code === "gone") {
            await adoptSnapshot();
            continue;
          }
          throw e;
        }
        out.head = res.head;
        meta.snapshotUpto = res.snapshotUpto;
        if (meta.cursor === null && res.snapshotUpto !== null) {
          // Never joined, and the relay has a snapshot: that, not the log from
          // the start, is where a newcomer begins.
          await adoptSnapshot();
          continue;
        }
        if (ahead() > res.head) {
          // The relay holds LESS than we have already seen: it was wiped or
          // restored. Start again from nothing; everything is pending, and
          // pushing it is idempotent.
          meta.cursor = null;
          meta.sent = {};
          await save();
          continue;
        }
        try {
          await takeEntries(res.entries);
        } catch (e) {
          if (e instanceof Gap) {
            await adoptSnapshot();
            continue;
          }
          throw e;
        }
        if (meta.cursor === null) meta.cursor = 0;
        if (ahead() >= res.head || !res.entries.length) {
          await save();
          return;
        }
      }
    };

    const settle = async (batch, seq) => {
      meta.sent = acknowledge(meta.sent, batch);
      meta.inflight = null;
      out.pushed += batch.changes.length;
      if (seq === ahead() + 1) meta.cursor = seq;
      out.head = Math.max(out.head ?? 0, seq);
      await save();
    };

    /** A batch whose answer was lost goes again with the SAME bid, so the relay
     *  can say it already has it instead of storing it twice. */
    const resume = async () => {
      if (!meta.inflight) return;
      const { bid, batch } = meta.inflight;
      try {
        const sent = await transport.push({ expect: ahead(), bid, batch });
        await settle(batch, sent.seq);
      } catch (e) {
        if (e instanceof TransportError && e.code === "conflict") {
          // It was never stored. Its records are still pending, so the next
          // batch is built from the ledger as it stands, not from this one.
          meta.inflight = null;
          await save();
          return;
        }
        throw e;
      }
    };

    const firstSnapshot = async (all) => {
      try {
        await transport.putSnapshot({ expectUpto: null, upto: 0, state });
      } catch (e) {
        if (e instanceof TransportError && e.code === "conflict") return false;
        throw e;
      }
      for (const batch of all) meta.sent = acknowledge(meta.sent, batch);
      out.pushed += all.reduce((n, b) => n + b.changes.length, 0);
      out.uploaded = true;
      meta.snapshotUpto = 0;
      meta.cursor = 0;
      out.head = 0;
      await save();
      return true;
    };

    /** Compaction forced by a full log. Only when this device has seen all of
     *  it (otherwise the snapshot would claim to cover entries it never read),
     *  and unlike `compact` it does not wait for the batches it is about to push:
     *  a snapshot holding records the log does not yet have is harmless, because
     *  merging is order-independent and these are still pushed afterwards. */
    let relieved = false;
    const relieve = async () => {
      await catchUp();
      if (meta.cursor === null || out.head === null || meta.cursor !== out.head) return false;
      try {
        await transport.putSnapshot({ expectUpto: meta.snapshotUpto, upto: meta.cursor, state });
        meta.snapshotUpto = meta.cursor;
        await save();
      } catch (e) {
        // Someone else compacted first, which makes the same room.
        if (!(e instanceof TransportError) || e.code !== "conflict") throw e;
        await catchUp();
      }
      return true;
    };

    const push = async () => {
      let conflicts = 0;
      for (;;) {
        const batches = toBatches(pending(state, meta.sent));
        if (!batches.length) return "ok";
        // A relay with nothing on it takes the ledger as ONE snapshot. As
        // batches it would be dozens of requests to say what one can.
        if (out.head === 0 && meta.snapshotUpto === null) {
          if (await firstSnapshot(batches)) return "ok";
          conflicts += 1;
          if (conflicts > L.MAX_CONFLICTS) return "busy";
          out.raced = true;
          await catchUp();
          continue;
        }
        let lost = false;
        for (const batch of batches) {
          const bid = newBid();
          meta.inflight = { bid, batch };
          await save();
          try {
            try {
              const sent = await transport.push({ expect: ahead(), bid, batch });
              await settle(batch, sent.seq);
            } catch (e) {
              // The relay's hard cap on log rows. Compaction normally runs AFTER
              // a push, so a vault that reached the cap could never push again
              // and never compact: it would be stuck for good. So, once, make
              // room first and go again.
              if (!(e instanceof TransportError) || e.code !== "quota" || e.detail?.what !== "log_rows" || relieved) throw e;
              relieved = true;
              if (!(await relieve())) throw e;
              const sent = await transport.push({ expect: ahead(), bid, batch });
              await settle(batch, sent.seq);
            }
          } catch (e) {
            if (!(e instanceof TransportError) || e.code !== "conflict") throw e;
            // Somebody else wrote first. Take what they wrote, then rebuild:
            // some of ours may have lost to theirs and no longer be pending.
            out.raced = true;
            meta.inflight = null;
            conflicts += 1;
            if (conflicts > L.MAX_CONFLICTS) return "busy";
            try {
              await takeEntries(e.detail?.entries ?? []);
            } catch (gap) {
              if (!(gap instanceof Gap)) throw gap;
            }
            await sleep(backoff(conflicts - 1, L.CONFLICT_BASE_MS, L.CONFLICT_CAP_MS, random));
            await catchUp();
            lost = true;
            break;
          }
        }
        if (!lost) return "ok";
      }
    };

    /** Folds the log into a snapshot once it has grown, so a new or long-absent
     *  device does not have to replay it. Never while anything is unsent: the
     *  snapshot must say exactly what the log up to `upto` says. */
    const compact = async () => {
      if (meta.cursor === null || out.head === null || meta.cursor !== out.head) return;
      if (meta.cursor - (meta.snapshotUpto ?? 0) < L.COMPACT_AFTER) return;
      if (pending(state, meta.sent).changes.length) return;
      try {
        await transport.putSnapshot({ expectUpto: meta.snapshotUpto, upto: meta.cursor, state });
        meta.snapshotUpto = meta.cursor;
        await save();
      } catch (e) {
        // Another device compacted first, which is the same result.
        if (!(e instanceof TransportError) || e.code !== "conflict") throw e;
      }
    };

    try {
      await resume();
      await catchUp();
      const outcome = await push();
      if (outcome === "busy") {
        retryAt = now() + L.BUSY_MS;
        return result({ ...out, state, status: "busy", retryAt, cursor: meta.cursor });
      }
      await compact();
      failures = 0;
      retryAt = 0;
      return result({ ...out, state, status: "ok", cursor: meta.cursor });
    } catch (e) {
      const status = classify(e);
      if (!status) throw e;
      return result({ ...out, state, status: status.status, retryAt: status.retryAt, cursor: meta.cursor, message: e.message });
    }
  }

  /** Maps a failure to what the caller should do, and remembers when not to try
   *  again. Anything that is not a transport failure is a bug and is rethrown. */
  function classify(e) {
    const at = now();
    if (e instanceof UnsupportedBatch) {
      retryAt = Infinity;
      return { status: "needs-update", retryAt };
    }
    if (!(e instanceof TransportError)) return null;
    switch (e.code) {
      case "auth":
      case "epoch":
        retryAt = Infinity;
        return { status: e.code === "epoch" ? "rekey" : "auth", retryAt };
      case "quota": {
        const wait = Number.isFinite(e.detail?.resetAt) ? e.detail.resetAt - at : L.QUOTA_CAP_MS;
        retryAt = at + Math.min(Math.max(wait, L.FAIL_BASE_MS), L.QUOTA_CAP_MS);
        return { status: "quota", retryAt };
      }
      case "network":
      case "paused":
        failures += 1;
        retryAt = at + backoff(failures - 1, L.FAIL_BASE_MS, L.FAIL_CAP_MS, random);
        return { status: e.code, retryAt };
      default:
        failures += 1;
        retryAt = at + backoff(failures - 1, L.FAIL_BASE_MS, L.FAIL_CAP_MS, random);
        return { status: "network", retryAt };
    }
  }

  const result = (fields) => ({
    status: "ok", changed: false, pushed: 0, pulled: 0, adopted: false, uploaded: false,
    raced: false, head: null, cursor: null, retryAt: 0, ...fields,
  });

  return { sync, get retryAt() { return retryAt; } };
}
