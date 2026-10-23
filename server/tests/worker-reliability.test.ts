import { expect, test } from "bun:test";
import ts from "typescript";
import { queueScore } from "../src/tasks";
import { renewTaskLease, TaskExecutionLost } from "../src/model-concurrency";
import { ProviderSubmissionRejected, isDefinitiveSubmissionRejection, submissionWasNotSent } from "../src/provider-submission-policy";
import { VideoProviderFailure, VideoSubmissionClaimLost, VideoTaskPending } from "../src/media-runtime";
import { ApiMartImageProviderFailure } from "../src/apimart-image";
import { buildOpenAiAudioRequest } from "../src/media-runtime";
import { normalizeWorkflowOutputs, readPath } from "../src/workflow-runtime";

const text = await Bun.file(new URL("../src/worker.ts", import.meta.url)).text();
const source = ts.createSourceFile("worker.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function productionFunctions(names: string[], dependencies: Record<string, unknown>, extra = "") {
  const code = names.map(name => {
    const node = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    if (!node) throw new Error(`Missing production function ${name}`);
    return node.getText(source);
  }).join("\n");
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), `${js}; return { ${names.join(",")}${extra} };`)(...Object.values(dependencies));
}

test("queue read failures back off and recover without ending the worker or losing a later task", async () => {
  const sleeps: number[] = [], processed: string[] = [], errors: string[] = [];
  let claims = 0;
  const activeTaskIds = new Set<string>();
  const worker = productionFunctions(["workerLoop"], {
    stopping: false, activeTaskIds,
    nextTask: async () => { if (++claims <= 3) throw new Error("Redis unavailable"); return "task-recovered"; },
    runTask: async (id: string) => { processed.push(id); expect(activeTaskIds.has(id)).toBe(true); worker.stop(); },
    Bun: { sleep: async (ms: number) => { sleeps.push(ms); } },
    console: { error: (message: string) => errors.push(message) },
  }, ", stop() { stopping = true; }");
  await worker.workerLoop();
  expect(processed).toEqual(["task-recovered"]);
  expect(sleeps).toEqual([500, 1000, 2000]);
  expect(errors).toHaveLength(3);
  expect(activeTaskIds.size).toBe(0);
});

test("stop waits for active task completion and prevents a second task claim", async () => {
  let complete!: () => void, started!: () => void, finished = false, claims = 0;
  const running = new Promise<void>(resolve => { started = resolve; });
  const activeTask = new Promise<void>(resolve => { complete = resolve; });
  const activeTaskIds = new Set<string>();
  const worker = productionFunctions(["workerLoop"], {
    stopping: false, activeTaskIds,
    nextTask: async () => { claims++; return "paid-task"; },
    runTask: async () => { started(); await activeTask; },
    Bun: { sleep: async () => {} }, console,
  }, ", stop() { stopping = true; }");
  const completion = worker.workerLoop().then(() => { finished = true; });
  await running;
  worker.stop();
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(activeTaskIds.size).toBe(1);
  complete();
  await completion;
  expect(finished).toBe(true);
  expect(claims).toBe(1);
  expect(activeTaskIds.size).toBe(0);
});

test("stop arriving during a queue pop does not start the popped task", async () => {
  let processed = false;
  const worker = productionFunctions(["workerLoop"], {
    stopping: false, activeTaskIds: new Set<string>(),
    nextTask: async () => { worker.stop(); return "durably-waiting"; },
    runTask: async () => { processed = true; }, Bun: { sleep: async () => {} }, console,
  }, ", stop() { stopping = true; }");
  await worker.workerLoop();
  expect(processed).toBe(false);
});

test("graceful shutdown is idempotent, stops reconciliation and enforces a bounded drain", () => {
  const scheduled: Array<{ callback: () => void; milliseconds: number }> = [];
  const cleared: unknown[] = [], exits: number[] = [];
  const worker = productionFunctions(["shutdown"], {
    stopping: false, queueReconciliationTimer: "reconcile-timer", shutdownTimer: undefined,
    activeTaskIds: new Set(["active"]), config: { WORKER_SHUTDOWN_GRACE_SECONDS: 1200 },
    console: { log() {}, error() {} }, process: { exit: (code: number) => exits.push(code) },
    clearInterval: (timer: unknown) => cleared.push(timer),
    setTimeout: (callback: () => void, milliseconds: number) => { scheduled.push({ callback, milliseconds }); return { unref() {} }; },
  });
  worker.shutdown("SIGTERM"); worker.shutdown("SIGINT");
  expect(cleared).toEqual(["reconcile-timer"]);
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0]!.milliseconds).toBe(1_200_000);
  expect(exits).toEqual([]);
  scheduled[0]!.callback();
  expect(exits).toEqual([1]);
});

