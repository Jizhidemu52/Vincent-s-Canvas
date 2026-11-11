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
    const calls: string[] = [], submissions: any[] = [], observations: any[] = [];
    let stateIndex = 0, refIndex = 0, effectIndex = 0, ownerId = "owner";
    let taskStatus: { busy: boolean; pending: boolean; ready: boolean };
    let resolveImage = async (key: string, fallback: string) => fallback || key;
    let failReadOnce = "";
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
        "@/services/api/generation-tasks": { ...requireModule("@/services/api/generation-tasks"), recoverQueuedTask: async (id: string) => { calls.push(`RECOVER ${id}`); return { ...originalTask, status: "processing" }; } },
        "@/services/api/task-result-reconciliation": { ...requireModule("@/services/api/task-result-reconciliation"), watchTaskReconciliation: (options: any) => { observations.push(options); return new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true })); } },
        "@/components/workbench-tasks": { useWorkbenchTask: () => ({ id: "default", active: true, draftScope: (scope: string) => scope }), useWorkbenchTaskStatus(status: typeof taskStatus) { taskStatus = status; } },
        react: { ...React, useState: (initial: any) => { const index = stateIndex++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial; return [states[index], (next: any) => { states[index] = typeof next === "function" ? next(states[index]) : next; }]; },
            useRef: (initial: any) => refs[refIndex++] ||= { current: initial }, useMemo: (factory: Function) => factory(),
            useEffect: (effect: Function, deps?: any[]) => { const index = effectIndex++, prior = effects[index]; if (prior && deps?.every((value, i) => Object.is(value, prior.deps?.[i]))) return; pendingEffects.push(() => { prior?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; }); },
        },
        "@/lib/workspace-storage": { createWorkspaceStorage: () => ({ getItem: async (key: string) => { if (failReadOnce && key.startsWith(failReadOnce)) { failReadOnce = ""; throw new Error("essential-storage-read-failed"); } return structuredClone(saved.get(key) ?? null); }, setItem: async (key: string, value: unknown) => { saved.set(key, structuredClone(value)); } }) },
        "@/lib/submission-gate": { workbenchSubmissions: { acquire: () => () => {} } },
        "@/stores/use-config-store": { ...requireModule("@/stores/use-config-store"), useEffectiveConfig: () => config },
        "@/stores/use-user-store": { useUserStore: userStore },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select({ status: "ready", models: [{ id: config.model, modelId: config.model, capabilities: ["generate", "edit"] }], estimate: () => ({ credits: 0, configured: true }) }) },
        "@/stores/use-module-store": { useModuleEnabled: () => true },
        "@/hooks/use-tool-config": { useToolConfig: (value: unknown) => value, useToolEnabled: () => true },
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: false } },
        "@/lib/image-model-settings": { ...requireModule("@/lib/image-model-settings"), useImageModelProfile: () => requireModule("@/lib/image-model-settings").imageModelProfile(config.model) },
        "@/services/image-storage": { resolveImageUrl: (key: string, fallback: string) => resolveImage(key, fallback), uploadImage: async (url: string) => ({ url, storageKey: "result-storage", width: 100, height: 100, bytes: 20, mimeType: "image/png" }) },
        "@/services/generation-local-inputs": { freezeLocalInput: async (image: any) => ({ ...image, inputSha256: "sha" }), restoreLocalInput: async (image: any) => ({ ...image }) },
        "@/services/api/image": { requestGeneration: (_config: unknown, _prompt: string, options: any) => submit(options), requestEdit: (_config: unknown, _prompt: string, _references: unknown, _mask: unknown, options: any) => submit(options) },
        "./scene-recovery": { ...requireModule("./scene-recovery"), readSceneRequest: (log: SceneLog, result: any, owner: string, _deps: unknown, signal?: AbortSignal) => readSceneRequest(log, result, owner, { getQueuedTask: getTask, getQueuedTaskByRequestId: getTask, getPromptCompilation: async () => { calls.push("GET compilation"); return originalCompilation; } }, signal) },
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name] || requireModule(name), module, module.exports);
    const render = () => { stateIndex = refIndex = effectIndex = 0; const value = module.exports.useSceneWorkspace("text-to-style"); pendingEffects.splice(0).forEach(effect => effect()); return value; };
    return { render, saved, calls, submissions, status: () => taskStatus, observations, reconcile: async () => { const observer = observations.findLast(item => !item.signal.aborted); expect(observer).toBeDefined(); await observer.reconcile(); }, setReadFailure: (prefix: string) => { failReadOnce = prefix; }, setResolveImage: (resolve: typeof resolveImage) => { resolveImage = resolve; }, initialize: async () => { render(); await tick(); render(); await tick(); return render(); },
        setTask: (task: QueuedTask | null) => { originalTask = task; }, setCompilation: (value: PublicPromptCompilation | null) => { originalCompilation = value; },
        setTaskQuery: (query: () => Promise<QueuedTask | null>) => { queryTask = query; }, setSubmit: (fn: typeof submit) => { submit = fn; }, changeOwner: () => { ownerId = "other"; }, unmount: () => effects.forEach(effect => effect?.cleanup?.()) };
}

