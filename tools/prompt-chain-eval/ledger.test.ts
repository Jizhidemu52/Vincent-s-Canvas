import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { EvalLedger, executeAttempt, costOf, defaultAllocation, sha256 } from "./ledger";
import { buildJobs, starterConfig } from "./cases";
import { ApplicationClient, EvaluationTransport, validateImageParameters, sourceEvidence, repoRoot, main, preflight } from "../prompt-chain-eval";
import { promptCompilationRequestSchema } from "../../shared/prompt-contracts";
import { taskSubmissionSchema, taskResponseSchema } from "../../shared/task-contracts";
import { preflightApiMartImageRequest } from "../../server/src/apimart-image";

const directories: string[] = [];
async function temporary() { const directory = await mkdtemp(resolve(tmpdir(), "prompt-chain-eval-test-")); directories.push(directory); return { directory, path: resolve(directory, "budget.sqlite") }; }
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const allSingle = { single: 100, sequence: 0, reserve: 0 };

test("plan is exactly 80 single + 12 sequential + 8 reserved, without generating extra jobs", () => {
  const config = starterConfig(), jobs = buildJobs(config);
  expect(jobs.filter(job => job.group === "single")).toHaveLength(80);
  expect(jobs.filter(job => job.group === "sequence")).toHaveLength(12);
  expect(jobs).toHaveLength(92);
  expect(config.allocation).toEqual(defaultAllocation);
  expect(config.samples).toHaveLength(10);
  expect(config.samples.every(sample => sample.sources.every(source => !source.approvedForEvaluation && source.provenance.includes("Synthetic")))).toBe(true);
  const original = jobs.find(job => job.round === 3 && job.key.includes("garment-color"))!;
  expect(original.sample.sources[0]!.fromAttempt).toBeUndefined();
  expect(original.sample.fields.change).toBe(original.sample.userText);
  expect(original.sample.userText).toContain("不保留上一轮海军蓝领口");
});

test("rejects excess allocation, changing allocation, and any multi-image or arbitrary parameter", async () => {
  const { path } = await temporary();
  expect(() => new EvalLedger(path, { single: 101, sequence: 0, reserve: 0 })).toThrow("INVALID_ALLOCATION");
  const ledger = new EvalLedger(path, allSingle); ledger.close();
  expect(() => new EvalLedger(path, defaultAllocation)).toThrow("ALLOCATION_CHANGED_EXISTING_BUDGET");
  for (const parameters of [{ n: 2 }, { n: 1, count: 2 }, { n: 1, batch: 2 }, { n: 1, apiKey: "not-real" }, { n: 1, quality: {} }])
    expect(() => validateImageParameters(parameters)).toThrow("ONLY_ONE_IMAGE_PARAMETERS_ALLOWED");
  expect(() => validateImageParameters({ n: 1, size: "1024x1024", quality: "auto" })).not.toThrow();
});

test("all outcomes occupy one immutable slot; new campaign names cannot reset the hard cap", async () => {
  const { path } = await temporary(), ledger = new EvalLedger(path, allSingle);
  try {
    for (let index = 0; index < 100; index++) { const key = `${index < 50 ? "run-a" : "run-b"}:${index}`; ledger.reserve(key, "single", { index }); ledger.mark(key, index % 3 === 0 ? "success" : index % 3 === 1 ? "failed" : "uncertain"); }
    expect(ledger.report().reservedImageAttempts).toBe(100);
    expect(() => ledger.reserve("retry-101", "single", {})).toThrow("IMAGE_BUDGET_EXHAUSTED");
    expect(ledger.reserve("run-a:0", "single", { index: 0 }).created).toBe(false);
    expect(() => ledger.reserve("run-a:0", "single", { index: 1 })).toThrow("ATTEMPT_INPUT_CHANGED");
    const db = new Database(path);
    try { expect(() => db.exec("DELETE FROM attempts")).toThrow("ATTEMPT_IMMUTABLE"); expect(() => db.exec("UPDATE budget SET max_images=101")).toThrow("BUDGET_IMMUTABLE"); }
    finally { db.close(); }
  } finally { ledger.close(); }
});

test("group caps and explicit retry share the same total accounting", async () => {
  const { path } = await temporary(), ledger = new EvalLedger(path, { single: 1, sequence: 1, reserve: 1 });
  try {
    ledger.reserve("initial", "single", {}); ledger.mark("initial", "failed");
    expect(() => ledger.reserve("silent-retry", "single", {})).toThrow("GROUP_BUDGET_EXHAUSTED");
    ledger.reserve("explicit-retry", "reserve", { retryOf: "initial" });
    ledger.reserve("seq", "sequence", {});
    expect(ledger.report().reservedImageAttempts).toBe(3);
    expect(() => ledger.reserve("more", "reserve", {})).toThrow("IMAGE_BUDGET_EXHAUSTED");
  } finally { ledger.close(); }
});

