import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { settleReservation } from "../src/billing";
import type { Cache } from "../src/db";
import { withTransaction } from "../src/db-transaction";
import { ApiMartImageProviderFailure, ApiMartImageTaskPending } from "../src/apimart-image";
import { VideoProviderFailure, VideoSubmissionClaimLost, VideoTaskPending } from "../src/media-runtime";
import { disposeProviderResults } from "../src/media-result-file";
import { acquireModelLease, releaseModelLease, TaskExecutionLost } from "../src/model-concurrency";
import { ProviderSubmissionRejected, submissionWasNotSent } from "../src/provider-submission-policy";
import { Seedream55OutputLimitExceeded } from "../src/seedream55-image";
import { TASK_LEASE_SECONDS, transitionTask } from "../src/tasks";
import { readApiMartVideoReceipt, saveApiMartVideoReceipt } from "../src/video-provider-receipt";
import { WorkflowTaskPending } from "../src/workflow-task-context";
import { createIsolatedPostgres } from "./helpers/isolated-postgres";

const source = ts.createSourceFile("worker.ts", await Bun.file(new URL("../src/worker.ts", import.meta.url)).text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const forbidden = (name: string) => () => { throw new Error(`Unexpected ${name}`); };
const timing = { measure: async (_stage: string, action: () => unknown) => action(), finish() {} };
function worker(dependencies: Record<string, unknown>, runTask = false) {
  const deps = {
    readApiMartVideoReceipt, saveApiMartVideoReceipt, TaskExecutionLost, VideoTaskPending, VideoProviderFailure, VideoSubmissionClaimLost,
    ApiMartImageProviderFailure, ApiMartImageTaskPending, ProviderSubmissionRejected, submissionWasNotSent, WorkflowTaskPending, Seedream55OutputLimitExceeded,
    storage: { configured: true }, config: { TASK_MOCK_MODE: "false", PROVIDER_ENCRYPTION_KEY: "fixture-only" },
    decryptSecret: forbidden("credential decryption"), assertImageEditMaskSupport: () => {},
    stepApiMartVideoTask: forbidden("provider submit or query"), loadVideoSourceAssets: forbidden("reference reload"),
    downloadVideoResult: forbidden("download"), db: { query: forbidden("database query") },
    ...dependencies,
  };
  const names = ["executeProvider", "executeApiMartVideo", "assertTaskExecution", ...(runTask ? ["runTask"] : [])];
  const code = names.map(name => source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(source)).join("\n");
  return new Function(...Object.keys(deps), `${ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText};return {${names.join(",")}}`)(...Object.values(deps));
}
const url = "https://provider-results.example/original.mp4?signature=private%2Fvalue";
const task = () => ({ id: randomUUID(), user_id: randomUUID(), model_config_id: randomUUID(), model_id: "gemini-omni-1.2-flash",
  execution_token: randomUUID(), upstream_task_id: "original-video", upstream_submission_started_at: new Date().toISOString(),
  operation_type: "video_generation", parameters: {}, source_urls: [], prompt: "fixture", protocol: "apimart", base_url: "https://provider.invalid",
  encrypted_credentials: "fixture-only", upstream_result_document: null as unknown, poll_deadline_at: null as string | null });
const receipt = (current: Pick<ReturnType<typeof task>, "id" | "user_id" | "model_config_id" | "model_id" | "upstream_task_id">, costUsd?: number) => ({ schema: "canvas.video-provider-receipt", version: 1, kind: "apimart-video",
  taskId: current.id, userId: current.user_id, modelConfigId: current.model_config_id, modelId: current.model_id, upstreamTaskId: current.upstream_task_id,
  status: "completed", url, currency: "USD", ...(costUsd === undefined ? { costStatus: "unknown" } : { costStatus: "known", costUsd }) });

test("completed receipt bypasses provider settings, credentials and expired polling deadlines", async () => {
  const current = { ...task(), base_url: null, encrypted_credentials: null, poll_deadline_at: new Date(0).toISOString() };
  current.upstream_result_document = receipt(current, 0);
  const calls: string[] = [];
  const result = { filePath: "fixture-only", byteSize: 3, mimeType: "video/mp4", dispose: async () => {} };
  const api = worker({ config: {},
    db: { query: async (_sql: string, values: unknown[]) => { calls.push("lease"); expect(values).toEqual([current.id, current.execution_token]); return { rows: [{ id: current.id }] }; } },
    downloadVideoResult: async (actualUrl: string) => { calls.push("download"); expect(actualUrl).toBe(url); return result; },
  });
  expect(await api.executeProvider(current, timing)).toEqual([result]); expect(calls).toEqual(["lease", "download"]);
});

test("non-null malformed, foreign-kind or mismatched receipts fail before provider, credentials, lease or downloads", async () => {
  const current = task(); const original = receipt(current);
  const documents = [{}, [], { version: 1, mode: "decompose", items: [] }, { ...original, version: 2 },
    ...["taskId", "userId", "modelConfigId", "modelId", "upstreamTaskId"].map(key => ({ ...original,
      [key]: key === "modelId" ? "doubao-seedance-2.5" : key === "upstreamTaskId" ? "other-upstream" : randomUUID() }))];
  const api = worker({});
  for (const document of documents) {
    await expect(api.executeProvider({ ...current, upstream_result_document: document }, timing)).rejects.toThrow("收据");
  }
  await expect(api.executeProvider({ ...current, upstream_task_id: null, upstream_result_document: original }, timing)).rejects.toThrow("收据");
});

test("a lost execution lease blocks receipt download even though provider work has completed", async () => {
  const current = task(); current.upstream_result_document = receipt(current);
  const api = worker({ db: { query: async () => ({ rows: [] }) } });
  await expect(api.executeProvider(current, timing)).rejects.toBeInstanceOf(TaskExecutionLost);
});

test("receipt save failure blocks download and leaves the task without an in-memory completion", async () => {
  const current = task(); let saves = 0;
  const api = worker({
    stepApiMartVideoTask: async () => ({ status: "completed", upstreamTaskId: current.upstream_task_id, url, costUsd: 0 }),
    saveApiMartVideoReceipt: async (_db: unknown, identity: Record<string, unknown>, result: unknown) => {
      saves++; expect(identity).toEqual({ taskId: current.id, userId: current.user_id, modelConfigId: current.model_config_id,
        modelId: current.model_id, upstreamTaskId: current.upstream_task_id, executionToken: current.execution_token });
      expect(result).toEqual({ status: "completed", upstreamTaskId: current.upstream_task_id, url, costUsd: 0 });
      throw new TaskExecutionLost("fixture lost lease");
    },
  });
  await expect(api.executeApiMartVideo(current, {})).rejects.toBeInstanceOf(TaskExecutionLost);
  expect(saves).toBe(1); expect(current.upstream_result_document).toBeNull();
});

test("pending or expired-without-receipt tasks neither checkpoint nor download", async () => {
  const current = task(); let queries = 0;
  const api = worker({ stepApiMartVideoTask: async () => { queries++; return { status: "pending", upstreamTaskId: current.upstream_task_id, nextPollMs: 3000 }; }, saveApiMartVideoReceipt: forbidden("receipt save") });
  await expect(api.executeApiMartVideo(current, {})).rejects.toBeInstanceOf(VideoTaskPending);
  await expect(api.executeApiMartVideo({ ...current, poll_deadline_at: new Date(0).toISOString() }, {})).rejects.toThrow("查询超时");
  expect(queries).toBe(1);
});

test("a video receipt can never be passed to Seedream storage as a layer manifest", async () => {
  const current = { ...task(), tool_key: "layer-studio", operation_type: "image_generation", request_id: "request", batch_id: null, attempts: 1 };
  current.upstream_result_document = receipt(current);
  let pauses = 0, captures = 0;
  const api = worker({
    db: { query: async (sql: string) => { if (sql.includes("status='paused'")) pauses++; return { rows: [current] }; } },
    randomUUID, TASK_LEASE_SECONDS, cache: {}, acquireModelLease: async () => ({}), releaseModelLease: async () => {},
    startTaskLeaseHeartbeat: () => ({ assertOwned() {}, stop: async () => {} }), createGenerationTiming: () => timing,
    storeSeedream55TaskResults: forbidden("Seedream storage"), readProviderSubmissionDiagnostics: () => undefined,
    settleLayerStudioReservation: () => { captures++; }, disposeProviderResults,
  }, true);
  await api.runTask(current.id); expect(pauses).toBe(1); expect(captures).toBe(0);
});

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
integration("Worker completion receipt actual SQL recovery", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  const userId = randomUUID();
  const query = (sql: string, values: unknown[] = []) => fixture.db.query(sql, values);
  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await query("INSERT INTO users(id,username,display_name) VALUES($1,$2,'Worker receipt fixture')", [userId, `worker-receipt-${userId}`]);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  const createTask = async (name: string) => {
    const taskId = randomUUID(), providerId = randomUUID(), modelId = randomUUID(), requestId = `worker-receipt-${taskId}`;
    await query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,$2,'apimart','https://provider.invalid','fixture-only')", [providerId, `Receipt ${name}`]);
    await query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,$3,'gemini-omni-1.2-flash',ARRAY['video'])", [modelId, providerId, `Omni ${name}`]);
    await query(`INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,model_config_id,prompt,status,upstream_task_id,upstream_submission_started_at,poll_deadline_at,attempts)
      VALUES($1,$2,$3,'worker-receipt','video_generation',$4,'fixture','waiting','original-video',now(),now()+interval '5 minutes',1)`, [taskId, requestId, userId, modelId]);
    await query(`INSERT INTO credit_reservations(request_id,user_id,operation_type,quantity,credits,rmb_cost,price_snapshot,status)
      VALUES($1,$2,'video_generation',1,0,0,'{"billingDisabled":true}','held')`, [requestId, userId]);
    const state = async () => (await query("SELECT status,attempts,upstream_result_document AS receipt,result_document,result_urls,failure_reason,model_slot_token,model_slot_expires_at FROM tasks WHERE id=$1", [taskId])).rows[0];
    return { taskId, providerId, modelId, requestId, state };
  };

  for (const failure of ["download", "store"] as const) test(`${failure} interruption releases the completed model slot, resumes from the same receipt and settles exactly once`, async () => {
    const { taskId, providerId, requestId, state } = await createTask(failure);
    const cache = { eval: async () => 1, zRem: async () => 0 } as unknown as Cache;
    let providerQueries = 0, decryptions = 0, downloads = 0, stores = 0, disposed = 0, captures = 0;
    const api = worker({
      db: fixture.db, cache, randomUUID, TASK_LEASE_SECONDS, withTransaction,
      acquireModelLease, releaseModelLease,
      startTaskLeaseHeartbeat: () => ({ assertOwned() {}, stop: async () => {} }), createGenerationTiming: () => timing,
      readProviderSubmissionDiagnostics: () => undefined, disposeProviderResults,
      settleReservation: async (...args: Parameters<typeof settleReservation>) => { captures++; return settleReservation(...args); },
      decryptSecret: () => { decryptions++; return '{"apiKey":"fixture-only"}'; },
      stepApiMartVideoTask: async (input: Record<string, unknown>) => { providerQueries++; expect(input.upstreamTaskId).toBe("original-video"); expect(input.sources).toEqual([]);
        return { status: "completed", upstreamTaskId: "original-video", url, ...(failure === "store" ? { costUsd: 0 } : {}) }; },
      downloadVideoResult: async (actualUrl: string) => {
        downloads++; expect(actualUrl).toBe(url);
        expect((await state()).receipt).toMatchObject({ kind: "apimart-video", taskId, url, costStatus: failure === "store" ? "known" : "unknown" });
        if (failure === "download" && downloads === 1) throw new Error("fixture interrupted download");
        return { filePath: "fixture-only", byteSize: 3, mimeType: "video/mp4", dispose: async () => { disposed++; } };
      },
      storeResults: async () => { stores++; if (failure === "store" && stores === 1) throw new Error("fixture interrupted storage"); return [`/api/assets/${taskId}/content`]; },
    }, true);
    await api.runTask(taskId);
    const paused = await state();
    expect(paused).toMatchObject({ status: "paused", attempts: 1, result_document: null, result_urls: [], model_slot_token: null, model_slot_expires_at: null });
    expect(paused.failure_reason).toContain("可恢复原任务继续下载和保存"); expect(paused.failure_reason).not.toContain("不能直接恢复");
    expect((await query("SELECT status FROM credit_reservations WHERE request_id=$1", [requestId])).rows[0].status).toBe("held");
    expect(captures).toBe(0); expect(providerQueries).toBe(1); expect(decryptions).toBe(1);

    // Resume through the real transition, then make provider access impossible.
    // runTask reloads the receipt from SQL with a new execution token.
    expect(await transitionTask(fixture.db, cache, taskId, "resume", false)).not.toBeNull();
    await query("UPDATE tasks SET poll_deadline_at=now()-interval '1 day' WHERE id=$1", [taskId]);
    await query("UPDATE providers SET encrypted_credentials=NULL,base_url='' WHERE id=$1", [providerId]);
    await api.runTask(taskId);
    const completed = await state();
    expect(completed).toMatchObject({ status: "success", attempts: 1, receipt: paused.receipt, result_document: null, result_urls: [`/api/assets/${taskId}/content`], model_slot_token: null, model_slot_expires_at: null });
    expect(completed.receipt).not.toHaveProperty("executionToken");
    if (failure === "store") expect(completed.receipt).toMatchObject({ currency: "USD", costStatus: "known", costUsd: 0 });
    else expect(completed.receipt).not.toHaveProperty("costUsd");
    expect((await query("SELECT status FROM credit_reservations WHERE request_id=$1", [requestId])).rows[0].status).toBe("captured");
    expect((await query("SELECT count(*)::int AS n FROM generation_history WHERE task_id=$1", [taskId])).rows[0].n).toBe(1);
    expect(providerQueries).toBe(1); expect(decryptions).toBe(1); expect(downloads).toBe(2); expect(captures).toBe(1);
    expect(disposed).toBe(failure === "store" ? 2 : 1);
    await api.runTask(taskId);
    expect(providerQueries).toBe(1); expect(downloads).toBe(2); expect(captures).toBe(1);
  });

  test("unknown completion, a layer manifest and a foreign-identity video receipt all retain the original model slot", async () => {
    for (const kind of ["unknown", "layer", "foreign"] as const) {
      const { taskId, modelId, requestId, state } = await createTask(kind);
      const original = kind === "unknown" ? null : kind === "layer" ? { version: 1, mode: "decompose", items: [] }
        : receipt({ id: taskId, user_id: randomUUID(), model_config_id: modelId, model_id: "gemini-omni-1.2-flash", upstream_task_id: "original-video" });
      await query("UPDATE tasks SET upstream_result_document=$2::jsonb WHERE id=$1", [taskId, original === null ? null : JSON.stringify(original)]);
      let queries = 0;
      const api = worker({
        db: fixture.db, cache: { eval: async () => 1, zRem: async () => 0 }, randomUUID, TASK_LEASE_SECONDS,
        acquireModelLease, releaseModelLease, startTaskLeaseHeartbeat: () => ({ assertOwned() {}, stop: async () => {} }),
        createGenerationTiming: () => timing, readProviderSubmissionDiagnostics: () => undefined, disposeProviderResults,
        decryptSecret: () => '{"apiKey":"fixture-only"}',
        stepApiMartVideoTask: async () => { queries++; throw new Error("fixture original state unknown"); },
      }, true);
      await api.runTask(taskId);
      const paused = await state();
      expect(paused).toMatchObject({ status: "paused", attempts: 1, receipt: original });
      expect(paused.model_slot_token).not.toBeNull(); expect(paused.model_slot_expires_at).not.toBeNull();
      expect(queries).toBe(kind === "unknown" ? 1 : 0);
      expect((await query("SELECT status FROM credit_reservations WHERE request_id=$1", [requestId])).rows[0].status).toBe("held");
    }
  });
});
