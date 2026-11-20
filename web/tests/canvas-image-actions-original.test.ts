import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { canvasImageSource, hasCanvasImageSource } from "@/lib/canvas/canvas-image-source";
import { canvasCompareSource } from "@/lib/canvas/canvas-image-compare-source";
import { canvasImageBaseName, canvasImageVersion, originalCanvasImageFileName } from "@/lib/canvas/canvas-image-filename";
import { createCanvasImageEditVersion } from "@/lib/canvas/canvas-image-edit";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const cloud = "/api/assets/cloud-original/content";
const image = { url: "blob:result", storageKey: "image:result", width: 768, height: 1024, mimeType: "image/png", bytes: 8 };

function harness(metadata: CanvasNodeData["metadata"], options: { resolve?: () => Promise<string>; process?: () => Promise<Blob>; wait?: () => Promise<boolean>; prepare?: () => Promise<void> } = {}) {
    const node: CanvasNodeData = { id: "original", type: CanvasNodeType.Image, title: "原始设计", width: 300, height: 400, position: { x: 0, y: 0 }, metadata: { originalFileName: "original.webp", mimeType: "image/webp", ...metadata } };
    const nodesRef = { current: [node] };
    const reads: unknown[][] = [], processing: unknown[][] = [], uploads: unknown[] = [], references: any[] = [], errors: string[] = [], adaptations: unknown[][] = [], dimensions: string[] = [];
    let id = 0, active = true;
    const states: Record<string, unknown> = { connections: [], selectedNodeIds: new Set() };
    const message = { error: (error: string) => errors.push(error), warning: (error: string) => errors.push(error), success() {} };
    const process = async (kind: string, source: string, params: unknown) => { processing.push([kind, source, params]); return options.process ? options.process() : new Blob(["modified"], { type: "image/png" }); };
    const dependencies: Record<string, unknown> = {
        "@/hooks/use-display-text": { displayNotice: (value: string) => value },
        "@/lib/i18n": { uiText: (value: string) => value },
        "@/constant/canvas": { NODE_DEFAULT_SIZE: { text: { width: 200, height: 100 } } },
        "@/lib/canvas/canvas-async-pool": { mapCanvasAsyncPool: async (items: unknown[], _limit: number, task: (item: unknown) => Promise<unknown>) => Promise.all(items.map(task)) },
        "@/lib/canvas/canvas-image-source": { canvasImageSource, hasCanvasImageSource },
        "@/lib/canvas/canvas-image-compare-source": { canvasCompareSource },
        "@/lib/canvas/canvas-image-filename": { canvasImageBaseName, canvasImageVersion, originalCanvasImageFileName },
        "@/lib/canvas/canvas-image-tool-loader": { loadCanvasImageTools: async () => ({
            cropImageBlob: (source: string, params: unknown) => process("crop", source, params),
            upscaleImageBlob: (source: string, params: unknown) => process("upscale", source, params),
            splitImageBlobs: async (source: string, params: unknown) => [{ row: 0, column: 0, blob: await process("split", source, params) }],
        }) },
        "@/lib/canvas/canvas-node-size": { fitNodeSize: (width: number, height: number) => ({ width, height }), nodeSizeFromRatio: () => null },
        "@/lib/canvas/canvas-image-output-placement": { placeCanvasImageOutputs: () => ({ x: 500, y: 0 }) },
        "@/lib/canvas/canvas-mask-adaptation": { canvasMaskAdaptationPlan: (size: unknown) => size, adaptCanvasMaskInputs: async (...values: unknown[]) => { adaptations.push(values); return { sourceDataUrl: "adapted-source", maskDataUrl: "adapted-mask" }; } },
        "@/lib/canvas/canvas-generation-model": { ensureCanvasModelsReady: async () => ({}), resolveCanvasToolModel: (_tool: string, config: unknown) => config },
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: false } },
        "@/lib/image-model-settings": { imageModelProfile: () => ({}) },
        "@/services/image-storage": {
            resolveImageUrl: async (...values: unknown[]) => { reads.push(values); return options.resolve ? options.resolve() : "blob:resolved-original"; },
            uploadImage: async (value: unknown) => { uploads.push(value); return { ...image, storageKey: `image:upload-${uploads.length}` }; },
        },
        "@/stores/canvas/use-canvas-store": { flushCanvasPersistence: async () => {}, useCanvasStore: { getState: () => ({ updateProject() {} }) } },
        "@/lib/canvas/canvas-image-edit": { createCanvasImageEditVersion },
        "@/stores/use-asset-store": { useAssetStore: { getState: () => ({ addAsset() {} }) } },
        "@/stores/use-business-config-store": { useBusinessConfigStore: { getState: () => ({ estimate: () => ({ configured: true, credits: 0 }), tools: [] }) } },
        "@/stores/use-config-store": { modelOptionName: (value: string) => value },
        "@/stores/use-user-store": { useUserStore: { getState: () => ({ user: { id: "employee", status: "active" } }) } },
        "@/types/canvas": { CanvasNodeType },
        nanoid: { nanoid: () => `generated-${++id}` },
        react: { createElement() {} },
        "./canvas-project-utils": {
            createCanvasNode: (type: CanvasNodeType, position: unknown, metadata: unknown) => ({ id: `generated-${++id}`, type, position, width: 200, height: 100, metadata }),
            buildAngleLabel: () => "angle", buildAnglePrompt: () => "angle prompt", buildGenerationConfig: (config: unknown) => config,
            buildImageGenerationMetadata: (_mode: string, _config: unknown, _count: number, inputs: unknown[]) => ({ generationReferences: inputs }),
            imageMetadata: (uploaded: typeof image) => ({ content: uploaded.url, storageKey: uploaded.storageKey }), isGenerationCanceled: () => false,
        },
        "@/lib/quick-image-tools": { quickImageTitle: () => "quick", quickImageReferenceFileError: () => null },
        "@/lib/canvas/canvas-generation-record": { createCanvasGenerationRecord: (record: unknown) => record },
        "@/stores/use-module-store": { isModuleAvailable: () => true, useModuleStore: { getState: () => ({ flags: {} }) } },
        "@/services/api/image": {
            optimizeImagePrompt: async (_config: unknown, draft: unknown, inputs: unknown[]) => { references.push({ kind: "reverse", draft, inputs }); return { prompt: "recognized", summaryZh: "summary" }; },
            requestEdit: async (_config: unknown, _prompt: string, inputs: unknown[]) => { references.push({ kind: "quick", inputs }); return { metadata: { content: image.url }, uploaded: image }; },
        },
        "@/services/api/prompt-compilations": {},
        "@/components/canvas/canvas-node-mask-edit-dialog": {
            canvasMaskEditImageSettings: (_config: unknown, size: { width: number; height: number }) => ({ size: `${size.width}x${size.height}` }),
            readCanvasMaskImageSize: async (source: string) => { dimensions.push(source); return { width: 768, height: 1024 }; },
        },
    };
    const source = readFileSync(new URL("../src/pages/canvas/canvas-image-actions-runtime.ts", import.meta.url), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: {} as { createCanvasImageActionsRuntime: Function } };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name], module, module.exports);
    const actions = module.exports.createCanvasImageActionsRuntime({
        projectId: "canvas", nodesRef, designProjectIdRef: { current: "canvas" }, savedProjectIdRef: { current: "canvas" }, projectSaveQueueRef: { current: null },
        effectiveConfig: { model: "fixture", imageModel: "fixture" }, message, isCurrent: () => active, isAiConfigReady: () => true,
        setField: (key: string, value: unknown) => { const previous = key === "nodes" ? nodesRef.current : states[key]; const next = typeof value === "function" ? value(previous) : value; if (key === "nodes") nodesRef.current = next; else states[key] = next; },
        setDialogNodeId() {}, setContextMenu() {}, handleMissingModelConfig() {}, dialogs: { manualEditNode: node, setCropNodeId() {}, setSplitNodeId() {}, setUpscaleNodeId() {}, setMaskEditNodeId() {}, setAngleNodeId() {} },
        runLocalImageOperation: async (_key: string, _label: string, task: (signal: AbortSignal) => Promise<void>) => { try { await task(new AbortController().signal); } catch (error) { errors.push(String(error)); } },
        runtime: {
            generationDispatchLocksRef: { current: new Set() }, waitForWriteAccess: options.wait || (async () => true), setRunningNodeId() {}, finishGenerationRequest() {}, startGenerationRequest: () => new AbortController(),
            createOptions: async (_id: string, _controller: AbortController, _unused: unknown, tool: string) => { await options.prepare?.(); return {
                generate: async (_config: unknown, _prompt: string, inputs: unknown[], mask: unknown) => { references.push({ kind: tool, inputs, mask }); return { metadata: { content: image.url }, uploaded: image }; },
                receiveResult: (result: unknown) => result,
            }; },
        },
    });
    return { node, nodesRef, actions, reads, processing, uploads, references, errors, adaptations, dimensions, deactivate: () => { active = false; } };
}

