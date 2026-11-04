import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import type { Server } from "node:http";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { PromptCompiler } from "../../src/prompt-compiler";
import { postgresPromptRecipeStore } from "../../src/prompt-recipe-postgres";
import { ensureVideoMotionRecipe } from "../../src/video-motion-input";
import { preflightStoredVideoTask } from "../../src/stored-video-preflight";
import { createTasksRouter } from "../../src/routes/tasks";
import { createPublicModelRouter } from "../../src/routes/model-configuration";
import { resolveToolExecution } from "../../src/tool-configuration";
import { promptInputSchema } from "../../../shared/prompt-contracts";

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
integration("video motion formal SQL admission", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>, server: Server, base: string;
  const userId = randomUUID(), providerId = randomUUID(), modelId = randomUUID(), assetId = randomUUID();
  const sourceUrl = `/api/assets/${assetId}/content`, summaryZh = "镜头轻推近针织纹理";
  let width = 768, invalidOutput = false, plannerCalls = 0, preflights = 0, queueCalls = 0;
  const order: string[] = [];
  const query = (sql: string, values: unknown[] = []) => fixture.db.query(sql, values);
  const input = () => ({ requestId: randomUUID(), projectId: "video-motion-fixture", operationType: "video_generation", toolKey: "video", modelConfigId: modelId, prompt: "",
    promptInput: promptInputSchema.parse({ scene: "video-motion", mode: "video", fields: { duration: 30 }, userText: "" }), parameters: { videoMode: "auto", seconds: 5, resolution: "720p", size: "adaptive" }, sourceUrls: [sourceUrl] });
  const request = (path: string, body?: unknown) => fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await query("INSERT INTO users(id,username,display_name,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,$2,'video-motion fixture',1000,1000,1000)", [userId, `video-${userId}`]);
    await query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'video-motion fixture','apimart','https://no-network.invalid','fixture-only')", [providerId]);
    await query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'Seedance fixture','doubao-seedance-2.5',ARRAY['video'])", [modelId, providerId]);
    await query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,source,status) VALUES($1,$2,'video-motion/image','shirt.png','image/png',3,'image','upload','ready')", [assetId, userId]);
    const store = postgresPromptRecipeStore(fixture.db);
    await ensureVideoMotionRecipe(store);
    expect((await store.get("video-motion")).currentVersionId).toBeNull();
    expect(await store.versions("video-motion")).toEqual([]);
    await store.update("video-motion", { ...(await store.get("video-motion")), modelConfigId: "fixture-optimizer" });
    const version = await store.saveVersion("video-motion", { systemPrompt: "Private test-only authoring rule.", fieldTemplate: "", modelOverrides: {}, fallbackPrompt: "", outputLanguage: "zh", changeNote: "fixture" }, userId);
    await store.activate("video-motion", version.id);
    const compiler = new PromptCompiler(store, {
      resolveTarget: async (_actor, data) => { const target = await resolveToolExecution(fixture.db, { operationType: "video_generation", toolKey: data.toolKey, modelConfigId: data.modelConfigId }); return { id: target.modelConfigId, modelId: "doubao-seedance-2.5", protocol: "apimart", fingerprint: target.modelConfigId }; },
      resolveOptimizer: async () => ({ id: "fixture-optimizer", modelId: "fixture-vision", fingerprint: "fixture-vision", estimatedRmbCost: null, invoke: async (_system, content) => {
        order.push("planner"); plannerCalls++;
        const payload = JSON.parse((content[0] as { text: string }).text);
        expect(payload.fields.duration).toBe(5); expect(payload.fields.generate_audio).toBe(false);
        return { content: invalidOutput ? "invalid JSON" : JSON.stringify({ prompt: "以图片1为首帧。0-5秒：镜头轻推近针织纹理，保持毛衫款式颜色。", summary_zh: summaryZh }) };
      } }),
      readSource: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", previewDataUrl: "data:image/webp;base64,eA==" }),
    });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { auth: { id: userId, role: "designer", departmentId: null } }); next(); });
    app.use("/tasks", createTasksRouter(fixture.db, { eval: async () => { queueCalls++; order.push("queue"); return 1; } } as never, false, async (db, task) => {
      preflights++; order.push("preflight");
      return preflightStoredVideoTask(db, task, "", { readSource: async () => (async function* () { yield new Uint8Array([1, 2, 3]); })(), probe: async () => ({ width, height: 768 }) });
    }, { promptCompiler: compiler }));
    app.use("/models", createPublicModelRouter(fixture.db));
    app.use(((error, _req, res, _next) => res.status(error.status ?? 400).json({ error: error.code, message: error.message })) as ErrorRequestHandler);
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(done => server.once("listening", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 30_000);
  afterAll(async () => { if (server) await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }); await fixture?.close(); });

  test("invalid media fails before paid compilation or reservation", async () => {
    width = 100;
    const value = input();
    const response = await request("/tasks", value);
    expect(response.status).toBe(400); expect((await response.json()).error).toBe("INVALID_VIDEO_INPUT");
    expect(plannerCalls).toBe(0); expect(queueCalls).toBe(0);
    expect((await query("SELECT count(*)::int AS n FROM tasks")).rows[0].n).toBe(0);
    expect((await query("SELECT count(*)::int AS n FROM credit_reservations")).rows[0].n).toBe(0);
    width = 768;
  });
  test("one validated preflight precedes LLM and admission; duplicate and matching input reuse planning", async () => {
    order.length = 0; const previousChecks = preflights;
    const value = input();
    const response = await request("/tasks", value); expect(response.status).toBe(201);
    const created = await response.json(); expect(created.task.summaryZh).toBe(summaryZh);
    expect(order).toEqual(["preflight", "planner", "queue"]); expect(preflights - previousChecks).toBe(1);
    expect(created.task.parameters).toMatchObject({ videoMode: "first-frame", generateAudio: false, promptOptimization: { summaryZh } });
    expect(created.task.userInput.fields.duration).toBe(5);
    const detail = await (await request(`/tasks/by-request/${value.requestId}`)).json();
    expect(detail.task.summaryZh).toBe(summaryZh);
    expect(JSON.stringify(detail)).not.toMatch(/Private test-only|rawResponse|fixture-vision|latencyMs|actualCost/);
    const repeated = await request("/tasks", value); expect(repeated.status).toBe(200);
    expect((await repeated.json()).task.id).toBe(created.task.id); expect(plannerCalls).toBe(1);
    const next = await request("/tasks", { ...value, requestId: randomUUID() }); expect(next.status).toBe(201); expect(plannerCalls).toBe(1);
    const listed = await (await request("/tasks?operationType=video_generation")).json();
    expect(listed.tasks.every((item: { summaryZh: string }) => item.summaryZh === summaryZh)).toBe(true);
  });
  test("invalid planner output creates no video task; explicit raw switch persists in the real column", async () => {
    invalidOutput = true;
    const value = input(); value.promptInput.userText = "invalid unique";
    const previousQueue = queueCalls;
    expect((await request("/tasks", value)).status).toBe(422);
    expect((await request(`/tasks/by-request/${value.requestId}`)).status).toBe(404);
    expect(queueCalls).toBe(previousQueue);
    const raw = { ...input(), prompt: "明确自写的视频提示词", promptInput: undefined, parameters: { videoMode: "first-frame", seconds: 5, resolution: "720p", size: "adaptive", promptOptimization: { summaryZh: "forged" } } };
    expect((await request("/tasks", raw)).status).toBe(403);
    await query("UPDATE tool_api_configurations SET allow_raw_prompt=true WHERE tool_key='video'");
    expect((await (await request("/models")).json()).tools.find((tool: { toolKey: string }) => tool.toolKey === "video").allowRawPrompt).toBe(true);
    const permitted = await request("/tasks", raw); expect(permitted.status).toBe(201);
    const result = await permitted.json(); expect(result.task.optimized).toBe(false); expect(result.task.summaryZh).toBeUndefined(); expect(result.task.parameters.promptOptimization).toBeUndefined();
  });
});
