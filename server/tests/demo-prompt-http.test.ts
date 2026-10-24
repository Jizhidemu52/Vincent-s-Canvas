import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sqlitePromptRecipeStore } from "../src/demo-prompt-recipes";
import { importPromptRecipes } from "../src/prompt-recipe-import";

const optimizerId = "d5000000-0000-4000-8000-000000000010";
const imageId = "40000000-0000-4000-8000-000000000105";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const finalPrompt = "A pale blue linen shirt in soft daylight on a clean white background.";

test("real Demo HTTP compiles once, fails closed, keeps private rules server-side, and resumes durable batches", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canvas-demo-prompt-http-"));
  const statePath = join(directory, "state.sqlite");
  const db = sqlitePromptRecipeStore(statePath);
  const source = readFileSync(new URL("../../docs/manual/prompt-optimization/无线画布-板块系统提示词（机密）.md", import.meta.url), "utf8");
  await importPromptRecipes(db.store, source, { actorId: "local-test-admin", modelConfigId: optimizerId, activate: true });
  const rules = (await db.store.active("text-to-style")).version.systemPrompt;
  const chatRules = (await db.store.active("canvas-assistant")).version.systemPrompt;
  db.close();
  const optimizerCalls: Record<string, any>[] = [], imageCalls: Array<Record<string, unknown>> = [], chatCalls: Record<string, any>[] = [];
  let output: "good" | "invalid" | "leak" = "good";
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/mark/v1/messages") {
      expect(request.headers.get("authorization")).toBe("Bearer isolated-prompt-fixture");
      const body = await request.json() as Record<string, any>;
      const isChat = Array.isArray(body.tools) && body.tools.length > 0;
      (isChat ? chatCalls : optimizerCalls).push(body);
      await Bun.sleep(20);
      const content = output === "invalid" ? "not valid JSON" : output === "leak" ? (isChat ? chatRules : JSON.stringify({ prompt: rules, avoid: [], keep_text: [] })) : isChat ? "已检查衬衫。" : JSON.stringify({ prompt: finalPrompt, avoid: [], keep_text: [] });
      return Response.json({ content: [{ type: "text", text: content }], stop_reason: "end_turn", usage: { input_tokens: 125, output_tokens: 30 } });
    }
    if (path === "/opentoken/v1/images/generations" || path === "/opentoken/v1/images/edits") {
      expect(request.headers.get("authorization")).toBe("Bearer isolated-image-fixture");
      const body = request.headers.get("content-type")?.includes("application/json") ? await request.json() : Object.fromEntries(await request.formData());
      imageCalls.push(body as Record<string, unknown>);
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    }
    return Response.json({ error: "Only loopback fixture routes are permitted" }, { status: 400 });
  } });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!; reservation.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const start = () => Bun.spawn([process.execPath, "src/demo-server.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "ignore", stderr: "pipe",
    env: { ...process.env, DEMO_STATE_PATH: statePath, DEMO_RECOVERY_FILE: "", DEMO_PORT: String(port), DEMO_HOST: "127.0.0.1",
      OA_LOGIN_ENABLED: "false", AUTH_ENABLED: "true", CREDITS_ENABLED: "false", LOCAL_STANDALONE: "false", ROLE_PORTALS_ENABLED: "true", STANDALONE_WEB_DIR: "", DEMO_PUBLIC_ASSET_ORIGIN: "",
      OPENTOKEN_BASE_URL: `http://127.0.0.1:${provider.port}/opentoken/v1`, OPENTOKEN_API_KEY: "isolated-image-fixture",
      MARK_IMAGE_BASE_URL: `http://127.0.0.1:${provider.port}/mark/v1`, MARK_IMAGE_API_KEY: "isolated-prompt-fixture",
      APIMART_BASE_URL: `http://127.0.0.1:${provider.port}/disabled/v1`, APIMART_API_KEY: "", GPT_IMAGE_2_API_KEY: "" },
  });
  let child = start();
  const ready = async () => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await fetch(base + "/api/health").then(response => response.ok).catch(() => false)) return;
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      await Bun.sleep(40);
    }
    throw new Error("Demo fixture startup timed out");
  };
  const request = (path: string, method = "GET", body?: unknown) => fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12_000) });
  const settle = async (id: string) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const body = await (await request(`/api/tasks/${id}`)).json();
      if (body.task.status !== "processing") return body.task;
      await Bun.sleep(40);
    }
    throw new Error("Local image fixture did not settle");
  };
  try {
    await ready();
    expect((await request("/api/admin/prompt-recipes")).status).toBe(403);
    const promptInput = { scene: "text-to-style", mode: "generate", fields: { material: "linen" }, userText: "A pale blue shirt", hasMask: false, referenceRoles: [] };
    const input = { requestId: crypto.randomUUID(), projectId: "prompt-test", operationType: "image_generation", toolKey: "creative-text-to-style", modelConfigId: imageId, prompt: "client template must be ignored", promptInput, parameters: {}, sourceUrls: [] };
    const responses = await Promise.all([request("/api/tasks", "POST", input), request("/api/tasks", "POST", input)]);
    expect(responses.map(response => response.status)).toEqual([201, 201]);
    const [one, duplicate] = await Promise.all(responses.map(response => response.json()));
    expect(one.task.id).toBe(duplicate.task.id); expect(one.task.prompt).toBe(finalPrompt); expect(one.task.optimized).toBe(true);
    expect(one.task.userInput).toMatchObject({ userText: promptInput.userText, compilationId: expect.any(String) });
    expect(one.task.promptCompilationId).toBeUndefined(); expect(one.task.submissionHash).toBeUndefined();
    expect((await settle(one.task.id)).status).toBe("success");
    expect(optimizerCalls).toHaveLength(1); expect(imageCalls).toHaveLength(1);
    expect(optimizerCalls[0]!.system).toContain(rules); expect(optimizerCalls[0]!.stream).not.toBe(true);
    expect(imageCalls[0]!.prompt).toBe(finalPrompt);
    expect(JSON.stringify(one)).not.toMatch(/rawResponse|systemPrompt|recipeVersionId|isolated-prompt-fixture/);
    const compilation = await (await request(`/api/prompt-compilations/by-request/${input.requestId}`)).json();
    expect(Object.keys(compilation.compilation).sort()).toEqual(["id", "optimized", "prompt", "requestId", "status"]);
    expect((await request("/api/tasks", "POST", { ...input, prompt: "changed input" })).status).toBe(409);
    expect((await request("/api/tasks", "POST", { ...input, requestId: crypto.randomUUID(), promptInput: undefined, parameters: { promptOptimization: { optimized: true, compilationId: compilation.compilation.id } } })).status).toBe(400);
    expect((await request("/api/tasks", "POST", { ...input, requestId: crypto.randomUUID(), promptInput: { ...promptInput, userText: "changed", compilationId: compilation.compilation.id } })).status).toBe(409);
    expect(optimizerCalls).toHaveLength(1); expect(imageCalls).toHaveLength(1);

    for (const mode of ["invalid", "leak"] as const) {
      output = mode;
      const invalid = { ...input, requestId: crypto.randomUUID(), promptInput: { ...promptInput, userText: "different " + mode } };
      expect((await request("/api/tasks", "POST", invalid)).status).toBe(422);
      expect((await request(`/api/tasks/by-request/${invalid.requestId}`)).status).toBe(404);
      expect((await request("/api/tasks", "POST", invalid)).status).toBe(422);
      expect(imageCalls).toHaveLength(1);
    }
    expect(optimizerCalls).toHaveLength(3);
    output = "good";
    const chatInput = { modelId: optimizerId, toolKey: "canvas-chat", profile: "canvas-assistant", profileContext: { stage: "plan", userText: "检查衬衫" }, input: [{ role: "user", content: "检查衬衫" }], tools: [], claude: { stream: true, thinking: true } };
    const chat = await request("/api/chat/responses", "POST", chatInput);
    expect(chat.status).toBe(200); expect(await chat.json()).toEqual({ content: "已检查衬衫。", toolCalls: [], stopReason: "end_turn" });
    expect(chatCalls[0]!.system).toContain(chatRules); expect(chatCalls[0]!.thinking).toBeUndefined(); expect(chatCalls[0]!.stream).not.toBe(true);
    output = "leak";
    const rejectedChat = await request("/api/chat/responses", "POST", chatInput);
    expect(rejectedChat.status).toBe(422); expect(await rejectedChat.text()).not.toContain(chatRules);
    output = "good";

    const uploaded = await (await request("/api/assets/upload-request", "POST", { filename: "shirt.png", mimeType: "image/png", byteSize: png.byteLength })).json();
    expect((await fetch(base + uploaded.uploadUrl, { method: "PUT", headers: { "content-type": "image/png" }, body: png })).status).toBe(204);
    const sourceUrls = [`/api/assets/${uploaded.assetId}/content`];
    const batch = { requestId: crypto.randomUUID(), projectId: "prompt-batch", operationType: "batch_image", toolKey: "canvas-batch", modelConfigId: imageId, prompt: "batch client text", parameters: {}, promptInput: { scene: "batch-optimize", mode: "edit", userText: "Make all shirts blue", fields: {}, referenceRoles: [], hasMask: false }, items: [{ sourceUrls }, { sourceUrls }] };
    const batchResponses = await Promise.all([request("/api/tasks/batch", "POST", batch), request("/api/tasks/batch", "POST", batch)]);
    expect(batchResponses.map(response => response.status)).toEqual([201, 201]);
    const [batchOne, batchDuplicate] = await Promise.all(batchResponses.map(response => response.json()));
    expect(typeof batchOne.batchId).toBe("string");
    expect(batchOne).toMatchObject({ prompt: finalPrompt, optimized: true, failures: [], submissionComplete: true, totalItems: 2 });
    expect(batchDuplicate.tasks.map((task: { id: string }) => task.id)).toEqual(batchOne.tasks.map((task: { id: string }) => task.id));
    expect(batchOne.tasks.map((task: { itemIndex: number }) => task.itemIndex)).toEqual([0, 1]);
    expect((await Promise.all(batchOne.tasks.map((task: { id: string }) => settle(task.id)))).map(task => task.status)).toEqual(["success", "success"]);
    expect(optimizerCalls).toHaveLength(4); expect(imageCalls).toHaveLength(3);
    child.kill(); await child.exited; child = start(); await ready();
    const resumed = await (await request(`/api/tasks/batches/by-request/${batch.requestId}`)).json();
    expect(resumed).toMatchObject({ batchId: batchOne.batchId, optimized: true, submissionComplete: true, totalItems: 2 });
    expect(resumed.tasks.map((task: { id: string }) => task.id)).toEqual(batchOne.tasks.map((task: { id: string }) => task.id));
    const replayed = await request("/api/tasks/batch", "POST", batch);
    expect(replayed.status).toBe(200); expect((await replayed.json()).batchId).toBe(batchOne.batchId);
    expect((await request("/api/tasks", "POST", input)).status).toBe(200);
    expect((await request("/api/tasks/batch", "POST", { ...batch, prompt: "changed" })).status).toBe(409);
    const cached = await request("/api/prompt-compilations", "POST", { requestId: crypto.randomUUID(), modelConfigId: imageId, toolKey: input.toolKey, promptInput, sourceUrls: [] });
    expect(cached.status).toBe(200); expect((await cached.json()).compilation.prompt).toBe(finalPrompt);
    expect(optimizerCalls).toHaveLength(4); expect(imageCalls).toHaveLength(3);
    output = "invalid";
    const rejectedBatch = { ...batch, requestId: crypto.randomUUID(), promptInput: { ...batch.promptInput, userText: "Unique rejected batch" } };
    expect((await request("/api/tasks/batch", "POST", rejectedBatch)).status).toBe(422);
    expect((await request(`/api/tasks/batches/by-request/${rejectedBatch.requestId}`)).status).toBe(404);
    expect((await request(`/api/tasks/by-request/${rejectedBatch.requestId}:0`)).status).toBe(404);
    expect((await request("/api/tasks/batch", "POST", rejectedBatch)).status).toBe(422);
    expect(optimizerCalls).toHaveLength(5); expect(imageCalls).toHaveLength(3);
    const saved = sqlitePromptRecipeStore(statePath);
    try {
      const stats = await saved.store.stats("text-to-style"); expect(stats.inputTokens).toBe(375); expect(stats.outputTokens).toBe(90); expect(stats.actualCost).toBe(0); expect(stats.unknownCostCount).toBe(3); expect(stats.cacheHits).toBe(1);
      await saved.store.update("text-to-style", { ...(await saved.store.get("text-to-style")), enabled: false });
      expect((await request("/api/tasks", "POST", { ...input, requestId: crypto.randomUUID(), promptInput: { ...promptInput, userText: "New disabled request" } })).status).toBe(503);
      expect(optimizerCalls).toHaveLength(5); expect(imageCalls).toHaveLength(3);
    }
    finally { saved.close(); }
  } finally {
    child.kill(); await child.exited; provider.stop(true); rmSync(directory, { recursive: true, force: true });
  }
}, 40_000);