const localActions = [
    ["cropImageNode", { x: 0, y: 0, width: 100, height: 100 }, "crop"],
    ["splitImageNode", { rows: 1, columns: 1 }, "split"],
    ["upscaleImageNode", { targetLongEdge: 2048 }, "upscale"],
] as const;

test("runtime construction does not read, decode or process image originals", () => {
    const app = harness({ serverAssetId: "cloud-original" });
    expect(app.reads).toEqual([]); expect(app.processing).toEqual([]); expect(app.dimensions).toEqual([]); expect(app.uploads).toEqual([]);
});

test("crop, split and upscale resolve durable cloud and local originals only on explicit actions", async () => {
    for (const metadata of [{ serverAssetId: "cloud-original" }, { content: "blob:expired", storageKey: "image:original", serverAssetId: "cloud-original" }, { content: "blob:expired", storageKey: "image:original" }, { storageKey: "image:original" }]) {
        for (const [action, params, kind] of localActions) {
            const app = harness(metadata); const before = structuredClone(app.node);
            await app.actions[action](app.node, params);
            expect(app.reads).toEqual([[metadata.storageKey, metadata.serverAssetId ? cloud : metadata.content || ""]]);
            expect(app.processing).toEqual([[kind, "blob:resolved-original", params]]);
            expect(app.nodesRef.current).toHaveLength(2); expect(app.node).toEqual(before);
            expect(app.nodesRef.current[1]?.metadata?.originalFileName).toBe("original.webp");
            expect(app.errors).toEqual([]);
        }
    }
});

