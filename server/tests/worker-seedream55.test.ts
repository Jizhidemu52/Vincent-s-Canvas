import { expect, test } from "bun:test";
import ts from "typescript";
import { ApiMartImageQueryRetryable, ApiMartImageTaskPending } from "../src/apimart-image";
import { parseSeedream55Manifest, seedream55PublicDocument, Seedream55OutputLimitExceeded } from "../src/seedream55-image";
import { storeSeedream55TaskResults } from "../src/seedream55-worker-storage";

const worker = await Bun.file(new URL("../src/worker.ts", import.meta.url)).text();
const source = ts.createSourceFile("worker.ts", worker, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function workerFunction(name: string, dependencies: Record<string, unknown>) {
  const node = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)!;
  const code = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(dependencies), `${code};return ${name}`)(...Object.values(dependencies));
}
const manifest = parseSeedream55Manifest({ data: { result: { images: [{ url: ["https://cdn.example.com/base.png", "https://cdn.example.com/layer.png"] }] } } }, true);
const task = () => ({ id: "task-one", request_id: "request-one", user_id: "alice", tool_key: "layer-studio", model_id: "seedream-5-5", model_config_id: "model-one", base_url: "https://example.com/v1",
  operation_type: "image_generation", prompt: "", parameters: { layer_decomposition: true, n: 1 }, source_urls: ["/api/assets/input/content"], execution_token: "execution-one",
  upstream_task_id: "upstream-one", upstream_submission_started_at: "started", poll_deadline_at: new Date(Date.now() + 60_000).toISOString(), attempts: 1,
  upstream_result_document: null as typeof manifest | null, result_document: null as ReturnType<typeof seedream55PublicDocument> | null });
class TaskExecutionLost extends Error {}

test("actual Worker adapter checkpoints private and public manifests before any output download", async () => {
  const current = task();
  const calls: string[] = [];
  const execute = workerFunction("executeApiMartImage", {
    loadSourceAssets: () => { throw new Error("must not reload a submitted task"); },
    stepApiMartImageTask: async (input: Record<string, unknown>) => { expect(input.upstreamTaskId).toBe("upstream-one"); calls.push("query"); return { status: "completed", manifest }; },
    db: { query: async (sql: string, values: unknown[]) => {
      expect(sql).toContain("upstream_result_document IS NULL"); expect(sql).toContain("execution_token=$5");
      expect(JSON.parse(values[0] as string)).toEqual(manifest);
      expect(values.slice(2)).toEqual([current.id, current.user_id, current.execution_token]);
      expect(values[1]).not.toContain("cdn.example.com"); calls.push("checkpoint"); return { rows: [{ id: current.id }] };
    } }, seedream55PublicDocument, TaskExecutionLost, ApiMartImageTaskPending, ApiMartImageQueryRetryable,
    fetchProviderResult: () => { throw new Error("must save originals only after manifest checkpoint"); },
  });
  expect(await execute(current, { apiKey: "fixture-only" }, "")).toEqual([]);
  expect(calls).toEqual(["query", "checkpoint"]); expect(current.upstream_result_document).toEqual(manifest);
  expect(current.result_document?.status).toBe("persisting");
});

function resumeHarness(failure?: Error) {
  const current = task(); current.upstream_result_document = manifest;
  const document = seedream55PublicDocument(current.id, manifest);
  document.status = "ready";
  document.items = document.items.map((item, index) => ({ ...item, state: "saved", contentUrl: `/api/assets/saved-${index}/content`, width: index ? 256 : 1200, height: index ? 128 : 900 }));
  const events: string[] = [];
  const failures: string[] = [];
  const db = { query: async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("SELECT t.id")) return { rows: [current] };
    if (sql.includes("RETURNING attempts")) return { rows: [{ attempts: 1 }] };
    if (sql.includes("status='success'")) events.push("success");
    if (sql.includes("status='paused'")) { events.push("paused"); failures.push(String(values?.[0])); }
    return { rows: [{ id: current.id }] };
  } };
  const run = workerFunction("runTask", {
    randomUUID: () => "execution-one", db, cache: {}, storage: {}, TASK_LEASE_SECONDS: 120,
    acquireModelLease: async () => ({}), startTaskLeaseHeartbeat: () => ({ assertOwned() {}, stop: async () => {} }),
    createGenerationTiming: () => ({ measure: async (_name: string, action: () => Promise<unknown>) => action(), finish() {} }),
    config: { TASK_MOCK_MODE: "false" }, assertTaskExecution: async () => {},
    executeProvider: () => { throw new Error("must not query or submit when durable manifest exists"); },
    storeSeedream55TaskResults: async (_db: unknown, _storage: unknown, storedTask: typeof current, storedManifest: typeof manifest) => {
      expect(storedTask.id).toBe(current.id); expect(storedManifest).toBe(manifest); events.push("save"); if (failure) throw failure; return document;
    },
    withTransaction: async (_db: unknown, action: (client: typeof db) => Promise<unknown>) => action(db),
    settleLayerStudioReservation: async (_db: unknown, requestId: string, outputs: unknown) => {
      expect(requestId).toBe(current.request_id); expect(outputs).toEqual([{ width: 1200, height: 900 }, { width: 256, height: 128 }]); events.push("settle");
    },
    disposeProviderResults: async () => [], releaseModelLease: async () => {}, TaskExecutionLost, Seedream55OutputLimitExceeded,
    VideoTaskPending: class extends Error {}, WorkflowTaskPending: class extends Error {}, VideoSubmissionClaimLost: class extends Error {}, ApiMartImageTaskPending,
    readProviderSubmissionDiagnostics: () => null,
  });
  return { run, current, events, failures };
}

test("actual Worker resumes saved manifest without provider/credentials and settles only saved actual dimensions", async () => {
  const { run, current, events } = resumeHarness();
  await run(current.id); expect(events).toEqual(["save", "settle", "success"]);
});

test("actual Worker pauses an interrupted original save without replay, charge or release", async () => {
  const { run, current, events, failures } = resumeHarness(new Error("interrupted original download"));
  await run(current.id); expect(events).toEqual(["save", "paused"]);
  expect(failures[0]).toContain("可恢复原任务继续保存"); expect(failures[0]).not.toContain("不能直接恢复");
});

test("request limit 4 versus receipt 100 is rejected before download and stays paused on original-task recovery", async () => {
  const received = parseSeedream55Manifest({ data: { result: { images: [{ url: Array.from({ length: 100 }, (_, index) => `https://cdn.example.com/${index}.png`) }] } } }, true);
  const current = { ...task(), parameters: { layer_decomposition: true, layer_decomposition_options: { max_images: 4 } } };
  let downloads = 0, databaseCalls = 0, violation: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await storeSeedream55TaskResults({ query: async () => { databaseCalls++; return { rows: [] }; } } as never, { configured: true } as never,
        { ...current, department_id: null, project_id: "fixture" }, received, seedream55PublicDocument(current.id, received), { download: async () => { downloads++; throw new Error("must not download"); } });
    } catch (error) { violation = error; }
    expect(violation).toBeInstanceOf(Seedream55OutputLimitExceeded);
  }
  expect(downloads).toBe(0); expect(databaseCalls).toBe(0); expect(received.items).toHaveLength(100);
  const h = resumeHarness(violation as Error); await h.run(h.current.id);
  expect(h.events).toEqual(["save", "paused"]); expect(h.failures[0]).toContain("原任务上限 4"); expect(h.failures[0]).toContain("保留原回执");
});
