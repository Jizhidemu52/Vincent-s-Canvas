import { expect, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCreditPolicy, getCreditsEnabled } from "../../src/credit-policy";
import { settleReservation } from "../../src/billing";
import type { Cache, Database } from "../../src/db";
import { createCreditPolicyRouter } from "../../src/routes/credit-policy";
import { createBillingRouter } from "../../src/routes/billing";
import { createTasksRouter } from "../../src/routes/tasks";

const runtime = process.env.PGLITE_RUNTIME_PATH;
const sqlTest = runtime ? test : test.skip;

sqlTest("credit policy is authorized, durable and read on every new task without changing existing holds", async () => {
  const requireRuntime = createRequire(resolve(runtime!, "package.json"));
  const { PGlite } = requireRuntime("@electric-sql/pglite");
  const { pgcrypto } = requireRuntime("@electric-sql/pglite/contrib/pgcrypto");
  const { citext } = requireRuntime("@electric-sql/pglite/contrib/citext");
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "canvas-credit-policy-"));
  const databasePath = join(fixtureDirectory, "pgdata");
  const options = { extensions: { pgcrypto, citext } };
  let database = new PGlite(databasePath, options);
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  const adminId = "82000000-0000-4000-8000-000000000001";
  const designerId = "82000000-0000-4000-8000-000000000002";
  const departmentId = "82000000-0000-4000-8000-000000000003";
  const departmentAdminId = "82000000-0000-4000-8000-000000000004";
  const providerId = "82000000-0000-4000-8000-000000000005";
  const modelId = "82000000-0000-4000-8000-000000000006";
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
    await query("INSERT INTO departments(id,name,code) VALUES($1,'Policy fixture','policy-fixture')", [departmentId]);
    for (const [id, username, role, department] of [[adminId, "policy-admin", "super_admin", null], [designerId, "policy-designer", "designer", null], [departmentAdminId, "policy-dept-admin", "department_admin", departmentId]]) {
      await query("INSERT INTO users(id,username,display_name,role,department_id,must_change_password,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,$2::text,$2::text,$3,$4,false,1000,1000,1000)", [id, username, role, department]);
    }
    await query("INSERT INTO providers(id,name,protocol,base_url,enabled) VALUES($1,'No-network fixture','custom','https://no-network.invalid',true)", [providerId]);
    await query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost,enabled) VALUES($1,$2,'Fixture image','fixture-image',ARRAY['generate'],4,0,true)", [modelId, providerId]);
    await query("INSERT INTO tool_api_configurations(tool_key,model_config_id,enabled,credit_cost_override,rmb_cost_override) VALUES('image',$1,true,13,0) ON CONFLICT(tool_key) DO UPDATE SET model_config_id=EXCLUDED.model_config_id,enabled=true,credit_cost_override=13,rmb_cost_override=0", [modelId]);
    await query("UPDATE module_flags SET enabled=true WHERE module_key='image'");
    const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Database;
    const queued: string[] = [];
    // There is no worker and no network provider. Observe committed queue delivery only.
    const cache = { zAdd: async (_key: string, item: { value: string }) => { queued.push(item.value); return 1; } } as unknown as Cache;
    const app = express();
    app.use(express.json());
    app.use((request, response, next) => {
      const actor = request.headers["x-fixture-actor"];
      if (!actor) { response.status(401).json({ error: "UNAUTHENTICATED" }); return; }
      Object.assign(request, { auth: { id: actor, role: actor === designerId ? "designer" : actor === departmentAdminId ? "department_admin" : "super_admin", departmentId: actor === departmentAdminId ? departmentId : null } });
      next();
    });
    app.use("/api/admin/credit-policy", createCreditPolicyRouter(db, { authenticationEnabled: true }));
    app.use("/fixture-without-login", createCreditPolicyRouter(db, { authenticationEnabled: false }));
    app.use("/api/tasks", createTasksRouter(db, cache, () => getCreditsEnabled(db)));
    app.use("/api/billing", createBillingRouter(db, () => getCreditsEnabled(db)));
    app.use(((error, _request, response, _next) => response.status(error.status ?? (error.name === "ZodError" ? 400 : 500)).json({ error: error.code, message: error.message })) as ErrorRequestHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(done => server!.once("listening", done));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const request = (path: string, method = "GET", body?: unknown, actor: string | null = adminId) => fetch(base + path, { method, headers: { "content-type": "application/json", ...(actor ? { "x-fixture-actor": actor } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const policy = "/api/admin/credit-policy";
    const setPolicy = (creditsEnabled: boolean) => request(policy, "PATCH", { creditsEnabled });
    const balance = async () => (await query("SELECT credit_balance FROM users WHERE id=$1", [designerId])).rows[0].credit_balance;
    const taskBody = (requestId: string) => ({ requestId, projectId: "policy-fixture", operationType: "image_generation", toolKey: "image", modelConfigId: modelId, prompt: "database-only fixture", sourceUrls: [] });
    const submit = (requestId: string) => request("/api/tasks", "POST", taskBody(requestId), designerId);
    expect(await getCreditPolicy(db)).toEqual({ creditsEnabled: false, updatedAt: null });
    const initial = await request(policy);
    expect(initial.status).toBe(200);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(await initial.json()).toEqual({ creditsEnabled: false, updatedAt: null });
    expect((await request(policy, "GET", undefined, departmentAdminId)).status).toBe(200);
    expect((await request(policy, "PATCH", { creditsEnabled: true }, departmentAdminId)).status).toBe(403);
    expect((await request(policy, "GET", undefined, designerId)).status).toBe(403);
    expect((await request(policy, "PATCH", { creditsEnabled: true }, designerId)).status).toBe(403);
    expect((await request(policy, "PATCH", { creditsEnabled: true }, null)).status).toBe(401);
    expect((await request("/fixture-without-login", "PATCH", { creditsEnabled: true })).status).toBe(409);
    expect((await request(policy, "PATCH", { creditsEnabled: "true" })).status).toBe(400);
    expect((await query("SELECT * FROM credit_policy")).rows).toEqual([]);
    const free = await submit("policy-free-task");
    expect(free.status).toBe(201);
    expect((await free.json()).task.credits).toBe(0);
    expect(await balance()).toBe(1000);
    expect((await setPolicy(true)).status).toBe(200);
    expect(await getCreditsEnabled(db)).toBe(true);
    await database.close();
    database = new PGlite(databasePath, options);
    await database.waitReady;
    expect(await getCreditsEnabled(db)).toBe(true);
    const charged = await submit("policy-charged-task");
    expect(charged.status).toBe(201);
    expect((await charged.json()).task.credits).toBe(13);
    expect(await balance()).toBe(987);
    expect((await setPolicy(false)).status).toBe(200);
    const unbilled = await submit("policy-free-after-off");
    expect(unbilled.status).toBe(201);
    expect((await unbilled.json()).task.credits).toBe(0);
    expect(await balance()).toBe(987);
    const duplicate = await submit("policy-charged-task");
    expect(duplicate.status).toBe(201);
    expect((await duplicate.json()).task.credits).toBe(13);
    expect(await balance()).toBe(987);
    expect((await query("SELECT credits FROM credit_reservations WHERE request_id='policy-charged-task'")).rows).toEqual([{ credits: 13 }]);
    // Turning billing off must not erase the original hold or prevent a failure refund.
    await settleReservation(db, "policy-charged-task", "release");
    expect(await balance()).toBe(1000);
    await settleReservation(db, "policy-free-task", "release");
    expect(await balance()).toBe(1000);
    await database.close();
    database = new PGlite(databasePath, options);
    await database.waitReady;
    expect(await getCreditsEnabled(db, true)).toBe(false);
    expect((await query("SELECT detail FROM audit_logs WHERE action='credits.policy_changed' ORDER BY id")).rows).toEqual([{ detail: { creditsEnabled: true } }, { detail: { creditsEnabled: false } }]);
    await database.exec("CREATE FUNCTION reject_fixture_policy_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='credits.policy_changed' THEN RAISE EXCEPTION 'Fixture audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_fixture_policy_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_fixture_policy_audit();");
    expect((await setPolicy(true)).status).toBe(500);
    expect(await getCreditsEnabled(db)).toBe(false);
    expect((await query("SELECT id FROM audit_logs WHERE action='credits.policy_changed'")).rows).toHaveLength(2);
    expect(new Set(queued).size).toBe(3);
    const reservedInput = { requestId: "reservation-owner-private", operationType: "image_generation", modelConfigId: modelId, quantity: 1 };
    const reserve = (body = reservedInput, actor = designerId) => request("/api/billing/reservations", "POST", body, actor);
    const reserved = await reserve();
    expect(reserved.status).toBe(201);
    expect((await reserved.json()).duplicate).toBe(false);
    const foreign = await reserve(reservedInput, adminId);
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toEqual({ error: "DUPLICATE_REQUEST", message: "请求编号已被其他账号占用" });
    for (const changed of [{ quantity: 2 }, { operationType: "inpaint" }, { modelConfigId: "82000000-0000-4000-8000-000000000099" }]) {
      const mismatched = await reserve({ ...reservedInput, ...changed });
      expect(mismatched.status).toBe(400);
      expect(await mismatched.json()).toEqual({ error: "DUPLICATE_REQUEST", message: "请求编号已用于不同的积分冻结操作" });
    }
    // A task cannot adopt a direct reservation, even for its owner: tool identity differs.
    const adopted = await submit(reservedInput.requestId);
    expect(adopted.status).toBe(400);
    expect((await adopted.json()).error).toBe("DUPLICATE_REQUEST");
    expect((await query("SELECT id FROM tasks WHERE request_id=$1", [reservedInput.requestId])).rows).toEqual([]);
    // A new user's task with the same reservation ID must roll back, not inherit a hold.
    const foreignTask = await request("/api/tasks", "POST", taskBody(reservedInput.requestId), adminId);
    expect(foreignTask.status).toBe(400);
    expect(await foreignTask.json()).toEqual({ error: "DUPLICATE_REQUEST", message: "请求编号已被其他账号占用" });
    expect((await query("SELECT id FROM tasks WHERE request_id=$1", [reservedInput.requestId])).rows).toEqual([]);
    // Same owner and operation continue returning the original snapshot after price changes.
    await query("UPDATE model_configs SET credit_cost=99 WHERE id=$1", [modelId]);
    const repeated = await reserve();
    expect(repeated.status).toBe(201);
    const repeatedBody = await repeated.json();
    expect(repeatedBody).toMatchObject({ duplicate: true, credits: 0, snapshot: { modelCredits: 4 } });
    expect(repeatedBody).not.toHaveProperty("user_id");
    expect((await query("SELECT id FROM credit_reservations WHERE request_id=$1", [reservedInput.requestId])).rows).toHaveLength(1);
    expect(await balance()).toBe(1000);
  } finally {
    if (server) await new Promise<void>(done => { server!.close(() => done()); server!.closeAllConnections(); });
    await database.close();
    if (dirname(resolve(fixtureDirectory)) !== resolve(tmpdir())) throw new Error("Refusing fixture cleanup outside the temporary directory");
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}, 60_000);