test("creative unresolved records beyond the first history page protect their tab after clear and history preview", async () => {
    const completed: SceneLog[] = Array.from({ length: 21 }, (_, index) => ({ ...structuredClone(pendingLog), id: `completed-${index}`, createdAt: index + 2,
        results: [{ id: `done-${index}`, status: "success" }], successCount: 1 }));
    const otherWorkspace: SceneLog = { ...structuredClone(pendingLog), id: "other-workspace", workspaceId: "other-task", createdAt: 30 };
    const saved = new Map<string, unknown>([["history:owner:text-to-style", [pendingLog, ...completed, otherWorkspace]]]);
    const app = harness(saved); const ws = await app.initialize();
    expect(ws.logs).toHaveLength(20);
    expect(ws.logs.some((log: SceneLog) => log.id === pendingLog.id)).toBe(false);
    expect(app.status().pending).toBe(true);
    ws.reset(); app.render();
    expect(app.status().pending).toBe(true);
    await app.render().previewLog(ws.logs.find((log: SceneLog) => log.id.startsWith("completed-"))); app.render();
    expect(app.status().pending).toBe(true);
    await app.render().previewLog(pendingLog); const pending = app.render();
    app.setTask({ id: "late-task", requestId: "original-request:0", userId: "owner", status: "success", resultUrls: ["/original.png"], failureReason: null });
    await pending.queryResult(pending.results[0]); app.render();
    // A different workspace's unresolved record must not pin this completed tab.
    expect(app.status().pending).toBe(false);
    await app.render().previewLog(otherWorkspace); app.render();
    expect(app.status().pending).toBe(false);
    expect(app.submissions).toHaveLength(0);
    app.unmount();
});

test("creative automatically reconciles a restored original request through success with GET only", async () => {
    const app = harness(new Map(), pendingLog); await app.initialize();
    app.setCompilation({ ...compilation, status: "optimizing", prompt: undefined });
    await app.reconcile();
    expect(app.render().results[0].failureKind).toBe("uncertain");
    app.setTask({ id: "late-task", requestId: "original-request:0", status: "success", userId: "owner", resultUrls: ["/original.png"], failureReason: null });
    await app.reconcile();
    expect(app.render().results[0].status).toBe("success");
    expect(app.status().pending).toBe(false);
    expect(app.submissions).toHaveLength(0);
    expect(app.calls.every(call => call.startsWith("GET"))).toBe(true);
    app.unmount();
});

test("automatic compilation recovery closes confirmed failure but never continues a successful compilation", async () => {
    const app = harness(new Map(), pendingLog); await app.initialize();
    await app.reconcile();
    expect(app.render().results[0].compilationId).toBe(compilation.id);
    expect(app.submissions).toHaveLength(0);
    app.setCompilation({ ...compilation, status: "failed", message: "提示词准备失败，未提交图片。" });
    await app.reconcile();
    expect(app.render().results[0].failureKind).toBe("local");
    expect(app.status().pending).toBe(false);
    expect(app.submissions).toHaveLength(0);
    app.unmount();
});