async function worker(path: string, prefix: string, count: number, same?: string) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "test-worker.ts"), path, prefix, String(count), ...(same ? [same] : [])], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}
test("8 independent processes race for 160 slots: exactly 100 survive and no process resets the counter", async () => {
  const { path } = await temporary(), initial = new EvalLedger(path, allSingle); initial.close();
  const workers = await Promise.all(Array.from({ length: 8 }, (_, index) => worker(path, `worker${index}`, 20)));
  expect(workers.map(w => ({ code: w.exitCode, error: w.stderr }))).toEqual(Array.from({ length: 8 }, () => ({ code: 0, error: "" })));
  expect(workers.reduce((sum, w) => sum + JSON.parse(w.stdout).created, 0)).toBe(100);
  const ledger = new EvalLedger(path, allSingle);
  try { expect(ledger.report().reservedImageAttempts).toBe(100); expect(new Set(ledger.list().map(row => row.requestId)).size).toBe(100); } finally { ledger.close(); }
}, 30_000);

test("same attempt in competing processes creates a single durable requestId", async () => {
  const { path } = await temporary(), initial = new EvalLedger(path, allSingle); initial.close();
  const workers = await Promise.all(Array.from({ length: 6 }, (_, index) => worker(path, `same${index}`, 1, "same")));
  expect(workers.every(worker => worker.exitCode === 0)).toBe(true);
  expect(workers.reduce((sum, w) => sum + JSON.parse(w.stdout).created, 0)).toBe(1);
  const ledger = new EvalLedger(path, allSingle); try { expect(ledger.list()).toHaveLength(1); } finally { ledger.close(); }
}, 30_000);

test("hard crash after durable reservation resumes query-only, even though image POST never began", async () => {
  const { path } = await temporary();
  const exited = await worker(path, "crash", 1, "crash"); expect(exited.exitCode).toBe(19);
  const ledger = new EvalLedger(path, allSingle); let submits = 0, queries = 0;
  try {
    const id = ledger.get("shared-attempt")!.requestId;
    await executeAttempt(ledger, "shared-attempt", "single", { fixture: "offline", index: 0 }, { submit: async () => { submits++; }, query: async attempt => { queries++; expect(attempt.requestId).toBe(id); } });
    expect(submits).toBe(0); expect(queries).toBe(1); expect(ledger.report().reservedImageAttempts).toBe(1);
  } finally { ledger.close(); }
});

test("network exception, explicit failure, and restart do not repeat submissions", async () => {
  const { path } = await temporary(); let submits = 0, queries = 0;
  let ledger = new EvalLedger(path, allSingle);
  const transport = { submit: async () => { submits++; throw new Error("SIMULATED_TIMEOUT"); }, query: async () => { queries++; } };
  await executeAttempt(ledger, "timeout", "single", { userText: "原话" }, transport); ledger.close();
  ledger = new EvalLedger(path, allSingle);
  try {
    await executeAttempt(ledger, "timeout", "single", { userText: "原话" }, transport);
    ledger.mark("timeout", "failed");
    await executeAttempt(ledger, "timeout", "single", { userText: "原话" }, transport);
    expect(submits).toBe(1); expect(queries).toBe(2); expect(ledger.report().reservedImageAttempts).toBe(1);
  } finally { ledger.close(); }
});

test("unknown costs remain null and currencies are never merged", async () => {
  const { path } = await temporary(), ledger = new EvalLedger(path, allSingle);
  try {
    ledger.reserve("unknown", "single", {}); ledger.reserve("cny", "single", {}); ledger.reserve("usd", "single", {});
    ledger.mark("cny", "success", { imageCost: costOf({ actualCost: 0.5, currency: "CNY" }) });
    ledger.mark("usd", "success", { imageCost: costOf({ actualCost: 1, currency: "USD" }) });
    expect(costOf()).toEqual({ actual: null, estimated: null, currency: null });
    expect(ledger.report().images).toEqual({ knownActualByCurrency: { CNY: 0.5, USD: 1 }, unknownCount: 1 });
  } finally { ledger.close(); }
});

test("reserve is committed with user/model/source evidence before transport sees it", async () => {
  const { path } = await temporary(), ledger = new EvalLedger(path, allSingle), input = { userText: "不要增加纽扣", strategy: "raw", model: "fixture", parameters: { n: 1 }, sourceSha256: "a".repeat(64) };
  try {
    await executeAttempt(ledger, "evidence", "single", input, { submit: async attempt => {
      const independent = new EvalLedger(path, allSingle);
      try { expect(independent.get("evidence")!.input).toEqual(input); expect(independent.get("evidence")!.requestId).toBe(attempt.requestId); expect(independent.report().reservedImageAttempts).toBe(1); } finally { independent.close(); }
    }, query: async () => {} });
  } finally { ledger.close(); }
});

