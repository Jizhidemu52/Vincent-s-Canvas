import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { auxiliaryQualityCases, creativeQualityCases } from "../scripts/prompt-quality-cases";
import { loadBaselineBuilder, loadCurrentSceneAdapter, maySubmitPaidPost, protocolQualityCases, runQualityMatrix, sanitizePublicText, selectCompilationCost } from "../scripts/prompt-quality-matrix";
import { getToolDefinition, toolDefinitions } from "../../shared/feature-catalog";

const root = resolve(import.meta.dir, "../..");
const qaRoot = resolve(root, "output/prompt-optimization/quality-matrix");
const modelId = "d5000000-0000-4000-8000-000000000001";
const taskId = "11111111-1111-4111-8111-111111111111";
const compilationId = "22222222-2222-4222-8222-222222222222";
const cleanup: Array<() => Promise<void>> = [];
test("protocol smoke respects Nano aspect parameters and Blend's image-only contract even with hidden model IDs", () => {
  const cases = protocolQualityCases([
    { id: "nano", modelId: "public-uuid", name: "aplmart-nano2.1", capabilities: ["generate", "edit"] },
    { id: "blend", modelId: "other-uuid", name: "aplmart-mj-blend", capabilities: ["generate"] },
  ], [{ toolKey: "image-edit", modelConfigId: null, enabled: true }, { toolKey: "midjourney-blend", modelConfigId: "blend", enabled: true }], "primary");
  expect(cases[0]?.parameters).toEqual({ n: 1, size: "1:1", resolution: "1K" });
  expect(cases[1]).toMatchObject({ toolKey: "midjourney-blend", sources: ["shirt", "flat"], operationType: "image_generation", prompt: "" });
  expect(cases[1]?.input).toBeUndefined();
});
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

function temporaryRun() {
  const runId = `test-${crypto.randomUUID()}`;
  const directory = resolve(qaRoot, runId);
  if (!directory.startsWith(qaRoot + sep)) throw new Error("Invalid test cleanup target");
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return { runId, directory };
}
function fakeApi(mode: "success" | "compile-unknown" | "partial-batch") {
  const counts = { compilationPosts: 0, taskPosts: 0, batchPosts: 0, gets: 0 };
  let requestId = "", compilationRequestId = "", assetIndex = 0;
  const task = () => ({ id: taskId, requestId, status: "success", resultUrls: ["/mock-image?signature=private-test-signed-url"], prompt: "Final compiled prompt", optimized: true, rmbCost: 0.2 });
  const compilation = () => ({ id: compilationId, requestId: compilationRequestId, status: "success", prompt: "Final compiled prompt", summaryZh: "仅改指定内容", optimized: true });
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "GET") counts.gets++;
    if (path === "/api/auth/session") return json({ user: { id: "qa-test-owner", role: "super_admin" } });
    if (path === "/api/models") return json({ models: [{ id: modelId, modelId: "mock-image", capabilities: ["generate", "edit", "chat"], enabled: true }], tools: toolDefinitions.map(tool => ({ toolKey: tool.toolKey, enabled: true, modelConfigId: modelId })) });
    if (path === "/api/prompt-compilations" && request.method === "POST") {
      counts.compilationPosts++; compilationRequestId = (await request.json() as any).requestId;
      return mode === "compile-unknown" ? json({ error: "UPSTREAM_UNCERTAIN" }, 503) : json({ compilation: compilation() });
    }
    if (path.startsWith("/api/prompt-compilations/by-request/")) return mode === "compile-unknown" ? json({ error: "NOT_FOUND" }, 404) : json({ compilation: compilation() });
    if (path.startsWith("/api/admin/prompt-recipes/")) return json({ compilation: { ...compilation(), inputTokens: 400, outputTokens: 90, cacheHit: false, actualCost: null, estimatedCost: 0.01, currency: "USD", systemPrompt: "MUST NOT ENTER REPORT", rawResponse: "MUST NOT ENTER REPORT" } });
    if (path === "/api/tasks" && request.method === "POST") { counts.taskPosts++; const body = await request.json() as any; requestId = body.requestId; expect(body.promptInput.compilationId).toBe(compilationId); return json({ task: task() }); }
    if (path === "/api/tasks/batch" && request.method === "POST") { counts.batchPosts++; requestId = (await request.json() as any).requestId; return json({ batchId: "mock-batch", tasks: [task()], submissionComplete: false, totalItems: 2 }); }
    if (path.startsWith("/api/tasks/batches/by-request/")) return json({ batchId: "mock-batch", tasks: [task()], submissionComplete: false, totalItems: 2 });
    if (path.startsWith("/api/tasks/by-request/") || path === `/api/tasks/${taskId}`) return json({ task: task() });
    if (path === "/api/assets/upload-request") return json({ assetId: `mock-asset-${++assetIndex}`, uploadUrl: `/mock-upload/${assetIndex}` });
    if (path.startsWith("/mock-upload/")) return new Response(null, { status: 204 });
    if (path === "/mock-image") return new Response(Bun.file(resolve(root, "labs/design-workbench/assets/garment.png")), { headers: { "content-type": "image/jpeg" } });
    return json({ error: "NOT_FOUND" }, 404);
  } });
  const keys = ["PQ_API_BASE", "PQ_COOKIE", "PQ_CONCURRENCY", "PQ_TIMEOUT_MS", "PQ_POLL_MS", "PQ_MODEL_CONFIG_ID"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PQ_API_BASE = server.url.origin; process.env.PQ_COOKIE = "test_session=do-not-save"; process.env.PQ_CONCURRENCY = "1"; process.env.PQ_TIMEOUT_MS = "1000"; process.env.PQ_POLL_MS = "100"; delete process.env.PQ_MODEL_CONFIG_ID;
  cleanup.push(async () => { server.stop(true); for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; });
  return counts;
}

