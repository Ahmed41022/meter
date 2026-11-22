/**
 * An in-memory relay speaking the engine's transport interface.
 *
 * Not a stand-in for the real thing's internals, only for its CONTRACT as the
 * engine relies on it (see sync/engine.js): a log with server-assigned seqs, a
 * compare-and-swap on push, bids that make a repeated push a no-op, one
 * snapshot that prunes the log behind it, and `gone` for a reader who fell off
 * the end. Everything that crosses it is cloned, as it would be on a wire.
 *
 * Failures are injected rather than random so a test says exactly what broke.
 */
import { TransportError } from "../src/sync/engine.js";

const copy = (x) => structuredClone(x);

export function createFakeRelay({ tail = 2, page = 100 } = {}) {
  const relay = {
    log: [], head: 0, snapshot: null, bids: new Map(), calls: [],
    /** `[method, error, afterStore]`, consumed in order for that method. */
    faults: [],
    alwaysConflict: false,
    count(method) { return relay.calls.filter((c) => c === method).length; },
    failNext(method, error, { afterStore = false } = {}) { relay.faults.push([method, error, afterStore]); },
    transport(dev) {
      const fault = (method, stored = false) => {
        const i = relay.faults.findIndex(([m, , after]) => m === method && after === stored);
        if (i < 0) return;
        const [, error] = relay.faults.splice(i, 1)[0];
        throw error;
      };
      const entriesAfter = (seq) =>
        relay.log.filter((e) => e.seq > seq).slice(0, page).map(copy);
      return {
        async pull(since) {
          relay.calls.push("pull");
          fault("pull");
          const oldest = relay.log[0]?.seq ?? relay.head + 1;
          if (relay.snapshot && since + 1 < oldest) {
            throw new TransportError("gone", { snapshotUpto: relay.snapshot.upto });
          }
          return {
            head: relay.head,
            snapshotUpto: relay.snapshot ? relay.snapshot.upto : null,
            entries: entriesAfter(since),
          };
        },
        async push({ expect, bid, batch }) {
          relay.calls.push("push");
          fault("push");
          if (relay.bids.has(bid)) return { seq: relay.bids.get(bid) };
          if (relay.alwaysConflict || expect !== relay.head) {
            throw new TransportError("conflict", { head: relay.head, entries: entriesAfter(expect) });
          }
          relay.head += 1;
          relay.log.push({ seq: relay.head, dev, bid, batch: copy(batch) });
          relay.bids.set(bid, relay.head);
          fault("push", true);
          return { seq: relay.head };
        },
        async getSnapshot() {
          relay.calls.push("getSnapshot");
          fault("getSnapshot");
          return relay.snapshot ? copy(relay.snapshot) : null;
        },
        async putSnapshot({ expectUpto, upto, state }) {
          relay.calls.push("putSnapshot");
          fault("putSnapshot");
          if (expectUpto !== (relay.snapshot ? relay.snapshot.upto : null)) {
            throw new TransportError("conflict", {});
          }
          relay.snapshot = { upto, state: copy(state) };
          relay.log = relay.log.filter((e) => e.seq > upto - tail);
          return {};
        },
      };
    },
  };
  return relay;
}