test("real API adapter: ambiguous POST + 404 and recovery never POST twice; no credentials persist", async () => {
  const { path, directory } = await temporary(), ledger = new EvalLedger(path, allSingle), config = starterConfig();
  const calls: string[] = [];
  const client = new ApplicationClient("http://127.0.0.1:13100", "private-session-not-real", async (url: any, init: any) => {
    const route = new URL(url).pathname, method = init.method || "GET"; calls.push(`${method} ${route}`);
    if (route === "/api/assets/upload-request") return Response.json({ assetId: "fixture-asset" });
    if (route === "/api/tasks" && method === "POST") throw new Error("connection lost after server accepted");
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  });
  const transport = new EvaluationTransport(config, client, ledger, directory), job = buildJobs(config)[0]!;
  try {
    const input = await transport.prepare(job);
    await executeAttempt(ledger, "api-unknown", "single", input, transport);
    await transport.query(ledger.get("api-unknown")!);
    expect(calls.filter(call => call === "POST /api/tasks")).toHaveLength(1);
    expect(calls.filter(call => call.startsWith("GET /api/tasks/by-request/"))).toHaveLength(2);
    expect(ledger.get("api-unknown")!.status).toBe("uncertain");
    expect(JSON.stringify(ledger.report())).not.toContain("private-session");
    expect(ledger.report().images.unknownCount).toBe(1);
  } finally { ledger.close(); }
});

test("reference bytes get SHA, and cross-origin cookies never leave the application", async () => {
  const source = await sourceEvidence(starterConfig().samples[0]!.sources[0]!);
  expect(source.sha256).toMatch(/^[a-f0-9]{64}$/); expect(source.bytes).toBeGreaterThan(10);
  const calls: any[] = [], client = new ApplicationClient("http://127.0.0.1:13100", "private-session", async (url: any, init: any) => { calls.push(init); return new Response(new Uint8Array([1])); });
  await client.bytes("https://example.invalid/image.png");
  expect(calls[0].headers.cookie).toBeUndefined();
  await expect(client.bytes("https://example.invalid/upload", "PUT", new Uint8Array([1]))).rejects.toThrow("CROSS_ORIGIN_UPLOAD_BLOCKED");
  await expect(client.api("https://example.invalid/api/tasks", "POST", {})).rejects.toThrow("CROSS_ORIGIN_AUTH_BLOCKED");
});

test("questions from compilation stop generation; deterministic result is not counted as an LLM call", async () => {
  const { path, directory } = await temporary(), ledger = new EvalLedger(path, allSingle), config = starterConfig();
  const job = buildJobs(config).find(job => job.strategy === "template")!;
  config.recipes[job.sample.scene]!.template = { versionId: "11111111-1111-4111-8111-111111111111", expectedExecutionStrategy: "template-first" };
  const calls: string[] = [];
  const client = new ApplicationClient("http://127.0.0.1:13100", "", async (url: any, init: any) => {
    const route = new URL(url).pathname; calls.push(`${init.method} ${route}`);
    if (route === "/api/assets/upload-request") return Response.json({ assetId: "fixture" });
    if (route.endsWith("/test")) return Response.json({ compilation: { id: "compilation-fixture", status: "success", prompt: "需要确认", method: "template", questions: ["哪个区域？"] } });
    if (route.includes("/compilations/")) return Response.json({ compilation: { recipeVersionId: config.recipes[job.sample.scene]!.template!.versionId, targetModelConfigId: job.model.modelConfigId, cacheHit: false } });
    throw new Error("UNEXPECTED_ROUTE");
  });
  const transport = new EvaluationTransport(config, client, ledger, directory);
  try {
    await executeAttempt(ledger, "question", "single", await transport.prepare(job), transport);
    expect(calls.some(call => call === "POST /api/tasks")).toBe(false);
    expect(ledger.get("question")!.status).toBe("failed");
    expect(ledger.report().confirmedPlanningModelCalls).toBe(0);
    expect(ledger.report().unknownPlanningCallCount).toBe(0);
    expect(ledger.get("question")!.evidence.actualMethod).toBe("template");
  } finally { ledger.close(); }
});

