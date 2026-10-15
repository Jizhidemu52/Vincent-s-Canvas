import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type DependencyList, type EffectCallback, type ReactElement } from "react";
import ts from "typescript";

import * as configModule from "@/stores/use-config-store";
import { applyCanvasAgentOps, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { CanvasNodeType, type CanvasAssistantMessage, type CanvasNodeData } from "@/types/canvas";
import { toolResponseToInput, type ToolResponseResult } from "@/services/api/image";
import * as generationTasks from "@/services/api/generation-tasks";
import { QueuedTaskPausedError } from "@/services/api/generation-tasks";
import { serverAssetIdFromAsset, type AssetInput } from "@/stores/use-asset-store";
import type { UploadedImage } from "@/services/image-storage";
import type { UploadedFile } from "@/services/file-storage";
import { moduleKeys, type ModuleKey } from "@/services/api/modules";
import { isModuleAvailable } from "@/stores/use-module-store";
import type { BusinessConfig } from "@/services/api/business-config";
import * as toolRuntime from "@/services/api/tool-runtime";

const requireModule = createRequire(new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url));
const source = readFileSync(new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const toolConfigCode = ts.transpileModule(readFileSync(new URL("../src/hooks/use-tool-config.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;

function panelHarness(options: { replies: ToolResponseResult[]; config?: Partial<configModule.AiConfig>; flags?: Partial<Record<ModuleKey, boolean>>; tools?: BusinessConfig["tools"]; selected?: CanvasNodeData[]; nodes?: CanvasNodeData[]; history?: CanvasAssistantMessage[]; confirmTools?: boolean; generate?: () => Promise<Array<{ id: string; dataUrl: string }>>; video?: () => Promise<{ url: string; mimeType: string }>; storedImage?: UploadedImage; storedVideo?: UploadedFile }) {
    const states: unknown[] = [];
    const refs: unknown[] = [];
    const memos: Array<{ dependencies?: DependencyList; value: unknown }> = [];
    const effects: Array<{ dependencies?: DependencyList; cleanup?: ReturnType<EffectCallback> }> = [];
    const pendingEffects: Array<() => void> = [];
    let stateIndex = 0;
    let refIndex = 0;
    let memoIndex = 0;
    let effectIndex = 0;
    const requests: Array<{ type: string; args: any[] }> = [];
    const assets: AssetInput[] = [];
    const imageUploads: string[] = [];
    const videoStores: unknown[] = [];
    const config = { ...configModule.defaultConfig, model: "text-model", textModel: "text-model", imageModel: "gpt-image-2", videoModel: "MiniMax-H3", size: "3:4", quality: "2k", canvasImageCount: "2", videoSeconds: "6", vquality: "1080P", videoGenerateAudio: "true", ...options.config };
    const flags = { ...Object.fromEntries(moduleKeys.map(key => [key, true])), ...options.flags } as Record<ModuleKey, boolean>;
    const business: BusinessConfig = {
        models: [
            { id: "text-model", name: config.textModel, modelId: config.textModel, capabilities: ["chat"], creditCost: 0, rmbCost: 0 },
            { id: "image-model", name: config.imageModel, modelId: config.imageModel, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
            { id: "video-model", name: config.videoModel, modelId: config.videoModel, capabilities: ["video"], creditCost: 0, rmbCost: 0 },
        ], prices: [], tools: options.tools || [],
    };
    const sessions = options.history ? [{ id: "history", title: "History", createdAt: "2026-09-06", updatedAt: "2026-09-06", messages: options.history }] : [];
    const onSessionsChange = () => undefined;
    const capabilityRequests: string[] = [];
    const dependenciesEqual = (previous?: DependencyList, next?: DependencyList) => Boolean(previous && next && previous.length === next.length && previous.every((value, index) => Object.is(value, next[index])));
    const useMemo = (factory: () => unknown, dependencies?: DependencyList) => {
        const index = memoIndex++;
        if (!memos[index] || !dependenciesEqual(memos[index].dependencies, dependencies)) memos[index] = { dependencies, value: factory() };
        return memos[index].value;
    };
    const snapshotRef: { current: CanvasAgentSnapshot } = { current: { projectId: "project", title: "Canvas", nodes: options.nodes || options.selected || [], connections: [], selectedNodeIds: (options.selected || []).map((node) => node.id), viewport: { x: 0, y: 0, k: 1 }, viewportSize: { width: 800, height: 600 } } };
    const imageRequest = async (type: string, args: any[]) => {
        requests.push({ type, args });
        return options.generate ? options.generate() : [{ id: "generated-image", dataUrl: "/api/assets/result/content" }];
    };
    const dependencies: Record<string, unknown> = {
        "@/lib/canvas/canvas-assistant-media": {
            captureCanvasContextSnapshot: (snapshot: CanvasAgentSnapshot) => snapshot,
            readCanvasContextImage: async (node: CanvasNodeData) => `data:image/jpeg;base64,${node.id}`,
            readCanvasContextVideo: async (node: CanvasNodeData) => [{ seconds: 0, dataUrl: `data:image/jpeg;base64,${node.id}-frame` }],
            readCanvasConversationImage: async (reference: { id: string; dataUrl?: string }) => reference.dataUrl?.startsWith("data:image/") ? reference.dataUrl : `data:image/jpeg;base64,${reference.id}`,
        },
        react: {
            ...React,
            memo: (component: unknown) => component,
            useEffect: (effect: EffectCallback, dependencies?: DependencyList) => {
                const index = effectIndex++;
                const previous = effects[index];
                if (!previous || !dependenciesEqual(previous.dependencies, dependencies)) {
                    pendingEffects.push(() => {
                        previous?.cleanup?.();
                        effects[index] = { dependencies, cleanup: effect() };
                    });
                }
            },
            useMemo,
            useCallback: (callback: unknown, dependencies?: DependencyList) => useMemo(() => callback, dependencies),
            useRef: (initial: unknown) => { const index = refIndex++; return refs[index] ||= { current: initial }; },
            useState: (initial: unknown) => {
                const index = stateIndex++;
                if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
                return [states[index], (next: unknown) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
            },
        },
        "@/stores/use-config-store": { ...configModule, useEffectiveConfig: () => config, useConfigStore: (selector: (state: unknown) => unknown) => selector({ openConfigDialog: () => undefined, updateConfig: () => undefined }) },
        "@/stores/use-theme-store": { useThemeStore: (selector: (state: unknown) => unknown) => selector({ theme: "light" }) },
        "@/stores/use-user-store": { useUserStore: (selector: (state: unknown) => unknown) => selector({ user: null }) },
        "@/stores/use-asset-store": { serverAssetIdFromAsset, useAssetStore: (selector: (state: unknown) => unknown) => selector({ cleanupImages: () => undefined, addAssets: (items: AssetInput[]) => { assets.push(...items); return items.map((_, index) => `asset-${index}`); } }) },
        "@/stores/canvas/use-canvas-agent-store": { useCanvasAgentStore: (selector: (state: unknown) => unknown) => selector({ confirmTools: options.confirmTools || false, setAgentState: () => undefined }) },
        "@/hooks/use-can-manage-config": { useCanManageConfig: () => false },
        "@/stores/use-module-store": { isModuleAvailable, useModuleEnabled: (key: ModuleKey) => isModuleAvailable(flags, business.tools, key), useModuleStore: (selector: (state: unknown) => unknown) => selector({ flags, status: "ready" }) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: Object.assign((selector: (state: BusinessConfig) => unknown) => selector(business), { getState: () => business }) },
        "@/services/api/tool-runtime": { ...toolRuntime, resolveToolConfig: async (config: configModule.AiConfig, operation: string, key?: string) => {
            const toolKey = toolRuntime.requireToolKey(operation, key);
            const resolved = toolRuntime.applyToolModel(config, business, toolKey);
            return { toolKey, config: resolved, model: toolRuntime.resolveConfiguredToolModel(business, toolKey, resolved.model) };
        } },
        "@/services/api/generation-tasks": {
            ...generationTasks,
            getImageGenerationModels: async () => {
                capabilityRequests.push("image");
                return [{ id: "image-model", name: config.imageModel, modelId: config.imageModel, capabilities: ["generate"], creditCost: 0, rmbCost: 0 }];
            },
            getGenerationCapabilities: async () => {
                capabilityRequests.push("video");
                return { models: [{ id: "video-model", name: config.videoModel, modelId: config.videoModel, capability: { seconds: [1, 10], resolutions: ["720P", "1080P"], sizes: ["1:1", "3:4", "16:9"], minImages: 0, maxImages: 9, firstFrameRequired: false, supportsAudio: true } }] };
            },
        },
        "@/services/api/image": {
            toolResponseToInput,
            requestToolResponse: async (...args: any[]) => { requests.push({ type: "agent", args }); return options.replies.shift() || { content: "没有更多调用", toolCalls: [] }; },
            requestImageQuestion: async (...args: any[]) => { requests.push({ type: "text", args }); return "refined prompt"; },
            requestGeneration: (...args: any[]) => imageRequest("image", args),
            requestEdit: (...args: any[]) => imageRequest("edit", args),
        },
        "@/services/api/video": {
            requestVideoGeneration: async (...args: any[]) => { requests.push({ type: "video", args }); args[5]?.onSubmitted?.({ id: "video-task", provider: "server", model: args[0].model }); return options.video ? options.video() : { url: "/api/assets/video/content", mimeType: "video/mp4" }; },
            storeGeneratedVideo: async (result: any) => { videoStores.push(result); return options.storedVideo || { url: result.url, storageKey: "video:cached", bytes: 123, mimeType: result.mimeType, width: 768, height: 768 }; },
        },
        "@/services/image-storage": { uploadImage: async (url: string) => { imageUploads.push(url); return options.storedImage || { url, storageKey: "", width: 1024, height: 1024, bytes: 100, mimeType: "image/png" }; }, imageToDataUrl: async (reference: any) => reference.dataUrl || reference.url },
    };
    // Execute the real hook against this harness's React dispatcher and scoped stores.
    // No global Zustand state or network configuration leaks into manual renders.
    const toolConfigModule = { exports: {} as any };
    new Function("require", "module", "exports", toolConfigCode)((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name), toolConfigModule, toolConfigModule.exports);
    dependencies["@/hooks/use-tool-config"] = toolConfigModule.exports;
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code)((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name), module, module.exports);
    const render = () => {
        stateIndex = refIndex = memoIndex = effectIndex = 0;
        const element = module.exports.CanvasAssistantPanel({
            selectedNodeIds: new Set(snapshotRef.current.selectedNodeIds), selectedNodes: options.selected || [], snapshotRef,
            sessions, activeSessionId: null, onSelectNodeIds: () => undefined, onSessionsChange,
            onApplyOps: (ops: any[]) => snapshotRef.current = applyCanvasAgentOps(snapshotRef.current, ops),
            canUndoOps: false, onUndoOps: () => null, onPasteImage: () => undefined,
            agentMode: "online", onAgentModeChange: () => undefined, closing: false, onCollapse: () => undefined,
        }) as ReactElement<any>;
        for (const effect of pendingEffects.splice(0)) effect();
        return element;
    };
    const composer = () => findElements(render()).find((element) => typeof element.props.onSubmit === "function")!;
    const messages = (): CanvasAssistantMessage[] => states.flatMap((value) => Array.isArray(value) ? value.flatMap((item) => item?.messages || []) : []);
    return {
        requests, config, snapshotRef, composer, messages, assets, imageUploads, videoStores, capabilityRequests,
        select(nodes: CanvasNodeData[]) {
            options.selected = nodes;
            snapshotRef.current = { ...snapshotRef.current, selectedNodeIds: nodes.map((node) => node.id) };
            render();
        },
        toggleContext() { findElements(render()).find((element) => element.type === "button" && typeof element.props["aria-pressed"] === "boolean")!.props.onClick(); },
        referencePreviews() {
            const rows = findElements(render()).filter((element) => typeof element.type === "function" && element.type.name === "MessageReferences");
            const chips = rows.flatMap((element) => findElements((element.type as Function)(element.props))).filter((element) => typeof element.type === "function" && element.type.name === "AssistantReferenceChip");
            return chips.flatMap((element) => findElements((element.type as Function)(element.props))).filter((element) => typeof element.type === "function" && element.type.name === "CanvasPersistedMediaPreview").map((element) => element.props);
        },
        async ready() { await waitFor(() => !composer().props.disabled); },
        async submit(prompt: string) { await waitFor(() => !composer().props.disabled); composer().props.onPromptChange(prompt); await composer().props.onSubmit(); },
        approve(messageId: string) { findElements(render()).find((element) => typeof element.props.onApproveTool === "function")!.props.onApproveTool(messageId); },
        approvalHandler() { return findElements(render()).find((element) => typeof element.props.onApproveTool === "function")!.props.onApproveTool as (messageId: string) => void; },
        async uploadReference() {
            const original = globalThis.FileReader;
            class Reader {
                result = "data:image/png;base64,dXBsb2FkZWQtcmVmZXJlbmNl";
                onload?: () => void;
                readAsDataURL() { this.onload?.(); }
            }
            globalThis.FileReader = Reader as unknown as typeof FileReader;
            try { await composer().props.onAddFiles([new File(["reference"], "uploaded-reference.png", { type: "image/png" })]); }
            finally { globalThis.FileReader = original; }
        },
    };
}

async function waitFor(predicate: () => boolean) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await Promise.resolve();
    }
    throw new Error("Panel did not reach the expected state");
}

function findElements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(findElements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...findElements(element.props.children)];
}

function tool(name: string, args: Record<string, unknown>): ToolResponseResult {
    return { content: "", toolCalls: [{ id: "tool-1", type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

describe("canvas assistant submission", () => {
    test("recalls selected image prompts without submitting, changing presets, or replacing a same-image edit", async () => {
        const first: CanvasNodeData = { id: "first", type: CanvasNodeType.Image, title: "第一张", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "blob:first", prompt: "第一张原始提示词", model: "unrelated-model" } };
        const second = { ...first, id: "second", metadata: { content: "blob:second", prompt: "第二张原始提示词" } };
        const harness = panelHarness({ selected: [first], replies: [] });
        await harness.ready();
        expect(harness.composer().props.prompt).toBe("第一张原始提示词");
        const settings = harness.composer().props.generationControls.props.settings;
        harness.composer().props.onPromptChange("用户正在修改的文字");
        harness.select([{ ...first, position: { x: 99, y: 99 }, metadata: { ...first.metadata, prompt: "后台更新" } }]);
        expect(harness.composer().props.prompt).toBe("用户正在修改的文字");
        harness.select([second]);
        expect(harness.composer().props.prompt).toBe("第二张原始提示词");
        expect(harness.composer().props.generationControls.props.settings).toEqual(settings);
        expect(harness.requests).toHaveLength(0);
        expect(harness.imageUploads).toHaveLength(0);
    });

    test("clears a prior image prompt for uploads and multiple images, retaining an unselected creation draft", async () => {
        const first: CanvasNodeData = { id: "first", type: CanvasNodeType.Image, title: "第一张", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "blob:first", prompt: "第一张原始提示词" } };
        const upload = { ...first, id: "upload", metadata: { content: "blob:upload" } };
        const harness = panelHarness({ selected: [first], replies: [] });
        await harness.ready();
        harness.select([upload]);
        expect(harness.composer().props.prompt).toBe("");
        harness.select([first]);
        harness.select([first, upload]);
        expect(harness.composer().props.prompt).toBe("");
        harness.composer().props.onPromptChange("两张参考图的编辑要求");
        harness.select([upload, first]);
        expect(harness.composer().props.prompt).toBe("两张参考图的编辑要求");
        harness.select([]);
        expect(harness.composer().props.prompt).toBe("两张参考图的编辑要求");
        expect(harness.requests).toHaveLength(0);
    });

    test("loads capabilities once and normalizes image settings without blocking text conversation", async () => {
        const harness = panelHarness({ replies: [] });
        expect(harness.composer().props.disabled).toBe(false);
        expect(harness.composer().props.generationControls.props.loading).toBe(true);
        await waitFor(() => !harness.composer().props.generationControls.props.loading);
        expect(harness.composer().props.disabled).toBe(false);
        expect(harness.composer().props.generationControls.props.loading).toBe(false);
        expect(harness.capabilityRequests).toEqual(["image", "video"]);
        expect(harness.composer().props.generationControls.props.settings).toMatchObject({ imageModel: "gpt-image-2", size: "1152x1536", quality: "auto", imageCount: "2" });
        expect(harness.requests).toHaveLength(0);
    });

    test("disabled chat capability or canvas parent blocks stale submit handlers without media requests", async () => {
        for (const unavailable of [
            { flags: { canvas: false } },
            { tools: [{ toolKey: "canvas-chat", modelConfigId: null, enabled: false, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }] },
        ]) {
            const harness = panelHarness({ replies: [tool("canvas_generate_image", { editIntent: "new", prompt: "must not submit" })], ...unavailable });
            expect(harness.composer().props.disabled).toBe(true);
            harness.composer().props.onPromptChange("不要穿过停用状态提交");
            await harness.composer().props.onSubmit();
            expect(harness.requests).toHaveLength(0);
            expect(harness.snapshotRef.current.nodes).toEqual([]);
        }
    });

    test("automatically sends unselected visible pixels and video frames, and the toggle disables only automatic media", async () => {
        const logo: CanvasNodeData = { id: "logo", type: CanvasNodeType.Image, title: "素材 A", position: { x: 20, y: 20 }, width: 200, height: 200, metadata: { content: "blob:logo" } };
        const clip = { ...logo, id: "clip", type: CanvasNodeType.Video };
        const hidden = { ...logo, id: "offscreen", position: { x: 3000, y: 0 } };
        const harness = panelHarness({ nodes: [logo, clip, hidden], replies: [{ content: "已看到标志和抽样画面", toolCalls: [] }, { content: "自动读取已关闭", toolCalls: [] }] });
        await harness.submit("当前画布上是什么？");
        expect(harness.requests.map((request) => request.type)).toEqual(["agent"]);
        const content = harness.requests[0].args[1].at(-1).content;
        expect(content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url)).toEqual(["data:image/jpeg;base64,logo", "data:image/jpeg;base64,clip-frame"]);
        expect(harness.messages().find((message) => message.role === "user")?.detail?.canvasContext).toMatchObject({ included: 2 });
        harness.toggleContext();
        await harness.uploadReference();
        await harness.submit("现在只分析上传图");
        const disabledContent = harness.requests.at(-1)!.args[1].at(-1).content;
        expect(disabledContent.filter((part: any) => part.type === "image_url")).toHaveLength(1);
        expect(disabledContent.find((part: any) => part.type === "image_url").image_url.url).toContain("dXBsb2FkZWQtcmVmZXJlbmNl");
        expect(JSON.stringify(disabledContent)).not.toContain("本轮自动画布上下文");
    });

    test("answers an ordinary question through the chat model without starting media generation", async () => {
        const harness = panelHarness({ replies: [{ content: "图片是静态画面，视频包含连续画面。", toolCalls: [] }] });
        await harness.submit("图片和视频有什么区别？先解释，不要生成");
        expect(harness.requests.map((request) => request.type)).toEqual(["agent"]);
        expect(harness.requests[0].args[3]).toBe("auto");
        expect(harness.messages().some((message) => message.text === "图片是静态画面，视频包含连续画面。")).toBe(true);
        expect(harness.snapshotRef.current.nodes).toHaveLength(0);
    });

    test("waits for an explicit image tool result before returning completion to the chat model", async () => {
        let finish!: (items: Array<{ id: string; dataUrl: string }>) => void;
        const generated = new Promise<Array<{ id: string; dataUrl: string }>>((resolve) => { finish = resolve; });
        const harness = panelHarness({ replies: [tool("canvas_generate_image", { editIntent: "new", prompt: "静态海报：电影镜头与相机" }), { content: "图片已完成", toolCalls: [] }], generate: () => generated });
        const submitted = harness.submit("请生成静态海报：电影镜头与相机");
        await waitFor(() => harness.requests.some((request) => request.type === "image"));
        expect(harness.requests.filter((request) => request.type === "agent")).toHaveLength(1);
        expect(harness.requests.filter((request) => request.type === "video")).toHaveLength(0);
        expect(harness.messages().some((message) => message.attachments?.length)).toBe(false);
        finish([{ id: "generated-image", dataUrl: "/api/assets/result/content" }]);
        await submitted;
        expect(harness.requests.filter((request) => request.type === "agent")).toHaveLength(2);
        expect(harness.requests.find((request) => request.type === "image")?.args[0]).toMatchObject({ model: "gpt-image-2", count: "2", size: "1152x1536", quality: "auto" });
        expect(harness.messages().flatMap((message) => message.attachments || [])).toContainEqual(expect.objectContaining({ id: "generated-image", url: "/api/assets/result/content", mediaType: "image", width: 1024, height: 1024 }));
        expect(harness.snapshotRef.current.nodes.find((node) => node.type === CanvasNodeType.Image && node.metadata?.content === "/api/assets/result/content")).toMatchObject({ width: 340, height: 340 });
    });

    test("passes both uploaded and selected images to the chat model and the actual edit request", async () => {
        const selected: CanvasNodeData = { id: "selected-reference", type: CanvasNodeType.Image, title: "原款", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "blob:stored-reference", storageKey: "stored-reference-key", status: "success" } };
        const harness = panelHarness({ selected: [selected], confirmTools: true, replies: [tool("canvas_generate_image", { editIntent: "new", prompt: "保留两张参考的服装版型与花型，仅将背景调整为淡蓝色" }), { content: "改图已完成", toolCalls: [] }] });
        await harness.uploadReference();
        await harness.submit("根据上传图和选中的原款改背景，不改变服装");
        const firstContent = harness.requests.find((request) => request.type === "agent")!.args[1].at(-1).content;
        expect(firstContent.filter((part: any) => part.type === "image_url")).toHaveLength(2);
        expect(firstContent.find((part: any) => part.type === "text" && part.text.includes("创作预设"))?.text).toContain('"quality":"auto"');
        expect(firstContent.find((part: any) => part.type === "text" && part.text.includes("可用参考图片"))?.text).toContain('"source":"upload"');
        expect(harness.requests.some((request) => request.type === "image" || request.type === "edit")).toBe(false);
        const confirmation = harness.messages().find((message) => message.role === "tool" && message.detail?.status === "pending")!;
        harness.approve(confirmation.id);
        await waitFor(() => harness.requests.filter((request) => request.type === "agent").length === 2);
        const edit = harness.requests.find((request) => request.type === "edit");
        expect(edit?.args[1]).toBe("保留两张参考的服装版型与花型，仅将背景调整为淡蓝色");
        expect(edit?.args[2]).toHaveLength(2);
        expect(edit?.args[2]).toContainEqual(expect.objectContaining({ id: "selected-reference", storageKey: "stored-reference-key" }));
        expect(edit?.args[2]).toContainEqual(expect.objectContaining({ name: "uploaded-reference.png", dataUrl: "data:image/png;base64,dXBsb2FkZWQtcmVmZXJlbmNl" }));
        expect(harness.messages().some((message) => message.attachments?.length && message.text.includes(edit!.args[1]))).toBe(true);
    });

    test("uses the explicit video tool and preserves duration, aspect ratio, quality, audio, and reference data", async () => {
        const selected: CanvasNodeData = { id: "selected-reference", type: CanvasNodeType.Image, title: "首帧", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "data:image/png;base64,cmVm", storageKey: "source-key", status: "success" } };
        const harness = panelHarness({ selected: [selected], replies: [tool("canvas_generate_video", { prompt: "以参考图为首帧，让主体轻微移动" }), { content: "视频已完成", toolCalls: [] }] });
        await harness.submit("请用这张图生成视频");
        expect(harness.requests.map((request) => request.type)).toEqual(["agent", "video", "agent"]);
        const video = harness.requests[1];
        expect(video.args[0]).toMatchObject({ model: "MiniMax-H3", videoSeconds: "6", size: "3:4", vquality: "1080P", videoGenerateAudio: "true" });
        expect(video.args[2]).toEqual([expect.objectContaining({ id: "selected-reference", storageKey: "source-key", dataUrl: "data:image/png;base64,cmVm" })]);
        expect(harness.messages().flatMap((message) => message.attachments || [])).toContainEqual(expect.objectContaining({ mediaType: "video", url: "/api/assets/video/content" }));
    });

    test("retains the chosen video ratio across image and video preset switches", async () => {
        const harness = panelHarness({ replies: [tool("canvas_generate_video", { prompt: "花瓶旋转" })] });
        await harness.ready();
        // The video tab normalizes the current pixel size before sending its patch.
        harness.composer().props.generationControls.props.onChange({ mode: "video", size: "1:1" });
        expect(harness.composer().props.generationControls.props.settings).toMatchObject({ mode: "video", size: "3:4" });
        harness.composer().props.generationControls.props.onChange({ size: "16:9" });
        harness.composer().props.generationControls.props.onChange({ mode: "image", size: "1024x1024" });
        await harness.submit("生成花瓶旋转视频");
        expect(harness.requests.find((request) => request.type === "video")?.args[0].size).toBe("16:9");
        expect(harness.composer().props.generationControls.props.settings).toMatchObject({ mode: "image", imageModel: "gpt-image-2", size: "1024x1024" });
        harness.composer().props.generationControls.props.onChange({ mode: "video", size: "1:1" });
        expect(harness.composer().props.generationControls.props.settings.size).toBe("16:9");
    });

    test("keeps an explicit video tool ratio above the remembered video default", async () => {
        const harness = panelHarness({ replies: [tool("canvas_generate_video", { prompt: "花瓶旋转", size: "16:9" })] });
        await harness.submit("生成宽幅花瓶旋转视频");
        expect(harness.requests.find((request) => request.type === "video")?.args[0].size).toBe("16:9");
        expect(harness.composer().props.generationControls.props.settings.size).toBe("1152x1536");
    });

    test("freezes the default video ratio at submission while a tool awaits confirmation", async () => {
        const harness = panelHarness({ confirmTools: true, replies: [tool("canvas_generate_video", { prompt: "花瓶旋转" }), { content: "完成", toolCalls: [] }] });
        await harness.submit("生成花瓶旋转视频");
        const confirmation = harness.messages().find((message) => message.role === "tool" && message.detail?.status === "pending")!;
        harness.composer().props.generationControls.props.onChange({ mode: "video", size: "1:1" });
        harness.composer().props.generationControls.props.onChange({ size: "16:9" });
        harness.approve(confirmation.id);
        await waitFor(() => harness.requests.filter((request) => request.type === "agent").length === 2);
        expect(harness.requests.find((request) => request.type === "video")?.args[0].size).toBe("3:4");
        expect(harness.composer().props.generationControls.props.settings.size).toBe("16:9");
    });

    test("uses the video preset for a run_generation node without an explicit ratio", async () => {
        const harness = panelHarness({ replies: [tool("canvas_apply_ops", { ops: [{ type: "add_node", id: "video-config", nodeType: "config", metadata: { generationMode: "video", prompt: "花瓶旋转" } }, { type: "run_generation", nodeId: "video-config", mode: "video", prompt: "花瓶旋转" }] }), { content: "完成", toolCalls: [] }] });
        await harness.submit("创建视频节点并生成花瓶旋转视频");
        expect(harness.requests.map((request) => request.type)).toEqual(["agent", "video", "agent"]);
        expect(harness.requests[1].args[0].size).toBe("3:4");
        expect(harness.snapshotRef.current.nodes.find((node) => node.id === "video-config")?.metadata?.status).toBe("success");
    });

    test("does not silently drop an uploaded reference when the model returns an empty reference list", async () => {
        const harness = panelHarness({ replies: [tool("canvas_generate_image", { editIntent: "new", prompt: "保留原图主体，换成浅蓝背景", referenceNodeIds: [] }), { content: "改图完成", toolCalls: [] }] });
        await harness.uploadReference();
        await harness.submit("这张图只改背景");
        expect(harness.requests.map((request) => request.type)).toEqual(["agent", "edit", "agent"]);
        expect(harness.requests[1].args[2]).toHaveLength(1);
    });

    test("applies ordinary canvas operations without spending an image or video request", async () => {
        const harness = panelHarness({ replies: [tool("canvas_create_text_node", { text: "项目说明", title: "说明" }), { content: "说明已放入画布", toolCalls: [] }] });
        await harness.submit("在画布创建一个写着项目说明的文本节点");
        expect(harness.requests.map((request) => request.type)).toEqual(["agent", "agent"]);
        expect(harness.snapshotRef.current.nodes).toEqual([expect.objectContaining({ type: CanvasNodeType.Text, title: "说明", metadata: expect.objectContaining({ content: "项目说明" }) })]);
    });

    test("executes explicit run_generation operations once and waits for real outputs", async () => {
        const harness = panelHarness({ replies: [tool("canvas_apply_ops", { ops: [{ type: "add_node", id: "image-config", nodeType: "config", metadata: { generationMode: "image", prompt: "红色花瓶", count: 1, size: "1:1", quality: "1k" } }, { type: "run_generation", nodeId: "image-config", mode: "image", prompt: "红色花瓶" }] }), { content: "生成已完成", toolCalls: [] }] });
        await harness.submit("创建图片生成节点并立即执行");
        expect(harness.requests.map((request) => request.type)).toEqual(["agent", "image", "agent"]);
        expect(harness.requests[1].args[0]).toMatchObject({ count: "1", size: "1024x1024", quality: "auto" });
        expect(harness.snapshotRef.current.nodes.find((node) => node.id === "image-config")?.metadata?.status).toBe("success");
        expect(harness.snapshotRef.current.connections).toContainEqual(expect.objectContaining({ fromNodeId: "image-config", toNodeId: "generated-image" }));
    });

    test("preserves the original paused video task and stops the tool loop without resubmitting", async () => {
        const paused = new QueuedTaskPausedError({ id: "paused-video", requestId: "video-request", operationType: "video_generation", status: "paused", upstreamTaskId: "upstream-video", resultUrls: [], failureReason: "查询超时" });
        const harness = panelHarness({ replies: [tool("canvas_generate_video", { prompt: "红色花瓶旋转" }), tool("canvas_generate_video", { prompt: "不要再次生成" })], video: async () => { throw paused; } });
        await harness.submit("生成红色花瓶旋转视频");
        expect(harness.requests.map((request) => request.type)).toEqual(["agent", "video"]);
        expect(harness.messages().find((message) => message.role === "error")?.detail).toMatchObject({ status: "paused", taskId: "paused-video", canRecover: true, resubmitAllowed: false });
        expect(harness.messages().flatMap((message) => message.attachments || [])).toHaveLength(0);
        expect(harness.assets).toHaveLength(0);
        expect(harness.videoStores).toHaveLength(0);
    });

    test("Agent sends seven images instead of silently capping a configured GPT adapter at four", async () => {
        const harness = panelHarness({ config: { imageModel: "vcen-gpt2" }, replies: [tool("canvas_generate_image", { editIntent: "new", prompt: "红色花瓶七种构图", count: 7, quality: "4k", size: "3:4" })] });
        await harness.submit("生成七张红色花瓶构图");
        expect(harness.requests.find((request) => request.type === "image")?.args[0]).toMatchObject({ model: "vcen-gpt2", count: "7", quality: "4k", size: "3:4" });
    });

    test("keeps the user's image model when the planner asks to switch providers", async () => {
        const harness = panelHarness({ replies: [tool("canvas_generate_image", { editIntent: "new", model: "vcen-gpt2", prompt: "红色花瓶", count: 7, quality: "4k", size: "3:4" }), { content: "已完成", toolCalls: [] }] });
        await harness.submit("生成七张红色花瓶");
        expect(harness.requests.map((request) => request.type)).toEqual(["agent", "image", "agent"]);
        expect(harness.requests[1].args[0]).toMatchObject({ model: "gpt-image-2", count: "7", quality: "auto", size: "1152x1536" });
        expect(harness.assets[0].metadata).toMatchObject({ model: "gpt-image-2" });
    });

    test("rejects an image tool without edit intent before submitting or creating outputs", async () => {
        const harness = panelHarness({ replies: [tool("canvas_generate_image", { prompt: "绿色花瓶" })] });
        await harness.submit("生成绿色花瓶");
        expect(harness.requests.map((request) => request.type)).toEqual(["agent"]);
        const failure = harness.messages().find((message) => message.role === "tool" && message.detail?.status === "failed");
        expect(failure?.text).toContain("必须指定 editIntent");
        expect(harness.imageUploads).toHaveLength(0);
        expect(harness.assets).toHaveLength(0);
        expect(harness.snapshotRef.current.nodes).toHaveLength(0);
    });

    test("Midjourney preserves its supported image reference in the dispatched request", async () => {
        const harness = panelHarness({ config: { imageModel: "midjourney-v7" }, replies: [tool("canvas_generate_image", { editIntent: "new", prompt: "修改背景" })] });
        await harness.uploadReference();
        await harness.submit("用 Midjourney 修改这张图");
        const edit = harness.requests.find((request) => request.type === "edit");
        expect(edit?.args[0]).toMatchObject({ model: "midjourney-v7", count: "1" });
        expect(edit?.args[2]).toHaveLength(1);
        expect(edit?.args[2][0]).toMatchObject({ name: "uploaded-reference.png" });
    });

    test("Midjourney Blend uses two references, one output, speed, and no fabricated prompt", async () => {
        const selected: CanvasNodeData = { id: "selected-reference", type: CanvasNodeType.Image, title: "原款", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "data:image/png;base64,cmVm", status: "success" } };
        const harness = panelHarness({ config: { imageModel: "midjourney-blend" }, selected: [selected], replies: [tool("canvas_generate_image", { editIntent: "new", count: 8, quality: "turbo" })] });
        await harness.uploadReference();
        await harness.submit("用 Blend 合成这两张图");
        const edit = harness.requests.find((request) => request.type === "edit");
        expect(edit?.args[0]).toMatchObject({ model: "midjourney-blend", count: "1", quality: "turbo" });
        expect(edit?.args[1]).toBe("");
        expect(edit?.args[2]).toHaveLength(2);
    });

    test("adds completed images to assets using the same local media and original server identity", async () => {
        const serverAssetId = "7075c394-1184-44cc-9077-068d78e8b36d";
        const url = `/api/assets/${serverAssetId}/content`;
        const harness = panelHarness({ replies: [tool("canvas_generate_image", { editIntent: "new", prompt: "绿色花瓶" })], generate: async () => [{ id: "green-vase", dataUrl: url }], storedImage: { url: "blob:cached-image", storageKey: "image:cached", width: 1024, height: 1024, bytes: 12345, mimeType: "image/png" } });
        await harness.submit("生成绿色花瓶");
        expect(harness.imageUploads).toEqual([url]);
        expect(harness.assets).toHaveLength(1);
        expect(harness.assets[0]).toMatchObject({ kind: "image", data: { dataUrl: "blob:cached-image", storageKey: "image:cached", width: 1024, height: 1024, bytes: 12345 }, metadata: { serverAssetId, nodeId: "green-vase", projectId: "project", prompt: "绿色花瓶", model: "gpt-image-2" } });
        expect(serverAssetIdFromAsset(harness.assets[0])).toBe(serverAssetId);
    });

    test("persists an Agent video once and shares its true dimensions and server identity with canvas and assets", async () => {
        const serverAssetId = "7075c394-1184-44cc-9077-068d78e8b36d";
        const url = `/api/assets/${serverAssetId}/content`;
        const harness = panelHarness({ replies: [tool("canvas_generate_video", { prompt: "花瓶缓慢旋转" })], video: async () => ({ url, mimeType: "video/mp4" }), storedVideo: { url: "blob:cached-video", storageKey: "video:cached", width: 768, height: 768, bytes: 2048, mimeType: "video/mp4", serverAssetId } });
        await harness.submit("生成视频");
        expect(harness.videoStores).toEqual([{ url, mimeType: "video/mp4" }]);
        expect(harness.assets).toHaveLength(1);
        expect(harness.assets[0]).toMatchObject({ kind: "video", data: { url: "blob:cached-video", storageKey: "video:cached", width: 768, height: 768 }, metadata: { serverAssetId, prompt: "花瓶缓慢旋转" } });
        expect(harness.snapshotRef.current.nodes.find((node) => node.type === CanvasNodeType.Video)).toMatchObject({ width: 340, height: 340, metadata: { content: "blob:cached-video", storageKey: "video:cached" } });
        expect(harness.messages().flatMap((message) => message.attachments || [])).toContainEqual(expect.objectContaining({ storageKey: "video:cached", width: 768, height: 768, serverAssetId }));
    });

    test("restores historical blob references through their storage keys and only backfills missing keys", () => {
        const node: CanvasNodeData = { id: "vase", type: CanvasNodeType.Image, title: "花瓶", position: { x: 0, y: 0 }, width: 340, height: 340, metadata: { content: "blob:current", storageKey: "image:node-key" } };
        const history: CanvasAssistantMessage[] = [{ id: "message", role: "user", text: "看看参考图", references: [
            { id: "vase", type: CanvasNodeType.Image, title: "旧参考", dataUrl: "blob:expired" },
            { id: "vase", type: CanvasNodeType.Image, title: "有独立存储的参考", dataUrl: "blob:earlier", storageKey: "image:historical-key" },
            { id: "vase", type: CanvasNodeType.Image, title: "内嵌原图", dataUrl: "data:image/png;base64,b3JpZ2luYWw=" },
        ] }];
        const harness = panelHarness({ replies: [], selected: [node], history });
        const previews = harness.referencePreviews();
        expect(previews).toHaveLength(3);
        expect(previews[0]).toMatchObject({ url: "blob:expired", storageKey: "image:node-key" });
        expect(previews[1]).toMatchObject({ storageKey: "image:historical-key" });
        expect(previews[2].storageKey).toBeUndefined();
        expect(history[0].references![0].storageKey).toBeUndefined();
    });

    test("consumes a confirmation once and keeps it running during same-tick duplicate approval", async () => {
        let finish!: (items: Array<{ id: string; dataUrl: string }>) => void;
        const generated = new Promise<Array<{ id: string; dataUrl: string }>>((resolve) => { finish = resolve; });
        const harness = panelHarness({ confirmTools: true, replies: [tool("canvas_generate_image", { editIntent: "new", prompt: "绿色花瓶" }), { content: "完成", toolCalls: [] }], generate: () => generated });
        await harness.submit("生成绿色花瓶");
        const confirmation = harness.messages().find((message) => message.detail?.status === "pending")!;
        const approve = harness.approvalHandler();
        approve(confirmation.id);
        approve(confirmation.id);
        await waitFor(() => harness.requests.some((request) => request.type === "image"));
        const runningStatus = harness.messages().find((message) => message.id === confirmation.id)?.detail?.status;
        const prematureFailure = harness.messages().some((message) => message.text.includes("工具上下文不完整"));
        const submittedCount = harness.requests.filter((request) => request.type === "image").length;
        finish([{ id: "green-vase", dataUrl: "/api/assets/green-vase/content" }]);
        await waitFor(() => harness.requests.filter((request) => request.type === "agent").length === 2);
        expect(submittedCount).toBe(1);
        expect(prematureFailure).toBe(false);
        expect(runningStatus).toBe("running");
        expect(harness.requests.filter((request) => request.type === "image")).toHaveLength(1);
    });
});
