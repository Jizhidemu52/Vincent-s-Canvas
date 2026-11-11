import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import type { Server } from "node:http";
import { promptInputSchema, type PromptInput } from "../../shared/prompt-contracts";
import { defaultVideoMotionSettings, normalizeVideoMotionSettings } from "../../shared/video-motion-options";
import { sqlitePromptRecipeStore } from "../src/demo-prompt-recipes";
import { PromptCompiler, type PromptOptimizer } from "../src/prompt-compiler";
import { publicPromptCompilation } from "../src/prompt-recipe-store";
import { preparePromptTaskInput } from "../src/prompt-task-input";
import { parseOptimizedPrompt } from "../src/prompt-safety";
import { assertVideoMotionPolicy, ensureVideoMotionRecipe, videoMotionParameters } from "../src/video-motion-input";
import { createTasksRouter } from "../src/routes/tasks";
import { createAdminPromptRecipesRouter } from "../src/routes/prompt-recipes";
import { BillingError } from "../src/billing";

const closers: Array<() => void> = [], servers: Server[] = [];
afterEach(async () => { closers.splice(0).forEach(close => close()); await Promise.all(servers.splice(0).map(server => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }))); });
const actor = { id: randomUUID(), role: "designer", departmentId: null };
const targetId = randomUUID();
const motion = (fields: Record<string, unknown> = {}): PromptInput => promptInputSchema.parse({ scene: "video-motion", mode: "video", fields, userText: "", outputLanguage: "zh" });
const output = { prompt: "以图片1为首帧。0-5秒：镜头缓慢推近毛衫的针织纹理，面料自然轻摆。保持款式、颜色和图案不变。", summary_zh: "镜头缓慢推近毛衫的针织纹理" };
async function fixture(invoke: PromptOptimizer["invoke"] = async () => ({ content: JSON.stringify(output) }), modelId = "doubao-seedance-2.5") {
  const db = sqlitePromptRecipeStore(":memory:"); closers.push(db.close);
  await ensureVideoMotionRecipe(db.store);
  await db.store.update("video-motion", { ...(await db.store.get("video-motion")), modelConfigId: "optimizer" });
  const version = await db.store.saveVersion("video-motion", { systemPrompt: "Private fixture only; emit the required JSON object.", fieldTemplate: "", modelOverrides: {}, fallbackPrompt: "", outputLanguage: "zh", changeNote: "fixture" }, "admin");
  await db.store.activate("video-motion", version.id);
  const calls: Parameters<PromptOptimizer["invoke"]>[] = [], reads: string[] = [];
  const compiler = new PromptCompiler(db.store, {
    resolveTarget: async () => ({ id: targetId, modelId, protocol: "apimart", fingerprint: `video-fixture:${modelId}` }),
    resolveOptimizer: async () => ({ id: "optimizer", modelId: "vision-fixture", fingerprint: "optimizer-fixture", estimatedRmbCost: null, invoke: async (...args) => { calls.push(args); return invoke(...args); } }),
    readSource: async (_actor, url) => { reads.push(url); return { bytes: Buffer.from(url), mimeType: "image/png", previewDataUrl: "data:image/webp;base64,eA==" }; },
  });
  return { ...db, compiler, calls, reads };
}
const task = (promptInput = motion()) => ({ requestId: randomUUID(), projectId: "video", operationType: "video_generation", toolKey: "video", modelConfigId: targetId, prompt: "", promptInput, parameters: { seconds: 5, size: "adaptive", resolution: "720p", videoMode: "first-frame", generateAudio: false } as Record<string, unknown>, sourceUrls: ["image-a"] });

