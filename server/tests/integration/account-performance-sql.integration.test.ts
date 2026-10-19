import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { createAccountsRouter } from "../../src/routes/accounts";
import { resolveOaUser } from "../../src/oa-identity";
import { withTransaction } from "../../src/db-transaction";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;

sqlTest("account lists skip N current-period transactions and reset only stale accounts once", async () => {
  const fixture = await createIsolatedPostgres();
  const admin = randomUUID();
  await fixture.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,'list-admin','List admin','super_admin')", [admin]);
  await fixture.db.query("INSERT INTO users(username,display_name,monthly_credit_limit,credit_balance,credit_limit) SELECT 'list-'||n,'User '||n,100,30,100 FROM generate_series(1,100) n");
  const app = express();
  app.use((request, _response, next) => { Object.assign(request, { auth: { id: admin, role: "super_admin", departmentId: null } }); next(); });
  app.use("/accounts", createAccountsRouter(fixture.db));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
  const list = () => fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/accounts`);
  try {
    fixture.statements.length = 0;
    expect((await list()).status).toBe(200);
    expect(fixture.statements).toHaveLength(2);
    expect(fixture.statements.some(sql => sql === "BEGIN")).toBe(false);
    await fixture.db.query("UPDATE users SET credit_period_start=(date_trunc('month',timezone('Asia/Shanghai',now()))-interval '1 month')::date WHERE username IN ('list-1','list-2')");
    fixture.statements.length = 0;
    const response = await list();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.users.find((user: { username: string }) => user.username === "list-1").creditBalance).toBe(100);
    expect(fixture.statements.filter(sql => sql === "BEGIN")).toHaveLength(2);
    expect(fixture.statements.filter(sql => sql.includes("LEFT JOIN departments") && sql.includes("ORDER BY u.created_at"))).toHaveLength(2);
    fixture.statements.length = 0;
    expect((await list()).status).toBe(200);
    expect(fixture.statements).toHaveLength(2);
    expect((await fixture.db.query("SELECT count(*)::int AS count FROM credit_ledger WHERE entry_type='monthly_reset'")).rows[0].count).toBe(2);
  } finally {
    await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
    await fixture.close();
  }
}, 60_000);

sqlTest("an OA tombstone remains mapped and cannot create a replacement account", async () => {
  const fixture = await createIsolatedPostgres();
  const id = randomUUID();
  try {
    await fixture.db.query("INSERT INTO users(id,username,display_name,role,deleted_at) VALUES($1,'deleted-oa','Deleted OA','designer',now())", [id]);
    await fixture.db.query("INSERT INTO external_identities(user_id,provider,subject) VALUES($1,'oa','employee-deleted')", [id]);
    await expect(withTransaction(fixture.db, client => resolveOaUser(client, { id: "employee-deleted", name: "New name" }))).rejects.toMatchObject({ code: "OA_ACCOUNT_FORBIDDEN" });
    expect((await fixture.db.query("SELECT count(*)::int AS count FROM users")).rows[0].count).toBe(1);
    expect((await fixture.db.query("SELECT user_id FROM external_identities WHERE provider='oa'")).rows[0].user_id).toBe(id);
  } finally { await fixture.close(); }
}, 60_000);