test("startup reconciliation errors stay recoverable and do not prevent the next reconciliation", async () => {
  let calls = 0;
  const worker = productionFunctions(["reconcileTaskQueue"], {
    stopping: false, queueReconciliation: null, db: {}, cache: {}, console: { log() {}, error() {} },
    restoreWaitingTasksToQueue: async () => { if (++calls === 1) throw new Error("Redis unavailable"); return 2; },
  });
  await worker.reconcileTaskQueue();
  await worker.reconcileTaskQueue();
  expect(calls).toBe(2);
});

test("deferred tasks retain original queued_at priority while available_at controls eligibility", async () => {
  const calls: unknown[][] = [];
  const queuedAt = "2026-10-20T00:00:00.000Z", availableAt = "2026-10-24T00:00:00.000Z";
  const worker = productionFunctions(["deferTask"], {
    db: { query: async () => ({ rows: [{ available_at: availableAt }] }) }, cache: {}, queueScore, TaskExecutionLost,
    scheduleQueuedTask: async (...args: unknown[]) => { calls.push(args); },
  });
  await worker.deferTask({ id: "old-task", priority: "normal", queued_at: queuedAt, execution_token: "token" }, 2000, true);
  expect(calls[0]!.slice(1)).toEqual(["old-task", queueScore("normal", Date.parse(queuedAt)), Date.parse(availableAt)]);
});

test("Redis renewal failure does not invalidate a successfully fenced Postgres lease", async () => {
  let updated = false;
  const db = { query: async () => { updated = true; return { rows: [{ expires_ms: Date.now() + 180_000 }] }; } };
  const cache = { eval: async () => { throw new Error("Redis unavailable"); } };
  await renewTaskLease(db as any, cache as any, { taskId: "task", executionToken: "owner", modelConfigId: "model", slotToken: "slot" }, 180);
  expect(updated).toBe(true);
  await expect(renewTaskLease({ query: async () => ({ rows: [] }) } as any, cache as any,
    { taskId: "task", executionToken: "stale-owner", modelConfigId: "model", slotToken: "slot" }, 180)).rejects.toBeInstanceOf(TaskExecutionLost);
});

test("synchronous submission intent is durably fenced before POST and cannot be reclaimed", async () => {
  const statements: string[] = [];
  const worker = productionFunctions(["claimProviderSubmission"], {
    db: { query: async (sql: string) => { statements.push(sql); return { rows: [{ id: "task" }] }; } }, VideoSubmissionClaimLost,
  });
  const task = { id: "task", execution_token: "token", upstream_submission_started_at: null, upstream_task_id: null };
  await worker.claimProviderSubmission(task);
  expect(task.upstream_submission_started_at).not.toBeNull();
  expect(statements[0]).toContain("execution_token=$2");
  expect(statements[0]).toContain("lease_expires_at>now()");
  await expect(worker.claimProviderSubmission(task)).rejects.toThrow("不能重复提交");
  expect(statements).toHaveLength(1);
});