describe("video motion contract and safety", () => {
  test("scene and mode are paired, masks are rejected and settings are bounded", () => {
    expect(() => promptInputSchema.parse({ scene: "video-motion", mode: "edit" })).toThrow();
    expect(() => promptInputSchema.parse({ scene: "free-optimize", mode: "video" })).toThrow();
    expect(() => promptInputSchema.parse({ ...motion(), hasMask: true })).toThrow();
    expect(normalizeVideoMotionSettings({ subject_action: ["turn", "walk", "touch", "turn"], audio: "invalid", keep: [] })).toMatchObject({ subject_action: ["turn", "walk"], audio: "none", keep: [] });
    expect(defaultVideoMotionSettings.keep).toEqual(["shape", "color", "pattern", "face"]);
  });
  test("only standalone video requires planning; audio and frame defaults use the actual sources", () => {
    expect(() => assertVideoMotionPolicy(task(undefined as never))).not.toThrow();
    const raw = { ...task(), promptInput: undefined };
    expect(() => assertVideoMotionPolicy(raw)).toThrow("尚未开放原文直发");
    expect(() => assertVideoMotionPolicy(raw, true)).not.toThrow();
    expect(() => assertVideoMotionPolicy({ ...raw, toolKey: "canvas-video" })).not.toThrow();
    expect(videoMotionParameters({}, motion(), ["image/png"], "doubao-seedance-2.5")).toEqual({ generateAudio: false, videoMode: "first-frame" });
    expect(videoMotionParameters({}, motion({ audio: "ambient" }), ["image/png", "image/jpeg"], "doubao-seedance-2.5")).toEqual({ generateAudio: true, videoMode: "first-last-frame" });
    expect(videoMotionParameters({}, motion(), ["image/png", "video/mp4"], "doubao-seedance-2.5")).toEqual({ generateAudio: false });
    expect(videoMotionParameters({ videoMode: "reference" }, motion(), ["image/png"], "doubao-seedance-2.5")).toMatchObject({ videoMode: "reference" });
  });
  test("video JSON requires only prompt and short summary and does not append Avoid", () => {
    const options = { video: true, referenceCount: 1, language: "zh" as const, userText: "" };
    expect(parseOptimizedPrompt(JSON.stringify(output), [], options)).toMatchObject({ prompt: output.prompt, summaryZh: output.summary_zh });
    for (const bad of [{ prompt: output.prompt }, { ...output, avoid: [] }, { ...output, prompt: "图片2 旋转" }, { ...output, prompt: "Image 3 rotates" }, { ...output, prompt: "动".repeat(1501) }, { ...output, summary_zh: "动".repeat(61) }, { ...output, summary_zh: "" }, { ...output, summary_zh: "一行\n两行" }]) {
      expect(() => parseOptimizedPrompt(JSON.stringify(bad), [], options)).toThrow();
    }
    const privateRule = "这是内部规则用于校验泄漏不允许公开系统指令这是内部规则用于校验泄漏不允许公开系统指令这是内部规则用于校验泄漏不允许公开系统指令这是内部规则用于校验泄漏不允许公开系统指令";
    expect(() => parseOptimizedPrompt(JSON.stringify({ ...output, prompt: privateRule }), [privateRule], options)).toThrow("安全检查");
  });
  test("empty recipe initialization never seeds or overwrites private rules", async () => {
    const db = sqlitePromptRecipeStore(":memory:"); closers.push(db.close);
    const recipe = await ensureVideoMotionRecipe(db.store);
    expect(recipe).toMatchObject({ name: "图生视频动效", enabled: true, modelConfigId: null, failurePolicy: "stop", currentVersionId: null });
    expect(await db.store.versions("video-motion")).toEqual([]);
    await db.store.update(recipe.key, { ...recipe, enabled: false, modelConfigId: "custom" });
    expect(await ensureVideoMotionRecipe(db.store)).toMatchObject({ enabled: false, modelConfigId: "custom" });
  });
});

