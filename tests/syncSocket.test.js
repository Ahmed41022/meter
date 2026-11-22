/**
 * The socket client (src/sync/socket.js) with a fake WebSocket, a fake page and
 * fake timers: every rule in DESIGN 7.4 is a statement about time and about
 * what is called when, so time is the one thing a test has to own.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { CLOSE, createSocket } from "../src/sync/socket.js";

class FakeWebSocket {
  static all = [];
  static answers = true;
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    this.closes = [];
    FakeWebSocket.all.push(this);
  }
  send(text) {
    this.sent.push(text);
    // A healthy relay answers a ping; the dead-line tests turn that off.
    if (text === "ping" && FakeWebSocket.answers) setTimeout(() => { if (this.readyState === 1) this.message("pong"); }, 10);
  }
  close(code, reason) { this.closes.push([code, reason]); this.readyState = 3; }
  // What the network does.
  open() { this.readyState = 1; this.onopen?.(); }
  message(m) { this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) }); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}

const fakeDoc = () => {
  const d = {
    visibilityState: "visible", listeners: new Set(),
    addEventListener: (type, fn) => { if (type === "visibilitychange") d.listeners.add(fn); },
    removeEventListener: (type, fn) => { d.listeners.delete(fn); },
    set(state) { d.visibilityState = state; for (const fn of [...d.listeners]) fn(); },
  };
  return d;
};

const URL_ = "wss://relay.example.workers.dev/v1/v/ID/ws";
const TOKEN = "t".repeat(43);

function rig(over = {}) {
  const doc = fakeDoc();
  const log = [];
  const calls = {
    sync: vi.fn(async () => { log.push("sync"); return { status: "ok" }; }),
    receive: vi.fn(async ({ seq }) => { log.push(`receive ${seq}`); return { cursor: seq }; }),
    openEntry: vi.fn(async ({ blob }) => blob),
    openPresence: vi.fn(async ({ blob }) => blob),
    sealPresence: vi.fn(async (payload) => ({ sealed: payload })),
    onPresence: vi.fn(), onEvent: vi.fn(), onState: vi.fn(), onError: vi.fn(),
  };
  let cursor = 4;
  const socket = createSocket({
    url: URL_, token: TOKEN, WebSocketImpl: FakeWebSocket, doc, device: "ME", random: () => 1,
    sync: calls.sync, receive: calls.receive, getCursor: async () => cursor,
    crypto: { openEntry: calls.openEntry, openPresence: calls.openPresence, sealPresence: calls.sealPresence },
    onPresence: calls.onPresence, onEvent: calls.onEvent, onState: calls.onState, onError: calls.onError,
    ...over,
  });
  return { socket, doc, calls, log, setCursor: (n) => { cursor = n; } };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const live = () => FakeWebSocket.all.filter((s) => s.readyState !== 3);
const last = () => FakeWebSocket.all[FakeWebSocket.all.length - 1];

beforeEach(() => { vi.useFakeTimers(); FakeWebSocket.all = []; FakeWebSocket.answers = true; });
afterEach(() => { vi.useRealTimers(); });

describe("connecting", () => {
  it("offers the protocol and the token as sub-protocols, not in the address", async () => {
    const { socket } = rig();
    socket.start();
    expect(FakeWebSocket.all).toHaveLength(1);
    expect(last().url).toBe(URL_);
    expect(last().protocols).toEqual(["meter.v1", TOKEN]);
    expect(last().url).not.toContain(TOKEN);
  });

  it("syncs first on every connect, before it trusts anything pushed to it", async () => {
    const { socket, calls, log, setCursor } = rig();
    let release;
    calls.sync.mockImplementationOnce(() => new Promise((r) => { release = () => { log.push("sync"); r({ status: "ok" }); }; }));
    socket.start();
    last().open();
    last().message({ t: "entry", seq: 5, dev: "OTHER", bid: "bid-00000001", blob: "b" });
    await tick();
    // The entry waits behind the sync that is still running.
    expect(calls.receive).not.toHaveBeenCalled();
    setCursor(4);
    release();
    await tick();
    expect(log).toEqual(["sync", "receive 5"]);
  });

  it("syncs again after a reconnect", async () => {
    const { socket, calls } = rig();
    socket.start();
    last().open();
    await tick();
    expect(calls.sync).toHaveBeenCalledTimes(1);
    last().drop();
    await tick(1_000);
    last().open();
    await tick();
    expect(calls.sync).toHaveBeenCalledTimes(2);
  });
});

describe("entries", () => {
  const entry = (seq, extra = {}) => ({ t: "entry", seq, dev: "OTHER", bid: `bid-${seq}-padding`, blob: `blob${seq}`, ...extra });
  const connected = async (over) => {
    const r = rig(over);
    r.socket.start();
    last().open();
    await tick();
    r.calls.sync.mockClear();
    return r;
  };

  it("applies exactly the next one directly, with no sync", async () => {
    const { calls } = await connected();
    last().message(entry(5));
    await tick();
    expect(calls.openEntry).toHaveBeenCalledOnce();
    expect(calls.receive).toHaveBeenCalledWith({ seq: 5, dev: "OTHER", bid: "bid-5-padding", batch: "blob5" });
    expect(calls.sync).not.toHaveBeenCalled();
  });

  it("pulls instead when there is a gap", async () => {
    const { calls } = await connected();
    last().message(entry(7));
    await tick();
    expect(calls.sync).toHaveBeenCalledOnce();
    expect(calls.receive).not.toHaveBeenCalled();
  });

  it("pulls when it has no cursor yet, or the entry has no bid", async () => {
    const a = await connected();
    a.setCursor(null);
    last().message(entry(1));
    await tick();
    expect(a.calls.sync).toHaveBeenCalledOnce();
    expect(a.calls.receive).not.toHaveBeenCalled();

    FakeWebSocket.all = [];
    const b = await connected();
    last().message(entry(5, { bid: undefined }));
    await tick();
    expect(b.calls.sync).toHaveBeenCalledOnce();
  });

  it("ignores what it already has, and its own entries", async () => {
    const { calls } = await connected();
    last().message(entry(4));
    last().message(entry(5, { dev: "ME" }));
    await tick();
    expect(calls.receive).not.toHaveBeenCalled();
    expect(calls.sync).not.toHaveBeenCalled();
  });

  it("falls back to a pull when the engine says it was not the next one, or when it cannot be read", async () => {
    const a = await connected();
    a.calls.receive.mockResolvedValueOnce(null);
    last().message(entry(5));
    await tick();
    expect(a.calls.sync).toHaveBeenCalledOnce();

    FakeWebSocket.all = [];
    const b = await connected();
    b.calls.openEntry.mockRejectedValueOnce(new Error("could not decrypt"));
    last().message(entry(5));
    await tick();
    expect(b.calls.sync).toHaveBeenCalledOnce();
    expect(b.calls.onError).toHaveBeenCalled();
  });

  it("handles a burst in order, one at a time", async () => {
    const { calls, log, setCursor } = await connected();
    log.length = 0;
    calls.receive.mockImplementation(async ({ seq }) => {
      log.push(`start ${seq}`);
      await new Promise((r) => setTimeout(r, 50));
      log.push(`end ${seq}`);
      setCursor(seq);
      return { cursor: seq };
    });
    last().message(entry(5));
    last().message(entry(6));
    last().message(entry(7));
    await tick(500);
    expect(log).toEqual(["start 5", "end 5", "start 6", "end 6", "start 7", "end 7"]);
  });

  it("pulls after a rotation and tells the app", async () => {
    const { calls } = await connected();
    last().message({ t: "rotated", epoch: 2 });
    await tick();
    expect(calls.onEvent).toHaveBeenCalledWith({ t: "rotated", epoch: 2 });
    expect(calls.sync).toHaveBeenCalledOnce();
  });

  it("passes the other notices to the app and does nothing else", async () => {
    const { calls } = await connected();
    for (const t of ["devices", "pair_request", "deleted"]) last().message({ t, joinId: "j" });
    last().message("pong");
    last().message("not json");
    last().message({ t: "something-new" });
    await tick();
    expect(calls.onEvent.mock.calls.map(([m]) => m.t)).toEqual(["devices", "pair_request", "deleted"]);
    expect(calls.sync).not.toHaveBeenCalled();
  });
});

describe("presence", () => {
  it("goes to the callback and nowhere else: never to sync, receive or the cursor", async () => {
    const { socket, calls } = rig();
    socket.start();
    last().open();
    await tick();
    calls.sync.mockClear();
    last().message({ t: "presence", dev: "OTHER", blob: { sessionId: "s1", tick: 9 } });
    await tick();
    expect(calls.onPresence).toHaveBeenCalledWith({ dev: "OTHER", payload: { sessionId: "s1", tick: 9 } });
    expect(calls.sync).not.toHaveBeenCalled();
    expect(calls.receive).not.toHaveBeenCalled();
    expect(calls.openEntry).not.toHaveBeenCalled();
  });

  it("drops presence that does not open, is from itself or has no sender", async () => {
    const { socket, calls } = rig();
    socket.start();
    last().open();
    await tick();
    calls.openPresence.mockRejectedValueOnce(new Error("could not decrypt"));
    last().message({ t: "presence", dev: "OTHER", blob: "x" });
    last().message({ t: "presence", dev: "ME", blob: "x" });
    last().message({ t: "presence", blob: "x" });
    await tick();
    expect(calls.onPresence).not.toHaveBeenCalled();
  });

  it("is sealed and sent as {t, blob} when connected, and not at all when not", async () => {
    const { socket, calls } = rig();
    expect(await socket.sendPresence({ tick: 1 })).toBe(false);
    socket.start();
    expect(await socket.sendPresence({ tick: 1 })).toBe(false); // connecting, not open
    last().open();
    await tick();
    expect(await socket.sendPresence({ sessionId: "s1", tick: 2 })).toBe(true);
    expect(calls.sealPresence).toHaveBeenCalledWith({ sessionId: "s1", tick: 2 });
    expect(JSON.parse(last().sent.at(-1))).toEqual({ t: "presence", blob: { sealed: { sessionId: "s1", tick: 2 } } });
  });
});

describe("keeping the line alive", () => {
  it("sends the literal ping, and a pong keeps it open", async () => {
    FakeWebSocket.answers = false;
    const { socket } = rig();
    socket.start();
    last().open();
    await tick(30_000);
    expect(last().sent).toEqual(["ping"]);
    last().message("pong");
    await tick(11_000);
    expect(live()).toHaveLength(1);
    await tick(20_000);
    expect(last().sent).toEqual(["ping", "ping"]);
  });

  it("treats silence after a ping as a dead line and reconnects", async () => {
    FakeWebSocket.answers = false;
    const { socket, calls } = rig();
    socket.start();
    last().open();
    await tick();
    const first = last();
    await tick(30_000 + 10_000);
    expect(first.closes).toEqual([[1000, "no answer"]]);
    await tick(1_000);
    expect(FakeWebSocket.all).toHaveLength(2);
    last().open();
    await tick();
    expect(calls.sync).toHaveBeenCalledTimes(2);
  });
});

describe("close codes that mean do not come back", () => {
  for (const [code, reason] of [[CLOSE.revoked, "removed"], [CLOSE.deleted, "deleted"], [CLOSE.replaced, "replaced"]]) {
    it(`${code} stops for good (${reason})`, async () => {
      const { socket, calls, doc } = rig();
      socket.start();
      last().open();
      await tick();
      last().drop(code);
      await tick(10 * 60_000);
      expect(FakeWebSocket.all).toHaveLength(1);
      expect(socket.state).toBe("stopped");
      expect(calls.onState).toHaveBeenLastCalledWith("stopped", { reason });
      // Not even a visibility change brings it back.
      doc.set("hidden");
      doc.set("visible");
      expect(FakeWebSocket.all).toHaveLength(1);
    });
  }

  it("an ordinary drop does come back", async () => {
    const { socket } = rig();
    socket.start();
    last().open();
    await tick();
    last().drop(1006);
    await tick(1_000);
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("stops when the sync that follows a connect says this device is out", async () => {
    for (const status of ["auth", "deleted", "rekey"]) {
      FakeWebSocket.all = [];
      const { socket, calls } = rig();
      calls.sync.mockResolvedValue({ status });
      socket.start();
      last().open();
      await tick();
      expect(socket.state).toBe("stopped");
      expect(calls.onState).toHaveBeenLastCalledWith("stopped", { reason: status });
      expect(live()).toHaveLength(0);
      await tick(10 * 60_000);
      expect(FakeWebSocket.all).toHaveLength(1);
    }
  });
});

describe("reconnecting", () => {
  it("waits 1 s, 2 s, 4 s ... up to 60 s between failed attempts", async () => {
    const { socket } = rig(); // random() = 1: the longest wait each time
    socket.start();
    const waits = [];
    for (let i = 0; i < 9; i += 1) {
      const before = FakeWebSocket.all.length;
      last().drop();
      let t = 0;
      while (FakeWebSocket.all.length === before && t < 120_000) { await tick(500); t += 500; }
      waits.push(t);
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it("jitters: the wait is between half and all of the step", async () => {
    const { socket } = rig({ random: () => 0 });
    socket.start();
    last().drop();
    await tick(499);
    expect(FakeWebSocket.all).toHaveLength(1);
    await tick(2);
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("does not storm: a relay that accepts and at once hangs up is tried a handful of times in ten minutes", async () => {
    const { socket, calls } = rig();
    socket.start();
    for (let t = 0; t < 10 * 60_000; t += 250) {
      await tick(250);
      for (const s of live()) { if (s.readyState === 0) { s.open(); s.drop(4429); } }
    }
    expect(FakeWebSocket.all.length).toBeLessThanOrEqual(16);
    // And each of them asked the app to sync only because it did open.
    expect(calls.sync.mock.calls.length).toBeLessThanOrEqual(16);
  });

  it("starts the wait over once a connection has held for a while", async () => {
    const { socket } = rig();
    socket.start();
    for (let i = 0; i < 4; i += 1) { last().drop(); await tick(60_000); }
    last().open();
    await tick(31_000);
    last().drop();
    await tick(999);
    const before = FakeWebSocket.all.length;
    await tick(1);
    expect(FakeWebSocket.all.length).toBe(before + 1);
  });

  it("does not leave two timers when the page asks to reconnect while one is waiting", async () => {
    const { socket, doc } = rig();
    socket.start();
    last().drop();
    doc.set("hidden");
    doc.set("visible");
    await tick(120_000);
    expect(FakeWebSocket.all.length).toBeLessThanOrEqual(3);
    expect(live().length).toBeLessThanOrEqual(1);
  });

  it("ignores events from a socket it has already let go of", async () => {
    const { socket, calls } = rig();
    socket.start();
    const old = last();
    old.open();
    await tick();
    old.drop();
    await tick(1_000);
    const fresh = last();
    old.message({ t: "entry", seq: 5, dev: "OTHER", bid: "bid-00000001", blob: "x" });
    old.drop(CLOSE.revoked);
    await tick();
    expect(calls.receive).not.toHaveBeenCalled();
    expect(socket.state).not.toBe("stopped");
    expect(fresh).not.toBe(old);
  });
});

describe("the page being hidden", () => {
  it("stays open for 60 s hidden, then closes, and says so", async () => {
    const { socket, doc, calls } = rig();
    socket.start();
    last().open();
    await tick();
    doc.set("hidden");
    await tick(59_000);
    expect(live()).toHaveLength(1);
    await tick(1_000);
    expect(live()).toHaveLength(0);
    expect(last().closes).toEqual([[1000, "hidden"]]);
    expect(calls.onState).toHaveBeenLastCalledWith("hidden", {});
    await tick(10 * 60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it("is still there if the page comes back before the minute is out", async () => {
    const { socket, doc } = rig();
    socket.start();
    last().open();
    await tick();
    doc.set("hidden");
    await tick(30_000);
    doc.set("visible");
    await tick(120_000);
    expect(live()).toHaveLength(1);
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it("reconnects at once when the page is shown again, and syncs", async () => {
    const { socket, doc, calls } = rig();
    socket.start();
    last().open();
    await tick();
    doc.set("hidden");
    await tick(61_000);
    doc.set("visible");
    expect(FakeWebSocket.all).toHaveLength(2);
    last().open();
    await tick();
    expect(calls.sync).toHaveBeenCalledTimes(2);
  });

  it("does not connect at all while hidden, and does when shown", async () => {
    const doc = fakeDoc();
    doc.visibilityState = "hidden";
    const { socket } = rig({ doc });
    socket.start();
    await tick(10 * 60_000);
    expect(FakeWebSocket.all).toHaveLength(0);
    doc.set("visible");
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it("does not keep retrying a dropped connection once it has been hidden past the minute", async () => {
    const { socket, doc } = rig();
    socket.start();
    last().open();
    await tick();
    last().drop();
    doc.set("hidden");
    await tick(10 * 60_000);
    expect(live()).toHaveLength(0);
    expect(FakeWebSocket.all.length).toBeLessThanOrEqual(2);
  });
});

describe("stopping", () => {
  it("closes, forgets the page and never reconnects", async () => {
    const { socket, doc } = rig();
    socket.start();
    last().open();
    await tick();
    socket.stop();
    expect(last().closes[0][0]).toBe(1000);
    expect(doc.listeners.size).toBe(0);
    await tick(10 * 60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    expect(socket.state).toBe("stopped");
  });

  it("survives a handler that throws", async () => {
    const { socket, calls } = rig();
    calls.sync.mockRejectedValueOnce(new Error("boom"));
    socket.start();
    last().open();
    await tick();
    expect(calls.onError).toHaveBeenCalled();
    last().message({ t: "entry", seq: 5, dev: "OTHER", bid: "bid-00000001", blob: "x" });
    await tick();
    expect(calls.receive).toHaveBeenCalled();
  });
});