test("a paused accepted task is not shown as generating and only an explicit action resumes its original ID", async () => {
    const app = harness(new Map(), pendingLog); await app.initialize();
    app.setTask({ id: "paused-original", requestId: "original-request:0", status: "paused", upstreamTaskId: "existing-upstream", userId: "owner", resultUrls: [], failureReason: "轮询已暂停" });
    await app.reconcile();
    let ws = app.render();
    expect(ws.results[0]).toMatchObject({ status: "failed", failureKind: "uncertain", recovery: "resume" });
    expect(app.calls).toEqual(["GET task"]);
    await ws.queryResult(ws.results[0], true); ws = app.render();
    expect(ws.results[0]).toMatchObject({ status: "pending", taskId: "paused-original" });
    expect(ws.results[0].recovery).toBeUndefined();
    expect(app.calls).toEqual(["GET task", "GET task", "RECOVER paused-original"]);
    expect(app.submissions).toHaveLength(0);
    app.unmount();
});

test.each([
    { status: "paused", errorCode: "IMAGE_RESULT_PROCESSING_FAILED" },
    { status: "paused", lastFailure: { phase: "postprocess" } },
    { status: "paused", failureReason: "渠道原件已保存到素材库，但图片后处理未完成：decoder failed" },
    { status: "failed", errorCode: "IMAGE_RESULT_PROCESSING_FAILED" },
])("creative postprocessing failure closes observation and rejects later continuation: %j", async failure => {
    const app = harness(new Map(), pendingLog); await app.initialize();
    app.setTask({ id: "local-failure", requestId: "original-request:0", userId: "owner", resultUrls: ["/upstream-original.png"], failureReason: null, ...failure, upstreamTaskId: "existing-upstream" });
    await app.reconcile();
    const ws = app.render();
    expect(ws.results[0]).toMatchObject({ status: "failed", failureKind: "local", taskId: "local-failure", requestId: "original-request:0" });
    expect(ws.results[0].recovery).toBeUndefined();
    expect(ws.results[0].image).toBeUndefined();
    expect(ws.results[0].error).toContain("原件已保存到素材库");
    expect(app.status().pending).toBe(false);
    expect(app.observations.every(item => item.signal.aborted)).toBe(true);
    await ws.queryResult(ws.results[0], true);
    expect(app.calls).toEqual(["GET task"]);
    expect(app.submissions).toEqual([]);
    app.unmount();
});

test("a stale creative continue click rechecks postprocessing failure before any recovery POST", async () => {
    const app = harness(new Map(), pendingLog); const ws = await app.initialize();
    app.setTask({ id: "local-failure", requestId: "original-request:0", userId: "owner", status: "paused", errorCode: "IMAGE_RESULT_PROCESSING_FAILED", resultUrls: [], failureReason: null, upstreamTaskId: "existing-upstream" });
    await ws.queryResult(ws.results[0], true);
    expect(app.calls).toEqual(["GET task"]);
    expect(app.render().results[0].failureKind).toBe("local");
    expect(app.submissions).toEqual([]);
    app.unmount();
});

test("a paused task without upstream identity can never be resumed or regenerated by continuation", async () => {
    const app = harness(new Map(), pendingLog); let ws = await app.initialize();
    app.setTask({ id: "unknown-original", requestId: "original-request:0", status: "paused", upstreamTaskId: null, userId: "owner", resultUrls: [], failureReason: "提交结果待核查" });
    await app.reconcile(); ws = app.render();
    expect(ws.results[0].recovery).toBe("investigate");
    await ws.queryResult(ws.results[0], true);
    expect(app.calls.every(call => call === "GET task")).toBe(true);
    expect(app.submissions).toHaveLength(0);
    expect(app.render().results[0].status).not.toBe("pending");
    app.unmount();
});

test("stopping automatic scene observation prevents late results from changing the saved original", async () => {
    const app = harness(new Map(), pendingLog); await app.initialize();
    let finish!: (task: QueuedTask | null) => void;
    app.setTaskQuery(() => new Promise(resolve => { finish = resolve; }));
    const reading = app.reconcile(); await tick();
    app.render().stopObserving(); app.render();
    finish({ id: "late-task", requestId: "original-request:0", status: "success", userId: "owner", resultUrls: ["/original.png"], failureReason: null });
    await reading;
    expect(app.render().results[0].status).toBe("pending");
    expect(app.observations.every(item => item.signal.aborted)).toBe(true);
    expect(app.submissions).toHaveLength(0);
    app.unmount();
});

