import { expect, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "../../src/db";
import { createAccountsRouter } from "../../src/routes/accounts";

const runtime = process.env.PGLITE_RUNTIME_PATH;
const sqlTest = runtime ? test : test.skip;

async function fixture(legacyDeletionConstraint: boolean) {
  const requireRuntime = createRequire(resolve(runtime!, "package.json"));
  const { PGlite } = requireRuntime("@electric-sql/pglite");
  const { pgcrypto } = requireRuntime("@electric-sql/pglite/contrib/pgcrypto");
  const { citext } = requireRuntime("@electric-sql/pglite/contrib/citext");
  // Isolated PostgreSQL/WASM only; never DATABASE_URL or application data.
  const database = new PGlite({ extensions: { pgcrypto, citext } });
  await database.waitReady;
  const migrations = fileURLToPath(new URL("../../src/migrations/", import.meta.url));
  for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
    await database.exec(await readFile(join(migrations, name), "utf8"));
  }
  if (legacyDeletionConstraint) {
    await database.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
      ALTER TABLE users ADD CONSTRAINT deleted_account_disabled CHECK
        (deleted_at IS NULL OR (status='disabled' AND password_hash IS NULL AND email IS NULL AND employee_no IS NULL));`);
  }
  const adminId = "84000000-0000-4000-8000-000000000001";
  const departmentAdminId = "84000000-0000-4000-8000-000000000002";
  const departmentId = "84000000-0000-4000-8000-000000000003";
  const disabledId = "84000000-0000-4000-8000-000000000004";
  const deletedId = "84000000-0000-4000-8000-000000000005";
  const query = async (sql: string, values: unknown[] = []) => {
    const result = await database.query(sql, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  await query("INSERT INTO departments(id,name,code) VALUES($1,'Compatibility fixture','deleted-compat-fixture')", [departmentId]);
  for (const [id, username, role, status, department] of [
    [adminId, "compat-admin", "super_admin", "active", null],
    [departmentAdminId, "compat-department-admin", "department_admin", "active", departmentId],
    [disabledId, "compat-disabled", "designer", "disabled", departmentId],
    ...(legacyDeletionConstraint ? [[deletedId, "compat-deleted", "designer", "disabled", departmentId]] : []),
  ]) {
    await query("INSERT INTO users(id,username,display_name,role,status,department_id,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,$2::text,$2::text,$3,$4,$5,80,100,100)", [id, username, role, status, department]);
  }
  if (legacyDeletionConstraint) {
    await query("UPDATE users SET deleted_at=now(),credit_period_start=(date_trunc('month',timezone('Asia/Shanghai',now()))-interval '1 month')::date WHERE id=$1", [deletedId]);
  }
  const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Database;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const departmentActor = request.headers["x-fixture-actor"] === "department";
    Object.assign(request, { auth: { id: departmentActor ? departmentAdminId : adminId, role: departmentActor ? "department_admin" : "super_admin", departmentId: departmentActor ? departmentId : null } });
    next();
  });
  app.use("/accounts", createAccountsRouter(db));
  app.use(((error, _request, response, _next) => response.status(error.name === "ZodError" ? 400 : 500).json({ error: error.code, message: error.message })) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/accounts`;
  return {
    query, adminId, departmentAdminId, disabledId, deletedId,
    request: (path: string, method: string, body?: unknown, actor = "super") => fetch(base + path, {
      method, headers: { "content-type": "application/json", "x-fixture-actor": actor }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    close: async () => {
      await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
      await database.close();
    },
  };
}

sqlTest("account lists hide legacy-deleted users without refreshing their credits or erasing historical usage", async () => {
  const data = await fixture(true);
  try {
    await data.query(`INSERT INTO credit_reservations(request_id,user_id,operation_type,quantity,credits,personal_credits,group_credits,rmb_cost,price_snapshot,status)
      VALUES('deleted-compat-usage',$1,'image_generation',1,7,7,0,0,'{}'::jsonb,'captured')`, [data.deletedId]);
    for (const actor of ["super", "department"]) {
      const response = await data.request("", "GET", undefined, actor);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.users.map((user: { id: string }) => user.id).sort()).toEqual(
        (actor === "super" ? [data.adminId, data.departmentAdminId, data.disabledId] : [data.disabledId]).sort(),
      );
      expect(body.totalUsedCredits).toBe(7);
    }
    expect((await data.query("SELECT credit_balance FROM users WHERE id=$1", [data.deletedId])).rows).toEqual([{ credit_balance: 80 }]);
    expect((await data.query("SELECT id FROM credit_ledger WHERE user_id=$1", [data.deletedId])).rows).toEqual([]);
  } finally { await data.close(); }
}, 60_000);

sqlTest("legacy-deleted targets reject account edits, password resets and both credit actions without writes", async () => {
  const data = await fixture(true);
  try {
    const before = (await data.query("SELECT to_jsonb(u) AS account FROM users u WHERE id=$1", [data.deletedId])).rows;
    const statuses: number[] = [];
    for (const [path, method, body] of [
      [`/${data.deletedId}`, "PATCH", { status: "active" }],
      [`/${data.deletedId}/reset-password`, "POST", { password: "CompatibilityPassword123" }],
      [`/${data.deletedId}/credits`, "POST", { requestId: "deleted-compat-add", amount: 10, reason: "Compatibility check" }],
      [`/${data.deletedId}/credits`, "PUT", { requestId: "deleted-compat-set", balance: 10, reason: "Compatibility check" }],
    ] as const) {
      const response = await data.request(path, method, body);
      statuses.push(response.status);
    }
    expect(statuses).toEqual([404, 404, 404, 404]);
    expect((await data.query("SELECT to_jsonb(u) AS account FROM users u WHERE id=$1", [data.deletedId])).rows).toEqual(before);
    expect((await data.query("SELECT id FROM credit_ledger")).rows).toEqual([]);
    expect((await data.query("SELECT id FROM audit_logs")).rows).toEqual([]);
  } finally { await data.close(); }
}, 60_000);

for (const legacyDeletionConstraint of [false, true]) {
  sqlTest(`ordinary disabled accounts remain visible and manageable ${legacyDeletionConstraint ? "with" : "without"} the legacy deletion constraint`, async () => {
    const data = await fixture(legacyDeletionConstraint);
    try {
      const listing = await data.request("", "GET");
      expect(listing.status).toBe(200);
      expect((await listing.json()).users.find((user: { id: string }) => user.id === data.disabledId).status).toBe("disabled");
      expect((await data.request(`/${data.disabledId}`, "PATCH", { displayName: "Updated disabled account" })).status).toBe(200);
      expect((await data.request(`/${data.disabledId}/reset-password`, "POST", { password: "CompatibilityPassword123" })).status).toBe(204);
      expect((await data.request(`/${data.disabledId}/credits`, "POST", { requestId: "disabled-compat-add", amount: 10, reason: "Compatibility check" })).status).toBe(200);
      expect((await data.request(`/${data.disabledId}/credits`, "PUT", { requestId: "disabled-compat-set", balance: 20, reason: "Compatibility check" })).status).toBe(200);
      expect((await data.query("SELECT display_name,status,credit_balance,password_hash IS NOT NULL AS has_password FROM users WHERE id=$1", [data.disabledId])).rows).toEqual([
        { display_name: "Updated disabled account", status: "disabled", credit_balance: 20, has_password: true },
      ]);
    } finally { await data.close(); }
  }, 60_000);
}
