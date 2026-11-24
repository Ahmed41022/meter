import { useCallback, useEffect, useRef, useState } from "react";
import { mergeState } from "../../domain/merge.js";
import { TransportError, createEngine } from "../../sync/engine.js";
import { createTransport, listDevices, socketUrl } from "../../sync/relay.js";
import { createSocket } from "../../sync/socket.js";
import { cryptoAvailable } from "../../sync/crypto.js";
import { leaveVault } from "../../sync/relayActions.js";
import { relayFetch } from "../../sync/relayConfig.js";
import { loadVault, progressStore } from "../../sync/vaultStore.js";
import { BUILT_AT, stampOf } from "./autoUpdate.js";

/**
 * Meter Sync, wired into the app: the engine, the live socket and the triggers
 * that decide when to run a round. It runs INSTEAD of Google Drive on a device
 * that holds a vault, and does nothing at all on one that does not.
 *
 * The rules that matter, from the engine's and the socket's own headers:
 *
 *  - ONE queue. Every engine call (a round, a socket entry) runs through
 *    `socket.run`, so the saved cursor has a single writer at a time. A device
 *    without WebSocket gets a queue of the same shape.
 *  - A round's result is MERGED into the current ledger and written with
 *    `write`, never `commit`: it is news from elsewhere, not an edit made here,
 *    and stamping it would re-date every record that just arrived and send them
 *    all straight back.
 *  - Only a round that changed something writes, so an idle sync does not save
 *    the ledger again.
 *  - Presence (which device is running a meter, and when it was last heard from)
 *    lives in a ref and a counter that re-renders. It is never merged and never
 *    saved: the ledger and the JSON export cannot contain it.
 */

/** A burst of edits is one round, but short enough that a stop on the phone
 *  reaches the laptop in a moment (DESIGN 4c; Drive used 8 s). */
export const PUSH_DELAY_MS = 1_500;
/** The slow poll, only while a meter runs and the socket is not up: without it a
 *  stop made elsewhere would sit unseen on a machine still counting. */
export const FALLBACK_POLL_MS = 120_000;
/** How often the device holding a meter says so (DESIGN 1.3), as useHeartbeat. */
export const PRESENCE_MS = 60_000;

const CLOSED_FOR_GOOD = new Set(["auth", "deleted", "rekey", "needs-update"]);
/** States where waiting and trying again is the right response. */
const RETRIES = new Set(["busy", "backoff", "network", "paused", "quota"]);

/** As the Settings list has it: two missed minutes means gone, not slow. */
const PRESENCE_FRESH_MS = 150_000;

/** A device can hold several meters. A build from before that reads `sessionId`
 *  alone, so the main one goes there and all of them in `sessionIds`. */
const presenceOf = (device, held) => ({ dev: device, sessionId: held[0], sessionIds: held, tick: Date.now() });
const heldIn = (p) => (Array.isArray(p.sessionIds)
  ? p.sessionIds.filter((id) => typeof id === "string") : [p.sessionId]);

const validPresence = (p) => p && typeof p === "object" && typeof p.sessionId === "string" && Number.isFinite(p.tick);

