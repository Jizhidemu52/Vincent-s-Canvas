import { expect, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "../../src/db";
import { createAccountsRouter } from "../../src/routes/accounts";

// Uses a disposable PostgreSQL/WASM database, never DATABASE_URL or application data.
const runtime = process.env.PGLITE_RUNTIME_PATH;
const sqlTest = runtime ? test : test.skip;

sqlTest("account credit HTTP routes persist exact balances, idempotency and atomic audit in real PostgreSQL SQL", async () => {
  const requireRuntime = createRequire(resolve(runtime!, "package.json"));
  const { PGlite } = requireRuntime("@electric-sql/pglite");
  const { pgcrypto } = requireRuntime("@electric-sql/pglite/contrib/pgcrypto");
  const { citext } = requireRuntime("@electric-sql/pglite/contrib/citext");
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "canvas-account-credits-"));
  const databasePath = join(fixtureDirectory, "pgdata");
  const options = { extensions: { pgcrypto, citext } };
  let database = new PGlite(databasePath, options);
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  const adminId = "81000000-0000-4000-8000-000000000001";
  const secondAdminId = "81000000-0000-4000-8000-000000000002";
  const designerId = "81000000-0000-4000-8000-000000000003";
  const secondDesignerId = "81000000-0000-4000-8000-000000000004";
  const departmentId = "81000000-0000-4000-8000-000000000005";
  const departmentAdminId = "81000000-0000-4000-8000-000000000006";
  const query = async (sql: string, values: unknown[] = []) => {
    const result = await database.query(sql, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  try {
    await database.waitReady;
    const migrationDirectory = fileURLToPath(new URL("../../src/migrations/", import.meta.url));
    for (const name of (await readdir(migrationDirectory)).filter(name => name.endsWith(".sql")).sort()) {
      await database.exec(await readFile(join(migrationDirectory, name), "utf8"));
    }
    await query("INSERT INTO departments(id,name,code) VALUES($1,'Credits fixture','credits-fixture')", [departmentId]);
    for (const [id, username, role, department] of [
      [adminId, "credits-admin", "super_admin", null], [secondAdminId, "credits-admin-2", "super_admin", null],
      [designerId, "credits-designer", "designer", departmentId], [secondDesignerId, "credits-other", "designer", null],
      [departmentAdminId, "credits-department-admin", "department_admin", departmentId],
    ]) {
      await query("INSERT INTO users(id,username,display_name,role,department_id,must_change_password,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,$2::text,$2::text,$3,$4,false,80,100,100)", [id, username, role, department]);
    }
    const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Database;
    const app = express();
    app.use(express.json());
    app.use((request, response, next) => {
      // Test-fixture identities only; the production router remains behind its real session middleware.
      const actor = request.headers["x-fixture-actor"];
      if (!actor) { response.status(401).json({ error: "UNAUTHENTICATED" }); return; }
      Object.assign(request, { auth: { id: actor, role: actor === designerId ? "designer" : actor === departmentAdminId ? "department_admin" : "super_admin", departmentId: actor === departmentAdminId ? departmentId : null } });
      next();
    });
    app.use("/api/admin/accounts", createAccountsRouter(db));
    app.use(((error, _request, response, _next) => response.status(error.name === "ZodError" ? 400 : 500).json({ error: error.code, message: error.message })) as ErrorRequestHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(done => server!.once("listening", done));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const change = (method: "PUT" | "POST", body: unknown, userId = designerId, actor: string | null = adminId) => fetch(`${base}/api/admin/accounts/${userId}/credits`, {
      method, headers: { "content-type": "application/json", ...(actor ? { "x-fixture-actor": actor } : {}) }, body: JSON.stringify(body),
    });
    const patch = (body: unknown, userId = designerId, actor = adminId) => fetch(`${base}/api/admin/accounts/${userId}`, {
      method: "PATCH", headers: { "content-type": "application/json", "x-fixture-actor": actor }, body: JSON.stringify(body),
    });
    const state = async () => (await query("SELECT credit_balance,credit_limit,monthly_credit_limit,temporary_credit_adjustment FROM users WHERE id=$1", [designerId])).rows[0];
    const set = { requestId: "sql-set-balance", balance: 500, reason: "分配本月额度" };
    const assigned = await change("PUT", set);
    expect(assigned.status).toBe(200);
    expect((await assigned.json()).user).toMatchObject({ creditBalance: 500, monthlyCreditLimit: 100, temporaryCreditAdjustment: 420 });
    expect((await query("SELECT amount,balance_after,metadata FROM credit_ledger WHERE request_id=$1", [set.requestId])).rows).toEqual([{ amount: 420, balance_after: 500, metadata: { scope: "temporary", mode: "set", requestedValue: 500, balanceBefore: 80, periodStart: (await query("SELECT credit_period_start::text FROM users WHERE id=$1", [designerId])).rows[0].credit_period_start } }]);
    expect((await query("SELECT action,detail FROM audit_logs WHERE detail->>'requestId'=$1", [set.requestId])).rows).toEqual([{ action: "account.credits_set", detail: { requestId: set.requestId, mode: "set", amount: 420, reason: set.reason, balanceBefore: 80, balance: 500 } }]);
    expect((await change("POST", { requestId: "sql-add-credits", amount: 50, reason: "额外项目积分" })).status).toBe(200);
    expect((await change("POST", { requestId: "sql-subtract-credits", amount: -30, reason: "撤回部分额度" })).status).toBe(200);
    expect(await state()).toEqual({ credit_balance: 520, credit_limit: 550, monthly_credit_limit: 100, temporary_credit_adjustment: 440 });
    const retried = await change("PUT", set);
    expect(retried.status).toBe(200);
    expect((await retried.json()).user.creditBalance).toBe(520);
    expect((await query("SELECT id FROM audit_logs WHERE detail->>'requestId'=$1", [set.requestId])).rows).toHaveLength(1);
    for (const [body, userId, actor] of [[{ ...set, balance: 501 }, designerId, adminId], [set, secondDesignerId, adminId], [set, designerId, secondAdminId], [{ ...set, reason: "另一个原因" }, designerId, adminId]] as const) {
      const conflicting = await change("PUT", body, userId, actor);
      expect(conflicting.status).toBe(409);
      expect(await conflicting.json()).toEqual({ error: "CREDIT_REQUEST_CONFLICT", message: "该请求编号已用于其他积分操作，请刷新后重试" });
    }
    expect((await change("POST", { requestId: set.requestId, amount: 500, reason: set.reason })).status).toBe(409);
    for (const balance of [-1, 1.5, 2_147_483_648]) expect((await change("PUT", { ...set, requestId: "sql-invalid-balance", balance })).status).toBe(400);
    expect((await change("POST", { requestId: "sql-overdraw", amount: -521, reason: "超额扣减测试" })).status).toBe(400);
    expect((await change("PUT", set, designerId, null)).status).toBe(401);
    expect((await change("PUT", set, designerId, designerId)).status).toBe(403);
    expect((await change("PUT", set, adminId)).status).toBe(403);
    expect((await change("PUT", set, secondAdminId)).status).toBe(403);
    expect((await change("PUT", set, secondDesignerId, departmentAdminId)).status).toBe(403);
    expect((await change("PUT", { ...set, requestId: "sql-dept-permitted", balance: 520 }, designerId, departmentAdminId)).status).toBe(200);
    expect(await state()).toEqual({ credit_balance: 520, credit_limit: 550, monthly_credit_limit: 100, temporary_credit_adjustment: 440 });
    expect((await patch({ monthlyCreditLimit: 200 }, secondDesignerId, departmentAdminId)).status).toBe(403);
    expect((await patch({ monthlyCreditLimit: 200 }, designerId, designerId)).status).toBe(403);
    expect((await patch({ monthlyCreditLimit: 200 }, adminId)).status).toBe(403);
    expect((await patch({ role: "department_admin" }, designerId, departmentAdminId)).status).toBe(403);
    expect((await patch({ departmentId: null }, designerId, departmentAdminId)).status).toBe(403);
    expect((await patch({ monthlyCreditLimit: 100 }, designerId, departmentAdminId)).status).toBe(200);
    expect(await state()).toEqual({ credit_balance: 520, credit_limit: 550, monthly_credit_limit: 100, temporary_credit_adjustment: 440 });
    // Failure at the final audit write must roll back BOTH the ledger and balance.
    await database.exec("CREATE FUNCTION reject_fixture_credit_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.detail->>'requestId'='sql-audit-failure' THEN RAISE EXCEPTION 'Fixture audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_fixture_credit_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_fixture_credit_audit();");
    expect((await change("PUT", { ...set, requestId: "sql-audit-failure", balance: 999 })).status).toBe(500);
    expect((await state()).credit_balance).toBe(520);
    expect((await query("SELECT id FROM credit_ledger WHERE request_id='sql-audit-failure'")).rows).toEqual([]);
    await database.close();
    database = new PGlite(databasePath, options);
    await database.waitReady;
    expect((await state()).credit_balance).toBe(520);
    expect((await change("PUT", set)).status).toBe(200);
    expect((await state()).credit_balance).toBe(520);
    // Crossing into a new natural month resets first, then adjusts that month's balance.
    await query("UPDATE users SET credit_period_start=(date_trunc('month', timezone('Asia/Shanghai',now()))-interval '1 month')::date WHERE id=$1", [designerId]);
    expect((await change("PUT", { ...set, requestId: "sql-new-month-set", balance: 40 })).status).toBe(200);
    expect(await state()).toEqual({ credit_balance: 40, credit_limit: 100, monthly_credit_limit: 100, temporary_credit_adjustment: -60 });
    expect((await query("SELECT id FROM credit_ledger WHERE user_id=$1 AND entry_type='monthly_reset'", [designerId])).rows).toHaveLength(1);
    // A previous-month absolute request must never reapply its value after rollover.
    expect((await change("PUT", set)).status).toBe(200);
    expect((await state()).credit_balance).toBe(40);
    expect((await query("SELECT id FROM credit_ledger WHERE request_id=$1", [set.requestId])).rows).toHaveLength(1);
    expect((await change("PUT", { ...set, requestId: "sql-zero-balance", balance: 0 })).status).toBe(200);
    expect((await state()).credit_balance).toBe(0);
    const list = (actor = adminId) => fetch(`${base}/api/admin/accounts`, { headers: { "x-fixture-actor": actor } });
    // Administrator adjustments (including setting zero) are not consumption.
    expect((await (await list()).json()).totalUsedCredits).toBe(0);
    const group = await query("INSERT INTO designer_groups(department_id,name,code) VALUES($1,'Usage fixture','usage-fixture') RETURNING id", [departmentId]);
    for (const [requestId, userId, status, credits, groupCredits] of [
      ["usage-personal", designerId, "captured", 15, 0],
      ["usage-shared", designerId, "captured", 10, 8],
      ["usage-other-department", secondDesignerId, "captured", 17, 0],
      ["usage-department-admin", departmentAdminId, "captured", 19, 0],
      ["usage-super-admin", adminId, "captured", 21, 0],
      ["usage-held", designerId, "held", 23, 0],
      ["usage-released", designerId, "released", 29, 0],
    ] as const) {
      await query(`INSERT INTO credit_reservations(request_id,user_id,operation_type,quantity,credits,personal_credits,group_credits,group_id,group_period_start,rmb_cost,price_snapshot,status)
        VALUES($1,$2,'image_generation',1,$3,$4,$5,$6,CASE WHEN $5>0 THEN date_trunc('month',timezone('Asia/Shanghai',now()))::date END,0,'{}'::jsonb,$7)`,
        [requestId, userId, credits, credits - groupCredits, groupCredits, groupCredits ? group.rows[0].id : null, status]);
    }
    expect((await (await list()).json()).totalUsedCredits).toBe(82);
    const departmentUsage = await (await list(departmentAdminId)).json();
    expect(departmentUsage.totalUsedCredits).toBe(25);
    expect(departmentUsage.users.map((user: { id: string }) => user.id)).toEqual([designerId]);
  } finally {
    if (server) await new Promise<void>(done => { server!.close(() => done()); server!.closeAllConnections(); });
    await database.close();
    if (dirname(resolve(fixtureDirectory)) !== resolve(tmpdir())) throw new Error("Refusing fixture cleanup outside the temporary directory");
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}, 60_000);
