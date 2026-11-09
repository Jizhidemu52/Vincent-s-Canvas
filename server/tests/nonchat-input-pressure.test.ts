import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express from "express";
import ts from "typescript";
import { taskSubmissionSchema, batchSubmissionSchema } from "../../shared/task-contracts";
import { settleReservation } from "../src/billing";
import type { Cache } from "../src/db";
import { withTransaction } from "../src/db-transaction";
import { acquireModelLease, releaseModelLease, startTaskLeaseHeartbeat, TaskExecutionLost } from "../src/model-concurrency";
import { enqueueTask, canAutomaticallyRetryTask, queueScore, recalculateBatch, restoreWaitingTasksToQueue, TASK_LEASE_SECONDS, transitionTask } from "../src/tasks";
import { scheduleQueuedTask } from "../src/task-queue";
import { createTasksRouter } from "../src/routes/tasks";
import { stepApiMartImageTask, ApiMartImageProviderFailure, ApiMartImageQueryRetryable, ApiMartImageTaskPending, preflightApiMartImageRequest } from "../src/apimart-image";
import { stepApiMartVideoTask, VideoProviderFailure, VideoSubmissionClaimLost, VideoTaskPending } from "../src/media-runtime";
import { ProviderSubmissionRejected, submissionWasNotSent } from "../src/provider-submission-policy";
import { disposeProviderResults, downloadVideoResult } from "../src/media-result-file";
import { WorkflowTaskPending } from "../src/workflow-task-context";
import { PromptOptimizationError } from "../src/prompt-safety";
import { preflightVideoTask } from "../src/video-task-preflight";
import { supportedVideoModelIds, videoModelCapabilities, validateVideoSources, type ProviderVideoSource } from "../src/video-models";
import { createIsolatedPostgres } from "./helpers/isolated-postgres";

// This intentionally does NOT pretend to execute Redis Lua or use network PG.
// SQL is the existing single-connection PGlite fixture; cache/provider are mocks.
const isolated = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
function cacheFixture() {
  const scheduled = new Set<string>();
  const leases = new Map<string, Map<string, number>>();
  const cache = {
    eval: async (script: string, options: { keys: string[]; arguments: string[] }) => {
      const a = options.arguments;
      if (script.includes("cjson.decode")) {
        const snapshot = JSON.parse(a[4]!) as { member: string; expires: number }[];
        const entries = new Map(snapshot.filter(v => v.expires > Number(a[0])).map(v => [v.member, v.expires]));
        leases.set(options.keys[0]!, entries);
        if (!entries.has(a[1]!) && entries.size >= Number(a[3])) return 0;
        entries.set(a[1]!, Number(a[2]));
        return 1;
      }
      if (script.includes("ZSCORE")) {
        const entries = leases.get(options.keys[0]!);
        if (!entries?.has(a[0]!)) return 0;
        entries.set(a[0]!, Number(a[1])); return 1;
      }
      if (a.length === 4) scheduled.add(a[0]!);
      else if (a.length === 1) scheduled.delete(a[0]!);
      else throw new Error("Unsupported mock cache operation");
      return 1;
    },
    zRem: async (key: string, member: string) => Number(leases.get(key)?.delete(member) ?? false),
  } as unknown as Cache;
  return { cache, scheduled, leases, clear: () => { scheduled.clear(); leases.clear(); } };
}

async function fixture(kind: "image" | "video" = "image", limit = 7) {
  const sql = await createIsolatedPostgres();
  const mock = cacheFixture();
  const user = randomUUID(), provider = randomUUID(), model = randomUUID();
  await sql.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,$2,'Pressure fixture','designer')", [user, `pressure-${user}`]);
  await sql.db.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Pressure fixture','apimart','https://provider.invalid/v1')", [provider]);
  await sql.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,concurrency_limit) VALUES($1,$2,'Pressure fixture',$3,ARRAY['generate','edit','batch','video'],$4)", [model, provider, kind === "image" ? "gpt-image-2.5-flare" : "wan2.7", limit]);
  await sql.db.query("UPDATE module_flags SET enabled=true");
  await sql.db.query("UPDATE tool_api_configurations SET enabled=true,model_config_id=$1 WHERE tool_key='image'", [model]);
  const input = (requestId = randomUUID()) => ({ requestId, userId: user, departmentId: null, projectId: "pressure-isolated", operationType: "image_generation", toolKey: "image", modelConfigId: model, prompt: "正常中文产品图 🔵 café", parameters: {}, sourceUrls: [], priority: "normal" as const, creditsEnabled: false, maxInflightTasks: 64 });
  const seedTask = async () => {
    const id = randomUUID();
    await sql.db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,model_config_id,prompt) VALUES($1,$2,$3,'pressure-isolated',$4,$5,$6)", [id, `request-${id}`, user, `${kind}_generation`, model, id]);
    await sql.db.query("INSERT INTO credit_reservations(request_id,user_id,operation_type,quantity,credits,rmb_cost,price_snapshot,status) VALUES($1,$2,$3,1,0,0,'{\"billingDisabled\":true}','held')", [`request-${id}`, user, `${kind}_generation`]);
    return id;
  };
  return { ...sql, ...mock, user, model, input, seedTask };
}