test("local processing stops when original identity changes during a delayed read", async () => {
    for (const [action, params] of localActions) {
        const pending = Promise.withResolvers<string>(); const app = harness({ storageKey: "image:original", serverAssetId: "cloud-original" }, { resolve: () => pending.promise });
        const task = app.actions[action](app.node, params);
        for (let index = 0; index < 6; index++) await Promise.resolve();
        expect(app.reads).toHaveLength(1);
        app.nodesRef.current = [{ ...app.node, metadata: { content: "blob:edited", storageKey: "image:edited" } }];
        pending.resolve("blob:old-original"); await task;
        expect(app.processing).toEqual([]); expect(app.uploads).toEqual([]); expect(app.nodesRef.current).toHaveLength(1);
    }
});

test("reverse, angle and quick actions retain durable reference URLs and source identities", async () => {
    for (const [content, storageKey] of [[undefined, undefined], [undefined, "image:original"], ["blob:expired", "image:original"]]) {
        for (const [action, params, kind] of [["createImageReversePromptNodes", undefined, "reverse"], ["generateAngleNode", { yaw: 90 }, "canvas-angle"], ["quickImageNode", "remove-background", "quick"]] as const) {
            const app = harness({ content, serverAssetId: "cloud-original", storageKey });
            await app.actions[action](app.node, params);
            expect(app.references).toHaveLength(1);
            expect(app.references[0]).toMatchObject({ kind, inputs: [{ id: "original", dataUrl: cloud, storageKey, type: "image/webp" }] });
            if (kind === "reverse") expect(app.references[0].draft.referenceRoles).toEqual(["待反推图片"]);
            expect(app.reads).toEqual([]); expect(app.errors).toEqual([]);
        }
    }
});

test("mask dimensions, adaptation and source storage all refer to the recovered original", async () => {
    for (const content of [undefined, "blob:expired"]) {
        const app = harness({ content, serverAssetId: "cloud-original" });
        await app.actions.maskEditImageNode(app.node, { prompt: "change material", maskDataUrl: "data:mask", imageSettings: {} });
        expect(app.reads).toEqual([[undefined, cloud]]);
        expect(app.dimensions).toEqual(["blob:resolved-original", "data:mask"]);
        expect(app.uploads).toEqual(["blob:resolved-original", "data:mask"]);
        expect(app.adaptations).toEqual([["blob:resolved-original", "data:mask", { width: 768, height: 1024 }]]);
        expect(app.nodesRef.current[1]?.metadata?.maskAdaptation).toMatchObject({ sourceStorageKey: "image:upload-1", maskStorageKey: "image:upload-2" });
        expect(app.references[0]).toMatchObject({ kind: "canvas-mask-edit", inputs: [{ id: "original", dataUrl: "adapted-source", originalFileName: "original.webp" }], mask: { dataUrl: "adapted-mask" } });
        expect(app.errors).toEqual([]);
    }
});

