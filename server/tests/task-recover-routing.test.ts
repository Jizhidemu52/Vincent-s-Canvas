import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { createTasksRouter } from "../src/routes/tasks";
import { createIsolatedPostgres } from "./helpers/isolated-postgres";
import type { Cache } from "../src/db";
import type { TaskPausedKind } from "../../shared/task-repair";

(process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip)("owner-scoped recovery HTTP", () => {
  let pg: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let server: ReturnType<ReturnType<typeof express>["listen"]>, base: string;
  const owner = randomUUID(), deliveries: string[] = [];
  beforeAll(async () => {
    pg = await createIsolatedPostgres();
    await pg.db.query("INSERT INTO users(id,username,display_name) VALUES($1,'recover-fixture','recover-fixture')", [owner]);
    const app = express();
    app.use((req,_res,next) => { Object.assign(req, { auth: { id: req.get("x-test-actor") } }); next(); });
    const unused = async (): Promise<never> => { throw Error("unexpected cache operation in recovery"); };
    const cache: Cache = { get: unused, set: unused, del: unused, ping: unused, quit: unused, zAdd: unused, zRem: unused, zPopMin: unused, incr: unused, decr: unused, expire: unused,
      eval: async (_s, options) => { deliveries.push(options.arguments[0]!); return 1; } };
    app.use("/tasks", createTasksRouter(pg.db, cache));
    server = app.listen(0,"127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("expected isolated TCP listener");
    base = `http://127.0.0.1:${address.port}/tasks`;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await pg.close(); });
  test.each([
    ["result_repair",true,"重新保存"],["awaiting_query",true,"原任务查询"],["submission_unknown",false,"不会自动重发"],["needs_review",false,"管理员"],
  ] satisfies Array<[TaskPausedKind, boolean, string]>)("%s: recovery never creates another task or misreports a new charge", async (kind, allowed, message) => {
    const id = randomUUID();
    await pg.db.query(`INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,status,attempts,paused_kind,upstream_task_id,upstream_submission_started_at,failure_reason)
      VALUES ($1::uuid,($1::uuid)::text,$2,'test','inpaint','paused',1,$3,$4,now(),'private-internal-reason')`, [id,owner,kind,kind === "submission_unknown" ? null : "original-id"]);
    const url = `${base}/${id}/recover`;
    const post = (actor: string) => fetch(url, { method: "POST", headers: { "x-test-actor": actor } });
    expect((await post(randomUUID())).status).toBe(404);
    const before = deliveries.length;
    const response = await post(owner), body = await response.json();
    expect(response.status).toBe(200); expect(body.recovered).toBe(allowed);
    expect(body.message).toContain(message);
    expect(JSON.stringify(body)).not.toContain("private-internal-reason");
    expect(deliveries.slice(before)).toEqual(allowed ? [id] : []);
    expect(body.task).toMatchObject({ id, attempts: 1, repairAttempts: allowed ? 1 : 0, status: allowed ? "waiting" : "paused" });
  });
});
