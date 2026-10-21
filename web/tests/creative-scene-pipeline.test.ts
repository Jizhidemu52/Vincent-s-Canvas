import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { createSubmissionGate } from "../src/lib/submission-gate";
import { buildCreativeSceneGenerationPrompt } from "../src/lib/creative-scene-plan";
import { defaultConfig, type AiConfig } from "../src/stores/use-config-store";
import { buildScenePrompt, createSceneForm, type SceneForm } from "../src/pages/creative/scene-form-model";
import type { SceneImage, SceneImages, SceneLog, SceneSelection, useSceneWorkspace } from "../src/pages/creative/use-scene-workspace";
import type { CreativeScenePlan, CreativeScenePlanInput } from "../src/services/api/creative-scene-plan";
import type { ImageSubmissionModel } from "../src/services/api/generation-tasks";
import type { ReferenceImage } from "../src/types/image";

const hookPath = new URL("../src/pages/creative/use-scene-workspace.ts", import.meta.url);
const requireModule = createRequire(hookPath);
const hookCode = ts.transpileModule(readFileSync(hookPath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
}).outputText;
const settings = requireModule("@/lib/image-model-settings") as typeof import("../src/lib/image-model-settings");
const imagePolicy = requireModule("@/lib/image-reference-policy") as typeof import("../src/lib/image-reference-policy");
const queued = requireModule("@/services/api/generation-tasks") as typeof import("../src/services/api/generation-tasks");
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
type Workspace = ReturnType<typeof useSceneWorkspace>;
type PlanOptions = { requestId: string; signal: AbortSignal; onPhase: (text: string) => void };
type PlannerCall = { config: AiConfig; input: CreativeScenePlanInput; options: PlanOptions };
type ImageOptions = { requestId: string; onSubmissionStarted?: () => Promise<void>; onSubmitted?: (ids: string[], model?: ImageSubmissionModel) => Promise<void> };
const clone = <T>(value: T): T => structuredClone(value);
const picture = (id: string): SceneImage => ({ id, name: `${id}.png`, type: "image/png", mimeType: "image/png", storageKey: `image:${id}`, dataUrl: `blob:${id}`, inputSha256: `${id}-sha256`, width: 1024, height: 1024, bytes: 10 });
const imageModel = { id: "image-config", modelId: "gpt-image-2", name: "后台出图模型", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 };
const plannerModel = { id: "planner-config", modelId: "managed-planner", name: "后台规划模型", capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 };
const actualPlannerModel = { ...plannerModel, id: "actual-planner-config", modelId: "actual-managed-planner", name: "真正执行的规划模型" };
const actualImageModel: ImageSubmissionModel = { modelConfigId: "actual-image-config", modelName: "真正执行的出图模型" };
const config: AiConfig = { ...defaultConfig, model: imageModel.id, imageModel: imageModel.id, textModel: plannerModel.id, size: "1024x1024", quality: "auto", count: "1", systemPrompt: "图像专用系统约束仍应传给图像模型" };
const formFor = (sceneId: string): SceneForm => ({ ...createSceneForm(sceneId), description: "奶油白毛衫，保留插肩结构与蓝色菱形提花", change: "仅将领口改为雾蓝V领", preserve: "保留衣身、袖型与提花" });
const planFor = (call: PlannerCall): CreativeScenePlan => {
    const content = { summary: "理解毛衫结构后调整指定部位", prompt: "这是真实规划接口边界返回的最终方案。", observations: ["蓝色菱形提花与插肩袖"], preserve: ["保持原有衣身与袖型"], warnings: ["预览不能证明实际针数"] };
    return { ...content, prompt: buildCreativeSceneGenerationPrompt(call.input, content), modelId: actualPlannerModel.id, modelName: actualPlannerModel.name, requestId: "actual-llm-request-id" };
};
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
    return { promise, resolve, reject };
}

