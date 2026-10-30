import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { createCanvasGenerationRecord } from "@/lib/canvas/canvas-generation-record";
import * as nodeGeneration from "@/components/canvas/canvas-node-generation";
import { i18nHarness } from "./helpers/i18n-harness";

type Hook = typeof import("@/pages/canvas/use-canvas-generation").useCanvasGeneration;
const url = new URL("../src/pages/canvas/use-canvas-generation.ts", import.meta.url);
const requireModule = createRequire(url);
const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const config = { ...defaultConfig, model: "gpt-image-2", imageModel: "gpt-image-2", size: "1:1", quality: "low", systemPrompt: "" };
const original: CanvasNodeData = { id: "original", type: CanvasNodeType.Image, title: "原始图片", position: { x: 0, y: 0 }, width: 200, height: 200,
    metadata: { content: "blob:original", storageKey: "image:original", prompt: "不要覆盖原词", draftPrompt: "新提示词", model: config.model } };

function harness(initial: CanvasNodeData[], initialConnections: CanvasConnection[] = [], options: { hydrate?: typeof nodeGeneration.hydrateNodeGenerationContext; generate?: () => Promise<void> } = {}) {
    const nodes = { current: structuredClone(initial) }, connections = { current: structuredClone(initialConnections) };
    let ownerId = "employee-a", id = 0, historyFlushes = 0;
    const submissions: Array<{ config: typeof config; prompt: string; references: any[]; exact: boolean; targetId: string }> = [];
    const feedback: string[] = [];
    const scope = {
        react: { useMemo: (create: Function) => create(), useCallback: (callback: Function) => callback, useRef: (current: unknown) => ({ current }), useEffect: () => {} },
        antd: { App: { useApp: () => ({ message: { info: (text: string) => feedback.push(text), error: (text: string) => feedback.push(text), warning: (text: string) => feedback.push(text) }, modal: {} }) } },
        nanoid: { nanoid: () => `new-${++id}` },
        "@/lib/i18n": i18nHarness,
        "@/stores/use-config-store": { ...requireModule("@/stores/use-config-store"), useEffectiveConfig: () => config },
        "@/stores/use-user-store": { useUserStore: { getState: () => ({ user: { id: ownerId } }) } },
        "@/stores/use-business-config-store": { useBusinessConfigStore: { getState: () => ({ models: [], tools: [] }) } },
        "@/stores/use-asset-store": { useAssetStore: (select: Function) => select({ addAsset: () => {} }) },
        "@/stores/canvas/canvas-graph-store": { useCanvasGraphSetter: (key: string) => (value: any) => {
            const reference = key === "nodes" ? nodes : key === "connections" ? connections : null;
            if (reference) reference.current = typeof value === "function" ? value(reference.current) : value;
        } },
        "@/components/canvas/canvas-node-generation": { ...nodeGeneration, hydrateNodeGenerationContext: options.hydrate || (async (context: any) => context) },
        "@/lib/canvas/canvas-generation-model": { resolveCanvasImageConfig: (input: typeof config, _business: unknown, hasReferences: boolean) => ({ config: input, toolKey: hasReferences ? "canvas-edit" : "canvas-image" }) },
        "./canvas-shared-generation-runtime": { runCanvasGeneration: async (nodeId: string, mode: string, prompt: string, onResult: Function, runtime: any) => runtime.execute(nodeId, mode, prompt, onResult) },
    } as Record<string, unknown>;
    const exports = {} as { useCanvasGeneration: Hook };
    new Function("require", "module", "exports", code)((key: string) => scope[key] || requireModule(key), { exports }, exports);
    const runtime = {
        createOptions: async (targetId: string) => ({ generate: async (parameters: typeof config, prompt: string, references?: any[], _mask?: unknown, _edit?: boolean, _input?: unknown, exact = false) => {
            submissions.push({ config: structuredClone(parameters), prompt, references: structuredClone(references || []), exact, targetId });
            await options.generate?.();
            return { metadata: { content: "blob:result", storageKey: "image:result", status: "success" }, uploaded: { url: "blob:result", storageKey: "image:result", width: 600, height: 400, bytes: 100, mimeType: "image/png" } };
        } }),
        recoverPending: async () => null, setRunningNodeId: () => {}, generationDispatchLocksRef: { current: new Set<string>() },
        textStreamBufferRef: { current: null }, startGenerationRequest: (_target: string, _origin: string, _run: string, controller?: AbortController) => controller || new AbortController(), finishGenerationRequest: () => {},
    } as unknown as Parameters<Hook>[0]["runtime"];
    const action = exports.useCanvasGeneration({ projectId: "project", nodesRef: nodes, connectionsRef: connections, designProjectIdRef: { current: "project" }, projectSaveQueueRef: { current: null }, runtime,
        setDialogNodeId: () => {}, focusCanvasArea: () => {}, handleMissingModelConfig: () => {}, isAiConfigReady: () => true, flushPendingHistory: () => historyFlushes++ });
    return { action, nodes, connections, submissions, feedback, historyFlushes: () => historyFlushes, changeOwner: () => { ownerId = "employee-b"; } };
}

