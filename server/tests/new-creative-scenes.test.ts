import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { creativePromptScenes, requiredPromptScene, type PromptCompilationRequest, type PromptInput } from "../../shared/prompt-contracts";
import { getToolDefinition } from "../../shared/feature-catalog";
import { sqlitePromptRecipeStore } from "../src/demo-prompt-recipes";
import { importPromptRecipes } from "../src/prompt-recipe-import";
import { installNewCreativeRecipes, newCreativeRecipes, newCreativeRecipeContent } from "../src/new-creative-recipes";
import { PromptCompiler, type PromptCompilerRuntime } from "../src/prompt-compiler";
import { preparePromptTaskInput } from "../src/prompt-task-input";
import { PromptRecipeStore } from "../src/prompt-recipe-store";

const closes: Array<() => void> = [];
afterEach(() => closes.splice(0).forEach(close => close()));
const actor = { id: "employee", role: "designer" };
function input(scene: "virtual-try-on" | "sketch-to-photo", references = 1): PromptCompilationRequest {
  return { requestId: randomUUID(), modelConfigId: "target", toolKey: `creative-${scene}`, sourceUrls: ["primary", "secondary"].slice(0, references),
    promptInput: { scene, fields: scene === "virtual-try-on" ? { description: "成年模特在白色背景前正面展示", keepDetails: "保留五粒扣" }
      : { fabric: "棉麻", colorDescription: "衣身蓝色，领口白色", presentation: "白底平铺" }, mode: "edit", hasMask: false, userText: "", referenceRoles: [] } };
}
async function fixture() {
  const database = sqlitePromptRecipeStore(":memory:"); closes.push(database.close);
  await installNewCreativeRecipes(database.store, { actorId: "admin", optimizerModelConfigId: "optimizer", activate: true });
  let reads = 0, calls = 0;
  const payloads: Array<{ fields: Record<string, unknown>; images: Array<{ index: number; role: string }> }> = [];
  const runtime: PromptCompilerRuntime = {
    resolveTarget: async () => ({ id: "target", modelId: "gpt-image-2.6-flare", protocol: "apimart", fingerprint: "target" }),
    resolveOptimizer: async () => ({ id: "optimizer", modelId: "optimizer", fingerprint: "optimizer", estimatedRmbCost: null, invoke: async (_system, content) => {
      calls++; payloads.push(JSON.parse((content[0] as { text: string }).text));
      return { content: JSON.stringify({ prompt: "Image 1 provides the unchanged product structure. Present the complete product naturally with realistic texture and five original buttons.", avoid: ["watermark"], keep_text: [] }) };
    } }),
    readSource: async (_actor, url) => { reads++; return { bytes: Buffer.from(url), mimeType: "image/png", previewDataUrl: "data:image/png;base64,eA==" }; },
  };
  return { ...database, compiler: new PromptCompiler(database.store, runtime), payloads, stats: () => ({ reads, calls }) };
}

