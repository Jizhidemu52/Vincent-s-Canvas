import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/types/canvas";
import * as nodeGeneration from "@/components/canvas/canvas-node-generation";
import { observeCanvasImageTask } from "@/lib/canvas/canvas-image-task-recovery";
import { stopCanvasObservation } from "@/lib/canvas/canvas-project-async-lifecycle";
import { i18nHarness } from "./helpers/i18n-harness";

type Hook = typeof import("@/pages/canvas/use-canvas-generation").useCanvasGeneration;
const base = new URL("../src/pages/canvas/", import.meta.url);
const requireModule = createRequire(new URL("use-canvas-generation.ts", base));
const realModules = new Map(["use-canvas-generation", "use-canvas-generation-runtime", "canvas-shared-generation-runtime", "use-canvas-image-tasks", "canvas-image-task-runtime"].map(name => [name,
    ts.transpileModule(readFileSync(new URL(`${name}.ts`, base), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
]));
const config = { ...defaultConfig, model: "gpt-image-2", imageModel: "gpt-image-2", size: "1:1", quality: "low", systemPrompt: "" };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(ready: () => boolean) { for (let i = 0; i < 100 && !ready(); i++) await tick(); expect(ready()).toBe(true); }

// The real generation, shared-dispatch, task-binding and recovery implementations
// execute together. Only React/store delivery and external I/O are substituted.
function harness(options: { preparation?: "ensure" | "hydrate"; unknown?: boolean; shared?: boolean; pendingRecovery?: boolean } = {}) {
    const nodes = { current: ["a", "b"].flatMap(id => [
        { id: `source-${id}`, type: CanvasNodeType.Image, title: `source-${id}`, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: `blob:${id}`, storageKey: `image:${id}` } },
        { id, type: CanvasNodeType.Config, title: id, position: { x: 200, y: 0 }, width: 200, height: 200, metadata: { generationMode: "image", configImageInputMode: "combined", model: config.model, composerContent: `edit ${id}`, prompt: `edit ${id}` } },
    ]) as CanvasNodeData[] };
    const connections = { current: ["a", "b"].map(id => ({ id: `input-${id}`, fromNodeId: options.shared ? id : `source-${id}`, toNodeId: options.shared ? `source-${id}` : id,
        ...(options.shared ? { kind: "config-target" as const } : {}) })) as CanvasConnection[] };
    if (options.pendingRecovery) {
        nodes.current.push({ id: "old-output", type: CanvasNodeType.Image, title: "old-output", position: { x: 500, y: 0 }, width: 100, height: 100,
            metadata: { status: "loading", imageTask: { ownerId: "employee-a", projectId: "project", requestId: "original:0", resultIndex: 0, ...(options.unknown ? {} : { taskId: "original-task" }) } } });
        connections.current.push({ id: "old-edge", fromNodeId: "a", toNodeId: "old-output", kind: "generation-output" });
    }
    const setNodes = (value: any) => { nodes.current = typeof value === "function" ? value(nodes.current) : value; };
    const effects: Array<() => void | (() => void)> = [];
    const preparation = Promise.withResolvers<void>();
    const submitted: Array<{ requestId: string; taskId: string; signal: AbortSignal; canceled?: boolean; reason?: unknown }> = [];
    const queries: Array<{ kind: string; id: string }> = [];
    const persisted: CanvasNodeData[][] = [];
    const notices: string[] = [];
    let id = 0, preparationEntered = false, streamed = new Map();
    const model = { id: "fixture-model", modelId: "gpt-image-2", name: "Fixture", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 };
    const request = async (_config: unknown, _prompt: string, requestOptions: any) => {
        requestOptions.signal.throwIfAborted();
        await requestOptions.onSubmissionStarted();
        const item = { requestId: `${requestOptions.requestId}:0`, taskId: `task-${submitted.length + 1}`, signal: requestOptions.signal } as (typeof submitted)[number];
        submitted.push(item);
        if (!options.unknown) await requestOptions.onSubmitted([item.taskId]);
        // Never manually complete this gate: only the actual execution signal ends it.
        return new Promise<never>((_resolve, reject) => {
            const abort = () => { item.reason = item.signal.reason; item.canceled = requestOptions.cancelOnAbort(); reject(item.signal.reason); };
            if (item.signal.aborted) abort(); else item.signal.addEventListener("abort", abort, { once: true });
        });
    };
    const query = async (kind: string, key: string, signal: AbortSignal) => {
        queries.push({ kind, id: key });
        if (options.pendingRecovery) return new Promise<never>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        const item = submitted.find(item => kind === "task" ? item.taskId === key : item.requestId === key);
        if (!item) throw new Error("Recovery queried a different paid attempt");
        return { id: item.taskId, requestId: item.requestId, userId: "employee-a", operationType: "inpaint", status: "success", resultUrls: [`blob:${item.taskId}`], failureReason: null };
    };
    const dependencies: Record<string, any> = {
        react: { useCallback: (fn: any) => fn, useMemo: (fn: any) => fn(), useRef: (current: any) => ({ current }), useState: (value: any) => [value, () => {}], useEffect: (fn: any) => effects.push(fn), useLayoutEffect: (fn: any) => effects.push(fn) },
        "react-dom": { flushSync: (fn: any) => fn() },
        antd: { App: { useApp: () => ({ message: { info: (text: string) => notices.push(text), error: (text: string) => notices.push(text), warning: (text: string) => notices.push(text) }, modal: {} }) } },
        nanoid: { nanoid: () => `generated-${++id}` },
        "@/lib/i18n": i18nHarness,
        "@/stores/use-config-store": { ...requireModule("@/stores/use-config-store"), useEffectiveConfig: () => config },
        "@/stores/use-user-store": { useUserStore: { getState: () => ({ user: { id: "employee-a" } }) } },
        "@/stores/use-business-config-store": { useBusinessConfigStore: { getState: () => ({ models: [model], tools: [], status: "ready" }) } },
        "@/stores/use-asset-store": { useAssetStore: (select: any) => select({ addAsset() {} }) },
        "@/stores/canvas/canvas-graph-store": { useCanvasGraphSetter: (key: string) => (value: any) => {
            if (key === "nodes") setNodes(value);
            else if (key === "connections") connections.current = typeof value === "function" ? value(connections.current) : value;
            else if (key === "streamedTextById") streamed = typeof value === "function" ? value(streamed) : value;
        } },
        "@/stores/canvas/use-canvas-store": { useCanvasStore: { getState: () => ({ updateProject: (_project: string, patch: any) => persisted.push(structuredClone(patch.nodes)) }) }, flushCanvasPersistence: async () => {} },
        "@/components/canvas/canvas-node-generation": { ...nodeGeneration, hydrateNodeGenerationContext: async (context: any) => { if (options.preparation === "hydrate") { preparationEntered = true; await preparation.promise; } return context; } },
        "@/lib/canvas/canvas-generation-model": { ensureCanvasModelsReady: async () => { if (options.preparation === "ensure") { preparationEntered = true; await preparation.promise; } return {}; }, resolveCanvasImageConfig: (input: any, _business: any, refs: boolean) => ({ config: input, toolKey: refs ? "canvas-edit" : "canvas-image" }) },
        "@/lib/canvas/canvas-prompt-history": { rememberCanvasPrompt: async () => {} },
        "@/lib/canvas/canvas-image-task-recovery": { observeCanvasImageTask: (binding: any, input: any) => observeCanvasImageTask(binding, { ...input, wait: async () => {} }) },
        "@/services/api/image": { requestGeneration: request, requestEdit: (settings: any, prompt: string, _refs: any, _mask: any, input: any) => request(settings, prompt, input) },
        "@/services/api/generation-tasks": { ...requireModule("@/services/api/generation-tasks"), getQueuedTask: (key: string, signal: AbortSignal) => query("task", key, signal), getQueuedTaskByRequestId: (key: string, signal: AbortSignal) => query("request", key, signal) },
        "@/services/image-storage": { uploadImage: async (url: string) => ({ url, storageKey: `image:${url}`, width: 100, height: 100, bytes: 10, mimeType: "image/png" }) },
    };
    const cache = new Map<string, any>();
    const load = (name: string): any => {
        if (Object.hasOwn(dependencies, name)) return dependencies[name];
        const local = name.replace(/^\.\//, "");
        if (!realModules.has(local)) return requireModule(name);
        if (cache.has(local)) return cache.get(local);
        const module = { exports: {} }; cache.set(local, module.exports);
        new Function("require", "module", "exports", realModules.get(local)!)(load, module, module.exports);
        return module.exports;
    };
    const runtime = load("./use-canvas-generation-runtime").useCanvasGenerationRuntime({ projectId: "project", nodesRef: nodes, setNodes, projectSaveQueueRef: { current: null }, textStreamPublishingEnabledRef: { current: true }, editLeaseRef: { current: true, ensureWritable: async () => true } });
    const action = (load("./use-canvas-generation") as { useCanvasGeneration: Hook }).useCanvasGeneration({ projectId: "project", nodesRef: nodes, connectionsRef: connections, designProjectIdRef: { current: "project" }, projectSaveQueueRef: { current: null }, runtime,
        setDialogNodeId() {}, focusCanvasArea() {}, handleMissingModelConfig() {}, isAiConfigReady: () => true });
    const cleanups = effects.map(fn => fn());
    const pending: Promise<void>[] = [];
    const run = (node: string, controller: AbortController) => { const key = `workflow-${node}`; runtime.generationDispatchLocksRef.current.add(key); const result = action.handleGenerateNode(node, "image", `edit ${node}`, undefined, key, controller.signal); pending.push(result); return result; };
    return { run, runtime, nodes, submitted, queries, persisted, notices, preparation, preparationEntered: () => preparationEntered,
        async cleanup() { preparation.resolve(); for (const item of runtime.generationRequestsRef.current.values()) item.controller.abort(); cleanups.forEach(fn => fn?.()); await Promise.all(pending); } };
}

test.each([false, true])("sequence abort reaches the real %s shared branch, returns A and leaves B observing", async shared => {
    const h = harness({ shared }), a = new AbortController(), b = new AbortController();
    let aDone = false, bDone = false;
    try {
        h.run("a", a).then(() => { aDone = true; }); h.run("b", b).then(() => { bDone = true; });
        await tick(); await tick(); expect(h.notices).toEqual([]);
        await until(() => h.submitted.length === 2);
        a.abort();
        await until(() => aDone);
        expect(h.submitted.map(item => item.signal.aborted)).toEqual([true, false]);
        expect(h.submitted[0]!.canceled).toBe(true); expect(bDone).toBe(false);
        expect([...h.runtime.generationRequestsRef.current.values()].every((request: any) => request.originNodeId !== "a")).toBe(true);
        b.abort(); await until(() => bDone);
    } finally { await h.cleanup(); }
});

test.each([false, true])("observation stop keeps the original %s unknown attempt recoverable without a new POST", async unknown => {
    const h = harness({ unknown }), controller = new AbortController(); let done = false;
    try {
        h.run("a", controller).then(() => { done = true; }); await until(() => h.submitted.length === 1);
        stopCanvasObservation(controller); await until(() => done);
        const original = h.submitted[0]!;
        expect(original.canceled).toBe(false); expect(original.reason).toBe(controller.signal.reason);
        const output = h.nodes.current.find(node => node.metadata?.imageTask)!;
        expect(output.metadata!.imageTask!.requestId).toBe(original.requestId);
        expect(h.persisted.some(snapshot => snapshot.some(node => node.id === output.id && node.metadata?.imageTask?.requestId === original.requestId))).toBe(true);
        await h.run("a", new AbortController());
        expect(h.submitted).toHaveLength(1);
        expect(h.queries[0]).toEqual({ kind: unknown ? "request" : "task", id: unknown ? original.requestId : original.taskId });
        expect(h.nodes.current.find(node => node.id === output.id)?.metadata).toMatchObject({ status: "success", sourceTaskId: original.taskId, imageTask: undefined });
    } finally { await h.cleanup(); }
});

test.each(["ensure", "hydrate"] as const)("sequence stop during %s preparation cannot submit later", async preparation => {
    const h = harness({ preparation }), controller = new AbortController();
    try {
        const running = h.run("a", controller); await until(h.preparationEntered);
        controller.abort(); h.preparation.resolve();
        let done = false; running.then(() => { done = true; }); await until(() => done);
        expect(h.submitted).toEqual([]); expect(h.nodes.current).toHaveLength(4);
        expect(h.runtime.generationRequestsRef.current.size).toBe(0);
    } finally { await h.cleanup(); }
});

test("sequence abort listener is removed after the real request returns", async () => {
    const h = harness(), controller = new AbortController();
    const added = new Set<unknown>(), removed = new Set<unknown>();
    const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((name: string, listener: any, options: any) => { if (name === "abort") added.add(listener); add(name, listener, options); }) as typeof add;
    controller.signal.removeEventListener = ((name: string, listener: any, options: any) => { if (name === "abort") removed.add(listener); remove(name, listener, options); }) as typeof remove;
    try {
        const running = h.run("a", controller); await until(() => h.submitted.length === 1);
        controller.abort(); let done = false; running.then(() => { done = true; }); await until(() => done);
        expect(added.size).toBeGreaterThan(0); expect([...added].every(item => removed.has(item))).toBe(true);
    } finally { await h.cleanup(); }
});

test.each([false, true])("stopping an existing %s unknown recovery returns without canceling or losing its identity", async unknown => {
    const h = harness({ pendingRecovery: true, unknown }), controller = new AbortController(); let done = false;
    try {
        const original = structuredClone(h.nodes.current.find(node => node.id === "old-output")!.metadata!.imageTask);
        h.run("a", controller).then(() => { done = true; }); await until(() => h.queries.length === 1);
        controller.abort(); await until(() => done);
        expect(h.submitted).toEqual([]);
        expect(h.nodes.current.find(node => node.id === "old-output")!.metadata!.imageTask).toEqual(original);
        expect(h.queries).toEqual([{ kind: unknown ? "request" : "task", id: unknown ? "original:0" : "original-task" }]);
    } finally { await h.cleanup(); }
});
