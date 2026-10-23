import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import express from "express";
import { Pool, type PoolClient } from "pg";
import type { Database } from "../../src/db";
import type { AuthenticatedRequest } from "../../src/types";
import { createTasksEventsRouter, TaskEventsService, TASK_EVENTS_CHANNEL } from "../../src/task-events";

const integration = process.env.RUN_INTEGRATION_TESTS === "true" || process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const migrations = new URL("../../src/migrations/", import.meta.url);
type Notification = { channel: string; payload: string };

async function migrationFixture() {
  const notifications: Notification[] = [];
  let checkouts = 0;
  if (process.env.RUN_INTEGRATION_TESTS === "true") {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for task event integration tests");
    const control = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 });
    const schema = `task_events_${crypto.randomUUID().replaceAll("-", "")}`;
    let pool: Pool | undefined, writer: PoolClient | undefined, created = false;
    const close = async () => {
      writer?.release(); await pool?.end();
      try { if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await control.end(); }
    };
    try {
      await control.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
      await control.query("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public");
      await control.query(`CREATE SCHEMA "${schema}"`); created = true;
      pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 5_000,
        options: `-c search_path=${schema},public -c statement_timeout=10000` });
      for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort())
        await pool.query(await readFile(new URL(name, migrations), "utf8"));
      writer = await pool.connect();
      const db = { connect: async () => {
        checkouts++;
        const client = await pool!.connect();
        client.on("notification", message => { if (message.channel === TASK_EVENTS_CHANNEL && message.payload) notifications.push({ channel: message.channel, payload: message.payload }); });
        return client;
      } } as unknown as Database;
      return { db, notifications, query: (sql: string, values: unknown[] = []) => writer!.query(sql, values), close, checkouts: () => checkouts };
    } catch (error) { await close(); throw error; }
  }

  // The local path uses real PostgreSQL WASM LISTEN/NOTIFY semantics. Only the
  // PoolClient event-emitter transport is adapted; production DDL is unchanged.
  const requireRuntime = createRequire(resolve(process.env.PGLITE_RUNTIME_PATH!, "package.json"));
  const { PGlite } = requireRuntime("@electric-sql/pglite");
  const { pgcrypto } = requireRuntime("@electric-sql/pglite/contrib/pgcrypto");
  const { citext } = requireRuntime("@electric-sql/pglite/contrib/citext");
  const database = new PGlite({ extensions: { pgcrypto, citext } });
  await database.waitReady;
  try {
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort())
      await database.exec(await readFile(new URL(name, migrations), "utf8"));
  } catch (error) { await database.close(); throw error; }
  const releases: Promise<unknown>[] = [];
  const db = { connect: async () => {
    checkouts++;
    let stop: (() => Promise<void>) | undefined, released = false;
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      query: async (sql: string) => {
        if (sql !== `LISTEN ${TASK_EVENTS_CHANNEL}`) throw new Error("Unexpected listener SQL");
        stop = await database.listen(TASK_EVENTS_CHANNEL, (payload: string) => {
          const message = { channel: TASK_EVENTS_CHANNEL, payload };
          notifications.push(message); emitter.emit("notification", message);
        });
        if (released) await stop!();
        return { rows: [] };
      },
      release: () => { if (released) return; released = true; if (stop) releases.push(stop()); },
    }) as unknown as PoolClient;
  } } as unknown as Database;
  return { db, notifications, query: (sql: string, values: unknown[] = []) => database.query(sql, values),
    checkouts: () => checkouts, close: async () => { await Promise.all(releases); await database.close(); } };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) { if (Date.now() >= deadline) throw new Error("SQL task notification did not reach the HTTP stream"); await Bun.sleep(5); }
}