/** Loads the production hook with per-instance boundaries; no global module or store mocking. */
function harness(options: {
    sceneId?: string;
    ownerId?: string;
    images?: SceneImages;
    selection?: SceneSelection;
    history?: SceneLog[];
    database?: Map<string, unknown>;
    planner?: (call: PlannerCall) => Promise<CreativeScenePlan>;
    fanoutCount?: number;
    plannerEnabled?: boolean;
} = {}) {
    let sceneId = options.sceneId || "text-to-style";
    let user = { id: options.ownerId || "owner-a", status: "active", creditBalance: 100, role: "designer" };
    const database = options.database || new Map<string, unknown>();
    const currentConfig = { ...config };
    const initialScope = `${user.id}:${sceneId}`;
    if (!database.has(`draft:${initialScope}`)) database.set(`draft:${initialScope}`, {
        form: formFor(sceneId), images: options.images || {}, config: currentConfig, selection: options.selection || null,
    });
    if (options.history) database.set(`history:${initialScope}`, clone(options.history));
    const states: unknown[] = [], refs: Array<{ current: unknown }> = [];
    const memos: Array<{ deps?: readonly unknown[]; value: unknown }> = [];
    const effects: Array<{ deps?: readonly unknown[]; cleanup?: (() => void) | void }> = [];
    const pendingEffects: Array<() => void> = [];
    let stateIndex = 0, refIndex = 0, memoIndex = 0, effectIndex = 0, sequence = 0;
    let mounted = true, lateStateWrites = 0;
    const events: string[] = [];
    const plannerCalls: PlannerCall[] = [];
    const imageCalls: Array<{ kind: "generate" | "edit"; config: AiConfig; prompt: string; references: ReferenceImage[]; requestId: string }> = [];
    const writes: Array<{ key: string; value: unknown }> = [];
    const restoredTasks: string[] = [], queriedTasks: string[] = [], recoveredTasks: string[] = [];
    const frozenInputs: string[] = [], compositions: Array<[string, string, string]> = [];
    const useState = (initial: unknown) => {
        const index = stateIndex++;
        if (!(index in states)) states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
        return [states[index], (value: unknown) => {
            if (!mounted) lateStateWrites += 1;
            states[index] = typeof value === "function" ? (value as (prior: unknown) => unknown)(states[index]) : value;
        }];
    };
    const sameDeps = (left?: readonly unknown[], right?: readonly unknown[]) => Boolean(left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index])));
    const state = () => ({ user });
    const useUserStore = Object.assign((selector: (value: ReturnType<typeof state>) => unknown) => selector(state()), { getState: state });
    const profile = settings.imageModelProfile(imageModel.modelId, [imageModel], "designer");
    const submitImage = async (kind: "generate" | "edit", imageConfig: AiConfig, prompt: string, references: ReferenceImage[], request: ImageOptions) => {
        const index = imageCalls.length + 1;
        events.push(`image:${kind}:${index}`);
        imageCalls.push({ kind, config: clone(imageConfig), prompt, references: clone(references), requestId: request.requestId });
        await request.onSubmissionStarted?.();
        await request.onSubmitted?.([`image-task-${index}`], actualImageModel);
        return [{ id: `result-${index}`, name: `result-${index}.png`, type: "image/png", dataUrl: `data:image/png;base64,${btoa(`result-${index}`)}`, sourceTaskId: `image-task-${index}` }];
    };
    const dependencies: Record<string, unknown> = {
        react: {
            useState,
            useRef: (initial: unknown) => refs[refIndex++] ||= { current: initial },
            useMemo(factory: () => unknown, deps?: readonly unknown[]) {
                const index = memoIndex++, prior = memos[index];
                if (prior && sameDeps(deps, prior.deps)) return prior.value;
                const value = factory(); memos[index] = { deps, value }; return value;
            },
            useEffect(effect: () => (() => void) | void, deps?: readonly unknown[]) {
                const index = effectIndex++, prior = effects[index];
                if (prior && sameDeps(deps, prior.deps)) return;
                pendingEffects.push(() => { prior?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; });
            },
        },
        nanoid: { nanoid: () => `local-id-${++sequence}` },
        "@/lib/client-id": { createClientId: () => `request-id-${++sequence}` },
        "@/lib/submission-gate": { workbenchSubmissions: createSubmissionGate() },
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: false } },
        "@/lib/workspace-storage": { createWorkspaceStorage: () => {
            const owner = user.id;
            const assertOwner = () => { if (owner !== user.id) throw new Error("fixture owner changed"); };
            return {
                isCurrent: () => owner === user.id,
                async getItem(key: string) { assertOwner(); return clone(database.get(key) ?? null); },
                async setItem(key: string, value: unknown) {
                    assertOwner(); const saved = clone(value); database.set(key, saved); writes.push({ key, value: saved });
                    if (key.startsWith("history:")) events.push(`persist:${(saved as SceneLog[])[0]?.planning?.status}`);
                    return value;
                },
            };
        } },
        "@/stores/use-user-store": { useUserStore },
        "@/stores/use-config-store": { ...requireModule("@/stores/use-config-store"), useEffectiveConfig: () => currentConfig },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (selector: (value: unknown) => unknown) => selector({ status: "ready", models: [imageModel, plannerModel, actualPlannerModel], refresh: async () => undefined, estimate: () => ({ credits: 0, configured: true }) }) },
        "@/hooks/use-tool-config": { useToolEnabled: (key: string) => key !== "creative-planner" || options.plannerEnabled !== false,
            useToolConfig: (value: AiConfig, key: string) => ({ ...value, model: key === "creative-planner" ? plannerModel.id : imageModel.id }) },
        "@/stores/use-module-store": { useModuleEnabled: () => true },
        "@/lib/image-model-settings": { ...settings, useImageModelProfile: () => profile,
            normalizeImageModelSettings: (value: Parameters<typeof settings.normalizeImageModelSettings>[0], selectedProfile: typeof profile) => {
                const normalized = settings.normalizeImageModelSettings(value, selectedProfile);
                // Product policy currently fixes count=1. Only the fanout test injects a
                // multi-result setting to exercise the existing batch continuation.
                return options.fanoutCount ? { ...normalized, count: String(options.fanoutCount) } : normalized;
            } },
        "@/lib/image-reference-policy": { ...imagePolicy, validateImageReferences: (model: string, references: ReferenceImage[]) => imagePolicy.validateImageReferences(model, references, profile) },
        "@/services/api/creative-scene-plan": { requestCreativeScenePlan: async (plannerConfig: AiConfig, input: CreativeScenePlanInput, plannerOptions: PlanOptions) => {
            const call = { config: clone(plannerConfig), input: clone(input), options: plannerOptions };
            plannerCalls.push(call); events.push("llm:start"); plannerOptions.onPhase("LLM 正在理解毛衫参考");
            const plan = options.planner ? await options.planner(call) : planFor(call);
            events.push("llm:complete"); return plan;
        } },
        "@/services/api/image": {
            requestGeneration: (imageConfig: AiConfig, prompt: string, request: ImageOptions) => submitImage("generate", imageConfig, prompt, [], request),
            requestEdit: (imageConfig: AiConfig, prompt: string, references: ReferenceImage[], _unused: unknown, request: ImageOptions) => submitImage("edit", imageConfig, prompt, references, request),
        },
        "@/services/image-storage": {
            resolveImageUrl: async (key?: string, fallback?: string) => key ? `blob:${key}` : fallback || "",
            uploadImage: async () => ({ url: `blob:saved-${++sequence}`, storageKey: `image:saved-${sequence}`, width: 1024, height: 1024, bytes: 10, mimeType: "image/png" }),
        },
        "@/services/generation-local-inputs": {
            freezeLocalInput: async (image: SceneImage) => { frozenInputs.push(image.id); return { ...image, inputSha256: `${image.id}-frozen-sha256` }; },
            restoreLocalInput: async (image: SceneImage) => ({ ...image, dataUrl: `blob:${image.storageKey}` }),
        },
        "./image-processing-browser": {
            createSelectionGuide: async () => new Blob(["fixture guide"], { type: "image/png" }),
            compositeSelectedImage: async (...values: [string, string, string]) => { compositions.push(values); return new Blob(["fixture composite"], { type: "image/png" }); },
        },
        "@/services/api/generation-history": { restoreGenerationDraft: async (taskId: string) => { restoredTasks.push(taskId); return { config: currentConfig }; } },
        "@/services/api/generation-tasks": { ...queued,
            getQueuedTask: async (id: string) => { queriedTasks.push(id); return { id, requestId: `request-${id}`, status: "success", resultUrls: ["blob:original-task-result"], failureReason: null, ownerUserId: user.id }; },
            getQueuedTaskByRequestId: async () => { throw new Error("unexpected request-ID lookup"); },
            recoverQueuedMedia: async (id: string) => { recoveredTasks.push(id); return ["blob:recovered"]; },
        },
    };
    const module = { exports: {} as { useSceneWorkspace: typeof useSceneWorkspace } };
    new Function("require", "module", "exports", hookCode)((name: string) => dependencies[name] || requireModule(name), module, module.exports);
    const render = (nextScene = sceneId): Workspace => {
        sceneId = nextScene;
        stateIndex = refIndex = memoIndex = effectIndex = 0;
        const output = module.exports.useSceneWorkspace(sceneId);
        pendingEffects.splice(0).forEach(effect => effect());
        return output;
    };
    const ready = async (nextScene = sceneId) => {
        render(nextScene); await tick(); render(); await tick(); return render();
    };
    return {
        render, ready, database, events, plannerCalls, imageCalls, writes, restoredTasks, queriedTasks, recoveredTasks, frozenInputs, compositions,
        get lateStateWrites() { return lateStateWrites; },
        history: (scope = initialScope) => clone(database.get(`history:${scope}`) || []) as SceneLog[],
        setOwner: (id: string) => { user = { ...user, id }; },
        unmount: () => { effects.forEach(effect => effect.cleanup?.()); mounted = false; },
    };
}

