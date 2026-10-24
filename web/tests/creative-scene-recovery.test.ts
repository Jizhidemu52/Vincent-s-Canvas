import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import ts from "typescript";
import { defaultConfig } from "../src/stores/use-config-store";
import { createSceneForm } from "../src/pages/creative/scene-form-model";
import { canQuerySceneResult, readSceneRequest, sceneRootRequestId, sceneTaskRequestId } from "../src/pages/creative/scene-recovery";
import { QueuedTaskSubmissionUncertainError, type QueuedTask } from "../src/services/api/generation-tasks";
import type { PublicPromptCompilation } from "../src/services/api/prompt-compilations";
import type { SceneLog } from "../src/pages/creative/use-scene-workspace";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const config = { ...defaultConfig, model: "gpt-image-2", imageModel: "gpt-image-2", count: "1", size: "1024x1024", quality: "auto" };
const form = { ...createSceneForm("text-to-style"), description: "红色童装连衣裙" };
const compilation: PublicPromptCompilation = { id: "12345678-1234-4123-8123-123456789abc", requestId: "original-request:0", status: "success", prompt: "Final red dress prompt", optimized: true };
const pendingLog: SceneLog = { id: "pending-log", ownerId: "owner", sceneId: "text-to-style", createdAt: 1, prompt: form.description,
    userInput: { scene: "text-to-style", userText: form.description, fields: { description: form.description }, mode: "generate" }, form, referenceImages: {}, submittedReferences: [], config,
    results: [{ id: "result", status: "pending", requestId: "original-request:0" }], images: [], durationMs: 0, successCount: 0, failCount: 0, operation: "ai", inputArchiveVersion: 1 };

function harness(saved = new Map<string, unknown>(), initialLog?: SceneLog) {
    const path = new URL("../src/pages/creative/use-scene-workspace.ts", import.meta.url), requireModule = createRequire(path);
    const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
    const states: any[] = [], refs: any[] = [], effects: any[] = [], pendingEffects: Array<() => void> = [];
    const calls: string[] = [], submissions: any[] = [];
    let stateIndex = 0, refIndex = 0, effectIndex = 0, ownerId = "owner";
    let originalTask: QueuedTask | null = null, originalCompilation: PublicPromptCompilation | null = compilation;
    let queryTask: (() => Promise<QueuedTask | null>) | undefined;
    let submit = async (options: any) => {
        await options.onSubmissionStarted?.(); calls.push("POST"); submissions.push(options);
        await options.onCompiled?.("Final server prompt", true); await options.onSubmitted?.(["accepted-task"]);
        return [{ id: "generated", dataUrl: "/result.png", sourceTaskId: "accepted-task", prompt: "Final server prompt", optimized: true, userInput: options.promptInput }];
    };
    if (!saved.has("draft:owner:text-to-style")) saved.set("draft:owner:text-to-style", structuredClone({ form, images: {}, config }));
    if (initialLog) saved.set("history:owner:text-to-style", [structuredClone(initialLog)]);
    const getTask = async () => { calls.push("GET task"); return queryTask ? queryTask() : originalTask; };
    const userState = () => ({ user: { id: ownerId, status: "active", creditBalance: 100 } });
    const userStore = Object.assign((select: Function) => select(userState()), { getState: userState });
    const dependencies: Record<string, any> = {
        react: { ...React, useState: (initial: any) => { const index = stateIndex++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial; return [states[index], (next: any) => { states[index] = typeof next === "function" ? next(states[index]) : next; }]; },
            useRef: (initial: any) => refs[refIndex++] ||= { current: initial }, useMemo: (factory: Function) => factory(),
            useEffect: (effect: Function, deps?: any[]) => { const index = effectIndex++, prior = effects[index]; if (prior && deps?.every((value, i) => Object.is(value, prior.deps?.[i]))) return; pendingEffects.push(() => { prior?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; }); },
        },
        "@/lib/workspace-storage": { createWorkspaceStorage: () => ({ getItem: async (key: string) => structuredClone(saved.get(key) ?? null), setItem: async (key: string, value: unknown) => { saved.set(key, structuredClone(value)); } }) },
        "@/lib/submission-gate": { workbenchSubmissions: { acquire: () => () => {} } },
        "@/stores/use-config-store": { ...requireModule("@/stores/use-config-store"), useEffectiveConfig: () => config },
        "@/stores/use-user-store": { useUserStore: userStore },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select({ status: "ready", models: [{ id: config.model, modelId: config.model, capabilities: ["generate", "edit"] }], estimate: () => ({ credits: 0, configured: true }) }) },
        "@/stores/use-module-store": { useModuleEnabled: () => true },
        "@/hooks/use-tool-config": { useToolConfig: (value: unknown) => value, useToolEnabled: () => true },
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: false } },
        "@/lib/image-model-settings": { ...requireModule("@/lib/image-model-settings"), useImageModelProfile: () => requireModule("@/lib/image-model-settings").imageModelProfile(config.model) },
        "@/services/image-storage": { resolveImageUrl: async (key: string, fallback: string) => fallback || key, uploadImage: async (url: string) => ({ url, storageKey: "result-storage", width: 100, height: 100, bytes: 20, mimeType: "image/png" }) },
        "@/services/generation-local-inputs": { freezeLocalInput: async (image: any) => ({ ...image, inputSha256: "sha" }), restoreLocalInput: async (image: any) => ({ ...image }) },
        "@/services/api/image": { requestGeneration: (_config: unknown, _prompt: string, options: any) => submit(options), requestEdit: (_config: unknown, _prompt: string, _references: unknown, _mask: unknown, options: any) => submit(options) },
        "./scene-recovery": { ...requireModule("./scene-recovery"), readSceneRequest: (log: SceneLog, result: any, owner: string) => readSceneRequest(log, result, owner, { getQueuedTask: getTask, getQueuedTaskByRequestId: getTask, getPromptCompilation: async () => { calls.push("GET compilation"); return originalCompilation; } }) },
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name] || requireModule(name), module, module.exports);
    const render = () => { stateIndex = refIndex = effectIndex = 0; const value = module.exports.useSceneWorkspace("text-to-style"); pendingEffects.splice(0).forEach(effect => effect()); return value; };
    return { render, saved, calls, submissions, initialize: async () => { render(); await tick(); render(); await tick(); return render(); },
        setTask: (task: QueuedTask | null) => { originalTask = task; }, setCompilation: (value: PublicPromptCompilation | null) => { originalCompilation = value; },
        setTaskQuery: (query: () => Promise<QueuedTask | null>) => { queryTask = query; }, setSubmit: (fn: typeof submit) => { submit = fn; }, changeOwner: () => { ownerId = "other"; }, unmount: () => effects.forEach(effect => effect?.cleanup?.()) };
}

