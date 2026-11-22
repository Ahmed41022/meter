/**
 * The Meter relay on your own machine, for trying the app in a browser without
 * deploying anything. DEVELOPMENT ONLY: nothing here is shipped or deployed.
 *
 * What is real: relay/worker.js itself, the vault and registry cores, and SQL
 * (node:sqlite, in a file so a restart keeps your accounts). What stands in is
 * the Durable Object runtime, the same stand-in the test suite uses
 * (tests/relayWorld.js), plus a plain Node HTTP front. It is not Cloudflare's
 * behaviour: there is no hibernation, no billing and no real limits.
 *
 * WebSockets are refused with 426 on purpose. Node has no WebSocket server in
 * its standard library, and the app must work without a live socket anyway (a
 * relay that cannot upgrade, a network that blocks it), so this doubles as the
 * test of that path: the app falls back to syncing when opened, after edits and
 * on its slow poll.
 *
 * Everything that touches the disk, the clock or the network is a parameter, so
 * a test can run it in-process.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRelay, WS_PROTOCOL } from "../../relay/worker.js";

/** Origins the app is served from during development (Electron and the dev page). */
export const DEV_ORIGINS = ["http://127.0.0.1:47940", "http://127.0.0.1:47823"];

let sqlite = null;
/** node:sqlite prints an ExperimentalWarning once; it is true and irrelevant here. */
async function loadSqlite() {
  if (sqlite) return sqlite;
  const original = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const text = typeof warning === "string" ? warning : warning?.message ?? "";
    if (/SQLite is an experimental feature/.test(text)) return undefined;
    return original.call(process, warning, ...rest);
  };
  try { sqlite = await import("node:sqlite"); } finally { process.emitWarning = original; }
  return sqlite;
}

/** `ctx.storage.sql` over a database file: the one call the cores use,
 *  `exec(query, ...bindings).toArray()`, and the transaction wrapper. */
export async function openFileSql(file) {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(file);
  const sql = {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      const rows = stmt.columns().length ? stmt.all(...bindings).map((r) => ({ ...r })) : (stmt.run(...bindings), []);
      return {
        toArray: () => rows,
        one() {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0];
        },
      };
    },
  };
  const transaction = (fn) => {
    db.exec("BEGIN");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  return { db, sql, transaction };
}

/** Secrets for this machine's relay, made once and kept in the directory. They
 *  protect nothing but a relay on 127.0.0.1 and are printed on purpose. */
export function localSecrets(dir, random = randomBytes) {
  const file = join(dir, "secrets.json");
  if (existsSync(file)) {
    try {
      const s = JSON.parse(readFileSync(file, "utf8"));
      if (typeof s.ROUTE_KEY === "string" && typeof s.ADMIN_TOKEN === "string") return { ...s, created: false };
    } catch { /* made again below */ }
  }
  const made = { ROUTE_KEY: random(24).toString("hex"), ADMIN_TOKEN: random(24).toString("hex") };
  writeFileSync(file, JSON.stringify(made, null, 2));
  return { ...made, created: true };
}

/** A namespace of Durable Objects, each name with its own database file. */
function fileNamespace(dir, makeInstance, track) {
  const entries = new Map();
  const ns = {
    idFromName: (name) => name,
    get: (name) => ({ fetch: (request) => ns.deliver(name, request) }),
    async deliver(name, request) {
      if (!entries.has(name)) {
        entries.set(name, (async () => {
          const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
          const db = await openFileSql(join(dir, `${safe}.sqlite`));
          track(db.db);
          const ctx = {
            storage: {
              sql: db.sql, transactionSync: db.transaction,
              // A deleted vault keeps its tombstone so the answer stays "gone".
              deleteAll() { throw new Error("deleteAll() must never be called"); },
            },
            acceptWebSocket() {},
            getWebSockets: () => [],
            setWebSocketAutoResponse() {},
          };
          return makeInstance(ctx);
        })());
      }
      return (await entries.get(name)).fetch(request);
    },
  };
  return ns;
}

/**
 * @param dir  where the databases and secrets live (created if missing)
 * @returns `{ env, worker, secrets, fetch, invite }`
 */
export async function createLocalRelay({ dir, now = () => Date.now(), random = randomBytes } = {}) {
  mkdirSync(dir, { recursive: true });
  const secrets = localSecrets(dir, random);
  const relay = createRelay({
    now,
    pair: () => { throw new Error("WebSocket pairs are not available in the local relay"); },
    upgraded: () => { throw new Error("WebSocket upgrades are not available in the local relay"); },
    autoResponse: () => ({ request: "ping", response: "pong" }),
  });
  const env = { ROUTE_KEY: secrets.ROUTE_KEY, ADMIN_TOKEN: secrets.ADMIN_TOKEN };
  const open = [];
  env.VAULT = fileNamespace(dir, (ctx) => new relay.VaultDO(ctx, env), (db) => open.push(db));
  env.REGISTRY = fileNamespace(dir, (ctx) => new relay.RegistryDO(ctx, env), (db) => open.push(db));
  const fetch = (url, init) => relay.worker.fetch(new Request(url, init), env);

  /** A fresh single-use invite, asked of the real admin route in-process. */
  const invite = async (label = "local test", days = 1) => {
    const res = await relay.worker.fetch(new Request("http://127.0.0.1/v1/admin/invite", {
      method: "POST",
      headers: { authorization: `Bearer ${secrets.ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ label, days }),
    }), env);
    const body = await res.json();
    if (res.status !== 200) throw new Error(`the relay would not make an invite (${res.status} ${body.code ?? ""})`);
    return body.code;
  };
  /** Closes the database files (a test needs them released before it deletes them). */
  const close = () => { for (const db of open.splice(0)) { try { db.close(); } catch { /* already closed */ } } };
  return { env, worker: relay.worker, secrets, fetch, invite, close, WS_PROTOCOL };
}

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks)));
  req.on("error", reject);
});

/**
 * Node `http` request in, the Worker's answer out. A request that asks to
 * upgrade to a WebSocket is answered 426 (see the header).
 */
export function nodeHandler(local, { origin = "http://127.0.0.1:8788" } = {}) {
  return async (req, res) => {
    try {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      if ((headers.upgrade ?? "").toLowerCase() === "websocket") {
        res.writeHead(426, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end(JSON.stringify({ code: "upgrade_required" }));
        return;
      }
      // The registry limits sign-ups per address, and Cloudflare would set this.
      headers["cf-connecting-ip"] = req.socket?.remoteAddress ?? "127.0.0.1";
      const method = (req.method ?? "GET").toUpperCase();
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
      const out = await local.fetch(`${origin}${req.url}`, { method, headers, body });
      const outHeaders = {};
      out.headers.forEach((v, k) => { outHeaders[k] = v; });
      res.writeHead(out.status, outHeaders);
      res.end(Buffer.from(await out.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ code: "internal", message: String(e?.message ?? e) }));
    }
  };
}
