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
const migrations = ["054_image_conversations.sql", "055_mai27_model_catalog.sql"];
const keys = { columns: ["table_name", "ordinal_position"], indexes: ["tablename", "indexname"], constraints: ["relation", "name"], functions: ["identity"], triggers: ["relation", "name"] };
const identity = (field, row) => JSON.stringify(keys[field].map(key => row[key]));
try {
    await db.exec("SET search_path=public; CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    for (const name of (await readdir(resolve(root, "server/src/migrations"))).filter(name => name.endsWith(".sql") && name < migrations[0]).sort()) {
        await db.exec(await read(`server/src/migrations/${name}`));
        await db.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    }
    await db.exec(await read("ops/release/canvas-design-chat-053-test-fixture.sql"));
    await db.exec(await read("ops/release/image-conversations-054-055-test-fixture.sql"));
    const [base, usage, extra] = await Promise.all(["database-state.sql", "usage-048-state.sql", "image-conversations-054-055-state.sql"].map(async name => (await read(`ops/release/${name}`)).trim().replace(/;$/, "")));
    const query = `WITH b(snapshot) AS (${base}), e(snapshot) AS (${usage}), s(snapshot) AS (${extra}) SELECT b.snapshot||e.snapshot||s.snapshot||jsonb_build_object('constraints',(SELECT coalesce(jsonb_agg(v ORDER BY v->>'relation',v->>'name'),'[]'::jsonb) FROM jsonb_array_elements(b.snapshot->'constraints') v WHERE v->>'type'<>'n')) AS snapshot FROM b,e,s`;
    const snapshotText = async () => (await db.query(`SELECT snapshot::text AS raw FROM (${query}) q`)).rows[0].raw;
    const snapshot = async () => JSON.parse(await snapshotText());
    if (process.argv[2] === "catalog") {
        const before = await snapshot();
        await db.exec(await read(`server/src/migrations/${migrations[0]}`));
        const after = await snapshot(), additions = {};
        for (const field of Object.keys(keys)) {
            const previous = new Map(before[field].map(row => [identity(field, row), row]));
            additions[field] = after[field].filter(row => !previous.has(identity(field, row)));
            if (before[field].some(prior => JSON.stringify(after[field].find(row => identity(field, row) === identity(field, prior))) !== JSON.stringify(prior))) throw Error(`054 changed old ${field}`);
        }
        const numberSequence = (await db.query(`SELECT jsonb_build_object('sequencename',sequencename,'start_value',start_value::text,
            'min_value',min_value::text,'max_value',max_value::text,'increment_by',increment_by::text,'cycle',cycle,'cache_size',cache_size::text) AS value
            FROM pg_sequences WHERE schemaname='public' AND sequencename='model_public_number_seq'`)).rows[0].value;
        console.log(JSON.stringify({ schema: 1, additions, seedColumns: before.columns.filter(row => ["model_configs", "schema_migrations"].includes(row.table_name)),
            modelTrigger: before.triggers.filter(row => row.relation === "model_configs"), modelFunction: before.functions.filter(row => row.identity === "assign_model_public_number()"), numberSequence }, null, 2));
    } else if (process.argv[2] === "sequence-probe") {
        const numberState = async () => {
            const value = await snapshot();
            return { sequence: value.sequenceStates.find(row => row.name === "model_public_number_seq"), modelRows: value.tables.find(row => row.name === "model_configs"), target: value.mai27Target };
        };
        const before = await numberState();
        await db.exec("BEGIN;" + await read(`server/src/migrations/${migrations[1]}`));
        const beforeRollback = await numberState();
        await db.exec("ROLLBACK;");
        const afterRollback = await numberState();
        await db.exec("BEGIN;" + await read(`server/src/migrations/${migrations[1]}`) + "COMMIT;");
        const afterCommit = await numberState();
        const nextNumber = state => BigInt(state.sequence.lastValue) + (state.sequence.isCalled ? 1n : 0n);
        await db.exec("BEGIN;" + await read(`server/src/migrations/${migrations[1]}`) + "COMMIT;");
        const afterReplay = await numberState();
        if (nextNumber(beforeRollback) - nextNumber(before) !== 1n || nextNumber(afterRollback) - nextNumber(before) !== 1n
            || nextNumber(afterCommit) - nextNumber(afterRollback) !== 1n || afterRollback.target.length || afterCommit.target.length !== 1
            || JSON.stringify(afterReplay) !== JSON.stringify(afterCommit)
            || JSON.stringify(before.modelRows) !== JSON.stringify(afterRollback.modelRows)) throw Error("Unexpected 055 sequence probe result");
        console.log(JSON.stringify({ status: "fixed-source-regression-passed", isolation: "disposable-in-memory-pglite-no-network", before, beforeRollback, afterRollback, afterCommit, afterReplay }, null, 2));
    } else {
        if (!process.env.IMAGE_CONVERSATIONS_054_055_TEST_PYTHON) throw Error("Explicit isolated test Python required");
        let input = ""; for await (const chunk of process.stdin) input += chunk;
        const results = [];
        for (const operation of JSON.parse(input)) {
            try {
                if (operation.kind === "snapshot") results.push({ ok: true, snapshotJson: await snapshotText() });
                else if (operation.kind === "migration") {
                    const built = spawnSync(process.env.IMAGE_CONVERSATIONS_054_055_TEST_PYTHON, ["-B", resolve(root, "ops/release/test_image_conversations_054_055.py"), "--sql-builder"], {
                        input: JSON.stringify({ ...operation, beforeJson: await snapshotText() }), encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
                    });
                    if (built.status !== 0) throw Error(built.stderr);
                    if (operation.beforeSql) await db.exec(operation.beforeSql);
                    results.push({ ok: true, values: await db.exec(built.stdout) });
                } else if (operation.kind === "raw-migration-055") results.push({ ok: true, values: await db.exec(await read(`server/src/migrations/${migrations[1]}`)) });
                else results.push({ ok: true, values: await db.exec(operation.sql) });
            } catch (error) {
                results.push({ ok: false, code: error.code, message: error.message, detail: error.detail });
                await db.exec("ROLLBACK");
            }
        }
        console.log(JSON.stringify(results));
    }
} finally { await db.close(); }
