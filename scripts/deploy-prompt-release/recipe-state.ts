import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Db = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> };
const ignored = new Set(["schema_migrations", "prompt_recipes", "prompt_recipe_versions", "prompt_compilations"]);
export const expectedKeys = ["text-to-style", "style-to-sketch", "local-restyle", "garment-colorway", "back-design", "pattern-extract", "pattern-colorway", "accessory-design", "pattern-craft", "series-recipe", "workflow-step", "print-placement", "garment-presentation", "free-optimize", "batch-optimize", "reverse-prompt", "creative-chat", "canvas-assistant"].sort();
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export async function assertOptimizer(db: Db, id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error("Optimizer must be a model configuration UUID");
  const row = (await db.query("SELECT m.enabled,p.enabled AS provider_enabled,m.capabilities,m.workflow_config_id,w.enabled AS workflow_enabled FROM model_configs m JOIN providers p ON p.id=m.provider_id LEFT JOIN workflow_configs w ON w.id=m.workflow_config_id WHERE m.id=$1", [id])).rows[0];
  if (!row?.enabled || !row.provider_enabled || !row.capabilities.includes("chat") || (row.workflow_config_id && !row.workflow_enabled)) throw Error("Selected independent optimizer is missing, disabled or not chat capable");
}
export async function capture(db: Db) {
  const names = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename as string);
  const tables: Record<string, { count: number; digest: string }> = {};
  for (const name of names.filter(name => !ignored.has(name))) {
    const record = name === "tasks" ? "to_jsonb(t)-'user_input'-'prompt_compilation_id'-'prompt_optimized'"
      : name === "batch_tasks" ? "to_jsonb(t)-'admission_input_hash'-'admission_status'-'admission_token'-'admission_lease_expires_at'-'admission_failures'" : "to_jsonb(t)";
    const row = (await db.query(`SELECT count(*)::int AS count, md5(COALESCE(string_agg(md5((${record})::text),'' ORDER BY md5((${record})::text)),'')) AS digest FROM ${quote(name)} t`)).rows[0];
    tables[name] = { count: Number(row.count), digest: row.digest };
  }
  const recipes = names.includes("prompt_recipes") ? (await db.query("SELECT key,settings,current_version_id FROM prompt_recipes ORDER BY key")).rows : [];
  const versions = names.includes("prompt_recipe_versions") ? (await db.query("SELECT id,md5(to_jsonb(v)::text) AS digest FROM prompt_recipe_versions v ORDER BY id")).rows : [];
  const compilations = names.includes("prompt_compilations") ? (await db.query("SELECT id,md5(to_jsonb(c)::text) AS digest FROM prompt_compilations c ORDER BY id")).rows : [];
  return { tables, recipes, versions, compilations };
}
export async function verify(db: Db, before: Awaited<ReturnType<typeof capture>>, optimizer: string) {
  const after = await capture(db);
  if (JSON.stringify(before.tables) !== JSON.stringify(after.tables)) throw Error("Non-prompt database tables changed during migration/import (employee, billing, task or tool configuration data)");
  for (const row of before.versions) if (!after.versions.some(value => value.id === row.id && value.digest === row.digest)) throw Error("An existing administrator recipe version changed");
  if (JSON.stringify(before.compilations) !== JSON.stringify(after.compilations)) throw Error("Existing compilation history changed");
  for (const key of expectedKeys) {
    const row = after.recipes.find(value => value.key === key), prior = before.recipes.find(value => value.key === key);
    if (!row?.current_version_id) throw Error(`Recipe not activated: ${key}`);
    if (prior) {
      if (JSON.stringify(prior.settings) !== JSON.stringify(row.settings)) throw Error(`Existing settings overwritten: ${key}`);
      if (prior.current_version_id && prior.current_version_id !== row.current_version_id) throw Error(`Existing active version overwritten: ${key}`);
    } else if (row.settings.modelConfigId !== optimizer || row.settings.failurePolicy !== "stop" || row.settings.enabled !== true) throw Error(`Initial recipe configuration mismatch: ${key}`);
  }
  const applied = (await db.query("SELECT name FROM schema_migrations WHERE name='043_prompt_recipes.sql'")).rows;
  if (applied.length !== 1) throw Error("Migration 043 not recorded");
  return { verifiedRecipeKeys: expectedKeys, preservedTables: Object.keys(after.tables).length, preservedExistingRecipes: before.recipes.length };
}

async function main() {
  const [command, state, optimizer] = process.argv.slice(2);
  // The mounted release guard uses the target image's production DB implementation.
  const { createDatabase } = await import("/app/src/db.ts");
  const db = createDatabase(process.env.DATABASE_URL!);
  try {
    if (command === "capture") { await assertOptimizer(db, optimizer!); await writeFile(state!, JSON.stringify(await capture(db), null, 2)); }
    else if (command === "verify") { console.log(JSON.stringify(await verify(db, JSON.parse(await readFile(state!, "utf8")), optimizer!))); }
    else if (command === "disable") {
      await db.query("UPDATE prompt_recipes SET settings=jsonb_set(settings,'{enabled}','false'::jsonb),updated_at=$2 WHERE key=ANY($1::text[])", [expectedKeys, new Date().toISOString()]);
      console.log("RECIPE_SETTINGS_DISABLED_DATA_RETAINED");
    } else throw Error("Expected capture, verify or disable");
  } finally { await db.end(); }
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.path) await main();