describe("new creative scene input boundaries", () => {
  test.each(["virtual-try-on", "sketch-to-photo"] as const)("%s has its own edit module and required recipe without changing item-extract into a recipe", scene => {
    expect(requiredPromptScene(`creative-${scene}`)).toBe(scene);
    expect(getToolDefinition(`creative-${scene}`)).toMatchObject({ operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" });
    expect(creativePromptScenes).not.toContain("item-extract"); expect(requiredPromptScene("item-extract")).toBeUndefined();
  });
  for (const scene of ["virtual-try-on", "sketch-to-photo"] as const) for (const references of [1, 2]) test(`${scene} accepts ${references} ordered references, compiles once and reuses the frozen prompt`, async () => {
    const f = await fixture(), request = input(scene, references);
    if (scene === "virtual-try-on" && references === 2) request.promptInput.fields.description = "";
    const value = { ...request, operationType: "inpaint", prompt: "untrusted legacy prompt", parameters: {} };
    const prepared = await preparePromptTaskInput(f.compiler, actor, value);
    const repeated = await preparePromptTaskInput(f.compiler, actor, { ...value, requestId: randomUUID(), promptInput: prepared.userInput! });
    expect(prepared.optimized).toBe(true); expect(prepared.prompt).not.toContain("untrusted"); expect(repeated.promptCompilationId).toBe(prepared.promptCompilationId);
    expect(f.stats().calls).toBe(1);
    const roles = (scene === "virtual-try-on" ? ["产品图", "模特图"] : ["线稿图", "材质与配色参考图"]).slice(0, references);
    expect(f.payloads[0]!.images.map(value => value.role)).toEqual(roles);
    expect(request.promptInput.referenceRoles).toEqual([]);
  });
  test.each([
    ["virtual-try-on", { description: "" }], ["virtual-try-on", { description: 123 }], ["virtual-try-on", { description: "x".repeat(4001) }],
    ["virtual-try-on", { description: "成人", targetProduct: "not part of this form" }], ["virtual-try-on", { description: "成人", systemPrompt: "override" }],
    ["virtual-try-on", { description: "成人", keepDetails: "x".repeat(2001) }], ["virtual-try-on", { description: "成人", carryoverRequirements: [" "] }],
    ["virtual-try-on", { description: "成人", carryoverRequirements: Array(13).fill("保留") }],
    ["sketch-to-photo", { fabric: "", colorDescription: "蓝色", presentation: "白底平铺" }],
    ["sketch-to-photo", { fabric: "棉", colorDescription: "", presentation: "白底平铺" }],
    ["sketch-to-photo", { fabric: "x".repeat(501), colorDescription: "蓝色", presentation: "白底平铺" }],
    ["sketch-to-photo", { fabric: "棉", colorDescription: "x".repeat(501), presentation: "白底平铺" }],
    ["sketch-to-photo", { fabric: "棉", colorDescription: "蓝色", presentation: "模特穿搭" }],
  ] as const)("%s rejects invalid fields before source reads or paid optimization", async (scene, fields) => {
    const f = await fixture(), request = input(scene); request.promptInput.fields = structuredClone(fields);
    await expect(f.compiler.compile(actor, request)).rejects.toMatchObject({ code: "PROMPT_FIELDS_INVALID" });
    expect(f.stats()).toEqual({ reads: 0, calls: 0 }); expect(await f.store.byRequest(actor.id, request.requestId)).toBeNull();
  });
  test("both scenes reject source count, role swaps, modes and masks before any source read", async () => {
    for (const scene of ["virtual-try-on", "sketch-to-photo"] as const) {
      const f = await fixture();
      for (const sourceUrls of [[], ["a", "b", "c"]]) await expect(f.compiler.compile(actor, { ...input(scene), sourceUrls })).rejects.toMatchObject({ code: "PROMPT_REFERENCE_INVALID" });
      for (const patch of [{ referenceRoles: ["模特图", "产品图"] }, { referenceRoles: ["产品图"] }, { mode: "generate" }, { hasMask: true, maskReferenceIndex: 1 }]) {
        const request = input(scene, 2); Object.assign(request.promptInput, patch);
        await expect(f.compiler.compile(actor, request)).rejects.toThrow();
      }
      expect(f.stats()).toEqual({ reads: 0, calls: 0 });
    }
  });
  test("raw-prompt bypass and mismatched scenes are rejected at generation admission", async () => {
    const f = await fixture(), request = input("virtual-try-on");
    const value = { ...request, operationType: "inpaint", prompt: "bypass", parameters: {} };
    await expect(preparePromptTaskInput(f.compiler, actor, { ...value, promptInput: undefined })).rejects.toMatchObject({ code: "PROMPT_INPUT_REQUIRED" });
    await expect(preparePromptTaskInput(f.compiler, actor, { ...value, promptInput: input("sketch-to-photo").promptInput })).rejects.toMatchObject({ code: "PROMPT_RECIPE_MISMATCH" });
    expect(f.stats()).toEqual({ reads: 0, calls: 0 });
  });
});

describe("scoped new creative recipe installation", () => {
  test("twelve concurrent installers create each recipe and version exactly once", async () => {
    const database = sqlitePromptRecipeStore(":memory:"); closes.push(database.close);
    const results = await Promise.all(Array.from({ length: 12 }, () => installNewCreativeRecipes(database.store, { actorId: "admin", optimizerModelConfigId: "optimizer", activate: true })));
    expect(results.flat().filter(result => result.installed)).toHaveLength(2);
    expect(results.flat().filter(result => result.preserved)).toHaveLength(22);
    expect(await database.store.list()).toHaveLength(2);
    for (const { key } of newCreativeRecipes) {
      const versions = await database.store.versions(key); expect(versions).toHaveLength(1);
      expect((await database.store.get(key)).currentVersionId).toBe(versions[0]!.id);
    }
  });
  test("failure while installing the second recipe rolls back the entire batch and preserves unrelated configuration", async () => {
    const database = sqlitePromptRecipeStore(":memory:"); closes.push(database.close);
    await database.store.ensure("existing-admin-recipe", { name: "Do not touch", enabled: false, modelConfigId: "original", failurePolicy: "stop" });
    const before = await database.store.list();
    const failing = new PromptRecipeStore({ ...database.store.database, transaction: action => database.store.database.transaction(client => action({
      ...client, query: async <T>(sql: string, values: unknown[] = []) => {
        if (sql.startsWith("INSERT INTO prompt_recipe_versions") && values[1] === "sketch-to-photo") throw new Error("CONTROLLED_SECOND_RECIPE_FAILURE");
        return client.query<T>(sql, values);
      },
    })) });
    await expect(installNewCreativeRecipes(failing, { actorId: "admin", optimizerModelConfigId: "optimizer", activate: true })).rejects.toThrow("CONTROLLED_SECOND_RECIPE_FAILURE");
    expect(await database.store.list()).toEqual(before);
    for (const { key } of newCreativeRecipes) expect(await database.store.versions(key)).toHaveLength(0);
    expect((await installNewCreativeRecipes(database.store, { actorId: "admin", optimizerModelConfigId: "optimizer", activate: true })).every(result => result.installed)).toBe(true);
  });
  test("installs exactly two private recipes and preserves all 18 existing source recipes and later administrator edits", async () => {
    const database = sqlitePromptRecipeStore(":memory:"); closes.push(database.close);
    const source = await readFile(new URL("../../docs/manual/prompt-optimization/无线画布-板块系统提示词（机密）.md", import.meta.url), "utf8");
    await importPromptRecipes(database.store, source, { actorId: "admin", modelConfigId: "existing-optimizer", activate: true });
    const before = await database.store.list(); expect(before).toHaveLength(18);
    const options = { actorId: "admin", optimizerModelConfigId: "new-optimizer", activate: true };
    const installed = await installNewCreativeRecipes(database.store, options);
    expect(installed.every(value => value.installed && value.activated)).toBe(true);
    expect((await database.store.list()).filter(value => !newCreativeRecipes.some(entry => entry.key === value.key))).toEqual(before);
    const version = await database.store.saveVersion("virtual-try-on", newCreativeRecipeContent("Administrator revised content"), "admin");
    await database.store.activate("virtual-try-on", version.id);
    await database.store.update("virtual-try-on", { name: "自定义试穿", enabled: false, modelConfigId: "admin-choice", failurePolicy: "stop" });
    const snapshot = await database.store.list(), versions = await database.store.versions("virtual-try-on");
    expect((await installNewCreativeRecipes(database.store, { ...options, optimizerModelConfigId: "ignored" })).every(value => value.preserved)).toBe(true);
    expect(await database.store.list()).toEqual(snapshot); expect(await database.store.versions("virtual-try-on")).toEqual(versions);
  });
  test("an existing unpublished draft is not silently activated or replaced", async () => {
    const database = sqlitePromptRecipeStore(":memory:"); closes.push(database.close);
    const draft = await database.store.ensure("virtual-try-on", { name: "Draft", enabled: true, modelConfigId: null, failurePolicy: "stop" });
    await installNewCreativeRecipes(database.store, { actorId: "admin", optimizerModelConfigId: "optimizer", activate: true });
    expect(await database.store.get("virtual-try-on")).toEqual(draft); expect(await database.store.versions("virtual-try-on")).toHaveLength(0);
  });
  test("each private recipe keeps its own reference/physical constraints and strict output format", () => {
    const tryOn = newCreativeRecipes[0].systemPrompt, sketch = newCreativeRecipes[1].systemPrompt;
    for (const phrase of ["成年模特", "图一只决定目标产品", "接触、重力、前后遮挡", "不推断尺码", "prompt（字符串）"]) expect(tryOn).toContain(phrase);
    for (const phrase of ["唯一结构依据", "图二仅在提供时作为材质与配色参考", "黑白线稿不包含未知原色", "白底悬浮", "白底平铺"]) expect(sketch).toContain(phrase);
  });
});