test.each([CanvasNodeType.Config, CanvasNodeType.Image, CanvasNodeType.Text])("image generation from %s appends one result and preserves the entire source", async type => {
    const source: CanvasNodeData = { ...original, type, metadata: { prompt: "保存原词", composerContent: "原始配置", draftPrompt: "用户草稿", model: config.model, ...(type === CanvasNodeType.Text ? { content: "原始文本" } : {}) } };
    const h = harness([source]);
    const before = h.nodes.current[0];
    await h.action.handleGenerateNode(source.id, "image", "新的生成提示词");
    expect(h.feedback).toEqual([]);
    expect(h.nodes.current).toHaveLength(2);
    expect(h.nodes.current[0]).toBe(before);
    expect(h.nodes.current[1]!.metadata?.generationRecord).toMatchObject({ sourceNodeId: source.id, inputPrompt: "新的生成提示词", references: [] });
    expect(h.connections.current).toHaveLength(1);
    expect(h.connections.current[0]).toMatchObject({ fromNodeId: source.id, toNodeId: h.nodes.current[1]!.id, kind: "generation-output" });
    expect(h.historyFlushes()).toBe(1);
});

test("editing an original image appends a result with the actual input order, without overwriting its prompt or references", async () => {
    const source = { ...original, metadata: { ...original.metadata, manualImageReferences: [{ id: "manual", referenceKey: "upload:manual", name: "手动参考", type: "image/png", content: "blob:manual", storageKey: "image:manual", origin: "upload" as const }] } };
    const h = harness([source]);
    const before = h.nodes.current[0];
    await h.action.handleGenerateNode(source.id, "image", "编辑它");
    expect(h.nodes.current[0]).toBe(before);
    expect(h.submissions[0]!.references.map(item => item.id)).toEqual([source.id, "manual"]);
    expect(h.nodes.current[1]!.metadata!.generationRecord!.references.map(item => [item.id, item.order])).toEqual([[source.id, 0], ["manual", 1]]);
});

test("a result uses its saved references, not itself or live upstream nodes; an empty draft stays reference-free", async () => {
    const record = createCanvasGenerationRecord({ id: "old", sourceNodeId: original.id, prompt: "最终提示词", inputPrompt: "原稿", references: [{ id: original.id, name: "原图", dataUrl: "blob:original", storageKey: "image:original", type: "image/png" }], config, generationType: "edit", nodes: [original] });
    const result = { ...original, id: "old-result", metadata: { content: "blob:old-result", storageKey: "image:old-result", generationRecord: record, model: config.model } };
    const h = harness([result]);
    await h.action.handleGenerateNode(result.id, "image", "修改草稿");
    expect(h.submissions[0]!.references.map(item => item.storageKey)).toEqual(["image:original"]);
    expect(h.nodes.current[1]!.metadata!.generationRecord!.references[0]!.sourceNodeId).toBe(original.id);
    const blank = harness([{ ...result, metadata: { ...result.metadata, draftImageReferences: [] } }]);
    await blank.action.handleGenerateNode(result.id, "image", "无参考生成");
    expect(blank.submissions[0]!.references).toEqual([]);
});

test("exact regenerate ignores edited drafts and parameters and adds a sibling result", async () => {
    const record = createCanvasGenerationRecord({ id: "old", sourceNodeId: original.id, prompt: "最终提示词含系统和图序", inputPrompt: "原稿", references: [], config: { ...config, size: "1536x1024", quality: "high" }, generationType: "generation", nodes: [] });
    const h = harness([{ ...original, metadata: { ...original.metadata, generationRecord: record, draftPrompt: "不同草稿", size: "1:1", quality: "low", draftImageReferences: [{ id: "wrong", name: "新参考", referenceKey: "upload:wrong", origin: "upload", type: "image/png", content: "blob:wrong" }] } }]);
    await h.action.handleRegenerateNode(h.nodes.current[0]!);
    expect(h.nodes.current).toHaveLength(2);
    expect(h.submissions[0]).toMatchObject({ prompt: record.prompt, exact: true, references: [], config: { size: "1536x1024", quality: "high" } });
    expect(h.nodes.current[0]!.metadata!.draftPrompt).toBe("不同草稿");
});

test("owner change while references hydrate cannot create nodes or submit a paid request", async () => {
    const ready = Promise.withResolvers<void>();
    const h = harness([original], [], { hydrate: async context => { await ready.promise; return context; } });
    const generating = h.action.handleGenerateNode(original.id, "image", "p");
    await new Promise(resolve => setTimeout(resolve, 0));
    h.changeOwner(); ready.resolve(); await generating;
    expect(h.nodes.current).toHaveLength(1);
    expect(h.connections.current).toEqual([]);
    expect(h.submissions).toEqual([]);
});

test("legacy text-to-image ignores live upstream inputs, while missing legacy edit references blocks a new request", async () => {
    const result: CanvasNodeData = { ...original, id: "legacy", metadata: { content: "blob:legacy", generationType: "generation", references: [], model: config.model } };
    const edges = [{ id: "legacy-edge", fromNodeId: original.id, toNodeId: result.id }];
    const complete = harness([original, result], edges);
    await complete.action.handleGenerateNode(result.id, "image", "新提示词");
    expect(complete.submissions[0]!.references).toEqual([]);
    const incomplete = harness([original, { ...result, metadata: { ...result.metadata, generationType: "edit", references: undefined } }], edges);
    await incomplete.action.handleGenerateNode(result.id, "image", "不应提交");
    expect(incomplete.submissions).toEqual([]);
    expect(incomplete.nodes.current).toHaveLength(2);
    expect(incomplete.feedback).toContain("旧版记录参考信息不完整，可恢复历史输入");
});
