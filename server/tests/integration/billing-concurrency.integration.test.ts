import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type QueryResult } from "pg";

import { adjustCredits, BillingError, reserveCredits, setCreditBalance, settleReservation } from "../../src/billing";
import type { Cache, Database } from "../../src/db";
import { enqueueTask, transitionTask, type TaskInput } from "../../src/tasks";

const integration = process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const schema = `billing_concurrency_${randomUUID().replaceAll("-", "")}`;
const migrations = fileURLToPath(new URL("../../src/migrations", import.meta.url));
// No worker or provider is involved. Only Redis delivery after the real commit is replaced.
const cache = { eval: async () => 1, zAdd: async () => 1 } as unknown as Cache;

function barrier(participants = 2) {
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolveReady) => { release = resolveReady; });
  return async () => {
    if (++arrivals >= participants) release();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Concurrent queries did not reach the barrier")), 5_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

integration("PostgreSQL billing concurrency", () => {
  let control: Pool | undefined;
  let database: Pool;
  let schemaCreated = false;

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required for billing integration tests");
    control = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
    // Existing CI migration installs these in public; keep extension ownership outside our schema.
    await control.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await control.query("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public");
    await control.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    database = new Pool({
      connectionString,
      max: 6,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema},public -c statement_timeout=10000 -c lock_timeout=5000`,
    });
    // Use the production DDL, including foreign keys, unique constraints and append-only ledgers.
    for (const name of (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort()) {
      await database.query(await readFile(resolve(migrations, name), "utf8"));
    }
  }, 30_000);

  afterAll(async () => {
    await database?.end();
    try {
      // The name is generated here, never supplied through environment variables or user data.
      if (schemaCreated) await control!.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await control?.end();
    }
  }, 15_000);

  function observeQueries(afterQuery?: (sql: string, result: QueryResult) => Promise<void>,
    beforeQuery?: (sql: string) => Promise<void>) {
    const concurrencyErrors: string[] = [];
    const db = {
      connect: async () => {
        const client = await database.connect();
        const query = (async (sql: string, values?: unknown[]) => {
          try {
            await beforeQuery?.(sql);
            const result = await client.query(sql, values);
            await afterQuery?.(sql, result);
            return result;
          } catch (error) {
            const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
            // withTransaction retries these errors. A successful retry must not hide a regression.
            if (code === "40P01" || code === "40001") concurrencyErrors.push(code);
            throw error;
          }
        }) as PoolClient["query"];
        return { query, release: () => client.release() } as PoolClient;
      },
    } as unknown as Database;
    return { db, concurrencyErrors };
  }

  function holdInsertedTasks() {
    const wait = barrier();
    let inserted = 0;
    return observeQueries(async (sql, result) => {
      if (/^\s*INSERT INTO tasks\(/.test(sql) && result.rows.length > 0 && inserted++ < 2) {
        // Both real INSERTs have completed their FK checks and still hold KEY SHARE locks.
        await wait();
      }
    });
  }

  function holdUserAdmissions() {
    const wait = barrier();
    let attempts = 0;
    // Admission intentionally serializes the same user before any INSERT.
    return observeQueries(undefined, async sql => {
      if (sql.includes("hashtext('user-inflight-quota')") && attempts++ < 2) await wait();
    });
  }

  async function fixture(options: { users?: number; department?: boolean; budget?: number; personal?: number } = {}) {
    const tag = randomUUID();
    let departmentId: string | null = null;
    if (options.department !== false) {
      const department = await database.query<{ id: string }>(
        "INSERT INTO departments(name,code,credit_balance,credit_limit) VALUES($1,$2,$3,$3) RETURNING id",
        [`Concurrency ${tag}`, tag, options.budget ?? 0],
      );
      departmentId = department.rows[0]!.id;
    }
    const userIds: string[] = [];
    const provider = await database.query<{ id: string }>(
      "INSERT INTO providers(name,protocol,base_url,enabled) VALUES($1,'custom','https://no-network.invalid',true) RETURNING id", [`Concurrency ${tag}`],
    );
    const model = await database.query<{ id: string }>(
      `INSERT INTO model_configs(provider_id,name,model_id,capabilities,credit_cost,rmb_cost,enabled)
       VALUES($1,$2,$2,ARRAY['generate'],0,0,true) RETURNING id`, [provider.rows[0]!.id, `database-only-${tag}`],
    );
    for (let index = 0; index < (options.users ?? 2); index += 1) {
      const user = await database.query<{ id: string }>(
        `INSERT INTO users(username,display_name,department_id,credit_balance,credit_limit,monthly_credit_limit)
         VALUES($1::text,$1::text,$2,$3,$3,$3) RETURNING id`,
        [`concurrency-${tag}-${index}`, departmentId, options.personal ?? 100],
      );
      userIds.push(user.rows[0]!.id);
    }
    const input = (userId = userIds[0]!, requestId = randomUUID()): TaskInput => ({
      requestId, userId, departmentId, projectId: `concurrency-${tag}`,
      operationType: "image_generation", toolKey: "image", modelConfigId: model.rows[0]!.id,
      prompt: "database-only billing regression", sourceUrls: [], priority: "normal",
    });
    return { departmentId, userIds, input };
  }

  async function balances(userIds: string[]) {
    const result = await database.query<{ credit_balance: number }>(
      "SELECT credit_balance FROM users WHERE id=ANY($1::uuid[]) ORDER BY username", [userIds],
    );
    return result.rows.map((row) => row.credit_balance);
  }

  async function taskCounts(requestIds: string[]) {
    const result = await database.query<{ tasks: number; reservations: number; userHolds: number; departmentHolds: number }>(
      `SELECT (SELECT count(*)::int FROM tasks WHERE request_id=ANY($1::text[])) AS tasks,
              (SELECT count(*)::int FROM credit_reservations WHERE request_id=ANY($1::text[])) AS reservations,
              (SELECT count(*)::int FROM credit_ledger WHERE reference_id=ANY($1::text[]) AND entry_type='hold' AND user_id IS NOT NULL) AS "userHolds",
              (SELECT count(*)::int FROM credit_ledger WHERE reference_id=ANY($1::text[]) AND entry_type='hold' AND department_id IS NOT NULL) AS "departmentHolds"`,
      [requestIds],
    );
    return result.rows[0]!;
  }

  test("concurrent administrator additions retain every increment and deduplicate a shared request", async () => {
    const data = await fixture({ users: 1, department: false });
    const userId = data.userIds[0]!;
    const input = { actorId: userId, userId, amount: 7, reason: "Concurrency fixture adjustment" };
    await Promise.all(Array.from({ length: 8 }, () => adjustCredits(database, { ...input, requestId: randomUUID() })));
    expect(await balances([userId])).toEqual([156]);
    const requestId = randomUUID();
    const repeated = await Promise.all([adjustCredits(database, { ...input, requestId }), adjustCredits(database, { ...input, requestId })]);
    expect(repeated.map(result => result.duplicate).sort()).toEqual([false, true]);
    expect(await balances([userId])).toEqual([163]);
    expect((await database.query("SELECT id FROM credit_ledger WHERE request_id=$1", [requestId])).rows).toHaveLength(1);
  }, 20_000);

  test("direct concurrent reservations share one hold and reject a different owner without unique-key errors", async () => {
    const data = await fixture({ users: 2, department: false });
    const task = data.input();
    const input = { requestId: task.requestId, userId: task.userId, operationType: task.operationType, modelConfigId: task.modelConfigId, quantity: 1 };
    const repeated = await Promise.all([reserveCredits(database, input), reserveCredits(database, input)]);
    expect(repeated.map(result => result.duplicate).sort()).toEqual([false, true]);
    expect(await balances(data.userIds)).toEqual([92, 100]);
    await expect(reserveCredits(database, { ...input, userId: data.userIds[1]! })).rejects.toMatchObject({ code: "DUPLICATE_REQUEST" });
    const sharedRequestId = randomUUID();
    const competing = await Promise.allSettled(data.userIds.map(userId => reserveCredits(database, { ...input, requestId: sharedRequestId, userId })));
    expect(competing.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((competing.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "DUPLICATE_REQUEST" });
    expect((await database.query("SELECT id FROM credit_reservations WHERE request_id=$1", [sharedRequestId])).rows).toHaveLength(1);
  }, 20_000);

  test("a concurrent reused administrator request cannot change a second user", async () => {
    const data = await fixture({ users: 2, department: false });
    const requestId = randomUUID();
    const result = await Promise.allSettled(data.userIds.map(userId => adjustCredits(database, {
      requestId, userId, actorId: data.userIds[0]!, amount: 7, reason: "Conflicting fixture adjustment",
    })));
    expect(result.map(item => item.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = result.find(item => item.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "CREDIT_REQUEST_CONFLICT" });
    expect((await balances(data.userIds)).sort()).toEqual([100, 107]);
    expect((await database.query("SELECT id FROM credit_ledger WHERE request_id=$1", [requestId])).rows).toHaveLength(1);
  }, 20_000);

  test("an absolute balance set and a task debit serialize without a client-computed delta race", async () => {
    const data = await fixture({ users: 1, department: false });
    const userId = data.userIds[0]!;
    const requestId = randomUUID();
    const task = data.input();
    await Promise.all([
      setCreditBalance(database, { requestId, userId, actorId: userId, balance: 200, reason: "Atomic absolute fixture" }),
      enqueueTask(database, cache, task),
    ]);
    const ledger = await database.query<{ amount: number; balance_after: number; metadata: { balanceBefore: number } }>(
      "SELECT amount,balance_after,metadata FROM credit_ledger WHERE request_id=$1", [requestId],
    );
    const adjustment = ledger.rows[0]!;
    expect(adjustment.balance_after).toBe(200);
    expect(adjustment.amount).toBe(200 - adjustment.metadata.balanceBefore);
    expect(await balances([userId])).toEqual([100 + adjustment.amount - 8]);
    expect([192, 200]).toContain((await balances([userId]))[0]);
  }, 20_000);

  test("different designers in one unlimited department do not upgrade FK locks into a deadlock", async () => {
    const data = await fixture();
    const observed = holdInsertedTasks();
    const inputs = data.userIds.map((userId) => data.input(userId));
    const results = await Promise.allSettled(inputs.map((input) => enqueueTask(observed.db, cache, input)));
    expect(observed.concurrencyErrors).toEqual([]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await balances(data.userIds)).toEqual([92, 92]);
    expect(await taskCounts(inputs.map((input) => input.requestId))).toEqual({ tasks: 2, reservations: 2, userHolds: 2, departmentHolds: 0 });
  }, 20_000);

  test("two submissions by one user without a department preserve the exact personal balance", async () => {
    const data = await fixture({ users: 1, department: false });
    const observed = holdUserAdmissions();
    const inputs = [data.input(), data.input()];
    const results = await Promise.allSettled(inputs.map((input) => enqueueTask(observed.db, cache, input)));
    expect(observed.concurrencyErrors).toEqual([]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await balances(data.userIds)).toEqual([84]);
    expect(await taskCounts(inputs.map((input) => input.requestId))).toEqual({ tasks: 2, reservations: 2, userHolds: 2, departmentHolds: 0 });
  }, 20_000);

  test("competing submissions cannot overspend a finite department budget or leave a failed task", async () => {
    const data = await fixture({ budget: 8 });
    const observed = holdInsertedTasks();
    const inputs = data.userIds.map((userId) => data.input(userId));
    const results = await Promise.allSettled(inputs.map((input) => enqueueTask(observed.db, cache, input)));
    expect(observed.concurrencyErrors).toEqual([]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BillingError);
    expect(rejected.reason.code).toBe("DEPARTMENT_CREDIT_EXHAUSTED");
    expect((await balances(data.userIds)).sort((left, right) => left - right)).toEqual([92, 100]);
    const department = await database.query("SELECT credit_balance FROM departments WHERE id=$1", [data.departmentId]);
    expect(department.rows[0].credit_balance).toBe(0);
    expect(await taskCounts(inputs.map((input) => input.requestId))).toEqual({ tasks: 1, reservations: 1, userHolds: 1, departmentHolds: 1 });
  }, 20_000);

  test("concurrent duplicate request IDs create one task and charge each balance only once", async () => {
    const data = await fixture({ users: 1, budget: 100 });
    const input = data.input();
    const observed = holdUserAdmissions();
    const results = await Promise.allSettled([1, 2].map(() => enqueueTask(observed.db, cache, input)));
    expect(observed.concurrencyErrors).toEqual([]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const tasks = results.map((result) => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof enqueueTask>>>).value);
    expect(tasks[0]!.id).toBe(tasks[1]!.id);
    expect(await balances(data.userIds)).toEqual([92]);
    const department = await database.query("SELECT credit_balance FROM departments WHERE id=$1", [data.departmentId]);
    expect(department.rows[0].credit_balance).toBe(92);
    expect(await taskCounts([input.requestId])).toEqual({ tasks: 1, reservations: 1, userHolds: 1, departmentHolds: 1 });
  }, 20_000);

  test("per-user admission lock admits exactly one competing last-slot request and does not block another user", async () => {
    const data = await fixture({ users: 2, department: false });
    const observed = holdUserAdmissions();
    const inputs = [data.input(), data.input()];
    const results = await Promise.allSettled(inputs.map(value => enqueueTask(observed.db, cache, { ...value, maxInflightTasks: 1 })));
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "USER_TASK_LIMIT_REACHED" });
    expect(observed.concurrencyErrors).toEqual([]);
    expect(await taskCounts(inputs.map(value => value.requestId))).toEqual({ tasks: 1, reservations: 1, userHolds: 1, departmentHolds: 0 });
    const other = data.input(data.userIds[1]);
    expect((await enqueueTask(database, cache, { ...other, maxInflightTasks: 1 })).status).toBe("waiting");
    const winningIndex = results.findIndex(result => result.status === "fulfilled");
    expect((await enqueueTask(database, cache, { ...inputs[winningIndex]!, maxInflightTasks: 1 })).id)
      .toBe((results[winningIndex] as PromiseFulfilledResult<any>).value.id);
    expect(await balances(data.userIds)).toEqual([92, 92]);
  }, 20_000);

  test("row-locked cancellation fences a concurrent worker claim and refunds once", async () => {
    const data = await fixture({ users: 1, department: false });
    const value = data.input(); const task = await enqueueTask(database, cache, value);
    let locked!: () => void; const ready = new Promise<void>(done => { locked = done; });
    let unlock!: () => void; const canContinue = new Promise<void>(done => { unlock = done; });
    const observed = observeQueries(async sql => {
      if (sql.includes("FROM tasks WHERE id=$1 AND status IN ('waiting','paused') FOR UPDATE")) { locked(); await canContinue; }
    });
    const cancellation = transitionTask(observed.db, cache, task.id, "cancel", false);
    await ready;
    const workerClaim = database.query("UPDATE tasks SET status='processing',execution_token=$2 WHERE id=$1 AND status='waiting' RETURNING id", [task.id, randomUUID()]);
    unlock();
    expect(await cancellation).not.toBeNull();
    expect((await workerClaim).rows).toHaveLength(0);
    expect(await balances(data.userIds)).toEqual([100]);
    expect((await database.query("SELECT status FROM credit_reservations WHERE request_id=$1", [value.requestId])).rows[0].status).toBe("released");
    expect(observed.concurrencyErrors).toEqual([]);
  }, 20_000);

  for (const outcome of ["capture", "release"] as const) {
    test(`group-funded ${outcome} and a new submission do not deadlock through ledger foreign keys`, async () => {
      const data = await fixture({ users: 1, personal: 0 });
      const userId = data.userIds[0]!;
      const group = await database.query<{ id: string }>(
        `INSERT INTO designer_groups(department_id,name,code,monthly_shared_credit_limit)
         VALUES($1,$2::text,$2::text,100) RETURNING id`, [data.departmentId, randomUUID()],
      );
      const groupId = group.rows[0]!.id;
      await database.query("INSERT INTO group_memberships(group_id,user_id) VALUES($1,$2)", [groupId, userId]);
      await database.query(
        `INSERT INTO group_credit_periods(group_id,period_start,fixed_credits,allocated_credits,pool_balance)
         SELECT $1,credit_period_start,100,100,0 FROM users WHERE id=$2`, [groupId, userId],
      );
      await database.query(
        `INSERT INTO group_credit_wallets(group_id,user_id,period_start,granted_credits,available_credits)
         SELECT $1,id,credit_period_start,100,100 FROM users WHERE id=$2`, [groupId, userId],
      );
      const held = data.input();
      await enqueueTask(database, cache, held);
      const next = data.input();
      const wait = barrier();
      let groupLocked = false;
      let userLocked = false;
      const reserve = observeQueries(async (sql) => {
        if (!groupLocked && /FROM designer_groups WHERE id=\$1 FOR /.test(sql)) {
          groupLocked = true;
          await wait();
        }
      });
      const settle = observeQueries(async (sql) => {
        if (!userLocked && /FROM users WHERE id=\$1 FOR /.test(sql)) {
          userLocked = true;
          await wait();
        }
      });
      const results = await Promise.allSettled([
        enqueueTask(reserve.db, cache, next),
        settleReservation(settle.db, held.requestId, outcome),
      ]);
      expect([...reserve.concurrencyErrors, ...settle.concurrencyErrors]).toEqual([]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(await balances(data.userIds)).toEqual([0]);
      const wallet = await database.query(
        "SELECT available_credits,spent_credits FROM group_credit_wallets WHERE group_id=$1 AND user_id=$2", [groupId, userId],
      );
      expect(wallet.rows[0]).toEqual(outcome === "capture"
        ? { available_credits: 84, spent_credits: 8 }
        : { available_credits: 92, spent_credits: 0 });
      const reservation = await database.query("SELECT status FROM credit_reservations WHERE request_id=$1", [held.requestId]);
      expect(reservation.rows[0].status).toBe(outcome === "capture" ? "captured" : "released");
      expect(await taskCounts([held.requestId, next.requestId])).toEqual({ tasks: 2, reservations: 2, userHolds: 2, departmentHolds: 0 });
    }, 20_000);
  }
});
