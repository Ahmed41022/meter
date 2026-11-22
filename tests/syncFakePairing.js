/**
 * An in-memory relay for the pairing endpoints only, in the shapes of DESIGN
 * section 7 (`pair/open`, `pair/pending`, `pair/request`, `pair/status`,
 * `pair/approve`, `DELETE pair`). The real relay core (step 3) replaces it, so
 * the request and response shapes here are the contract, not a convenience.
 *
 * It is deliberately a decent relay and a hostile one at once: `hooks` let a
 * test rewrite what the relay hands to either device, which is exactly what a
 * relay-in-the-middle would do.
 *
 * What it enforces, as the real one must:
 *  - open needs a registered device token; a slot lives 10 minutes and is bound
 *    to the SHA-256 of a join token it never sees in the clear until a joiner
 *    uses it;
 *  - one request per slot: a second device gets "conflict", the same device
 *    repeating itself (a retry after a lost response) is accepted;
 *  - approving registers the joiner's device and keeps the answer for an hour,
 *    so a joiner that was offline or crashed can still collect it;
 *  - everything that crosses is cloned, as on a wire.
 */
import { TransportError } from "../src/sync/engine.js";
import { tokenHash } from "../src/sync/crypto.js";

const copy = (x) => (x === undefined ? x : structuredClone(x));

export const OPEN_MS = 10 * 60_000;
export const COLLECT_MS = 60 * 60_000;

export function createFakePairingRelay({ now = Date.now, vaultId } = {}) {
  const relay = {
    slots: new Map(), devices: new Map(), calls: [], faults: [],
    /** Rewrites applied to what the relay delivers: `pending(req)`, `status(res)`,
     *  `request(req)` (what it stores). Each returns the replacement. */
    hooks: {},
    count(method) { return relay.calls.filter((c) => c === method).length; },
    /** `afterStore` throws once the relay has already done the work, as a lost response does. */
    failNext(method, error, { afterStore = false } = {}) { relay.faults.push([method, error, afterStore]); },
    registerDevice({ token, deviceId, privateJwk }) {
      return tokenHash(token).then((h) => {
        relay.devices.set(h, { id: deviceId, pubkey: { kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y } });
      });
    },
    deviceIds() { return [...relay.devices.values()].map((d) => d.id); },
  };

  const fault = (method, stored = false) => {
    const i = relay.faults.findIndex(([m, , after]) => m === method && after === stored);
    if (i < 0) return;
    throw relay.faults.splice(i, 1)[0][1];
  };
  const live = (slot) => {
    if (!slot) throw new TransportError("gone");
    if (now() >= slot.expiresAt) throw new TransportError("gone");
    return slot;
  };

  relay.approverTransport = (deviceToken) => {
    const who = async () => {
      const dev = relay.devices.get(await tokenHash(deviceToken));
      if (!dev) throw new TransportError("auth");
      return dev;
    };
    return {
      async open({ joinId, joinTokenHash, openProof }) {
        relay.calls.push("open");
        fault("open");
        const dev = await who();
        if (relay.slots.has(joinId)) throw new TransportError("conflict");
        const slot = {
          joinId, owner: dev.id, joinTokenHash, openProof, approverPub: dev.pubkey,
          expiresAt: now() + OPEN_MS, state: "pending", request: null, result: null,
        };
        relay.slots.set(joinId, slot);
        fault("open", true);
        return { expiresAt: slot.expiresAt };
      },

      async pending() {
        relay.calls.push("pending");
        fault("pending");
        const dev = await who();
        const slot = [...relay.slots.values()].reverse()
          .find((s) => s.owner === dev.id && s.state === "pending" && s.request && now() < s.expiresAt);
        if (!slot) return null;
        const req = { joinId: slot.joinId, ...copy(slot.request) };
        return copy(relay.hooks.pending ? relay.hooks.pending(req) : req);
      },

      async approve({ joinId, wrapped, ack, epoch }) {
        relay.calls.push("approve");
        fault("approve");
        const dev = await who();
        const slot = relay.slots.get(joinId);
        if (slot && slot.owner === dev.id && slot.state === "approved") {
          return { deviceId: slot.request.deviceId };
        }
        live(slot);
        if (slot.owner !== dev.id) throw new TransportError("auth");
        if (!slot.request || slot.state !== "pending") throw new TransportError("conflict");
        relay.devices.set(slot.request.tokenHash, { id: slot.request.deviceId, pubkey: copy(slot.request.pubkey) });
        slot.state = "approved";
        slot.result = copy({ wrapped, ack, epoch });
        slot.expiresAt = now() + COLLECT_MS;
        fault("approve", true);
        return { deviceId: slot.request.deviceId };
      },

      async deny({ joinId }) {
        relay.calls.push("deny");
        fault("deny");
        const dev = await who();
        const slot = live(relay.slots.get(joinId));
        if (slot.owner !== dev.id) throw new TransportError("auth");
        if (slot.state === "pending") slot.state = "denied";
        return {};
      },
    };
  };

  relay.joinerTransport = () => ({ vaultId: vid }) => {
    if (vid !== vaultId) throw new TransportError("gone");
    return {
      async request({ joinId, joinToken, deviceId, pubkey, tokenHash: th, proof }) {
        relay.calls.push("request");
        fault("request");
        const slot = live(relay.slots.get(joinId));
        if ((await tokenHash(joinToken)) !== slot.joinTokenHash) throw new TransportError("auth");
        const incoming = { deviceId, pubkey: copy(pubkey), tokenHash: th, proof };
        if (slot.request) {
          const same = slot.request.deviceId === deviceId && slot.request.tokenHash === th
            && slot.request.pubkey.x === pubkey.x && slot.request.pubkey.y === pubkey.y;
          if (!same) throw new TransportError("conflict");
          return {};
        }
        slot.request = relay.hooks.request ? relay.hooks.request(incoming) : incoming;
        fault("request", true);
        return {};
      },

      async status({ joinId, joinToken }) {
        relay.calls.push("status");
        fault("status");
        const slot = relay.slots.get(joinId);
        if (!slot) throw new TransportError("gone");
        if ((await tokenHash(joinToken)) !== slot.joinTokenHash) throw new TransportError("auth");
        let res;
        if (now() >= slot.expiresAt) res = { state: "expired" };
        else if (slot.state === "denied") res = { state: "denied" };
        else {
          res = { state: slot.state, approverPub: copy(slot.approverPub), openProof: slot.openProof };
          if (slot.state === "approved") Object.assign(res, copy(slot.result));
        }
        return copy(relay.hooks.status ? relay.hooks.status(res) : res);
      },
    };
  };

  return relay;
}
