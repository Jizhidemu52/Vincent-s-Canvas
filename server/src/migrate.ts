import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config";
import { createDatabase } from "./db";

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const directory = fileURLToPath(new URL("./migrations", import.meta.url));

await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
const applied = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((row) => row.name));

for (const name of (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()) {
    if (applied.has(name)) continue;
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query(await readFile(resolve(directory, name), "utf8"));
        await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
        await client.query("COMMIT");
        console.log(`Applied ${name}`);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

await db.end();
