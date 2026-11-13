import { i18nHarness } from "./helpers/i18n-harness";
import { displayHooksHarness } from "./helpers/display-hooks-harness";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
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
import * as onlineTaskRecovery from "@/lib/canvas/canvas-online-task-recovery";
import * as agentGeneration from "@/lib/agent-direct-generation";
import { imageAgentGenerationParameters } from "@/lib/image-agent-generation-parameters";

const requireModule = createRequire(new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url));
const requireToolConfigModule = createRequire(new URL("../src/hooks/use-tool-config.ts", import.meta.url));
const source = readFileSync(new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const toolConfigCode = ts.transpileModule(readFileSync(new URL("../src/hooks/use-tool-config.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const reducedMotionCode = ts.transpileModule(readFileSync(resolve(dirname(requireModule.resolve("framer-motion")), "../es/utils/reduced-motion/use-reduced-motion.mjs"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;

function panelHarness(options: { replies: ToolResponseResult[]; stream?: string; translate?: () => Promise<string>; readImage?: (reference: { id?: string; dataUrl?: string; storageKey?: string }) => Promise<string>; config?: Partial<configModule.AiConfig>; flags?: Partial<Record<ModuleKey, boolean>>; tools?: BusinessConfig["tools"]; models?: BusinessConfig["models"]; imageCapabilities?: BusinessConfig["models"]; standalone?: boolean; selected?: CanvasNodeData[]; nodes?: CanvasNodeData[]; history?: CanvasAssistantMessage[]; session?: Partial<CanvasAssistantSession>; confirmTools?: boolean; canManageConfig?: boolean; generate?: () => Promise<Array<{ id: string; dataUrl: string }>>; video?: () => Promise<{ url: string; mimeType: string }>; storedImage?: UploadedImage; storedVideo?: UploadedFile; taskLifecycle?: boolean; storeImage?: () => Promise<UploadedImage>; userId?: string; recoveryIO?: NonNullable<Parameters<typeof onlineTaskRecovery.recoverOnlineAgentTask>[3]> } & Pick<CanvasAssistantSession, "documents" | "requirementCard">) {
    const states: unknown[] = [];
    const refs: unknown[] = [];
    const memos: Array<{ dependencies?: DependencyList; value: unknown }> = [];
    const effects: Array<{ dependencies?: DependencyList; cleanup?: ReturnType<EffectCallback> }> = [];
    const pendingEffects: Array<() => void> = [];
    const pendingLayoutEffects: Array<() => void> = [];
    let stateIndex = 0;
    let refIndex = 0;
    let memoIndex = 0;
    let effectIndex = 0;
    const requests: Array<{ type: string; args: any[] }> = [];
    const assets: AssetInput[] = [];
    const imageUploads: string[] = [];
    const imageSizeReads: string[] = [];
    const imagePreviewReads: string[] = [];
    const videoStores: unknown[] = [];
    const config = { ...configModule.defaultConfig, model: "text-model", textModel: "text-model", imageModel: "gpt-image-2", videoModel: "MiniMax-H3", size: "3:4", quality: "2k", canvasImageCount: "2", videoSeconds: "6", vquality: "1080P", videoGenerateAudio: "true", ...options.config };
    const flags = { ...Object.fromEntries(moduleKeys.map(key => [key, true])), ...options.flags } as Record<ModuleKey, boolean>;
    const business: BusinessConfig = {
        models: options.models || [
            { id: "text-model", name: config.textModel, modelId: config.textModel, capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 },
            { id: "image-model", name: config.imageModel, modelId: config.imageModel, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
            { id: "video-model", name: config.videoModel, modelId: config.videoModel, capabilities: ["video"], creditCost: 0, rmbCost: 0 },
        ], prices: [], tools: options.tools || [],
    };
    if (!business.tools.some(item => item.toolKey === "gpt-chat")) business.tools = [
        ...business.tools,
        { toolKey: "gpt-chat", modelConfigId: business.models.find(model => model.capabilities.includes("chat"))?.id || null, enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 },
    ];
    const businessState = { ...business, status: "ready" as const, refresh: async () => undefined };
    const userState = { status: options.userId ? "authenticated" : "guest", user: options.userId ? { id: options.userId } : null };
    let sessions: CanvasAssistantSession[] = options.history || options.requirementCard || options.documents ? [{ id: "history", title: "History", createdAt: "2026-09-06", updatedAt: "2026-09-06", messages: options.history || [], documents: options.documents, requirementCard: options.requirementCard, ...options.session }] : [];
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
    const scheduleEffect = (effect: EffectCallback, dependencies: DependencyList | undefined, queue: Array<() => void>) => {
        const index = effectIndex++;
        const previous = effects[index];
        if (!previous || !dependenciesEqual(previous.dependencies, dependencies)) {
            queue.push(() => {
                previous?.cleanup?.();
                effects[index] = { dependencies, cleanup: effect() };
            });
        }
    };
    const snapshotRef: { current: CanvasAgentSnapshot } = { current: { projectId: "project", title: "Canvas", nodes: options.nodes || options.selected || [], connections: [], selectedNodeIds: (options.selected || []).map((node) => node.id), viewport: { x: 0, y: 0, k: 1 }, viewportSize: { width: 800, height: 600 } } };
    const imageRequest = async (type: string, args: any[]) => {
        imageAgentGenerationParameters(args[type === "image" ? 2 : 4]);
        requests.push({ type, args });
        if (options.taskLifecycle) {
            const settings = args[type === "image" ? 2 : 4];
            await settings.onSubmissionStarted();
            await settings.onSubmitted(["accepted-image"]);
        }
        return options.generate ? options.generate() : [{ id: "generated-image", dataUrl: "/api/assets/result/content" }];
    };
    const dependencies: Record<string, unknown> = {
        "@/hooks/use-display-text": { ...displayHooksHarness, DisplayText: ({ text }: { text: string }) => text, DisplayTranslationScope: ({ children }: { children: unknown }) => children },
        // Browser download/dialog effects are covered by their browser tests, not this planner dispatcher.
        "@/hooks/use-conversation-image-tools": { useConversationImageTools: () => ({ download: async () => undefined, compare: () => undefined, compareDialog: null }) },
        // Native drag events are covered separately; onAddFiles below still runs the real attachment reader.
        "@/hooks/use-image-drop": { useImageDrop: () => ({ dropProps: {}, dragging: false, reading: false }) },
        "@/hooks/use-chat-bottom-follow": { useChatBottomFollow: () => ({ listRef: { current: null }, onScroll: () => undefined, hasNewMessages: false, scrollToBottom: () => undefined }) },
        "@/stores/canvas/use-canvas-panel-store": { useCanvasPanelStore: (selector: (state: unknown) => unknown) => selector({ chatWidth: 520 }) },
        "@/lib/canvas/canvas-assistant-media": {
            captureCanvasContextSnapshot: (snapshot: CanvasAgentSnapshot) => snapshot,
            readCanvasContextImage: async (node: CanvasNodeData) => `data:image/jpeg;base64,${node.id}`,
            readCanvasContextVideo: async (node: CanvasNodeData) => [{ seconds: 0, dataUrl: `data:image/jpeg;base64,${node.id}-frame` }],
            readCanvasConversationImage: async (reference: { id: string; dataUrl?: string; storageKey?: string }) => {
                imagePreviewReads.push(reference.storageKey || reference.dataUrl || reference.id);
                return options.readImage ? options.readImage(reference)
                    : reference.dataUrl?.startsWith("data:image/") ? reference.dataUrl : `data:image/jpeg;base64,${Buffer.from(reference.id).toString("base64")}`;
            },
        },
        react: {
            ...React,
            memo: (component: unknown) => component,
            useEffect: (effect: EffectCallback, dependencies?: DependencyList) => scheduleEffect(effect, dependencies, pendingEffects),
            useLayoutEffect: (effect: EffectCallback, dependencies?: DependencyList) => scheduleEffect(effect, dependencies, pendingLayoutEffects),
            useMemo,
            // This manual renderer commits synchronously; scheduling itself is
            // covered by the production-browser input and session-switch tests.
            useDeferredValue: (value: unknown) => value,
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
        "@/stores/use-user-store": { useUserStore: Object.assign((selector: (state: typeof userState) => unknown) => selector(userState), { getState: () => userState }) },
        "@/lib/canvas/canvas-online-task-recovery": {
            ...onlineTaskRecovery,
            recoverOnlineAgentTask: (...args: Parameters<typeof onlineTaskRecovery.recoverOnlineAgentTask>) => onlineTaskRecovery.recoverOnlineAgentTask(args[0], args[1], args[2], options.recoveryIO),
        },
        "@/stores/use-asset-store": { serverAssetIdFromAsset, useAssetStore: (selector: (state: unknown) => unknown) => selector({ cleanupImages: () => undefined, addAssets: (items: AssetInput[]) => { assets.push(...items); return items.map((_, index) => `asset-${index}`); } }) },
        "@/stores/canvas/use-canvas-agent-store": { useCanvasAgentStore: (selector: (state: unknown) => unknown) => selector({ onlineConfirmTools: options.confirmTools || false, setAgentState: () => undefined }) },
        "@/hooks/use-can-manage-config": { useCanManageConfig: () => options.canManageConfig || false },
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
        "@/services/api/audio": {
            requestAudioGeneration: async (...args: any[]) => {
                requests.push({ type: "audio", args });
                await args[2]?.onSubmissionStarted?.("audio-request");
                await args[2]?.onSubmitted?.({ id: "accepted-audio" });
                return new Blob(["audio"], { type: "audio/mpeg" });
            },
            storeGeneratedAudio: async () => ({ url: "/api/assets/audio/content", storageKey: "", mimeType: "audio/mpeg" }),
        },
        "@/services/image-storage": { uploadImage: async (url: string) => { imageUploads.push(url); return options.storeImage ? options.storeImage() : options.storedImage || { url, storageKey: "", width: 1024, height: 1024, bytes: 100, mimeType: "image/png" }; }, imageToDataUrl: async (reference: any) => reference.dataUrl || reference.url },
        "@/lib/agent-direct-generation": {
            ...agentGeneration,
            // These placeholder bytes represent 1024-square fixtures, not
            // decodable browser images. Keep the real size preflight and mock
            // only its source decoder instead of bypassing generation rules.
            resolveAgentImageGenerationSettings: (...args: Parameters<typeof agentGeneration.resolveAgentImageGenerationSettings>) => {
                args[5] = async (source, assertCurrent) => {
                    assertCurrent();
                    imageSizeReads.push(source.id);
                    return { width: 1024, height: 1024 };
                };
                return agentGeneration.resolveAgentImageGenerationSettings(...args);
            },
        },
    };
    // Execute the real hook against this harness's React dispatcher and scoped stores.
    // No global Zustand state or network configuration leaks into manual renders.
    const reducedMotionModule = { exports: {} as any };
    new Function("require", "module", "exports", reducedMotionCode)((id: string) => id === "react" ? dependencies.react : requireModule(id), reducedMotionModule, reducedMotionModule.exports);
    dependencies["motion/react"] = { ...requireModule("motion/react"), ...reducedMotionModule.exports };
    const toolConfigModule = { exports: {} as any };
    new Function("require", "module", "exports", toolConfigCode)((id: string) => id === "@/lib/i18n" ? i18nHarness : ((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireToolConfigModule(name))(id), toolConfigModule, toolConfigModule.exports);
    dependencies["@/hooks/use-tool-config"] = toolConfigModule.exports;
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code)((id: string) => id === "@/lib/i18n" ? i18nHarness : ((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name))(id), module, module.exports);
    const panelState = { closing: false, agentMode: "online" };
    const render = (): ReactElement<any> => {
        stateIndex = refIndex = memoIndex = effectIndex = 0;
        const element = module.exports.CanvasAssistantPanel({
            selectedNodeIds: new Set(snapshotRef.current.selectedNodeIds), selectedNodes: options.selected || [], snapshotRef,
            sessions, activeSessionId, onSelectNodeIds: () => undefined, onSessionsChange,
            onApplyOps: (ops: any[]) => snapshotRef.current = applyCanvasAgentOps(snapshotRef.current, ops),
            canUndoOps: false, onUndoOps: () => null, onPasteImage: () => undefined,
            ...panelState, onAgentModeChange: () => undefined, onCollapse: () => undefined,
        }) as ReactElement<any>;
        for (const effect of pendingLayoutEffects.splice(0)) effect();
        for (const effect of pendingEffects.splice(0)) effect();
        return element;
    };
    const composer = () => findElements(render()).find((element) => typeof element.props.onSubmit === "function")!;
    const messages = (): CanvasAssistantMessage[] => states.flatMap((value) => Array.isArray(value) ? value.flatMap((item) => item?.messages || []) : []);
    return {
        requests, config, snapshotRef, composer, messages, assets, imageUploads, imageSizeReads, imagePreviewReads, videoStores, capabilityRequests, sessionCommits, sessionUpdates,
        stop() { composer().props.onStop(); },
        close() { panelState.closing = true; render(); },
        unmount() { effects.forEach(effect => effect.cleanup?.()); },
        pauseCommit(gate: Promise<void>) { commitGate = gate; },
        pauseReply(gate: Promise<void>) { replyGate = gate; },
        newChat() { findElements(render()).find(element => element.props.title === "新对话")!.props.children.props.onClick(); },
        echoCommit() { const committed = sessionCommits.at(-1)!; sessions = committed.sessions; activeSessionId = committed.activeId; render(); },
        echoUpdate(index: number) { const update = sessionUpdates[index]!; sessions = update.sessions; activeSessionId = update.activeId; render(); },
        restoreSessions(restored: CanvasAssistantSession[], activeId: string | null) { sessions = restored; activeSessionId = activeId; render(); },
        sessionIds: () => states.flatMap(value => Array.isArray(value) ? value.filter(item => Array.isArray(item?.messages)).map(item => item.id) : []),
        workflowCards: () => findElements(render()).filter((element) => typeof element.type === "function" && element.type.name === "CanvasAgentMediaWorkflowCard").map((element) => element.props),
        switchProject(projectId: string) { sessions = []; activeSessionId = null; snapshotRef.current = { ...snapshotRef.current, projectId }; render(); },
        select(nodes: CanvasNodeData[]) {
            options.selected = nodes;
            snapshotRef.current = { ...snapshotRef.current, selectedNodeIds: nodes.map((node) => node.id) };
            render();
        },
        toggleContext() { findElements(render()).find((element) => element.type === "button" && typeof element.props["aria-pressed"] === "boolean")!.props.onClick(); },
        referenceTray() {
            return findElements(composer().props.attachmentPreview).find(element => typeof element.props.onMove === "function")!.props;
        },
        session: () => (sessionUpdates.at(-1)?.sessions || sessions).find(session => session.id === (sessionUpdates.at(-1)?.activeId || sessions[0]?.id)),
        displayedMessages() {
            return findElements(render()).filter(element => typeof element.type === "object" && element.props.item).map(element => element.props.item as CanvasAssistantMessage);
        },
        recoveryButtons() {
            return findElements(render()).filter(element => element.props.children === "查询原任务" && typeof element.props.onClick === "function");
        },
        referencePreviews() {
            const rows = findElements(render()).filter((element) => typeof element.type === "function" && element.type.name === "MessageReferences");
            const chips = rows.flatMap((element) => findElements((element.type as Function)(element.props))).filter((element) => typeof element.type === "function" && element.type.name === "AssistantReferenceChip");
            return chips.flatMap((element) => findElements((element.type as Function)(element.props))).filter((element) => typeof element.type === "function" && element.type.name === "CanvasPersistedMediaPreview").map((element) => element.props);
        },
        async ready() { await waitFor(() => !composer().props.disabled); },
        async submit(prompt: string) {
            await waitFor(() => !composer().props.disabled);
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
    for (let attempt = 0; attempt < 1000; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error("Panel did not reach the expected state");
}

describe("canvas conversational image selection without target controls", () => {
    const original = { id: "source", type: CanvasNodeType.Image, title: "原图", dataUrl: "data:image/png;base64,ORIGINAL", storageKey: "image:source" };
    const sourceId = "chat-image:source-message:reference:0:source";
    const oldId = "chat-image:old-message:result:old";
    const history = (): CanvasAssistantMessage[] => [
        { id: "source-message", role: "user", text: "背景改白色", references: [original] },
        { id: "old-message", role: "assistant", text: "旧结果", detail: { status: "completed", imageAgent: { baseImageId: sourceId, workId: sourceId, referenceIds: [sourceId], note: { summary: "白背景花瓶", keep: ["保留白色背景"] } } }, attachments: [{ id: "old", name: "旧结果", mediaType: "image", url: "data:image/png;base64,OLD", storageKey: "image:old" }] },
        { id: "latest-message", role: "assistant", text: "另一项新任务", detail: { status: "completed", imageAgent: { referenceIds: [], note: { summary: "蓝色裙子", keep: ["保留蓝色"] } } }, attachments: [{ id: "latest", name: "最新结果", mediaType: "image", url: "data:image/png;base64,LATEST", storageKey: "image:latest" }] },
    ];

    test("natural conversation inspects and edits a historical result without a target button or unrelated branch requirements", async () => {
        const harness = panelHarness({ history: history(), replies: [tool("look_at_images", { image_ids: [oldId] }), tool("edit_image", { base: oldId, prompt: "图2再亮一点", note_update: "白背景花瓶，光线更亮" })] });
        expect(harness.composer().props.imageTarget.props.images).toBeUndefined();
        expect(harness.composer().props.imageTarget.props.onSelect).toBeUndefined();
        await harness.submit("图2再亮一点");
        const request = harness.requests.find(item => item.type === "edit")!;
        expect(request.args[2].map((image: any) => image.storageKey)).toEqual(["image:old"]);
        expect(harness.imageSizeReads).toEqual([oldId]);
        expect(request.args[1]).toContain("保留白色背景");
        expect(request.args[1]).not.toContain("蓝色");
        const saved = harness.messages().filter(message => message.attachments?.length).at(-1)!;
        expect(saved.detail?.imageAgent).toMatchObject({ baseImageId: oldId, workId: sourceId, note: { summary: "白背景花瓶，光线更亮", keep: ["保留白色背景"] } });
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "agent", "edit"]);
    });

    test("a conversational original request keeps its frozen pixels after acceptance while another canvas node is selected", async () => {
        const gate = Promise.withResolvers<Array<{ id: string; dataUrl: string }>>();
        const other: CanvasNodeData = { id: "other", type: CanvasNodeType.Image, title: "另一张", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "blob:other" } };
        const harness = panelHarness({ history: history(), session: { focusImageId: oldId, focusLocked: true }, nodes: [other], confirmTools: true, taskLifecycle: true, generate: () => gate.promise, replies: [tool("edit_image", { base: "original", prompt: "从原图再亮一点" })] });
        const submitted = harness.submit("从原图再亮一点");
        await waitFor(() => harness.messages().some(message => (message.detail?.pendingTask as { taskIds?: string[] })?.taskIds?.includes("accepted-image")) && !harness.composer().props.sending);
        harness.select([other]);
        gate.resolve([{ id: "bright-result", dataUrl: "/api/assets/bright/content" }]);
        await submitted;
        expect(harness.requests.find(request => request.type === "edit")!.args[2].map((image: any) => image.storageKey)).toEqual(["image:source"]);
        expect(harness.requests.filter(request => request.type === "agent")).toHaveLength(1);
        expect(harness.messages().some(message => message.detail?.status === "pending")).toBe(false);
        expect(harness.snapshotRef.current.selectedNodeIds).toEqual([other.id]);
    });

    test("a restored legacy focus lock and persistent canvas selection cannot override spoken previous or original", async () => {
        const messages = history(), latestId = "chat-image:latest-message:result:latest";
        messages[2]!.detail!.imageAgent = { baseImageId: oldId, workId: sourceId, referenceIds: [oldId], note: { summary: "当前花瓶", keep: [] } };
        const selected: CanvasNodeData = { id: "source", type: CanvasNodeType.Image, title: "原图", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: "image:source", content: "data:image/png;base64,ORIGINAL" } };
        let generated = 0;
        const harness = panelHarness({ history: messages, selected: [selected], session: { focusImageId: latestId, focusLocked: true },
            generate: async () => [{ id: `result-${++generated}`, dataUrl: `/api/assets/result-${generated}/content` }],
            replies: [tool("edit_image", { base: "previous", prompt: "回上一版调亮" }), tool("edit_image", { base: "original", prompt: "从原图重新改颜色" })] });
        await harness.submit("回上一版调亮");
        await harness.submit("从原图重新改颜色");
        const plans = harness.requests.filter(request => request.type === "agent");
        expect(plans[0].args[5].profileContext.focusImageId).toBe(latestId);
        expect(plans.every(request => !request.args[5].profileContext.lockedImageId)).toBe(true);
        expect(harness.requests.filter(request => request.type === "edit").map(request => request.args[2].map((image: any) => image.storageKey))).toEqual([["image:old"], ["image:source"]]);
        expect(harness.messages().filter(message => message.detail?.kind === "agent_generation" && message.detail.status === "completed").map(message => (message.detail!.imageAgent as { baseImageId: string }).baseImageId)).toEqual([oldId, sourceId]);
        expect(harness.session()?.focusLocked).toBe(false);
    });

    test.each([
        ["canvas_run_generation", { nodeId: "generator", mode: "image", prompt: "Brighten the image." }],
        ["canvas_create_generation_flow", { mode: "image", prompt: "Brighten the image.", autoRun: true }],
        ["canvas_apply_ops", { ops: [{ type: "run_generation", nodeId: "generator", mode: "image", prompt: "Brighten the image." }] }],
    ] as const)("an explicit local selection cannot be bypassed by %s", async (name, args) => {
        const node: CanvasNodeData = { id: "generator", type: CanvasNodeType.Config, title: "生成", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { generationMode: "image" } };
        const harness = panelHarness({ history: history(), session: { imageAgentRegion: { imageId: oldId, mask: { id: "mask", name: "mask", type: "image/png", dataUrl: "data:image/png;base64,MASK" }, selection: { id: "selection", name: "selection", type: "image/png", dataUrl: "data:image/png;base64,SELECTION" } } }, nodes: [node], replies: [tool(name, args)] });
        const before = JSON.stringify(harness.snapshotRef.current.nodes);
        await harness.submit("再亮一点");
        expect(harness.requests.map(request => request.type)).toEqual(["agent"]);
        expect(JSON.stringify(harness.snapshotRef.current.nodes)).toBe(before);
        expect(harness.messages().some(message => message.text.includes("不会通过节点生成绕过"))).toBe(true);
    });

    test("speaking image numbers allows read-only discussion without mention selection or media submission", async () => {
        const harness = panelHarness({ history: history(), replies: [tool("look_at_images", { image_ids: [oldId, sourceId] }), { content: "讨论", toolCalls: [] }] });
        expect(harness.composer().props.mentionImages).toBeUndefined();
        expect(harness.composer().props.onMentionImage).toBeUndefined();
        expect(harness.requests).toEqual([]);
        await harness.submit("比较图2和图1，先不要修改");
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "agent"]);
        expect(harness.assets).toEqual([]);
    });

    test("project changes clear an old conversation instead of carrying its target into another canvas", async () => {
        const harness = panelHarness({ history: history(), session: { focusImageId: oldId }, replies: [{ content: "新画布", toolCalls: [] }] });
        harness.switchProject("other-project");
        await harness.submit("你好");
        expect(harness.requests[0].args[5].profileContext.focusImageId).toBeUndefined();
        expect(harness.requests[0].args[5].profileContext.imageCatalog).toEqual([]);
    });

    test("new creation does not silently reuse a prior result as edit pixels", async () => {
        const harness = panelHarness({ history: history(), replies: [tool("edit_image", { base: "none", prompt: "生成新包" })] });
        await harness.submit("重新创作一个包");
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "image"]);
        expect(harness.requests[1].args[3]).toEqual([]);
    });
});

describe("canvas historical-image repair reads before its only replanning request", () => {
    const prompt = "以图3为基础，只把两侧连接环从金色改成银色。保留图3的森林绿包身和肩带、浅暖灰背景，以及原有包型，生成一张。";
    const sourceId = "chat-image:branch-source:reference:0:source";
    const id = (version: number) => version === 1 ? sourceId : `chat-image:branch-v${version}:result:v${version}`;
    const pixels = (version: number) => `data:image/png;base64,${Buffer.from(`original-pixels-v${version}`).toString("base64")}`;
    const history = (): CanvasAssistantMessage[] => [
        { id: "branch-source", role: "user", text: "原包", references: [{ id: "source", type: CanvasNodeType.Image, title: "原包", storageKey: "image:v1", dataUrl: pixels(1) }] },
        ...[2, 3, 4, 5].map((version): CanvasAssistantMessage => ({
            id: `branch-v${version}`, role: "assistant", text: `版本${version}`,
            detail: { kind: "agent_generation", status: "completed", prompt: version === 3 ? "森林绿包身和肩带、浅暖灰背景、金色连接环" : `其他版本${version}`,
                imageAgent: { baseImageId: id(version === 2 || version === 5 ? 1 : 2), workId: sourceId,
                    referenceIds: [id(version === 2 || version === 5 ? 1 : 2)], note: { summary: `版本${version}`, keep: version === 3 ? ["森林绿包身和肩带", "浅暖灰背景"] : [`其他分支${version}`] } } },
            attachments: [{ id: `v${version}`, name: `版本${version}`, mediaType: "image", storageKey: `image:v${version}`, url: pixels(version) }],
        })),
    ];
    const editPlan = () => tool("edit_image", { base: "图3", prompt });
    const previewUrls = (request: { args: any[] }) => request.args[1].flatMap((message: any) => Array.isArray(message.content)
        ? message.content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url) : []);

    test("the five-version branch loads image 3 and submits its exact original once, preserving focus and lineage", async () => {
        const original = history(), before = structuredClone(original);
        const harness = panelHarness({ history: original, session: { focusImageId: id(5) }, replies: [editPlan(), editPlan()] });
        await harness.submit(prompt);
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "agent", "edit"]);
        const [initial, repaired, edit] = harness.requests;
        expect(previewUrls(initial)).toEqual([pixels(5), pixels(1)]);
        expect(initial.args[5].profileContext.previewImageIds).toEqual([id(5), id(1)]);
        expect(previewUrls(repaired)).toEqual([pixels(3), pixels(5), pixels(1)]);
        expect(repaired.args[5].profileContext).toMatchObject({ stage: "repair", focusImageId: id(5), previewImageIds: [id(3), id(5), id(1)],
            repairIssue: { code: "IMAGE_AGENT_UNPREVIEWED_IMAGE", submitted: false, repairable: true } });
        expect(Object.keys(repaired.args[5].profileContext.repairIssue).sort()).toEqual(["code", "message", "repairable", "submitted"]);
        expect(repaired.args[5].profileContext.imageCatalog.find((image: any) => image.id === id(3))).toMatchObject({ previewed: true, parentId: id(2), workId: sourceId });
        expect(repaired.args[5].profileContext.imageCatalog.find((image: any) => image.id === id(4)).previewed).toBe(false);
        expect(repaired.args[1].at(-1)).toEqual({ role: "user", content: prompt });
        expect(repaired.args[2]).toEqual([]);
        expect(harness.imagePreviewReads).toEqual(["image:v5", "image:v1", "image:v3"]);
        expect(edit.args[2]).toEqual([expect.objectContaining({ id: id(3), storageKey: "image:v3", dataUrl: pixels(3) })]);
        expect(edit.args[1]).toContain("森林绿包身和肩带");
        expect(edit.args[1]).not.toContain("其他分支5");
        expect(harness.messages().filter(message => message.detail?.kind === "agent_generation").at(-1)?.detail?.imageAgent)
            .toMatchObject({ baseImageId: id(3), sourceNodeId: "v3", workId: sourceId, referenceIds: [id(3)], version: 6 });
        const userMessage = harness.messages().find(message => message.role === "user" && message.text === prompt)!;
        expect(userMessage.meta).toBe("本轮助手看到了 3 张图片（图3、图5、图1）");
        expect(userMessage.detail).toMatchObject({ previewImageIds: [id(3), id(5), id(1)], conversationContext: { images: 3 } });
        expect(userMessage.references).toEqual([]);
        expect(userMessage.contextReferences?.map(reference => reference.dataUrl)).toEqual([pixels(5), pixels(1)]);
        expect(original).toEqual(before);
        expect(harness.assets).toHaveLength(1);
        expect(harness.messages().some(message => message.role === "error")).toBe(false);
    });

    test("required historical references are loaded together without replacing the actual edit base", async () => {
        const plan = () => tool("edit_image", { base: "图3", references: ["图4"], prompt });
        const harness = panelHarness({ history: history(), session: { focusImageId: id(5) }, replies: [plan(), plan()] });
        await harness.submit(prompt);
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "agent", "edit"]);
        expect(previewUrls(harness.requests[1])).toEqual([pixels(3), pixels(4), pixels(5), pixels(1)]);
        expect(harness.requests[2].args[2].map((reference: any) => reference.storageKey)).toEqual(["image:v3", "image:v4"]);
    });

    test("failed original preview loading stops before repair, image submission, or sibling writes", async () => {
        const plan = editPlan();
        plan.toolCalls.unshift({ ...tool("canvas_create_text_node", { title: "禁止写入", text: "unread base" }).toolCalls[0], id: "blocked-write" });
        const harness = panelHarness({ history: history(), session: { focusImageId: id(5) }, replies: [plan, editPlan()],
            readImage: async reference => { if (reference.storageKey === "image:v3") throw new Error("图3原件加载失败"); return reference.dataUrl!; } });
        await harness.submit(prompt);
        expect(harness.requests.map(request => request.type)).toEqual(["agent"]);
        expect(harness.snapshotRef.current.nodes).toEqual([]);
        expect(harness.assets).toEqual([]);
        expect(harness.imageUploads).toEqual([]);
        expect(harness.messages()).toContainEqual(expect.objectContaining({ role: "error", text: "图3原件加载失败" }));
        expect(harness.messages().find(message => message.role === "user" && message.text === prompt)).toMatchObject({
            meta: "本轮助手看到了 2 张图片（图5、图1）", detail: { previewImageIds: [id(5), id(1)], conversationContext: { images: 2 } },
        });
    });

    test("stopping while the missing image loads cannot replan or submit after its pixels arrive", async () => {
        const gate = Promise.withResolvers<string>();
        const harness = panelHarness({ history: history(), session: { focusImageId: id(5) }, replies: [editPlan(), editPlan()],
            readImage: reference => reference.storageKey === "image:v3" ? gate.promise : Promise.resolve(reference.dataUrl!) });
        const submitted = harness.submit(prompt);
        await waitFor(() => harness.imagePreviewReads.includes("image:v3"));
        harness.stop();
        gate.resolve(pixels(3));
        await submitted;
        expect(harness.requests.map(request => request.type)).toEqual(["agent"]);
        expect(harness.snapshotRef.current.nodes).toEqual([]);
        expect(harness.assets).toEqual([]);
        expect(harness.imageUploads).toEqual([]);
        expect(harness.session()?.focusImageId).toBe(id(5));
        expect(harness.messages().find(message => message.role === "user" && message.text === prompt)).toMatchObject({
            meta: "本轮助手看到了 2 张图片（图5、图1）", detail: { previewImageIds: [id(5), id(1)] },
        });
    });

    test("a pending repair response and later cancellation do not claim its replacement previews were seen", async () => {
        const response = Promise.withResolvers<void>();
        const harness = panelHarness({ history: history(), session: { focusImageId: id(5) }, replies: [editPlan(), editPlan()],
            readImage: async reference => {
                if (reference.storageKey === "image:v3") harness.pauseReply(response.promise);
                return reference.dataUrl!;
            } });
        const submitted = harness.submit(prompt);
        await waitFor(() => harness.requests.length === 2);
        const currentUserMessage = () => harness.messages().find(message => message.role === "user" && message.text === prompt);
        expect(currentUserMessage()).toMatchObject({ meta: "本轮助手看到了 2 张图片（图5、图1）", detail: { previewImageIds: [id(5), id(1)] } });
        harness.stop();
        response.resolve();
        await submitted;
        expect(currentUserMessage()).toMatchObject({ meta: "本轮助手看到了 2 张图片（图5、图1）", detail: { previewImageIds: [id(5), id(1)] } });
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "agent"]);
        expect(harness.assets).toEqual([]);
        expect(harness.imageUploads).toEqual([]);
    });

    test("the single repair cannot silently edit a different still-unpreviewed branch", async () => {
        const harness = panelHarness({ history: history(), session: { focusImageId: id(5) }, replies: [editPlan(), tool("edit_image", { base: "图4", prompt }), editPlan()] });
        await harness.submit(prompt);
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "agent"]);
        expect(harness.imagePreviewReads).not.toContain("image:v4");
        expect(harness.assets).toEqual([]);
        expect(harness.imageUploads).toEqual([]);
        expect(harness.snapshotRef.current.nodes).toEqual([]);
    });
});