isolated("128 concurrent same-request admissions and 128 distinct admissions preserve dedup and 64 inflight cap", async () => {
  const f = await fixture();
  const started = performance.now();
  try {
    const first = f.input();
    const duplicates = await Promise.all(Array.from({ length: 128 }, () => enqueueTask(f.db, f.cache, structuredClone(first))));
    expect(new Set(duplicates.map(t => t.id)).size).toBe(1);
    expect(f.scheduled.size).toBe(1);
    const independent = await Promise.allSettled(Array.from({ length: 128 }, () => enqueueTask(f.db, f.cache, f.input())));
    expect(independent.filter(r => r.status === "fulfilled")).toHaveLength(63);
    const rejected = independent.filter(r => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(65);
    expect(rejected.every(r => r.reason.code === "USER_TASK_LIMIT_REACHED")).toBe(true);
    expect((await f.db.query("SELECT count(*)::int AS n,count(DISTINCT request_id)::int AS unique_n FROM tasks")).rows).toEqual([{ n: 64, unique_n: 64 }]);
    expect((await f.db.query("SELECT count(*)::int AS n FROM credit_reservations WHERE status='held'")).rows).toEqual([{ n: 64 }]);
    expect(f.scheduled.size).toBe(64);
    console.log(JSON.stringify({ pressure: "admission", calls: 256, peakCallers: 128, tasks: 64, duplicateCalls: 128, quotaRejected: 65, elapsedMs: Math.round(performance.now() - started) }));
  } finally { await f.close(); }
}, 120_000);

isolated("160 loopback HTTP requests: valid short/20000-char text and invalid boundary inputs reject before admission", async () => {
  const f = await fixture();
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((request: any, _response, next) => { request.auth = { id: f.user, role: "designer", status: "active", departmentId: null }; next(); });
  app.use("/api/tasks", createTasksRouter(f.db, f.cache, false, undefined, { maxInflightTasks: 100 }));
  app.use((error: any, _request: any, response: any, _next: any) => response.status(error.name === "ZodError" ? 400 : 500).json({ code: error.name }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const started = performance.now();
  try {
    const valid = Array.from({ length: 80 }, (_, i) => ({ ...f.input(), requestId: `http-valid-${i}-${randomUUID()}`, prompt: i % 2 ? "中".repeat(20_000) : "杯", sourceUrls: i % 4 ? [] : ["/api/assets/owned-placeholder/content"] }));
    const invalid = Array.from({ length: 80 }, (_, i) => ({ ...f.input(), requestId: `http-bad-${i}-${randomUUID()}`, ...[
      { prompt: "x".repeat(20_001) }, { sourceUrls: Array.from({ length: 51 }, () => "x") }, { sourceUrls: ["x".repeat(2001)] }, { requestId: "short" },
      { projectId: "" }, { modelConfigId: "not-uuid" }, { parameters: [] }, { priority: "override" },
    ][i % 8] }));
    const results = await Promise.all([...valid, ...invalid].map(async body => {
      const response = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      await response.json(); return response.status;
    }));
    expect(results.slice(0, 80).every(status => status === 201)).toBe(true);
    expect(results.slice(80).every(status => status === 400)).toBe(true);
    expect((await f.db.query("SELECT count(*)::int AS n,count(*) FILTER(WHERE length(prompt)=20000)::int AS long_n FROM tasks")).rows).toEqual([{ n: 80, long_n: 40 }]);
    expect((await f.db.query("SELECT count(*)::int AS n FROM credit_reservations")).rows).toEqual([{ n: 80 }]);
    console.log(JSON.stringify({ pressure: "loopback-http", calls: 160, peakCallers: 160, valid: 80, invalid: 80, longPromptCharacters: 20_000, elapsedMs: Math.round(performance.now() - started) }));
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await f.close(); }
}, 120_000);

test("2400 pure contract checks preserve single/batch cardinality and string boundaries", () => {
  const input = { requestId: "pressure-contract", projectId: "local", operationType: "image_generation" };
  for (let i = 0; i < 200; i++) {
    expect(taskSubmissionSchema.safeParse({ ...input, prompt: "中".repeat(20_000), sourceUrls: Array(50).fill("x".repeat(2000)) }).success).toBe(true);
    expect(taskSubmissionSchema.safeParse({ ...input, prompt: "中".repeat(20_001) }).success).toBe(false);
    expect(taskSubmissionSchema.safeParse({ ...input, requestId: "x".repeat(200) }).success).toBe(true);
    expect(taskSubmissionSchema.safeParse({ ...input, requestId: "x".repeat(201) }).success).toBe(false);
    expect(taskSubmissionSchema.safeParse({ ...input, requestId: "1234567" }).success).toBe(false);
    expect(taskSubmissionSchema.safeParse({ ...input, sourceUrls: Array(51).fill("x") }).success).toBe(false);
    expect(batchSubmissionSchema.safeParse({ ...input, items: Array(100).fill({ sourceUrls: Array(20).fill("x") }) }).success).toBe(true);
    expect(batchSubmissionSchema.safeParse({ ...input, items: Array(101).fill({ sourceUrls: ["x"] }) }).success).toBe(false);
    expect(batchSubmissionSchema.safeParse({ ...input, items: [{ sourceUrls: Array(21).fill("x") }] }).success).toBe(false);
    expect(batchSubmissionSchema.safeParse({ ...input, items: [{ sourceUrls: [] }] }).success).toBe(false);
    expect(batchSubmissionSchema.safeParse({ ...input, items: [] }).success).toBe(false);
    expect(taskSubmissionSchema.safeParse({ ...input, parameters: { quality: "high", nested: { label: "合法附加参数" } } }).success).toBe(true);
  }
});

test("640 media parameter/preflight checks use current supported video and image adapters", () => {
  const imageModels = ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.6-flare", "gemini-3.1-flash-image-preview"];
  for (let repeat = 0; repeat < 20; repeat++) {
    for (const modelId of imageModels) {
      expect(preflightApiMartImageRequest({ modelId, prompt: "红色手袋", parameters: { n: 1 } }).payload).toBeDefined();
      expect(() => preflightApiMartImageRequest({ modelId, prompt: " ", parameters: {} })).toThrow();
      expect(() => preflightApiMartImageRequest({ modelId, prompt: "合法描述", parameters: { n: 2 } })).toThrow();
      expect(() => preflightApiMartImageRequest({ modelId, prompt: "合法描述", parameters: { resolution: "64k" } })).toThrow();
    }
    for (const model of supportedVideoModelIds) {
      const cap = videoModelCapabilities[model];
      expect(preflightVideoTask({ model, prompt: "时装模特向前走一步", parameters: { seconds: cap.seconds[0] }, sources: [] }).normalized).toBeDefined();
      expect(preflightVideoTask({ model, prompt: "首帧服装保持不变", parameters: { seconds: cap.seconds[1] }, sources: [{ mimeType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]), publicUrl: "https://assets.example.test/owned.png" }] }).normalized).toBeDefined();
      expect(() => preflightVideoTask({ model, prompt: " ", sources: [] })).toThrow();
      expect(() => preflightVideoTask({ model, prompt: "合法描述", sources: [{ mimeType: "application/pdf", bytes: new Uint8Array([1, 2]), publicUrl: "https://assets.example.test/source.pdf" }] })).toThrow();
    }
  }
});

test("620 video/audio/image metadata boundary checks cover short/long, count, bytes, dimensions and mixed modes", () => {
  const image: ProviderVideoSource = { mimeType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]), width: 1024, height: 1024 };
  const video: ProviderVideoSource = { mimeType: "video/mp4", bytes: new Uint8Array([1]), width: 1280, height: 720, durationMs: 4000, fps: 30 };
  const audio: ProviderVideoSource = { mimeType: "audio/wav", bytes: new Uint8Array([1]), durationMs: 2000 };
  for (let repeat = 0; repeat < 20; repeat++) {
    expect(validateVideoSources("MiniMax-H3", { videoMode: "reference" }, [image, video, audio]).videos).toHaveLength(1);
    for (const durationMs of [2000, 15000]) expect(validateVideoSources("MiniMax-H3", { videoMode: "reference" }, [{ ...video, durationMs }]).videos).toHaveLength(1);
    for (const durationMs of [1999, 15001]) expect(() => validateVideoSources("MiniMax-H3", { videoMode: "reference" }, [{ ...video, durationMs }])).toThrow();
    for (const durationMs of [2000, 30000]) expect(validateVideoSources("doubao-seedance-2.5", { videoMode: "reference" }, [{ ...audio, durationMs }]).audios).toHaveLength(1);
    for (const durationMs of [1999, 30001]) expect(() => validateVideoSources("doubao-seedance-2.5", { videoMode: "reference" }, [{ ...audio, durationMs }])).toThrow();
    expect(validateVideoSources("wan2.7", { videoMode: "extend", seconds: 15 }, [{ ...video, durationMs: 10000 }, image]).mode).toBe("extend");
    expect(() => validateVideoSources("wan2.7", { videoMode: "extend", seconds: 5 }, [{ ...video, durationMs: 5000 }])).toThrow();
    expect(() => validateVideoSources("wan2.7", { videoMode: "extend", seconds: 15 }, [video, audio])).toThrow();
    expect(() => validateVideoSources("happyhorse-1.1", { videoMode: "reference" }, [video])).toThrow();
    expect(() => validateVideoSources("happyhorse-1.1", { videoMode: "reference" }, [audio])).toThrow();
    expect(() => validateVideoSources("MiniMax-H3", { videoMode: "reference" }, [audio])).toThrow();
    expect(() => validateVideoSources("MiniMax-H3", { videoMode: "first-frame" }, [image, audio])).toThrow();
    expect(() => validateVideoSources("MiniMax-H3", { videoMode: "reference" }, [video, { ...video, durationMs: 12000 }])).toThrow();
    expect(() => validateVideoSources("doubao-seedance-2.5", { videoMode: "reference" }, [{ ...audio, durationMs: 16000 }, { ...audio, durationMs: 16000 }])).toThrow();
    expect(() => validateVideoSources("wan2.7", {}, [image, image, image])).toThrow();
    expect(() => validateVideoSources("happyhorse-1.1", { videoMode: "first-frame" }, [{ ...image, width: 299 }])).toThrow();
    expect(() => validateVideoSources("MiniMax-H3", {}, [{ ...image, mimeType: "image/gif" }])).toThrow();
    expect(() => validateVideoSources("MiniMax-H3", { videoMode: "reference" }, [{ ...video, mimeType: "video/webm" }])).toThrow();
    expect(() => validateVideoSources("doubao-seedance-2.5", { videoMode: "reference" }, [{ ...audio, mimeType: "audio/flac" }])).toThrow();
    expect(() => validateVideoSources("MiniMax-H3", {}, [{ ...image, bytes: new Uint8Array() }])).toThrow();
    expect(() => validateVideoSources("MiniMax-H3", {}, [{ ...image, byteSize: 10 * 1024 * 1024 + 1 }])).toThrow();
    expect(() => validateVideoSources("MiniMax-H3", { videoMode: "reference" }, [{ ...video, byteSize: 50 * 1024 * 1024 + 1 }])).toThrow();
    expect(() => validateVideoSources("doubao-seedance-2.5", { videoMode: "reference" }, [{ ...audio, byteSize: 15 * 1024 * 1024 + 1 }])).toThrow();
    for (const fps of [0, 23, 61, Number.NaN]) expect(() => validateVideoSources("doubao-seedance-2.5", { videoMode: "reference" }, [{ ...video, fps }])).toThrow();
  }
});

