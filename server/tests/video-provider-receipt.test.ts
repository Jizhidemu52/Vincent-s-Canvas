import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Database } from "../src/db";
import { TaskExecutionLost } from "../src/model-concurrency";
import { readApiMartVideoReceipt, saveApiMartVideoReceipt, type ApiMartVideoCompletedResult, type ApiMartVideoReceiptIdentity } from "../src/video-provider-receipt";
import { createIsolatedPostgres } from "./helpers/isolated-postgres";

const identity: ApiMartVideoReceiptIdentity = { taskId: randomUUID(), userId: randomUUID(), modelConfigId: randomUUID(), modelId: "gemini-omni-1.2-flash", upstreamTaskId: "provider-task/original" };
const url = "https://provider-results.example/original.mp4?signature=private%2Fvalue";
const result: ApiMartVideoCompletedResult = { status: "completed", upstreamTaskId: identity.upstreamTaskId, url };
const document = (costUsd?: number) => ({ ...identity, schema: "canvas.video-provider-receipt", version: 1, kind: "apimart-video", status: "completed", url, currency: "USD",
  ...(costUsd === undefined ? { costStatus: "unknown" } : { costStatus: "known", costUsd }),
});

describe("private APIMart video receipt validation", () => {
  test("absence stays absent; unknown settlement is not zero and exact zero remains known", () => {
    expect(readApiMartVideoReceipt(null, identity)).toBeNull();
    expect(readApiMartVideoReceipt(undefined, identity)).toBeNull();
    const unknown = readApiMartVideoReceipt(document(), identity);
    expect(unknown).toMatchObject({ kind: "apimart-video", currency: "USD", costStatus: "unknown", url });
    expect(unknown).not.toHaveProperty("costUsd");
    for (const costUsd of [0, 0.123456789]) expect(readApiMartVideoReceipt(document(costUsd), identity)).toMatchObject({ currency: "USD", costStatus: "known", costUsd });
  });

  test("all five task identities are exact and error text does not expose private URLs", () => {
    for (const key of ["taskId", "userId", "modelConfigId", "modelId", "upstreamTaskId"] as const) {
      const expected = { ...identity, [key]: key === "modelId" ? "doubao-seedance-2.5" : key === "upstreamTaskId" ? "different-upstream" : randomUUID() };
      try { readApiMartVideoReceipt(document(0), expected); throw new Error("Expected identity mismatch"); }
      catch (error) { expect(error).toMatchObject({ code: "VIDEO_PROVIDER_RECEIPT_IDENTITY_MISMATCH" }); expect(String(error)).not.toContain("signature"); }
    }
  });

  test("other document kinds, schema versions and incomplete or ambiguous cost records are rejected", () => {
    for (const value of [[], {}, { version: 1, mode: "decompose", items: [{ url }] },
      { ...document(), schema: "other" }, { ...document(), version: 2 }, { ...document(), kind: "seedream" },
      { ...document(), status: "failed" }, { ...document(), currency: "CNY" }, { ...document(), unexpected: "private" },
      { ...document(), costStatus: "known" }, { ...document(), costUsd: 0 },
      ...[-1, NaN, Infinity, null, "0.1"].map(costUsd => ({ ...document(0), costUsd }))]) {
      expect(() => readApiMartVideoReceipt(value, identity)).toThrow("收据格式无效");
    }
  });

  test("only public HTTP(S) output URLs are accepted and signed query bytes are preserved", () => {
    for (const invalidUrl of ["", "asset://original", "data:video/mp4;base64,eA==", "blob:https://public.example/video", "ftp://public.example/video",
      "http://127.0.0.1/video", "http://10.0.0.1/video", "https://localhost/video", "https://user:password@public.example/video", ` ${url}`, `${url} `, `https://public.example/${"x".repeat(16_384)}`]) {
      expect(() => readApiMartVideoReceipt({ ...document(), url: invalidUrl }, identity)).toThrow("收据格式无效");
    }
    expect(readApiMartVideoReceipt({ ...document(), url: "http://public.example/video.mp4" }, identity)?.url).toBe("http://public.example/video.mp4");
    expect(readApiMartVideoReceipt(document(), identity)?.url).toBe(url);
  });

  test("failed/pending/invalid provider results never open a transaction or imply a free completed result", async () => {
    let connections = 0;
    const db = { connect: async () => { connections++; throw new Error("Unexpected database access"); } } as unknown as Database;
    for (const badResult of [{ ...result, status: "failed" }, { ...result, status: "pending" }, { ...result, url: "http://127.0.0.1/video" },
      { ...result, costUsd: -1 }, { ...result, costUsd: NaN }, { ...result, costUsd: null }, { ...result, upstreamTaskId: "other" }]) {
      await expect(saveApiMartVideoReceipt(db, { ...identity, executionToken: randomUUID() }, badResult as ApiMartVideoCompletedResult)).rejects.toThrow("收据");
    }
    expect(connections).toBe(0);
  });
});

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
integration("private APIMart video receipt actual SQL persistence", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  const userId = randomUUID(), providerId = randomUUID(), modelConfigId = randomUUID();
  const query = (sql: string, values: unknown[] = []) => fixture.db.query(sql, values);
  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await query("INSERT INTO users(id,username,display_name) VALUES($1,$2,'Receipt fixture')", [userId, `receipt-${userId}`]);
    await query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Receipt fixture','apimart','https://no-network.invalid','fixture-only')", [providerId]);
    await query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'Omni receipt','gemini-omni-1.2-flash',ARRAY['video'])", [modelConfigId, providerId]);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  const createTask = async () => {
    const bound = { taskId: randomUUID(), userId, modelConfigId, modelId: "gemini-omni-1.2-flash", upstreamTaskId: `upstream-${randomUUID()}`, executionToken: randomUUID() };
    await query(`INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,model_config_id,status,execution_token,lease_expires_at,upstream_task_id,
      upstream_submission_started_at,result_document,result_urls,credits,rmb_cost,attempts)
      VALUES($1,$6,$2,'receipt-fixture','video_generation',$3,'processing',$4,clock_timestamp()+interval '5 minutes',$5,
        now(),'{"public":"original"}'::jsonb,'["/api/assets/existing/content"]'::jsonb,7,0.4321,1)`,
    [bound.taskId, userId, modelConfigId, bound.executionToken, bound.upstreamTaskId, `receipt-${bound.taskId}`]);
    return bound;
  };
  const completed = (bound: ApiMartVideoReceiptIdentity, costUsd?: number): ApiMartVideoCompletedResult => ({ status: "completed", upstreamTaskId: bound.upstreamTaskId, url, ...(costUsd === undefined ? {} : { costUsd }) });
  const stored = async (taskId: string) => (await query(`SELECT upstream_result_document AS document,result_document AS public,result_urls AS urls,
    status,credits,rmb_cost::float8 AS "rmbCost",attempts,upstream_task_id AS "upstreamTaskId" FROM tasks WHERE id=$1`, [taskId])).rows[0];

  test("completion persists privately before any download, survives reload and never touches public output or charges", async () => {
    const bound = await createTask();
    const before = await stored(bound.taskId);
    const receipt = await saveApiMartVideoReceipt(fixture.db, bound, completed(bound));
    expect(receipt).toMatchObject({ schema: "canvas.video-provider-receipt", version: 1, kind: "apimart-video", currency: "USD", costStatus: "unknown", url });
    expect(receipt).not.toHaveProperty("costUsd"); expect(receipt).not.toHaveProperty("executionToken");
    const after = await stored(bound.taskId);
    expect({ ...after, document: null }).toEqual(before);
    expect(readApiMartVideoReceipt(JSON.parse(JSON.stringify(after.document)), bound)).toEqual(receipt);
    expect((await query("SELECT count(*)::int AS n FROM credit_reservations")).rows[0].n).toBe(0);
    expect((await query("SELECT count(*)::int AS n FROM generation_history")).rows[0].n).toBe(0);
  });

  test.each([0, 0.123456789])("same receipt can gain a final cost, and missing cost cannot erase it (%s)", async costUsd => {
    const bound = await createTask();
    await saveApiMartVideoReceipt(fixture.db, bound, completed(bound));
    const known = await saveApiMartVideoReceipt(fixture.db, bound, completed(bound, costUsd));
    expect(known).toMatchObject({ costStatus: "known", costUsd, currency: "USD" });
    expect(await saveApiMartVideoReceipt(fixture.db, bound, completed(bound))).toEqual(known);
    expect(await saveApiMartVideoReceipt(fixture.db, bound, completed(bound, costUsd))).toEqual(known);
    expect((await stored(bound.taskId)).document).toEqual(known);
  });

  test("different URLs or conflicting known settlements never replace an existing receipt", async () => {
    const bound = await createTask();
    const first = await saveApiMartVideoReceipt(fixture.db, bound, completed(bound, 0.25));
    for (const value of [{ ...completed(bound, 0.25), url: "https://other.example/replacement.mp4" }, completed(bound, 0.5)]) {
      await expect(saveApiMartVideoReceipt(fixture.db, bound, value)).rejects.toMatchObject({ code: "VIDEO_PROVIDER_RECEIPT_CONFLICT" });
      expect((await stored(bound.taskId)).document).toEqual(first);
    }
  });

  test("other private document kinds and mismatched persisted identities remain untouched", async () => {
    const bound = await createTask();
    for (const other of [{ version: 1, mode: "decompose", items: [{ url }] },
      { ...document(0), ...bound, executionToken: undefined, taskId: randomUUID() },
      { ...document(0), ...bound, executionToken: undefined, modelId: "doubao-seedance-2.5" }]) {
      const original = JSON.parse(JSON.stringify(other));
      await query("UPDATE tasks SET upstream_result_document=$2::jsonb WHERE id=$1", [bound.taskId, JSON.stringify(original)]);
      await expect(saveApiMartVideoReceipt(fixture.db, bound, completed(bound, 0))).rejects.toThrow("收据");
      expect((await stored(bound.taskId)).document).toEqual(original);
    }
  });

  test("save fences task, owner, configuration, actual model, upstream task and execution token", async () => {
    const bound = await createTask();
    for (const key of ["taskId", "userId", "modelConfigId", "executionToken", "upstreamTaskId", "modelId"] as const) {
      const other = { ...bound, [key]: key === "modelId" ? "doubao-seedance-2.5" : key === "upstreamTaskId" ? "other-upstream" : randomUUID() };
      await expect(saveApiMartVideoReceipt(fixture.db, other, completed(other))).rejects.toBeInstanceOf(TaskExecutionLost);
      expect((await stored(bound.taskId)).document).toBeNull();
    }
  });

  test.each(["waiting", "paused", "cancelled", "failed", "success"])("nonprocessing state %s is never changed into a completed receipt", async status => {
    const bound = await createTask();
    await query("UPDATE tasks SET status=$2 WHERE id=$1", [bound.taskId, status]);
    await expect(saveApiMartVideoReceipt(fixture.db, bound, completed(bound))).rejects.toBeInstanceOf(TaskExecutionLost);
    expect(await stored(bound.taskId)).toMatchObject({ document: null, status, credits: 7, rmbCost: 0.4321 });
  });

  test("expired leases and nonvideo task routes cannot save a provider receipt", async () => {
    const bound = await createTask();
    await query("UPDATE tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [bound.taskId]);
    await expect(saveApiMartVideoReceipt(fixture.db, bound, completed(bound))).rejects.toBeInstanceOf(TaskExecutionLost);
    await query("UPDATE tasks SET lease_expires_at=clock_timestamp()+interval '5 minutes',operation_type='image_generation' WHERE id=$1", [bound.taskId]);
    await expect(saveApiMartVideoReceipt(fixture.db, bound, completed(bound))).rejects.toBeInstanceOf(TaskExecutionLost);
    expect((await stored(bound.taskId)).document).toBeNull();
  });

  test("an identically named model on a different protocol cannot save an APIMart receipt", async () => {
    const bound = await createTask();
    try {
      await query("UPDATE providers SET protocol='openai' WHERE id=$1", [providerId]);
      await expect(saveApiMartVideoReceipt(fixture.db, bound, completed(bound))).rejects.toBeInstanceOf(TaskExecutionLost);
      expect((await stored(bound.taskId)).document).toBeNull();
    } finally { await query("UPDATE providers SET protocol='apimart' WHERE id=$1", [providerId]); }
  });

  test.each(["lease", "receipt"])("the final SQL write rechecks a changed %s after the locked read", async changed => {
    const bound = await createTask();
    let intervened = false;
    const fencedDb = { connect: async () => {
      const client = await fixture.db.connect();
      return { release: () => client.release(), query: async (sql: string, values: unknown[] = []) => {
        const found = await client.query(sql, values);
        if (sql.startsWith("SELECT t.upstream_result_document")) {
          intervened = true;
          await client.query(changed === "lease"
            ? "UPDATE tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1"
            : "UPDATE tasks SET upstream_result_document='{\"kind\":\"other-private-result\"}'::jsonb WHERE id=$1", [bound.taskId]);
        }
        return found;
      } };
    } } as unknown as Database;
    await expect(saveApiMartVideoReceipt(fencedDb, bound, completed(bound, 0))).rejects.toBeInstanceOf(TaskExecutionLost);
    expect(intervened).toBe(true);
    // The whole failed transaction rolls back; neither a new receipt nor the injected change survives.
    expect((await stored(bound.taskId)).document).toBeNull();
  });

  test("serialized duplicate completions preserve a known cost even when a concurrent reply omits it", async () => {
    const bound = await createTask();
    await Promise.all([saveApiMartVideoReceipt(fixture.db, bound, completed(bound, 0)), saveApiMartVideoReceipt(fixture.db, bound, completed(bound))]);
    expect((await stored(bound.taskId)).document).toMatchObject({ costStatus: "known", costUsd: 0 });
  });
});
