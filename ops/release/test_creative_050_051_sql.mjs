// Disposable WASM PostgreSQL only. Never loads app config or DATABASE_URL.
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
const read = relative => readFile(resolve(root, relative), 'utf8');
try {
  await db.exec('SET search_path=public; CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await readdir(resolve(root, 'server/src/migrations'))).filter(n => n.endsWith('.sql') && n < '050_').sort()) {
    await db.exec(await read(`server/src/migrations/${name}`));
    await db.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
  }
  await db.exec(await read('ops/release/creative-050-051-test-fixture.sql'));
  const queries = await Promise.all(['database-state.sql', 'usage-048-state.sql', 'creative-050-051-state.sql'].map(async name => (await read(`ops/release/${name}`)).trim().replace(/;$/, '')));
  const query = `WITH b(snapshot) AS (${queries[0]}), e(snapshot) AS (${queries[1]}), c(snapshot) AS (${queries[2]}) SELECT b.snapshot||e.snapshot||c.snapshot||jsonb_build_object('constraints',(SELECT coalesce(jsonb_agg(v ORDER BY v->>'relation',v->>'name'),'[]'::jsonb) FROM jsonb_array_elements(b.snapshot->'constraints') v WHERE v->>'type'<>'n')) AS snapshot FROM b,e,c`;
  const snapshotText = async () => (await db.query(`SELECT snapshot::text AS raw FROM (${query}) s`)).rows[0].raw;
  if (process.argv[2] === 'catalog') {
    const before = JSON.parse(await snapshotText());
    for (const name of ['050_quick_image_item_extract.sql', '051_new_creative_scenes.sql']) await db.exec(await read(`server/src/migrations/${name}`));
    const after = JSON.parse(await snapshotText());
    const changed = before.constraints.flatMap(prior => {
      const current = after.constraints.find(row => row.relation === prior.relation && row.name === prior.name);
      return JSON.stringify(prior) === JSON.stringify(current) ? [] : [{ before: prior, after: current }];
    });
    console.log(JSON.stringify({ schema: 1, constraints: changed }));
  } else {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const results = [];
    for (const operation of JSON.parse(input)) {
      try {
        if (operation.kind === 'snapshot') results.push({ ok: true, snapshotJson: await snapshotText() });
        else if (operation.kind === 'migration') {
          const built = spawnSync(process.env.CREATIVE_051_TEST_PYTHON, ['-B', resolve(root, 'ops/release/test_creative_050_051.py'), '--sql-builder'], {
            input: JSON.stringify({ ...operation, beforeJson: await snapshotText() }), encoding: 'utf8', maxBuffer: 24 * 1024 * 1024,
          });
          if (built.status !== 0) throw Error(built.stderr);
          results.push({ ok: true, values: await db.exec(built.stdout) });
        } else results.push({ ok: true, values: await db.exec(operation.sql) });
      } catch (error) {
        results.push({ ok: false, code: error.code, message: error.message, detail: error.detail });
        await db.exec('ROLLBACK');
      }
    }
    console.log(JSON.stringify(results));
  }
} finally { await db.close(); }
