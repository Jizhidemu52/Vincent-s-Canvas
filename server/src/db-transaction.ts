import type { PoolClient } from "pg";

import type { Database } from "./db";

export async function withTransaction<T>(
  db: Database,
  operation: (client: PoolClient) => Promise<T>,
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const code =
        typeof error === "object" && error && "code" in error
          ? String(error.code)
          : "";
      if ((code !== "40P01" && code !== "40001") || attempt === 3) throw error;
      await Bun.sleep(20 * (attempt + 1));
    } finally {
      client.release();
    }
  }
  throw new Error("Transaction retry limit reached");
}
