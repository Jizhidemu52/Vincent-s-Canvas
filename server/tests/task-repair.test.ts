import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { classifyResultFailure, pauseOwnedTask, requeueRepairs } from "../src/task-repair";
import { ImageResultProcessingError } from "../src/image-result-processing";
import { createIsolatedPostgres } from "./helpers/isolated-postgres";

test("local pixel checks go to review, space and transfer failures are retriable", () => {
  expect(classifyResultFailure(new Error("wrapper", { cause: new ImageResultProcessingError("IMAGE_RESULT_DIMENSION_MISMATCH", "width") })).kind).toBe("needs_review");
  expect(classifyResultFailure(Object.assign(new Error("disk"), { code: "ENOSPC" }))).toEqual({ kind: "result_repair", code: "STORAGE_ENOSPC" });
  expect(classifyResultFailure(new Error("Content-Length mismatch")).code).toBe("STORAGE_LENGTH_MISMATCH");
});

(process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip)("original task repair scheduling", () => {
  let pg: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  const owner = randomUUID();
  beforeAll(async () => {
    pg = await createIsolatedPostgres();
    await pg.db.query("INSERT INTO users(id,username,display_name) VALUES($1,'repair-fixture','repair-fixture')", [owner]);
  });
  afterAll(async () => { await pg?.close(); });
  test("056 backfills historical output validation, partial saves and unknown submissions without taking over a manual pause", async () => {
    const migration = await Bun.file(new URL("../src/migrations/056_task_repair.sql", import.meta.url)).text();
    const backfill = migration.slice(migration.indexOf("WITH classified AS"));
    await pg.db.query("BEGIN");
    try {
      for (const [id,reason,upstream,started,attempts] of [
        ["mask","渠道原件已保存到素材库，但图片后处理未完成：前景蒙版全黑","id1",true,1],
        ["partial","部分图层原件尚未保存","id2",true,1],
        ["unknown","HTTP 500",null,true,1],
        ["query","暂时查询不到","id3",true,1],
        ["manual",null,null,false,0],
      ] as const) await pg.db.query(`INSERT INTO tasks(request_id,user_id,project_id,operation_type,status,failure_reason,upstream_task_id,upstream_submission_started_at,attempts)
        VALUES ($1,$2,'migration-test','inpaint','paused',$3,$4,CASE WHEN $5::boolean THEN now() END,$6)`,[id,owner,reason,upstream,started,attempts]);
      await pg.db.query(backfill);
      const result = await pg.db.query("SELECT request_id,paused_kind,repair_error_code,next_repair_at IS NOT NULL AS due FROM tasks WHERE project_id='migration-test' ORDER BY request_id");
      expect(result.rows.map(row => [row.request_id,row.paused_kind,row.repair_error_code,row.due])).toEqual([
        ["manual",null,null,false], ["mask","needs_review","RESULT_MASK_INVALID",false], ["partial","result_repair","LAYER_PARTIAL_SAVE",true],
        ["query","awaiting_query","UPSTREAM_QUERY_PENDING",true], ["unknown","submission_unknown","SUBMISSION_UNKNOWN",false],
      ]);
      expect((await pg.db.query(backfill)).rowCount).toBe(0);
    } finally { await pg.db.query("ROLLBACK"); }
  });
  test("expired or replaced ownership cannot change another worker's state", async () => {
    const id = randomUUID(), token = randomUUID();
    await pg.db.query(`INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,status,attempts,execution_token,lease_expires_at)
      VALUES ($1::uuid,($1::uuid)::text,$2,'test','inpaint','processing',1,$3,now()-interval '1 second')`, [id,owner,token]);
    const lost = (execution_token: string) => pauseOwnedTask(pg.db, { id, execution_token }, { kind: "needs_review", code: "TASK_EXECUTION_LOST" }, "lost", 3);
    expect((await lost(token)).rowCount).toBe(0);
    await pg.db.query("UPDATE tasks SET lease_expires_at=now()+interval '1 minute' WHERE id=$1", [id]);
    expect((await lost(randomUUID())).rowCount).toBe(0);
    expect((await pg.db.query("SELECT status FROM tasks WHERE id=$1",[id])).rows[0]?.status).toBe("processing");
  });
  test("uses the same upstream identity, fences concurrent claims and stops after 3 repairs", async () => {
    const id = randomUUID(), token = randomUUID(), started = "2026-01-01T00:00:00Z";
    await pg.db.query(`INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,status,attempts,execution_token,upstream_task_id,upstream_submission_started_at)
      VALUES ($1::uuid,($1::uuid)::text,$2,'test','inpaint','processing',1,$3,'already-paid',$4)`, [id,owner,token,started]);
    const sent: string[] = [];
    const cache = { eval: async (_: string, o: { arguments: string[] }) => { sent.push(o.arguments[0]!); return 1; } };
    for (let i = 0; i <= 3; i++) {
      const decision = classifyResultFailure(Object.assign(new Error("disk"), { code: "ENOSPC" }));
      await pauseOwnedTask(pg.db, { id, execution_token: token }, decision, "storage", 3);
      const row = (await pg.db.query("SELECT paused_kind, repair_attempts, attempts, upstream_task_id, upstream_submission_started_at,round(extract(epoch FROM next_repair_at-updated_at))::int AS delay FROM tasks WHERE id=$1",[id])).rows[0]!;
      expect(row).toMatchObject({ paused_kind: i === 3 ? "needs_review" : "result_repair", repair_attempts: i, attempts: 1, upstream_task_id: "already-paid", delay: [60,300,900,null][i] });
      expect(new Date(row.upstream_submission_started_at).getTime()).toBe(Date.parse(started));
      await pg.db.query("UPDATE tasks SET execution_token=NULL WHERE id=$1",[id]);
      expect(await requeueRepairs(pg.db, cache, { maxAttempts: 3 })).toBe(0);
      await pg.db.query("UPDATE tasks SET next_repair_at=now() WHERE id=$1 AND next_repair_at IS NOT NULL", [id]);
      const results = await Promise.all([requeueRepairs(pg.db, cache, { maxAttempts: 3 }),requeueRepairs(pg.db, cache, { maxAttempts: 3 })]);
      expect(results.reduce((a,b) => a+b, 0)).toBe(i < 3 ? 1 : 0);
      if (i < 3) await pg.db.query("UPDATE tasks SET status='processing',execution_token=$2 WHERE id=$1 AND status='waiting'",[id,token]);
    }
    expect(sent).toEqual([id,id,id]);
  });
});
