import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DemoPromptTemplateStore, handleDemoPromptTemplates, type DemoPromptContext } from "../src/demo-prompt-templates";
import { MARK_IMAGE_PROVIDER_ID } from "../../shared/mark-image-models";

const owner = { id: "00000000-0000-4000-8000-000000000003", role: "designer", departmentId: "10000000-0000-4000-8000-000000000001" };
const other = { id: "00000000-0000-4000-8000-000000000004", role: "super_admin" };
const modelId = "d5000000-0000-4000-8000-000000000001";
const assetId = "50000000-0000-4000-8000-000000000001", taskId = "60000000-0000-4000-8000-000000000001";
const model = { id: modelId, providerId: MARK_IMAGE_PROVIDER_ID, providerName: "Mark", name: "internal upstream label", modelId: "gpt-image-2.5-flare", capabilities: ["generate", "edit", "batch"], creditCost: 4, rmbCost: .2, enabled: true };
const snapshot = { title: "针织白底", prompt: "保留针织开衫结构，改白底。", targetTool: "image-generation", modelConfigId: modelId, parameters: { quality: "max", resolution: "4k", size: "21:9", quantity: 2, imageOptions: '{"resolution":"4k"}' }, category: "服装", tags: ["针织", "白底"], notes: "原稿不变" };
const stores: DemoPromptTemplateStore[] = [], temporaryDirectories: string[] = [];
function open(path = ":memory:", clock?: () => number) { const store = new DemoPromptTemplateStore(path, clock); stores.push(store); return store; }
function close(store: DemoPromptTemplateStore) { stores.splice(stores.indexOf(store), 1); store.close(); }
function diskPath() { const directory = mkdtempSync(join(tmpdir(), "mark-prompt-templates-")); temporaryDirectories.push(directory); return join(directory, "nested", "demo.sqlite"); }
function context() {
  const assets = new Map<string, { id: string; ownerUserId: string; mimeType: string; bytes: Uint8Array; createdAt: string; taskId?: string; metadata?: Record<string, unknown> }>();
  const tasks = new Map<string, { id: string; ownerUserId: string; status: string; operationType: string; prompt?: string; parameters?: Record<string, unknown>; modelConfigId?: string }>();
  const value: DemoPromptContext = { models: [{ ...model }], providers: [{ id: MARK_IMAGE_PROVIDER_ID, protocol: "apimart", enabled: true, hasCredentials: true }], prices: [{ operationType: "image_generation", status: "published", credits: 2, rmbCost: .1, version: 3 }], tools: [], creditsEnabled: false, asset: id => assets.get(id), task: id => tasks.get(id), assets: () => [...assets.values()] };
  return { value, assets, tasks };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) { expect(resolve(directory).startsWith(resolve(tmpdir()) + sep)).toBe(true); rmSync(directory, { recursive: true, force: true }); }
});