test("missing latest preview preserves draft readiness and subsequent input writes", async () => {
    const image = { id: "missing", name: "missing.png", storageKey: "missing-storage", dataUrl: "", width: 100, height: 100, bytes: 20, mimeType: "image/png", type: "image/png" };
    const latest: SceneLog = { ...structuredClone(pendingLog), results: [{ id: "result", status: "success", image }], images: [image], successCount: 1 };
    const app = harness(new Map(), latest);
    app.setResolveImage(async () => "");
    const ws = await app.initialize();
    expect(ws.error).toContain("本地文件已不可用");
    expect(app.status().ready).toBe(true);
    ws.setForm({ ...ws.form, description: "仍需保存的修改" }); app.render(); await tick();
    expect((app.saved.get("draft:owner:text-to-style") as any).form.description).toBe("仍需保存的修改");
    expect(app.saved.get("history-record:owner:text-to-style:pending-log")).toEqual(latest);
    expect(app.submissions).toHaveLength(0);
    app.unmount();
});

for (const failedRead of ["draft:", "history-index:"]) {
    test(`essential creative ${failedRead} read failure blocks submissions and preserves the unread draft`, async () => {
        const app = harness();
        const original = structuredClone(app.saved.get("draft:owner:text-to-style"));
        app.setReadFailure(failedRead);
        const ws = await app.initialize();
        expect(ws.error).toContain("essential-storage-read-failed");
        expect(app.status().ready).toBe(false);
        ws.setForm(form); const edited = app.render(); await tick();
        await edited.generate();
        expect(app.submissions).toHaveLength(0);
        expect(edited.validation).toContain("读取失败");
        expect(app.saved.get("draft:owner:text-to-style")).toEqual(original);
        app.unmount();
    });
}

test("original IDs normalize only once and foreign scene records cannot be queried", async () => {
    expect(sceneTaskRequestId(pendingLog.results[0]!)).toBe("original-request:0");
    expect(sceneRootRequestId(pendingLog.results[0]!)).toBe("original-request");
    expect(canQuerySceneResult(pendingLog.results[0]!)).toBe(true);
    await expect(readSceneRequest(pendingLog, pendingLog.results[0]!, "other")).rejects.toThrow("当前账号");
});

test("a verified task remains authoritative when the auxiliary compilation query fails", async () => {
    const task: QueuedTask = { id: "accepted", requestId: "original-request:0", status: "success", resultUrls: ["/original.png"], failureReason: null, userId: "owner" };
    const result = await readSceneRequest(pendingLog, pendingLog.results[0]!, "owner", {
        getQueuedTask: async () => task, getQueuedTaskByRequestId: async () => task,
        getPromptCompilation: async () => { throw new Error("compilation unavailable"); },
    });
    expect(result.task).toEqual(task);
    expect(result.compilation).toBeNull();
});

test("accepted task recovery never starts an auxiliary compilation request that could hang", async () => {
    let compilationReads = 0;
    const task: QueuedTask = { id: "accepted", requestId: "original-request:0", status: "success", resultUrls: ["/original.png"], failureReason: null, userId: "owner" };
    const result = await readSceneRequest(pendingLog, pendingLog.results[0]!, "owner", {
        getQueuedTask: async () => task, getQueuedTaskByRequestId: async () => task,
        getPromptCompilation: async () => { compilationReads++; return new Promise(() => {}); },
    });
    expect(result.task).toEqual(task);
    expect(compilationReads).toBe(0);
});

test("a foreign compilation cannot close or continue the original scene request", async () => {
    await expect(readSceneRequest(pendingLog, pendingLog.results[0]!, "owner", {
        getQueuedTask: async () => null, getQueuedTaskByRequestId: async () => null,
        getPromptCompilation: async () => ({ ...compilation, requestId: "another-request:0", status: "failed" }),
    })).rejects.toThrow("身份不匹配");
});

test("a previously accepted task cannot become a pre-admission failure after a missing lookup", async () => {
    const log = { ...pendingLog, results: [{ ...pendingLog.results[0]!, taskId: "accepted" }] };
    await expect(readSceneRequest(log, log.results[0]!, "owner", {
        getQueuedTask: async () => null, getQueuedTaskByRequestId: async () => null,
        getPromptCompilation: async () => ({ ...compilation, status: "failed" }),
    })).rejects.toThrow("原图片任务暂时无法读取");
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