test.each(["image", "audio", "workflow"])("%s POST waits for the durable submission claim and cannot run after a lost claim", async kind => {
  for (const owned of [true, false]) {
    const events: string[] = [];
    const request = async () => {
      events.push("POST");
      expect(events).toEqual(["claim", "POST"]);
      return kind === "audio" ? new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } })
        : Response.json({ data: [{ url: "https://result.invalid/image.png" }], outputs: ["https://result.invalid/image.png"] });
    };
    const worker = productionFunctions(["executeProvider", "executeOpenAiAudio", "executeWorkflow", "claimProviderSubmission", "assertProviderSubmissionResponse"], {
      db: { query: async () => { events.push("claim"); return { rows: owned ? [{ id: "task" }] : [] }; } },
      config: { PROVIDER_ENCRYPTION_KEY: "test-only" }, decryptSecret: () => '{"apiKey":"test-only"}',
      assertImageEditMaskSupport: () => {}, openAiImageParameters: () => ({}), VideoSubmissionClaimLost,
      ProviderSubmissionRejected, isDefinitiveSubmissionRejection,
      fetchProviderSubmission: request, fetch: request, fetchProviderResult: async () => ({ bytes: new Uint8Array([1]), mimeType: "image/png" }),
      buildOpenAiAudioRequest, loadSourceAssets: async () => [], parsePromptVariables: () => ({}),
      renderTemplate: () => ({ n: 1 }), singleImageWorkflowRequestBody: (_task: unknown, body: unknown) => body,
      isImageWorkflowTask: () => true, normalizeWorkflowOutputs, readPath,
      joinUrl: (base: string, path: string) => base + path,
    });
    const task = { id: "task", execution_token: "owner", protocol: "openai", base_url: "https://provider.invalid/v1", model_id: "gpt-image-2",
      operation_type: kind === "audio" ? "audio_generation" : "image_generation", prompt: "test", parameters: {}, source_urls: [], encrypted_credentials: "test-only",
      ...(kind === "workflow" ? { workflow_config_id: "workflow", submit_path: "/workflow", output_path: "outputs" } : {}),
    };
    const result = worker.executeProvider(task, { measure: async (_label: string, action: () => unknown) => action() });
    if (owned) { await result; expect(events).toEqual(["claim", "POST"]); }
    else { await expect(result).rejects.toBeInstanceOf(VideoSubmissionClaimLost); expect(events).toEqual(["claim"]); }
  }
});

test.each(["network", "http_started", "initial_tls", "rejected"])("paid submission outcome %s preserves or settles the original reservation correctly", async phase => {
  const task = { id: "task", request_id: "request", operation_type: "image_generation", attempts: 1, model_config_id: "model",
    upstream_submission_started_at: "started", upstream_task_id: null, execution_token: "token", batch_id: null };
  let releasedSlots = 0;
  const settlements: string[] = [], statements: string[] = [], outcomes: string[] = [];
  const error = phase === "rejected" ? new ProviderSubmissionRejected("Provider rejected")
    : phase === "network" ? new Error("connection interrupted")
    : Object.assign(new Error("transport failure"), { code: "PROVIDER_CONNECTION_ERROR", phase });
  const db = { query: async (sql: string) => { statements.push(sql); return { rows: [task] }; } };
  const worker = productionFunctions(["runTask"], {
    db, cache: {}, randomUUID: () => "token", TASK_LEASE_SECONDS: 180, config: { TASK_MOCK_MODE: "false" },
    acquireModelLease: async () => ({}), releaseModelLease: async () => { releasedSlots++; },
    startTaskLeaseHeartbeat: () => ({ assertOwned() {}, stop: async () => {} }),
    createGenerationTiming: () => ({ measure: async (_name: string, run: () => unknown) => run(), finish: (outcome: string) => outcomes.push(outcome) }),
    executeProvider: async () => { throw error; }, VideoTaskPending, VideoSubmissionClaimLost, TaskExecutionLost,
    VideoProviderFailure, ApiMartImageProviderFailure, ProviderSubmissionRejected, submissionWasNotSent,
    readProviderSubmissionDiagnostics: () => undefined, canAutomaticallyRetryTask: () => false,
    withTransaction: async (_db: unknown, action: (client: unknown) => Promise<unknown>) => action(db),
    settleReservation: async (_db: unknown, _request: string, action: string) => { settlements.push(action); },
  });
  await worker.runTask("task");
  const unknown = phase === "network" || phase === "http_started";
  expect(settlements).toEqual(unknown ? [] : ["release"]);
  expect(releasedSlots).toBe(unknown ? 0 : 1);
  expect(outcomes).toEqual([unknown ? "paused" : "failed"]);
  expect(statements.some(sql => sql.includes("status='paused'"))).toBe(unknown);
});

test("only explicit HTTP rejections settle failed submissions, never timeouts, conflicts or server errors", async () => {
  const worker = productionFunctions(["assertProviderSubmissionResponse"], { ProviderSubmissionRejected, isDefinitiveSubmissionRejection });
  for (const status of [400, 401, 403, 422, 429]) {
    await expect(worker.assertProviderSubmissionResponse(new Response("secret", { status }), "Provider")).rejects.toBeInstanceOf(ProviderSubmissionRejected);
  }
  for (const status of [408, 409, 500, 502, 503]) {
    const error = await worker.assertProviderSubmissionResponse(new Response("secret", { status }), "Provider").catch((error: Error) => error);
    expect(error).not.toBeInstanceOf(ProviderSubmissionRejected);
    expect(error.message).not.toContain("secret");
  }
});