describe("durable local personal prompt templates", () => {
  test("CRUD and favorite/copy persist across restart while every snapshot retains Mark UUID and image parameters", () => {
    const file = diskPath(), ctx = context(), store = open(file);
    const created = store.create(owner, snapshot, ctx.value);
    expect(created).toMatchObject({ scope: "personal", ownerUserId: owner.id, version: 1, modelConfigId: modelId, modelSnapshot: { modelId }, parameters: snapshot.parameters, favorite: false, useCount: 0 });
    expect(created.modelSnapshot).not.toHaveProperty("providerId");
    store.favorite(owner, created.id, { favorite: true });
    const changed = store.update(owner, created.id, { ...snapshot, title: "针织新版", parameters: { ...snapshot.parameters, quality: "xhigh" } }, ctx.value);
    expect(changed.version).toBe(2); expect(changed.favorite).toBe(true);
    const copied = store.copy(owner, created.id, ctx.value);
    expect(copied).toMatchObject({ title: "针织新版 副本", version: 1, favorite: false, modelConfigId: modelId });
    expect(copied.id).not.toBe(created.id);
    close(store); const reopened = open(file);
    expect(reopened.get(owner, created.id)).toEqual(changed);
    const detached = reopened.get(owner, created.id); detached.parameters.quality = "low";
    expect(reopened.get(owner, created.id).parameters.quality).toBe("xhigh");
    expect(reopened.list(owner, { favorite: "true" }).templates.map(item => item.id)).toEqual([created.id]);
    reopened.remove(owner, created.id);
    expect(() => reopened.get(owner, created.id)).toThrow("不存在或无权访问");
    expect(reopened.list(owner, {}).templates.map(item => item.id)).toEqual([copied.id]);
  });

  test("list search, categories, tags and pagination are owner-scoped; public/team do not pretend to publish", () => {
    const ctx = context(), store = open();
    const first = store.create(owner, snapshot, ctx.value);
    store.create(owner, { ...snapshot, title: "连衣裙", category: "裙装", tags: ["春夏"] }, ctx.value);
    store.create(other, { ...snapshot, title: "其他人的私有针织" }, ctx.value);
    expect(store.list(owner, {}).total).toBe(2);
    expect(store.list(owner, { query: "白底", category: "服装", tag: "针织" }).templates.map(item => item.id)).toEqual([first.id]);
    expect(store.list(owner, { page: 2, pageSize: 1 }).templates).toHaveLength(1);
    expect(store.list(owner, { scope: "public" }).total).toBe(0);
    expect(store.list(owner, { scope: "team" }).total).toBe(0);
    expect(() => store.get(other, first.id)).toThrow("不存在或无权访问");
    expect(() => store.update(other, first.id, snapshot, ctx.value)).toThrow("不存在或无权访问");
    expect(() => store.favorite(other, first.id, { favorite: true })).toThrow("不存在或无权访问");
    expect(() => store.copy(other, first.id, ctx.value)).toThrow("不存在或无权访问");
    expect(() => store.remove(other, first.id)).toThrow("不存在或无权访问");
  });

  test("the shared schema rejects invalid bodies and reference/source identity cannot be forged", () => {
    const ctx = context(), store = open();
    ctx.assets.set(assetId, { id: assetId, ownerUserId: other.id, mimeType: "image/png", bytes: new Uint8Array([1]), createdAt: new Date().toISOString() });
    ctx.tasks.set(taskId, { id: taskId, ownerUserId: other.id, status: "success", operationType: "image_generation", prompt: "private" });
    expect(() => store.create(owner, { ...snapshot, title: " " }, ctx.value)).toThrow();
    expect(() => store.create(owner, { ...snapshot, modelConfigId: "gpt-image-2.5-flare" }, ctx.value)).toThrow();
    expect(() => store.create(owner, { ...snapshot, referenceAssetIds: [assetId] }, ctx.value)).toThrow("参考图不存在或当前无权访问");
    expect(() => store.create(owner, { ...snapshot, sourceAssetId: assetId }, ctx.value)).toThrow("不存在或无权访问");
    expect(() => store.create(owner, { ...snapshot, sourceTaskId: taskId }, ctx.value)).toThrow("不存在或无权访问");
    expect(store.list(owner, {}).total).toBe(0);
  });

  test("reuse tokens are owner-bound, expire at ten minutes and survive restart without regenerating", () => {
    let now = Date.parse("2026-10-15T00:00:00Z"); const file = diskPath(), ctx = context(), store = open(file, () => now);
    const created = store.create(owner, snapshot, ctx.value);
    const resolved = store.resolve(owner, created.id, { requestId: "reuse-immutable-01", mode: "fill_and_generate" }, ctx.value);
    expect(resolved).toMatchObject({ expiresInSeconds: 600, mode: "fill_and_generate", pricing: { selectedModel: { id: modelId, modelId }, estimate: { totalCredits: 0, quantity: 2 } } });
    expect(() => store.reuse(other, resolved.reuseToken, ctx.value)).toThrow("复用链接已失效");
    close(store); const reopened = open(file, () => now);
    expect(reopened.reuse(owner, resolved.reuseToken, ctx.value)).toMatchObject({ mode: "fill_and_generate", template: { prompt: snapshot.prompt, parameters: snapshot.parameters } });
    now += 599_999; expect(reopened.reuse(owner, resolved.reuseToken, ctx.value).template.id).toBe(created.id);
    now += 1; expect(() => reopened.reuse(owner, resolved.reuseToken, ctx.value)).toThrow("复用链接已失效");
    expect(reopened.get(owner, created.id).useCount).toBe(1);
    expect(ctx.tasks.size).toBe(0);
  });

  test("requestId counts only once, retry keeps the first version, conflicting reuse is rejected", () => {
    const file = diskPath(), ctx = context(), firstStore = open(file), secondStore = open(file);
    const created = firstStore.create(owner, snapshot, ctx.value);
    const first = firstStore.resolve(owner, created.id, { requestId: "replay-request-01", mode: "fill" }, ctx.value);
    firstStore.update(owner, created.id, { ...snapshot, prompt: "新版提示词", parameters: { resolution: "1k", quality: "low" } }, ctx.value);
    const retry = secondStore.resolve(owner, created.id, { requestId: "replay-request-01", mode: "fill" }, ctx.value);
    expect(secondStore.get(owner, created.id).useCount).toBe(1);
    for (const token of [first.reuseToken, retry.reuseToken]) expect(secondStore.reuse(owner, token, ctx.value).template).toMatchObject({ version: 1, currentVersionId: created.currentVersionId, prompt: snapshot.prompt, parameters: snapshot.parameters });
    expect(() => firstStore.resolve(owner, created.id, { requestId: "replay-request-01", mode: "fill_and_generate" }, ctx.value)).toThrow("其他模板或模式");
    const second = firstStore.create(owner, snapshot, ctx.value);
    expect(() => firstStore.resolve(owner, second.id, { requestId: "replay-request-01", mode: "fill" }, ctx.value)).toThrow("其他模板或模式");
    const fresh = firstStore.resolve(owner, created.id, { requestId: "replay-request-02", mode: "fill" }, ctx.value);
    expect(firstStore.reuse(owner, fresh.reuseToken, ctx.value).template.version).toBe(2);
    expect(firstStore.get(owner, created.id).useCount).toBe(2);
  });

  test("removed references are dropped with a warning and deleting a template invalidates its links", () => {
    const ctx = context(), store = open();
    ctx.assets.set(assetId, { id: assetId, ownerUserId: owner.id, mimeType: "image/png", bytes: new Uint8Array([1]), createdAt: new Date().toISOString() });
    const created = store.create(owner, { ...snapshot, referenceAssetIds: [assetId] }, ctx.value);
    const resolved = store.resolve(owner, created.id, { requestId: "reference-removal-01" }, ctx.value);
    ctx.assets.delete(assetId);
    expect(store.reuse(owner, resolved.reuseToken, ctx.value)).toMatchObject({ template: { referenceAssetIds: [] }, warnings: ["部分参考图已删除或当前无权访问"] });
    store.remove(owner, created.id);
    expect(() => store.reuse(owner, resolved.reuseToken, ctx.value)).toThrow("不存在或无权访问");
  });

  test("from-task/from-asset preserve owned provenance and parameter snapshots, never another owner's records", () => {
    const ctx = context(), store = open();
    ctx.tasks.set(taskId, { id: taskId, ownerUserId: owner.id, status: "success", operationType: "inpaint", prompt: snapshot.prompt, parameters: { ...snapshot.parameters, tool: "angle-control" }, modelConfigId: modelId });
    ctx.assets.set(assetId, { id: assetId, ownerUserId: owner.id, mimeType: "image/png", bytes: new Uint8Array([1]), taskId, createdAt: new Date().toISOString() });
    expect(store.fromTask(owner, taskId, ctx.value)).toMatchObject({ targetTool: "angle-control", sourceTaskId: taskId, modelConfigId: modelId, referenceAssetIds: [assetId], parameters: snapshot.parameters });
    expect(store.fromAsset(owner, assetId, ctx.value)).toMatchObject({ targetTool: "angle-control", sourceAssetId: assetId, modelConfigId: modelId, referenceAssetIds: [assetId], parameters: snapshot.parameters });
    expect(() => store.fromTask(other, taskId, ctx.value)).toThrow("不存在或无权访问");
    expect(() => store.fromAsset(other, assetId, ctx.value)).toThrow("不存在或无权访问");
    ctx.tasks.get(taskId)!.status = "processing";
    expect(() => store.fromTask(owner, taskId, ctx.value)).toThrow("不存在或无权访问");
  });

  test("unavailable Mark model is not silently replaced with an older provider sharing the upstream ID", () => {
    const ctx = context(), store = open();
    const created = store.create(owner, snapshot, ctx.value);
    (ctx.value.models[0]!).enabled = false;
    ctx.value.models = [...ctx.value.models, { ...model, id: "40000000-0000-4000-8000-000000000107", providerId: "old-provider", providerName: "OpenToken" }];
    ctx.value.providers = [...ctx.value.providers, { id: "old-provider", protocol: "openai", enabled: true, hasCredentials: true }];
    const result = store.resolve(owner, created.id, { requestId: "model-unavailable-01" }, ctx.value);
    expect(result.pricing).toMatchObject({ modelChanged: true, selectedModel: null, reason: "model_unavailable" });
    expect(result.pricing.alternatives).toHaveLength(1);
    expect(result.pricing.alternatives[0]!.model.modelId).toBe("40000000-0000-4000-8000-000000000107");
  });

  test("pricing refuses missing published prices and preserves exact tool override snapshots", () => {
    const ctx = context(), store = open();
    const created = store.create(owner, snapshot, ctx.value);
    ctx.value.prices = [];
    expect(store.resolve(owner, created.id, { requestId: "no-published-price" }, ctx.value).pricing).toMatchObject({ reason: "price_unavailable", selectedModel: null, estimate: null });
    ctx.value.tools = [{ toolKey: "image", enabled: true, modelConfigId: modelId, creditCostOverride: 7, rmbCostOverride: .123456, configurationVersion: 8 }];
    const local = store.resolve(owner, created.id, { requestId: "local-price-override" }, ctx.value).pricing;
    expect(local.estimate).toMatchObject({ totalCredits: 0, totalRmb: .2469, quantity: 2, toolKey: "image", configurationVersion: 8, creditCostOverride: 0, rmbCostOverride: .123456 });
    ctx.value.creditsEnabled = true;
    expect(store.resolve(owner, created.id, { requestId: "paid-price-override" }, ctx.value).pricing.estimate).toMatchObject({ totalCredits: 14, totalRmb: .2469, creditCostOverride: 7 });
    ctx.value.moduleEnabled = () => false;
    expect(store.resolve(owner, created.id, { requestId: "disabled-tool-price" }, ctx.value).pricing).toMatchObject({ reason: "tool_unavailable", selectedModel: null, estimate: null });
  });

  test("route handler checks auth/owner, uses actual persistence, and refuses team publication", async () => {
    const store = open(), ctx = context();
    const request = (suffix = "", method = "GET", body?: unknown, headers: Record<string, string> = {}) => new Request(`http://localhost/api/prompt-templates${suffix}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: { "content-type": "application/json", ...headers } });
    expect((await handleDemoPromptTemplates(request(), store, null, ctx.value))!.status).toBe(401);
    expect((await handleDemoPromptTemplates(request("", "GET", undefined, { "x-canvas-owner-id": other.id }), store, owner, ctx.value))!.status).toBe(409);
    const created = await handleDemoPromptTemplates(request("", "POST", snapshot), store, owner, ctx.value);
    expect(created!.status).toBe(201); const payload = await created!.json() as { template: { id: string } };
    const listed = await handleDemoPromptTemplates(request("?scope=personal"), store, owner, ctx.value);
    expect(await listed!.json()).toMatchObject({ total: 1 });
    const forbidden = await handleDemoPromptTemplates(request(`/${payload.template.id}/submit`, "POST", { requestId: "never-publish-01" }), store, owner, ctx.value);
    expect(forbidden!.status).toBe(405);
    const invalid = await handleDemoPromptTemplates(new Request("http://localhost/api/prompt-templates", { method: "POST", body: "bad-json" }), store, owner, ctx.value);
    expect(invalid!.status).toBe(400);
    expect(await handleDemoPromptTemplates(new Request("http://localhost/api/other"), store, owner, ctx.value)).toBeNull();
  });
});
