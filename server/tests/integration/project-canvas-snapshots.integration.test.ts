import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

const runIntegration =
  process.env.RUN_INTEGRATION_TESTS === "true" && !!process.env.DATABASE_URL;
const integration = runIntegration ? describe : describe.skip;

const migrationsDirectory = fileURLToPath(
  new URL("../../src/migrations", import.meta.url),
);

integration("project canvas snapshot migrations", () => {
  test("allows inserting one revisioned snapshot for a project", async () => {
    const schemaName = `test_canvas_snapshots_${crypto.randomUUID().replaceAll("-", "")}`;
    const database = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schemaName}`,
    });

    try {
      await database.query(`CREATE SCHEMA "${schemaName}"`);
      await database.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );

      const applied = new Set(
        (
          await database.query<{ name: string }>(
            "SELECT name FROM schema_migrations",
          )
        ).rows.map((row) => row.name),
      );

      for (const name of (await readdir(migrationsDirectory))
        .filter((file) => file.endsWith(".sql"))
        .sort()) {
        if (applied.has(name)) continue;
        const client = await database.connect();
        try {
          await client.query("BEGIN");
          await client.query(await readFile(resolve(migrationsDirectory, name), "utf8"));
          await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      }

      const owner = await database.query<{ id: string }>(
        `INSERT INTO users(username,display_name,password_hash)
         VALUES($1,$2,$3)
         RETURNING id`,
        [
          `canvas-owner-${crypto.randomUUID()}`,
          "Canvas Owner",
          "not-used-in-test",
        ],
      );
      const project = await database.query<{ id: string }>(
        `INSERT INTO projects(external_id,name,owner_user_id)
         VALUES($1,$2,$3)
         RETURNING id`,
        [`canvas-project-${crypto.randomUUID()}`, "Canvas Project", owner.rows[0]!.id],
      );

      const inserted = await database.query<{ revision: number }>(
        `INSERT INTO project_canvas_snapshots(project_id,owner_user_id,snapshot)
         VALUES($1,$2,$3::jsonb)
         RETURNING revision`,
        [
          project.rows[0]!.id,
          owner.rows[0]!.id,
          JSON.stringify({ elements: [{ id: "shape-1", type: "rectangle" }] }),
        ],
      );

      expect(inserted.rows).toEqual([{ revision: 1 }]);
    } finally {
      await database.end();

      const cleanup = new Pool({ connectionString: process.env.DATABASE_URL });
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } finally {
        await cleanup.end();
      }
    }
  });
});
