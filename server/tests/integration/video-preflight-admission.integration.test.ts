import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Cache, Database } from "../../src/db";
import { enqueueTask, type TaskInput } from "../../src/tasks";
import { preflightStoredVideoTask } from "../../src/stored-video-preflight";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
integration("video preflight outside atomic task admission", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let db: Database;
  let transactionDepth = 0, queued = 0;
  const cache = { eval: async () => { queued++; return 1; } } as unknown as Cache;
  const provider = randomUUID(), model = randomUUID(), otherUser = randomUUID();
  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    db = { query: fixture.db.query, connect: async () => {
      const client = await fixture.db.connect();
      return { query: async (sql: string, values: unknown[]) => {
        const result = await client.query(sql, values);
        if (sql === "BEGIN") transactionDepth++;
        if (sql === "COMMIT" || sql === "ROLLBACK") transactionDepth--;
        return result;
      }, release: () => client.release() };
    } } as unknown as Database;
    await db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Offline video preflight','apimart','https://no-network.invalid','fixture-only')", [provider]);
    await db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'Offline video','MiniMax-H3',ARRAY['video'])", [model, provider]);
    await db.query("INSERT INTO users(id,username,display_name) VALUES($1,$2,'Other fixture')", [otherUser, `other-${otherUser}`]);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  const row = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows[0];
  async function input(): Promise<TaskInput> {
    const user = randomUUID(), asset = randomUUID();
    await db.query("INSERT INTO users(id,username,display_name,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,$2,'Video fixture',100,100,100)", [user, `video-${user}`]);
    await db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,source,status) VALUES($1,$2,$3,'source.png','image/png',3,'image','upload','ready')", [asset, user, `fixture/${asset}`]);
    return { requestId: randomUUID(), userId: user, departmentId: null, projectId: "fixture", operationType: "video_generation", modelConfigId: model,
      prompt: "first-frame fixture", parameters: { videoMode: "first-frame" }, sourceUrls: [`/api/assets/${asset}/content`], priority: "normal", maxInflightTasks: 1 };
  }
  function preflight(after?: () => Promise<void>, counter?: { count: number }) {
    return async (database: Pick<Database, "query">, value: Parameters<typeof preflightStoredVideoTask>[1]) => {
      if (counter) counter.count++;
      expect(transactionDepth).toBe(0);
      const checked = await preflightStoredVideoTask(database, value, "", {
        readSource: async () => { expect(transactionDepth).toBe(0); return (async function* () { yield new Uint8Array([1, 2, 3]); })(); },
        probe: async (stream, _mime, expected) => {
          expect(transactionDepth).toBe(0); expect(expected).toBe(3);
          // A second DB operation must progress while media I/O is in flight.
          expect((await row("SELECT 1 AS available")).available).toBe(1);
          let count = 0; for await (const chunk of stream as AsyncIterable<Uint8Array>) count += chunk.byteLength;
          expect(count).toBe(3); return { width: 768, height: 768 };
        },
      });
      await after?.(); return checked;
    };
  }
  async function noAdmission(value: TaskInput) {
    expect((await row("SELECT count(*)::int AS count FROM tasks WHERE request_id=$1", [value.requestId])).count).toBe(0);
    expect((await row("SELECT count(*)::int AS count FROM credit_reservations WHERE request_id=$1", [value.requestId])).count).toBe(0);
    expect((await row("SELECT credit_balance FROM users WHERE id=$1", [value.userId])).credit_balance).toBe(100);
    expect(transactionDepth).toBe(0);
  }
  test("media I/O holds no transaction; successful admission and duplicate freeze only once", async () => {
    const value = await input(), counter = { count: 0 };
    const before = queued;
    const task = await enqueueTask(db, cache, value, preflight(undefined, counter));
    expect(task.status).toBe("waiting"); expect(task.credits).toBe(30);
    expect((await row("SELECT credit_balance FROM users WHERE id=$1", [value.userId])).credit_balance).toBe(70);
    expect((await row("SELECT parameters FROM tasks WHERE id=$1", [task.id])).parameters.referenceCount).toBe(1);
    const duplicate = await enqueueTask(db, cache, value, preflight(undefined, counter));
    expect(duplicate.id).toBe(task.id); expect(counter.count).toBe(1);
    expect((await row("SELECT count(*)::int AS count FROM credit_ledger WHERE reference_id=$1 AND entry_type='hold'", [value.requestId])).count).toBe(1);
    expect(queued - before).toBe(2); expect(transactionDepth).toBe(0);
  });
  test.each(["key", "owner", "deleted", "size", "mime", "model"])("rechecks %s after probe before any credit hold", async change => {
    const value = await input(), before = queued, asset = value.sourceUrls[0]!.split('/')[3];
    const after = async () => {
      if (change === "model") await db.query("UPDATE model_configs SET enabled=false WHERE id=$1", [model]);
      else if (change === "owner") await db.query("UPDATE assets SET owner_user_id=$2 WHERE id=$1", [asset, otherUser]);
      else if (change === "deleted") await db.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [asset]);
      else if (change === "key") await db.query("UPDATE assets SET object_key=object_key||'-changed' WHERE id=$1", [asset]);
      else if (change === "size") await db.query("UPDATE assets SET byte_size=4 WHERE id=$1", [asset]);
      else await db.query("UPDATE assets SET mime_type='video/mp4' WHERE id=$1", [asset]);
    };
    try { await expect(enqueueTask(db, cache, value, preflight(after))).rejects.toMatchObject({ code: change === "model" ? "MODEL_DISABLED" : ["owner", "deleted"].includes(change) ? "INVALID_SOURCE" : "INVALID_VIDEO_INPUT" }); }
    finally { if (change === "model") await db.query("UPDATE model_configs SET enabled=true WHERE id=$1", [model]); }
    expect(queued).toBe(before); await noAdmission(value);
  });
  test("quota is checked again after the probe; a competing task does not create an extra hold", async () => {
    const value = await input(), before = queued;
    await expect(enqueueTask(db, cache, value, preflight(async () => {
      await db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,prompt) VALUES($1,$2,$3,'fixture','image_generation','other')", [randomUUID(), randomUUID(), value.userId]);
    }))).rejects.toMatchObject({ code: "USER_TASK_LIMIT_REACHED" });
    expect(queued).toBe(before); await noAdmission(value);
  });
  test("a duplicate created during the probe wins without a second task or reservation", async () => {
    const value = await input(), original = randomUUID();
    const result = await enqueueTask(db, cache, value, preflight(async () => {
      await db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,prompt,status) VALUES($1,$2,$3,'fixture','video_generation','original','success')", [original, value.requestId, value.userId]);
    }));
    expect(result.id).toBe(original);
    expect((await row("SELECT count(*)::int AS count FROM credit_reservations WHERE request_id=$1", [value.requestId])).count).toBe(0);
    expect((await row("SELECT credit_balance FROM users WHERE id=$1", [value.userId])).credit_balance).toBe(100);
  });
});
