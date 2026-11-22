/**
 * `ctx.storage.sql` for the relay cores, over `node:sqlite` in memory.
 *
 * The cores only ever call `sql.exec(query, ...bindings).toArray()`, which is
 * all this offers; a Durable Object's `sql` has the same call and the same row
 * shape (objects keyed by column). `transaction` stands in for
 * `ctx.storage.transactionSync`: it rolls back when the function throws.
 *
 * `node:sqlite` prints an ExperimentalWarning the first time it loads. It is
 * true and irrelevant to a test, and it would fill every run's output, so it is
 * dropped for the one import and nothing else.
 */
let loading = null;

const loadSqlite = () => {
  loading ??= (async () => {
    const original = process.emitWarning;
    process.emitWarning = (warning, ...rest) => {
      const text = typeof warning === "string" ? warning : warning?.message ?? "";
      if (/SQLite is an experimental feature/.test(text)) return;
      return original.call(process, warning, ...rest);
    };
    try {
      return await import("node:sqlite");
    } finally {
      process.emitWarning = original;
    }
  })();
  return loading;
};

export async function openSql() {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      // A statement with result columns is a query; the rest only has effects.
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

/** A repeatable random source: bytes from a counter, so ids and tokens in a test are stable. */
export function seededRandom(seed = 1) {
  let x = seed >>> 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      out[i] = x >>> 24;
    }
    return out;
  };
}
