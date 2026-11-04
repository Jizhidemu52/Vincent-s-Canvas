// Disposable WASM PostgreSQL. Never loads application configuration or connects
// to a network database. Python tests supply reviewed SQL through stdin.
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
if (!process.env.PGLITE_RUNTIME_PATH) throw Error('PGLITE_RUNTIME_PATH required');
const runtime = createRequire(resolve(process.env.PGLITE_RUNTIME_PATH, 'package.json'));
const { PGlite } = runtime('@electric-sql/pglite');
const { pgcrypto } = runtime('@electric-sql/pglite/contrib/pgcrypto');
const { citext } = runtime('@electric-sql/pglite/contrib/citext');
const db = new PGlite({ extensions: { pgcrypto, citext } });
await db.waitReady;
try {
  await db.exec('SET search_path=public');
  await db.exec('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await readdir(resolve(root, 'server/src/migrations'))).filter(n => n.endsWith('.sql') && !n.startsWith('048_')).sort()) {
    await db.exec(await readFile(resolve(root, 'server/src/migrations', name), 'utf8'));
    await db.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
  }
  const base = (await readFile(resolve(root, 'ops/release/database-state.sql'), 'utf8')).trim().replace(/;$/, '');
  const extra = (await readFile(resolve(root, 'ops/release/usage-048-state.sql'), 'utf8')).trim().replace(/;$/, '');
  const query = `WITH b(snapshot) AS (${base}), e(snapshot) AS (${extra}) SELECT b.snapshot||e.snapshot||jsonb_build_object('constraints',(SELECT coalesce(jsonb_agg(c ORDER BY c->>'relation',c->>'name'),'[]'::jsonb) FROM jsonb_array_elements(b.snapshot->'constraints') c WHERE c->>'type'<>'n')) AS snapshot FROM b,e`;
  // pg_sequences includes bigint max_value beyond JavaScript's safe integer.
  // Preserve the database JSON text until Python can decode exact integers.
  const snapshotText = async () => (await db.query(`SELECT snapshot::text AS raw FROM (${query}) s`)).rows[0].raw;
  if (process.argv[2] === 'catalog') {
    const before = (await db.query(query)).rows[0].snapshot;
    await db.exec(await readFile(resolve(root, 'server/src/migrations/048_usage_daily_facts.sql'), 'utf8'));
    const after = (await db.query(query)).rows[0].snapshot;
    const keys = { columns: 'table_name', indexes: 'indexname', constraints: 'name', functions: 'identity', triggers: 'name' };
    const catalog = {};
    for (const [field, key] of Object.entries(keys)) {
      const prior = new Set((before[field] ?? []).map(row => JSON.stringify(field === 'constraints' || field === 'triggers' ? [row.relation, row[key]] : field === 'columns' ? [row.table_name, row.column_name] : row[key])));
      catalog[field] = after[field].filter(row => !prior.has(JSON.stringify(field === 'constraints' || field === 'triggers' ? [row.relation, row[key]] : field === 'columns' ? [row.table_name, row.column_name] : row[key])));
    }
    console.log(JSON.stringify(catalog));
  } else {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const operations = JSON.parse(input);
    const results = [];
    for (const operation of operations) {
      try {
        if (operation.kind === 'snapshot') {
          if (operation.transaction) await db.exec("BEGIN; SET LOCAL search_path=public; SET LOCAL lock_timeout='30s'; SET LOCAL statement_timeout='300s'; LOCK TABLE schema_migrations IN SHARE MODE");
          results.push({ ok: true, snapshotJson: await snapshotText() });
          if (operation.transaction) await db.exec('ROLLBACK');
        }
        else if (operation.kind === 'migration' || operation.kind === 'control') {
          const beforeJson = await snapshotText();
          const built = spawnSync(process.env.USAGE_048_TEST_PYTHON, ['-B', resolve(root, 'ops/release/test_usage_048.py'), '--sql-builder'], {
            input: JSON.stringify({ ...operation, beforeJson }), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
          });
          if (built.status !== 0) throw Error(built.stderr);
          results.push({ ok: true, values: await db.exec(built.stdout) });
        } else {
          results.push({ ok: true, values: await db.exec(operation.sql) });
        }
      } catch (error) {
        results.push({ ok: false, code: error.code, message: error.message, detail: error.detail });
        await db.exec('ROLLBACK');
      }
    }
    console.log(JSON.stringify(results));
  }
} finally { await db.close(); }
