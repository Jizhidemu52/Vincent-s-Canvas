import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "../../src/db";

/** Disposable WASM PostgreSQL only. No application config or DATABASE_URL. */
export async function createIsolatedPostgres(options: { usageRollupsEnabled?: boolean } = {}) {
  const runtime = process.env.PGLITE_RUNTIME_PATH;
  if (!runtime) throw new Error("PGLITE_RUNTIME_PATH is required for isolated SQL tests");
  const requireRuntime = createRequire(resolve(runtime, "package.json"));
  const { PGlite } = requireRuntime("@electric-sql/pglite");
  const { pgcrypto } = requireRuntime("@electric-sql/pglite/contrib/pgcrypto");
  const { citext } = requireRuntime("@electric-sql/pglite/contrib/citext");
  const database = new PGlite({ extensions: { pgcrypto, citext } });
  await database.waitReady;
  const directory = fileURLToPath(new URL("../../src/migrations/", import.meta.url));
  for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
    await database.exec(await readFile(resolve(directory, name), "utf8"));
  }
  // Opt-in only for tests of active processing. Ordinary fixtures retain the
  // production migration's disabled-by-default release boundary.
  if (options.usageRollupsEnabled) await database.exec("UPDATE usage_rollup_state SET processing_enabled=true WHERE singleton=true");
  // PGlite has one connection. Serialize entire transactions, not just their
  // individual statements, so parallel worker tests cannot nest transactions.
  let tail = Promise.resolve();
  const lock = async () => {
    const previous = tail;
    let unlock!: () => void;
    tail = new Promise<void>(done => { unlock = done; });
    await previous;
    return unlock;
  };
  const statements: string[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    statements.push(sql);
    const result = await database.query(sql, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  const db = {
    query: async (sql: string, values?: unknown[]) => {
      const unlock = await lock();
      try { return await query(sql, values); } finally { unlock(); }
    },
    connect: async () => {
      const unlock = await lock();
      return { query, release: unlock };
    },
  } as unknown as Database;
  return { db, statements, close: () => database.close() as Promise<void> };
}