describe("creative scene LLM to image pipeline", () => {
    test.each([["one image", undefined], ["three-image continuation", 3]] as const)("waits for one LLM result before %s and persists both model identities", async (_label, fanoutCount) => {
        const pending = deferred<CreativeScenePlan>();
        const app = harness({ fanoutCount, planner: () => pending.promise });
        try {
            const workspace = await app.ready();
            expect(workspace.validation).toBeNull();
            expect(workspace.count).toBe(fanoutCount || 1);
            const generate = workspace.generate();
            await tick();
            expect(app.plannerCalls).toHaveLength(1);
            expect(app.imageCalls).toHaveLength(0);
            expect(app.history()[0]!.planning).toMatchObject({ status: "pending", modelId: plannerModel.id });
            expect(app.history()[0]!.results.every(result => !result.requestId && !result.taskId)).toBe(true);
            expect(app.render().phase).toBe("LLM 正在理解毛衫参考");
            const plan = planFor(app.plannerCalls[0]!);
            pending.resolve(plan);
            await generate;
            const final = app.render();
            expect(app.plannerCalls).toHaveLength(1);
            expect(app.imageCalls).toHaveLength(fanoutCount || 1);
            const completeIndex = app.events.indexOf("llm:complete");
            expect(app.events.filter(event => event.startsWith("image:")).every(event => app.events.indexOf(event) > completeIndex)).toBe(true);
            expect(app.imageCalls.every(call => call.prompt === plan.prompt && call.config.count === "1" && call.config.systemPrompt === config.systemPrompt)).toBe(true);
            expect(new Set(app.imageCalls.map(call => call.requestId)).size).toBe(fanoutCount || 1);
            expect(app.imageCalls.every(call => call.requestId !== app.plannerCalls[0]!.options.requestId && call.requestId !== plan.requestId)).toBe(true);
            expect(final.logs).toHaveLength(1);
            expect(final.activeLog).toMatchObject({ prompt: plan.prompt, config: { imageModel: imageModel.id }, planning: { status: "success", modelId: actualPlannerModel.id, modelName: actualPlannerModel.name, requestId: plan.requestId, plan }, successCount: fanoutCount || 1, failCount: 0 });
            expect(app.history()[0]!.planning?.plan).toEqual(plan);
            expect(app.history()[0]!.prompt).toBe(plan.prompt);
            expect(app.history()[0]!.results.every(result => result.modelConfigId === actualImageModel.modelConfigId && result.modelName === actualImageModel.modelName)).toBe(true);
            expect(final.activeImageModelName).toBe(actualImageModel.modelName);
            expect(final.running).toBe(false);
            expect(final.phase).toBe("");
        } finally { app.unmount(); }
    });

    test("planning failure is archived without any image submission or recoverable image identity", async () => {
        const app = harness({ planner: async () => { throw new Error("LLM 规划 JSON 无效"); } });
        try {
            await app.ready();
            await app.render().generate();
            const workspace = app.render();
            expect(app.plannerCalls).toHaveLength(1);
            expect(app.imageCalls).toHaveLength(0);
            expect(workspace.error).toContain("设计分析未完成，未提交出图");
            expect(app.history()).toHaveLength(1);
            expect(app.history()[0]!.planning).toMatchObject({ status: "failed", error: "LLM 规划 JSON 无效", requestId: app.plannerCalls[0]!.options.requestId });
            expect(workspace.results[0]).toMatchObject({ status: "failed", recoveryAllowed: false });
            expect(workspace.results[0]!.taskId).toBeUndefined();
            expect(workspace.results[0]!.requestId).toBeUndefined();
            await workspace.recoverResult(workspace.results[0]!.id);
            expect(app.plannerCalls).toHaveLength(1);
            expect(app.imageCalls).toHaveLength(0);
            expect(app.queriedTasks).toEqual([]);
            expect(workspace.running).toBe(false);
        } finally { app.unmount(); }
    });

    test("a second click during pending analysis cannot create a second billed planning request", async () => {
        const pending = deferred<CreativeScenePlan>();
        const app = harness({ planner: () => pending.promise });
        try {
            const workspace = await app.ready();
            const first = workspace.generate();
            await workspace.generate();
            await tick();
            expect(app.plannerCalls).toHaveLength(1);
            expect(app.imageCalls).toHaveLength(0);
            pending.resolve(planFor(app.plannerCalls[0]!));
            await first;
            expect(app.imageCalls).toHaveLength(1);
        } finally { app.unmount(); }
    });

    test("fixed input roles and the last selection guide reach both planner and image edit unchanged", async () => {
        const primary = picture("knitwear"), mask = picture("selection-mask");
        const app = harness({ sceneId: "local-restyle", images: { primary }, selection: { sourceId: primary.id, mask } });
        try {
            await app.ready();
            await app.render().generate();
            const call = app.plannerCalls[0]!;
            expect(app.plannerCalls).toHaveLength(1);
            expect(app.imageCalls).toHaveLength(1);
            expect(app.imageCalls[0]!.kind).toBe("edit");
            expect(app.frozenInputs).toEqual([primary.id, mask.id]);
            expect(call.input.references.map(image => image.slotId)).toEqual(["primary", "selection-guide"]);
            expect(call.input.references[0]!.id).toBe(primary.id);
            expect(call.input.references[1]!.role).toContain("最后一张蓝色选区示意");
            expect(call.input.selection).toContain("最后一张图片");
            expect(call.input.brief).toContain(buildScenePrompt("local-restyle", formFor("local-restyle")));
            expect(app.imageCalls[0]!.references.map(image => image.id)).toEqual(call.input.references.map(image => image.id));
            expect(app.imageCalls[0]!.prompt).toBe(app.history()[0]!.planning!.plan!.prompt);
            expect(app.compositions).toHaveLength(1);
            expect(app.history()[0]!.selection?.sourceId).toBe(primary.id);
        } finally { app.unmount(); }
    });

    test.each(["scene", "owner", "unmount"] as const)("a late successful LLM response after %s change cannot submit an image", async change => {
        const pending = deferred<CreativeScenePlan>();
        const app = harness({ planner: () => pending.promise });
        let unmounted = false;
        try {
            await app.ready();
            const generation = app.render().generate();
            await tick();
            expect(app.plannerCalls).toHaveLength(1);
            const call = app.plannerCalls[0]!;
            if (change === "scene") await app.ready("pattern-create");
            else if (change === "owner") { app.setOwner("owner-b"); await app.ready(); }
            else { app.unmount(); unmounted = true; }
            expect(call.options.signal.aborted).toBe(true);
            const writesBeforeLateResult = app.writes.length;
            pending.resolve(planFor(call)); // Deliberately ignores abort to test the hook's epoch guard.
            await generation;
            expect(app.imageCalls).toHaveLength(0);
            expect(app.plannerCalls).toHaveLength(1);
            // Same-owner cleanup can archive the stopped analysis in its original
            // record; it must never populate the new scope or create an image ID.
            const lateHistory = app.writes.slice(writesBeforeLateResult).filter(write => write.key.startsWith("history:"));
            if (change === "owner") expect(lateHistory).toEqual([]);
            else for (const write of lateHistory) {
                expect(write.key).toBe("history:owner-a:text-to-style");
                expect((write.value as SceneLog[]).every(log => !log.successCount && log.results.every(result => result.status === "failed" && !result.requestId && !result.taskId && result.recoveryAllowed === false))).toBe(true);
            }
            if (unmounted) expect(app.lateStateWrites).toBe(0);
            else { expect(app.render().results).toEqual([]); expect(app.render().activeLog).toBeNull(); }
        } finally { if (!unmounted) app.unmount(); }
    });

    test("a refreshed workspace can preview and restore the saved plan without rerunning the LLM", async () => {
        const app = harness();
        await app.ready(); await app.render().generate();
        const original = app.history()[0]!;
        app.unmount();
        const refreshed = harness({ database: app.database });
        try {
            await refreshed.ready();
            expect(refreshed.render().logs[0]!.planning?.plan).toEqual(original.planning?.plan);
            await refreshed.render().previewLog(refreshed.render().logs[0]!);
            expect(refreshed.render().selectedPrompt).toBe(original.prompt);
            await refreshed.render().restoreLog(refreshed.render().logs[0]!);
            expect(refreshed.restoredTasks).toEqual([original.results[0]!.taskId!]);
            expect(refreshed.render().activeLog?.planning?.plan).toEqual(original.planning?.plan);
            expect(refreshed.render().selectedPrompt).toBe(original.prompt);
            expect(refreshed.plannerCalls).toHaveLength(0);
            expect(refreshed.imageCalls).toHaveLength(0);
        } finally { refreshed.unmount(); }
    });

    test("recovering an existing image task preserves the recorded LLM plan and never starts another plan or image task", async () => {
        const request: PlannerCall = { config, input: { sceneId: "text-to-style", sceneTitle: "以文生款", brief: buildScenePrompt("text-to-style", formFor("text-to-style")), references: [] }, options: { requestId: "original-planner-id", signal: new AbortController().signal, onPhase() {} } };
        const plan = planFor(request);
        const original: SceneLog = { id: "existing-log", ownerId: "owner-a", sceneId: "text-to-style", createdAt: 1, inputArchiveVersion: 1, prompt: plan.prompt, form: formFor("text-to-style"), referenceImages: {}, config,
            planning: { status: "success", modelId: plan.modelId, modelName: plan.modelName, requestId: plan.requestId, plan },
            results: [{ id: "existing-result", status: "failed", taskId: "existing-image-task", requestId: "original-image-request", ...actualImageModel, recoveryAllowed: true, error: "下载中断" }], images: [], successCount: 0, failCount: 1, durationMs: 10 };
        const app = harness({ history: [original] });
        try {
            await app.ready();
            await app.render().previewLog(app.render().logs[0]!);
            await app.render().recoverResult("existing-result");
            expect(app.queriedTasks).toEqual(["existing-image-task"]);
            expect(app.recoveredTasks).toEqual([]);
            expect(app.history()).toHaveLength(1);
            expect(app.history()[0]).toMatchObject({ id: original.id, prompt: plan.prompt, planning: original.planning, successCount: 1, failCount: 0 });
            expect(app.history()[0]!.results[0]).toMatchObject({ ...actualImageModel, requestId: "original-image-request" });
            expect(app.plannerCalls).toHaveLength(0);
            expect(app.imageCalls).toHaveLength(0);
        } finally { app.unmount(); }
    });
});
