import { expect, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reserveCredits, settleReservation } from "../../src/billing";
import type { Database } from "../../src/db";
import { createAccountsRouter } from "../../src/routes/accounts";

const runtime = process.env.PGLITE_RUNTIME_PATH;
const sqlTest = runtime ? test : test.skip;

async function fixture() {
  const requireRuntime = createRequire(resolve(runtime!, "package.json"));
  const { PGlite } = requireRuntime("@electric-sql/pglite");
  const { pgcrypto } = requireRuntime("@electric-sql/pglite/contrib/pgcrypto");
  const { citext } = requireRuntime("@electric-sql/pglite/contrib/citext");
  // Isolated in-memory PostgreSQL/WASM, never the application database or provider.
  const database = new PGlite({ extensions: { pgcrypto, citext } });
  await database.waitReady;
  const migrations = fileURLToPath(new URL("../../src/migrations/", import.meta.url));
  for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
    await database.exec(await readFile(join(migrations, name), "utf8"));
  }
  const adminId = "83000000-0000-4000-8000-000000000001";
  const designerId = "83000000-0000-4000-8000-000000000002";
  const query = async (sql: string, values: unknown[] = []) => {
    const result = await database.query(sql, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  await query("INSERT INTO users(id,username,display_name,role,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,'boundary-admin','Boundary admin','super_admin',0,0,0),($2,'boundary-designer','Boundary designer','designer',80,100,100)", [adminId, designerId]);
  const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Database;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    Object.assign(request, { auth: { id: adminId, role: "super_admin", departmentId: null } });
    next();
  });
  app.use("/accounts", createAccountsRouter(db));
  app.use(((error, _request, response, _next) => response.status(error.name === "ZodError" ? 400 : 500).json({ error: error.code, message: error.message })) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/accounts`;
  const request = (path: string, method: string, body?: unknown) => fetch(base + path, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const state = async () => (await query("SELECT credit_balance,credit_limit,monthly_credit_limit,temporary_credit_adjustment,credit_period_start::text FROM users WHERE id=$1", [designerId])).rows[0];
  return {
    db, query, adminId, designerId, request, state,
    patch: (body: unknown) => request(`/${designerId}`, "PATCH", body),
    set: (balance: number, requestId: string) => request(`/${designerId}/credits`, "PUT", { balance, requestId, reason: "余额边界验证" }),
    reserve: (requestId: string) => reserveCredits(db, { requestId, userId: designerId, operationType: "image_generation", quantity: 1 }),
    close: async () => {
      await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
      await database.close();
    },
  };
}

sqlTest("monthly allowance edits refresh the current period with the previous allowance first", async () => {
  const data = await fixture();
  try {
    await data.query("UPDATE users SET credit_period_start=(date_trunc('month',timezone('Asia/Shanghai',now()))-interval '1 month')::date,temporary_credit_adjustment=40 WHERE id=$1", [data.designerId]);
    const updated = await data.patch({ monthlyCreditLimit: 200 });
    expect(updated.status).toBe(200);
    expect((await updated.json()).user).toMatchObject({ creditBalance: 100, creditLimit: 100, monthlyCreditLimit: 200, temporaryCreditAdjustment: 0 });
    expect((await data.query("SELECT amount,balance_after,metadata->>'monthlyCreditLimit' AS allowance FROM credit_ledger WHERE user_id=$1 AND entry_type='monthly_reset'", [data.designerId])).rows).toEqual([{ amount: 20, balance_after: 100, allowance: "100" }]);
    // A later same-month rule edit must not refill or erase the usable balance.
    expect((await data.set(35, "boundary-current-balance")).status).toBe(200);
    expect((await data.patch({ monthlyCreditLimit: 0 })).status).toBe(200);
    expect(await data.state()).toMatchObject({ credit_balance: 35, monthly_credit_limit: 0, temporary_credit_adjustment: -65 });
    const listing = await data.request("", "GET");
    expect(listing.status).toBe(200);
    expect((await listing.json()).users.find((user: { id: string }) => user.id === data.designerId).creditBalance).toBe(35);
  } finally { await data.close(); }
}, 60_000);

sqlTest("account creation, monthly edits and period rollover roll back when their audit cannot be saved", async () => {
  const data = await fixture();
  try {
    await data.query("UPDATE users SET credit_period_start=(date_trunc('month',timezone('Asia/Shanghai',now()))-interval '1 month')::date WHERE id=$1", [data.designerId]);
    const before = await data.state();
    await data.query("CREATE FUNCTION reject_boundary_account_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('account.created','account.monthly_credit_updated') THEN RAISE EXCEPTION 'Fixture audit unavailable'; END IF; RETURN NEW; END $$");
    await data.query("CREATE TRIGGER reject_boundary_account_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_boundary_account_audit()");
    expect((await data.patch({ monthlyCreditLimit: 200, displayName: "Must roll back" })).status).toBe(500);
    expect(await data.state()).toEqual(before);
    expect((await data.query("SELECT display_name FROM users WHERE id=$1", [data.designerId])).rows[0].display_name).toBe("Boundary designer");
    expect((await data.query("SELECT id FROM credit_ledger WHERE user_id=$1", [data.designerId])).rows).toEqual([]);
    expect((await data.request("", "POST", { username: "creation-audit-failure", displayName: "Must roll back", password: "BoundaryPassword123", creditBalance: 30, creditLimit: 100 })).status).toBe(500);
    expect((await data.query("SELECT id FROM users WHERE username='creation-audit-failure'")).rows).toEqual([]);
    expect((await data.query("SELECT id FROM credit_ledger")).rows).toEqual([]);
  } finally { await data.close(); }
}, 60_000);

sqlTest("administrative balances leave room for all same-month frozen-credit refunds", async () => {
  const data = await fixture();
  try {
    await data.reserve("boundary-held-one");
    await data.reserve("boundary-held-two");
    expect((await data.state()).credit_balance).toBe(64);
    expect((await data.set(2_147_483_639, "boundary-two-holds-overflow")).status).toBe(400);
    expect((await data.set(500, "boundary-normal-set")).status).toBe(200);
    await settleReservation(data.db, "boundary-held-one", "release");
    expect((await data.state()).credit_balance).toBe(508);
    // Captured or expired reservations cannot refund into this period.
    await data.reserve("boundary-captured");
    await settleReservation(data.db, "boundary-captured", "capture");
    await data.query("INSERT INTO credit_reservations(request_id,user_id,operation_type,quantity,credits,personal_credits,rmb_cost,price_snapshot,credit_period_start) VALUES('boundary-expired',$1,'image_generation',1,10,10,0,'{}'::jsonb,(date_trunc('month',timezone('Asia/Shanghai',now()))-interval '1 month')::date)", [data.designerId]);
    const overflowing = await data.set(2_147_483_647, "boundary-overflow-set");
    expect(overflowing.status).toBe(400);
    expect((await overflowing.json()).error).toBe("INVALID_CREDIT");
    expect((await data.state()).credit_balance).toBe(500);
    expect((await data.query("SELECT id FROM credit_ledger WHERE request_id='boundary-overflow-set'")).rows).toEqual([]);
    expect((await data.set(2_147_483_639, "boundary-safe-max-set")).status).toBe(200);
    expect((await data.request(`/${data.designerId}/credits`, "POST", { requestId: "boundary-add-overflow", amount: 1, reason: "冻结退款容量验证" })).status).toBe(400);
    await settleReservation(data.db, "boundary-held-two", "release");
    expect((await data.state()).credit_balance).toBe(2_147_483_647);
    await settleReservation(data.db, "boundary-expired", "release");
    expect((await data.state()).credit_balance).toBe(2_147_483_647);
    expect(await settleReservation(data.db, "boundary-held-two", "release")).toMatchObject({ duplicate: true });
  } finally { await data.close(); }
}, 60_000);

sqlTest("individual and bulk account creation preserve an explicitly disabled status", async () => {
  const data = await fixture();
  try {
    const account = { username: "disabled-individual", displayName: "Disabled individual", password: "BoundaryPassword123", status: "disabled", creditBalance: 30, creditLimit: 100, monthlyCreditLimit: 100 };
    const created = await data.request("", "POST", account);
    expect(created.status).toBe(201);
    expect((await created.json()).user).toMatchObject({ status: "disabled", creditBalance: 30 });
    const bulk = await data.request("/bulk", "POST", { accounts: [{ ...account, username: "disabled-bulk" }] });
    expect(bulk.status).toBe(201);
    expect(await bulk.json()).toEqual({ created: 1, failures: [] });
    expect((await data.query("SELECT status,credit_balance FROM users WHERE username IN ('disabled-individual','disabled-bulk') ORDER BY username")).rows).toEqual([{ status: "disabled", credit_balance: 30 }, { status: "disabled", credit_balance: 30 }]);
    const active = await data.request("", "POST", { ...account, username: "default-active", status: undefined });
    expect(active.status).toBe(201);
    expect((await active.json()).user.status).toBe("active");
  } finally { await data.close(); }
}, 60_000);

sqlTest("bulk imports roll back on audit failure while retaining mixed-success row results on retry", async () => {
  const data = await fixture();
  try {
    const account = { displayName: "Bulk audit fixture", password: "BoundaryPassword123", creditBalance: 30, creditLimit: 100 };
    const body = { accounts: [
      { ...account, username: "bulk-audit-first" },
      { ...account, username: "boundary-designer" },
      { ...account, username: "bulk-audit-second" },
      { ...account, username: "bulk-audit-weak", password: "short" },
    ] };
    await data.query("CREATE FUNCTION reject_bulk_fixture_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='account.bulk_created' THEN RAISE EXCEPTION 'Fixture bulk audit failure'; END IF; RETURN NEW; END $$");
    await data.query("CREATE TRIGGER reject_bulk_fixture_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_bulk_fixture_audit()");
    expect((await data.request("/bulk", "POST", body)).status).toBe(500);
    expect((await data.query("SELECT id FROM users WHERE username LIKE 'bulk-audit-%'")).rows).toEqual([]);
    expect((await data.query("SELECT id FROM credit_ledger")).rows).toEqual([]);
    expect((await data.query("SELECT id FROM audit_logs WHERE action='account.bulk_created'")).rows).toEqual([]);
    await data.query("DROP TRIGGER reject_bulk_fixture_audit ON audit_logs");
    await data.query("DROP FUNCTION reject_bulk_fixture_audit()");
    const recovered = await data.request("/bulk", "POST", body);
    expect(recovered.status).toBe(207);
    const result = await recovered.json();
    expect(result.created).toBe(2);
    expect(result.failures.map((failure: { index: number }) => failure.index)).toEqual([1, 3]);
    expect((await data.query("SELECT username,credit_balance FROM users WHERE username LIKE 'bulk-audit-%' ORDER BY username")).rows).toEqual([
      { username: "bulk-audit-first", credit_balance: 30 }, { username: "bulk-audit-second", credit_balance: 30 },
    ]);
    expect((await data.query("SELECT amount,balance_after FROM credit_ledger ORDER BY id")).rows).toEqual([{ amount: 30, balance_after: 30 }, { amount: 30, balance_after: 30 }]);
    expect((await data.query("SELECT result,detail FROM audit_logs WHERE action='account.bulk_created'")).rows).toEqual([{ result: "failed", detail: { created: 2, failed: 2 } }]);
  } finally { await data.close(); }
}, 60_000);

sqlTest("account credit fields reject values outside PostgreSQL integer range before writing", async () => {
  const data = await fixture();
  try {
    for (const field of ["creditLimit", "monthlyCreditLimit"]) {
      expect((await data.patch({ [field]: 2_147_483_648 })).status).toBe(400);
    }
    for (const field of ["creditBalance", "creditLimit", "monthlyCreditLimit"]) {
      const account = { username: `invalid-${field}`, displayName: "Invalid range", password: "BoundaryPassword123", creditBalance: 0, creditLimit: 100, [field]: 2_147_483_648 };
      expect((await data.request("", "POST", account)).status).toBe(400);
      expect((await data.request("/bulk", "POST", { accounts: [account] })).status).toBe(400);
    }
    expect(await data.state()).toMatchObject({ credit_balance: 80, credit_limit: 100, monthly_credit_limit: 100 });
  } finally { await data.close(); }
}, 60_000);
