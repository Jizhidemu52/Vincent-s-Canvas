import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoMarkProvider } from "../src/demo-mark-provider";
import { DemoAdmissionGate, DemoPromptBatchStore } from "../src/demo-prompt-batches";
import { sqlitePromptRecipeStore } from "../src/demo-prompt-recipes";
import { createDemoPromptCompiler, handleDemoPromptRecipes } from "../src/demo-prompt-runtime";
import { importPromptRecipes } from "../src/prompt-recipe-import";

const actor = { id: "fixture-owner", role: "designer", departmentId: null };
const admin = { ...actor, role: "super_admin" };
const provider = createDemoMarkProvider({ apiKey: "local-fixture-only", baseUrl: "http://127.0.0.1:1/v1" });
const optimizerId = String(provider.models.find(model => model.modelId === "claude-sonnet-5-5")!.id);
const source = readFileSync(new URL("../../docs/manual/prompt-optimization/无线画布-板块系统提示词（机密）.md", import.meta.url), "utf8");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("Demo runtime checks reference ownership before materializing bytes and validates MIME", async () => {
  const db = sqlitePromptRecipeStore(":memory:");
  let reads = 0;
  const id = crypto.randomUUID();
  const asset = { id, ownerUserId: "another-owner", mimeType: "image/png", get bytes() { reads++; return png; } };
  const compiler = createDemoPromptCompiler(db.store, { models: provider.models, providers: [provider.provider], tools: [], flags: {}, credential: () => provider.apiKey, asset: () => asset });
  try {
    await expect(compiler.runtime.readSource(actor, `https://example.invalid/${id}`)).rejects.toMatchObject({ code: "PROMPT_REFERENCE_INVALID" });
    await expect(compiler.runtime.readSource(actor, `/api/assets/${id}/content`)).rejects.toMatchObject({ code: "PROMPT_REFERENCE_FORBIDDEN" });
    expect(reads).toBe(0);
    asset.ownerUserId = actor.id;
    const actual = await compiler.runtime.readSource(actor, `/api/assets/${id}/content`);
    expect(actual.mimeType).toBe("image/png"); expect(actual.previewDataUrl).toStartWith("data:image/webp;base64,");
    expect(reads).toBe(1);
    asset.mimeType = "image/jpeg";
    await expect(compiler.runtime.readSource(actor, `/api/assets/${id}/content`)).rejects.toMatchObject({ code: "PROMPT_REFERENCE_INVALID" });
    await expect(compiler.runtime.resolveOptimizer(String(provider.models[0]!.id))).rejects.toMatchObject({ code: "PROMPT_MODEL_UNAVAILABLE" });
    expect((await compiler.runtime.resolveOptimizer(optimizerId)).id).toBe(optimizerId);
  } finally { db.close(); }
});

