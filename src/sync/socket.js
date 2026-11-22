/**
 * The live connection to the relay (DESIGN 7.4). No React and no globals of its
 * own: the WebSocket constructor, the page's visibility, the timers and the
 * randomness are all injected, so every rule below is tested with a fake socket.
 *
 * What it is for, and what it is not. It makes updates arrive in a moment
 * instead of on the next poll, and carries presence. It is never the source of
 * truth: the ledger is correct after a `sync` whatever the socket did or did
 * not deliver, so every doubt resolves to "call sync".
 *
 * Rules:
 *
 *  - Open while the page is visible. Hidden for 60 s: close. Visible again:
 *    reconnect at once. A hidden phone must not hold a connection open.
 *  - On every (re)connect, `sync()` FIRST: whatever was missed while there was
 *    no socket is pulled before any pushed entry is trusted.
 *  - An `entry` is applied directly only when it is exactly cursor+1 and from
 *    another device; anything else (a gap, unreadable, not applicable) is a
 *    `sync()`. An entry this device pushed itself is ignored: the push already
 *    settled it.
 *  - Reconnects back off 1 s to 60 s with jitter. The counter is reset only by a
 *    connection that STAYED up, not by one that merely opened: a relay that
 *    accepts and immediately closes would otherwise be called once a second for
 *    ever. Every failure waits; nothing retries in a loop.
 *  - Close codes that mean "do not come back": 4401 (this device was removed),
 *    4410 (the vault was deleted), 4000 (another socket of this device replaced
 *    this one; reconnecting would start a tug of war between two tabs).
 *  - Presence is encrypted and handed to `onPresence` and nowhere else. It never
 *    reaches `sync`, `receive` or any storage from here.
 *
 * Everything that touches the ledger runs one at a time (`queue`), in the order
 * it arrived, so a burst of entries cannot interleave with the sync that is
 * still running. The app must run its OWN syncs through the same `run` (below)
 * or serialise them the same way: the engine's saved cursor has one writer at a
 * time.
 */
import { backoff } from "./engine.js";

export const PROTOCOL = "meter.v1";
/** Close codes the relay uses (relay/worker.js CLOSE). */
export const CLOSE = { replaced: 4000, revoked: 4401, deleted: 4410 };

export const DEFAULTS = {
  hiddenCloseMs: 60_000,
  reconnectBaseMs: 1_000,
  reconnectCapMs: 60_000,
  /** A connection that lasted this long counts as healthy: the backoff resets. */
  stableMs: 30_000,
  pingEveryMs: 30_000,
  /** No word of any kind this long after a ping: the connection is dead. */
  pongWithinMs: 10_000,
};

const OPEN = 1;

/**
 * @param url         `wss://host/v1/v/<id>/ws` (relay.js `socketUrl`)
 * @param token       the device token, sent as the second sub-protocol
 * @param WebSocketImpl  the constructor (`globalThis.WebSocket` in the app)
 * @param doc         `{ visibilityState, addEventListener, removeEventListener }`
 * @param device      this device's id, to recognise its own entries
 * @param sync        () -> the engine's sync result (`{ status }`); runs the
 *                    app's whole sync step, including merging into its state
 * @param receive     ({ seq, dev, bid, batch }) -> truthy when the entry was
 *                    applied, falsy when it was not the next one
 * @param getCursor   () -> the engine's saved cursor (number or null)
 * @param crypto      `{ openEntry, openPresence, sealPresence }` (relay.js createTransport)
 * @param onPresence  ({ dev, payload }) presence from another device
 * @param onEvent     (message) rotated, devices, pair_request and deleted messages
 * @param onState     (state, detail) "connecting", "connected", "waiting",
 *                    "hidden", "stopped" (detail.reason: removed, deleted,
 *                    replaced, auth, rekey, stopped)
 * @param onError     (error) something a handler threw; never fatal
 */
