import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

import { observeCanvasImageTask, type CanvasImageTaskBinding } from "@/lib/canvas/canvas-image-task-recovery";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { shouldCancelCanvasGeneration, stopCanvasObservation } from "@/lib/canvas/canvas-project-async-lifecycle";
import { QueuedTaskFailedError, QueuedTaskPausedError, type QueuedTask } from "@/services/api/generation-tasks";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { imageModelProfile } from "@/lib/image-model-settings";
import { defaultConfig } from "@/stores/use-config-store";

// Execute the actual page hook with explicit React/store/I/O boundaries, without a DOM
// or global module mocks. The production task observer and sizing logic stay real.
const hookCode = ts.transpileModule(readFileSync(new URL("../src/pages/canvas/use-canvas-image-tasks.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
}).outputText;
const runtimeCode = ts.transpileModule(readFileSync(new URL("../src/pages/canvas/canvas-image-task-runtime.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
}).outputText;
type Hook = typeof import("@/pages/canvas/use-canvas-image-tasks").useCanvasImageTasks;
type HookResult = ReturnType<Hook>;
type Save = { projectId: string; nodes: CanvasNodeData[] };
type Query = { kind: "task" | "request"; id: string; signal: AbortSignal };

const binding: CanvasImageTaskBinding = { ownerId: "employee-a", projectId: "canvas-a", requestId: "original-request:0", taskId: "original-task", resultIndex: 0 };
const completedTask: QueuedTask = { id: binding.taskId!, requestId: binding.requestId, userId: binding.ownerId, operationType: "image_generation", status: "success", resultUrls: ["/api/assets/original-result/content"], failureReason: null };
const image = { url: "blob:original-result", storageKey: "image:original-result", width: 1200, height: 600, bytes: 3456, mimeType: "image/png" };

function initialNodes(taskBinding?: CanvasImageTaskBinding): CanvasNodeData[] {
    return [
        { id: "source-node", type: CanvasNodeType.Image, title: "保持原图", position: { x: 3, y: 5 }, width: 240, height: 300, metadata: { content: "blob:source", storageKey: "image:source" } },
        { id: "result-node", type: CanvasNodeType.Image, title: "当前生成", position: { x: 512, y: 99 }, width: 320, height: 240, metadata: { status: "loading", prompt: "只改花瓣", ...(taskBinding ? { imageTask: structuredClone(taskBinding) } : {}) } },
    ];
}

function harness(options: {
    binding?: CanvasImageTaskBinding;
    nodes?: CanvasNodeData[];
    isGenerating?: (nodeId: string) => boolean;
    loadRuntime?: () => Promise<void>;
    persist?: (save: Save, index: number) => Promise<void>;
    query?: (query: Query) => Promise<QueuedTask | null>;
    loadImage?: (url: string) => Promise<typeof image>;
    imageRequest?: (toolKey: string | undefined, edit: boolean) => Promise<Array<{ id: string; dataUrl: string }>>;
} = {}) {
    const nodes = { current: options.nodes ? structuredClone(options.nodes) : initialNodes(options.binding) };
    const refs: Array<{ current: unknown }> = [];
    const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [];
    const memos: Array<{ deps: unknown[]; value: unknown }> = [];
    let refIndex = 0;
    let effectIndex = 0;
    let memoIndex = 0;
    let queuedEffects: Array<() => void> = [];
    let ownerId: string | undefined = "employee-a";
    let requestCount = 0;
    let runtimeLoadAttempts = 0;
    let loadedRuntime: Record<string, unknown> | undefined;
    let loadingRuntime: Promise<Record<string, unknown>> | undefined;
    let projectId = "canvas-a";
    let pendingSave: Save | undefined;
    let value: HookResult;
    const saves: Save[] = [];
    const committed: Save[] = [];
    const queries: Query[] = [];
    const uploads: string[] = [];
    const events: string[] = [];
    const dependencies: Record<string, unknown> = {
        react: {
            useRef(initial: unknown) { return refs[refIndex++] ||= { current: initial }; },
            useCallback(callback: unknown) { return callback; },
            useMemo(create: () => unknown, deps: unknown[]) {
                const index = memoIndex++;
                const previous = memos[index];
                if (previous && previous.deps.length === deps.length && deps.every((dependency, i) => Object.is(dependency, previous.deps[i]))) return previous.value;
                const value = create();
                memos[index] = { deps, value };
                return value;
            },
            useLayoutEffect(run: () => void | (() => void), deps: unknown[]) {
                const index = effectIndex++;
                const previous = effects[index];
                if (previous && previous.deps.length === deps.length && deps.every((dependency, i) => Object.is(dependency, previous.deps[i]))) return;
                queuedEffects.push(() => {
                    previous?.cleanup?.();
                    effects[index] = { deps, cleanup: run() || undefined };
                });
            },
        },
        "react-dom": { flushSync(run: () => void) { run(); } },
        nanoid: { nanoid: () => `new-request-${++requestCount}` },
        "@/types/canvas": { CanvasNodeType },
        "@/lib/canvas/canvas-image-task-recovery": { observeCanvasImageTask },
        "@/lib/canvas/canvas-node-size": { fitNodeSize },
        "@/lib/canvas/canvas-project-async-lifecycle": { shouldCancelCanvasGeneration },
        "@/lib/image-model-settings": { imageModelProfile },
        "@/services/api/generation-tasks": {
            QueuedTaskFailedError, QueuedTaskPausedError,
            getQueuedTask: (id: string, signal: AbortSignal) => query({ kind: "task", id, signal }),
            getQueuedTaskByRequestId: (id: string, signal: AbortSignal) => query({ kind: "request", id, signal }),
        },
        "@/services/api/image": {
            requestEdit: (_config: unknown, _prompt: string, _references: unknown, _mask: unknown, requestOptions: { tool?: string }) => { if (options.imageRequest) return options.imageRequest(requestOptions.tool, true); throw new Error("Unexpected fresh image edit"); },
            requestGeneration: (_config: unknown, _prompt: string, requestOptions: { tool?: string }) => { if (options.imageRequest) return options.imageRequest(requestOptions.tool, false); throw new Error("Unexpected fresh image generation"); },
        },
        "@/services/image-storage": {
            uploadImage: async (url: string) => { uploads.push(url); return options.loadImage ? options.loadImage(url) : image; },
        },
        "@/stores/canvas/use-canvas-store": {
            useCanvasStore: { getState: () => ({ updateProject(id: string, patch: { nodes: CanvasNodeData[] }) {
                events.push("store");
                pendingSave = { projectId: id, nodes: structuredClone(patch.nodes) };
            } }) },
            flushCanvasPersistence: async () => {
                if (!pendingSave) throw new Error("Persistence must follow a project update");
                const snapshot = structuredClone(pendingSave);
                saves.push(snapshot);
                events.push("flush");
                await options.persist?.(snapshot, saves.length);
                committed.push(snapshot);
                events.push("persisted");
            },
        },
        "@/stores/use-user-store": { useUserStore: { getState: () => ({ user: ownerId ? { id: ownerId } : null }) } },
    };
    function requireDependency(name: string): unknown {
        // CommonJS transpilation turns import() into a Promise around require().
        // Gate this one boundary while still evaluating the real runtime module.
        if (name === "./canvas-image-task-runtime") {
            if (loadedRuntime) return loadedRuntime;
            return loadingRuntime ||= Promise.resolve().then(async () => {
                runtimeLoadAttempts++;
                await options.loadRuntime?.();
                const runtime = { exports: {} as Record<string, unknown> };
                new Function("require", "module", "exports", runtimeCode)(requireDependency, runtime, runtime.exports);
                loadedRuntime = runtime.exports;
                return loadedRuntime;
            }).catch(error => { loadingRuntime = undefined; throw error; });
        }
        if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`);
        return dependencies[name];
    }
    const module = { exports: {} as { useCanvasImageTasks: Hook } };
    new Function("require", "module", "exports", hookCode)(requireDependency, module, module.exports);
    async function query(call: Query) {
        queries.push(call);
        return options.query ? options.query(call) : completedTask;
    }
    const setNodes: Parameters<Hook>[0]["setNodes"] = update => { nodes.current = typeof update === "function" ? update(nodes.current) : update; };
    const saveQueue = { current: { flush: () => { events.push("editor"); } } };
    const generating = { current: { has: options.isGenerating || (() => false) } };
    function render(nextProjectId = projectId) {
        projectId = nextProjectId;
        refIndex = 0;
        effectIndex = 0;
        memoIndex = 0;
        queuedEffects = [];
        // biome-ignore lint/correctness/useHookAtTopLevel: This harness supplies its own isolated React hook dispatcher above.
        value = module.exports.useCanvasImageTasks({ projectId, nodes, setNodes, saveQueue, generating });
        for (const run of queuedEffects) run();
        return value;
    }
    render();
    return {
        nodes, saves, committed, queries, uploads, events,
        action: () => value,
        runtimeLoadAttempts: () => runtimeLoadAttempts,
        result: () => nodes.current.find(node => node.id === "result-node"),
        render,
        setOwner(id?: string) { ownerId = id; },
        removeResult() { nodes.current = nodes.current.filter(node => node.id !== "result-node"); },
        unmount() { for (const effect of effects) effect.cleanup?.(); },
    };
}

describe("lazy canvas image task runtime", () => {
    test.each([
        { tool: undefined, edit: false, expected: "canvas-image" },
        { tool: undefined, edit: true, expected: "canvas-edit" },
        { tool: "canvas-mask-edit" as const, edit: true, expected: "canvas-mask-edit" },
        { tool: "canvas-angle" as const, edit: true, expected: "canvas-angle" },
    ])("forwards $expected from the page hook through the lazy runtime", async ({ tool, edit, expected }) => {
        const requests: Array<{ toolKey?: string; edit: boolean }> = [];
        const h = harness({ imageRequest: async (toolKey, editing) => { requests.push({ toolKey, edit: editing }); return [{ id: "generated", dataUrl: "blob:generated" }]; } });
        const options = await h.action().createOptions("result-node", new AbortController(), undefined, tool);
        await options.generate(defaultConfig, "prompt", edit ? [{ id: "reference", name: "reference.png", type: "image/png", dataUrl: "blob:reference" }] : undefined);
        expect(requests).toEqual([{ toolKey: expected, edit }]);
        h.unmount();
    });

    test("rendering stays lazy and option creation loads the runtime without task I/O", async () => {
        const h = harness();
        const controller = new AbortController();
        expect(h.runtimeLoadAttempts()).toBe(0);
        const creating = h.action().createOptions("result-node", controller);
        expect(creating).toBeInstanceOf(Promise);
        const options = await creating;
        expect(options.requestId).toBe("new-request-1");
        expect(options.signal).toBe(controller.signal);
        expect(options.cancelOnAbort()).toBe(true);
        expect(() => options.assertCurrent()).not.toThrow();
        expect(h.runtimeLoadAttempts()).toBe(1);
        expect(h.saves).toEqual([]);
        expect(h.queries).toEqual([]);
        h.unmount();
    });

    test("stopping local observation never cancels the accepted task even while the node remains current", async () => {
        const h = harness();
        const controller = new AbortController();
        const options = await h.action().createOptions("result-node", controller);
        await options.onSubmissionStarted();
        await options.onSubmitted(["accepted-task"]);
        stopCanvasObservation(controller);
        expect(controller.signal.aborted).toBe(true);
        expect(options.cancelOnAbort()).toBe(false);
        expect(() => options.assertCurrent()).toThrow();
        expect(h.result()!.metadata?.imageTask?.taskId).toBe("accepted-task");
        expect(h.uploads).toEqual([]);
        expect(h.queries).toEqual([]);
        h.unmount();
    });

    test.each(["abort", "account", "project", "project-return", "delete", "unmount"])("%s during runtime loading prevents preparation under a stale identity", async reason => {
        const entered = Promise.withResolvers<void>();
        const loaded = Promise.withResolvers<void>();
        const h = harness({ loadRuntime: async () => { entered.resolve(); await loaded.promise; } });
        const controller = new AbortController();
        const preparing = h.action().createOptions("result-node", controller);
        await entered.promise;
        if (reason === "abort") controller.abort();
        if (reason === "account") h.setOwner("employee-b");
        if (reason === "project") h.render("canvas-b");
        if (reason === "project-return") { h.render("canvas-b"); h.render("canvas-a"); }
        if (reason === "delete") h.removeResult();
        if (reason === "unmount") h.unmount();
        loaded.resolve();
        await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
        expect(h.saves).toEqual([]);
        expect(h.result()?.metadata?.imageTask).toBeUndefined();
        expect(h.queries).toEqual([]);
        h.unmount();
    });

    test("a failed runtime load rejects preparation before persistence and can be loaded again", async () => {
        let failLoad = true;
        const h = harness({ loadRuntime: async () => { if (failLoad) throw new Error("runtime offline"); } });
        await expect(h.action().createOptions("result-node", new AbortController())).rejects.toThrow("runtime offline");
        expect(h.result()!.metadata?.imageTask).toBeUndefined();
        expect(h.saves).toEqual([]);
        failLoad = false;
        const options = await h.action().createOptions("result-node", new AbortController());
        await options.onSubmissionStarted();
        expect(h.runtimeLoadAttempts()).toBe(2);
        expect(h.committed[0]!.nodes[1]!.metadata?.imageTask).toMatchObject({ ownerId: "employee-a", projectId: "canvas-a", requestId: `${options.requestId}:0` });
        h.unmount();
    });

    test.each(["account", "project", "project-return", "delete", "unmount"])("%s while loading the recovery runtime makes no task query or node save", async reason => {
        const entered = Promise.withResolvers<void>();
        const loaded = Promise.withResolvers<void>();
        const h = harness({ binding, loadRuntime: async () => { entered.resolve(); await loaded.promise; } });
        const recovering = h.action().recoverPending("result-node");
        await entered.promise;
        if (reason === "account") h.setOwner("employee-b");
        if (reason === "project") h.render("canvas-b");
        if (reason === "project-return") { h.render("canvas-b"); h.render("canvas-a"); }
        if (reason === "delete") h.removeResult();
        if (reason === "unmount") h.unmount();
        loaded.resolve();
        await recovering;
        expect(h.queries).toEqual([]);
        expect(h.saves).toEqual([]);
        expect(h.uploads).toEqual([]);
        h.unmount();
    });

    test("concurrent recoveries share a runtime load and a failed load remains retryable", async () => {
        const entered = Promise.withResolvers<void>();
        const loaded = Promise.withResolvers<void>();
        let failLoad = true;
        const h = harness({ binding, loadRuntime: async () => { entered.resolve(); await loaded.promise; if (failLoad) throw new Error("runtime offline"); } });
        const first = h.action().recoverPending("result-node");
        await entered.promise;
        const second = h.action().recoverPending("result-node");
        expect(h.runtimeLoadAttempts()).toBe(1);
        expect(h.saves).toEqual([]);
        loaded.resolve();
        const failures = await Promise.all([first, second]);
        expect(h.result()!.metadata?.imageTask).toEqual(binding);
        expect(failures[0]?.[0]?.error).toContain("runtime offline");
        expect(h.queries).toEqual([]);
        failLoad = false;
        await h.action().recoverPending("result-node");
        expect(h.runtimeLoadAttempts()).toBe(2);
        expect(h.result()!.metadata?.status).toBe("success");
        h.unmount();
    });
});

describe("canvas image submission persistence", () => {
    test.each(["failed", "cancelled"])("the shared result receiver clears a confirmed %s binding and preserves the terminal error", async status => {
        const h = harness();
        const options = await h.action().createOptions("result-node", new AbortController());
        await options.onSubmissionStarted();
        const failure = new QueuedTaskFailedError({ ...completedTask, status });
        await expect(options.receiveResult(Promise.reject(failure))).rejects.toBe(failure);
        expect(h.result()!.metadata?.imageTask).toBeUndefined();
        expect(h.uploads).toEqual([]);
        h.unmount();
    });

    test("the shared result receiver keeps the original API object and stores its image once", async () => {
        const h = harness();
        const options = await h.action().createOptions("result-node", new AbortController());
        await options.onSubmissionStarted();
        const generated = { dataUrl: "/api/assets/result/content", sourceTaskId: "accepted-task", revisedPrompt: "original prompt" };
        const result = await options.receiveResult(Promise.resolve([generated]));
        expect(result.image).toBe(generated);
        expect(result.uploaded).toEqual(image);
        expect(result.metadata).toMatchObject({ sourceTaskId: "accepted-task", content: image.url, storageKey: image.storageKey, status: "success", imageTask: undefined });
        expect(h.uploads).toEqual([generated.dataUrl]);
        h.unmount();
    });

    test("the shared result receiver cannot revive after leaving and returning during image loading", async () => {
        const entered = Promise.withResolvers<void>();
        const loaded = Promise.withResolvers<typeof image>();
        const h = harness({ loadImage: async () => { entered.resolve(); return loaded.promise; } });
        const options = await h.action().createOptions("result-node", new AbortController());
        await options.onSubmissionStarted();
        const receiving = options.receiveResult(Promise.resolve([{ dataUrl: "/api/assets/result/content" }]));
        await entered.promise;
        h.render("canvas-b");
        h.render("canvas-a");
        loaded.resolve(image);
        await expect(receiving).rejects.toMatchObject({ name: "AbortError" });
        expect(options.cancelOnAbort()).toBe(false);
        h.unmount();
    });

    test("request identity resolves only after durable persistence, with the editor flushed first", async () => {
        const entered = Promise.withResolvers<void>();
        const saved = Promise.withResolvers<void>();
        const h = harness({ persist: async () => { entered.resolve(); await saved.promise; } });
        const options = await h.action().createOptions("result-node", new AbortController());
        let resolved = false;
        const preparing = options.onSubmissionStarted().then(() => { resolved = true; });
        await entered.promise;
        expect(resolved).toBe(false);
        expect(h.committed).toEqual([]);
        expect(h.events).toEqual(["editor", "store", "flush"]);
        expect(h.saves[0]!.nodes[1]!.metadata?.imageTask).toEqual({ ownerId: "employee-a", projectId: "canvas-a", requestId: `${options.requestId}:0`, resultIndex: 0 });
        saved.resolve();
        await preparing;
        expect(resolved).toBe(true);
        expect(h.committed[0]!.nodes[1]!.metadata?.status).toBe("loading");
        expect(h.queries).toEqual([]);
        h.unmount();
    });

    test("a failed first identity save clears its unsubmitted binding and permits a fresh request after storage recovers", async () => {
        let failSave = true;
        const h = harness({ persist: async () => { if (failSave) throw new Error("local persistence failed"); } });
        let submitted = false;
        const options = await h.action().createOptions("result-node", new AbortController(), () => { submitted = true; });
        await expect(options.onSubmissionStarted()).rejects.toThrow("local persistence failed");
        expect(submitted).toBe(false);
        expect(h.committed).toEqual([]);
        expect(h.result()!.metadata?.status).not.toBe("success");
        expect(h.result()!.metadata?.sourceTaskId).toBeUndefined();
        expect(h.result()!.metadata?.imageTask).toBeUndefined();
        expect(h.queries).toEqual([]);
        failSave = false;
        const retry = await h.action().createOptions("result-node", new AbortController());
        expect(retry.requestId).not.toBe(options.requestId);
        await retry.onSubmissionStarted();
        expect(h.result()!.metadata?.imageTask?.requestId).toBe(`${retry.requestId}:0`);
        expect(h.committed).toHaveLength(1);
        expect(h.committed[0]!.nodes[1]!.metadata?.imageTask?.requestId).toBe(`${retry.requestId}:0`);
        h.unmount();
    });

    test("an existing uncertain submission binding cannot be replaced by a fresh request", async () => {
        const h = harness({ binding });
        const options = await h.action().createOptions("result-node", new AbortController());
        await expect(options.onSubmissionStarted()).rejects.toThrow("已有原任务");
        expect(h.result()!.metadata?.imageTask).toEqual(binding);
        expect(h.saves).toEqual([]);
        h.unmount();
    });

    test("an explicit stop while saving a not-yet-submitted identity clears that binding after the save resolves", async () => {
        const entered = Promise.withResolvers<void>();
        const saved = Promise.withResolvers<void>();
        const h = harness({ persist: async () => { entered.resolve(); await saved.promise; } });
        const controller = new AbortController();
        const options = await h.action().createOptions("result-node", controller);
        const preparing = options.onSubmissionStarted();
        await entered.promise;
        controller.abort();
        saved.resolve();
        await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
        expect(h.result()!.metadata?.imageTask).toBeUndefined();
        expect(h.result()!.metadata?.sourceTaskId).toBeUndefined();
        expect(h.queries).toEqual([]);
        const retry = await h.action().createOptions("result-node", new AbortController());
        await retry.onSubmissionStarted();
        expect(h.result()!.metadata?.imageTask?.requestId).toBe(`${retry.requestId}:0`);
        h.unmount();
    });

    test("a failed pre-submission save keeps the previous image and its historical task association", async () => {
        const previousNodes = initialNodes();
        Object.assign(previousNodes[1]!.metadata!, { content: "blob:previous-result", storageKey: "image:previous-result", sourceTaskId: "previous-task" });
        const h = harness({ nodes: previousNodes, persist: async () => { throw new Error("storage offline"); } });
        const options = await h.action().createOptions("result-node", new AbortController());
        await expect(options.onSubmissionStarted()).rejects.toThrow("storage offline");
        expect(h.result()!.metadata?.imageTask).toBeUndefined();
        expect(h.result()!.metadata).toMatchObject({ content: "blob:previous-result", storageKey: "image:previous-result", sourceTaskId: "previous-task" });
        h.unmount();
    });

    test("accepted task ID is written immediately and the submitted callback waits for its save", async () => {
        const entered = Promise.withResolvers<void>();
        const saved = Promise.withResolvers<void>();
        const h = harness({ persist: async (_save, index) => { if (index === 2) { entered.resolve(); await saved.promise; } } });
        let submitted = false;
        const options = await h.action().createOptions("result-node", new AbortController(), () => { submitted = true; });
        await options.onSubmissionStarted();
        const accepting = options.onSubmitted(["accepted-task"]);
        await entered.promise;
        expect(h.result()!.metadata?.imageTask?.taskId).toBe("accepted-task");
        expect(h.result()!.metadata?.sourceTaskId).toBe("accepted-task");
        expect(h.saves[1]!.nodes[1]!.metadata?.imageTask?.taskId).toBe("accepted-task");
        expect(submitted).toBe(false);
        expect(h.committed).toHaveLength(1);
        saved.resolve();
        await accepting;
        expect(submitted).toBe(true);
        expect(h.committed[1]!.nodes[1]!.metadata?.imageTask?.taskId).toBe("accepted-task");
        h.unmount();
    });

    test("an explicit abort of the current request keeps cancellation enabled", async () => {
        const h = harness();
        const controller = new AbortController();
        const options = await h.action().createOptions("result-node", controller);
        await options.onSubmissionStarted();
        controller.abort();
        expect(options.cancelOnAbort()).toBe(true);
        expect(() => options.assertCurrent()).toThrow();
        h.unmount();
    });

    test.each(["unmount", "project", "project-return", "account", "delete"])("%s makes the original request observation-only when its controller aborts", async reason => {
        const h = harness();
        const controller = new AbortController();
        const options = await h.action().createOptions("result-node", controller);
        await options.onSubmissionStarted();
        if (reason === "unmount") h.unmount();
        if (reason === "project") h.render("canvas-b");
        if (reason === "project-return") { h.render("canvas-b"); controller.abort(); h.render("canvas-a"); }
        if (reason === "account") h.setOwner("employee-b");
        if (reason === "delete") h.removeResult();
        controller.abort();
        expect(options.cancelOnAbort()).toBe(false);
        expect(() => options.assertCurrent()).toThrow();
        h.unmount();
    });
});

describe("canvas original image task recovery", () => {
    test("an old child result cannot overwrite a root with its own newer image task", async () => {
        const batchNodes = initialNodes(binding);
        batchNodes[1]!.metadata!.batchRootId = "batch-root";
        batchNodes.push({ id: "batch-root", type: CanvasNodeType.Image, title: "新生成任务", position: { x: 900, y: 77 }, width: 640, height: 480,
            metadata: { isBatchRoot: true, primaryImageId: "result-node", status: "loading", imageTask: { ...binding, requestId: "new-root:0", taskId: "new-root-task" } } });
        const previousRoot = structuredClone(batchNodes[2]!);
        const h = harness({ nodes: batchNodes });
        await h.action().recoverPending("result-node");
        expect(h.result()!.metadata?.status).toBe("success");
        expect(h.nodes.current.find(node => node.id === "batch-root")).toEqual(previousRoot);
        expect(h.committed.at(-1)!.nodes.find(node => node.id === "batch-root")).toEqual(previousRoot);
        h.unmount();
    });

    test.each(["unset", "current-child", "other-child"])("recovered batch results update only the chosen or first successful cover (%s)", async primary => {
        const batchNodes = initialNodes(binding);
        batchNodes[1]!.metadata!.batchRootId = "batch-root";
        batchNodes.push({ id: "batch-root", type: CanvasNodeType.Image, title: "批量结果", position: { x: 900, y: 77 }, width: 640, height: 480,
            metadata: { isBatchRoot: true, batchChildIds: ["result-node", "other-result"], status: "loading", content: "blob:previous-cover", storageKey: "image:previous-cover",
                ...(primary === "unset" ? {} : { primaryImageId: primary === "current-child" ? "result-node" : "other-result" }) } });
        const previousRoot = structuredClone(batchNodes[2]!);
        const h = harness({ nodes: batchNodes });
        await h.action().recoverPending("result-node");
        const root = h.nodes.current.find(node => node.id === "batch-root")!;
        expect(h.result()!.metadata?.status).toBe("success");
        expect(root.position).toEqual(previousRoot.position);
        expect(root.metadata?.batchChildIds).toEqual(previousRoot.metadata?.batchChildIds);
        if (primary === "other-child") expect(root).toEqual(previousRoot);
        else expect(root).toMatchObject({ id: "batch-root", title: "批量结果", width: 640, height: 320,
            metadata: { isBatchRoot: true, primaryImageId: "result-node", content: image.url, storageKey: image.storageKey, status: "success", sourceTaskId: completedTask.id } });
        expect(h.committed.at(-1)!.nodes.find(node => node.id === "batch-root")).toEqual(root);
        h.unmount();
    });

    test.each([true, false])("restores the original result into the same node and persists a discovered ID first (known task ID: %s)", async knownId => {
        const taskBinding = { ...binding, ...(knownId ? {} : { taskId: undefined }) };
        const h = harness({ binding: taskBinding });
        const original = structuredClone(h.nodes.current);
        await h.action().recoverPending("result-node");
        expect(h.queries.map(({ kind, id }) => ({ kind, id }))).toEqual([{ kind: knownId ? "task" : "request", id: knownId ? completedTask.id : binding.requestId }]);
        expect(h.uploads).toEqual([completedTask.resultUrls[0]!]);
        expect(h.nodes.current).toHaveLength(2);
        expect(h.nodes.current[0]).toEqual(original[0]);
        expect(h.result()).toMatchObject({ id: "result-node", title: original[1]!.title, position: original[1]!.position, width: 320, height: 160,
            metadata: { sourceTaskId: completedTask.id, status: "success", content: image.url, storageKey: image.storageKey, naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType, prompt: "只改花瓣" } });
        expect(h.result()!.metadata?.imageTask).toBeUndefined();
        expect(h.committed.at(-1)!.nodes[1]).toEqual(h.result());
        if (!knownId) {
            expect(h.committed[1]!.nodes[1]!.metadata?.imageTask?.taskId).toBe(completedTask.id);
            expect(h.committed[1]!.nodes[1]!.metadata?.status).toBe("loading");
        }
        h.unmount();
    });

    test("legacy recovery preserves existing prompt provenance when the task response omits it", async () => {
        const previous = initialNodes(binding);
        const userInput = { scene: "free-optimize" as const, userText: "只改花瓣", mode: "edit" as const, compilationId: "1cd57c50-d53e-4694-adb0-dc0b862c2e08" };
        Object.assign(previous[1]!.metadata!, { optimized: true, userInput });
        const h = harness({ nodes: previous });
        await h.action().recoverPending("result-node");
        expect(h.result()!.metadata).toMatchObject({ prompt: "只改花瓣", optimized: true, userInput, optimizingPrompt: false });
        expect(h.result()!.metadata?.imageTask).toBeUndefined();
        expect(h.committed.at(-1)!.nodes[1]!.metadata).toMatchObject({ prompt: "只改花瓣", optimized: true, userInput });
        expect(h.queries).toHaveLength(1);
        expect(h.uploads).toEqual(["/api/assets/original-result/content"]);
        h.unmount();
    });

    test.each([true, false])("recovery applies authoritative server prompt provenance including optimized=%s", async optimized => {
        const previous = initialNodes(binding);
        Object.assign(previous[1]!.metadata!, { optimized: !optimized, userInput: { scene: "free-optimize", userText: "old input", mode: "edit" } });
        const userInput = { scene: "free-optimize" as const, userText: "把花瓣改为蓝色", mode: "edit" as const };
        const h = harness({ nodes: previous, query: async () => ({ ...completedTask, prompt: "Make the petals blue.", optimized, userInput }) });
        await h.action().recoverPending("result-node");
        expect(h.result()!.metadata).toMatchObject({ prompt: "Make the petals blue.", optimized, userInput, optimizingPrompt: false });
        expect(h.committed.at(-1)!.nodes[1]).toEqual(h.result());
        expect(h.queries).toHaveLength(1);
        expect(h.uploads).toEqual(["/api/assets/original-result/content"]);
        h.unmount();
    });

    test("repeated recover calls observe one task and import its result once", async () => {
        const entered = Promise.withResolvers<void>();
        const reply = Promise.withResolvers<QueuedTask>();
        const h = harness({ binding, query: async () => { entered.resolve(); return reply.promise; } });
        const first = h.action().recoverPending("result-node");
        await entered.promise;
        await h.action().recoverPending("result-node");
        expect(h.queries).toHaveLength(1);
        reply.resolve(completedTask);
        await first;
        await h.action().recoverPending("result-node");
        expect(h.queries).toHaveLength(1);
        expect(h.uploads).toHaveLength(1);
        expect(h.committed.filter(save => save.nodes[1]!.metadata?.status === "success")).toHaveLength(1);
        h.unmount();
    });

    test("a live generation prevents a second observer until its original page request has stopped", async () => {
        let generating = true;
        const h = harness({ binding, isGenerating: nodeId => nodeId === "result-node" && generating });
        await h.action().recoverPending("result-node");
        expect(h.queries).toEqual([]);
        expect(h.saves).toEqual([]);
        expect(h.uploads).toEqual([]);
        expect(h.result()!.metadata?.imageTask).toEqual(binding);
        generating = false;
        await h.action().recoverPending("result-node");
        expect(h.queries).toHaveLength(1);
        expect(h.result()!.metadata?.status).toBe("success");
        h.unmount();
    });

    test("a failed final save retains the task binding and reports an error instead of durable success", async () => {
        const h = harness({ binding, persist: async save => {
            if (save.nodes[1]!.metadata?.status === "success") throw new Error("result persistence failed");
        } });
        await h.action().recoverPending("result-node");
        expect(h.result()!.metadata?.imageTask).toEqual(binding);
        expect(h.result()!.metadata?.status).toBe("error");
        expect(h.result()!.metadata?.errorDetails).toContain("result persistence failed");
        expect(h.committed.some(save => save.nodes[1]!.metadata?.status === "success")).toBe(false);
        expect(h.committed.at(-1)!.nodes[1]!.metadata?.imageTask).toEqual(binding);
        expect(h.uploads).toEqual([completedTask.resultUrls[0]!]);
        h.unmount();
    });

    test("a failed final batch save cannot leave its newly updated cover persisted as success", async () => {
        const batchNodes = initialNodes(binding);
        batchNodes[1]!.metadata!.batchRootId = "batch-root";
        batchNodes.push({ id: "batch-root", type: CanvasNodeType.Image, title: "批量结果", position: { x: 900, y: 77 }, width: 640, height: 480,
            metadata: { isBatchRoot: true, batchChildIds: ["result-node"], status: "loading" } });
        const h = harness({ nodes: batchNodes, persist: async save => {
            if (save.nodes[1]!.metadata?.status === "success") throw new Error("batch result persistence failed");
        } });
        await h.action().recoverPending("result-node");
        expect(h.result()!.metadata?.imageTask).toEqual(binding);
        expect(h.result()!.metadata?.status).toBe("error");
        expect(h.nodes.current.find(node => node.id === "batch-root")!.metadata?.status).not.toBe("success");
        expect(h.committed.some(save => save.nodes.find(node => node.id === "batch-root")?.metadata?.status === "success")).toBe(false);
        h.unmount();
    });

    test.each(["failed", "cancelled", "paused"])("%s recovery clears only a terminal binding and never imports an image", async status => {
        const h = harness({ binding, query: async () => ({ ...completedTask, status, resultUrls: [], failureReason: "原任务状态说明" }) });
        await h.action().recoverPending("result-node");
        expect(h.result()!.metadata).toMatchObject({ status: "error", sourceTaskId: completedTask.id, errorDetails: "原任务状态说明" });
        if (status === "paused") expect(h.result()!.metadata?.imageTask).toEqual(binding);
        else expect(h.result()!.metadata?.imageTask).toBeUndefined();
        expect(h.uploads).toEqual([]);
        expect(h.committed.at(-1)!.nodes[1]).toEqual(h.result());
        h.unmount();
    });

    test.each(["delete", "account", "project", "unmount"])("%s during the task query cannot write the returned result", async reason => {
        const entered = Promise.withResolvers<void>();
        const reply = Promise.withResolvers<QueuedTask>();
        const h = harness({ binding, query: async () => { entered.resolve(); return reply.promise; } });
        const recovering = h.action().recoverPending("result-node");
        await entered.promise;
        const savesBeforeChange = h.saves.length;
        if (reason === "delete") h.removeResult();
        if (reason === "account") h.setOwner("employee-b");
        if (reason === "project") h.render("canvas-b");
        if (reason === "unmount") h.unmount();
        reply.resolve(completedTask);
        await recovering;
        expect(h.saves).toHaveLength(savesBeforeChange);
        expect(h.uploads).toEqual([]);
        if (reason === "delete") expect(h.result()).toBeUndefined();
        else expect(h.result()!.metadata?.status).not.toBe("success");
        if (reason === "project" || reason === "unmount") expect(h.queries[0]!.signal.aborted).toBe(true);
        h.unmount();
    });

    test.each(["delete", "account", "project", "unmount"])("%s during original-byte loading cannot refill a stale node", async reason => {
        const entered = Promise.withResolvers<void>();
        const loaded = Promise.withResolvers<typeof image>();
        const h = harness({ binding, loadImage: async () => { entered.resolve(); return loaded.promise; } });
        const recovering = h.action().recoverPending("result-node");
        await entered.promise;
        const savesBeforeChange = h.saves.length;
        if (reason === "delete") h.removeResult();
        if (reason === "account") h.setOwner("employee-b");
        if (reason === "project") h.render("canvas-b");
        if (reason === "unmount") h.unmount();
        loaded.resolve(image);
        await recovering;
        expect(h.saves).toHaveLength(savesBeforeChange);
        if (reason === "delete") expect(h.result()).toBeUndefined();
        else expect(h.result()!.metadata?.content).toBeUndefined();
        expect(h.committed.every(save => save.projectId === "canvas-a")).toBe(true);
        h.unmount();
    });
});
