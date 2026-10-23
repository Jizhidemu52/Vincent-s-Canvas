import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import { settleReservation } from "../../src/billing";
import type { Cache } from "../../src/db";
import { createTasksRouter } from "../../src/routes/tasks";
import { enqueueTask, queueScore, transitionTask, type TaskInput } from "../../src/tasks";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;

integration("SQL task admission and atomic cancellation", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let base: string;
  const modelId = randomUUID();
  const queueCalls: Array<{ keys: string[]; arguments: string[] }> = [];
  let failCache = false;
  const cache = {
    eval: async (_script: string, options: { keys: string[]; arguments: string[] }) => {
      if (failCache) throw new Error("Fixture cache unavailable");
      queueCalls.push(options); return 1;
    },
    zRem: async () => 1,
  } as unknown as Cache;
  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    const providerId = randomUUID();
    await fixture.db.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Task admission fixture','custom','https://no-network.invalid')", [providerId]);
    await fixture.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'Admission fixture','admission-fixture',ARRAY['generate'],0,0)", [modelId, providerId]);
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
      Object.assign(request, { auth: { id: request.get("x-fixture-user"), role: request.get("x-fixture-role") ?? "designer", departmentId: null } });
      next();
    });
    app.use("/tasks", createTasksRouter(fixture.db, cache, true, undefined, { maxInflightTasks: 2 }));
    app.use(((error, _request, response, _next) => response.status(error.name === "ZodError" ? 400 : 500).json({ error: error.code, message: error.message })) as ErrorRequestHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(done => server.once("listening", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/tasks`;
  }, 30_000);
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    await fixture?.close();
  });
  const row = async (sql: string, values: unknown[] = []) => (await fixture.db.query(sql, values)).rows[0];
  const balance = async (userId: string) => (await row("SELECT credit_balance FROM users WHERE id=$1", [userId])).credit_balance;
  async function user() {
    const userId = randomUUID();
    await fixture.db.query("INSERT INTO users(id,username,display_name,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,$2,'Admission fixture',100,100,100)", [userId, `quota-${userId}`]);
    return userId;
  }
  const input = (userId: string, patch: Partial<TaskInput> = {}): TaskInput => ({
    requestId: randomUUID(), userId, departmentId: null, projectId: "admission-fixture", operationType: "image_generation",
    toolKey: "image", modelConfigId: modelId, prompt: "Database-only admission check", sourceUrls: [], priority: "normal", ...patch,
  });
  const submit = (value: TaskInput) => enqueueTask(fixture.db, cache, value);
  const request = (userId: string, path: string, body: unknown, role = "designer") => fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json", "x-fixture-user": userId, "x-fixture-role": role }, body: JSON.stringify(body),
  });

  test("queued, processing and paused work share capacity while terminal work does not", async () => {
    const userId = await user();
    const first = await submit(input(userId, { maxInflightTasks: 2 }));
    const secondInput = input(userId, { maxInflightTasks: 2 });
    const second = await submit(secondInput);
    await fixture.db.query("UPDATE tasks SET status='processing' WHERE id=$1", [first.id]);
    await fixture.db.query("UPDATE tasks SET status='paused' WHERE id=$1", [second.id]);
    const rejected = input(userId, { maxInflightTasks: 2 });
    await expect(submit(rejected)).rejects.toMatchObject({ code: "USER_TASK_LIMIT_REACHED" });
    expect((await row("SELECT count(*)::int AS count FROM credit_reservations WHERE request_id=$1", [rejected.requestId])).count).toBe(0);
    expect((await row("SELECT count(*)::int AS count FROM tasks WHERE request_id=$1", [rejected.requestId])).count).toBe(0);
    await settleReservation(fixture.db, secondInput.requestId, "capture");
    await fixture.db.query("UPDATE tasks SET status='success' WHERE id=$1", [second.id]);
    expect((await submit(rejected)).status).toBe("waiting");
    expect(await balance(userId)).toBe(76);
    expect(fixture.statements.some(sql => sql.includes("pg_advisory_xact_lock(hashtext('user-inflight-quota')"))).toBe(true);
  });

  test("parallel requests are capped per actor and a duplicate consumes no extra slot or hold", async () => {
    // PGlite serializes whole transactions; true lock-contention coverage lives
    // in billing-concurrency.integration.test.ts against the CI PostgreSQL service.
    const userId = await user(); const other = await user();
    const first = input(userId, { maxInflightTasks: 1 });
    const competing = input(userId, { maxInflightTasks: 1 });
    const results = await Promise.allSettled([submit(first), submit(competing), submit(input(other, { maxInflightTasks: 1 }))]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect((results[1] as PromiseRejectedResult).reason.code).toBe("USER_TASK_LIMIT_REACHED");
    const repeated = await submit(first);
    expect(repeated.id).toBe((results[0] as PromiseFulfilledResult<any>).value.id);
    expect(await balance(userId)).toBe(92); expect(await balance(other)).toBe(92);
    expect((await row("SELECT count(*)::int AS count FROM credit_ledger WHERE reference_id=$1 AND entry_type='hold'", [first.requestId])).count).toBe(1);
  });

  test("idempotent queue delivery, pause and resume keep original FIFO time and delayed recovery respects availability", async () => {
    const userId = await user(); const value = input(userId); const task = await submit(value);
    const queuedAt = "2026-01-01T00:00:00.000Z";
    const availableAt = new Date(Date.now() + 60_000).toISOString();
    await fixture.db.query("UPDATE tasks SET queued_at=$2,available_at=$3 WHERE id=$1", [task.id, queuedAt, availableAt]);
    await submit(value);
    expect(Number(queueCalls.at(-1)!.arguments[3])).toBe(queueScore("normal", Date.parse(queuedAt)));
    expect(Number(queueCalls.at(-1)!.arguments[1])).toBe(Date.parse(availableAt));
    expect((await request(userId, `/${task.id}/recover`, {})).status).toBe(200);
    expect(Number(queueCalls.at(-1)!.arguments[1])).toBe(Date.parse(availableAt));
    await transitionTask(fixture.db, cache, task.id, "pause");
    await transitionTask(fixture.db, cache, task.id, "resume");
    expect(new Date((await row("SELECT queued_at FROM tasks WHERE id=$1", [task.id])).queued_at).toISOString()).toBe(queuedAt);
    expect(Number(queueCalls.at(-1)!.arguments[3])).toBe(queueScore("normal", Date.parse(queuedAt)));
  });

  test("a release SQL failure rolls task status, wallet and reservation back in one transaction", async () => {
    const userId = await user(); const value = input(userId); const task = await submit(value);
    await fixture.db.query("CREATE FUNCTION admission_release_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entry_type='release' THEN RAISE EXCEPTION 'Fixture release unavailable'; END IF; RETURN NEW; END $$");
    await fixture.db.query("CREATE TRIGGER admission_release_failure BEFORE INSERT ON credit_ledger FOR EACH ROW EXECUTE FUNCTION admission_release_failure()");
    try {
      await expect(transitionTask(fixture.db, cache, task.id, "cancel")).rejects.toThrow("Fixture release unavailable");
      expect((await row("SELECT status FROM tasks WHERE id=$1", [task.id])).status).toBe("waiting");
      expect((await row("SELECT status FROM credit_reservations WHERE request_id=$1", [value.requestId])).status).toBe("held");
      expect(await balance(userId)).toBe(92);
      expect((await row("SELECT count(*)::int AS count FROM credit_ledger WHERE reference_id=$1 AND entry_type='release'", [value.requestId])).count).toBe(0);
    } finally {
      await fixture.db.query("DROP TRIGGER admission_release_failure ON credit_ledger");
      await fixture.db.query("DROP FUNCTION admission_release_failure()");
    }
    expect(await transitionTask(fixture.db, cache, task.id, "cancel")).not.toBeNull();
    expect(await balance(userId)).toBe(100);
    expect(fixture.statements.some(sql => sql.includes("FROM tasks WHERE id=$1 AND status IN ('waiting','paused') FOR UPDATE"))).toBe(true);
  });

  test("concurrent cancellation settles once and cache failure cannot reverse a committed cancellation", async () => {
    const userId = await user(); const value = input(userId); const task = await submit(value);
    failCache = true;
    let results;
    try { results = await Promise.all([transitionTask(fixture.db, cache, task.id, "cancel"), transitionTask(fixture.db, cache, task.id, "cancel")]); }
    finally { failCache = false; }
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await row("SELECT status FROM tasks WHERE id=$1", [task.id])).status).toBe("cancelled");
    expect(await balance(userId)).toBe(100);
    expect((await row("SELECT count(*)::int AS count FROM credit_ledger WHERE reference_id=$1 AND entry_type='release'", [value.requestId])).count).toBe(1);
  });

  test("captured or uncertain work cannot be cancelled, refunded or replayed by resume", async () => {
    const userId = await user(); const value = input(userId); const task = await submit(value);
    await settleReservation(fixture.db, value.requestId, "capture");
    await expect(transitionTask(fixture.db, cache, task.id, "cancel")).rejects.toMatchObject({ code: "INVALID_TASK_STATE" });
    expect((await row("SELECT status FROM tasks WHERE id=$1", [task.id])).status).toBe("waiting");
    expect(await balance(userId)).toBe(92);
    const unknown = input(userId); const second = await submit(unknown);
    await fixture.db.query("UPDATE tasks SET status='paused',operation_type='video_generation',attempts=1,upstream_submission_started_at=now() WHERE id=$1", [second.id]);
    expect(await transitionTask(fixture.db, cache, second.id, "cancel")).toBeNull();
    expect(await transitionTask(fixture.db, cache, second.id, "resume")).toBeNull();
    expect((await row("SELECT status FROM credit_reservations WHERE request_id=$1", [unknown.requestId])).status).toBe("held");
    expect(await balance(userId)).toBe(84);
  });

  test("HTTP single quota returns 429 and ignores a forged client admission limit", async () => {
    const userId = await user(); await submit(input(userId)); await submit(input(userId));
    const value = input(userId, { maxInflightTasks: 1000 });
    const response = await request(userId, "", value);
    expect(response.status).toBe(429); expect(await response.json()).toMatchObject({ error: "USER_TASK_LIMIT_REACHED" });
    expect(await balance(userId)).toBe(84);
    expect((await row("SELECT count(*)::int AS count FROM tasks WHERE request_id=$1", [value.requestId])).count).toBe(0);
  });

  test("HTTP batch retains admitted items, reports per-item quota codes and never holds rejected items", async () => {
    const userId = await user(); await submit(input(userId));
    const value = { ...input(userId), items: Array.from({ length: 3 }, () => ({ sourceUrls: ["/fixture.png"] })) };
    const response = await request(userId, "/batch", value);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.tasks).toHaveLength(1); expect(body.tasks[0].itemIndex).toBe(0);
    expect(body.failures.map((failure: any) => ({ index: failure.index, code: failure.code }))).toEqual([{ index: 1, code: "USER_TASK_LIMIT_REACHED" }, { index: 2, code: "USER_TASK_LIMIT_REACHED" }]);
    expect((await row("SELECT count(*)::int AS count FROM credit_reservations WHERE request_id=ANY($1::text[])", [[0, 1, 2].map(index => `${value.requestId}:${index}`)])).count).toBe(1);
    expect((await row("SELECT count(*)::int AS count FROM tasks WHERE batch_id=$1 AND status='failed' AND credits=0", [body.batchId])).count).toBe(2);
    expect(await balance(userId)).toBe(84);
    expect((await request(userId, "/batch", value)).status).toBe(201);
    expect(await balance(userId)).toBe(84);
  });

  test("department administrators cannot submit urgent single or batch tasks", async () => {
    const userId = await user(); const value = input(userId, { priority: "urgent" });
    expect((await request(userId, "", value, "department_admin")).status).toBe(403);
    expect((await request(userId, "/batch", { ...value, items: [{ sourceUrls: ["/fixture.png"] }] }, "department_admin")).status).toBe(403);
    expect((await row("SELECT count(*)::int AS count FROM tasks WHERE user_id=$1", [userId])).count).toBe(0);
    expect(await balance(userId)).toBe(100);
  });
});