export function createSocket({
  url, token, WebSocketImpl, doc, device = null, sync, receive, getCursor, crypto,
  onPresence = () => {}, onEvent = () => {}, onState = () => {}, onError = () => {},
  now = () => Date.now(), random = Math.random, options = {},
}) {
  const O = { ...DEFAULTS, ...options };
  let ws = null;
  let state = "idle";
  let stopped = false;
  let started = false;
  let attempt = 0;
  let openedAt = 0;
  let reconnectTimer = null;
  let hiddenTimer = null;
  let pingTimer = null;
  let pongTimer = null;
  let queue = Promise.resolve();

  const setState = (next, detail = {}) => {
    state = next;
    try { onState(next, detail); } catch { /* a listener's bug is not the socket's */ }
  };

  /** Runs `task` after everything queued before it; a failure is reported, not thrown. */
  const run = (task) => {
    const next = queue.then(task);
    queue = next.catch((e) => { try { onError(e); } catch { /* ignore */ } });
    return next;
  };

  const visible = () => doc?.visibilityState !== "hidden";
  const clear = (id) => { if (id !== null) clearTimeout(id); return null; };

  const stop = (reason) => {
    stopped = true;
    reconnectTimer = clear(reconnectTimer);
    hiddenTimer = clear(hiddenTimer);
    pingTimer = clear(pingTimer);
    pongTimer = clear(pongTimer);
    doc?.removeEventListener?.("visibilitychange", onVisibility);
    closeSocket(1000, "stopped");
    setState("stopped", { reason });
  };

  /** Detaches before closing, so the close this causes is not mistaken for the
   *  relay's (and cannot schedule a reconnect). */
  const closeSocket = (code, reason) => {
    const old = ws;
    ws = null;
    pingTimer = clear(pingTimer);
    pongTimer = clear(pongTimer);
    if (old) { try { old.close(code, reason); } catch { /* already closed */ } }
  };

  // ---------------------------------------------------------------- connect
  function connect() {
    if (stopped || ws || !visible()) return;
    reconnectTimer = clear(reconnectTimer);
    setState("connecting");
    let socket;
    try {
      socket = new WebSocketImpl(url, [PROTOCOL, token]);
    } catch (e) {
      onError(e);
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.onopen = () => {
      if (ws !== socket) return;
      openedAt = now();
      setState("connected");
      schedulePing();
      // Before anything pushed to this socket is trusted: catch up first.
      run(async () => {
        const out = await sync();
        // This device can no longer use the relay: do not keep knocking.
        if (out?.status === "auth" || out?.status === "deleted" || out?.status === "rekey") {
          stop(out.status);
        }
      });
    };
    socket.onmessage = (event) => { if (ws === socket) onMessage(event.data); };
    socket.onerror = () => { /* a close always follows; it decides */ };
    socket.onclose = (event) => { if (ws === socket) onClose(event?.code ?? 1006); };
  }

  function onClose(code) {
    ws = null;
    pingTimer = clear(pingTimer);
    pongTimer = clear(pongTimer);
    if (code === CLOSE.revoked) return stop("removed");
    if (code === CLOSE.deleted) return stop("deleted");
    if (code === CLOSE.replaced) return stop("replaced");
    dropped();
  }

  /** The connection is gone and should come back, in time and only if wanted. */
  function dropped() {
    // A connection that held for a while was healthy, so the next failure starts
    // from the short wait again; one that dropped at once keeps climbing.
    attempt = openedAt && now() - openedAt >= O.stableMs ? 0 : attempt + 1;
    openedAt = 0;
    if (!visible() && hiddenTimer === null) { setState("hidden"); return; }
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;
    const wait = backoff(Math.max(0, attempt - 1), O.reconnectBaseMs, O.reconnectCapMs, random);
    setState("waiting", { retryInMs: wait });
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
  }

  // ------------------------------------------------------------ keep-alive
  function schedulePing() {
    pingTimer = clear(pingTimer);
    pingTimer = setTimeout(() => {
      pingTimer = null;
      if (!ws || ws.readyState !== OPEN) return;
      try { ws.send("ping"); } catch { return; }
      // Any word from the relay, "pong" or an entry, proves the line is alive.
      pongTimer = setTimeout(() => {
        pongTimer = null;
        // Detached first: this close is ours, and it must reconnect.
        closeSocket(1000, "no answer");
        dropped();
      }, O.pongWithinMs);
      schedulePing();
    }, O.pingEveryMs);
  }

  // -------------------------------------------------------------- messages
  function onMessage(data) {
    pongTimer = clear(pongTimer);
    if (typeof data !== "string" || data === "pong") return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== "object") return;
    switch (m.t) {
      case "entry":
        run(() => onEntry(m));
        break;
      case "presence":
        run(() => onPresenceMessage(m));
        break;
      case "rotated":
        // The key moved on: the next sync says "rekey" and the app handles it.
        try { onEvent(m); } catch (e) { onError(e); }
        run(() => sync());
        break;
      case "devices":
      case "pair_request":
      case "deleted":
        try { onEvent(m); } catch (e) { onError(e); }
        break;
      default:
    }
  }

  async function onEntry(m) {
    if (!Number.isInteger(m.seq) || m.dev === device) return;
    const cursor = await getCursor();
    if (cursor !== null && cursor !== undefined && m.seq <= cursor) return; // already have it
    if (cursor !== null && cursor !== undefined && m.seq === cursor + 1 && typeof m.bid === "string") {
      try {
        const batch = await crypto.openEntry(m);
        if (await receive({ seq: m.seq, dev: m.dev, bid: m.bid, batch })) return;
      } catch (e) {
        // Unreadable here or by the engine: the pull will say why.
        onError(e);
      }
    }
    await sync();
  }

  async function onPresenceMessage(m) {
    if (typeof m.dev !== "string" || m.dev === device) return;
    try {
      onPresence({ dev: m.dev, payload: await crypto.openPresence({ dev: m.dev, blob: m.blob }) });
    } catch { /* a presence that does not open is dropped, never shown */ }
  }

  // ------------------------------------------------------------ visibility
  function onVisibility() {
    if (stopped) return;
    if (visible()) {
      hiddenTimer = clear(hiddenTimer);
      if (!ws) {
        // Back after being closed on purpose: a fresh start, not a retry.
        attempt = 0;
        reconnectTimer = clear(reconnectTimer);
        connect();
      }
    } else if (hiddenTimer === null) {
      hiddenTimer = setTimeout(() => {
        hiddenTimer = null;
        reconnectTimer = clear(reconnectTimer);
        closeSocket(1000, "hidden");
        setState("hidden");
      }, O.hiddenCloseMs);
    }
  }

  return {
    /** Starts, and keeps itself right from then on. */
    start() {
      if (started || stopped) return;
      started = true;
      doc?.addEventListener?.("visibilitychange", onVisibility);
      if (visible()) connect(); else onVisibility();
    },
    stop: () => stop("stopped"),
    /** Seals `payload` as presence and sends it, if connected. Resolves false
     *  when there was no open socket. It is never queued or retried: presence
     *  that is a minute old is worse than none. */
    async sendPresence(payload) {
      const socket = ws;
      if (!socket || socket.readyState !== OPEN) return false;
      const blob = await crypto.sealPresence(payload);
      if (ws !== socket) return false;
      socket.send(JSON.stringify({ t: "presence", blob }));
      return true;
    },
    /** Runs the app's own work in the socket's queue, so it cannot interleave. */
    run,
    get state() { return state; },
    get connected() { return Boolean(ws) && ws.readyState === OPEN; },
  };
}
