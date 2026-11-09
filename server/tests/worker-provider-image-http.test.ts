import { expect, test } from "bun:test";
import ts from "typescript";
import { ApiMartImageQueryRetryable, ApiMartImageTaskPending, stepApiMartImageTask, type ApiMartImageTaskInput } from "../src/apimart-image";
import { assertImageEditMaskSupport, prepareImageEditInput } from "../src/image-edit-input";
import { validateQuickImageSource } from "../src/image-result-processing";
import { ProviderImageAccess } from "../src/provider-image-access";
import { imageAgentProviderPrompt } from "../src/image-agent-profile";
import { openAiImageParameters } from "../src/openai-image-parameters";
import { assertWorkflowTaskContext, workflowTaskContext, WorkflowTaskPending, type WorkflowTaskContext } from "../src/workflow-task-context";
import { normalizeWorkflowOutputs, parsePromptVariables, readPath, renderTemplate } from "../src/workflow-runtime";
import { toolDefinitions } from "../../shared/feature-catalog";

const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8////fwYGBgYWEAHCAD4KBAICIHhuAAAAAElFTkSuQmCC", "base64");
const origin = "http://ai.in-choice.com.cn";
const sources = ["original", "layer", "texture"].map((name, index) => ({
  assetId: `10000000-0000-4000-8000-00000000000${index + 1}`, objectKey: `private/${name}.png`,
  filename: `${name}.png`, mimeType: "image/png", bytes, etag: `"etag-${index}"`,
}));
const worker = ts.createSourceFile("worker.ts", await Bun.file(new URL("../src/worker.ts", import.meta.url)).text(), ts.ScriptTarget.Latest, true);
function declaration(name: string) {
  const node = worker.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  return ts.transpileModule(node.getText(worker), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}
// Execute the production dispatcher and request builders, not a test copy of their routing conditions.
const executeCode = ["executeProvider", "executeApiMartImage", "executeWorkflow", "claimProviderSubmission",
  "isImageWorkflowTask", "isBuiltinSingleImageWorkflow", "singleImageWorkflowRequestBody", "joinUrl"].map(declaration).join("\n");
const newTask = () => ({ id: "20000000-0000-4000-8000-000000000001", execution_token: "execution-owned", user_id: "30000000-0000-4000-8000-000000000001", model_id: "gpt-image-2.6-flare",
  base_url: "https://provider.invalid/v1", operation_type: "inpaint", prompt: "Keep the bag and change its colour", parameters: {} as Record<string, unknown>,
  source_urls: sources.map(source => `/api/assets/${source.assetId}/content`), upstream_task_id: null as string | null,
  upstream_submission_started_at: null as string | null, poll_deadline_at: null as string | null });
const providerTask = () => ({ ...newTask(), protocol: "apimart", encrypted_credentials: "fixture-encrypted",
  model_config_id: "fixture-model", provider_id: "fixture-provider", workflow_config_id: null as string | null,
  workflow_id: null as string | null, submit_path: null as string | null, status_path: null as string | null,
  output_path: null as string | null, request_template: null as Record<string, unknown> | null,
  external_task_path: null, status_value_path: null, success_values: null, failure_values: null,
  poll_interval_ms: null, timeout_seconds: null, upstream_workflow_context: null as WorkflowTaskContext | null });

function harness(options: { origin?: string; failIssue?: boolean; realCacheFailure?: boolean; failQuickValidation?: boolean; sourceAssets?: typeof sources } = {}) {
  const calls: Array<{ url: string; method: string; payload?: Record<string, any>; form?: FormData }> = [];
  const grants: Record<string, any>[] = [];
  const mediaDispatches: Array<{ kind: "video" | "audio"; task: ReturnType<typeof providerTask> }> = [];
  const events: string[] = [];
  const queries: string[] = [];
  let loaded = 0, downloads = 0;
  const sourceAssets = options.sourceAssets ?? sources;
  const db = { query: async (sql: string, values: unknown[]) => {
    queries.push(sql);
    if (sql.startsWith("SELECT a.object_key")) {
      const source = sourceAssets.find(source => source.assetId === values[2])!;
      return { rows: [{ object_key: source.objectKey, mime_type: source.mimeType, filename: source.filename, byte_size: source.bytes.byteLength }] };
    }
    events.push("persist"); return { rows: [{ id: newTask().id }] };
  } };
  const cache = { set: async () => { events.push("cache-write"); throw new Error("Cache unavailable"); } };
  const storage = { configured: true, head: async (key: string) => { const source = sourceAssets.find(source => source.objectKey === key)!;
    return { ETag: source.etag, ContentLength: source.bytes.byteLength }; } };
  class FakeProviderImageAccess {
    constructor(actualDb: unknown, actualCache: unknown, actualStorage: unknown, actualOrigin: string) {
      expect([actualDb, actualCache, actualStorage, actualOrigin]).toEqual([db, cache, storage, origin]);
    }
    async issue(input: Record<string, any>) {
      events.push("grant"); grants.push(input);
      if (options.failIssue) throw new Error("Cache grant write unavailable");
      return `${origin}/api/provider-images/reference-${input.source.assetId}`;
    }
  }
  const fakeFetch = async (url: string, init?: RequestInit) => {
    const method = init?.method || "GET";
    const payload = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, payload, ...(init?.body instanceof FormData ? { form: init.body } : {}) }); events.push("fetch");
    if (url.endsWith("/uploads/images")) return Response.json({ url: `https://provider.invalid/upload-${calls.length}.png` });
    if (method === "POST" && url.endsWith("/images/generations")) return Response.json({ data: [{ task_id: "upstream-owned" }] });
    if (method === "POST" && url.endsWith("/midjourney/generations/blend")) return Response.json({ data: [{ task_id: "upstream-owned" }] });
    if (method === "GET" && url.endsWith("/tasks/upstream-owned")) return Response.json({ data: { status: "completed", result: { images: [{ url: "http://provider.invalid/result.png" }] } } });
    if (method === "POST" && url.endsWith("/workflow/run")) return Response.json({ outputs: ["https://provider.invalid/workflow-result.png"] });
    if (method === "POST" && url.endsWith("/images/edits")) return Response.json({ data: [{ url: "https://provider.invalid/openai-result.png" }] });
    if (method === "POST" && url.endsWith("/custom/image")) return Response.json({ resultUrls: ["https://provider.invalid/custom-result.png"] });
    throw new Error(`Unexpected provider request: ${method} ${url}`);
  };
  const dependencies = {
    db, cache, storage, config: { PROVIDER_IMAGE_PUBLIC_ORIGIN: options.origin ?? origin, PROVIDER_ENCRYPTION_KEY: "fixture-key" }, ProviderImageAccess: options.realCacheFailure ? ProviderImageAccess : FakeProviderImageAccess,
    decryptSecret: (cipher: string, key: string) => { expect([cipher, key]).toEqual(["fixture-encrypted", "fixture-key"]); return JSON.stringify({ apiKey: "fixture-only" }); },
    assertImageEditMaskSupport, imageAgentProviderPrompt, openAiImageParameters, OPENAI_IMAGE_TIMEOUT_MS: 180_000,
    assertWorkflowTaskContext, workflowTaskContext, WorkflowTaskPending, normalizeWorkflowOutputs, parsePromptVariables, readPath, renderTemplate,
    fetch: fakeFetch, fetchProviderSubmission: fakeFetch,
    assertProviderSubmissionResponse: async (response: Response) => { expect(response.ok).toBe(true); },
    executeApiMartVideo: async (task: ReturnType<typeof providerTask>) => { mediaDispatches.push({ kind: "video", task }); return [{ bytes, mimeType: "video/mp4" }]; },
    executeOpenAiAudio: async (task: ReturnType<typeof providerTask>) => { mediaDispatches.push({ kind: "audio", task }); return [{ bytes, mimeType: "audio/mpeg" }]; },
    loadSourceAssets: async () => { loaded++; events.push("load"); return sourceAssets; },
    prepareImageEditInput: async (...args: Parameters<typeof prepareImageEditInput>) => { events.push("prepare"); return prepareImageEditInput(...args); },
    validateQuickImageSource: async (...args: Parameters<typeof validateQuickImageSource>) => {
      events.push("validate-quick"); if (options.failQuickValidation) throw new Error("Quick source invalid"); return validateQuickImageSource(...args);
    },
    VideoSubmissionClaimLost: class extends Error {}, ApiMartImageTaskPending, ApiMartImageQueryRetryable,
    stepApiMartImageTask: (input: ApiMartImageTaskInput) => stepApiMartImageTask(input, { fetch: fakeFetch, sleep: async () => { throw new Error("No polling sleep expected"); } }),
    fetchProviderResult: async () => { downloads++; return { bytes, mimeType: "image/png" }; },
  };
  const execute = new Function(...Object.keys(dependencies), `${executeCode}; return { image: executeApiMartImage, provider: executeProvider };`)(...Object.values(dependencies));
  return { execute: (task: ReturnType<typeof newTask>) => execute.image(task, { apiKey: "fixture-only" }, task.prompt),
    dispatch: (task: ReturnType<typeof providerTask>) => execute.provider(task, { measure: async (_stage: string, operation: () => Promise<unknown>) => operation() }),
    calls, grants, events, queries, mediaDispatches,
    loaded: () => loaded, downloads: () => downloads };
}