test("original IDs normalize only once and foreign scene records cannot be queried", async () => {
    expect(sceneTaskRequestId(pendingLog.results[0]!)).toBe("original-request:0");
    expect(sceneRootRequestId(pendingLog.results[0]!)).toBe("original-request");
    expect(canQuerySceneResult(pendingLog.results[0]!)).toBe(true);
    await expect(readSceneRequest(pendingLog, pendingLog.results[0]!, "other")).rejects.toThrow("当前账号");
});

test("creative submission persists the original request before POST and refresh does not resubmit it", async () => {
    const app = harness(); await app.initialize();
    let finish!: () => void;
    const entered = Promise.withResolvers<void>();
    app.setSubmit(async options => {
        await options.onSubmissionStarted(); app.calls.push("POST"); app.submissions.push(options);
        const records = [...app.saved.entries()].filter(([key]) => key.startsWith("history-record:"));
        expect(records).toHaveLength(1);
        const record = records[0]![1] as SceneLog;
        expect(record.results[0]?.requestId).toBe(`${options.requestId}:0`);
        expect(record.userInput?.scene).toBe("text-to-style"); expect(record.submittedReferences).toEqual([]);
        entered.resolve(); await new Promise<void>(resolve => { finish = resolve; });
        throw new QueuedTaskSubmissionUncertainError(`${options.requestId}:0`);
    });
    const running = app.render().generate(); await entered.promise;
    app.unmount();
    const refreshed = harness(app.saved); const recovered = await refreshed.initialize();
    expect(recovered.recoveredRequestId).toBeTruthy(); expect(recovered.results[0].requestId).toBe(`${app.submissions[0].requestId}:0`);
    expect(refreshed.calls).toEqual([]);
    await recovered.generate(); expect(refreshed.submissions).toHaveLength(0);
    expect(refreshed.render().error).toContain("相同输入已有未结束");
    refreshed.render().setForm({ ...recovered.form, description: "改为蓝色童装连衣裙" });
    await refreshed.render().generate();
    expect(refreshed.submissions).toHaveLength(1); expect(refreshed.submissions[0].requestId).not.toBe(app.submissions[0].requestId);
    finish(); await running; refreshed.unmount();
});

test("compiled-but-not-created recovery is GET-only until explicit same-ID continuation", async () => {
    const app = harness(new Map(), pendingLog); const initial = await app.initialize();
    await initial.queryResult(initial.results[0]);
    const ready = app.render();
    expect(app.calls).toEqual(["GET task", "GET compilation"]); expect(app.submissions).toHaveLength(0);
    expect(ready.results[0].compilationId).toBe(compilation.id);
    await ready.queryResult(ready.results[0], true);
    expect(app.submissions).toHaveLength(1);
    expect(app.submissions[0].requestId).toBe("original-request");
    expect(app.submissions[0].promptInput.compilationId).toBe(compilation.id);
    expect(app.render().results[0].status).toBe("success");
    expect(app.render().historyTotal).toBe(1); app.unmount();
});

test("a late original task is adopted before continuation, without another POST", async () => {
    const app = harness(new Map(), pendingLog); let ws = await app.initialize();
    await ws.queryResult(ws.results[0]); ws = app.render();
    app.setTask({ id: "late-task", requestId: "original-request:0", userId: "owner", status: "success", resultUrls: ["/original.png"], failureReason: null, prompt: compilation.prompt, optimized: true });
    await ws.queryResult(ws.results[0], true);
    expect(app.submissions).toHaveLength(0); expect(app.render().results[0].image.sourceTaskId).toBe("late-task"); app.unmount();
});

test("unknown compilation and cross-employee late query never start a paid task", async () => {
    const app = harness(new Map(), pendingLog); let ws = await app.initialize();
    app.setCompilation({ ...compilation, status: "uncertain", prompt: undefined });
    await ws.queryResult(ws.results[0], true);
    expect(app.submissions).toHaveLength(0); expect(app.render().results[0].failureKind).toBe("uncertain");
    let finish!: (task: QueuedTask | null) => void;
    app.setTaskQuery(() => new Promise(resolve => { finish = resolve; })); ws = app.render();
    const query = ws.queryResult(ws.results[0]); await tick(); app.changeOwner(); finish(null); await query;
    expect(app.submissions).toHaveLength(0); expect(app.render().results[0].status).not.toBe("success"); app.unmount();
});
