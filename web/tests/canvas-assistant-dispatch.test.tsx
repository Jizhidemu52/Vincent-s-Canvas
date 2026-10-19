import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type DependencyList, type EffectCallback, type ReactElement } from "react";
import ts from "typescript";

import * as configModule from "@/stores/use-config-store";
import { applyCanvasAgentOps, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { CanvasNodeType, type CanvasAssistantMessage, type CanvasAssistantSession, type CanvasNodeData } from "@/types/canvas";
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
import { createAgentMediaWorkflow } from "@/lib/canvas/agent-media-workflow";
import { CanvasEditContractError } from "@/lib/canvas/canvas-image-edit-contract";

const requireModule = createRequire(new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url));
const requireToolConfigModule = createRequire(new URL("../src/hooks/use-tool-config.ts", import.meta.url));
const source = readFileSync(new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const toolConfigCode = ts.transpileModule(readFileSync(new URL("../src/hooks/use-tool-config.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;

function panelHarness(options: { replies: ToolResponseResult[]; stream?: string; translate?: () => Promise<string>; config?: Partial<configModule.AiConfig>; flags?: Partial<Record<ModuleKey, boolean>>; tools?: BusinessConfig["tools"]; models?: BusinessConfig["models"]; imageCapabilities?: BusinessConfig["models"]; standalone?: boolean; selected?: CanvasNodeData[]; nodes?: CanvasNodeData[]; history?: CanvasAssistantMessage[]; confirmTools?: boolean; generate?: () => Promise<Array<{ id: string; dataUrl: string }>>; video?: () => Promise<{ url: string; mimeType: string }>; storedImage?: UploadedImage; storedVideo?: UploadedFile }) {
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
        models: options.models || [
            { id: "text-model", name: config.textModel, modelId: config.textModel, capabilities: ["chat"], creditCost: 0, rmbCost: 0 },
            { id: "image-model", name: config.imageModel, modelId: config.imageModel, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
            { id: "video-model", name: config.videoModel, modelId: config.videoModel, capabilities: ["video"], creditCost: 0, rmbCost: 0 },
        ], prices: [], tools: options.tools || [],
    };
    if (!business.tools.some(item => item.toolKey === "gpt-chat")) business.tools = [
        ...business.tools,
        { toolKey: "gpt-chat", modelConfigId: business.models.find(model => model.capabilities.includes("chat"))?.id || null, enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 },
    ];
    const businessState = { ...business, status: "ready" as const, refresh: async () => undefined };
    let sessions: CanvasAssistantSession[] = options.history ? [{ id: "history", title: "History", createdAt: "2026-09-06", updatedAt: "2026-09-06", messages: options.history }] : [];
    let activeSessionId: string | null = null;
    const sessionCommits: Array<{ sessions: CanvasAssistantSession[]; activeId: string | null }> = [];
    const sessionUpdates: Array<{ sessions: CanvasAssistantSession[]; activeId: string | null }> = [];
    let commitGate: Promise<void> | undefined;
    let replyGate: Promise<void> | undefined;
    const onSessionsChange = (sessions: CanvasAssistantSession[], activeId: string | null, settings?: { flush: boolean }) => {
        sessionUpdates.push({ sessions, activeId });
        if (!settings?.flush) return;
        sessionCommits.push({ sessions, activeId });
        return commitGate;
    };
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
        "@/lib/standalone-edition": { standaloneEdition: options.standalone || false },
        "@/stores/use-theme-store": { useThemeStore: (selector: (state: unknown) => unknown) => selector({ theme: "light" }) },
        "@/stores/use-user-store": { useUserStore: (selector: (state: unknown) => unknown) => selector({ user: null }) },
        "@/stores/use-asset-store": { serverAssetIdFromAsset, useAssetStore: (selector: (state: unknown) => unknown) => selector({ cleanupImages: () => undefined, addAssets: (items: AssetInput[]) => { assets.push(...items); return items.map((_, index) => `asset-${index}`); } }) },
        "@/stores/canvas/use-canvas-agent-store": { useCanvasAgentStore: (selector: (state: unknown) => unknown) => selector({ confirmTools: options.confirmTools || false, setAgentState: () => undefined }) },
        "@/hooks/use-can-manage-config": { useCanManageConfig: () => false },
        "@/stores/use-module-store": { isModuleAvailable, useModuleEnabled: (key: ModuleKey) => isModuleAvailable(flags, business.tools, key), useModuleStore: (selector: (state: unknown) => unknown) => selector({ flags, status: "ready" }) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: Object.assign((selector: (state: typeof businessState) => unknown) => selector(businessState), { getState: () => businessState }) },
        "@/services/api/tool-runtime": { ...toolRuntime, resolveToolConfig: async (config: configModule.AiConfig, operation: string, key?: string) => {
            const toolKey = toolRuntime.requireToolKey(operation, key);
            const resolved = toolRuntime.applyToolModel(config, business, toolKey);
            return { toolKey, config: resolved, model: toolRuntime.resolveConfiguredToolModel(business, toolKey, resolved.model) };
        } },
        "@/services/api/generation-tasks": {
            ...generationTasks,
            getImageGenerationModels: async () => {
                capabilityRequests.push("image");
                return options.imageCapabilities || [{ id: "image-model", name: config.imageModel, modelId: config.imageModel, capabilities: ["generate"], creditCost: 0, rmbCost: 0 }];
            },
            getGenerationCapabilities: async () => {
                capabilityRequests.push("video");
                return { models: [{ id: "video-model", name: config.videoModel, modelId: config.videoModel, capability: { seconds: [1, 10], resolutions: ["720P", "1080P"], sizes: ["1:1", "3:4", "16:9"], minImages: 0, maxImages: 9, firstFrameRequired: false, supportsAudio: true } }] };
            },
        },
        "@/services/api/image": {
            toolResponseToInput,
            requestToolResponse: async (...args: any[]) => { requests.push({ type: "agent", args }); if (options.stream) args[4]?.(options.stream); await replyGate; return options.replies.shift() || { content: "没有更多调用", toolCalls: [] }; },
            requestImageQuestion: async (...args: any[]) => { requests.push({ type: "text", args }); return options.translate ? options.translate() : "refined prompt"; },
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
    new Function("require", "module", "exports", toolConfigCode)((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireToolConfigModule(name), toolConfigModule, toolConfigModule.exports);
    dependencies["@/hooks/use-tool-config"] = toolConfigModule.exports;
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code)((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name), module, module.exports);
    const render = () => {
        stateIndex = refIndex = memoIndex = effectIndex = 0;
        const element = module.exports.CanvasAssistantPanel({
            selectedNodeIds: new Set(snapshotRef.current.selectedNodeIds), selectedNodes: options.selected || [], snapshotRef,
            sessions, activeSessionId, onSelectNodeIds: () => undefined, onSessionsChange,
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
        requests, config, snapshotRef, composer, messages, assets, imageUploads, videoStores, capabilityRequests, sessionCommits, sessionUpdates,
        pauseCommit(gate: Promise<void>) { commitGate = gate; },
        pauseReply(gate: Promise<void>) { replyGate = gate; },
        newChat() { findElements(render()).find(element => element.props.title === "新对话")!.props.children.props.onClick(); },
        echoCommit() { const committed = sessionCommits.at(-1)!; sessions = committed.sessions; activeSessionId = committed.activeId; render(); },
        sessionIds: () => states.flatMap(value => Array.isArray(value) ? value.filter(item => Array.isArray(item?.messages)).map(item => item.id) : []),
        workflowCards: () => findElements(render()).filter((element) => typeof element.type === "function" && element.type.name === "CanvasAgentMediaWorkflowCard").map((element) => element.props),
        select(nodes: CanvasNodeData[]) {
            options.selected = nodes;
            snapshotRef.current = { ...snapshotRef.current, selectedNodeIds: nodes.map((node) => node.id) };
            render();
        },
        toggleContext() { findElements(render()).find((element) => element.type === "button" && typeof element.props["aria-pressed"] === "boolean")!.props.onClick(); },
        referenceTray() {
            return findElements(composer().props.attachmentPreview).find(element => typeof element.props.onMove === "function")!.props;
        },
        displayedMessages() {
            return findElements(render()).filter(element => typeof element.type === "object" && element.props.item).map(element => element.props.item as CanvasAssistantMessage);
        },
        referencePreviews() {
            const rows = findElements(render()).filter((element) => typeof element.type === "function" && element.type.name === "MessageReferences");
            const chips = rows.flatMap((element) => findElements((element.type as Function)(element.props))).filter((element) => typeof element.type === "function" && element.type.name === "AssistantReferenceChip");
            return chips.flatMap((element) => findElements((element.type as Function)(element.props))).filter((element) => typeof element.type === "function" && element.type.name === "CanvasPersistedMediaPreview").map((element) => element.props);
        },
        async ready() { await waitFor(() => !composer().props.disabled); },
        async submit(prompt: string) {
            await waitFor(() => !composer().props.disabled);
            const references = findElements(composer().props.attachmentPreview).find(element => typeof element.props.onMove === "function")?.props.references || [];
            // Populate ordinary mocked planner replies with the new contract. Explicit test contracts (including null) stay untouched.
            for (const reply of options.replies) for (const call of reply.toolCalls) if (call.function.name === "canvas_generate_image") {
                const args = JSON.parse(call.function.arguments);
                if (!("editContract" in args)) {
                    const text = typeof args.prompt === "string" && !/[\u3400-\u9fff]/u.test(args.prompt) ? args.prompt : "refined prompt";
                    args.editContract = { mode: "complete", changes: [], preserve: [{ id: "fixture", text, source: prompt }], forbid: [], supersedes: [], referenceRoles: references.map((ref: any) => ({ id: ref.id, role: "reference" })) };
                    call.function.arguments = JSON.stringify(args);
                }
            }
            composer().props.onPromptChange(prompt); await composer().props.onSubmit();
        },
        approve(messageId: string) { findElements(render()).find((element) => typeof element.props.onApproveTool === "function")!.props.onApproveTool(messageId); },
        approvalHandler() { return findElements(render()).find((element) => typeof element.props.onApproveTool === "function")!.props.onApproveTool as (messageId: string) => void; },
        async uploadReference(name = "uploaded-reference.png", dataUrl = "data:image/png;base64,dXBsb2FkZWQtcmVmZXJlbmNl") {
            const original = globalThis.FileReader;
            class Reader {
                result = dataUrl;
                onload?: () => void;
                readAsDataURL() { this.onload?.(); }
            }
            globalThis.FileReader = Reader as unknown as typeof FileReader;
            try { await composer().props.onAddFiles([new File(["reference"], name, { type: "image/png" })]); }
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
    test("workflow cards use server capability identities and binding restrictions, not stale local models", () => {
        const imageId = "d5000000-0000-4000-8000-000000000001";
        const videoId = "d5000000-0000-4000-8000-000000000005";
        const models = [
            { id: imageId, modelId: imageId, name: "aplmart-gpt2.5-flare", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
            { id: "second-image", modelId: "second-image", name: "Second image", capabilities: ["generate"], creditCost: 0, rmbCost: 0 },
            { id: videoId, modelId: videoId, name: "aplmart-happyhorse1.1", capabilities: ["video"], creditCost: 0, rmbCost: 0 },
            { id: "mark-chat", modelId: "mark-chat", name: "aplmart-gpt6-astra", capabilities: ["chat"], creditCost: 0, rmbCost: 0 },
        ];
        const workflow = createAgentMediaWorkflow({ intent: "image_to_video", prompt: "workflow", imageModel: imageId, videoModel: videoId, imageCount: 1, aspectRatio: "1:1" });
        const history: CanvasAssistantMessage[] = [{ id: "workflow", role: "assistant", text: "workflow", detail: { mediaWorkflow: workflow } }];
        const available = panelHarness({ replies: [], models, history }).workflowCards()[0];
        expect(available.imageModels).toEqual([imageId, "second-image"]);
        expect(available.videoModels).toEqual([videoId]);
        const restricted = panelHarness({ replies: [], models, history, tools: [
            { toolKey: "canvas-image", modelConfigId: imageId, enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 },
            { toolKey: "canvas-video", modelConfigId: null, enabled: false, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 },
        ] }).workflowCards()[0];
        expect(restricted.imageModels).toEqual([imageId]);
        expect(restricted.videoModels).toEqual([]);
        const empty = panelHarness({ replies: [], models: [], history }).workflowCards()[0];
        expect(empty.imageModels).toEqual([]);
        expect(empty.videoModels).toEqual([]);
    });

    test("selection never exposes internal image prompts, changes presets, or replaces a same-image user draft", async () => {
        const first: CanvasNodeData = { id: "first", type: CanvasNodeType.Image, title: "第一张", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "blob:first", prompt: "第一张原始提示词", model: "unrelated-model" } };
        const second = { ...first, id: "second", metadata: { content: "blob:second", prompt: "第二张原始提示词" } };
        const harness = panelHarness({ selected: [first], replies: [] });
        await harness.ready();
        expect(harness.composer().props.prompt).toBe("");
        const settings = harness.composer().props.generationControls.props.settings;
        harness.composer().props.onPromptChange("用户正在修改的文字");
        harness.select([{ ...first, position: { x: 99, y: 99 }, metadata: { ...first.metadata, prompt: "后台更新" } }]);
        expect(harness.composer().props.prompt).toBe("用户正在修改的文字");
        harness.select([second]);
        expect(harness.composer().props.prompt).toBe("");
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
        expect(harness.composer().props.generationControls.props.settings).toMatchObject({ imageModel: "gpt-image-2", size: "1152x1536", quality: "auto", imageCount: "1" });
        expect(harness.requests).toHaveLength(0);
    });

    test("capability loading resolves APIMart GPT2 for a new composer and retains a valid saved image model", async () => {
        const models = [
            { id: "first", modelId: "first", name: "gpt-image-2", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
            { id: "mark-gpt2", modelId: "mark-gpt2", name: "aplmart-gpt2", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
        ];
        for (const [saved, expected] of [[configModule.defaultConfig.imageModel, "mark-gpt2"], ["first", "first"], ["removed", "mark-gpt2"]]) {
            const harness = panelHarness({ replies: [], config: { imageModel: saved }, models: [...models, { id: "text-model", modelId: "text-model", name: "Text model", capabilities: ["chat"], creditCost: 0, rmbCost: 0 }], imageCapabilities: models });
            await harness.ready();
            expect(harness.composer().props.generationControls.props.settings.imageModel).toBe(expected);
            expect(harness.requests).toHaveLength(0);
        }
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

    test("keeps a completed reply busy until the latest user and assistant messages finish persisting", async () => {
        const saved = Promise.withResolvers<void>();
        const harness = panelHarness({ replies: [{ content: "完整回复必须保存", toolCalls: [] }] });
        harness.pauseCommit(saved.promise);
        let completed = false;
        const submitted = harness.submit("请保留问题和回复").then(() => { completed = true; });
        await waitFor(() => harness.sessionCommits.length === 1);
        expect(JSON.stringify(harness.sessionCommits[0])).toContain("请保留问题和回复");
        expect(JSON.stringify(harness.sessionCommits[0])).toContain("完整回复必须保存");
        expect(harness.composer().props.sending).toBe(true);
        expect(completed).toBe(false);
        saved.resolve();
        await submitted;
        expect(harness.composer().props.sending).toBe(false);
        expect(harness.sessionUpdates.at(-1)?.activeId).toBe(harness.sessionCommits[0].activeId);
    });

    test("failed conversation storage preserves the visible reply and explicitly warns that it is not saved", async () => {
        const harness = panelHarness({ replies: [{ content: "暂未落盘的回复", toolCalls: [] }] });
        const failed = Promise.withResolvers<void>();
        harness.pauseCommit(failed.promise);
        const submitted = harness.submit("保存失败测试");
        await waitFor(() => harness.sessionCommits.length === 1);
        failed.reject(new Error("disk full"));
        await submitted;
        expect(harness.messages().some(message => message.text === "暂未落盘的回复")).toBe(true);
        expect(harness.messages().some(message => message.title === "对话尚未保存")).toBe(true);
        expect(harness.composer().props.sending).toBe(false);
    });

    test("finishing an older request preserves the conversation selected while it was running", async () => {
        const reply = Promise.withResolvers<void>();
        const harness = panelHarness({ replies: [{ content: "原会话回复", toolCalls: [] }] });
        harness.pauseReply(reply.promise);
        const submitted = harness.submit("原会话问题");
        await waitFor(() => harness.requests.some(request => request.type === "agent"));
        harness.newChat();
        reply.resolve();
        await submitted;
        const committed = harness.sessionCommits[0];
        const selected = (committed.sessions as Array<{ id: string; messages: CanvasAssistantMessage[] }>).find(session => session.id === committed.activeId);
        expect(selected?.messages).toEqual([]);
        expect(JSON.stringify(committed.sessions)).toContain("原会话回复");
    });

    test("a completed-turn parent echo does not overwrite a new conversation opened while saving", async () => {
        const saved = Promise.withResolvers<void>();
        const harness = panelHarness({ replies: [{ content: "已返回的完整回复", toolCalls: [] }] });
        harness.pauseCommit(saved.promise);
        const submitted = harness.submit("测试完成提交的父回声");
        await waitFor(() => harness.sessionCommits.length === 1);
        harness.newChat();
        const newerIds = harness.sessionIds();
        expect(newerIds).toHaveLength(2);
        harness.echoCommit();
        expect(harness.sessionIds()).toEqual(newerIds);
        expect(harness.messages().some(message => message.text === "已返回的完整回复")).toBe(true);
        saved.resolve();
        await submitted;
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
        expect(harness.requests.find((request) => request.type === "image")?.args[0]).toMatchObject({ model: "gpt-image-2", count: "1", size: "1152x1536", quality: "auto" });
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
        expect(edit?.args[1]).toContain("refined prompt");
        expect(edit?.args[4]).toMatchObject({ referencePromptLanguage: "en" });
        expect(edit?.args[2]).toHaveLength(2);
        expect(edit?.args[2]).toContainEqual(expect.objectContaining({ id: "selected-reference", storageKey: "stored-reference-key" }));
        expect(edit?.args[2]).toContainEqual(expect.objectContaining({ name: "uploaded-reference.png", dataUrl: "data:image/png;base64,dXBsb2FkZWQtcmVmZXJlbmNl" }));
        expect(harness.messages().some((message) => message.attachments?.length && message.text.includes(edit!.args[1]))).toBe(false);
        expect(harness.messages().find(message => message.attachments?.length)?.detail?.prompt).toBe(edit?.args[1]);
    });

    test("one draft order controls mixed image previews, numbered chat evidence and frozen edit input", async () => {
        const selected: CanvasNodeData = { id: "selected", type: CanvasNodeType.Image, title: "原款", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "data:image/png;base64,c2VsZWN0ZWQ=", status: "success" } };
        const orderedCall = tool("canvas_generate_image", { editIntent: "new", prompt: "Use the bound references for print and shape. Preserve all other details." });
        const harness = panelHarness({ selected: [selected], confirmTools: true, replies: [orderedCall, { content: "已调整图案，版型保持不变。", toolCalls: [] }] });
        await harness.uploadReference("print.png", "data:image/png;base64,cHJpbnQ=");
        const first = harness.referenceTray();
        expect(first.thumbnailSize).toBe(96);
        first.onMove(first.references[1].id, first.references[0].id);
        expect(harness.referenceTray().references.map((reference: any) => reference.name)).toEqual(["print.png", "原款"]);
        await harness.uploadReference("color.png", "data:image/png;base64,Y29sb3I=");
        const withThird = harness.referenceTray();
        expect(withThird.references.map((reference: any) => reference.name)).toEqual(["print.png", "原款", "color.png"]);
        withThird.onRemove(withThird.references[2].id);
        const submittedIds = harness.referenceTray().references.map((reference: any) => reference.id);
        orderedCall.toolCalls[0]!.function.arguments = JSON.stringify({ editIntent: "new", prompt: "Use the bound references.", editContract: { mode: "complete", changes: [{ id: "print", text: `Use [[ref:${submittedIds[0]}]] for the print on [[ref:${submittedIds[1]}]].`, source: "按图1的花型改图2的衣服" }], preserve: [{ id: "rest", text: "All other details.", source: "其他不变" }], forbid: [], supersedes: [], referenceRoles: [{ id: submittedIds[0], role: "pattern" }, { id: submittedIds[1], role: "shape" }] } });
        await harness.submit("按图1的花型改图2的衣服，其他不变");
        const sent = harness.messages().find(message => message.role === "user")!;
        expect(sent.references?.map(reference => reference.id)).toEqual(submittedIds);
        const input = harness.requests[0].args[1].at(-1).content;
        expect(input.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url)).toEqual(["data:image/png;base64,cHJpbnQ=", "data:image/png;base64,c2VsZWN0ZWQ="]);
        expect(input.find((part: any) => part.text?.includes("本轮图片1 ·"))?.text).toContain("print.png");
        expect(input.find((part: any) => part.text?.includes("本轮图片2 ·"))?.text).toContain("原款");
        // New draft uploads cannot alter the pending turn's frozen references.
        await harness.uploadReference("later.png", "data:image/png;base64,bGF0ZXI=");
        const pending = harness.messages().find(message => message.detail?.status === "pending")!;
        harness.approve(pending.id);
        await waitFor(() => harness.requests.some(request => request.type === "edit"));
        const actual = harness.requests.find(request => request.type === "edit")!;
        expect(actual.args[2].map((reference: any) => reference.id)).toEqual(submittedIds);
        expect(actual.args[1]).toContain("Use Image 1 for the print on Image 2.");
        expect(harness.requests.filter(request => request.type === "text")).toHaveLength(0);
    });

    test("Chinese requests produce internal English instructions without exposing tool thoughts or full prompts", async () => {
        const internal = "Preserve the sweater silhouette, change only the background to pale blue.";
        const call = tool("canvas_generate_image", { editIntent: "new", prompt: internal });
        call.content = "INTERNAL_TOOL_THOUGHT do not show this";
        const harness = panelHarness({ stream: "<think>INTERNAL_STREAM_THOUGHT</think>", replies: [call, { content: `已将背景改为浅蓝，衣服保持不变。\n${internal}`, toolCalls: [] }] });
        await harness.submit("背景换成浅蓝，衣服不变");
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "image", "agent"]);
        const generation = harness.messages().find(message => message.attachments?.length)!;
        expect(generation.detail?.prompt).toContain(internal);
        expect(generation.detail?.imageEdit).toMatchObject({ editPrompt: generation.detail?.prompt });
        expect(generation.text).not.toContain(internal);
        expect(JSON.stringify(harness.messages())).not.toContain("INTERNAL_");
        const visible = harness.displayedMessages();
        expect(visible.some(message => message.text === "已将背景改为浅蓝，衣服保持不变。")).toBe(true);
        expect(visible.some(message => message.role === "tool")).toBe(false);
        expect(JSON.stringify(visible)).not.toContain(internal);
        expect(harness.requests[0].args[1][0].content).toContain("内部完整生成提示词必须使用英文");
    });

    test.each([null, { mode: "complete", changes: [{ id: "background", text: "仍然是中文提示词", source: "背景换成浅蓝" }], preserve: [], forbid: [], supersedes: [], referenceRoles: [] }])("invalid or non-English contract never submits or spends a translation retry", async (editContract) => {
        const harness = panelHarness({ replies: [tool("canvas_generate_image", { editIntent: "new", prompt: "只改成浅蓝背景，保留衣服的全部细节", editContract })] });
        await harness.submit("背景换成浅蓝");
        expect(harness.requests.map(request => request.type)).toEqual(["agent"]);
        expect(harness.assets).toHaveLength(0);
        expect(harness.messages().some(message => message.text.includes("尚未提交图片生成"))).toBe(true);
        expect(harness.displayedMessages().some(message => message.text.includes("尚未提交图片生成"))).toBe(true);
    });

    test.each(["针织棉面料", "cotton knit fabric"])("planner receives source-copy guidance and rejects %s without a paid repair or image submission", async source => {
        const editContract = { mode: "complete", changes: [{ id: "knit_material", text: "Use cotton knit fabric.", source }], preserve: [], forbid: [], supersedes: [], referenceRoles: [] };
        const harness = panelHarness({ replies: [tool("canvas_generate_image", { editIntent: "new", prompt: "Use cotton knit fabric.", editContract })] });
        await harness.submit("把材质改成棉质针织。");
        expect(harness.requests.map(request => request.type)).toEqual(["agent"]);
        expect(harness.assets).toHaveLength(0);
        expect(harness.imageUploads).toHaveLength(0);
        expect(harness.displayedMessages().some(message => message.text.includes("尚未提交图片生成"))).toBe(true);
        expect(JSON.stringify(harness.displayedMessages())).not.toContain("knit_material 的 source");
        expect(JSON.stringify(harness.messages().filter(message => message.role === "tool"))).toContain("knit_material 的 source 不是已提供的用户要求原文");
        const planner = harness.requests[0];
        expect(planner.args[1][0].content).toContain("逐字复制允许来源中的连续原文片段，禁止翻译、改写、重排");
        expect(planner.args[1][0].content).toContain("新任务只能引用本轮用户需求");
        expect(planner.args[1][0].content).toContain("不能把整段需求复制给每一项");
        const schema = planner.args[2].find((item: any) => item.function.name === "canvas_generate_image").function.parameters.properties.editContract;
        for (const group of ["changes", "preserve", "forbid"]) {
            const description = schema.properties[group].items.properties.source.description;
            expect(description).toContain("verbatim contiguous excerpt from the current user request");
            expect(description).toContain("Do not translate, paraphrase, reorder");
            expect(description).toContain("not the whole request as a blanket justification");
        }
    });

    test.each(["stale-number", "missing-count", "lost-negation"])("contract guard blocks %s before provider dispatch and translation", async kind => {
        const selected: CanvasNodeData = { id: "shirt", type: CanvasNodeType.Image, title: "shirt", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "data:image/png;base64,ORIGINAL" } };
        const user = kind === "lost-negation" ? "不要添加口袋，只生成1张" : "只生成1张，保留七颗纽扣";
        const editContract = { mode: "complete", changes: kind === "lost-negation" ? [{ id: "pockets", text: "Add pockets.", source: "不要添加口袋" }] : [], preserve: kind === "lost-negation" ? [] : [{ id: "buttons", text: kind === "missing-count" ? "The cream buttons." : "Seven cream buttons.", source: "保留七颗纽扣" }], forbid: [], supersedes: [], referenceRoles: [{ id: "shirt", role: "base" }] };
        const harness = panelHarness({ selected: [selected], replies: [tool("canvas_generate_image", { editIntent: "new", prompt: kind === "stale-number" ? "Use Image 3 for color." : "Edit the shirt.", editContract })] });
        await harness.submit(user);
        expect(harness.requests.map(request => request.type)).toEqual(["agent"]);
        expect(harness.assets).toHaveLength(0);
        expect(harness.imageUploads).toHaveLength(0);
        expect(harness.messages().some(message => message.role === "tool" && message.detail?.status === "failed")).toBe(true);
    });

    test("correction dispatch after reload uses original pixels and all current requested targets", async () => {
        const original = { id: "shirt", type: CanvasNodeType.Image, title: "shirt", dataUrl: "data:image/png;base64,ORIGINAL" };
        const contract = { changes: [{ id: "fabric", text: "Make the shirt pink.", source: "衬衫改粉色" }], preserve: [{ id: "buttons", text: "Seven cream buttons.", source: "保留七颗米白纽扣" }], forbid: [] };
        const history: CanvasAssistantMessage[] = [{ id: "pink", role: "assistant", text: "已生成（不代表验收）", detail: { status: "completed", imageEdit: { intent: "new", originalReferences: [original], originalPrompt: "衬衫改粉色，保留七颗米白纽扣", editPrompt: "Make the shirt pink.", baseReferences: [original], contract } }, attachments: [{ id: "pink", mediaType: "image", name: "pink", url: "data:image/png;base64,PINK" }] }];
        const editContract = { mode: "update", changes: [{ id: "buttons", text: "Make the seven buttons burgundy.", source: "七颗纽扣改酒红" }], preserve: [], forbid: [], supersedes: ["buttons"], referenceRoles: [{ id: "edit-original-0", role: "base" }] };
        const harness = panelHarness({ history: JSON.parse(JSON.stringify(history)), replies: [tool("canvas_generate_image", { editIntent: "correct_original", prompt: "Fix the buttons.", referenceNodeIds: ["pink"], editContract }), { content: "已更新。", toolCalls: [] }] });
        await harness.submit("粉色不变，七颗纽扣改酒红，只生成1张");
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "edit", "agent"]);
        // Verify the real planner request receives delta guidance, not merely a disconnected exported constant.
        const planner = harness.requests.find(request => request.type === "agent")!;
        expect(planner.args[1][0].content).toContain("完全未变条件必须省略，由代码继承");
        const schema = planner.args[2].find((item: any) => item.function.name === "canvas_generate_image").function.parameters.properties.editContract;
        expect(schema.properties.mode.description).toContain("update is a delta");
        for (const group of ["changes", "preserve", "forbid"]) expect(schema.properties[group].description).toContain("Omit unchanged ids");
        const edit = harness.requests.find(request => request.type === "edit")!;
        expect(edit.args[2][0].dataUrl).toBe(original.dataUrl);
        expect(edit.args[1]).toContain("Make the shirt pink.");
        expect(edit.args[1]).toContain("Make the seven buttons burgundy.");
        expect(edit.args[1]).not.toContain("Seven cream buttons.");
        const saved = harness.messages().filter(message => message.attachments?.length).at(-1)!;
        expect((saved.detail?.imageEdit as any).contract.changes).toHaveLength(2);
        expect(JSON.stringify((saved.detail?.imageEdit as any).contract)).not.toMatch(/approved|accepted/);
    });

    const repeatOriginal = { id: "shirt", type: CanvasNodeType.Image, title: "shirt", dataUrl: "data:image/png;base64,ORIGINAL" };
    const repeatGoal = { changes: [{ id: "pink", text: "Make the shirt pink.", source: "衬衫改粉色" }], preserve: [], forbid: [] };
    const repeatHistory = (saved = false): CanvasAssistantMessage[] => [
        { id: "initial-user", role: "user", text: "衬衫改粉色" },
        { id: "pink-result", role: "assistant", text: "已生成", detail: { status: "completed", imageEdit: { intent: "new", originalReferences: [repeatOriginal], originalPrompt: "衬衫改粉色", editPrompt: "Make the shirt pink.", baseReferences: [repeatOriginal], ...(saved ? { contract: repeatGoal } : {}) } }, attachments: [{ id: "pink", mediaType: "image", name: "pink", url: "data:image/png;base64,PINK" }] },
    ];
    const repeatCall = (mode: "complete" | "update", editIntent = "correct_original", patch: Record<string, unknown> = {}) => tool("canvas_generate_image", {
        editIntent, prompt: "Make the shirt pink.",
        editContract: { mode, ...(mode === "complete" ? repeatGoal : { changes: [], preserve: [], forbid: [] }), supersedes: [], referenceRoles: [{ id: "edit-original-0", role: "base" }] }, ...patch,
    });

    test("legacy repeat repairs only the preflight mode once, then submits exactly one image and ends", async () => {
        const failed = repeatCall("update"), repaired = repeatCall("complete");
        failed.responsesOutputItems = [{ type: "reasoning", id: "opaque-original", encrypted_content: "opaque-proof" }, { type: "function_call", call_id: failed.toolCalls[0].id, name: "canvas_generate_image", arguments: failed.toolCalls[0].function.arguments }];
        const harness = panelHarness({ history: repeatHistory(), replies: [failed, repaired, repeatCall("complete")] });
        await harness.submit("在跑一张");
        expect(harness.requests.map(item => item.type)).toEqual(["agent", "agent", "edit"]);
        const correction = harness.requests[1];
        expect(correction.args[2].map((item: any) => item.function.name)).toEqual(["canvas_generate_image"]);
        expect(correction.args[3]).toEqual({ type: "function", name: "canvas_generate_image" });
        expect(correction.args[1]).toContainEqual({ type: "responses_assistant", output: failed.responsesOutputItems });
        expect(correction.args[1].filter((item: any) => item.role === "tool").map((item: any) => JSON.parse(item.content))).toContainEqual(expect.objectContaining({ ok: false, data: expect.objectContaining({ phase: "image_preflight", submitted: false, expectedMode: "complete" }) }));
        const edit = harness.requests[2];
        expect(edit.args[2][0].dataUrl).toBe(repeatOriginal.dataUrl);
        expect(edit.args[1]).toContain("Make the shirt pink.");
        expect(harness.messages().find(message => message.attachments?.length && message.id !== "pink-result")?.detail?.imageEdit).toMatchObject({ contract: repeatGoal });
        expect(JSON.stringify(harness.displayedMessages())).not.toMatch(/完整目标|editContract|必须提供 complete/);
    });

    test("a repeat misclassified as new can correct its intent without dropping the saved goal", async () => {
        const harness = panelHarness({ history: repeatHistory(true), replies: [repeatCall("update", "new"), repeatCall("update")] });
        await harness.submit("再跑一张");
        expect(harness.requests.map(item => item.type)).toEqual(["agent", "agent", "edit"]);
        expect(harness.requests[2].args[1]).toContain("Make the shirt pink.");
        expect(harness.requests[2].args[2][0].dataUrl).toBe(repeatOriginal.dataUrl);
    });

    test("a corrected mode still validates sources and never silently accepts an incomplete or invented goal", async () => {
        const invalid = repeatCall("complete", "correct_original", { editContract: { mode: "complete", changes: [{ id: "made-up", text: "Make the shirt green.", source: "改绿色" }], preserve: [], forbid: [], supersedes: [], referenceRoles: [{ id: "edit-original-0", role: "base" }] } });
        const harness = panelHarness({ history: repeatHistory(), replies: [repeatCall("update"), invalid, repeatCall("complete")] });
        await harness.submit("再跑一张");
        expect(harness.requests.map(item => item.type)).toEqual(["agent", "agent"]);
        expect(harness.assets).toHaveLength(0);
        expect(harness.displayedMessages().some(item => item.text.includes("尚未提交图片生成"))).toBe(true);
        expect(JSON.stringify(harness.displayedMessages())).not.toContain("made-up");
    });

    test("a second mode mismatch ends without a second correction or any image submission", async () => {
        const harness = panelHarness({ history: repeatHistory(), replies: [repeatCall("update"), repeatCall("update"), repeatCall("complete")] });
        await harness.submit("再跑一张");
        expect(harness.requests.map(item => item.type)).toEqual(["agent", "agent"]);
        expect(harness.assets).toHaveLength(0);
    });

    test.each(["extra-call", "wrong-tool", "count", "model", "references", "intent", "result"])("rejects a repair which expands the original operation: %s", async kind => {
        const repaired = repeatCall("complete", kind === "intent" ? "refine_latest" : "correct_original", kind === "count" ? { count: 5 } : kind === "model" ? { model: "other-provider" } : kind === "references" ? { referenceNodeIds: ["another-image"] } : kind === "result" ? { resultImageId: "another-result" } : {});
        if (kind === "extra-call") repaired.toolCalls.push({ ...repaired.toolCalls[0], id: "unexpected-second" });
        if (kind === "wrong-tool") repaired.toolCalls[0].function.name = "canvas_generate_video";
        const harness = panelHarness({ history: repeatHistory(), replies: [repeatCall("update"), repaired] });
        await harness.submit("再跑一张");
        expect(harness.requests.map(item => item.type)).toEqual(["agent", "agent"]);
        expect(harness.assets).toHaveLength(0);
    });

    test("new references prevent reclassifying a new task as an old-task redo", async () => {
        const selected: CanvasNodeData = { id: "new-shirt", type: CanvasNodeType.Image, title: "新款", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "data:image/png;base64,NEW" } };
        const harness = panelHarness({ selected: [selected], history: repeatHistory(true), replies: [repeatCall("update", "new"), repeatCall("update")] });
        await harness.submit("用这张新图重新做");
        expect(harness.requests.map(item => item.type)).toEqual(["agent", "agent"]);
        expect(harness.assets).toHaveLength(0);
    });

    test("repair freezes explicit image bytes while the planner waits and retains omitted generation settings", async () => {
        const selected: CanvasNodeData = { id: "shirt", type: CanvasNodeType.Image, title: "原图", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: repeatOriginal.dataUrl } };
        const failed = repeatCall("update", "new", { referenceNodeIds: ["shirt"], size: "1:1", count: 1 });
        const corrected = repeatCall("complete", "new", { editContract: { mode: "complete", ...repeatGoal, supersedes: [], referenceRoles: [{ id: "shirt", role: "base" }] } });
        const harness = panelHarness({ selected: [selected], replies: [failed, corrected] });
        const first = Promise.withResolvers<void>(), repair = Promise.withResolvers<void>();
        harness.pauseReply(first.promise);
        const pending = harness.submit("衬衫改粉色");
        await waitFor(() => harness.requests.length === 1);
        first.resolve();
        harness.pauseReply(repair.promise);
        await waitFor(() => harness.requests.length === 2);
        harness.select([{ ...selected, metadata: { content: "data:image/png;base64,CHANGED-WHILE-WAITING" } }]);
        repair.resolve();
        await pending;
        expect(harness.requests.map(item => item.type)).toEqual(["agent", "agent", "edit"]);
        expect(harness.requests[2].args[2][0].dataUrl).toBe(repeatOriginal.dataUrl);
        expect(harness.requests[2].args[0]).toMatchObject({ size: "1024x1024", count: "1" });
    });

    test("a prior read-only tool does not block the single unsubmitted image repair", async () => {
        const harness = panelHarness({ history: repeatHistory(), replies: [tool("canvas_get_state", {}), repeatCall("update"), repeatCall("complete")] });
        await harness.submit("看看画布，再跑一张");
        expect(harness.requests.map(item => item.type)).toEqual(["agent", "agent", "agent", "edit"]);
        expect(harness.assets).toHaveLength(1);
    });

    test("any earlier write in the turn closes the repair gate, even in a previous planner step", async () => {
        const harness = panelHarness({ history: repeatHistory(), replies: [tool("canvas_create_text_node", { text: "说明" }), repeatCall("update"), repeatCall("complete")] });
        await harness.submit("添加说明，再跑一张");
        expect(harness.requests.map(item => item.type)).toEqual(["agent", "agent"]);
        expect(harness.snapshotRef.current.nodes).toHaveLength(1);
        expect(harness.assets).toHaveLength(0);
    });

    test("a mixed or skipped write batch cannot be replayed as part of parameter correction", async () => {
        const batch = repeatCall("update");
        batch.toolCalls.push({ ...tool("canvas_create_text_node", { text: "不要执行这个" }).toolCalls[0], id: "skipped-write" });
        const harness = panelHarness({ history: repeatHistory(), replies: [batch, repeatCall("complete")] });
        await harness.submit("再跑一张");
        expect(harness.requests.map(item => item.type)).toEqual(["agent"]);
        expect(harness.snapshotRef.current.nodes).toHaveLength(0);
    });

    test.each([new Error("socket hang up"), new CanvasEditContractError("provider-level lookalike", "complete")])("a generation-stage failure never triggers contract correction, even with a misleading error type", async failure => {
        const harness = panelHarness({ history: repeatHistory(), replies: [repeatCall("complete"), repeatCall("complete")], generate: async () => { throw failure; } });
        await harness.submit("再跑一张");
        expect(harness.requests.map(item => item.type)).toEqual(["agent", "edit"]);
        expect(harness.assets).toHaveLength(0);
    });

    test("repaired calls still require confirmation when tool confirmations are enabled", async () => {
        const harness = panelHarness({ confirmTools: true, history: repeatHistory(), replies: [repeatCall("update"), repeatCall("complete"), repeatCall("complete")] });
        await harness.submit("再跑一张");
        const first = harness.messages().find(item => item.detail?.status === "pending")!;
        harness.approve(first.id);
        await waitFor(() => harness.messages().some(item => item.id !== first.id && item.detail?.status === "pending"));
        const second = harness.messages().find(item => item.id !== first.id && item.detail?.status === "pending")!;
        expect(harness.requests.map(item => item.type)).toEqual(["agent", "agent"]);
        await waitFor(() => !harness.composer().props.sending);
        harness.approve(second.id);
        await waitFor(() => harness.assets.length === 1);
        await waitFor(() => !harness.composer().props.sending);
        expect(harness.requests.map(item => item.type)).toEqual(["agent", "agent", "edit"]);
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
        expect(harness.requests.find(request => request.type === "edit")!.args[2]).toHaveLength(1);
    });

    test("applies ordinary canvas operations without spending an image or video request", async () => {
        const harness = panelHarness({ replies: [tool("canvas_create_text_node", { text: "项目说明", title: "说明" }), { content: "说明已放入画布", toolCalls: [] }] });
        await harness.submit("在画布创建一个写着项目说明的文本节点");
        expect(harness.requests.map((request) => request.type)).toEqual(["agent", "agent"]);
        expect(harness.snapshotRef.current.nodes).toEqual([expect.objectContaining({ type: CanvasNodeType.Text, title: "说明", metadata: expect.objectContaining({ content: "项目说明" }) })]);
    });

    test.each([false, true])("preserves complete Responses output through automatic or confirmed multi-step tools (confirm=%s)", async (confirmTools) => {
        const response = (turn: number, titles: string[]): ToolResponseResult => {
            const calls = titles.map((title, index) => ({ id: `call-${turn}-${index}`, type: "function" as const, function: { name: "canvas_create_text_node", arguments: JSON.stringify({ text: title, title }) } }));
            return {
                content: `第 ${turn} 轮`,
                toolCalls: calls,
                responsesOutputItems: [
                    { type: "reasoning", id: `rs-${turn}`, status: "completed", summary: [], encrypted_content: `opaque-reasoning-${turn}` },
                    ...calls.map((call, index) => ({ type: "function_call", id: `fc-${turn}-${index}`, call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: "completed" })),
                ],
            };
        };
        const first = response(1, ["第一项", "第二项"]);
        const second = response(2, ["第三项"]);
        const harness = panelHarness({ confirmTools, replies: [first, second, { content: "三项完成", toolCalls: [] }] });
        await harness.submit("在画布创建三项文本说明");
        if (confirmTools) {
            const firstPending = harness.messages().find((message) => message.detail?.status === "pending")!;
            expect(firstPending).toBeDefined();
            expect(harness.snapshotRef.current.nodes).toHaveLength(0);
            harness.approve(firstPending.id);
            await waitFor(() => harness.messages().some((message) => message.id !== firstPending.id && message.detail?.status === "pending"));
            const secondPending = harness.messages().find((message) => message.id !== firstPending.id && message.detail?.status === "pending")!;
            await waitFor(() => !harness.composer().props.sending);
            harness.approve(secondPending.id);
            await waitFor(() => harness.requests.filter((request) => request.type === "agent").length === 3);
        }
        const requests = harness.requests.filter((request) => request.type === "agent");
        expect(harness.requests.map((request) => request.type)).toEqual(["agent", "agent", "agent"]);
        expect(requests[1].args[1].slice(0, requests[0].args[1].length)).toEqual(requests[0].args[1]);
        expect(requests[1].args[1].slice(-3)).toEqual([
            { type: "responses_assistant", output: first.responsesOutputItems },
            expect.objectContaining({ role: "tool", tool_call_id: "call-1-0" }),
            expect.objectContaining({ role: "tool", tool_call_id: "call-1-1" }),
        ]);
        expect(requests[2].args[1].slice(0, requests[1].args[1].length)).toEqual(requests[1].args[1]);
        expect(requests[2].args[1].slice(-2)).toEqual([
            { type: "responses_assistant", output: second.responsesOutputItems },
            expect.objectContaining({ role: "tool", tool_call_id: "call-2-0" }),
        ]);
        expect(harness.snapshotRef.current.nodes).toHaveLength(3);
        expect(JSON.stringify(harness.messages())).not.toContain("opaque-reasoning-");
    });

    test("executes explicit run_generation operations once and waits for real outputs", async () => {
        const harness = panelHarness({ replies: [tool("canvas_apply_ops", { ops: [{ type: "add_node", id: "image-config", nodeType: "config", metadata: { generationMode: "image", prompt: "红色花瓶", count: 1, size: "1:1", quality: "1k" } }, { type: "run_generation", nodeId: "image-config", mode: "image", prompt: "红色花瓶" }] }), { content: "生成已完成", toolCalls: [] }] });
        await harness.submit("创建图片生成节点并立即执行");
        expect(harness.requests.map((request) => request.type)).toEqual(["agent", "text", "image", "agent"]);
        expect(harness.requests.find(request => request.type === "image")!.args[0]).toMatchObject({ count: "1", size: "1024x1024", quality: "auto" });
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

    test("Agent constrains a planner's legacy seven-image request to one independent output", async () => {
        const harness = panelHarness({ config: { imageModel: "vcen-gpt2" }, replies: [tool("canvas_generate_image", { editIntent: "new", prompt: "红色花瓶七种构图", count: 7, quality: "4k", size: "3:4" })] });
        await harness.submit("生成七张红色花瓶构图");
        expect(harness.requests.filter((request) => request.type === "image")).toHaveLength(1);
        expect(harness.requests.find((request) => request.type === "image")?.args[0]).toMatchObject({ model: "vcen-gpt2", count: "1", canvasImageCount: "1", quality: "4k", size: "3:4" });
    });

    test("keeps the user's image model when the planner asks to switch providers", async () => {
        const harness = panelHarness({ replies: [tool("canvas_generate_image", { editIntent: "new", model: "vcen-gpt2", prompt: "红色花瓶", count: 7, quality: "4k", size: "3:4" }), { content: "已完成", toolCalls: [] }] });
        await harness.submit("生成七张红色花瓶");
        expect(harness.requests.map((request) => request.type)).toEqual(["agent", "image", "agent"]);
        expect(harness.requests.find(request => request.type === "image")!.args[0]).toMatchObject({ model: "gpt-image-2", count: "1", quality: "auto", size: "1152x1536" });
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
        expect(harness.requests.filter((request) => request.type === "edit")).toHaveLength(0);
        const images = harness.requests.filter((request) => request.type === "image");
        expect(images).toHaveLength(1);
        expect(images[0]?.args[0]).toMatchObject({ model: "midjourney-blend", count: "1", quality: "turbo" });
        expect(images[0]?.args[1]).toBe("");
        expect(images[0]?.args[2]).toMatchObject({ tool: "canvas-image" });
        expect(images[0]?.args[3]).toHaveLength(2);
    });

    test("adds completed images to assets using the same local media and original server identity", async () => {
        const serverAssetId = "7075c394-1184-44cc-9077-068d78e8b36d";
        const url = `/api/assets/${serverAssetId}/content`;
        const harness = panelHarness({ replies: [tool("canvas_generate_image", { editIntent: "new", prompt: "绿色花瓶" })], generate: async () => [{ id: "green-vase", dataUrl: url }], storedImage: { url: "blob:cached-image", storageKey: "image:cached", width: 1024, height: 1024, bytes: 12345, mimeType: "image/png" } });
        await harness.submit("生成绿色花瓶");
        expect(harness.imageUploads).toEqual([url]);
        expect(harness.assets).toHaveLength(1);
        expect(harness.assets[0]).toMatchObject({ kind: "image", data: { dataUrl: "blob:cached-image", storageKey: "image:cached", width: 1024, height: 1024, bytes: 12345 }, metadata: { serverAssetId, nodeId: "green-vase", projectId: "project", prompt: "Keep unchanged:\n- refined prompt", model: "gpt-image-2" } });
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