test("mask submission does not decode, upload or submit an original replaced during recovery", async () => {
    const pending = Promise.withResolvers<string>(); const app = harness({ serverAssetId: "cloud-original" }, { resolve: () => pending.promise });
    const task = app.actions.maskEditImageNode(app.node, { prompt: "change material", maskDataUrl: "data:mask", imageSettings: {} });
    for (let index = 0; index < 6; index++) await Promise.resolve();
    expect(app.reads).toHaveLength(1);
    app.nodesRef.current = [{ ...app.node, metadata: { content: "blob:edited" } }];
    pending.resolve("blob:old-original"); await task;
    expect(app.dimensions).toEqual([]); expect(app.uploads).toEqual([]); expect(app.references).toEqual([]); expect(app.nodesRef.current).toHaveLength(1);
});

test("a changed original after local processing cannot upload or create a stale output", async () => {
    const pending = Promise.withResolvers<Blob>(); const app = harness({ content: "blob:original", storageKey: "image:original" }, { process: () => pending.promise });
    const task = app.actions.cropImageNode(app.node, localActions[0][1]);
    for (let index = 0; index < 6; index++) await Promise.resolve();
    expect(app.processing).toHaveLength(1);
    app.nodesRef.current = [{ ...app.node, metadata: { content: "blob:edited", storageKey: "image:edited" } }];
    pending.resolve(new Blob(["old output"])); await task;
    expect(app.uploads).toEqual([]); expect(app.nodesRef.current).toHaveLength(1);
});

test("reverse, angle and quick operations do not create or submit stale inputs after waiting for write access", async () => {
    for (const [action, params] of [["createImageReversePromptNodes", undefined], ["generateAngleNode", { yaw: 90 }], ["quickImageNode", "remove-background"]] as const) {
        const pending = Promise.withResolvers<boolean>(); const app = harness({ serverAssetId: "cloud-original" }, { wait: () => pending.promise });
        const task = app.actions[action](app.node, params);
        for (let index = 0; index < 6; index++) await Promise.resolve();
        app.nodesRef.current = [{ ...app.node, metadata: { ...app.node.metadata, serverAssetId: "replacement" } }];
        pending.resolve(true); await task;
        expect(app.references).toEqual([]); expect(app.nodesRef.current).toHaveLength(1);
    }
});

test("generation preparation cannot dispatch a replaced source to a paid image operation", async () => {
    for (const [action, params] of [["generateAngleNode", { yaw: 90 }], ["quickImageNode", "remove-background"], ["maskEditImageNode", { prompt: "change", maskDataUrl: "data:mask", imageSettings: {} }]] as const) {
        const pending = Promise.withResolvers<void>(), prepared = Promise.withResolvers<void>();
        const app = harness({ serverAssetId: "cloud-original" }, { prepare: () => { prepared.resolve(); return pending.promise; } });
        const task = app.actions[action](app.node, params);
        await prepared.promise;
        app.nodesRef.current = app.nodesRef.current.map(item => item.id === app.node.id ? { ...item, metadata: { ...item.metadata, serverAssetId: "replacement" } } : item);
        pending.resolve(); await task;
        expect(app.references).toEqual([]);
        expect(app.nodesRef.current[1]?.metadata?.status).toBe("error");
        expect(app.errors).toHaveLength(1);
    }
});

test("manual save rejects a changed cloud original even when content and local storage are unchanged", async () => {
    const app = harness({ serverAssetId: "cloud-original" });
    app.nodesRef.current = [{ ...app.node, metadata: { ...app.node.metadata, serverAssetId: "replacement" } }];
    await expect(app.actions.saveManualImageEdit(image)).rejects.toThrow("原图片已发生变化");
    expect(app.nodesRef.current).toHaveLength(1);
});