test("fresh Flare uses ordered HTTP references through the real provider adapter: zero uploads and one paid POST", async () => {
  const h = harness(), task = newTask();
  await expect(h.execute(task)).rejects.toBeInstanceOf(ApiMartImageTaskPending);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]).toMatchObject({ url: "https://provider.invalid/v1/images/generations", method: "POST" });
  expect(h.calls[0]!.payload!.image_urls).toEqual(sources.map(source => `${origin}/api/provider-images/reference-${source.assetId}`));
  expect(h.grants.map(grant => grant.source)).toEqual(sources);
  for (const grant of h.grants) expect(grant).toMatchObject({ taskId: task.id, userId: task.user_id, executionToken: task.execution_token });
  expect(h.events).toEqual(["load", "prepare", "grant", "grant", "grant", "persist", "fetch", "persist"]);
  expect(task.upstream_task_id).toBe("upstream-owned");
  expect(h.downloads()).toBe(0);
});

test.each(["mask", "markup"] as const)("Flare %s layer remains validated original PNG data and only references become HTTP URLs", async layer => {
  const h = harness(), task = newTask();
  task.parameters = { inputArchive: { [`${layer}ReferenceIndex`]: 1 } };
  await expect(h.execute(task)).rejects.toBeInstanceOf(ApiMartImageTaskPending);
  expect(h.grants.map(grant => grant.source.assetId)).toEqual([sources[0]!.assetId, sources[2]!.assetId]);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]!.payload![`${layer}_url`]).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
  expect(h.calls[0]!.payload!.image_urls).toHaveLength(2);
});