isolated("128 recovery/cancel attempts cannot replay an unknown submitted task or release its held reservation", async () => {
  const f = await fixture();
  try {
    const id = await f.seedTask();
    await f.db.query("UPDATE tasks SET status='paused',attempts=1,upstream_submission_started_at=now(),model_slot_token=gen_random_uuid(),model_slot_expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    const before = (await f.db.query("SELECT id,request_id,status,attempts,upstream_submission_started_at,model_slot_token FROM tasks WHERE id=$1", [id])).rows;
    const attempts = await Promise.all(Array.from({ length: 128 }, (_, i) => transitionTask(f.db, f.cache, id, i % 2 ? "resume" : "cancel", false)));
    expect(attempts.every(value => value === null)).toBe(true);
    await restoreWaitingTasksToQueue(f.db, f.cache);
    expect((await f.db.query("SELECT id,request_id,status,attempts,upstream_submission_started_at,model_slot_token FROM tasks WHERE id=$1", [id])).rows).toEqual(before);
    expect((await f.db.query("SELECT status FROM credit_reservations")).rows).toEqual([{ status: "held" }]);
    expect(f.scheduled.size).toBe(0);
    console.log(JSON.stringify({ pressure: "unknown-recovery", calls: 128, resumed: 0, cancelled: 0, heldReservations: 1, providerPosts: 0 }));
  } finally { await f.close(); }
}, 120_000);

async function productionWorker(dependencies: Record<string, unknown>) {
  const file = await Bun.file(new URL("../src/worker.ts", import.meta.url)).text();
  const source = ts.createSourceFile("worker.ts", file, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const code = ["runTask", "deferTask", "assertTaskExecution", "executeApiMartVideo", "executeApiMartImage"].map(name => {
    const node = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
    if (!node) throw new Error(`Missing actual worker function ${name}`); return node.getText(source);
  }).join("\n");
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(dependencies), `${js}; async function executeProvider(task) { return task.operation_type === 'video_generation' ? executeApiMartVideo(task,{apiKey:'fixture-only'}) : executeApiMartImage(task,{apiKey:'fixture-only'},task.prompt); } return {runTask};`)(...Object.values(dependencies)) as { runTask(id: string): Promise<void> };
}

for (const kind of ["image", "video"] as const) isolated(`96 ${kind} tasks / 192 overlapping worker invocations: quota, interruption, pause/resume and one terminal record`, async () => {
  const f = await fixture(kind);
  const started = performance.now();
  const remote = new Map<string, { polls: number; complete: boolean }>();
  let posts = 0, inflight = 0, maxInflight = 0, loads = 0, workerCalls = 0;
  const fakeFetch = async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const id = JSON.parse(String(init.body)).prompt as string;
      expect(remote.has(id)).toBe(false); remote.set(id, { polls: 0, complete: false });
      posts++; inflight++; maxInflight = Math.max(maxInflight, inflight);
      return Response.json({ data: [{ task_id: id }] });
    }
    if (url.includes("/tasks/")) {
      const id = decodeURIComponent(url.split("/tasks/")[1]!); const task = remote.get(id)!;
      expect(task).toBeDefined();
      if (++task.polls < 2) return Response.json({ data: { status: "processing" } });
      if (!task.complete) { task.complete = true; inflight--; }
      return Response.json({ data: { status: "completed", result: kind === "image" ? { images: [{ url: `https://provider.invalid/files/${id}.png` }] } : { videos: [`https://provider.invalid/files/${id}.mp4`] } } });
    }
    if (url.includes("/files/")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } });
    throw new Error(`Forbidden fixture request ${url}`);
  };
  const worker = await productionWorker({
    db: f.db, cache: f.cache, randomUUID, TASK_LEASE_SECONDS, config: { TASK_MOCK_MODE: "false" },
    acquireModelLease, releaseModelLease, startTaskLeaseHeartbeat, TaskExecutionLost, withTransaction, settleReservation, scheduleQueuedTask,
    queueScore, canAutomaticallyRetryTask, recalculateBatch, VideoTaskPending, ApiMartImageTaskPending, VideoSubmissionClaimLost,
    VideoProviderFailure, ApiMartImageProviderFailure, ApiMartImageQueryRetryable, WorkflowTaskPending, PromptOptimizationError,
    ProviderSubmissionRejected, submissionWasNotSent, disposeProviderResults,
    createGenerationTiming: () => ({ measure: async (_stage: string, fn: () => unknown) => fn(), finish() {} }),
    readProviderSubmissionDiagnostics: () => undefined, storage: { configured: true },
    loadSourceAssets: async () => { loads++; return []; }, loadVideoSourceAssets: async () => { loads++; return []; },
    downloadVideoResult: (url: string) => downloadVideoResult(url, fakeFetch),
    stepApiMartVideoTask: (input: any) => stepApiMartVideoTask(input, { fetch: fakeFetch }),
    stepApiMartImageTask: (input: any) => stepApiMartImageTask(input, { fetch: fakeFetch }),
    fetchProviderResult: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }),
    storeResults: async (task: { id: string }) => [`/api/assets/${task.id}/content`],
  });
  const invoke = async (ids: string[]) => { workerCalls += ids.length; await Promise.all(ids.map(id => worker.runTask(id))); };
  try {
    const ids: string[] = [];
    for (let i = 0; i < 96; i++) ids.push(await f.seedTask());
    const paused = ids.slice(-4);
    for (const id of paused) expect(await transitionTask(f.db, f.cache, id, "pause", false)).not.toBeNull();
    await invoke([...ids, ...ids]);
    expect(posts).toBe(7); expect(inflight).toBe(7);
    expect((await f.db.query("SELECT count(*)::int AS n FROM tasks WHERE status='paused'")).rows).toEqual([{ n: 4 }]);
    const originals = (await f.db.query("SELECT id,request_id,upstream_task_id FROM tasks WHERE upstream_task_id IS NOT NULL ORDER BY id")).rows;
    f.clear();
    await f.db.query("UPDATE tasks SET execution_token=gen_random_uuid(),lease_expires_at=now()-interval '1 second',model_slot_expires_at=now()-interval '1 second' WHERE status='processing'");
    await restoreWaitingTasksToQueue(f.db, f.cache);
    // Simulate a query failure having paused a known upstream task, then use the real resume path.
    await f.db.query("UPDATE tasks SET status='paused' WHERE id=$1", [originals[0]!.id]);
    expect(await transitionTask(f.db, f.cache, originals[0]!.id, "resume", false)).not.toBeNull();
    for (const id of paused) expect(await transitionTask(f.db, f.cache, id, "resume", false)).not.toBeNull();
    for (let round = 0; round < 60; round++) {
      await f.db.query("UPDATE tasks SET available_at=now()-interval '1 millisecond' WHERE status IN ('waiting','processing') AND execution_token IS NULL");
      const pending = (await f.db.query("SELECT id FROM tasks WHERE status IN ('waiting','processing')")).rows.map(r => String(r.id));
      if (!pending.length) break;
      await invoke([...pending, ...pending]);
    }
    expect(maxInflight).toBe(7); expect(posts).toBe(96); expect(loads).toBe(96); expect(inflight).toBe(0);
    expect((await f.db.query("SELECT status,count(*)::int AS n,min(attempts)::int AS minimum,max(attempts)::int AS maximum FROM tasks GROUP BY status")).rows).toEqual([{ status: "success", n: 96, minimum: 1, maximum: 1 }]);
    expect((await f.db.query("SELECT id,request_id,upstream_task_id FROM tasks WHERE id=ANY($1::uuid[]) ORDER BY id", [originals.map(r => r.id)])).rows).toEqual(originals);
    expect((await f.db.query("SELECT count(*)::int AS n,count(DISTINCT task_id)::int AS unique_n FROM generation_history")).rows).toEqual([{ n: 96, unique_n: 96 }]);
    expect((await f.db.query("SELECT count(*)::int AS n FROM credit_reservations WHERE status='captured'")).rows).toEqual([{ n: 96 }]);
    expect((await f.db.query("SELECT count(*)::int AS n FROM tasks WHERE execution_token IS NOT NULL OR model_slot_token IS NOT NULL")).rows).toEqual([{ n: 0 }]);
    await invoke([...ids, ...ids]);
    expect(posts).toBe(96);
    expect((await f.db.query("SELECT count(*)::int AS n FROM generation_history")).rows).toEqual([{ n: 96 }]);
    console.log(JSON.stringify({ pressure: `worker-${kind}`, tasks: 96, peakCallers: 192, workerCalls, mockProviderPosts: posts, maxMockProviderInflight: maxInflight, pausedResumed: 5, terminalRecords: 96, elapsedMs: Math.round(performance.now() - started) }));
  } finally { await f.close(); }
}, 120_000);