describe("online Agent cancellation", () => {
    test("image output IDs use each original task index, matching recovery across split tasks", async () => {
        const harness = panelHarness({ replies: [tool("edit_image", { prompt: "A red vase" }), { content: "done", toolCalls: [] }],
            generate: async () => [
                { id: "a", dataUrl: "/api/assets/a/content", sourceTaskId: "task-a" },
                { id: "b", dataUrl: "/api/assets/b/content", sourceTaskId: "task-b" },
                { id: "c", dataUrl: "/api/assets/c/content", sourceTaskId: "task-b" },
            ],
        });
        await harness.submit("生成图片");
        expect(harness.snapshotRef.current.nodes.map(node => node.id)).toEqual(["agent-task-a-0", "agent-task-b-0", "agent-task-b-1"]);
    });

    test("audio output keeps the original task identity used by later recovery", async () => {
        const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Audio, title: "音频", position: { x: 0, y: 0 }, width: 300, height: 120, metadata: { model: "audio-model", generationMode: "audio" } };
        const harness = panelHarness({ config: { audioModel: "audio-model" }, nodes: [source],
            models: [
                { id: "text-model", name: "Text", modelId: "text-model", capabilities: ["chat"], creditCost: 0, rmbCost: 0 },
                { id: "audio-model", name: "Audio", modelId: "audio-model", capabilities: ["audio"], creditCost: 0, rmbCost: 0 },
            ],
            replies: [tool("canvas_run_generation", { nodeId: "source", mode: "audio", prompt: "Read this" }), { content: "done", toolCalls: [] }],
        });
        await harness.submit("生成音频");
        expect(harness.requests.filter(request => request.type === "audio")).toHaveLength(1);
        expect(harness.snapshotRef.current.nodes.find(node => node.id === "agent-accepted-audio-0")?.metadata).toMatchObject({ sourceTaskId: "accepted-audio", status: "success" });
        expect(harness.snapshotRef.current.connections).toContainEqual(expect.objectContaining({ fromNodeId: "source", toNodeId: "agent-accepted-audio-0" }));
    });

    test("stopping during the pre-submit save clears the unsubmitted identity and permits a later message", async () => {
        const saved = Promise.withResolvers<void>();
        const harness = panelHarness({ taskLifecycle: true, replies: [tool("edit_image", { prompt: "A red vase" }), { content: "ready", toolCalls: [] }] });
        harness.pauseCommit(saved.promise);
        const submitted = harness.submit("生成花瓶");
        await waitFor(() => harness.messages().some(message => Boolean(message.detail?.pendingTask)));
        harness.stop();
        saved.resolve();
        await submitted;
        expect(harness.messages().some(message => Boolean(message.detail?.pendingTask))).toBe(false);
        expect(harness.messages().some(message => message.text.includes("本次请求未提交"))).toBe(true);
        expect(harness.imageUploads).toEqual([]);
        await harness.submit("继续对话");
        expect(harness.requests.filter(request => request.type === "agent")).toHaveLength(2);
    });

    test("project switches abort the prior turn before a late planner can modify the next canvas", async () => {
        const gate = Promise.withResolvers<void>();
        const harness = panelHarness({ replies: [tool("canvas_create_text_node", { text: "old project" })] });
        harness.pauseReply(gate.promise);
        const submitted = harness.submit("创建文字节点");
        await waitFor(() => harness.requests.some(request => request.type === "agent"));
        harness.snapshotRef.current = { ...harness.snapshotRef.current, projectId: "next-project" };
        harness.composer();
        gate.resolve();
        await submitted;
        expect(harness.snapshotRef.current.nodes).toEqual([]);
        expect(harness.requests[0]!.args[5].signal.aborted).toBe(true);
    });
    test.each(["stop", "unmount"] as const)("%s prevents a late planner reply from submitting tools", async action => {
        const gate = Promise.withResolvers<void>();
        const harness = panelHarness({ replies: [tool("canvas_create_text_node", { text: "must not appear" })] });
        harness.pauseReply(gate.promise);
        const submitted = harness.submit("创建文字节点");
        await waitFor(() => harness.requests.some(request => request.type === "agent"));
        const request = harness.requests.find(request => request.type === "agent")!;
        harness[action]();
        expect(request.args[5].signal.aborted).toBe(true);
        gate.resolve();
        await submitted;
        expect(harness.snapshotRef.current.nodes).toEqual([]);
        expect(harness.requests).toHaveLength(1);
        expect(harness.messages().some(message => message.text.includes("must not appear"))).toBe(false);
    });

    test("stopping expires pending approval and stale approval handlers cannot mutate the canvas", async () => {
        const harness = panelHarness({ canManageConfig: true, confirmTools: true, replies: [tool("canvas_create_text_node", { text: "blocked" })] });
        await harness.submit("创建文字节点");
        const pending = harness.messages().find(message => message.detail?.status === "pending")!;
        const approve = harness.approvalHandler();
        harness.stop();
        approve(pending.id);
        await Promise.resolve();
        expect(harness.snapshotRef.current.nodes).toEqual([]);
        expect(harness.requests).toHaveLength(1);
        expect(harness.messages().find(message => message.id === pending.id)?.detail?.status).not.toBe("pending");
    });

    test("collapsing hides the panel without stopping an already authorized turn", async () => {
        const gate = Promise.withResolvers<void>();
        const harness = panelHarness({ replies: [tool("canvas_create_text_node", { text: "继续执行" }), { content: "已完成", toolCalls: [] }] });
        harness.pauseReply(gate.promise);
        const submitted = harness.submit("创建文字节点");
        await waitFor(() => harness.requests.length > 0);
        harness.close();
        expect(harness.requests[0].args[5].signal.aborted).toBe(false);
        gate.resolve(); await submitted;
        expect(harness.snapshotRef.current.nodes.some(node => node.metadata?.content === "继续执行")).toBe(true);
    });

    test("stopping after acceptance preserves original task identity and prevents later tool cycles", async () => {
        const gate = Promise.withResolvers<Array<{ id: string; dataUrl: string }>>();
        const harness = panelHarness({ taskLifecycle: true, generate: () => gate.promise,
            replies: [tool("edit_image", { prompt: "A red vase" }), tool("edit_image", { prompt: "A red vase" })] });
        const submitted = harness.submit("生成花瓶");
        await waitFor(() => harness.messages().some(message => (message.detail?.pendingTask as { taskIds?: string[] })?.taskIds?.includes("accepted-image")));
        const saved = harness.sessionCommits.find(commit => JSON.stringify(commit).includes("accepted-image"));
        expect(saved).toBeDefined();
        const image = harness.requests.find(request => request.type === "image")!;
        expect(image.args[2].cancelOnAbort()).toBe(false);
        harness.stop();
        gate.resolve([{ id: "late-image", dataUrl: "/api/assets/late/content" }]);
        await submitted;
        expect(harness.snapshotRef.current.nodes).toEqual([]);
        expect(harness.imageUploads).toEqual([]);
        expect(harness.requests.filter(request => request.type === "agent")).toHaveLength(1);
        const paused = harness.messages().find(message => message.detail?.pendingTask)!;
        expect(paused.detail?.status).toBe("paused");
        expect(paused.text).toContain("服务端任务可能继续");
        await harness.submit("生成花瓶");
        expect(harness.requests.filter(request => request.type === "image")).toHaveLength(1);
        expect(harness.messages().some(message => message.text.includes("相同请求的原任务尚未核实"))).toBe(true);
    });

    test("stopping an empty new conversation does not cancel an accepted task in another conversation", async () => {
        const gate = Promise.withResolvers<Array<{ id: string; dataUrl: string }>>();
        const harness = panelHarness({ taskLifecycle: true, generate: () => gate.promise, replies: [tool("edit_image", { prompt: "A red vase" })] });
        const submitted = harness.submit("生成花瓶");
        await waitFor(() => harness.messages().some(message => (message.detail?.pendingTask as { taskIds?: string[] })?.taskIds?.includes("accepted-image")) && !harness.composer().props.sending);
        const request = harness.requests.find(item => item.type === "image")!;
        harness.newChat();
        harness.stop();
        expect(request.args[2].signal.aborted).toBe(false);
        gate.resolve([{ id: "previous-conversation-image", dataUrl: "/api/assets/previous/content" }]);
        await submitted;
        expect(harness.snapshotRef.current.nodes.map(node => node.id)).toEqual(["previous-conversation-image"]);
        const final = harness.sessionCommits.at(-1)!;
        expect(final.sessions.find(session => session.id === final.activeId)?.messages).toEqual([]);
    });

    test("a download finishing after stop cannot write nodes, assets or completion messages", async () => {
        const download = Promise.withResolvers<UploadedImage>();
        const harness = panelHarness({ replies: [tool("edit_image", { prompt: "A red vase" })], storeImage: () => download.promise });
        const submitted = harness.submit("生成花瓶");
        await waitFor(() => harness.imageUploads.length === 1);
        harness.stop();
        download.resolve({ url: "/api/assets/late/content", storageKey: "cached", width: 100, height: 100, bytes: 5, mimeType: "image/png" });
        await submitted;
        expect(harness.snapshotRef.current.nodes).toEqual([]);
        expect(harness.assets).toEqual([]);
        expect(harness.messages().flatMap(message => message.attachments || [])).toEqual([]);
    });

    test.each([true, false])("persisted recovery controls use original metadata without exposing private prompts (task ID saved: %s)", async hasTaskId => {
        const task: generationTasks.QueuedTask = { id: "original-task", requestId: "original-request", status: "paused", upstreamTaskId: "original-upstream", resultUrls: [], failureReason: "下载失败" };
        const completed = { ...task, status: "success" as const, resultUrls: ["/api/assets/original-result/content"] };
        const calls: string[] = [];
        const pending: onlineTaskRecovery.PendingOnlineAgentTask = {
            ownerId: "owner", projectId: "project", requestId: task.requestId!, taskIds: hasTaskId ? [task.id] : undefined,
            mode: "image", prompt: "PRIVATE_PROVIDER_PROMPT", model: "gpt-image-2",
        };
        const harness = panelHarness({ userId: "owner", replies: [], history: [{
            id: "persisted-generation", role: "error", text: "下载失败，可查询原任务。",
            detail: { kind: "agent_generation", status: "paused", prompt: pending.prompt, pendingTask: pending },
        }], recoveryIO: {
            getQueuedTask: async id => { calls.push(`get:${id}`); return task; },
            getQueuedTaskByRequestId: async id => { calls.push(`request:${id}`); return task; },
            recoverQueuedTask: async id => { calls.push(`recover:${id}`); return { ...task, status: "waiting" }; },
            waitForTasks: async ids => { calls.push(`wait:${ids.join(",")}`); return [completed]; },
            uploadImage: async url => { calls.push(`store:${url}`); return { url, storageKey: "", width: 100, height: 100, bytes: 5, mimeType: "image/png" }; },
        } as NonNullable<Parameters<typeof onlineTaskRecovery.recoverOnlineAgentTask>[3]> });
        await harness.ready();
        expect(harness.messages()[0]!.detail?.pendingTask).toEqual(pending);
        expect(JSON.stringify(harness.displayedMessages())).not.toContain(pending.prompt);
        expect(harness.recoveryButtons()).toHaveLength(1);
        harness.recoveryButtons()[0]!.props.onClick();
        await waitFor(() => harness.messages().some(message => message.detail?.status === "completed"));
        expect(calls).toEqual([
            hasTaskId ? "get:original-task" : "request:original-request",
            "recover:original-task", "wait:original-task", "store:/api/assets/original-result/content",
        ]);
        expect(harness.requests).toEqual([]);
        expect(harness.snapshotRef.current.nodes.map(node => node.id)).toEqual(["agent-original-task-0"]);
        expect(harness.recoveryButtons()).toEqual([]);
        expect(JSON.stringify(harness.displayedMessages())).not.toContain(pending.prompt);
        expect(harness.messages()[0]!.text).toContain("没有重新生成");
    });
});

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
    test.each([4, 5])("document continuation respects five-image budget with %s working images and preserves focus", async count => {
        const selected: CanvasNodeData[] = Array.from({ length: count }, (_, index) => ({ id: `source-${index}`, type: CanvasNodeType.Image, title: `原图${index}`, position: { x: index * 210, y: 0 }, width: 200, height: 200, metadata: { content: `data:image/png;base64,${Buffer.from(`source-${index}`).toString("base64")}`, status: "success" } }));
        const figures = Array.from({ length: 3 }, (_, index) => ({ id: `figure-${index}`, label: `文件图${index}`, sectionId: "section", name: `page-${index}.png`, mimeType: "image/png", dataUrl: `data:image/png;base64,${Buffer.from(`figure-${index}`).toString("base64")}` }));
        const document: NonNullable<CanvasAssistantSession["documents"]>[number] = { id: "brief", name: "brief.docx", kind: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: 42, sections: [{ id: "section", title: "结构", text: "红色无口袋开衫", figureIds: figures.map(figure => figure.id) }], figures, warnings: [] };
        const harness = panelHarness({ selected, documents: [document], replies: [tool("read_document", { document_id: "brief", section_start: 1, section_count: 1 }), { content: "已查阅可见内容，缺失图仍待确认。", toolCalls: [] }] });
        await harness.submit("整理需求，不更换当前底图");
        const calls = harness.requests.filter(request => request.type === "agent");
        expect(calls).toHaveLength(2);
        const images = (messages: any[]) => messages.flatMap(message => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url) : []);
        const initialImages = images(calls[0].args[1]), continuedImages = images(calls[1].args[1]);
        expect(initialImages).toHaveLength(5);
        expect(continuedImages).toHaveLength(5);
        for (const node of selected) expect(continuedImages).toContain(node.metadata?.content);
        expect(calls[1].args[5].profileContext.focusImageId).toBe(calls[0].args[5].profileContext.focusImageId);
        expect(calls[1].args[5].profileContext.lockedImageId).toBe(calls[0].args[5].profileContext.lockedImageId);
        expect(calls[1].args[1].at(-1).content).toBe("整理需求，不更换当前底图");
        expect(JSON.stringify(calls[1].args[1])).toContain("以下文件图未展示");
        expect(JSON.stringify(calls[1].args[1])).toContain("不得把未展示图片视为已看");
        if (count === 4) expect(JSON.stringify(calls[1].args[1])).toContain("仅查阅，未选为出图参考");
        expect(harness.requests.some(request => ["image", "edit"].includes(request.type))).toBe(false);
    });

    test("new canvas image defaults reach the task as 2K / high while explicit choices remain unchanged", async () => {
        for (const quality of ["", "low"]) {
            const harness = panelHarness({ config: { imageModel: "gpt-image-2.6-flare", quality, imageOptions: quality ? '{"resolution":"1k"}' : "" }, replies: [tool("edit_image", { base: "none", prompt: "红色花瓶" })] });
            await harness.submit("制作红色花瓶");
            const image = harness.requests.find(request => request.type === "image");
            expect(image).toBeDefined();
            expect(image!.args[0]).toMatchObject({ quality: quality || "high", count: "1" });
            expect(JSON.parse(image!.args[0].imageOptions).resolution).toBe(quality ? "1k" : "2k");
        }
    });

    test.each([false, true])("ordinary image dispatch without confirmed requirements reaches the strict serializer (edit=%s)", async editing => {
        const selected: CanvasNodeData = { id: "source", type: CanvasNodeType.Image, title: "原图", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "data:image/png;base64,cmVm", status: "success" } };
        const draft: CanvasAssistantSession["requirementCard"] = { id: "draft", status: "draft", updatedAt: "now", title: "草稿", documentIds: [], subject: "花瓶", colors: "红色", materials: "陶瓷", must: [], avoid: [], unknowns: [], referenceFigureIds: [], sources: [] };
        for (const requirementCard of [undefined, draft]) {
            const harness = panelHarness({ requirementCard, selected: editing ? [selected] : [], replies: [tool("edit_image", { base: editing ? "focus" : "none", prompt: "红色花瓶" })] });
            await harness.submit("制作红色花瓶");
            const image = harness.requests.find(request => request.type === (editing ? "edit" : "image"));
            expect(image).toBeDefined();
            const options = image!.args[editing ? 4 : 2];
            expect(options).not.toHaveProperty("imageAgentRequirements");
            expect(options).not.toHaveProperty("imageAgentDocumentCatalog");
            expect(harness.messages().flatMap(message => message.attachments || [])).toHaveLength(1);
        }
    });

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
        expect(harness.composer().props.prompt).toBe("用户正在修改的文字");
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
        expect(harness.composer().props.generationControls.props.settings).toMatchObject({ imageModel: "gpt-image-2", size: "1152x1536", quality: "high", imageCount: "1" });
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
            const harness = panelHarness({ replies: [tool("edit_image", { prompt: "must not submit" })], ...unavailable });
            expect(harness.composer().props.disabled).toBe(true);
            harness.composer().props.onPromptChange("不要穿过停用状态提交");
            await harness.composer().props.onSubmit();
            expect(harness.requests).toHaveLength(0);
            expect(harness.snapshotRef.current.nodes).toEqual([]);
        }
    });

    test("viewport media is opt-in and only selected image previews enter the planner", async () => {
        const logo: CanvasNodeData = { id: "logo", type: CanvasNodeType.Image, title: "素材 A", position: { x: 20, y: 20 }, width: 200, height: 200, metadata: { content: "blob:logo" } };
        const hidden = { ...logo, id: "offscreen", position: { x: 3000, y: 0 } };
        const clip = { ...logo, id: "clip", type: CanvasNodeType.Video };
        const harness = panelHarness({ nodes: [logo, hidden, clip], replies: [{ content: "先聊天", toolCalls: [] }, { content: "已看到可见图片", toolCalls: [] }] });
        await harness.submit("先聊一聊");
        const imageParts = (request: typeof harness.requests[number]) => request.args[1].flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "image_url") : []);
        expect(imageParts(harness.requests[0])).toEqual([]);
        harness.toggleContext();
        await harness.submit("现在看看画布可见图");
        expect(imageParts(harness.requests[1])).toHaveLength(1);
        expect(imageParts(harness.requests[1])[0].image_url.url).toBe("data:image/jpeg;base64,bG9nbw==");
        const viewed = harness.messages().filter(message => message.role === "user").at(-1)!;
        expect(viewed.contextReferences).toHaveLength(1);
        expect(viewed.contextReferences?.[0].title).toBe("素材 A");
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

    test("an older parent echo cannot erase a media failure while its completed turn is saving", async () => {
        const read = Promise.withResolvers<string>(), saved = Promise.withResolvers<void>();
        const selected: CanvasNodeData = { id: "source", type: CanvasNodeType.Image, title: "原图", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "blob:source" } };
        const harness = panelHarness({ replies: [], selected: [selected], readImage: () => read.promise });
        harness.pauseCommit(saved.promise);
        const submitted = harness.submit("只把原图改成蓝色");
        await waitFor(() => harness.imagePreviewReads.length === 1);
        harness.composer();
        const earlierUpdate = harness.sessionUpdates.length - 1;
        expect(JSON.stringify(harness.sessionUpdates[earlierUpdate])).toContain("只把原图改成蓝色");
        read.reject(new Error("画布媒体不可读取"));
        await waitFor(() => harness.sessionCommits.length === 1);
        expect(harness.messages().some(message => message.role === "error" && message.text === "画布媒体不可读取")).toBe(true);
        harness.echoUpdate(earlierUpdate);
        expect(harness.messages().some(message => message.role === "error" && message.text === "画布媒体不可读取")).toBe(true);
        expect(harness.composer().props.prompt).toBe("只把原图改成蓝色");
        expect(JSON.stringify(harness.sessionUpdates.at(-1))).toContain("画布媒体不可读取");
        expect(harness.requests).toEqual([]);
        saved.resolve(); await submitted;
        harness.echoCommit();
        expect(harness.messages().some(message => message.text === "画布媒体不可读取")).toBe(true);
    });

    test("an acknowledged snapshot can later be explicitly restored without blocking external history", async () => {
        const harness = panelHarness({ replies: [{ content: "完整回复", toolCalls: [] }] });
        await harness.submit("保留这轮");
        harness.echoCommit();
        const acknowledged = harness.sessionCommits.at(-1)!;
        harness.newChat(); harness.composer();
        expect(harness.sessionIds()).toHaveLength(2);
        harness.echoUpdate(harness.sessionUpdates.length - 1);
        harness.restoreSessions(acknowledged.sessions, acknowledged.activeId);
        expect(harness.sessionIds()).toEqual(acknowledged.sessions.map(session => session.id));
        expect(harness.messages().some(message => message.text === "完整回复")).toBe(true);
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


    test("waits for image output and finishes a write without a paid planner-summary call", async () => {
        const gate = Promise.withResolvers<Array<{ id: string; dataUrl: string }>>();
        const harness = panelHarness({ replies: [tool("edit_image", { base: "none", prompt: "静态海报：电影镜头与相机" })], generate: () => gate.promise });
        const submitted = harness.submit("生成静态海报：电影镜头与相机");
        await waitFor(() => harness.requests.some(request => request.type === "image"));
        expect(harness.requests.filter(request => request.type === "agent")).toHaveLength(1);
        expect(harness.messages().some(message => message.attachments?.length)).toBe(false);
        gate.resolve([{ id: "generated-image", dataUrl: "/api/assets/result/content" }]);
        await submitted;
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "image"]);
        expect(harness.requests[1].args[0]).toMatchObject({ model: "gpt-image-2", count: "1", size: "1152x1536", quality: "high" });
        expect(harness.messages().flatMap(message => message.attachments || [])).toContainEqual(expect.objectContaining({ id: "generated-image", mediaType: "image", width: 1024, height: 1024 }));
        expect(harness.snapshotRef.current.nodes.find(node => node.type === CanvasNodeType.Image)).toMatchObject({ width: 340, height: 340 });
    });

    test("uploaded and selected references reach both the planner and exact edit inputs", async () => {
        const selected: CanvasNodeData = { id: "selected", type: CanvasNodeType.Image, title: "原款", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "data:image/png;base64,SELECTED", storageKey: "image:selected", status: "success" } };
        const harness = panelHarness({ selected: [selected], replies: [tool("edit_image", { prompt: "保留原款，只改背景", references: [] })] });
        await harness.uploadReference();
        await harness.submit("按两张图改背景");
        const planner = harness.requests.find(request => request.type === "agent")!;
        const previews = planner.args[1].flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "image_url") : []);
        expect(previews).toHaveLength(2);
        const edit = harness.requests.find(request => request.type === "edit")!;
        expect(edit.args[2]).toHaveLength(2);
        expect(edit.args[2][0].storageKey).toBe("image:selected");
        expect(edit.args[2][1].name).toBe("uploaded-reference.png");
        expect(edit.args[1]).toContain("修改底图");
        expect(edit.args[1]).toContain("参考图");
        expect(harness.requests.filter(request => request.type === "text")).toEqual([]);
    });

    test.each([
        ["unknown field", { editIntent: "new" }],
        ["model override", { model: "other-provider" }],
        ["multiple outputs", { count: 7 }],
        ["legacy contract", { editContract: { mode: "complete" } }],
        ["invalid base", { base: 12 }],
        ["invalid keep", { keep: [""] }],
        ["oversized note", { note_update: "x".repeat(801) }],
        ["empty prompt", { prompt: "" }],
    ] as const)("invalid edit parameters allow one typed planning repair, then stop before every write: %s", async (_name, invalid) => {
        const invalidPlan = tool("edit_image", { prompt: "红色花瓶", ...invalid });
        invalidPlan.toolCalls.unshift({ ...tool("canvas_create_text_node", { title: "必须拦截", text: "invalid plan must not write" }).toolCalls[0], id: "blocked-write" });
        const harness = panelHarness({ replies: [invalidPlan, invalidPlan, tool("edit_image", { prompt: "must not reach a third plan" })] });
        await harness.submit("生成红色花瓶");
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "agent"]);
        const [initial, repaired] = harness.requests.map(request => request.args[5].profileContext);
        expect(initial.stage).toBe("plan");
        expect(initial.repairIssue).toBeUndefined();
        expect(repaired).toEqual({ ...initial, stage: "repair", repairIssue: {
            code: "IMAGE_AGENT_ARGUMENTS_INVALID", message: expect.any(String), repairable: true, submitted: false,
        } });
        expect(harness.messages()).toContainEqual(expect.objectContaining({ role: "error", title: "操作失败", text: repaired.repairIssue.message }));
        expect(harness.snapshotRef.current.nodes).toEqual([]);
        expect(harness.assets).toEqual([]);
        expect(harness.imageUploads).toEqual([]);
    });

    test.each([
        ["unknown image", { base: "missing-image" }, "指定的图片已不在当前作品中，请重新选择；本次尚未提交生成。"],
        ["unknown reference", { references: ["missing-image"] }, "有一张参考图已不可用，请重新选择；尚未提交生成。"],
    ] as const)("unavailable edit sources never trigger planning repair or media submission: %s", async (_name, invalid, reason) => {
        const harness = panelHarness({ replies: [tool("edit_image", { prompt: "红色花瓶", ...invalid }), tool("edit_image", { prompt: "must not retry" })] });
        await harness.submit("生成红色花瓶");
        expect(harness.requests.map(request => request.type)).toEqual(["agent"]);
        expect(harness.requests[0].args[5].profileContext.repairIssue).toBeUndefined();
        expect(harness.messages()).toContainEqual(expect.objectContaining({ role: "error", title: "操作失败", text: reason }));
        expect(harness.snapshotRef.current.nodes).toEqual([]);
        expect(harness.assets).toEqual([]);
        expect(harness.imageUploads).toEqual([]);
    });

    test("a valid planning correction submits one authorized image without replaying invalid sibling writes or model overrides", async () => {
        const invalidPlan = tool("edit_image", { prompt: "红色花瓶", model: "other-provider", count: 7 });
        invalidPlan.toolCalls.unshift({ ...tool("canvas_create_text_node", { title: "必须拦截", text: "invalid plan must not write" }).toolCalls[0], id: "blocked-write" });
        const harness = panelHarness({ replies: [invalidPlan, tool("edit_image", { prompt: "红色花瓶" }), tool("edit_image", { prompt: "must not repeat generation" })] });
        await harness.submit("生成红色花瓶");
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "agent", "image"]);
        const [initial, repaired] = harness.requests.slice(0, 2).map(request => request.args[5].profileContext);
        expect(initial.stage).toBe("plan");
        expect(repaired).toEqual({ ...initial, stage: "repair", repairIssue: {
            code: "IMAGE_AGENT_ARGUMENTS_INVALID", message: expect.any(String), repairable: true, submitted: false,
        } });
        const generated = harness.requests[2];
        expect(generated.args[0]).toMatchObject({ model: "gpt-image-2", count: "1" });
        expect(generated.args[1]).toContain("红色花瓶");
        expect(harness.snapshotRef.current.nodes).toHaveLength(1);
        expect(harness.snapshotRef.current.nodes[0].type).toBe(CanvasNodeType.Image);
        expect(harness.assets).toHaveLength(1);
        expect(harness.messages().some(message => message.role === "error")).toBe(false);
    });

    test("draft reorder keeps the planner preview order and binds edit inputs explicitly with the base first", async () => {
        const selected: CanvasNodeData = { id: "selected", type: CanvasNodeType.Image, title: "原款", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "data:image/png;base64,c2VsZWN0ZWQ=", status: "success" } };
        const harness = panelHarness({ selected: [selected], replies: [tool("edit_image", { prompt: "按参考花型改原款，其他不变" })] });
        await harness.uploadReference("print.png", "data:image/png;base64,cHJpbnQ=");
        const first = harness.referenceTray();
        first.onMove(first.references[1].id, first.references[0].id);
        await harness.uploadReference("remove.png", "data:image/png;base64,cmVtb3Zl");
        const three = harness.referenceTray();
        three.onRemove(three.references[2].id);
        const submittedIds = harness.referenceTray().references.map((reference: any) => reference.id);
        await harness.submit("按花型图修改衣服");
        expect(harness.messages().find(message => message.role === "user")!.references?.map(reference => reference.id)).toEqual(submittedIds);
        const previews = harness.requests[0].args[1].flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url) : []);
        expect(previews).toEqual(["data:image/png;base64,cHJpbnQ=", "data:image/png;base64,c2VsZWN0ZWQ="]);
        const edit = harness.requests.find(request => request.type === "edit")!;
        expect(edit.args[2].map((reference: any) => reference.dataUrl)).toEqual(["data:image/png;base64,c2VsZWN0ZWQ=", "data:image/png;base64,cHJpbnQ="]);
        expect(harness.imageSizeReads).toEqual([edit.args[2][0].id]);
        expect(edit.args[1]).toContain("输入图1对应图2（修改底图）");
        expect(edit.args[1]).toContain("输入图2对应图1（参考图）");
    });

    test("a read-only canvas scan and image inspection can precede one real edit", async () => {
        const image: CanvasNodeData = { id: "offscreen", type: CanvasNodeType.Image, title: "屏外图", position: { x: 5000, y: 0 }, width: 200, height: 200, metadata: { content: "data:image/png;base64,OFFSCREEN" } };
        const harness = panelHarness({ nodes: [image], replies: [
            tool("canvas_get_state", {}),
            tool("look_at_images", { image_ids: ["offscreen"] }),
            tool("edit_image", { base: "canvas-image:offscreen", prompt: "背景改白" }),
        ] });
        await harness.submit("找到画布的屏外图并修改");
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "agent", "agent", "edit"]);
        const previews = harness.requests[2].args[1].flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "image_url") : []);
        expect(previews).toHaveLength(1);
        expect(previews[0].image_url.url).toBe("data:image/png;base64,OFFSCREEN");
        expect(harness.requests[3].args[2][0].dataUrl).toBe("data:image/png;base64,OFFSCREEN");
    });

    test("Midjourney keeps a supported reference and the user's model", async () => {
        const harness = panelHarness({ config: { imageModel: "midjourney-v7" }, replies: [tool("edit_image", { prompt: "修改背景" })] });
        await harness.uploadReference();
        await harness.submit("用 Midjourney 修改这张图");
        const edit = harness.requests.find(request => request.type === "edit")!;
        expect(edit.args[0]).toMatchObject({ model: "midjourney-v7", count: "1" });
        expect(edit.args[2]).toHaveLength(1);
        expect(edit.args[2][0].name).toBe("uploaded-reference.png");
    });

    test("Midjourney Blend uses two references and one output without a fabricated prompt", async () => {
        const selected: CanvasNodeData = { id: "selected-reference", type: CanvasNodeType.Image, title: "原款", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "data:image/png;base64,cmVm", status: "success" } };
        const harness = panelHarness({ config: { imageModel: "midjourney-blend", quality: "turbo" }, selected: [selected], replies: [tool("edit_image", { prompt: "合成这两张图" })] });
        await harness.uploadReference();
        await harness.submit("用 Blend 合成");
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "image"]);
        const image = harness.requests[1];
        expect(image.args[0]).toMatchObject({ model: "midjourney-blend", count: "1", quality: "turbo" });
        expect(image.args[1]).toBe("");
        expect(image.args[2]).toMatchObject({ tool: "canvas-image" });
        expect(image.args[3]).toHaveLength(2);
    });

    test("Chinese final prompts stay visible and dispatch without translation or hidden recipe text", async () => {
        const harness = panelHarness({ replies: [tool("edit_image", { prompt: "背景改成纯白，保留针织纹理", keep: ["保留主体比例"], note_update: "白背景针织包" })] });
        await harness.uploadReference();
        await harness.submit("背景改白色");
        const edit = harness.requests.find(request => request.type === "edit")!;
        expect(edit.args[1]).toContain("背景改成纯白，保留针织纹理");
        expect(edit.args[1]).toContain("保留主体比例");
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "edit"]);
        expect(harness.messages().some(message => message.detail?.prompt === edit.args[1])).toBe(true);
        expect(edit.args[0].systemPrompt).toBe("");
    });

    test("a media failure ends the turn without another planner or image submission", async () => {
        const harness = panelHarness({ replies: [tool("edit_image", { prompt: "绿色花瓶" }), tool("edit_image", { prompt: "must not retry" })], generate: async () => { throw new Error("provider failed"); } });
        await harness.submit("生成花瓶");
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "image"]);
        expect(harness.assets).toEqual([]);
        expect(harness.messages().some(message => message.role === "error" && message.text.includes("provider failed"))).toBe(true);
    });

    test("multiple media calls reject the whole batch before any write", async () => {
        const first = tool("edit_image", { prompt: "红色花瓶" });
        first.toolCalls.push({ ...tool("generate_video", { prompt: "花瓶旋转" }).toolCalls[0], id: "second" });
        const harness = panelHarness({ replies: [first] });
        await harness.submit("生成图片和视频");
        expect(harness.requests.map(request => request.type)).toEqual(["agent"]);
        expect(harness.snapshotRef.current.nodes).toEqual([]);
        expect(harness.messages().some(message => message.text.includes("单轮只允许提交一个生成任务"))).toBe(true);
    });

    test("ordinary canvas operations finish without image, video, or planner-summary requests", async () => {
        const harness = panelHarness({ replies: [tool("canvas_create_text_node", { text: "项目说明", title: "说明" })] });
        await harness.submit("创建文本说明");
        expect(harness.requests.map(request => request.type)).toEqual(["agent"]);
        expect(harness.snapshotRef.current.nodes).toEqual([expect.objectContaining({ type: CanvasNodeType.Text, title: "说明", metadata: expect.objectContaining({ content: "项目说明" }) })]);
    });

    test.each([false, true])("ordinary users ignore the extra confirmation flag on initial and continuation writes (read first=%s)", async readFirst => {
        const harness = panelHarness({ confirmTools: true, replies: [
            ...(readFirst ? [tool("canvas_get_state", {})] : []),
            tool("canvas_create_text_node", { text: "直接执行", title: "说明" }),
        ] });
        await harness.submit("创建文本说明");
        expect(harness.snapshotRef.current.nodes).toHaveLength(1);
        expect(harness.messages().some(message => message.detail?.status === "pending")).toBe(false);
        expect(harness.requests.every(request => request.type === "agent")).toBe(true);
    });

    for (const canManageConfig of [false, true]) for (const confirmTools of [false, true]) {
        test.each([false, true])(`deletion still needs approval (admin=${canManageConfig}, flag=${confirmTools}, read first=%s)`, async readFirst => {
            const node: CanvasNodeData = { id: "delete-target", type: CanvasNodeType.Text, title: "待删除说明", position: { x: 0, y: 0 }, width: 200, height: 120 };
            const harness = panelHarness({ canManageConfig, confirmTools, nodes: [node], replies: [
                ...(readFirst ? [tool("canvas_get_state", {})] : []),
                tool("canvas_delete_nodes", { ids: [node.id] }),
            ] });
            await harness.submit("删除说明节点");
            expect(harness.snapshotRef.current.nodes).toEqual([node]);
            const pending = harness.messages().find(message => message.detail?.status === "pending")!;
            expect(pending.detail?.preview).toEqual([expect.objectContaining({ destructive: true, count: 1, nodes: [expect.objectContaining({ id: node.id, title: node.title })] })]);
            harness.approve(pending.id);
            await waitFor(() => harness.messages().find(message => message.id === pending.id)?.detail?.status === "completed");
            expect(harness.snapshotRef.current.nodes).toHaveLength(0);
            expect(harness.requests.every(request => request.type === "agent")).toBe(true);
        });
    }

    test.each([false, true])("preserves opaque Responses output across read steps and stops after a write (confirm=%s)", async confirmTools => {
        const response = (turn: number, name: string, args: Record<string, unknown>): ToolResponseResult => {
            const call = { id: `call-${turn}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
            return { content: "", toolCalls: [call], responsesOutputItems: [
                { type: "reasoning", id: `rs-${turn}`, status: "completed", summary: [], encrypted_content: `opaque-${turn}` },
                { type: "function_call", id: `fc-${turn}`, call_id: call.id, name, arguments: call.function.arguments, status: "completed" },
            ] };
        };
        const first = response(1, "canvas_get_state", {});
        const second = response(2, "canvas_get_selection", {});
        const harness = panelHarness({ canManageConfig: true, confirmTools, replies: [first, second, response(3, "canvas_create_text_node", { text: "三步完成" })] });
        await harness.submit("读取状态并创建说明");
        if (confirmTools) {
            const pending = harness.messages().find(message => message.detail?.status === "pending")!;
            expect(harness.snapshotRef.current.nodes).toHaveLength(0);
            harness.approve(pending.id);
            await waitFor(() => harness.messages().find(message => message.id === pending.id)?.detail?.status === "completed");
        }
        const requests = harness.requests.filter(request => request.type === "agent");
        expect(requests).toHaveLength(3);
        expect(requests[1].args[1].slice(-2)).toEqual([{ type: "responses_assistant", output: first.responsesOutputItems }, expect.objectContaining({ role: "tool", tool_call_id: "call-1" })]);
        expect(requests[2].args[1].slice(0, requests[1].args[1].length)).toEqual(requests[1].args[1]);
        expect(requests[2].args[1].slice(-2)).toEqual([{ type: "responses_assistant", output: second.responsesOutputItems }, expect.objectContaining({ role: "tool", tool_call_id: "call-2" })]);
        expect(harness.snapshotRef.current.nodes).toHaveLength(1);
        expect(JSON.stringify(harness.messages())).not.toContain("opaque-");
    });

    test("explicit run_generation operations execute once and connect real outputs", async () => {
        const harness = panelHarness({ replies: [tool("canvas_apply_ops", { ops: [
            { type: "add_node", id: "image-config", nodeType: "config", metadata: { generationMode: "image", prompt: "红色花瓶", count: 1, size: "1:1", quality: "1k" } },
            { type: "run_generation", nodeId: "image-config", mode: "image", prompt: "红色花瓶" },
        ] })] });
        await harness.submit("创建图片生成节点并执行");
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "image"]);
        expect(harness.snapshotRef.current.nodes.find(node => node.id === "image-config")?.metadata?.status).toBe("success");
        expect(harness.snapshotRef.current.connections).toContainEqual(expect.objectContaining({ fromNodeId: "image-config", toNodeId: "generated-image" }));
    });

    test("explicit video tools preserve duration, ratio, quality, audio and reference pixels", async () => {
        const harness = panelHarness({ replies: [tool("generate_video", { prompt: "花瓶缓慢旋转", seconds: "8", size: "16:9", vquality: "720P" })] });
        await harness.uploadReference();
        await harness.submit("生成视频");
        const video = harness.requests.find(request => request.type === "video")!;
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "video"]);
        expect(video.args[0]).toMatchObject({ model: "MiniMax-H3", videoSeconds: "8", size: "16:9", vquality: "720P", videoGenerateAudio: "true" });
        expect(video.args[2]).toHaveLength(1);
        expect(video.args[2][0].name).toBe("uploaded-reference.png");
    });

    test("video submission freezes its ratio while the planner waits and composer settings change", async () => {
        const gate = Promise.withResolvers<void>();
        const harness = panelHarness({ confirmTools: true, replies: [tool("generate_video", { prompt: "花瓶旋转" })] });
        harness.pauseReply(gate.promise);
        const submitted = harness.submit("生成花瓶旋转视频");
        await waitFor(() => harness.requests.some(request => request.type === "agent"));
        harness.composer().props.generationControls.props.onChange({ mode: "video", size: "1:1" });
        harness.composer().props.generationControls.props.onChange({ size: "16:9" });
        gate.resolve();
        await submitted;
        expect(harness.requests.find(request => request.type === "video")!.args[0].size).toBe("3:4");
        expect(harness.composer().props.generationControls.props.settings.size).toBe("16:9");
        expect(harness.messages().some(message => message.detail?.status === "pending")).toBe(false);
    });

    test("paused video preserves original identity without retry or local outputs", async () => {
        const paused = new QueuedTaskPausedError({ id: "paused-video", requestId: "video-request", operationType: "video_generation", status: "paused", upstreamTaskId: "upstream-video", resultUrls: [], failureReason: "查询超时" });
        const harness = panelHarness({ replies: [tool("generate_video", { prompt: "花瓶旋转" }), tool("generate_video", { prompt: "must not retry" })], video: async () => { throw paused; } });
        await harness.submit("生成视频");
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "video"]);
        expect(harness.messages().find(message => message.role === "error")?.detail).toMatchObject({ status: "paused", taskId: "paused-video", canRecover: true, resubmitAllowed: false });
        expect(harness.assets).toEqual([]);
        expect(harness.videoStores).toEqual([]);
    });

    test("image assets reuse original server identity and one local media copy", async () => {
        const serverAssetId = "7075c394-1184-44cc-9077-068d78e8b36d";
        const url = `/api/assets/${serverAssetId}/content`;
        const harness = panelHarness({ replies: [tool("edit_image", { prompt: "绿色花瓶" })], generate: async () => [{ id: "green-vase", dataUrl: url }], storedImage: { url: "blob:cached-image", storageKey: "image:cached", width: 1024, height: 1024, bytes: 12345, mimeType: "image/png" } });
        await harness.submit("生成绿色花瓶");
        expect(harness.imageUploads).toEqual([url]);
        expect(harness.assets).toHaveLength(1);
        expect(harness.assets[0]).toMatchObject({ kind: "image", data: { dataUrl: "blob:cached-image", storageKey: "image:cached" }, metadata: { serverAssetId, nodeId: "green-vase", projectId: "project", prompt: "绿色花瓶", model: "gpt-image-2" } });
        expect(serverAssetIdFromAsset(harness.assets[0])).toBe(serverAssetId);
    });

    test("video persistence shares dimensions and server identity with canvas and assets", async () => {
        const serverAssetId = "7075c394-1184-44cc-9077-068d78e8b36d";
        const url = `/api/assets/${serverAssetId}/content`;
        const harness = panelHarness({ replies: [tool("generate_video", { prompt: "花瓶缓慢旋转" })], video: async () => ({ url, mimeType: "video/mp4" }), storedVideo: { url: "blob:cached-video", storageKey: "video:cached", width: 768, height: 768, bytes: 2048, mimeType: "video/mp4", serverAssetId } });
        await harness.submit("生成视频");
        expect(harness.videoStores).toEqual([{ url, mimeType: "video/mp4" }]);
        expect(harness.assets).toHaveLength(1);
        expect(harness.assets[0]).toMatchObject({ kind: "video", data: { url: "blob:cached-video", storageKey: "video:cached", width: 768, height: 768 }, metadata: { serverAssetId, prompt: "花瓶缓慢旋转" } });
        expect(harness.snapshotRef.current.nodes.find(node => node.type === CanvasNodeType.Video)).toMatchObject({ width: 340, height: 340, metadata: { content: "blob:cached-video", storageKey: "video:cached" } });
        expect(harness.messages().flatMap(message => message.attachments || [])).toContainEqual(expect.objectContaining({ storageKey: "video:cached", serverAssetId }));
    });

    test("duplicate approvals consume one authorization and cannot submit twice", async () => {
        const gate = Promise.withResolvers<Array<{ id: string; dataUrl: string }>>();
        const harness = panelHarness({ canManageConfig: true, confirmTools: true, replies: [tool("canvas_apply_ops", { ops: [
            { type: "add_node", id: "green-config", nodeType: "config", metadata: { generationMode: "image", prompt: "绿色花瓶" } },
            { type: "run_generation", nodeId: "green-config", mode: "image", prompt: "绿色花瓶" },
        ] })], generate: () => gate.promise });
        await harness.submit("生成绿色花瓶");
        const pending = harness.messages().find(message => message.detail?.status === "pending")!;
        const approve = harness.approvalHandler();
        approve(pending.id);
        approve(pending.id);
        await waitFor(() => harness.requests.some(request => request.type === "image"));
        expect(harness.messages().find(message => message.id === pending.id)?.detail?.status).toBe("running");
        expect(harness.messages().some(message => message.text.includes("工具上下文不完整"))).toBe(false);
        expect(harness.requests.filter(request => request.type === "image")).toHaveLength(1);
        gate.resolve([{ id: "green-vase", dataUrl: "/api/assets/green-vase/content" }]);
        await waitFor(() => harness.messages().find(message => message.id === pending.id)?.detail?.status === "completed");
        expect(harness.requests.map(request => request.type)).toEqual(["agent", "image"]);
    });
});