test.each(["mask", "markup"] as const)("invalid %s bytes fail before publishing or submitting", async layer => {
  const brokenSources = sources.map((source, index) => index === 1 ? { ...source, bytes: Buffer.from("broken") } : source);
  const h = harness({ sourceAssets: brokenSources }), task = newTask();
  task.parameters = { inputArchive: { [`${layer}ReferenceIndex`]: 1 } };
  await expect(h.execute(task)).rejects.toThrow();
  expect(h.grants).toHaveLength(0); expect(h.calls).toHaveLength(0); expect(h.queries).toHaveLength(0);
});

test("the original upstream task resumes without reading assets, issuing grants, or resubmitting", async () => {
  const h = harness(), task = { ...newTask(), upstream_task_id: "upstream-owned", upstream_submission_started_at: "already-started", poll_deadline_at: new Date(Date.now() + 60_000).toISOString() };
  expect(await h.execute(task)).toHaveLength(1);
  expect(h.calls).toEqual([{ url: "https://provider.invalid/v1/tasks/upstream-owned", method: "GET", payload: undefined }]);
  expect(h.grants).toHaveLength(0); expect(h.loaded()).toBe(0); expect(h.queries).toHaveLength(0);
});

test("an uncertain earlier submission cannot reload sources, publish references, or post again", async () => {
  const h = harness(), task = { ...newTask(), upstream_submission_started_at: "already-started" };
  await expect(h.execute(task)).rejects.toThrow("不会自动重新提交");
  expect(h.grants).toHaveLength(0); expect(h.calls).toHaveLength(0); expect(h.loaded()).toBe(0);
});

test.each([
  { origin: "", model: "gpt-image-2.6-flare" },
  { origin, model: "gpt-image-2.6-sunburst" },
  { origin, model: "gpt-image-2.5-flare" },
  { origin, model: "mai-image-2.6-flash" },
])("no configured origin or non-Flare model retains the existing upload path: %p", async scenario => {
  const h = harness({ origin: scenario.origin, sourceAssets: [sources[0]!] }), task = { ...newTask(), model_id: scenario.model };
  await expect(h.execute(task)).rejects.toBeInstanceOf(ApiMartImageTaskPending);
  expect(h.grants).toHaveLength(0);
  expect(h.calls.map(call => call.url)).toEqual(["https://provider.invalid/v1/uploads/images", "https://provider.invalid/v1/images/generations"]);
});

test("a cache grant failure stops before the paid POST and never falls back to uploading", async () => {
  const h = harness({ failIssue: true });
  await expect(h.execute(newTask())).rejects.toThrow("Cache grant write unavailable");
  expect(h.grants).toHaveLength(1); expect(h.calls).toHaveLength(0); expect(h.queries).toHaveLength(0);
});