describe("prompt quality matrix safe execution", () => {
  test("90 old/new pairs and 44 other samples use valid operation contracts", async () => {
    const baseline = await loadBaselineBuilder();
    const creative = creativeQualityCases(baseline.build, await loadCurrentSceneAdapter()), auxiliary = auxiliaryQualityCases();
    expect(creative).toHaveLength(180); expect(auxiliary).toHaveLength(44);
    expect(new Set(creative.map(item => item.pairId)).size).toBe(90);
    for (const item of [...creative, ...auxiliary]) {
      const operation = item.kind === "chat" ? "chat" : item.kind === "batch" ? "batch_image" : item.input?.mode === "generate" || !item.sources.length ? "image_generation" : "inpaint";
      expect(getToolDefinition(item.toolKey)?.operations as readonly string[]).toContain(operation);
    }
    const workflow = auxiliary.filter(item => item.group === "workflow");
    expect(new Set(workflow.map(item => item.input?.fields?.step_type)).size).toBe(6);
    expect(creative.filter(item => item.variant === "new" && item.input?.scene === "accessory-design" && item.sources[0] === "button")).toHaveLength(2);
  });
  test("dry-run performs no API call", async () => {
    const counts = fakeApi("success"), { runId } = temporaryRun();
    const plan = await runQualityMatrix(["--run-id", runId, "--only", "creative", "--limit", "2"]);
    expect((plan as any).cases).toHaveLength(2); expect(counts.gets).toBe(0); expect(counts.compilationPosts).toBe(0); expect(counts.taskPosts).toBe(0);
  });
  test("successful run preserves magic MIME and resume submits nothing again", async () => {
    const counts = fakeApi("success"), { runId, directory } = temporaryRun();
    const args = ["--run-id", runId, "--only", "free-1-on", "--execute"];
    const ledger = await runQualityMatrix(args) as any;
    expect(ledger.cases["free-1-on"].status).toBe("success"); expect(ledger.cases["free-1-on"].outputs[0].mime).toBe("image/png");
    expect(ledger.cases["free-1-on"].outputs[0].contentType).toBe("image/jpeg");
    expect(ledger.cases["free-1-on"].compilationCost.actualCost).toBeNull();
    await runQualityMatrix(args); expect(counts.compilationPosts).toBe(1); expect(counts.taskPosts).toBe(1);
    const state = await readFile(resolve(directory, "ledger.json"), "utf8"), report = await readFile(resolve(directory, "report.json"), "utf8");
    for (const content of [state, report]) { expect(content).not.toContain("do-not-save"); expect(content).not.toContain("private-test-signed-url"); expect(content).not.toContain("MUST NOT ENTER REPORT"); }
  });
  test("unknown compilation is query-only on resume", async () => {
    const counts = fakeApi("compile-unknown"), { runId } = temporaryRun();
    const args = ["--run-id", runId, "--only", "free-1-on", "--execute"];
    expect((await runQualityMatrix(args) as any).cases["free-1-on"].status).toBe("uncertain");
    expect((await runQualityMatrix(args) as any).cases["free-1-on"].status).toBe("uncertain");
    expect(counts.compilationPosts).toBe(1); expect(counts.taskPosts).toBe(0);
  });
  test("partial batch never re-posts or reports full success", async () => {
    const counts = fakeApi("partial-batch"), { runId } = temporaryRun();
    const args = ["--run-id", runId, "--only", "batch-off", "--execute"];
    expect((await runQualityMatrix(args) as any).cases["batch-off"].status).toBe("uncertain");
    expect((await runQualityMatrix(args) as any).cases["batch-off"].status).toBe("uncertain");
    expect(counts.batchPosts).toBe(1); expect(counts.compilationPosts).toBe(0);
  });
  test("unknown accounting remains null and attempted POST is never eligible", () => {
    expect(selectCompilationCost({}).actualCost).toBeNull(); expect(selectCompilationCost({ actualCost: 0 }).actualCost).toBe(0);
    expect(maySubmitPaidPost(true)).toBe(false); expect(maySubmitPaidPost(undefined)).toBe(true);
    expect(sanitizePublicText("authorization=secret Bearer private-token sk-abcdefghijklmnop")).not.toContain("private-token");
  });
});
