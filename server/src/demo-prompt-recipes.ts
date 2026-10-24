import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PromptRecipeStore, type PromptSql } from "./prompt-recipe-store";

export function sqlitePromptRecipeStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true, strict: true });
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS prompt_recipes (key TEXT PRIMARY KEY,settings TEXT NOT NULL CHECK(json_valid(settings)),current_version_id TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS prompt_recipe_versions (id TEXT PRIMARY KEY,recipe_key TEXT NOT NULL REFERENCES prompt_recipes(key),version INTEGER NOT NULL,content_hash TEXT NOT NULL,content TEXT NOT NULL CHECK(json_valid(content)),created_by TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(recipe_key,version),UNIQUE(recipe_key,content_hash));
    CREATE TABLE IF NOT EXISTS prompt_compilations (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,recipe_key TEXT NOT NULL REFERENCES prompt_recipes(key),recipe_version_id TEXT NOT NULL REFERENCES prompt_recipe_versions(id),status TEXT NOT NULL CHECK(status IN ('optimizing','success','failed','uncertain')),reused_from_id TEXT REFERENCES prompt_compilations(id),details TEXT NOT NULL CHECK(json_valid(details)),created_at TEXT NOT NULL,UNIQUE(user_id,request_id));
    CREATE INDEX IF NOT EXISTS prompt_compilations_cache_idx ON prompt_compilations(user_id,input_hash,created_at DESC) WHERE reused_from_id IS NULL;
    CREATE INDEX IF NOT EXISTS prompt_compilations_recipe_idx ON prompt_compilations(recipe_key,created_at DESC);`);
  let tail = Promise.resolve();
  const acquire = async () => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(done => { release = done; });
    await previous;
    return release;
  };
  const client: PromptSql = {
    query: async <T>(sql: string, values: unknown[] = []) => {
      const statement = database.prepare(sql.replace(/\$(\d+)/g, "?$1"));
      try { return { rows: statement.all(...values as SQLQueryBindings[]) as T[] }; }
      finally { statement.finalize(); }
    },
    lock: async () => {},
  };
  const store = new PromptRecipeStore({ ...client,
    // Standalone reads/writes must not observe another async transaction's draft.
    query: async <T>(sql: string, values?: unknown[]) => {
      const release = await acquire();
      try { return await client.query<T>(sql, values); } finally { release(); }
    },
    transaction: async action => {
    const release = await acquire();
    try {
      database.exec("BEGIN IMMEDIATE");
      try { const result = await action(client); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    } finally { release(); }
  } });
  return { store, close: () => database.close() };
}
