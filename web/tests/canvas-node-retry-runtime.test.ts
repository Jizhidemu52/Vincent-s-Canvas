import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import { defaultConfig } from "@/stores/use-config-store";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { shouldCancelCanvasGeneration } from "@/lib/canvas/canvas-project-async-lifecycle";
import { canvasCompareSource } from "@/lib/canvas/canvas-image-compare-source";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import type { retryCanvasNode } from "@/pages/canvas/canvas-node-retry-runtime";

const transpile = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;
const runtimeCode = transpile(readFileSync(new URL("../src/pages/canvas/canvas-node-retry-runtime.ts", import.meta.url), "utf8"));
const pageSource = readFileSync(new URL("../src/pages/canvas/use-canvas-generation.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("project.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "";
function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "handleRetryNode") callback = `const ${node.getText(ast)};`;
    ts.forEachChild(node, visit);
}
visit(ast);
if (!callback) throw new Error("Missing retry callback");
const callbackCode = transpile(`${callback}\nreturn handleRetryNode;`);
const image = { url: "blob:retried", storageKey: "image:retried", width: 800, height: 400, bytes: 10, mimeType: "image/png" };
function node(type = CanvasNodeType.Image, metadata: CanvasNodeMetadata = {}): CanvasNodeData {
    return { id: "result", type, title: "Result", position: { x: 12, y: 34 }, width: 200, height: 200, metadata: { prompt: "原提示词", ...metadata } };
}

