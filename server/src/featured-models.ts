import type { PoolClient } from "pg";
import type { Database } from "./db";

/** No row is the first-run default; a persisted empty array explicitly disables all featured choices. */
export async function readFeaturedModelIds(db: Database | PoolClient): Promise<string[] | null> {
  const result = await db.query<{ featuredModelIds: string[] }>(
    `SELECT featured_model_ids AS "featuredModelIds" FROM model_presentation_settings WHERE singleton=true`,
  );
  return result.rows[0]?.featuredModelIds ?? null;
}