test("success archives exact original bytes/SHA, never stores signed URLs, and recovery is read-only", async () => {
  const { path, directory } = await temporary(), ledger = new EvalLedger(path, allSingle), config = starterConfig(), job = buildJobs(config)[0]!;
  const bytes = await readFile(resolve(repoRoot, job.sample.sources[0]!.path));
  const calls: string[] = [];
  let originalRequestId = "";
  const client = new ApplicationClient("http://127.0.0.1:13100", "", async (url: any, init: any) => {
    const route = new URL(url).pathname; calls.push(`${init.method} ${route}`);
    if (route === "/api/assets/upload-request") return Response.json({ assetId: "fixture" });
    if (route === "/api/tasks") { originalRequestId = JSON.parse(init.body).requestId; return Response.json({ task: { id: "fixture-task" } }); }
    if (route.startsWith("/api/tasks/by-request/")) return Response.json({ task: { id: "fixture-task", requestId: originalRequestId, modelConfigId: job.model.modelConfigId,
      status: "success", prompt: job.sample.userText, parameters: config.parameters, rmbCost: 0.3, resultUrls: ["/result.png?token=SIGNED_PRIVATE"],
      startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z" } });
    if (route === "/result.png") return new Response(bytes, { headers: { "content-type": "image/png" } });
    throw new Error("UNEXPECTED_ROUTE");
  });
  const transport = new EvaluationTransport(config, client, ledger, directory);
  try {
    const input = await transport.prepare(job); await executeAttempt(ledger, "success", "single", input, transport);
    const saved = ledger.get("success")!;
    expect(saved.status).toBe("success"); expect(saved.evidence.outputs[0].sha256).toBe(sha256(bytes));
    expect(sha256(await readFile(resolve(repoRoot, saved.evidence.outputs[0].path)))).toBe(sha256(bytes));
    expect(saved.evidence.taskDurationMs).toBe(1000); expect(saved.evidence.imageCost.actual).toBeNull(); expect(saved.evidence.applicationChargeRmb).toBe(0.3);
    const before = calls.length; await transport.query(saved);
    expect(calls.slice(before).every(call => call.startsWith("GET "))).toBe(true);
    expect(calls.filter(call => call === "POST /api/tasks")).toHaveLength(1);
    expect(JSON.stringify(ledger.report())).not.toContain("SIGNED_PRIVATE");
  } finally { ledger.close(); }
});

test("uncertain compilation is queried by original request and never automatically compiled or generated again", async () => {
  const { path, directory } = await temporary(), ledger = new EvalLedger(path, allSingle), config = starterConfig();
  const job = buildJobs(config).find(job => job.strategy === "minimal")!, calls: string[] = [];
  const client = new ApplicationClient("http://127.0.0.1:13100", "", async (url: any, init: any) => {
    const route = new URL(url).pathname; calls.push(`${init.method} ${route}`);
    if (route === "/api/assets/upload-request") return Response.json({ assetId: "fixture" });
    if (route.endsWith("/test")) throw new Error("SIMULATED_TIMEOUT");
    return Response.json({}, { status: 404 });
  });
  const transport = new EvaluationTransport(config, client, ledger, directory);
  try {
    const input = await transport.prepare(job); await executeAttempt(ledger, "compile-timeout", "single", input, transport);
    await transport.query(ledger.get("compile-timeout")!);
    expect(calls.filter(call => call.startsWith("POST ") && call.endsWith("/test"))).toHaveLength(1);
    expect(calls.some(call => call === "POST /api/tasks")).toBe(false);
    expect(calls.filter(call => call.startsWith("GET /api/prompt-compilations/by-request/"))).toHaveLength(2);
    expect(ledger.report().reservedImageAttempts).toBe(1); expect(ledger.report().planning.unknownCount).toBe(1);
  } finally { ledger.close(); }
});

test("CLI refuses a run without --execute before any network request or budget creation", async () => {
  const { directory } = await temporary(), originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(async () => { calls++; throw new Error("NETWORK_MUST_NOT_RUN"); }, { preconnect: originalFetch.preconnect }) as typeof fetch;
  try { await expect(main(["run", "--config", resolve(directory, "missing.json")])).rejects.toThrow("EXECUTE_FLAG_REQUIRED"); expect(calls).toBe(0); }
  finally { globalThis.fetch = originalFetch; }
});

const formalModel = { id: "11111111-1111-4111-8111-111111111111", modelId: "gpt-image-2.6-flare", enabled: true, providerEnabled: true, capabilities: ["edit"] };
const formalVersions = { template: "22222222-2222-4222-8222-222222222222", minimal: "33333333-3333-4333-8333-333333333333", legacy: "44444444-4444-4444-8444-444444444444" };
function formalConfig() {
  const config = starterConfig();
  config.approvedForPaidExecution = true;
  config.models = [{ key: "model-a", modelConfigId: formalModel.id, expectedModelId: formalModel.modelId }];
  for (const sample of config.samples) for (const source of sample.sources) source.approvedForEvaluation = true;
  for (const recipes of Object.values(config.recipes)) for (const strategy of ["template", "minimal", "legacy"] as const) recipes[strategy]!.versionId = formalVersions[strategy];
  return config;
}

test("preflight verifies real admin identity while public catalog legitimately masks modelId as UUID", async () => {
  const { path } = await temporary(), ledger = new EvalLedger(path), config = formalConfig(), calls: string[] = [];
  const selected = buildJobs(config).filter(job => job.sample.id === "garment-color" && job.group === "single");
  const client = new ApplicationClient(config.apiOrigin, "mock-admin-cookie", async (url: any, init: any) => {
    const route = new URL(url).pathname; calls.push(`${init.method} ${route}`);
    if (route === "/api/auth/session") return Response.json({ user: { id: "owner", role: "super_admin" } });
    if (route === "/api/models") return Response.json({ models: [{ id: formalModel.id, modelId: formalModel.id, capabilities: ["edit"] }], tools: ["image-edit", "creative-garment-colorway"].map(toolKey => ({ toolKey, enabled: true, modelConfigId: null })) });
    if (route === "/api/admin/model-configuration/models") return Response.json({ models: [formalModel] });
    if (route === "/api/admin/prompt-recipes/garment-colorway") return Response.json({ versions: [
      { id: formalVersions.template, executionStrategy: "template-first" }, { id: formalVersions.minimal, executionStrategy: "minimal" }, { id: formalVersions.legacy },
    ] });
    throw new Error("UNEXPECTED_ROUTE");
  });
  try {
    await preflight(config, selected, client, ledger);
    expect(calls.filter(call => call === "GET /api/admin/model-configuration/models")).toHaveLength(1);
    expect(calls.filter(call => call === "GET /api/admin/prompt-recipes/garment-colorway")).toHaveLength(1);
    expect(calls.every(call => call.startsWith("GET "))).toBe(true);
    expect(ledger.report().reservedImageAttempts).toBe(0);
  } finally { ledger.close(); }
});

test.each([
  { label: "wrong upstream model", admin: { ...formalModel, modelId: "wrong-model" }, visible: true, publicEdit: true, enabledTool: true },
  { label: "disabled admin model", admin: { ...formalModel, enabled: false }, visible: true, publicEdit: true, enabledTool: true },
  { label: "disabled provider", admin: { ...formalModel, providerEnabled: false }, visible: true, publicEdit: true, enabledTool: true },
  { label: "admin identity absent", admin: null, visible: true, publicEdit: true, enabledTool: true },
  { label: "admin edit unavailable", admin: { ...formalModel, capabilities: ["chat"] }, visible: true, publicEdit: true, enabledTool: true },
  { label: "public visibility absent", admin: formalModel, visible: false, publicEdit: true, enabledTool: true },
  { label: "public edit unavailable", admin: formalModel, visible: true, publicEdit: false, enabledTool: true },
  { label: "tool disabled", admin: formalModel, visible: true, publicEdit: true, enabledTool: false },
])("preflight rejects $label without reserving or writing", async example => {
  const { path } = await temporary(), ledger = new EvalLedger(path), config = formalConfig(), calls: string[] = [];
  const client = new ApplicationClient(config.apiOrigin, "", async (url: any, init: any) => {
    const route = new URL(url).pathname; calls.push(`${init.method} ${route}`);
    if (route === "/api/auth/session") return Response.json({ user: { id: "owner", role: "super_admin" } });
    // Even a plausible unmasked public ID cannot replace administrator identity verification.
    if (route === "/api/models") return Response.json({ models: example.visible ? [{ id: formalModel.id, modelId: formalModel.modelId, capabilities: example.publicEdit ? ["edit"] : [] }] : [], tools: [{ toolKey: "image-edit", enabled: example.enabledTool }] });
    if (route === "/api/admin/model-configuration/models") return Response.json({ models: example.admin ? [example.admin] : [] });
    throw new Error("UNEXPECTED_ROUTE");
  });
  try {
    await expect(preflight(config, [buildJobs(config)[0]!], client, ledger)).rejects.toThrow();
    expect(calls.every(call => call.startsWith("GET "))).toBe(true);
    expect(ledger.report().reservedImageAttempts).toBe(0);
  } finally { ledger.close(); }
});

const formalOptimizerId = "88888888-8888-4888-8888-888888888888";
const reusedCompilationId = "99999999-9999-4999-8999-999999999999";
async function legacyCompilationContract(options: {
  strategy?: "legacy" | "template" | "minimal"; recipe?: Record<string, unknown>; public?: Record<string, unknown>;
  details?: Record<string, unknown>; detailsUnavailable?: boolean;
} = {}) {
  const { path, directory } = await temporary(), ledger = new EvalLedger(path), config = formalConfig();
  const strategy = options.strategy ?? "legacy", job = buildJobs(config).find(job => job.strategy === strategy)!;
  const recipe = config.recipes[job.sample.scene]![strategy]!;
  Object.assign(recipe, { optimizerModelConfigId: formalOptimizerId }, options.recipe);
  const bytes = await readFile(resolve(repoRoot, job.sample.sources[0]!.path));
  const compilationId = "55555555-5555-4555-8555-555555555555";
  let compileRequestId = "", imageRequestId = "";
  const calls: string[] = [];
  const client = new ApplicationClient(config.apiOrigin, "", async (url: any, init: any) => {
    const route = new URL(url).pathname; calls.push(`${init.method} ${route}`);
    if (route === "/api/assets/upload-request") return Response.json({ assetId: "fixture" });
    if (route.endsWith("/test")) {
      compileRequestId = JSON.parse(init.body).requestId;
      return Response.json({ compilation: { id: compilationId, requestId: compileRequestId, status: "success", optimized: true, prompt: "只改衣身为鼠尾草绿，其他保持原样。", ...options.public } });
    }
    if (route.includes("/compilations/")) {
      if (options.detailsUnavailable) return Response.json({}, { status: 503 });
      return Response.json({ compilation: { id: compilationId, requestId: compileRequestId, status: "success", optimized: true,
        recipeVersionId: recipe.versionId, targetModelConfigId: job.model.modelConfigId, modelConfigId: formalOptimizerId,
        cacheHit: false, reusedFromId: null, actualCost: 0.02, estimatedCost: null, currency: "CNY", ...options.details } });
    }
    if (route === "/api/tasks") { imageRequestId = JSON.parse(init.body).requestId; return Response.json({ task: { id: "fixture-task" } }); }
    if (route.startsWith("/api/tasks/by-request/")) return imageRequestId
      ? Response.json({ task: { id: "fixture-task", requestId: imageRequestId, modelConfigId: job.model.modelConfigId, status: "success", resultUrls: ["/result.png"] } })
      : Response.json({}, { status: 404 });
    if (route === "/result.png") return new Response(bytes, { headers: { "content-type": "image/png" } });
    throw new Error("UNEXPECTED_ROUTE");
  });
  const transport = new EvaluationTransport(config, client, ledger, directory), input = await transport.prepare(job);
  const result = await executeAttempt(ledger, "legacy-contract", "single", input, transport);
  return { result, ledger, calls, transport, input };
}

test("legacy missing method is llm only after matching successful optimized administrator details", async () => {
  const fixture = await legacyCompilationContract();
  try {
    expect(fixture.result.status).toBe("success");
    expect(fixture.result.evidence.actualMethod).toBe("llm");
    expect(fixture.result.evidence.methodEvidence).toBe("legacy-admin-details");
    expect(fixture.result.evidence.recipeEvidence.optimizerModelConfigId).toBe(formalOptimizerId);
    expect(fixture.result.evidence.planningModelCalled).toBe(true);
    expect(fixture.result.evidence.planningCost.actual).toBe(0.02);
    expect(fixture.calls.filter(call => call === "POST /api/tasks")).toHaveLength(1);
  } finally { fixture.ledger.close(); }
});

test.each([
  { label: "optimizer not explicitly selected", recipe: { optimizerModelConfigId: undefined } },
  { label: "optimizer differs", details: { modelConfigId: "different-optimizer" } },
  { label: "version differs", details: { recipeVersionId: formalVersions.minimal } },
  { label: "target differs", details: { targetModelConfigId: "different-target" } },
  { label: "compilation differs", details: { id: reusedCompilationId } },
  { label: "request differs", details: { requestId: "different-request" } },
  { label: "expected strategy differs", recipe: { expectedExecutionStrategy: "minimal" } },
  { label: "public result not optimized", public: { optimized: false } },
  { label: "admin result not optimized", details: { optimized: false } },
  { label: "admin result not successful", details: { status: "failed" } },
  { label: "admin method contradicts", details: { method: "minimal" } },
  { label: "public method contradicts", public: { method: "template" } },
  { label: "admin details unavailable", detailsUnavailable: true },
  { label: "template absence cannot become llm", strategy: "template" as const, recipe: { expectedExecutionStrategy: "llm" } },
  { label: "minimal absence cannot become llm", strategy: "minimal" as const, recipe: { expectedExecutionStrategy: "llm" } },
])("legacy missing-method guard rejects $label without an image POST", async example => {
  const fixture = await legacyCompilationContract(example);
  try {
    expect(fixture.result.status).not.toBe("success");
    expect(fixture.result.imagePostStarted).toBe(false);
    expect(fixture.calls.filter(call => call === "POST /api/tasks")).toHaveLength(0);
    expect(fixture.ledger.report().reservedImageAttempts).toBe(1);
  } finally { fixture.ledger.close(); }
});

test.each([
  { label: "explicit original", details: { cacheHit: false, reusedFromId: null }, cacheHit: false, called: true, actualCost: 0.02 },
  { label: "explicit cache", details: { cacheHit: true, reusedFromId: reusedCompilationId }, cacheHit: true, called: false, actualCost: 0 },
  { label: "older explicit boolean", details: { cacheHit: false, reusedFromId: undefined }, cacheHit: false, called: true, actualCost: 0.02 },
  { label: "reusedFromId proves cache", details: { cacheHit: undefined, reusedFromId: reusedCompilationId }, cacheHit: true, called: false, actualCost: 0 },
  { label: "null reusedFromId proves original", details: { cacheHit: undefined, reusedFromId: null }, cacheHit: false, called: true, actualCost: 0.02 },
  { label: "missing cache evidence", details: { cacheHit: undefined, reusedFromId: undefined }, cacheHit: null, called: null, actualCost: null },
  { label: "contradicting cache evidence", details: { cacheHit: false, reusedFromId: reusedCompilationId }, cacheHit: null, called: null, actualCost: null },
  { label: "invalid cache type", details: { cacheHit: "false", reusedFromId: undefined }, cacheHit: null, called: null, actualCost: null },
])("cache accounting keeps $label truthful", async example => {
  const fixture = await legacyCompilationContract({ details: example.details });
  try {
    expect(fixture.result.status).toBe("success");
    expect(fixture.result.evidence.recipeEvidence.cacheHit).toBe(example.cacheHit);
    expect(fixture.result.evidence.planningModelCalled).toBe(example.called);
    expect(fixture.result.evidence.planningCost.actual).toBe(example.actualCost);
    expect(fixture.result.evidence.sourcePlanningCost.actual).toBe(0.02);
    expect(fixture.ledger.report().unknownPlanningCallCount).toBe(example.called === null ? 1 : 0);
  } finally { fixture.ledger.close(); }
});

test("method compatibility repair never resubmits an already blocked legacy attempt", async () => {
  const fixture = await legacyCompilationContract({ public: { optimized: false } });
  try {
    const before = fixture.calls.length;
    await executeAttempt(fixture.ledger, "legacy-contract", "single", fixture.input, fixture.transport);
    expect(fixture.calls.slice(before).every(call => call.startsWith("GET "))).toBe(true);
    expect(fixture.calls.filter(call => call === "POST /api/tasks")).toHaveLength(0);
    expect(fixture.calls.filter(call => call.startsWith("POST ") && call.endsWith("/test"))).toHaveLength(1);
    expect(fixture.ledger.report().reservedImageAttempts).toBe(1);
  } finally { fixture.ledger.close(); }
});

test("preflight requires admin identity proof even for raw-only new jobs", async () => {
  const { path } = await temporary(), ledger = new EvalLedger(path), config = formalConfig(), calls: string[] = [];
  const client = new ApplicationClient(config.apiOrigin, "", async (url: any, init: any) => {
    const route = new URL(url).pathname; calls.push(`${init.method} ${route}`);
    if (route === "/api/auth/session") return Response.json({ user: { id: "owner", role: "designer" } });
    if (route === "/api/models") return Response.json({ models: [formalModel], tools: [{ toolKey: "image-edit", enabled: true }] });
    throw new Error("ADMIN_ROUTE_MUST_NOT_RUN");
  });
  try {
    await expect(preflight(config, [buildJobs(config)[0]!], client, ledger)).rejects.toThrow("ISOLATED_ADMIN_TEST_SESSION_REQUIRED");
    expect(calls.some(call => call.includes("/admin/"))).toBe(false);
    expect(ledger.report().reservedImageAttempts).toBe(0);
  } finally { ledger.close(); }
});

test("formal API shapes: authenticated PUT, flattened recipe details, public compilation ID and success task", async () => {
  const { path, directory } = await temporary(), ledger = new EvalLedger(path), config = formalConfig();
  const job = buildJobs(config).find(job => job.strategy === "template")!, bytes = await readFile(resolve(repoRoot, job.sample.sources[0]!.path));
  const compilationId = "55555555-5555-4555-8555-555555555555", assetId = "66666666-6666-4666-8666-666666666666";
  let compileRequest: any, submittedTask: any;
  const calls: string[] = [];
  const client = new ApplicationClient(config.apiOrigin, "mock-admin-cookie", async (url: any, init: any) => {
    const route = new URL(url).pathname; calls.push(`${init.method} ${route}`);
    expect(init.headers.cookie).toBe("mock-admin-cookie"); expect(init.headers["x-canvas-owner-id"]).toBe("owner");
    if (route === "/api/assets/upload-request") {
      expect(JSON.parse(init.body).metadata.contentSha256).toBe(sha256(bytes));
      return Response.json({ assetId, uploadUrl: `/api/assets/${assetId}/upload` }, { status: 201 });
    }
    if (route.endsWith("/upload")) {
      expect(init.method).toBe("PUT"); expect(sha256(new Uint8Array(init.body))).toBe(sha256(bytes));
      return new Response(null, { status: 204 });
    }
    if (route.endsWith("/test")) {
      const { versionId, ...request } = JSON.parse(init.body);
      expect(versionId).toBe(formalVersions.template); compileRequest = promptCompilationRequestSchema.parse(request);
      return Response.json({ compilation: { id: compilationId, requestId: request.requestId, status: "success", optimized: true, method: "template", prompt: "只改衣身为鼠尾草绿，其他保持原样。" } });
    }
    if (route.includes("/compilations/")) return Response.json({ compilation: { id: compilationId, recipeVersionId: formalVersions.template, targetModelConfigId: formalModel.id, modelConfigId: "server-template:revision", latencyMs: 1, cacheHit: false, actualCost: 0, currency: "CNY" } });
    if (route === "/api/tasks") { submittedTask = taskSubmissionSchema.parse(JSON.parse(init.body)); return Response.json({ task: { id: "77777777-7777-4777-8777-777777777777", requestId: submittedTask.requestId, status: "waiting" } }, { status: 201 }); }
    if (route.startsWith("/api/tasks/by-request/")) return Response.json(taskResponseSchema.parse({ task: { id: "77777777-7777-4777-8777-777777777777", requestId: submittedTask.requestId, status: "success", modelConfigId: formalModel.id, prompt: submittedTask.prompt, resultUrls: [`/api/assets/${assetId}/content`] } }));
    if (route.endsWith("/content")) return new Response(bytes, { headers: { "content-type": "image/png" } });
    throw new Error("UNEXPECTED_ROUTE");
  });
  client.ownerId = "owner";
  const transport = new EvaluationTransport(config, client, ledger, directory);
  try {
    const attempt = await executeAttempt(ledger, "formal-shapes", "single", await transport.prepare(job), transport);
    expect(attempt.status).toBe("success");
    expect(submittedTask.promptInput.compilationId).toBe(compilationId);
    expect(submittedTask.promptInput.referenceRoles).toEqual(compileRequest.promptInput.referenceRoles);
    expect(submittedTask.sourceUrls).toEqual(compileRequest.sourceUrls);
    expect(attempt.evidence.recipeEvidence.recipeVersionId).toBe(formalVersions.template);
    expect(attempt.evidence.planningCost.actual).toBe(0);
    expect(attempt.evidence.planningModelCalled).toBe(false);
    expect(calls.filter(call => call === "POST /api/tasks")).toHaveLength(1);
  } finally { ledger.close(); }
});

test("starter parameters are the common one-image APIMart GPT2/Nano2 contract", () => {
  const parameters = starterConfig().parameters;
  expect(parameters).toEqual({ n: 1, size: "1:1", resolution: "1k" });
  expect(parameters).not.toHaveProperty("quality");
  for (const modelId of ["gpt-image-2", "gemini-3.1-flash-image-preview"]) {
    expect(() => preflightApiMartImageRequest({ modelId, prompt: "只将衣身改成鼠尾草绿", parameters, sourceImages: ["https://owned-reference.invalid/source.png"] })).not.toThrow();
  }
});

test.each([
  { modelId: "gemini-3.1-flash-image-preview", parameters: { n: 1, size: "1024x1024", quality: "auto" }, valid: false },
  { modelId: "gpt-image-2", parameters: { n: 1, size: "1:1", resolution: "64k" }, valid: false },
  { modelId: "gemini-3.1-flash-image-preview", parameters: { n: 1, size: "1:1", resolution: "64k" }, valid: false },
  { modelId: "gpt-image-2", parameters: { n: 1, size: "1:1", resolution: "1k" }, valid: true },
  { modelId: "gemini-3.1-flash-image-preview", parameters: { n: 1, size: "1:1", resolution: "1k" }, valid: true },
])("formal adapter preflight checks $modelId/$parameters before reservation or any external write", async example => {
  const { path } = await temporary(), ledger = new EvalLedger(path), config = formalConfig(), calls: string[] = [];
  config.parameters = example.parameters;
  config.models[0]!.expectedModelId = example.modelId;
  const client = new ApplicationClient(config.apiOrigin, "", async (url: any, init: any) => {
    const route = new URL(url).pathname; calls.push(`${init.method} ${route}`);
    if (route === "/api/auth/session") return Response.json({ user: { id: "owner", role: "super_admin" } });
    if (route === "/api/models") return Response.json({ models: [{ id: formalModel.id, modelId: formalModel.id, capabilities: ["edit"] }], tools: [{ toolKey: "image-edit", enabled: true }] });
    if (route === "/api/admin/model-configuration/models") return Response.json({ models: [{ ...formalModel, modelId: example.modelId, protocol: "apimart", workflowConfigId: null }] });
    throw new Error("EXTERNAL_WRITE_MUST_NOT_RUN");
  });
  try {
    const check = preflight(config, [buildJobs(config)[0]!], client, ledger);
    if (example.valid) await check;
    else await expect(check).rejects.toThrow("APIMART_IMAGE_PREFLIGHT_FAILED");
    expect(ledger.report().reservedImageAttempts).toBe(0);
    expect(calls.every(call => call.startsWith("GET "))).toBe(true);
    expect(calls.some(call => call.includes("/assets/") || call.includes("/tasks") || call.includes("/test"))).toBe(false);
  } finally { ledger.close(); }
});