// All I/O is an explicit local dependency; unexpected calls fail immediately.
function harness(target = node(), options: { recover?: () => Promise<unknown>; resolve?: (key: string) => Promise<string>; generate?: (...args: unknown[]) => Promise<unknown> } = {}) {
    let current = true;
    const calls: Array<{ kind: string; args: unknown[] }> = [];
    const feedback: string[] = [];
    const running: Array<string | null> = [];
    const nodesRef = { current: [target] };
    const connectionsRef = { current: [] as Array<{ id: string; fromNodeId: string; toNodeId: string }> };
    const record = (kind: string, ...args: unknown[]) => calls.push({ kind, args });
    const metadata = { content: image.url, storageKey: image.storageKey, naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType, status: "success" };
    const generate = async (...args: unknown[]) => { record("image", ...args); return options.generate ? options.generate(...args) : { metadata, uploaded: image }; };
    const unexpected = () => { throw new Error("Unexpected external generation request"); };
    const dependencies: Record<string, unknown> = {
        "@/constant/canvas": { NODE_DEFAULT_SIZE },
        "@/types/canvas": { CanvasNodeType },
        "@/hooks/use-tool-config": { currentToolConfig: (value: unknown) => value, canvasToolKey: () => "canvas-image" },
        "@/components/canvas/canvas-node-generation": {
            buildNodeGenerationContext: (id: string) => { record("context", id); return { prompt: "上下文提示词", referenceImages: [], referenceVideos: [], referenceAudios: [] }; },
            hydrateNodeGenerationContext: async (value: unknown) => value,
            buildNodeResponseMessages: (value: unknown) => value,
        },
        "@/lib/canvas/canvas-node-size": { fitNodeSize },
        "@/lib/canvas/canvas-image-compare-source": { canvasCompareSource },
        "@/lib/canvas/canvas-project-async-lifecycle": { shouldCancelCanvasGeneration },
        "@/lib/image-model-settings": { imageModelProfile: (model: string) => ({ kind: model === "blend" ? "midjourney-blend" : "standard" }) },
        "@/services/api/image": { requestImageQuestion: unexpected },
        "@/services/api/audio": { requestAudioGeneration: unexpected, storeGeneratedAudio: unexpected },
        "@/services/api/video": {
            requestVideoGeneration: unexpected,
            recoverVideoGenerationTask: async (...args: unknown[]) => { record("recover-video", ...args); return image; },
            storeGeneratedVideo: async (value: unknown) => value,
        },
        "@/services/image-storage": { resolveImageUrl: async (key: string) => options.resolve ? options.resolve(key) : `blob:${key}` },
        "./canvas-media-generation-runtime": {
            confirmCanvasTextRetry: (...args: unknown[]) => record("confirm-text", ...args),
            retryCanvasMediaNode: async (...args: unknown[]) => record("recover-media", ...args),
        },
    };
    const module = { exports: {} as { retryCanvasNode: typeof retryCanvasNode } };
    new Function("require", "module", "exports", runtimeCode)((name: string) => {
        if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency ${name}`);
        return dependencies[name];
    }, module, module.exports);
    const context = {
        projectId: "project-a", nodesRef, connectionsRef, effectiveConfig: defaultConfig,
        setNodes: (update: CanvasNodeData[] | ((previous: CanvasNodeData[]) => CanvasNodeData[])) => { nodesRef.current = typeof update === "function" ? update(nodesRef.current) : update; },
        createOptions: async (...args: unknown[]) => { record("options", ...args); return { generate }; },
        recoverPending: async (id: string) => { record("recover-image", id); return options.recover ? options.recover() : null; },
        setRunningNodeId: (value: string | null) => running.push(value),
        startGenerationRequest: (...args: unknown[]) => { record("start", ...args); return new AbortController(); },
        finishGenerationRequest: (...args: unknown[]) => record("finish", ...args),
        generationDispatchLocksRef: { current: new Set<string>() },
        textStreamBufferRef: { current: { clear: () => undefined, push: unexpected } },
        handleGenerateNode: async (...args: unknown[]) => record("shared-generation", ...args),
        handleMissingModelConfig: () => record("missing-model"), isAiConfigReady: () => true,
        message: Object.fromEntries(["info", "warning", "error", "success"].map(key => [key, (value: string) => feedback.push(value)])),
        modal: {}, flushSave: () => record("flush"), isCurrent: () => current,
        buildGenerationConfig: () => defaultConfig,
        buildImageGenerationMetadata: () => ({ generationType: "generation", count: 1 }),
        buildAudioGenerationMetadata: () => ({}), videoMetadata: () => metadata, audioMetadata: () => metadata,
        videoTaskErrorMetadata: () => ({}), isGenerationCanceled: (error: unknown) => error instanceof Error && error.name === "AbortError",
    };
    return { context, module: module.exports, target, calls, feedback, running, nodesRef, connectionsRef,
        invalidate: () => { current = false; }, run: () => module.exports.retryCanvasNode(target, context as unknown as Parameters<typeof retryCanvasNode>[1]) };
}

describe("lazy node retry runtime", () => {
    test("an existing image task is observed without fresh generation", async () => {
        const h = harness(node(), { recover: async () => [{ status: "failed" }] });
        await h.run();
        expect(h.calls.map(call => call.kind)).toEqual(["recover-image"]);
        expect(h.nodesRef.current).toEqual([h.target]);
    });

    test("saved image edit preserves model, prompt, one output and ordered original references", async () => {
        const h = harness(node(CanvasNodeType.Image, { generationType: "edit", model: "saved-model", size: "3:2", quality: "high", references: ["image:first", "https://local.test/second.png"] }));
        await h.run();
        const args = h.calls.find(call => call.kind === "image")!.args;
        expect(args[0]).toMatchObject({ model: "saved-model", size: "3:2", quality: "high", count: "1" });
        expect(args[1]).toBe("原提示词");
        expect(args[2]).toMatchObject([{ dataUrl: "blob:image:first", storageKey: "image:first" }, { dataUrl: "https://local.test/second.png" }]);
        expect(args[4]).toBe(true);
        expect(h.nodesRef.current[0]).toMatchObject({ id: "result", position: { x: 12, y: 34 }, metadata: { content: image.url, storageKey: image.storageKey, naturalWidth: 800, naturalHeight: 400, bytes: 10, mimeType: "image/png", status: "success", generationType: "edit", count: 1 } });
        expect(h.running).toEqual(["result", null]);
    });

    test("missing saved references blocks submission and preserves the source image", async () => {
        const h = harness(node(CanvasNodeType.Image, { generationType: "edit", references: ["image:missing"], content: "blob:source" }), { resolve: async () => "" });
        await h.run();
        expect(h.calls.map(call => call.kind)).toEqual(["recover-image"]);
        expect(h.feedback).toEqual(["参考图片已丢失，无法继续重试"]);
        expect(h.nodesRef.current[0]!.metadata).toMatchObject({ content: "blob:source", status: "error" });
    });

    test("Blend retry retains its prompt-free generation path", async () => {
        const h = harness(node(CanvasNodeType.Image, { generationType: "edit", model: "blend", references: ["image:first", "image:second"] }));
        await h.run();
        const args = h.calls.find(call => call.kind === "image")!.args;
        expect(args[1]).toBe("");
        expect(args[2]).toHaveLength(2);
        expect(args[4]).toBe(false);
    });

    test("uncertain text and media tasks keep their existing confirmation/recovery routes", async () => {
        const text = harness(node(CanvasNodeType.Text, { generationSubmissionUncertain: true }));
        await text.run();
        expect(text.calls.map(call => call.kind)).toEqual(["confirm-text"]);
        const video = harness(node(CanvasNodeType.Video, { mediaTask: { ownerId: "owner-a", projectId: "project-a", requestId: "original" } }));
        await video.run();
        expect(video.calls.map(call => call.kind)).toEqual(["recover-media"]);
    });

    test("legacy video recovery queries its original task and does not submit", async () => {
        const h = harness(node(CanvasNodeType.Video, { videoTaskId: "original-video", status: "error" }));
        await h.run();
        expect(h.calls.map(call => call.kind)).toEqual(["start", "recover-video", "finish"]);
        expect(h.calls[1]!.args[0]).toMatchObject({ id: "original-video", provider: "server" });
        expect(h.nodesRef.current[0]!.metadata).toMatchObject({ content: image.url, status: "success" });
    });

    test("a shared-config origin keeps the original source and current config prompt", async () => {
        const h = harness(node(CanvasNodeType.Text, { generationOrigin: { configNodeId: "config", sourceNodeId: "input", runId: "run", mode: "text" } }));
        h.nodesRef.current.push({ ...node(CanvasNodeType.Config, { composerContent: "当前公共配置" }), id: "config" }, { ...node(CanvasNodeType.Text), id: "input" });
        await h.run();
        expect(h.calls).toEqual([{ kind: "shared-generation", args: ["input", "text", "当前公共配置"] }]);
    });

    test("leaving during reference resolution cannot submit a new request", async () => {
        const entered = Promise.withResolvers<void>(), resolve = Promise.withResolvers<string>();
        const h = harness(node(CanvasNodeType.Image, { generationType: "edit", references: ["image:first"] }), { resolve: async () => { entered.resolve(); return resolve.promise; } });
        const pending = h.run();
        await entered.promise;
        h.invalidate(); resolve.resolve("blob:first");
        await pending;
        expect(h.calls.map(call => call.kind)).toEqual(["recover-image"]);
        expect(h.running).toEqual([]);
    });

    test("leaving during an image response cannot write the result into a departed canvas", async () => {
        const entered = Promise.withResolvers<void>(), response = Promise.withResolvers<unknown>();
        const h = harness(node(CanvasNodeType.Image, { generationType: "generation", content: "blob:original" }), { generate: async () => { entered.resolve(); return response.promise; } });
        const pending = h.run();
        await entered.promise;
        const before = structuredClone(h.nodesRef.current);
        h.invalidate(); response.resolve({ metadata: { content: image.url, status: "success" }, uploaded: image });
        await pending;
        expect(h.nodesRef.current).toEqual(before);
        expect(h.running).toEqual(["result"]);
    });
});

function entry() {
    const h = harness();
    let owner: string | undefined = "owner-a", loads = 0;
    const module = Promise.withResolvers<{ retryCanvasNode: typeof retryCanvasNode }>();
    const invoked: unknown[] = [];
    const scope = {
        ...h.context, retryScope: { active: true }, designProjectIdRef: { current: "project-a" }, projectSaveQueueRef: { current: null },
        useUserStore: { getState: () => ({ user: owner ? { id: owner } : null }) }, useCallback: (fn: unknown) => fn,
        require: (name: string) => { if (name !== "./canvas-node-retry-runtime") throw new Error(name); loads++; return module.promise; },
    };
    const retry = new Function("scope", `const { ${Object.keys(scope).join(", ")} } = scope;\n${callbackCode}`)(scope) as (node: CanvasNodeData) => Promise<void>;
    return { h, scope, retry, invoked, get loads() { return loads; }, setOwner: (id?: string) => { owner = id; },
        resolve: () => module.resolve({ retryCanvasNode: async (...args) => { invoked.push(args); } }), reject: module.reject };
}

describe("actual canvas retry entry", () => {
    test("loads only on click and dispatches the original node after loading", async () => {
        const e = entry();
        expect(e.loads).toBe(0);
        const pending = e.retry(e.h.target);
        expect(e.invoked).toEqual([]);
        e.resolve(); await pending;
        expect(e.loads).toBe(1);
        expect(e.invoked).toHaveLength(1);
        expect((e.invoked[0] as unknown[])[0]).toBe(e.h.target);
    });

    test.each(["account", "logout", "project", "project-return", "unmount", "deleted", "changed"])("%s during loading never dispatches the stale retry", async changed => {
        const e = entry(), pending = e.retry(e.h.target);
        if (changed === "account" || changed === "logout") e.setOwner(changed === "account" ? "owner-b" : undefined);
        if (changed === "project") e.scope.designProjectIdRef.current = "project-b";
        if (changed === "project-return" || changed === "unmount") e.scope.retryScope.active = false;
        if (changed === "deleted") e.h.nodesRef.current = [];
        if (changed === "changed") e.h.nodesRef.current = [structuredClone(e.h.target)];
        e.resolve(); await pending;
        expect(e.invoked).toEqual([]);
        expect(e.h.calls).toEqual([]);
        expect(e.h.feedback).toEqual([]);
    });

    test("load failure is visible without changing the graph or submitting", async () => {
        const e = entry(), pending = e.retry(e.h.target);
        e.reject(new Error("离线加载失败")); await pending;
        expect(e.h.feedback).toEqual(["离线加载失败"]);
        expect(e.invoked).toEqual([]);
        expect(e.h.nodesRef.current).toEqual([e.h.target]);
    });
});
