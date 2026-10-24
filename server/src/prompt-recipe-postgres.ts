import type { Database } from "./db";
import { withTransaction } from "./db-transaction";
import { PromptRecipeStore, type PromptSql } from "./prompt-recipe-store";

export function postgresPromptRecipeStore(db: Database) {
  return new PromptRecipeStore({
    query: async <T>(sql: string, values?: unknown[]) => ({ rows: (await db.query(sql, values)).rows as T[] }), lock: async () => {},
    transaction: action => withTransaction(db, client => action({
      query: async <T>(sql: string, values?: unknown[]) => ({ rows: (await client.query(sql, values)).rows as T[] }),
      lock: async key => { await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]); },
    } satisfies PromptSql)),
  });
}
