/**
 * The Worker and its Durable Objects in Node, for tests: fake bindings over the
 * real worker.js, the real cores and node:sqlite. Shared by the Worker's own
 * tests and by the tests of the things that talk to it (the app's transport,
 * the admin CLI), so they all meet the same relay.
 *
 * What is real: worker.js itself, the vault and registry cores, SQL. What is a
 * stand-in: the Durable Object runtime (see relayWorker.test.js).
 */
import { createRelay, WS_PROTOCOL } from "../relay/worker.js";
import { ADMIN_TOKEN, RELAY_URL, ROUTE_KEY } from "./relayShim.js";
import { openSql } from "./relaySql.js";

// -------------------------------------------------------------- fake runtime
export class FakeSocket {
  constructor() { this.sent = []; this.closed = null; this.att = null; this.peer = null; }
  send(text) {
    if (this.closed) throw new Error("socket closed");
    this.sent.push(text);
  }
  close(code, reason) {
    if (this.closed) throw new Error("already closed");
    this.closed = { code, reason };
  }
  serializeAttachment(v) { this.att = structuredClone(v); }
  deserializeAttachment() { return this.att === null ? null : structuredClone(this.att); }
  get messages() { return this.sent.map((s) => JSON.parse(s)); }
}

/** A namespace of objects: `get(id)` gives a stub, each name its own database. */
function fakeNamespace(label, makeInstance) {
  const entries = new Map();
  const ns = {
    label, entries, gets: [], calls: [], failNext: 0,
    idFromName: (name) => name,
    get(name) {
      ns.gets.push(name);
      return { fetch: (request) => ns.deliver(name, request) };
    },
    async entry(name) {
      if (!entries.has(name)) {
        entries.set(name, (async () => {
          const db = await openSql();
          const sockets = [];
          const ctx = {
            sockets, auto: null,
            storage: {
              sql: db.sql, transactionSync: db.transaction,
              // The tombstone must survive a delete: nothing may call this.
              deleteAll() { throw new Error("deleteAll() must never be called"); },
            },
            acceptWebSocket(ws) { sockets.push(ws); },
            getWebSockets() { return sockets.filter((s) => !s.closed); },
            setWebSocketAutoResponse(pair) { ctx.auto = pair; },
          };
          return { db, ctx, instance: null };
        })());
      }
      const e = await entries.get(name);
      e.instance ??= makeInstance(e.ctx);
      return e;
    },
    async deliver(name, request) {
      if (label === "registry" && ns.failNext > 0) { ns.failNext -= 1; throw new Error("registry unreachable"); }
      const e = await ns.entry(name);
      if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
        const env = await request.clone().json();
        ns.calls.push({ name, method: env.method, path: env.path.split("?")[0], trusted: env.trusted, ip: env.ip });
      }
      return e.instance.fetch(request);
    },
    /** Drops the live instance, keeping storage and sockets: what hibernation does. */
    evict(name) { return ns.entries.get(name).then((e) => { e.instance = null; }); },
    async socketMessage(name, ws, message) { return (await ns.entry(name)).instance.webSocketMessage(ws, message); },
    async socketClose(name, ws, code) { return (await ns.entry(name)).instance.webSocketClose(ws, code); },
  };
  return ns;
}

const platformWith = (clock) => ({
  now: () => clock.t,
  pair: () => {
    const client = new FakeSocket();
    const server = new FakeSocket();
    client.peer = server;
    return [client, server];
  },
  // Node's Response refuses status 101, so the upgrade is a plain object with the same fields.
  upgraded: (client) => ({ status: 101, webSocket: client, headers: new Headers({ "sec-websocket-protocol": WS_PROTOCOL }) }),
  autoResponse: () => ({ request: "ping", response: "pong" }),
});

export function world(secrets = {}) {
  const clock = { t: Date.UTC(2026, 0, 5, 12) };
  const relay = createRelay(platformWith(clock));
  const env = { ROUTE_KEY, ADMIN_TOKEN, ...secrets };
  env.VAULT = fakeNamespace("vault", (ctx) => new relay.VaultDO(ctx, env));
  env.REGISTRY = fakeNamespace("registry", (ctx) => new relay.RegistryDO(ctx, env));
  const w = {
    clock, env, relay,
    touched: () => [...env.VAULT.gets, ...env.REGISTRY.gets],
    /** `fetch` as the client sees it: a URL and an init, answered by the Worker. */
    fetch: (url, init) => relay.worker.fetch(new Request(url, init), env),
    vaultName: (vault) => `v:${vault.vaultId}`,
    registryCalls: (path) => env.REGISTRY.calls.filter((c) => c.path === path),
  };
  return w;
}

export const request = (w, path, { method = "GET", token, body, headers = {}, ip } = {}) =>
  w.fetch(`${RELAY_URL}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(ip ? { "cf-connecting-ip": ip } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const read = async (res) => ({ status: res.status, body: await res.json(), res });
export const admin = (w, path, opts = {}) => request(w, `/v1/admin${path}`, { ...opts, token: opts.token ?? ADMIN_TOKEN }).then(read);

