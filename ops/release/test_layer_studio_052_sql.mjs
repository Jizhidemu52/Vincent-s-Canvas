// Disposable WASM PostgreSQL only: no app env, credentials or network database.
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
if (!process.env.PGLITE_RUNTIME_PATH) throw Error("PGLITE_RUNTIME_PATH required");
const runtime = createRequire(resolve(process.env.PGLITE_RUNTIME_PATH, "package.json"));
const { PGlite } = runtime("@electric-sql/pglite");
const { pgcrypto } = runtime("@electric-sql/pglite/contrib/pgcrypto");
const { citext } = runtime("@electric-sql/pglite/contrib/citext");
const db = new PGlite({ extensions: { pgcrypto, citext } });
await db.waitReady;
const read = relative => readFile(resolve(root, relative), "utf8");
const migration = "052_layer_studio.sql";
try {
    await db.exec("SET search_path=public; CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    for (const name of (await readdir(resolve(root, "server/src/migrations"))).filter(name => name.endsWith(".sql") && name < migration).sort()) {
        await db.exec(await read(`server/src/migrations/${name}`));
        await db.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    }
    await db.exec(await read("ops/release/layer-studio-052-test-fixture.sql"));
    const [base, usage, layer] = await Promise.all(["database-state.sql", "usage-048-state.sql", "layer-studio-052-state.sql"].map(async name => (await read(`ops/release/${name}`)).trim().replace(/;$/, "")));
    const query = `WITH b(snapshot) AS (${base}), e(snapshot) AS (${usage}), s(snapshot) AS (${layer}) SELECT b.snapshot||e.snapshot||s.snapshot||jsonb_build_object('constraints',(SELECT coalesce(jsonb_agg(v ORDER BY v->>'relation',v->>'name'),'[]'::jsonb) FROM jsonb_array_elements(b.snapshot->'constraints') v WHERE v->>'type'<>'n')) AS snapshot FROM b,e,s`;
    // Keep bigint sequence state as PostgreSQL JSON text until Python parses it.
    const snapshotText = async () => (await db.query(`SELECT snapshot::text AS raw FROM (${query}) q`)).rows[0].raw;
    if (process.argv[2] === "catalog") {
        const before = JSON.parse(await snapshotText());
        await db.exec(await read(`server/src/migrations/${migration}`));
        const after = JSON.parse(await snapshotText());
        const keys = { columns: ["table_name", "ordinal_position"], indexes: ["tablename", "indexname"], constraints: ["relation", "name"], functions: ["identity"], triggers: ["relation", "name"] };
        const identity = (field, row) => JSON.stringify(keys[field].map(key => row[key]));
        const additions = {};
        for (const field of Object.keys(keys)) {
            const previous = new Set(before[field].map(row => identity(field, row)));
            additions[field] = after[field].filter(row => !previous.has(identity(field, row)));
        }
        const replacements = before.constraints.flatMap(prior => {
            const current = after.constraints.find(row => identity("constraints", row) === identity("constraints", prior));
            return JSON.stringify(prior) === JSON.stringify(current) ? [] : [{ before: prior, after: current }];
        });
        const seeds = {
            module_flags: { values: { module_key: "layer-studio", enabled: false, updated_by: null }, timestamps: ["updated_at"] },
            tool_api_configurations: { values: { tool_key: "layer-studio", model_config_id: null, enabled: false, updated_by: null, credit_cost_override: null, rmb_cost_override: null, configuration_version: 1, allow_raw_prompt: false }, timestamps: ["created_at", "updated_at"] },
        };
        console.log(JSON.stringify({ schema: 1, replacements, additions, seedColumns: before.columns.filter(row => ["module_flags", "tool_api_configurations", "schema_migrations"].includes(row.table_name)), seeds }, null, 2));
    } else {
        let input = ""; for await (const chunk of process.stdin) input += chunk;
        const results = [];
        for (const operation of JSON.parse(input)) {
            try {
                if (operation.kind === "snapshot") results.push({ ok: true, snapshotJson: await snapshotText() });
                else if (operation.kind === "migration") {
                    const built = spawnSync(process.env.LAYER_STUDIO_052_TEST_PYTHON, ["-B", resolve(root, "ops/release/test_layer_studio_052.py"), "--sql-builder"], {
                        input: JSON.stringify({ ...operation, beforeJson: await snapshotText() }), encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
                    });
                    if (built.status !== 0) throw Error(built.stderr);
                    results.push({ ok: true, values: await db.exec(built.stdout) });
                } else results.push({ ok: true, values: await db.exec(operation.sql) });
            } catch (error) {
                results.push({ ok: false, code: error.code, message: error.message, detail: error.detail });
                await db.exec("ROLLBACK");
            }
        }
        console.log(JSON.stringify(results));
    }
} finally { await db.close(); }