integration("production task trigger delivers commit-only lightweight SSE and suppresses scheduling churn", async () => {
  const fixture = await migrationFixture();
  const owner = crypto.randomUUID(), otherOwner = crypto.randomUUID(), task = crypto.randomUUID(), otherTask = crypto.randomUUID();
  const service = new TaskEventsService(fixture.db);
  const app = express();
  app.use((request, _response, next) => { (request as AuthenticatedRequest).auth = { id: owner } as AuthenticatedRequest["auth"]; next(); });
  app.use("/api/tasks/events", createTasksEventsRouter(service, { heartbeatMs: 25, maxConnectionMs: 10_000 }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(done => server.once("listening", done));
  let stream: Promise<void> | undefined;
  const events: Array<{ ids: string[] }> = [];
  let wire = "";
  try {
    await fixture.query("INSERT INTO users(id,username,display_name) VALUES($1,$3,'Event owner'),($2,$4,'Other event owner')", [owner, otherOwner, `events-${owner}`, `events-${otherOwner}`]);
    await service.start();
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/tasks/events?ids=${task},${otherTask}&ownerId=${owner}`);
    expect(response.status).toBe(200);
    stream = (async () => {
      let pending = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body!) {
        const text = decoder.decode(chunk, { stream: true }); wire += text; pending += text;
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          if (frame.startsWith("event: tasks-changed\ndata: ")) events.push(JSON.parse(frame.split("\ndata: ")[1]!));
        }
      }
    })();
    await until(() => events.length === 1);
    expect(events[0]).toEqual({ ids: [task, otherTask] });
    const insert = (id = task, userId = owner) => fixture.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,prompt) VALUES($1,$3,$2,'events-fixture','image_generation','private prompt')", [id, userId, id]);
    const silent = async (count: number) => { await Bun.sleep(35); expect(events).toHaveLength(count); };
    const change = async (sql: string, count: number, values: unknown[] = [task]) => {
      await fixture.query(sql, values); await until(() => events.length === count); expect(events.at(-1)).toEqual({ ids: [task] });
    };

    await fixture.query("BEGIN"); await insert(); await silent(1); expect(fixture.notifications).toEqual([]);
    await fixture.query("ROLLBACK"); await silent(1); expect(fixture.notifications).toEqual([]);
    await insert(); await until(() => events.length === 2);
    await insert(otherTask, otherOwner); await silent(2);
    await fixture.query("UPDATE tasks SET lease_expires_at=now()+interval '30 seconds',model_slot_expires_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1", [task]);
    await fixture.query("UPDATE tasks SET status=status,result_urls='[]'::jsonb,failure_reason=NULL,upstream_task_id=NULL WHERE id=$1", [task]);
    await silent(2);
    await change("UPDATE tasks SET status='processing',started_at=now() WHERE id=$1", 3);
    // Both not-yet-admitted tasks and submitted tasks are claimed/deferred every
    // few seconds. These internal active-state flips must never trigger GETs.
    const churn = async () => {
      for (let index = 0; index < 5; index++) {
        await fixture.query("UPDATE tasks SET status='waiting',execution_token=NULL,available_at=now()+interval '2 seconds',failure_reason=COALESCE(NULL,failure_reason) WHERE id=$1", [task]);
        await fixture.query("UPDATE tasks SET status='processing',started_at=COALESCE(started_at,now()),execution_token=gen_random_uuid(),lease_expires_at=now()+interval '30 seconds' WHERE id=$1", [task]);
      }
    };
    await churn(); await silent(3);
    await change("UPDATE tasks SET upstream_submission_started_at=now() WHERE id=$1", 4);
    await change("UPDATE tasks SET upstream_task_id='private-upstream-id' WHERE id=$1", 5);
    await churn(); await silent(5);
    await change("UPDATE tasks SET result_urls='[\"https://private-provider.example/result\"]'::jsonb WHERE id=$1", 6);
    await fixture.query("UPDATE tasks SET result_urls='[\"https://private-provider.example/result\"]'::jsonb WHERE id=$1", [task]);
    await silent(6);
    await change("UPDATE tasks SET failure_reason='private-provider-error' WHERE id=$1", 7);
    await change("UPDATE tasks SET status='paused' WHERE id=$1", 8);
    await change("UPDATE tasks SET status='waiting' WHERE id=$1", 9);
    await fixture.query("BEGIN"); await fixture.query("UPDATE tasks SET status='success' WHERE id=$1", [task]); await silent(9);
    await fixture.query("ROLLBACK"); await silent(9);
    await fixture.query("BEGIN"); await fixture.query("UPDATE tasks SET status='success' WHERE id=$1", [task]); await silent(9);
    await fixture.query("COMMIT"); await until(() => events.length === 10);
    await change("DELETE FROM tasks WHERE id=$1", 11);
    expect(fixture.checkouts()).toBe(1);
    const ownedNotifications = fixture.notifications.map(message => JSON.parse(message.payload)).filter(message => message.userId === owner);
    expect(ownedNotifications).toHaveLength(10);
    for (const notification of ownedNotifications) expect(notification).toEqual({ id: task, userId: owner });
    expect(wire).not.toContain("private-"); expect(wire).not.toContain("userId"); expect(wire).toContain(": heartbeat");
    await service.close(); await stream;
  } finally {
    await service.close();
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    await stream;
    await fixture.close();
  }
}, 30_000);