test("the real grant service cache failure propagates through Worker without a claim, upload or paid POST", async () => {
  const h = harness({ realCacheFailure: true }), task = newTask();
  await expect(h.execute(task)).rejects.toMatchObject({ code: "PROVIDER_IMAGE_UNAVAILABLE", status: 503 });
  expect(h.events.filter(event => event === "cache-write")).toHaveLength(1);
  expect(h.calls).toHaveLength(0);
  expect(h.queries.every(sql => sql.startsWith("SELECT a.object_key"))).toBe(true);
  expect(task.upstream_task_id).toBeNull(); expect(task.upstream_submission_started_at).toBeNull();
});

test("quick-action source validation occurs before URL publication", async () => {
  const h = harness({ failQuickValidation: true }), task = newTask(); task.parameters.quickImageAction = "remove-background";
  await expect(h.execute(task)).rejects.toThrow("Quick source invalid");
  expect(h.events).toEqual(["load", "prepare", "validate-quick"]); expect(h.grants).toHaveLength(0); expect(h.calls).toHaveLength(0);
});

test("source loading carries authorized asset identity and the original object ETag", async () => {
  const dependencies = {
    db: { query: async (sql: string, values: unknown[]) => {
      expect(sql).toContain("owner_user_id=$2 AND status='ready' AND deleted_at IS NULL");
      expect(values).toEqual([sources[0]!.assetId, "owner"]);
      return { rows: [{ object_key: sources[0]!.objectKey, mime_type: "image/png", filename: "original.png" }] };
    } }, storage: {}, videoSourceMetadata: () => ({}),
    readSourceAssetObject: async () => ({ ETag: '"original-etag"', Body: { transformToByteArray: async () => bytes } }),
  };
  const load = new Function(...Object.keys(dependencies), `${declaration("loadSourceAsset")}; return loadSourceAsset;`)(...Object.values(dependencies));
  expect(await load(`/api/assets/${sources[0]!.assetId}/content`, "owner")).toEqual({ ...sources[0], etag: '"original-etag"' });
});

const imageCapabilities = new Set(["generate", "edit", "upscale", "batch"]);
const imageToolRoutes = toolDefinitions.filter(tool => tool.capabilities.some(capability => imageCapabilities.has(capability)))
  .flatMap(tool => tool.operations.map(operation => ({ tool: tool.toolKey, operation })));

test.each(imageToolRoutes)("production dispatcher covers catalog image route %p with its resolved model", async route => {
  const h = harness(), task = providerTask();
  task.operation_type = route.operation;
  task.parameters = { tool: route.tool };
  // Blend has a dedicated model contract; never claim the UI can bind it to Flare.
  if (route.tool === "midjourney-blend") { task.model_id = "midjourney-blend"; task.prompt = ""; }
  if (route.tool === "canvas-mask-edit") task.parameters.inputArchive = { maskReferenceIndex: 1 };
  await expect(h.dispatch(task)).rejects.toBeInstanceOf(ApiMartImageTaskPending);
  expect(h.mediaDispatches).toHaveLength(0);
  const submissions = h.calls.filter(call => call.url.endsWith(route.tool === "midjourney-blend" ? "/midjourney/generations/blend" : "/images/generations"));
  expect(submissions).toHaveLength(1);
  if (route.tool === "midjourney-blend") {
    expect(h.grants).toHaveLength(0);
    expect(h.calls.filter(call => call.url.endsWith("/uploads/images"))).toHaveLength(sources.length);
    expect(submissions[0]!.payload!.image_urls).toHaveLength(sources.length);
    return;
  }
  expect(submissions[0]!.payload!.model).toBe(task.model_id);
  const references = route.tool === "canvas-mask-edit" ? [sources[0]!, sources[2]!] : sources;
  expect(h.calls).toHaveLength(1);
  expect(submissions[0]!.payload!.image_urls).toEqual(references.map(source => `${origin}/api/provider-images/reference-${source.assetId}`));
  expect(h.grants.map(grant => grant.source)).toEqual(references);
  if (route.tool === "canvas-mask-edit") expect(submissions[0]!.payload!.mask_url).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
});

test("production text-only Flare generation does not issue reference grants or upload an image", async () => {
  const h = harness({ sourceAssets: [] }), task = { ...providerTask(), operation_type: "image_generation", source_urls: [], parameters: { tool: "canvas-image" } };
  await expect(h.dispatch(task)).rejects.toBeInstanceOf(ApiMartImageTaskPending);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]!.payload!.image_urls).toBeUndefined();
  expect(h.grants).toHaveLength(0);
});