export function useRelaySync({ ready, stateRef, write, anyRunning, heldSessions = [], device, onMerged }) {
  const [vault, setVault] = useState(() => loadVault());
  const active = Boolean(vault?.vaultId);
  const [status, setStatus] = useState({ state: "idle", at: null });
  const [socketState, setSocketState] = useState("off");
  const [, setPresenceVersion] = useState(0);
  /** The newest build another device was heard running, for useAutoUpdate. */
  const [newerBuild, setNewerBuild] = useState(null);
  /** Device names by sync id, opened with the vault key, for naming the
   *  device a meter is running on. Fetched when the engine starts, and again
   *  when a device nobody has named yet is heard from. */
  const [deviceNames, setDeviceNames] = useState({});
  const namesAsked = useRef(0);
  const heardBuild = useCallback((stamp) => {
    const b = stampOf(stamp);
    if (b !== null) setNewerBuild((was) => (was !== null && was >= b ? was : b));
  }, []);

  const presenceRef = useRef({});
  /** What this device holds, for answering a hello from inside the engine. */
  const heldRef = useRef(heldSessions);
  heldRef.current = heldSessions;
  const heldKey = heldSessions.join("|");
  const deviceRef = useRef(device);
  deviceRef.current = device;
  /** What the running effect offers the rest of the hook: `{ sync, sendPresence, kill }`. */
  const live = useRef(null);
  const pushTimer = useRef(null);
  const retryTimer = useRef(null);
  const listeners = useRef(new Set());
  const mergedRef = useRef(onMerged);
  mergedRef.current = onMerged;

  // ------------------------------------------------------------------ engine
  useEffect(() => {
    live.current = null;
    presenceRef.current = {};
    setSocketState("off");
    if (!ready || !active) {
      setStatus({ state: "idle", at: null });
      return undefined;
    }
    if (!cryptoAvailable()) {
      setStatus({ state: "unsupported", at: null, message: "Sync needs a secure page (https) and a current browser, and this one has no encryption available." });
      return undefined;
    }

    let dead = false;
    let socket = null;
    let last = { state: "idle", at: null };
    const progress = progressStore(globalThis);
    // A round still in flight when the vault is left must not write its progress
    // back after the vault was cleared: the next vault would inherit a cursor.
    const store = { load: () => progress.load(), save: (m) => (dead ? false : progress.save(m)) };

    const publish = (next) => {
      last = next;
      if (!dead) setStatus(next);
    };

    const boot = async () => {
      let transport;
      try {
        transport = await createTransport({ fetch: relayFetch, vault });
      } catch (e) {
        publish({ state: "unsupported", at: null, message: e?.message });
        return;
      }
      if (dead) return;

      // The engine's result says THAT it was over a limit, not by how much; the
      // detail (what, and when it resets) is on the error it caught, so it is
      // remembered on the way past.
      let failure = null;
      const watch = (fn) => async (...args) => {
        try { return await fn(...args); } catch (e) {
          if (e instanceof TransportError) failure = e;
          throw e;
        }
      };
      const watched = {
        ...transport,
        pull: watch(transport.pull),
        push: watch(transport.push),
        getSnapshot: watch(transport.getSnapshot),
        putSnapshot: watch(transport.putSnapshot),
      };
      const engine = createEngine({
        transport: watched, store, device: vault.deviceId, build: stampOf(BUILT_AT),
      });

      const take = (out) => {
        const next = mergeState(stateRef.current, out.state);
        write(next);
        mergedRef.current?.(next);
      };

      const retryLater = (at) => {
        clearTimeout(retryTimer.current);
        if (!Number.isFinite(at)) return;
        retryTimer.current = setTimeout(() => live.current?.sync(), Math.max(1_000, at - Date.now()));
      };

      /** One round. Never throws: a failure is a status. */
      const round = async ({ force = false } = {}) => {
        if (dead) return { status: "stopped" };
        clearTimeout(retryTimer.current);
        failure = null;
        setStatus({ ...last, state: "syncing" });
        let out;
        try {
          out = await engine.sync(stateRef.current, { force });
        } catch (e) {
          publish({ state: "error", at: Date.now(), message: e?.message ?? "Sync failed." });
          return { status: "error" };
        }
        if (dead) return out;
        heardBuild(out.newestBuild);
        // Merged into what is on screen NOW: the person may have edited while
        // the round was out.
        if (out.changed) {
          const next = mergeState(stateRef.current, out.state);
          write(next);
          if (out.pulled || out.adopted) mergedRef.current?.(next);
        }
        if (out.status === "backoff") {
          // Nothing was asked of the relay. Keep saying what it said last.
          publish(last.state === "idle" ? { state: "network", at: Date.now(), retryAt: out.retryAt } : last);
          retryLater(out.retryAt);
        } else if (out.status === "ok") {
          publish({ state: "ok", at: Date.now(), pushed: out.pushed, pulled: out.pulled, raced: out.raced });
        } else {
          publish({
            state: out.status, at: Date.now(), retryAt: out.retryAt, message: out.message,
            detail: failure?.detail,
          });
          if (RETRIES.has(out.status)) retryLater(out.retryAt);
        }
        if (CLOSED_FOR_GOOD.has(out.status)) socket?.stop();
        return out;
      };

      const receive = async (entry) => {
        const out = await engine.receive(stateRef.current, entry);
        if (!out) return false;
        if (entry.dev !== vault.deviceId) heardBuild(out.build);
        if (out.changed) take(out);
        return true;
      };

      const learnNames = () => {
        if (Date.now() - namesAsked.current < 60_000) return;
        namesAsked.current = Date.now();
        listDevices({ fetch: relayFetch, vault })
          .then((list) => {
            if (!dead) setDeviceNames(Object.fromEntries(list.filter((d) => d.name).map((d) => [d.id, d.name])));
          })
          .catch(() => { namesAsked.current = 0; });
      };

      const onPresence = ({ dev, payload }) => {
        if (dead) return;
        if (!(dev in namesRef.current)) learnNames();
        // The hello a device sends when its connection opens says only which
        // build it runs. A build from before it drops it as not a presence.
        if (dev !== vault.deviceId && payload && typeof payload === "object") heardBuild(payload.build);
        if (!validPresence(payload)) {
          // A hello: that device has just connected (opened, reloaded, updated)
          // and knows of no meter until it hears of one. Holding one, say so
          // now rather than on the next minute, which left it saying "on
          // another device" for up to a minute after every reload.
          if (dev !== vault.deviceId && heldRef.current.length) {
            live.current?.sendPresence(presenceOf(deviceRef.current, heldRef.current));
          }
          return;
        }
        presenceRef.current = { ...presenceRef.current, [dev]: { sessionIds: heldIn(payload), tick: payload.tick, at: Date.now() } };
        setPresenceVersion((v) => v + 1);
      };

      const onEvent = (m) => {
        if (dead) return;
        if (m.t === "deleted") publish({ state: "deleted", at: Date.now() });
        for (const fn of listeners.current) { try { fn(m); } catch { /* a screen's bug is not the socket's */ } }
      };

      const onState = (s, detail = {}) => {
        if (dead) return;
        setSocketState(s);
        if (s !== "stopped") return;
        if (detail.reason === "removed" || detail.reason === "auth") publish({ state: "auth", at: Date.now() });
        else if (detail.reason === "deleted") publish({ state: "deleted", at: Date.now() });
        else if (detail.reason === "rekey") publish({ state: "rekey", at: Date.now() });
      };

      // A device that cannot open a socket (no WebSocket, a relay that says 426)
      // still syncs: on open, when shown, after edits, and on the slow poll.
      const WS = globalThis.WebSocket;
      socket = typeof WS === "function" ? createSocket({
        url: socketUrl(vault), token: vault.token, WebSocketImpl: WS, doc: globalThis.document,
        device: vault.deviceId, sync: () => round(), receive, getCursor: () => progress.load().cursor,
        crypto: transport, onPresence, onEvent, onState, onError: () => {},
      }) : null;

      let tail = Promise.resolve();
      const run = socket ? socket.run : (task) => {
        const next = tail.then(task);
        tail = next.catch(() => {});
        return next;
      };

      live.current = {
        sync: (options) => run(() => round(options)).catch(() => ({ status: "error" })),
        sendPresence: (payload) => (socket ? socket.sendPresence(payload).catch(() => false) : Promise.resolve(false)),
        kill: () => { dead = true; clearTimeout(retryTimer.current); socket?.stop(); },
      };
      socket?.start();
      live.current.sync();
      learnNames();
    };
    boot();

    return () => {
      dead = true;
      clearTimeout(pushTimer.current);
      clearTimeout(retryTimer.current);
      socket?.stop();
      live.current = null;
    };
  }, [ready, vault]); // eslint-disable-line react-hooks/exhaustive-deps -- stateRef is a ref and write is stable; a new vault object is the only thing that restarts this

  // ---------------------------------------------------------------- triggers
  /** Back on screen: on a phone this is how it learns what happened while it was
   *  away. The socket reconnects itself; this covers one that cannot. */
  useEffect(() => {
    if (!active) return undefined;
    const onShow = () => { if (!document.hidden) live.current?.sync(); };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [active]);

  useEffect(() => {
    if (!active || !anyRunning || socketState === "connected") return undefined;
    const id = setInterval(() => live.current?.sync(), FALLBACK_POLL_MS);
    return () => clearInterval(id);
  }, [active, anyRunning, socketState]);

  /** Which build this device runs, said once each time the connection opens,
   *  so a device that is behind hears of it without waiting for an edit. */
  useEffect(() => {
    if (!active || socketState !== "connected" || !stampOf(BUILT_AT)) return;
    live.current?.sendPresence({ dev: device, build: BUILT_AT });
  }, [active, socketState, device]);

  /** The device holding a meter says so once a minute. Sent, not stored: see the
   *  header. Sent at once when the socket comes up, so a receiver need not wait. */
  useEffect(() => {
    if (!active || !heldKey || socketState !== "connected") return undefined;
    const send = () => live.current?.sendPresence(presenceOf(device, heldRef.current));
    send();
    const id = setInterval(send, PRESENCE_MS);
    return () => clearInterval(id);
  }, [active, heldKey, socketState, device]);

  const namesRef = useRef(deviceNames);
  namesRef.current = deviceNames;

  /**
   * The name of the device running the session `sessionId`, from the presence
   * it sends while it runs: null when none has been heard from lately, or it
   * has no name.
   */
  const runningOn = useCallback((sessionId, now = Date.now()) => {
    for (const [dev, p] of Object.entries(presenceRef.current)) {
      if (p.sessionIds.includes(sessionId) && now - p.at < PRESENCE_FRESH_MS) return namesRef.current[dev] ?? null;
    }
    return null;
  }, []);

  // ----------------------------------------------------------------- outputs
  /** Called after an edit made here. Debounced. */
  const schedulePush = useCallback(() => {
    clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => live.current?.sync(), PUSH_DELAY_MS);
  }, []);

  /** The button: a round now, even if the engine was backing off. */
  const syncNow = useCallback(() => live.current?.sync({ force: true }), []);

  /** The vault on this device changed in storage (created, joined): pick it up. */
  const reload = useCallback(() => setVault(loadVault()), []);

  /** Forgets the vault here. The engine is stopped FIRST so nothing it still has
   *  in flight can write progress after the vault is gone. The ledger stays. */
  const leave = useCallback(() => {
    live.current?.kill();
    clearTimeout(pushTimer.current);
    leaveVault();
    setVault(null);
  }, []);

  /** For screens that need the socket's messages (pair_request, devices). */
  const subscribe = useCallback((fn) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  return {
    vault, active, status, socketState, presence: presenceRef.current, newerBuild, runningOn,
    syncNow, schedulePush, reload, leave, subscribe,
  };
}