test("Demo recipe adapter exposes admin contracts only to super_admin and keeps SQLite versions across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canvas-demo-recipes-"));
  const path = join(directory, "state.sqlite");
  let db = sqlitePromptRecipeStore(path);
  const audit: string[] = [];
  const context = { models: async () => provider.models, audit: async (_actor: unknown, action: string) => { audit.push(action); } };
  const compiler = () => createDemoPromptCompiler(db.store, { models: provider.models, providers: [provider.provider], tools: [], flags: {}, credential: () => provider.apiKey, asset: () => undefined });
  const call = (route: string, method = "GET", body?: unknown, user: typeof actor | null = admin) => handleDemoPromptRecipes(new Request("http://localhost/api/" + route, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) }), compiler(), user, context);
  try {
    await importPromptRecipes(db.store, source, { actorId: admin.id, modelConfigId: optimizerId, activate: true });
    expect((await call("admin/prompt-recipes", "GET", undefined, actor))!.status).toBe(403);
    expect((await call("prompt-compilations/by-request/unknown00", "GET", undefined, null))!.status).toBe(401);
    const list = await (await call("admin/prompt-recipes"))!.json();
    expect(list.recipes).toHaveLength(18); expect(list.recipes.every((recipe: { enabled: boolean }) => recipe.enabled)).toBe(true);
    const original = await db.store.active("creative-chat");
    const changed = await (await call("admin/prompt-recipes/creative-chat/versions", "POST", { ...original.version, systemPrompt: "Private edited rule for a local fixture.", changeNote: "local-only" }))!.json();
    expect((await call("admin/prompt-recipes/creative-chat/activate", "POST", { versionId: changed.version.id }))!.status).toBe(200);
    expect((await call("admin/prompt-recipes/creative-chat", "PATCH", { ...(await db.store.get("creative-chat")), enabled: false }))!.status).toBe(200);
    db.close(); db = sqlitePromptRecipeStore(path);
    const detail = await (await call("admin/prompt-recipes/creative-chat"))!.json();
    expect(detail.recipe).toMatchObject({ currentVersionId: changed.version.id, enabled: false });
    expect(detail.versions).toHaveLength(2);
    await importPromptRecipes(db.store, source, { actorId: admin.id, modelConfigId: "do-not-overwrite", activate: true });
    expect((await db.store.get("creative-chat"))).toMatchObject({ currentVersionId: changed.version.id, enabled: false, modelConfigId: optimizerId });
    expect(audit).toEqual(["prompt_recipe.version_saved", "prompt_recipe.activated", "prompt_recipe.updated"]);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Demo admission gate shares one submission, rejects changed concurrent input, and releases after errors", async () => {
  const gate = new DemoAdmissionGate();
  let calls = 0;
  let release!: () => void;
  const wait = new Promise<void>(done => { release = done; });
  const action = async () => { calls++; await wait; return Response.json({ taskId: "same" }); };
  const first = gate.run("request", "hash", action), second = gate.run("request", "hash", action);
  await expect(gate.run("request", "changed", action)).rejects.toMatchObject({ code: "PROMPT_REQUEST_CHANGED" });
  release();
  const responses = await Promise.all([first, second]);
  expect(await responses[0]!.json()).toEqual(await responses[1]!.json()); expect(calls).toBe(1);
  await expect(gate.run("failed", "hash", async () => { throw new Error("fixture"); })).rejects.toThrow("fixture");
  expect((await gate.run("failed", "hash", action)).status).toBe(200);
});

test("durable Demo batch recovery reports interrupted unadmitted items without replaying work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canvas-demo-batches-"));
  const path = join(directory, "state.sqlite");
  let db = sqlitePromptRecipeStore(path);
  let batches = new DemoPromptBatchStore(db.store.database);
  try {
    await batches.initialize();
    const batch = await batches.create(actor.id, "batch-request", "input-hash", { prompt: "One compiled prompt", optimized: true, projectId: "project", operationType: "batch_image", modelConfigId: "model", totalItems: 3 });
    const tasks = [{ id: "task", requestId: "batch-request:0", ownerUserId: actor.id, batchId: batch.id }, { id: "other-user-task", requestId: "batch-request:1", ownerUserId: "other", batchId: batch.id }];
    await batches.failure(batch, { index: 1, reason: "Invalid reference", code: "INVALID_SOURCE" });
    expect(batches.result(batch, tasks)).toMatchObject({ totalItems: 3, submissionComplete: false });
    db.close(); db = sqlitePromptRecipeStore(path); batches = new DemoPromptBatchStore(db.store.database); await batches.initialize();
    const recovered = await batches.get(actor.id, "batch-request");
    const result = batches.result(recovered!, tasks);
    expect(result).toMatchObject({ batchId: batch.id, submissionComplete: true, totalItems: 3, prompt: "One compiled prompt", optimized: true });
    expect(result.tasks.map(task => task.itemIndex)).toEqual([0]);
    expect(result.failures).toEqual([{ index: 1, reason: "Invalid reference", code: "INVALID_SOURCE" }, { index: 2, reason: expect.any(String), code: "BATCH_SUBMISSION_INTERRUPTED" }]);
    expect(await batches.get("other-user", "batch-request")).toBeNull();
    await expect(batches.create(actor.id, "batch-request", "changed", { prompt: "different", optimized: false, projectId: "project", operationType: "batch_image", modelConfigId: "model", totalItems: 1 })).rejects.toMatchObject({ code: "PROMPT_REQUEST_CHANGED" });
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