test.each(["gpt-image-2.6-sunburst", "gpt-image-2.5-flare", "mai-image-2.6-flash", "gemini-nano-banana-2.1"])(
  "production dispatcher uses actual model %s, not a tool name or stale UI model parameter", async model => {
    const h = harness({ sourceAssets: [sources[0]!] }), task = { ...providerTask(), model_id: model,
      source_urls: [providerTask().source_urls[0]!], parameters: { tool: "canvas-edit", model: "gpt-image-2.6-flare" } };
    await expect(h.dispatch(task)).rejects.toBeInstanceOf(ApiMartImageTaskPending);
    expect(h.grants).toHaveLength(0);
    expect(h.calls.map(call => call.url)).toEqual(["https://provider.invalid/v1/uploads/images", "https://provider.invalid/v1/images/generations"]);
    expect(h.calls[1]!.payload!.model).toBe(model);
  },
);

test.each(["image_generation", "inpaint", "upscale", "batch_image", "seamless_stitch"])(
  "configured workflow takes precedence over the same Flare model for %s", async operation => {
    const h = harness(), task = { ...providerTask(), operation_type: operation, workflow_config_id: "fixture-workflow",
      submit_path: "/workflow/run", output_path: "outputs", parameters: { tool: "canvas-edit" },
      request_template: { model: "$modelId", n: 1, sourceUrls: "$sourceUrls", sourceDataUrls: "$sourceDataUrls" } };
    expect(await h.dispatch(task)).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!).toMatchObject({ url: "https://provider.invalid/v1/workflow/run", method: "POST",
      payload: { model: "gpt-image-2.6-flare", n: 1, sourceUrls: task.source_urls, sourceDataUrls: sources.map(() => `data:image/png;base64,${bytes.toString("base64")}`) } });
    expect(h.grants).toHaveLength(0);
    expect(h.mediaDispatches).toHaveLength(0);
    expect(task.upstream_workflow_context).toMatchObject({ workflowConfigId: "fixture-workflow" });
    expect(h.downloads()).toBe(1);
  },
);

test("the same Flare model on OpenAI protocol sends original multipart bytes, not APIMart HTTP grants", async () => {
  const h = harness(), task = { ...providerTask(), protocol: "openai", parameters: { tool: "canvas-edit" } };
  expect(await h.dispatch(task)).toHaveLength(1);
  expect(h.grants).toHaveLength(0);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]!.url).toBe("https://provider.invalid/v1/images/edits");
  const form = h.calls[0]!.form!;
  expect(form.get("model")).toBe(task.model_id);
  expect(form.getAll("image")).toHaveLength(sources.length);
  for (const [index, value] of form.getAll("image").entries()) {
    expect(value).toBeInstanceOf(File);
    const file = value as File;
    expect(file.name).toBe(sources[index]!.filename);
    expect(file.type).toBe(sources[index]!.mimeType);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(sources[index]!.bytes);
  }
});

test("the same Flare model on custom protocol keeps its custom request contract", async () => {
  const h = harness(), task = { ...providerTask(), protocol: "custom", base_url: "https://provider.invalid/custom/image" };
  expect(await h.dispatch(task)).toHaveLength(1);
  expect(h.grants).toHaveLength(0);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]!).toMatchObject({ url: task.base_url, payload: { model: task.model_id, sourceUrls: task.source_urls } });
});

const mediaToolRoutes = toolDefinitions.filter(tool => ["video_generation", "audio_generation"].includes(tool.operationType));
test.each(mediaToolRoutes)("production dispatcher keeps media route $toolKey outside the image adapter", async route => {
  const audio = route.operationType === "audio_generation", h = harness();
  const task = { ...providerTask(), operation_type: route.operationType, protocol: audio ? "openai" : "apimart",
    model_id: audio ? "tts-1" : "sora-2", parameters: { tool: route.toolKey } };
  expect(await h.dispatch(task)).toHaveLength(1);
  expect(h.mediaDispatches).toEqual([{ kind: audio ? "audio" : "video", task }]);
  expect(h.grants).toHaveLength(0);
  expect(h.calls).toHaveLength(0);
  expect(h.loaded()).toBe(0);
});

test("a submitted image whose protocol changed fails before invoking any alternative adapter", async () => {
  const h = harness(), task = { ...providerTask(), protocol: "openai", upstream_task_id: "upstream-owned" };
  await expect(h.dispatch(task)).rejects.toThrow("模型渠道配置已变更");
  expect(h.calls).toHaveLength(0);
  expect(h.grants).toHaveLength(0);
  expect(h.mediaDispatches).toHaveLength(0);
  expect(h.loaded()).toBe(0);
});