describe("video planner orchestration", () => {
  test.each([6, 6.5])("Omni edit follows the actual source and accepts concise edit instructions without forcing a new timeline (%s)", async seconds => {
    const prompt = "只将背景改为柔和日光，保持其余内容与源视频时长不变。";
    const f = await fixture(async () => ({ content: JSON.stringify({ ...output, prompt }) }), "gemini-omni-1.2-flash");
    const input = task(motion({ duration: 15, duration_mode: "output", generate_audio: false }));
    input.sourceUrls = ["video-a"];
    input.parameters = { seconds, size: "16:9", resolution: "720p", videoMode: "auto" };
    expect(await preparePromptTaskInput(f.compiler, actor, input, { videoSourceMimeTypes: ["video/mp4"] })).toMatchObject({ prompt, optimized: true });
    const payload = JSON.parse((f.calls[0]![1][0] as { text: string }).text);
    expect(payload.fields).toMatchObject({ video_mode: "edit", duration_mode: "source", source_duration: seconds, generate_audio: true, native_audio: true });
    expect(payload.fields).not.toHaveProperty("duration");
    expect(f.reads).toEqual([]);
  });

  test("Omni extension plans only the added seconds and overrides untrusted duration mode fields", async () => {
    const prompt = "0-3秒：沿源视频片尾继续横移，原片保持不变。";
    const f = await fixture(async () => ({ content: JSON.stringify({ ...output, prompt }) }), "gemini-omni-1.2-flash");
    const input = task(motion({ duration: 15, duration_mode: "source" }));
    input.sourceUrls = ["video-a", "image-a"];
    input.parameters = { seconds: 3, size: "16:9", resolution: "720p", videoMode: "extend", generateAudio: false };
    expect(await preparePromptTaskInput(f.compiler, actor, input, { videoSourceMimeTypes: ["video/mp4", "image/png"] })).toMatchObject({ prompt });
    const payload = JSON.parse((f.calls[0]![1][0] as { text: string }).text);
    expect(payload.fields).toMatchObject({ duration: 3, duration_mode: "added", video_mode: "extend", generate_audio: true, native_audio: true });
    expect(payload.images).toEqual([{ index: 1, role: "参考图片" }]);
    expect(f.reads).toEqual(["image-a"]);
  });

  test.each(["first-frame", "first-last-frame"])("Omni %s labels only the actual frames while retaining additional references", async videoMode => {
    const f = await fixture(undefined, "gemini-omni-1.2-flash");
    const input = task(); input.sourceUrls = ["image-a", "image-b", "image-c", "image-d"]; input.parameters.videoMode = videoMode;
    await preparePromptTaskInput(f.compiler, actor, input, { videoSourceMimeTypes: input.sourceUrls.map(() => "image/png") });
    const payload = JSON.parse((f.calls[0]![1][0] as { text: string }).text);
    expect(payload.images.map((image: { role: string }) => image.role)).toEqual(videoMode === "first-frame" ? ["首帧", "参考图片", "参考图片", "参考图片"] : ["首帧", "尾帧", "参考图片", "参考图片"]);
    expect(payload.fields.duration_mode).toBe("output");
    expect(f.reads).toEqual(input.sourceUrls);
  });

  test("a client cannot claim Omni source-duration semantics for an authoritative Seedance model", async () => {
    const f = await fixture(async () => ({ content: JSON.stringify({ ...output, prompt: "只调整光线。" }) }));
    const input = task(motion({ model: "gemini-omni-1.2-flash", duration_mode: "source" }));
    input.parameters.modelId = "gemini-omni-1.2-flash";
    await expect(preparePromptTaskInput(f.compiler, actor, input, { videoSourceMimeTypes: ["image/png"] })).rejects.toMatchObject({ code: "PROMPT_VIDEO_TIMELINE_INVALID" });
    const payload = JSON.parse((f.calls[0]![1][0] as { text: string }).text);
    expect(payload.fields.duration).toBe(5); expect(payload.fields.generate_audio).toBe(false);
    expect(payload.fields).not.toHaveProperty("duration_mode");
  });

  test("actual video parameters override claimed fields; images only; public summary and same-input reuse", async () => {
    const f = await fixture();
    const input = task({ ...motion({ camera: "push", subject_action: ["turn"], duration: 30, generate_audio: true }), referenceRoles: ["商品", "动作参考", "声音参考"] });
    input.sourceUrls = ["image-a", "video-a", "audio-a"];
    input.parameters.videoMode = "reference";
    const options = { videoSourceMimeTypes: ["image/png", "video/mp4", "audio/mpeg"] };
    const first = await preparePromptTaskInput(f.compiler, actor, input, options);
    expect(f.reads).toEqual(["image-a"]);
    const payload = JSON.parse((f.calls[0]![1][0] as { text: string }).text);
    expect(payload).toMatchObject({ model_style: "video", mode: "video", output_language: "zh", fields: { camera: "缓慢推近", subject_action: ["转身展示"], duration: 5, generate_audio: false, media_references: [{ kind: "video", index: 1, role: "动作参考" }, { kind: "audio", index: 1, role: "声音参考" }] }, images: [{ index: 1, role: "商品" }] });
    expect(f.calls[0]![1].filter(part => part.type === "input_image")).toHaveLength(1);
    expect(first.summaryZh).toBe(output.summary_zh); expect(first.parameters.promptOptimization).toMatchObject({ summaryZh: output.summary_zh });
    await preparePromptTaskInput(f.compiler, actor, { ...input, requestId: randomUUID() }, options);
    expect(f.calls).toHaveLength(1);
    expect(payload.fields.media_source_ids).toBeUndefined();
    await preparePromptTaskInput(f.compiler, actor, { ...input, requestId: randomUUID(), sourceUrls: ["image-a", "video-b", "audio-a"] }, options);
    expect(f.calls).toHaveLength(2);
    const publicResult = publicPromptCompilation((await f.store.byRequest(actor.id, input.requestId))!);
    expect(publicResult.summaryZh).toBe(output.summary_zh);
    expect(JSON.stringify(publicResult)).not.toMatch(/rawResponse|systemPrompt|vision-fixture|latencyMs|actualCost/);
    await expect(preparePromptTaskInput(f.compiler, actor, { ...input, requestId: randomUUID(), operationType: "image_generation" }, options)).rejects.toMatchObject({ code: "PROMPT_OPERATION_INVALID" });
    await expect(preparePromptTaskInput(f.compiler, actor, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: "VIDEO_PREFLIGHT_REQUIRED" });
  });
  test("text-only and blank descriptions are valid; changed parameters invalidate reuse", async () => {
    const f = await fixture(async (_system, parts) => {
      const payload = JSON.parse((parts[0] as { text: string }).text);
      return { content: JSON.stringify({ prompt: `0-${payload.fields.duration}秒：镜头缓慢推近一件针织毛衫。`, summary_zh: "缓慢推近针织毛衫" }) };
    });
    const input = { ...task(), sourceUrls: [], parameters: { seconds: 5, resolution: "720p", size: "adaptive", videoMode: "text", generateAudio: false } };
    const first = await preparePromptTaskInput(f.compiler, actor, input, { videoSourceMimeTypes: [] });
    expect(first.optimized).toBe(true); expect(f.calls).toHaveLength(1);
    await preparePromptTaskInput(f.compiler, actor, { ...input, requestId: randomUUID(), parameters: { ...input.parameters, seconds: 8 } }, { videoSourceMimeTypes: [] });
    expect(f.calls).toHaveLength(2);
  });
  test("invalid new timelines are stored as failed and cannot become a success cache or silently retry", async () => {
    const invalidPrompt = "0-2.5秒缓慢推进，2.5-5秒保持。";
    let prompt = invalidPrompt;
    const f = await fixture(async () => ({ content: JSON.stringify({ ...output, prompt }) }));
    const input = task(), options = { videoSourceMimeTypes: ["image/png"] };
    const failure = { code: "PROMPT_VIDEO_TIMELINE_INVALID", status: 422 };
    await expect(preparePromptTaskInput(f.compiler, actor, input, options)).rejects.toMatchObject(failure);
    expect(f.calls).toHaveLength(1);
    const compiled = (await f.store.byRequest(actor.id, input.requestId))!;
    expect(compiled).toMatchObject({ status: "failed", errorCode: failure.code });
    expect(compiled.prompt).toBeUndefined();
    await expect(preparePromptTaskInput(f.compiler, actor, input, options)).rejects.toMatchObject(failure);
    await expect(preparePromptTaskInput(f.compiler, actor, { ...input, requestId: randomUUID(), promptInput: { ...input.promptInput, compilationId: compiled.id } }, options)).rejects.toMatchObject(failure);
    expect(f.calls).toHaveLength(1);
    // An explicit new request is allowed, but it cannot reuse the invalid result.
    prompt = output.prompt;
    const newRequest = { ...input, requestId: randomUUID() };
    await expect(preparePromptTaskInput(f.compiler, actor, newRequest, options)).resolves.toMatchObject({ prompt: output.prompt });
    expect((await f.store.byRequest(actor.id, newRequest.requestId))!).toMatchObject({ status: "success", cacheHit: false });
    expect(f.calls).toHaveLength(2);
  });
  test("stored success timelines are rechecked for same-request, cached and explicit reuse without a planner call", async () => {
    const f = await fixture(), input = task(), options = { videoSourceMimeTypes: ["image/png"] };
    await preparePromptTaskInput(f.compiler, actor, input, options);
    const compiled = (await f.store.byRequest(actor.id, input.requestId))!;
    // Seed a pre-validation success record in this isolated in-memory store.
    const row = (await f.store.database.query<{ details: string }>("SELECT details FROM prompt_compilations WHERE id=$1", [compiled.id])).rows[0]!;
    await f.store.database.query("UPDATE prompt_compilations SET details=$1 WHERE id=$2", [JSON.stringify({ ...JSON.parse(row.details), prompt: "0-2.5秒推进，2.5-5秒保持。" }), compiled.id]);
    const failure = { code: "PROMPT_VIDEO_TIMELINE_INVALID", status: 422 };
    await expect(preparePromptTaskInput(f.compiler, actor, input, options)).rejects.toMatchObject(failure);
    await expect(preparePromptTaskInput(f.compiler, actor, { ...input, requestId: randomUUID() }, options)).rejects.toMatchObject(failure);
    await expect(preparePromptTaskInput(f.compiler, actor, { ...input, requestId: randomUUID(), promptInput: { ...input.promptInput, compilationId: compiled.id } }, options)).rejects.toMatchObject(failure);
    expect(f.calls).toHaveLength(1);
  });
  test("authoritative task duration overrides claimed fields when validating the compiled timeline", async () => {
    const f = await fixture();
    const input = task(motion({ duration: 5 }));
    input.parameters.seconds = 8;
    await expect(preparePromptTaskInput(f.compiler, actor, input, { videoSourceMimeTypes: ["image/png"] })).rejects.toMatchObject({ code: "PROMPT_VIDEO_TIMELINE_INVALID", status: 422 });
    const payload = JSON.parse((f.calls[0]![1][0] as { text: string }).text);
    expect(payload.fields.duration).toBe(8);
    expect(f.calls).toHaveLength(1);
  });
  test("final preparation checks fallback timelines and preserves valid fallback behavior", async () => {
    const f = await fixture(async () => ({ content: "not JSON" }));
    await f.store.update("video-motion", { ...(await f.store.get("video-motion")), failurePolicy: "fallback" });
    for (const [prompt, accepted] of [["0-2.5秒推进，2.5-5秒保持。", false], ["0-2秒推进，2-5秒保持。", true]] as const) {
      const version = await f.store.saveVersion("video-motion", { systemPrompt: "Private fixture only; emit the required JSON object.", fieldTemplate: "", modelOverrides: {}, fallbackPrompt: JSON.stringify({ ...output, prompt }), outputLanguage: "zh", changeNote: "fallback fixture" }, "admin");
      await f.store.activate("video-motion", version.id);
      const input = task(), result = preparePromptTaskInput(f.compiler, actor, input, { videoSourceMimeTypes: ["image/png"] });
      if (accepted) expect(await result).toMatchObject({ prompt, optimized: false });
      else await expect(result).rejects.toMatchObject({ code: "PROMPT_VIDEO_TIMELINE_INVALID", status: 422 });
      expect((await f.store.byRequest(actor.id, input.requestId))!).toMatchObject(accepted ? { status: "success", optimized: false } : { status: "failed", errorCode: "PROMPT_VIDEO_TIMELINE_INVALID" });
    }
    expect(f.calls).toHaveLength(2);
  });
  test("automatic video duration can retain an unsegmented plan", async () => {
    const prompt = "以图片1为首帧，镜头缓慢推近毛衫并自然结束。";
    const f = await fixture(async () => ({ content: JSON.stringify({ ...output, prompt }) }));
    const input = task(); input.parameters.seconds = -1;
    expect(await preparePromptTaskInput(f.compiler, actor, input, { videoSourceMimeTypes: ["image/png"] })).toMatchObject({ prompt, optimized: true });
    expect(f.calls).toHaveLength(1);
  });
  test("admin HTTP trial reports malformed timelines as failed and never returns an invalid stored success", async () => {
    let prompt = "0-2.5秒推进，2.5-5秒保持。";
    const f = await fixture(async () => ({ content: JSON.stringify({ ...output, prompt }) }));
    const admin = { ...actor, role: "super_admin" };
    const app = express(); app.use(express.json());
    app.use((request, _response, next) => { Object.assign(request, { auth: admin }); next(); });
    app.use("/recipes", createAdminPromptRecipesRouter(f.compiler, async () => [], async () => {}));
    const server = app.listen(0, "127.0.0.1"); servers.push(server); await new Promise<void>(done => server.once("listening", done));
    const address = server.address() as { port: number };
    const input = { requestId: randomUUID(), modelConfigId: targetId, toolKey: "video", sourceUrls: ["image-a"], promptInput: motion({ duration: 5 }), versionId: (await f.store.active("video-motion")).version.id };
    const post = (body: typeof input) => fetch(`http://127.0.0.1:${address.port}/recipes/video-motion/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await post(input);
      expect(response.status).toBe(200);
      expect((await response.json()).compilation).toMatchObject({ status: "failed", errorCode: "PROMPT_VIDEO_TIMELINE_INVALID" });
    }
    expect(f.calls).toHaveLength(1);
    expect((await f.store.byRequest(admin.id, input.requestId))!).toMatchObject({ status: "failed", cacheHit: false });
    prompt = output.prompt;
    const validInput = { ...input, requestId: randomUUID() };
    const validResponse = await post(validInput);
    expect(validResponse.status).toBe(200);
    const valid = (await validResponse.json()).compilation;
    expect(valid).toMatchObject({ status: "success", prompt: output.prompt });
    expect(f.calls).toHaveLength(2);
    const row = (await f.store.database.query<{ details: string }>("SELECT details FROM prompt_compilations WHERE id=$1", [valid.id])).rows[0]!;
    await f.store.database.query("UPDATE prompt_compilations SET details=$1 WHERE id=$2", [JSON.stringify({ ...JSON.parse(row.details), prompt: "0-6秒推进。" }), valid.id]);
    const cachedResponse = await post({ ...validInput, requestId: randomUUID() });
    expect(cachedResponse.status).toBe(422);
    expect(await cachedResponse.json()).toMatchObject({ error: "PROMPT_VIDEO_TIMELINE_INVALID" });
    expect(f.calls).toHaveLength(2);
  });
  test("formal HTTP rejects a timeline that conflicts with normalized preflight duration before task writes or queue admission", async () => {
    const f = await fixture();
    let writes = 0, queues = 0;
    const db = { query: async (sql: string) => {
      if (sql.includes("FROM module_flags")) return { rows: [{ enabled: true }] };
      if (sql.includes("FROM tool_api_configurations")) return { rows: [] };
      if (sql.includes("FROM model_configs")) return { rows: [{ id: targetId, modelId: "doubao-seedance-2.5", capabilities: ["video"], enabled: true, providerEnabled: true }] };
      if (sql.includes("SELECT count(*)::int")) return { rows: [{ count: 0 }] };
      if (sql.startsWith("SELECT")) return { rows: [] };
      writes++; throw new Error("Unexpected task or credit write for invalid timeline");
    } };
    const app = express(); app.use(express.json());
    app.use((request, _response, next) => { Object.assign(request, { auth: actor }); next(); });
    app.use("/tasks", createTasksRouter(db as never, { eval: async () => { queues++; throw new Error("Unexpected queue admission"); } } as never, false,
      (async () => ({ normalized: { seconds: 8 }, snapshot: { assets: [{ mimeType: "image/png" }] } })) as never, { promptCompiler: f.compiler }));
    app.use(((error, _request, response, _next) => response.status(error.status ?? 400).json({ error: error.code })) as ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1"); servers.push(server); await new Promise<void>(done => server.once("listening", done));
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(task()) });
    expect(response.status).toBe(422); expect((await response.json()).error).toBe("PROMPT_VIDEO_TIMELINE_INVALID");
    expect(JSON.parse((f.calls[0]![1][0] as { text: string }).text).fields.duration).toBe(8);
    expect(f.calls).toHaveLength(1); expect(writes).toBe(0); expect(queues).toBe(0);
  });
  test("formal HTTP preflight failure does not call the planner or reserve a task", async () => {
    const f = await fixture();
    let preflights = 0;
    const db = { query: async (sql: string) => {
      if (sql.includes("FROM module_flags")) return { rows: [{ enabled: true }] };
      if (sql.includes("FROM tool_api_configurations")) return { rows: [] };
      if (sql.includes("FROM model_configs")) return { rows: [{ id: targetId, modelId: "doubao-seedance-2.5", capabilities: ["video"], enabled: true, providerEnabled: true }] };
      if (sql.includes("SELECT count(*)::int")) return { rows: [{ count: 0 }] };
      if (sql.startsWith("SELECT")) return { rows: [] };
      throw new Error("Unexpected write before valid preflight");
    } };
    const app = express(); app.use(express.json());
    app.use((request, _response, next) => { Object.assign(request, { auth: actor }); next(); });
    app.use("/tasks", createTasksRouter(db as never, {} as never, false, (async () => { preflights++; throw new BillingError("INVALID_VIDEO_INPUT", "素材尺寸不合格"); }) as never, { promptCompiler: f.compiler }));
    app.use(((error, _request, response, _next) => response.status(error.status ?? 400).json({ error: error.code })) as ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1"); servers.push(server); await new Promise<void>(done => server.once("listening", done));
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(task()) });
    expect(response.status).toBe(400); expect((await response.json()).error).toBe("INVALID_VIDEO_INPUT");
    expect(preflights).toBe(1); expect(f.calls).toHaveLength(0); expect(await f.store.recent("video-motion")).toEqual([]);
  });
});
