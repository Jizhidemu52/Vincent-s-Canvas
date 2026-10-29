import { useUiText, uiText, useUiLocale } from "@/lib/i18n";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import copyToClipboard from "copy-to-clipboard";
import { Bot, Copy, Cpu, History, ImageIcon, Maximize2, MoreHorizontal, PanelLeft, PanelRightClose, Plus, Settings2, Trash2, Video, X } from "lucide-react";
import { Button, Dropdown, Modal, Popover, Segmented, Switch, Tooltip } from "antd";
import { motion } from "motion/react";

import { modelOptionName, normalizeModelOptionValue, selectableModelsByCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { imageModelDisplayName, imageModelIdentityHidden } from "@/lib/model-display";
import { preferredImageModel } from "@/lib/default-image-model";
import { ModelPicker } from "@/components/model-picker";
import { CanvasPanelSizeControl } from "@/components/canvas/canvas-panel-size-control";
import { ConversationImageTarget, conversationImageLabel, type ConversationImageAction, type ConversationImageItem } from "@/components/conversation-image-controls";
import { useConversationImageTools } from "@/hooks/use-conversation-image-tools";
import { getModelPickerOptions, resolveModelPickerSource } from "@/lib/model-picker-options";
import { standaloneEdition } from "@/lib/standalone-edition";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { canvasToolKey, useToolConfig, useToolEnabled } from "@/hooks/use-tool-config";
import { useModuleEnabled } from "@/stores/use-module-store";
import { resolveToolConfig } from "@/services/api/tool-runtime";
import { canvasThemes } from "@/lib/canvas-theme";
import { nanoid } from "nanoid";
import { requestEdit, requestGeneration, requestImageQuestion, requestToolResponse, toolResponseToInput, type AiTextMessage, type ClaudeAssistantContent, type ResponseInputMessage, type ResponseToolCall, type ToolResponseResult } from "@/services/api/image";
import { imageToDataUrl, uploadImage } from "@/services/image-storage";
import { requestVideoGeneration, storeGeneratedVideo, type VideoGenerationTask } from "@/services/api/video";
import { requestAudioGeneration, storeGeneratedAudio } from "@/services/api/audio";
import { serverAssetIdFromAsset, useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { moveImageReference } from "@/lib/image-reference-policy";
import { CanvasQuickReferenceTray } from "./canvas-quick-reference-tray";
import { DiaTextReveal } from "@/components/ui/dia-text-reveal";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasAgentMediaWorkflowCard } from "./canvas-agent-media-workflow-card";
import { CanvasPersistedMediaPreview } from "./canvas-persisted-media-preview";
import { AgentChatComposer, AgentChatMessage, AgentModeSwitch, AgentPanelTabs, AgentWorkingMessage, type CanvasAgentChatAttachment, type CanvasAgentChatImageControl, type CanvasAgentMode } from "./canvas-agent-chat-ui";
import { CanvasLocalAgentPanel } from "./canvas-local-agent-panel";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { useCanManageConfig } from "@/hooks/use-can-manage-config";
import { CanvasNodeType, type CanvasAgentMediaWorkflow, type CanvasAssistantAttachment, type CanvasAssistantMessage, type CanvasAssistantReference, type CanvasAssistantSession, type CanvasNodeData } from "@/types/canvas";
import { useCanvasAgentStore } from "@/stores/canvas/use-canvas-agent-store";
import { summarizeCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { classifyAgentMediaIntent, resolveAgentMediaToolDispatch } from "@/lib/canvas/agent-media-workflow";
import { agentQuickstartPreset, buildAgentGeneratedMediaOps, buildAgentGenerationBrief, buildAgentGenerationPlan, buildAgentReferenceImageContent, buildAgentVideoPrompt, createAgentVideoConfirmation, normalizeAgentImageSettings, normalizeAgentVideoSettings, resolveAgentGeneratedMediaPosition, selectAgentVideoReferences, type AgentGenerationSettings, type AgentVideoConfirmation } from "@/lib/agent-direct-generation";
import { imageModelProfile, useImageModelProfile } from "@/lib/image-model-settings";
import { getVideoModelParameterSpec } from "@/lib/video-model-parameters";
import { getGenerationCapabilities, getImageGenerationModels, QueuedTaskFailedError, QueuedTaskPausedError, type GenerationCapabilityModel, type ImageGenerationModel } from "@/services/api/generation-tasks";
import type { ReferenceImage } from "@/types/image";
import { canvasAssistantPanelPropsEqual, type CanvasAssistantPanelRenderState, type CanvasMediaWorkflowAction } from "@/lib/canvas/canvas-assistant-panel-render-stability";
import { CANVAS_AGENT_PANEL_MOTION_MS } from "@/lib/canvas/canvas-agent-panel-constants";
import { agentMessageWindow, DEFAULT_AGENT_MESSAGE_WINDOW, expandAgentMessageWindow } from "@/lib/canvas/agent-message-window";
import { executeOnlineAgentOperations, onlineAgentConfig, onlineAgentMediaSettings } from "@/lib/canvas/online-agent-execution";
import { buildNodeGenerationContext, buildNodeResponseMessages, hydrateNodeGenerationContext } from "./canvas-node-generation";
import { buildCanvasAssistantContext } from "@/lib/canvas/canvas-assistant-context";
import { captureCanvasContextSnapshot, readCanvasContextImage, readCanvasContextVideo, readCanvasConversationImage } from "@/lib/canvas/canvas-assistant-media";
import { buildCanvasConversationHistory } from "@/lib/canvas/canvas-assistant-history";
import { canvasAssistantDisplayMessage, ensureEnglishImagePrompt } from "@/lib/canvas/canvas-assistant-output";
import { createCanvasSelectionPromptSync } from "@/lib/canvas/canvas-selection-prompt";
import { canvasImageEditContext, canvasImageEditToolArgs, canvasImageTargetReferences, imageEditContextData, resolveCanvasImageEdit, type CanvasImageEditContext, type CanvasImageEditLineage, type CanvasImageEditTarget } from "@/lib/canvas/canvas-assistant-image-edit";
import { canvasConversationImageForAsset, canvasConversationImageLabels, canvasConversationImages, canvasConversationOriginals, canvasConversationTarget, type CanvasConversationImage } from "@/lib/canvas/canvas-assistant-image-catalog";
import { CanvasEditContractError } from "@/lib/canvas/canvas-image-edit-contract";
import { pendingOnlineAgentTask, recoverOnlineAgentTask, type PendingOnlineAgentTask } from "@/lib/canvas/canvas-online-task-recovery";
import { CANVAS_AGENT_ATTACHMENT_LIMIT, readCanvasAgentAttachments } from "@/lib/canvas/canvas-agent-attachments";
import { canvasCompareSource } from "@/lib/canvas/canvas-image-compare-source";

const PANEL_MOTION_SECONDS = CANVAS_AGENT_PANEL_MOTION_MS / 1000;
const ONLINE_AGENT_MAX_STEPS = 4;
const IMAGE_TARGETS_INCOMPLETE_MESSAGE = "未能完整接续这次生图要求，本次尚未提交图片生成。请明确要沿用的上一版，或补充本次需要保留和修改的内容。";

const ONLINE_READ_TOOLS = new Set(["canvas_get_state", "canvas_get_selection", "canvas_export_snapshot"]);

type OnlineAgentTab = "setup" | "chat" | "history" | "log";
type OnlineAgentLog = { id: string; time: string; title: string; data?: unknown };
type OnlineAgentLogContext = { model: string; running: boolean; confirmTools: boolean; messages: number; nodes: number; connections: number };
type OnlineLoopContext = { step: number };
type OnlineTurnContext = { signal?: AbortSignal; userPrompt: string; references: CanvasAssistantReference[]; historyReferences?: CanvasAssistantReference[]; hiddenPrompts?: string[]; imageEditContext?: CanvasImageEditContext; imageEditTarget?: CanvasImageEditTarget; imageLabels?: Record<string, string>; settings: AgentGenerationSettings; videoSize: string; config: AiConfig; canvasSnapshot: CanvasAgentSnapshot; autoContext: boolean; writeOperationAttempted?: boolean; imageContractRepairUsed?: boolean; finishAfterImageRepair?: boolean; imageRepairReferences?: CanvasAssistantReference[] };
type OnlineToolResult = { ok: true; message: string; data?: unknown; mediaWorkflow?: CanvasAgentMediaWorkflow } | { ok: false; message: string; data?: unknown };
type OnlineExecutedToolCall = { toolCallId: string; name: string; result: OnlineToolResult };
type PendingOnlineToolContext = { messages: ResponseInputMessage[]; toolCalls: ResponseToolCall[]; claudeAssistantContent?: ClaudeAssistantContent; responsesOutputItems?: ToolResponseResult["responsesOutputItems"]; assistantId: string; step: number; turn: OnlineTurnContext };

function mediaWorkflowFromResults(results: OnlineExecutedToolCall[]) {
    for (const item of results) {
        if (item.result.ok && item.result.mediaWorkflow) return item.result.mediaWorkflow;
    }
    return undefined;
}

function latestAssistantUserPrompt(messages: CanvasAssistantMessage[]) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === "user") return messages[index].text;
    }
    return "";
}

export type { CanvasMediaWorkflowAction } from "@/lib/canvas/canvas-assistant-panel-render-stability";

export const CanvasAssistantPanel = memo(function CanvasAssistantPanel({
    selectedNodeIds,
    selectedNodes,
    snapshotRef,
    sessions,
    activeSessionId,
    onSelectNodeIds,
    onSessionsChange,
    onApplyOps,
    canUndoOps,
    onUndoOps,
    onPasteImage,
    agentMode,
    onAgentModeChange,
    onMediaWorkflowAction,
    autoConnectLocal,
    closing,
    onCollapse,
    layout = "sidebar",
    onToggleLayout,
}: CanvasAssistantPanelRenderState) {
    const t = useUiText();
    const locale = useUiLocale();
    const brandName = locale === "en-US" ? "Inchoice TruCreate" : "无线画布";
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const user = useUserStore((state) => state.user);
    const baseConfig = useEffectiveConfig();
    const effectiveConfig = useToolConfig({ ...baseConfig, model: baseConfig.textModel || baseConfig.model }, "canvas-chat");
    const businessModels = useBusinessConfigStore((state) => state.models);
    const businessTools = useBusinessConfigStore((state) => state.tools);
    const businessConfigStatus = useBusinessConfigStore((state) => state.status);
    const refreshBusinessConfig = useBusinessConfigStore((state) => state.refresh);
    useEffect(() => {
        if (businessConfigStatus === "idle") void refreshBusinessConfig().catch(() => undefined);
    }, [businessConfigStatus, refreshBusinessConfig]);
    const onlineEnabled = useToolEnabled("canvas-chat");
    const localEnabled = useModuleEnabled("canvas-local-agent");
    const cleanupImages = useAssetStore((state) => state.cleanupImages);
    const addAssets = useAssetStore((state) => state.addAssets);
    const isAiConfigReady = (..._args: unknown[]) => true;
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const canManageConfig = useCanManageConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const confirmTools = useCanvasAgentStore((state) => state.confirmTools);
    const setAgentState = useCanvasAgentStore((state) => state.setAgentState);
    const [width, setWidth] = useState(520);
    const [view, setView] = useState<OnlineAgentTab>("chat");
    const [prompt, setPrompt] = useState("");
    const [autoContext, setAutoContext] = useState(true);
    const [isRunning, setIsRunning] = useState(false);
    const [uploadedReferences, setUploadedReferences] = useState<CanvasAssistantReference[]>([]);
    const [imageSelection, setImageSelection] = useState<{ imageId: string; mode: "edit" | "original"; sessionId?: string; projectId?: string; ownerId?: string } | null>(null);
    const imageTools = useConversationImageTools();
    const [attachmentErrors, setAttachmentErrors] = useState<string[]>([]);
    const [attachmentsLoading, setAttachmentsLoading] = useState(false);
    const attachmentReadRef = useRef<{ token: object; busy: boolean }>({ token: {}, busy: false });
    const [referenceOrder, setReferenceOrder] = useState<string[]>([]);
    const [imageCapabilities, setImageCapabilities] = useState<ImageGenerationModel[]>([]);
    const [videoCapabilities, setVideoCapabilities] = useState<GenerationCapabilityModel[]>([]);
    const [capabilityError, setCapabilityError] = useState<string | null>(null);
    const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
    const [videoConfirmation, setVideoConfirmation] = useState<AgentVideoConfirmation | null>(null);
    const [generationSettings, setGenerationSettings] = useState<AgentGenerationSettings>(() => {
        return {
        mode: "image",
        imageModel: effectiveConfig.imageModel || effectiveConfig.model,
        videoModel: effectiveConfig.videoModel || effectiveConfig.model,
        size: effectiveConfig.size || "1:1",
        quality: effectiveConfig.quality || "1k",
        imageOptions: effectiveConfig.imageOptions,
        imageCount: effectiveConfig.canvasImageCount || "3",
        videoSeconds: effectiveConfig.videoSeconds || "5",
        videoQuality: effectiveConfig.vquality || "1080P",
        videoGenerateAudio: effectiveConfig.videoGenerateAudio || "false",
        afterImage: "select_then_video",
        };
    });
    // Image adapters may replace ratios with pixel sizes. Keep the user's video
    // ratio independently so image normalization or a mode switch cannot erase it.
    const videoSizeRef = useRef(effectiveConfig.size || "16:9");
    const [deleteChatIds, setDeleteChatIds] = useState<string[]>([]);
    const [onlineLogs, setOnlineLogs] = useState<OnlineAgentLog[]>([]);
    const [resizing, setResizing] = useState(false);
    const [removedReferenceIds, setRemovedReferenceIds] = useState<Set<string>>(new Set());
    const [localSessions, setLocalSessionsState] = useState<CanvasAssistantSession[]>(() => (sessions.length ? sessions : [createSession()]));
    const localSessionsRef = useRef(localSessions);
    // Keep the completed turn available before React publishes its next render.
    const setLocalSessions = (next: CanvasAssistantSession[] | ((previous: CanvasAssistantSession[]) => CanvasAssistantSession[])) => {
        const value = typeof next === "function" ? next(localSessionsRef.current) : next;
        localSessionsRef.current = value;
        setLocalSessionsState(value);
    };
    const [localActiveSessionId, setLocalActiveSessionIdState] = useState<string | null>(activeSessionId);
    const localActiveSessionIdRef = useRef(localActiveSessionId);
    const setLocalActiveSessionId = (next: string | null) => {
        localActiveSessionIdRef.current = next;
        setLocalActiveSessionIdState(next);
    };
    const [chatMessageLimit, setChatMessageLimit] = useState(DEFAULT_AGENT_MESSAGE_WINDOW);
    const pendingToolContextRef = useRef(new Map<string, PendingOnlineToolContext>());
    const executingToolIdsRef = useRef(new Set<string>());
    const onlineRequestRef = useRef<AbortController | null>(null);
    const onlineMountedRef = useRef(true);
    const onlineProjectId = snapshotRef.current.projectId;
    useEffect(() => {
        onlineMountedRef.current = true;
        setIsRunning(false);
        return () => {
            onlineMountedRef.current = false;
            attachmentReadRef.current = { token: {}, busy: false };
            onlineRequestRef.current?.abort();
            pendingToolContextRef.current.clear();
        };
    }, [onlineProjectId, user?.id]);
    const onlineActionHandlersRef = useRef<{
        approve: (messageId: string) => unknown;
        reject: (messageId: string) => void;
        useImage: (attachment: CanvasAgentChatAttachment) => void;
        imageAction: (action: ConversationImageAction, imageId: string) => boolean | void;
        queryOriginal: (sessionId: string, item: CanvasAssistantMessage) => unknown;
    }>({
        approve: (_messageId: string) => undefined,
        reject: (_messageId: string) => undefined,
        useImage: (_attachment: CanvasAgentChatAttachment) => undefined,
        imageAction: (_action: ConversationImageAction, _imageId: string) => undefined,
        queryOriginal: (_sessionId: string, _item: CanvasAssistantMessage) => undefined,
    });

    const incomingSessionsRef = useRef({ sessions, activeSessionId });
    const publishedSessionsRef = useRef<{ sessions: CanvasAssistantSession[]; activeSessionId: string | null } | null>(null);
    useEffect(() => {
        const previous = incomingSessionsRef.current;
        const changed = previous.sessions !== sessions || previous.activeSessionId !== activeSessionId;
        incomingSessionsRef.current = { sessions, activeSessionId };
        const published = publishedSessionsRef.current;
        const echo = published?.sessions === sessions && published.activeSessionId === activeSessionId;
        // A parent echo must not overwrite newer local messages. Reconcile in one
        // effect so an external restore is never simultaneously published back as stale state.
        if (changed && !echo) {
            setLocalSessions(sessions);
            setLocalActiveSessionId(activeSessionId);
            return;
        }
        if (localSessions === sessions && localActiveSessionId === activeSessionId) return;
        publishedSessionsRef.current = { sessions: localSessions, activeSessionId: localActiveSessionId };
        onSessionsChange(localSessions, localActiveSessionId);
    }, [activeSessionId, sessions, localActiveSessionId, localSessions, onSessionsChange]);

    useEffect(() => {
        if (!canManageConfig && view === "setup") setView("chat");
    }, [canManageConfig, view]);

    const capabilitiesRequestRef = useRef(0);
    const loadCapabilities = useCallback(async () => {
        const request = ++capabilitiesRequestRef.current;
        setCapabilitiesLoading(true);
        setCapabilityError(null);
        const [images, videos] = await Promise.allSettled([getImageGenerationModels(), getGenerationCapabilities("canvas-video")]);
        if (request !== capabilitiesRequestRef.current) return;
        const errors: string[] = [];
        if (images.status === "fulfilled") {
            setImageCapabilities(images.value);
            setGenerationSettings((current) => {
                const selected = preferredImageModel(images.value, [current.imageModel]);
                if (!selected) return current;
                const normalized = normalizeAgentImageSettings({ ...current, imageModel: selected.modelId });
                return current.mode === "image" ? normalized : { ...normalized, size: current.size };
            });
        } else {
            setImageCapabilities([]);
            errors.push(`图像模型：${images.reason instanceof Error ? images.reason.message : "加载失败"}`);
        }
        if (videos.status === "fulfilled") {
            setVideoCapabilities(videos.value.models);
            setGenerationSettings((current) => {
                const selected = videos.value.models.find((model) => model.modelId === current.videoModel) || videos.value.models[0];
                if (!selected) return current;
                const normalized = normalizeAgentVideoSettings({ ...current, videoModel: selected.modelId, size: current.mode === "video" ? current.size : videoSizeRef.current }, selected.capability);
                videoSizeRef.current = normalized.size;
                return current.mode === "video" ? normalized : { ...normalized, size: current.size };
            });
        } else {
            setVideoCapabilities([]);
            errors.push(`视频模型：${videos.reason instanceof Error ? videos.reason.message : "加载失败"}`);
        }
        setCapabilityError(errors.length ? errors.join("；") : null);
        setCapabilitiesLoading(false);
    }, []);
    useEffect(() => {
        void loadCapabilities();
        return () => { capabilitiesRequestRef.current++; };
    }, [loadCapabilities, user?.id]);

    const safeSessions = localSessions.length ? localSessions : [createSession()];
    const activeSession = useMemo(() => safeSessions.find((session) => session.id === localActiveSessionId) || safeSessions[0] || null, [localActiveSessionId, safeSessions]);
    const historySessions = safeSessions.filter((session) => session.messages.length > 0);
    const messages = activeSession?.messages || [];
    const conversationImages = useMemo(() => canvasConversationImages(messages), [messages]);
    const selectedConversationImage = imageSelection?.sessionId === activeSession?.id && imageSelection?.projectId === onlineProjectId && imageSelection?.ownerId === user?.id
        ? conversationImages.find(image => image.id === imageSelection?.imageId) : undefined;
    const conversationImageControls = useMemo(() => new Map<string, CanvasAgentChatImageControl>(conversationImages.flatMap(image => {
        if (!image.attachmentId) return [];
        const originals = canvasConversationOriginals(image, messages, conversationImages);
        const originalDisabledReason = !originals.length ? "本任务没有保存可用原图" : originals.some(original => original.unavailableReason) ? "原图素材已不可用" : undefined;
        const comparable = originals.some(original => !original.unavailableReason && (original.storageKey || original.dataUrl) !== (image.storageKey || image.dataUrl));
        return [[`${image.messageId}:${image.attachmentId}`, { image, originalDisabledReason, compareDisabledReason: comparable ? undefined : "没有可对比的原图" }] as const];
    })), [conversationImages, messages]);
    useEffect(() => { setImageSelection(null); }, [activeSession?.id, onlineProjectId, user?.id]);
    const messageView = useMemo(() => ({ sessionId: activeSession?.id, userId: user?.id, messages }), [activeSession?.id, user?.id, messages]);
    const deferredMessageView = useDeferredValue(messageView);
    // Never briefly display another session/account while a deferred render is
    // pending. Only presentation lags; send/retry/approval use live messages.
    const displayMessages = deferredMessageView.sessionId === messageView.sessionId && deferredMessageView.userId === messageView.userId ? deferredMessageView.messages : messages;
    const renderedMessageWindow = useMemo(() => agentMessageWindow(displayMessages.length, chatMessageLimit), [chatMessageLimit, displayMessages.length]);
    const renderedMessages = useMemo(() => displayMessages.slice(renderedMessageWindow.start).flatMap(message => {
        const display = canvasAssistantDisplayMessage(message);
        return display ? [{ source: message, display, pendingTask: pendingOnlineAgentTask(message.detail?.pendingTask) }] : [];
    }), [displayMessages, renderedMessageWindow.start]);
    const hasMessages = messages.length > 0;
    const activeModel = effectiveConfig.textModel || effectiveConfig.model;
    const mediaWorkflowModels = useMemo(() => {
        const source = businessModels.length ? "server" : resolveModelPickerSource(effectiveConfig.channelMode, undefined, standaloneEdition);
        const availableModels = (capability: "image" | "video", toolKey: "canvas-image" | "canvas-video") => {
            const binding = businessTools.find((item) => item.toolKey === toolKey);
            if (binding?.enabled === false) return [];
            const models = businessModels.filter((item) => !binding?.modelConfigId || item.id === binding.modelConfigId);
            return getModelPickerOptions(effectiveConfig, capability, models, source);
        };
        return { image: availableModels("image", "canvas-image"), video: availableModels("video", "canvas-video") };
    }, [businessModels, businessTools, effectiveConfig]);
    const selectedNodeKey = useMemo(() => Array.from(selectedNodeIds).sort().join(","), [selectedNodeIds]);
    const syncSelectedPromptRef = useRef(createCanvasSelectionPromptSync());
    useEffect(() => {
        const selectedPrompt = syncSelectedPromptRef.current(selectedNodeIds, selectedNodes, snapshotRef.current.projectId);
        // Selection still resets a stale draft, but internal generation prompts
        // must never be recalled into the user-facing chat input.
        if (selectedPrompt !== undefined) setPrompt("");
    }, [selectedNodeIds, selectedNodes, snapshotRef]);
    const allSelectedReferences = useMemo(() => buildAssistantReferences(selectedNodes), [selectedNodes]);
    const selectedReferences = useMemo(() => allSelectedReferences.filter((item) => !removedReferenceIds.has(item.id)), [allSelectedReferences, removedReferenceIds]);
    const draftReferences = useMemo(() => {
        const available = new Map([...selectedReferences, ...uploadedReferences].map(item => [item.id, item]));
        const ordered = referenceOrder.flatMap(id => {
            const reference = available.get(id);
            available.delete(id);
            return reference ? [reference] : [];
        });
        return [...ordered, ...Array.from(available.values())];
    }, [selectedReferences, uploadedReferences, referenceOrder]);
    useEffect(() => {
        const ids = draftReferences.map(item => item.id);
        setReferenceOrder(current => current.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids);
    }, [draftReferences]);
    const generationReferences = useMemo(() => draftReferences.filter(item => item.dataUrl || item.storageKey).map(item => ({ ...item, dataUrl: item.dataUrl || "" })), [draftReferences]);
    const draftImageCatalog = useMemo(() => canvasConversationImages([...messages, { id: "draft", role: "user", text: "", references: draftReferences }]), [messages, draftReferences]);
    const draftImageLabel = (reference: ReferenceImage) => {
        const image = canvasConversationImageForAsset(draftImageCatalog, "draft", reference);
        return image ? t("图{number}", { number: image.label.replace(/^图/u, "") }) : "";
    };
    const removeDraftReferences = (ids: string[]) => {
        setUploadedReferences(current => current.filter(item => !ids.includes(item.id)));
        setRemovedReferenceIds(current => new Set([...Array.from(current), ...ids]));
        if (ids.some(id => selectedNodeIds.has(id))) onSelectNodeIds(new Set(Array.from(selectedNodeIds).filter(id => !ids.includes(id))));
    };
    const iconButtonStyle = { color: theme.node.muted };

    useEffect(() => {
        setChatMessageLimit(DEFAULT_AGENT_MESSAGE_WINDOW);
    }, [activeSession?.id]);

    useEffect(() => {
        setRemovedReferenceIds(new Set());
    }, [selectedNodeKey]);

    const updateSession = (sessionId: string, updater: (session: CanvasAssistantSession) => CanvasAssistantSession) => {
        setLocalSessions((prev) => prev.map((session) => (session.id === sessionId ? updater(session) : session)));
    };

    const appendMessage = (sessionId: string, message: CanvasAssistantMessage) => {
        updateSession(sessionId, (session) => ({
            ...session,
            title: session.messages.length ? session.title : message.text.slice(0, 18) || "新对话",
            messages: [...session.messages, message],
            updatedAt: new Date().toISOString(),
        }));
    };
    const addOnlineLog = (title: string, data?: unknown) => setOnlineLogs((prev) => [{ id: nanoid(), time: new Date().toLocaleTimeString(), title, data }, ...prev].slice(0, 80));

    const upsertMessage = (sessionId: string, message: CanvasAssistantMessage) => {
        updateSession(sessionId, (session) => {
            const exists = session.messages.some((item) => item.id === message.id);
            return {
                ...session,
                title: session.messages.length ? session.title : message.text.slice(0, 18) || "新对话",
                messages: exists ? session.messages.map((item) => (item.id === message.id ? { ...item, ...message } : item)) : [...session.messages, message],
                updatedAt: new Date().toISOString(),
            };
        });
    };

    const stopOnlineAgent = useCallback(() => {
        attachmentReadRef.current = { token: {}, busy: false };
        setAttachmentsLoading(false);
        onlineRequestRef.current?.abort();
        onlineRequestRef.current = null;
        pendingToolContextRef.current.clear();
        setLocalSessions(previous => previous.map(session => ({ ...session, messages: session.messages.map(item => {
            if (item.role === "tool" && ["pending", "running"].includes(String(item.detail?.status))) return { ...item, title: "已停止后续执行", text: "已停止本地回复和后续工具提交；已提交的服务端任务可能继续，请查询原任务。", detail: { ...item.detail, status: "rejected" } };
            if (item.detail?.kind === "agent_generation" && item.detail.status === "running") return { ...item, text: item.detail.pendingTask ? "已停止本地查询；服务端任务可能继续，请查询原任务，勿重复生成。" : "已停止本地回复和后续工具提交。", detail: { ...item.detail, status: "paused" } };
            return item;
        }) })));
        setIsRunning(false);
    }, []);
    useEffect(() => { if (closing || agentMode !== "online") stopOnlineAgent(); }, [agentMode, closing, stopOnlineAgent]);
    const beginOnlineRequest = () => {
        stopOnlineAgent();
        const controller = new AbortController();
        onlineRequestRef.current = controller;
        setIsRunning(true);
        return controller.signal;
    };

    const finishConversationTurn = async (sessionId: string, signal?: AbortSignal) => {
        if (!onlineMountedRef.current || signal?.aborted) return;
        try {
            // A complete reply must not remain behind the panel and editor debounce queues.
            const snapshot = { sessions: localSessionsRef.current, activeSessionId: localActiveSessionIdRef.current || sessionId };
            setLocalActiveSessionId(snapshot.activeSessionId);
            publishedSessionsRef.current = snapshot;
            await onSessionsChange(snapshot.sessions, snapshot.activeSessionId, { flush: true });
        } catch (error) {
            if (!onlineMountedRef.current || signal?.aborted) return;
            addOnlineLog("对话保存失败", error instanceof Error ? error.message : error);
            appendMessage(sessionId, { id: nanoid(), role: "error", title: "对话尚未保存", text: "回复已返回，但本机保存失败；请保留此页面并复制重要内容。" });
        } finally {
            if (onlineMountedRef.current && !signal?.aborted) setIsRunning(false);
        }
    };

    const startChatSession = () => {
        if (activeSession && activeSession.messages.length === 0) {
            setLocalActiveSessionId(activeSession.id);
            return;
        }
        const session = createSession();
        setLocalSessions((prev) => [session, ...prev]);
        setLocalActiveSessionId(session.id);
    };

    const removeSessions = (ids: string[]) => {
        const next = safeSessions.filter((session) => !ids.includes(session.id));
        if (!next.length) {
            const session = createSession();
            setLocalSessions([session]);
            setLocalActiveSessionId(session.id);
        } else {
            setLocalSessions(next);
            setLocalActiveSessionId(localActiveSessionId && ids.includes(localActiveSessionId) ? next[0].id : localActiveSessionId);
        }
        cleanupImages({ sessions: next });
    };

    const clearSessions = () => {
        const session = createSession();
        setLocalSessions([session]);
        setLocalActiveSessionId(session.id);
        cleanupImages({ sessions: [session] });
    };

    const sendMessage = async (text: string, history: CanvasAssistantMessage[], savedReferences?: CanvasAssistantReference[]) => {
        if (!onlineEnabled) return;
        if (history.some(item => pendingOnlineAgentTask(item.detail?.pendingTask))) {
            appendMessage(activeSession!.id, { id: nanoid(), role: "system", text: "本会话有生成任务尚未核实，请先查询原任务，勿重复生成。" });
            return;
        }
        const requestConfig = { ...effectiveConfig, model: effectiveConfig.textModel || effectiveConfig.model };
        if (!isAiConfigReady(requestConfig, requestConfig.model)) {
            if (canManageConfig) {
                openConfigDialog(true);
            } else {
                Modal.warning({
                    title: uiText("暂无可用模型"),
                    content: uiText("当前账号没有模型配置权限，请联系管理员统一配置模型和 API。"),
                });
            }
            return;
        }

        const session = activeSession || createSession();
        if (!activeSession) {
            setLocalSessions([session]);
            setLocalActiveSessionId(session.id);
        }

        let refs = savedReferences || draftReferences;
        let selectedEdit: ReturnType<typeof canvasConversationTarget> | undefined;
        if (imageSelection) {
            try {
                if (!selectedConversationImage) throw new Error("编辑目标已不可用，请重新选择图片");
                selectedEdit = canvasConversationTarget(history, selectedConversationImage, imageSelection.mode);
                selectedEdit.target.additionalReferences = refs.filter(reference => reference.type === CanvasNodeType.Image).map(reference => ({ ...reference }));
                refs = [...canvasImageTargetReferences(selectedEdit.target, selectedEdit.context), ...refs.filter(reference => reference.type !== CanvasNodeType.Image)];
            } catch (error) {
                setAttachmentErrors([uiText(error instanceof Error ? error.message : "编辑目标已不可用，请重新选择图片")]);
                return;
            }
        }
        const settings = { ...generationSettings };
        const turn: OnlineTurnContext = { signal: beginOnlineRequest(), userPrompt: text, references: refs, imageEditContext: selectedEdit?.context, imageEditTarget: selectedEdit?.target, settings, videoSize: videoSizeRef.current, config: onlineAgentConfig(effectiveConfig, settings), canvasSnapshot: captureCanvasContextSnapshot(snapshotRef.current), autoContext };
        const userMessage: CanvasAssistantMessage = { id: nanoid(), role: "user", text, references: refs, detail: { generationSettings: settings, ...(selectedEdit ? { selectedImageTarget: { imageId: selectedConversationImage!.id, mode: selectedEdit.target.mode, label: selectedConversationImage!.label } } : {}) } };
        const assistantId = nanoid();
        appendMessage(session.id, userMessage);
        addOnlineLog("发送请求", { text, selectedNodeIds: snapshotRef.current.selectedNodeIds, nodeCount: snapshotRef.current.nodes.length, connectionCount: snapshotRef.current.connections.length });
        setPrompt("");
        setUploadedReferences([]);
        setIsRunning(true);
        await runOnlineAgentStep(session.id, assistantId, history, userMessage, { step: 1 }, turn);
    };

    const runOnlineAgentStep = async (sessionId: string, assistantId: string, history: CanvasAssistantMessage[], userMessage: CanvasAssistantMessage, loop: OnlineLoopContext, turn: OnlineTurnContext) => {
        const requestConfig = { ...turn.config, model: turn.config.textModel || turn.config.model };
        try {
            setIsRunning(true);
            const context = turn.autoContext ? await buildCanvasAssistantContext(turn.canvasSnapshot, new Set(turn.references.map((ref) => ref.id)), { image: readCanvasContextImage, video: readCanvasContextVideo }) : undefined;
            turn.signal?.throwIfAborted();
            turn.imageEditContext ||= canvasImageEditContext(history);
            // Keep original and latest-result evidence available even beyond the chat window.
            const editEvidence = [...turn.imageEditContext.originals, ...turn.imageEditContext.results];
            const current = { ...userMessage, contextReferences: editEvidence };
            const imageLabels = canvasConversationImageLabels(canvasConversationImages([...history, current]), [...history, current]);
            turn.imageLabels = Object.fromEntries([...turn.references, ...editEvidence].flatMap(reference => {
                const label = imageLabels.get(`${userMessage.id}:${reference.id}`);
                return label ? [[reference.id, label]] : [];
            }));
            const conversation = await buildCanvasConversationHistory(history, current, readCanvasConversationImage, context?.content, imageLabels);
            turn.signal?.throwIfAborted();
            turn.historyReferences = conversation.references;
            const contextReferences = context?.summary.items.filter(item => item.type === CanvasNodeType.Image && item.reading === "已提供图片").flatMap(item => {
                const node = turn.canvasSnapshot.nodes.find(node => node.id === item.id);
                const reference = node && nodeToReference(node);
                return reference ? [reference] : [];
            });
            upsertMessage(sessionId, { ...userMessage, contextReferences, detail: { ...userMessage.detail, ...(context ? { canvasContext: context.summary } : {}), conversationContext: conversation.summary }, meta: `图文上下文 ${conversation.summary.images} 张图片${conversation.summary.omitted ? `，${conversation.summary.omitted} 张未发送` : ""}${conversation.summary.failed ? `，${conversation.summary.failed} 张读取失败` : ""}${conversation.summary.omittedMessages ? `，${conversation.summary.omittedMessages} 条较早消息未带入` : ""}` });
            const messages = buildToolAgentMessages(turn.canvasSnapshot, userMessage, turn.settings, conversation, turn.imageEditContext, turn.imageEditTarget, turn.imageLabels);
            addOnlineLog(`Agent Tool Loop ${loop.step} 开始`, { toolChoice: "auto" });
            let streamed = "";
            const result = await requestToolResponse(
                { ...requestConfig, systemPrompt: "" },
                messages,
                [],
                "auto",
                (text) => {
                    streamed = text;
                },
                { webSearch: true, tool: "canvas-chat", signal: turn.signal, ...canvasChatProfile(turn, "plan") },
            );
            turn.signal?.throwIfAborted();
            addOnlineLog("模型工具回复", { content: result.content, toolCalls: result.toolCalls, stopReason: result.stopReason });
            if (result.toolCalls.length) {
                const writableCalls = result.toolCalls.filter(isWritableToolCall);
                if (confirmTools && writableCalls.length) {
                    const toolMessageId = nanoid();
                    pendingToolContextRef.current.set(toolMessageId, { messages, toolCalls: result.toolCalls, claudeAssistantContent: result.claudeAssistantContent, responsesOutputItems: result.responsesOutputItems, assistantId, step: loop.step, turn });
                    const toolMessage: CanvasAssistantMessage = { id: toolMessageId, role: "tool", title: "确认工具调用", text: summarizeToolCalls(result.toolCalls), detail: { status: "pending", step: loop.step, toolCalls: result.toolCalls, generationSettings: turn.settings, referenceImages: turn.references.map(({ id, title }) => ({ id, title })) } };
                    appendMessage(sessionId, toolMessage);
                    addOnlineLog("等待用户确认", result.toolCalls);
                    return;
                }
                await continueOnlineToolLoop(sessionId, assistantId, messages, result, loop.step, turn);
            } else {
                if (!result.content.trim()) throw new Error("模型没有返回工具调用，画布操作未执行。");
                upsertMessage(sessionId, { id: assistantId, role: "assistant", text: result.content || streamed || "没有返回内容。" });
                addOnlineLog(`Agent Tool Loop ${loop.step} 结束`, { reply: result.content });
            }
        } catch (error) {
            if (turn.signal?.aborted) return;
            addOnlineLog("请求失败", error instanceof Error ? error.message : error);
            appendMessage(sessionId, { id: nanoid(), role: "error", title: "操作失败", text: error instanceof Error ? error.message : "操作失败" });
        } finally {
            await finishConversationTurn(sessionId, turn.signal);
        }
    };

    const continueOnlineToolLoop = async (sessionId: string, assistantId: string, messages: ResponseInputMessage[], result: ToolResponseResult, step: number, turn: OnlineTurnContext) => {
        const toolResults = await executeOnlineToolCalls(sessionId, result.toolCalls, turn);
        turn.signal?.throwIfAborted();
        addOnlineLog("工具执行结果", toolResults);
        const mediaWorkflow = mediaWorkflowFromResults(toolResults);
        appendMessage(sessionId, {
            id: nanoid(),
            role: "tool",
            title: toolResults.every((item) => item.result.ok) ? "工具自动执行完成" : "工具执行未完成",
            text: toolResults.map((item) => toolResultText(item.result)).join("\n"),
            detail: { status: toolResults.every((item) => item.result.ok) ? "completed" : "failed", step, toolCalls: result.toolCalls, results: toolResults, ...(mediaWorkflow ? { mediaWorkflow } : {}) },
        });
        await continueOnlineToolLoopAfterResults(sessionId, assistantId, messages, result.toolCalls, toolResults, step, turn, result.claudeAssistantContent, result.responsesOutputItems);
    };

    const continueOnlineToolLoopAfterResults = async (sessionId: string, assistantId: string, messages: ResponseInputMessage[], toolCalls: ResponseToolCall[], toolResults: OnlineExecutedToolCall[], step: number, turn: OnlineTurnContext, claudeAssistantContent?: ClaudeAssistantContent, responsesOutputItems?: ToolResponseResult["responsesOutputItems"]) => {
        turn.signal?.throwIfAborted();
        const prompts = toolResults.map(item => objectDetail(item.result.data).prompt);
        for (const call of toolCalls) {
            try { prompts.push(parseToolArguments(call.function.arguments).prompt); } catch { /* Invalid arguments are reported by tool execution. */ }
        }
        turn.hiddenPrompts = Array.from(new Set([...(turn.hiddenPrompts || []), ...prompts.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))]));
        const assistantTurn = toolResponseToInput({ toolCalls, claudeAssistantContent, responsesOutputItems });
        const nextMessages: ResponseInputMessage[] = [...messages, ...assistantTurn, ...toolResults.map((item) => ({ role: "tool" as const, tool_call_id: item.toolCallId, content: JSON.stringify(item.result) }))];
        if (toolResults.some((item) => !item.result.ok)) {
            const failed = toolResults.find(item => !item.result.ok);
            const failure = objectDetail(failed?.result.data);
            const original = toolCalls.find(call => call.id === failed?.toolCallId);
            // A model may correct one proven preflight mode mismatch. This is not
            // a provider retry: nothing in this turn may have attempted a write.
            const canRepair = original?.function.name === "canvas_generate_image"
                && failure.code === "IMAGE_EDIT_CONTRACT_INVALID" && failure.phase === "image_preflight" && failure.submitted === false
                && (failure.expectedMode === "complete" || failure.expectedMode === "update")
                && !turn.writeOperationAttempted && !turn.imageContractRepairUsed
                && toolCalls.filter(isWritableToolCall).length === 1
                && toolResults.every(item => item === failed || (item.result.ok && ONLINE_READ_TOOLS.has(item.name)));
            if (canRepair && original) {
                turn.imageContractRepairUsed = true;
                const repairMessages: ResponseInputMessage[] = nextMessages;
                upsertMessage(sessionId, { id: assistantId, role: "assistant", text: "正在接续上一轮要求，核对完整生成参数…" });
                let repaired: ToolResponseResult, call: ResponseToolCall;
                try {
                    const originalArgs = canvasImageEditToolArgs(parseToolArguments(original.function.arguments), turn.imageEditContext || canvasImageEditContext([]), turn.imageEditTarget);
                    turn.imageRepairReferences = turn.imageEditTarget ? canvasImageTargetReferences(turn.imageEditTarget, turn.imageEditContext!) : originalArgs.editIntent === "new" || originalArgs.editIntent === "explicit"
                        ? mediaReferencesForTool(originalArgs, turn).map(ref => ({ ...ref })) : [];
                    repaired = await requestToolResponse(
                        { ...turn.config, model: turn.config.textModel || turn.config.model, systemPrompt: "" },
                        repairMessages, [],
                        { type: "function", name: "canvas_generate_image" }, undefined, { tool: "canvas-chat", signal: turn.signal, ...canvasChatProfile(turn, "repair-image-contract") },
                    );
                    turn.signal?.throwIfAborted();
                    call = checkedImageContractRepairCall(original, repaired.toolCalls, turn);
                } catch (error) {
                    if (turn.signal?.aborted) throw error;
                    addOnlineLog("图片参数纠正未完成", error instanceof Error ? error.message : error);
                    upsertMessage(sessionId, { id: assistantId, role: "assistant", text: IMAGE_TARGETS_INCOMPLETE_MESSAGE });
                    return;
                }
                turn.finishAfterImageRepair = true;
                addOnlineLog("图片提交前参数纠正", { toolCall: call });
                if (confirmTools) {
                    const toolMessageId = nanoid();
                    pendingToolContextRef.current.set(toolMessageId, { messages: repairMessages, toolCalls: [call], claudeAssistantContent: repaired.claudeAssistantContent, responsesOutputItems: repaired.responsesOutputItems, assistantId, step: step + 1, turn });
                    appendMessage(sessionId, { id: toolMessageId, role: "tool", title: "确认工具调用", text: summarizeToolCalls([call]), detail: { status: "pending", step: step + 1, toolCalls: [call], generationSettings: turn.settings, referenceImages: turn.references.map(({ id, title }) => ({ id, title })) } });
                } else {
                    await continueOnlineToolLoop(sessionId, assistantId, repairMessages, { ...repaired, toolCalls: [call] }, step + 1, turn);
                }
                return;
            }
            upsertMessage(sessionId, { id: assistantId, role: "assistant", text: toolResults.map((item) => toolResultText(item.result)).join("\n") });
            return;
        }
        // A repaired image call is the only authorized pending operation. Do not
        // ask the planner for another tool cycle after its result is known.
        if (turn.finishAfterImageRepair) {
            upsertMessage(sessionId, { id: assistantId, role: "assistant", text: toolResults.map(item => toolResultText(item.result)).join("\n") });
            return;
        }
        if (step >= ONLINE_AGENT_MAX_STEPS) {
            upsertMessage(sessionId, { id: assistantId, role: "assistant", text: toolResults.map((item) => toolResultText(item.result)).join("\n") || "工具已执行。" });
            addOnlineLog("Agent Tool Loop 达到步数上限", { maxSteps: ONLINE_AGENT_MAX_STEPS });
            return;
        }
        const requestConfig = { ...turn.config, model: turn.config.textModel || turn.config.model };
        let streamed = "";
        const next = await requestToolResponse(
            { ...requestConfig, systemPrompt: "" },
            nextMessages,
            [],
            "auto",
            (text) => {
                streamed = text;
            },
            { webSearch: true, tool: "canvas-chat", signal: turn.signal, ...canvasChatProfile(turn, "continue") },
        );
        turn.signal?.throwIfAborted();
        addOnlineLog(`Agent Tool Loop ${step + 1} 回复`, { content: next.content, toolCalls: next.toolCalls, stopReason: next.stopReason });
        if (next.toolCalls.length) {
            const writableCalls = next.toolCalls.filter(isWritableToolCall);
            if (confirmTools && writableCalls.length) {
                const toolMessageId = nanoid();
                pendingToolContextRef.current.set(toolMessageId, { messages: nextMessages, toolCalls: next.toolCalls, claudeAssistantContent: next.claudeAssistantContent, responsesOutputItems: next.responsesOutputItems, assistantId, step: step + 1, turn });
                appendMessage(sessionId, { id: toolMessageId, role: "tool", title: "确认工具调用", text: summarizeToolCalls(next.toolCalls), detail: { status: "pending", step: step + 1, toolCalls: next.toolCalls, generationSettings: turn.settings, referenceImages: turn.references.map(({ id, title }) => ({ id, title })) } });
                addOnlineLog("等待用户确认", next.toolCalls);
                return;
            }
            await continueOnlineToolLoop(sessionId, assistantId, nextMessages, next, step + 1, turn);
            return;
        }
        upsertMessage(sessionId, { id: assistantId, role: "assistant", text: next.content || streamed || toolResults.map((item) => toolResultText(item.result)).join("\n") || "画布操作已完成。", detail: { hiddenPrompts: turn.hiddenPrompts } });
    };

    const executeOps = (ops: CanvasAgentOp[], signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (!onlineMountedRef.current || (signal && onlineRequestRef.current?.signal !== signal)) throw new DOMException("本轮已停止", "AbortError");
        const beforeSnapshot = snapshotRef.current;
        const before = snapshotSignature(beforeSnapshot);
        const next = onApplyOps(ops);
        snapshotRef.current = next;
        const ranGeneration = ops.some((op) => op.type === "run_generation" && Boolean(op.nodeId));
        const changed = before !== snapshotSignature(next) || ranGeneration;
        const noopReason = changed ? "" : explainNoop(ops, beforeSnapshot);
        return { changed, ops, ranGeneration, noopReason, before: JSON.parse(before), after: JSON.parse(snapshotSignature(next)) };
    };

    const mediaReferencesForTool = (args: Record<string, unknown>, turn: OnlineTurnContext) => {
        if (turn.imageRepairReferences) return turn.imageRepairReferences.map(ref => ({ ...ref, dataUrl: ref.dataUrl || "" }));
        const available = new Map<string, CanvasAssistantReference>();
        for (const reference of turn.historyReferences || []) available.set(reference.id, reference);
        for (const reference of [...(turn.imageEditContext?.originals || []), ...(turn.imageEditContext?.results || [])]) available.set(reference.id, reference);
        for (const node of snapshotRef.current.nodes) {
            const reference = nodeToReference(node);
            if (reference?.dataUrl || reference?.storageKey) available.set(reference.id, reference);
        }
        for (const reference of turn.references) if (reference.dataUrl || reference.storageKey) available.set(reference.id, reference);
        const defaults = turn.references.filter((reference) => reference.dataUrl || reference.storageKey).map((reference) => reference.id);
        const requestedIds = args.referenceNodeIds === undefined ? [] : requireStringArray(args.referenceNodeIds, "referenceNodeIds");
        const ids = requestedIds.length ? requestedIds : defaults;
        return Array.from(new Set(ids)).map((id) => {
            const reference = available.get(id);
            if (!reference?.dataUrl && !reference?.storageKey) throw new Error(`参考图片 ${id} 不存在，请使用当前画布、本轮上传或已提供历史图片的真实 id。`);
            return { ...reference, dataUrl: reference.dataUrl || "" };
        });
    };

    const generateOnlineNode = async (sessionId: string, op: Extract<CanvasAgentOp, { type: "run_generation" }>, turn: OnlineTurnContext) => {
        const current = snapshotRef.current;
        const node = current.nodes.find((item) => item.id === op.nodeId);
        if (!node) throw new Error(`要生成的节点 ${op.nodeId} 不存在。`);
        const metadata = node.metadata || {};
        const mode = op.mode || metadata.generationMode || (node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image");
        if (mode === "image" && turn.imageEditTarget) throw new Error("已锁定编辑目标，请使用图片编辑工具；不会通过节点生成绕过所选底图与修改要求。");
        const config: AiConfig = {
            ...turn.config, model: mode === "text" ? turn.config.textModel : metadata.model || defaultGenerationModel(turn.config, mode),
            size: metadata.size || (mode === "video" ? turn.videoSize : turn.config.size), quality: metadata.quality || turn.config.quality,
            imageOptions: metadata.imageOptions ?? turn.config.imageOptions,
            count: String(metadata.count ?? turn.config.count), canvasImageCount: String(metadata.count ?? turn.config.canvasImageCount),
            videoSeconds: metadata.seconds || turn.config.videoSeconds, vquality: metadata.vquality || turn.config.vquality,
            videoGenerateAudio: metadata.generateAudio ?? turn.config.videoGenerateAudio,
            videoWatermark: metadata.watermark ?? turn.config.videoWatermark,
            audioVoice: metadata.audioVoice || turn.config.audioVoice, audioFormat: metadata.audioFormat || turn.config.audioFormat,
            audioSpeed: metadata.audioSpeed || turn.config.audioSpeed, audioInstructions: metadata.audioInstructions || turn.config.audioInstructions,
        };
        const context = buildNodeGenerationContext(node.id, current.nodes, current.connections, op.prompt || metadata.composerContent || metadata.prompt || turn.userPrompt, mode);
        executeOps([{ type: "update_node", id: node.id, metadata: { status: "loading", errorDetails: undefined } }], turn.signal);
        try {
            if (mode === "image" || mode === "video") {
                const settings = onlineAgentMediaSettings(turn.settings, mode, { model: config.model, size: config.size, quality: config.quality, imageOptions: config.imageOptions, count: Number(config.count), seconds: config.videoSeconds, vquality: config.vquality, generateAudio: config.videoGenerateAudio });
                const result = await runDirectGeneration(sessionId, context.prompt, settings, context.referenceImages, config, undefined, turn.signal, node.id);
                executeOps([{ type: "update_node", id: node.id, metadata: { status: "success" } }, ...result.data.nodeIds.map((id): CanvasAgentOp => ({ type: "connect_nodes", fromNodeId: node.id, toNodeId: id }))], turn.signal);
                return result;
            }
            const id = nanoid();
            const position = { x: node.position.x + node.width + 80, y: node.position.y };
            if (mode === "text") {
                const content = await requestImageQuestion(config, buildNodeResponseMessages(await hydrateNodeGenerationContext(context)), () => undefined, { tool: "canvas-chat", signal: turn.signal });
                if (!snapshotRef.current.nodes.some(item => item.id === node.id)) throw new DOMException("生成源节点已删除，结果未回写画布", "AbortError");
                executeOps([{ type: "add_node", id, nodeType: CanvasNodeType.Text, title: "生成文本", position, metadata: { content, prompt: context.prompt, model: config.model, status: "success" } }, { type: "connect_nodes", fromNodeId: node.id, toNodeId: id }, { type: "update_node", id: node.id, metadata: { status: "success" } }], turn.signal);
                appendMessage(sessionId, { id: nanoid(), role: "assistant", title: "生成文本", text: content });
                return { ok: true as const, message: "文本已生成并放入画布。", data: { nodeIds: [id] } };
            }
            let pending: PendingOnlineAgentTask | undefined;
            const audio = await storeGeneratedAudio(await requestAudioGeneration(config, context.prompt, {
                signal: turn.signal, cancelOnAbort: () => false,
                onSubmissionStarted: async requestId => {
                    pending = { requestId, ownerId: user?.id || "", projectId: snapshotRef.current.projectId, mode: "audio", model: config.model, prompt: context.prompt, nodeId: node.id };
                    await savePendingOnlineTask(sessionId, id, pending, turn.signal, true);
                },
                onSubmitted: async task => { if (pending) { pending = { ...pending, taskIds: [task.id] }; await savePendingOnlineTask(sessionId, id, pending, turn.signal); } },
            }), config.audioFormat);
            if (!snapshotRef.current.nodes.some(item => item.id === node.id)) throw new DOMException("生成源节点已删除，可查询原任务", "AbortError");
            const sourceTaskId = pending?.taskIds?.[0];
            const outputId = sourceTaskId ? `agent-${sourceTaskId}-0` : id;
            executeOps([{ type: "add_node", id: outputId, nodeType: CanvasNodeType.Audio, title: "生成音频", position, metadata: { content: audio.url, storageKey: audio.storageKey, mimeType: audio.mimeType, prompt: context.prompt, model: config.model, status: "success", sourceTaskId } }, { type: "connect_nodes", fromNodeId: node.id, toNodeId: outputId }, { type: "update_node", id: node.id, metadata: { status: "success" } }], turn.signal);
            upsertMessage(sessionId, { id, role: "assistant", text: "音频已生成并放入画布。", detail: { kind: "agent_generation", status: "completed" } });
            return { ok: true as const, message: "音频已生成，可在画布节点播放。", data: { nodeIds: [outputId], url: audio.url } };
        } catch (error) {
            if (turn.signal?.aborted) throw error;
            executeOps([{ type: "update_node", id: node.id, metadata: { status: "error", errorDetails: error instanceof Error ? error.message : "生成失败" } }], turn.signal);
            throw error;
        }
    };

    const executeOnlineTool = async (sessionId: string, name: string, args: Record<string, unknown>, turn: OnlineTurnContext): Promise<OnlineToolResult> => {
        turn.signal?.throwIfAborted();
        const current = snapshotRef.current;
        try {
            if (name === "canvas_get_state") return { ok: true, message: describeCanvasSnapshot(current), data: compactSnapshot(current) };
            if (name === "canvas_export_snapshot") return { ok: true, message: describeCanvasSnapshot(current), data: compactSnapshot(current) };
            if (name === "canvas_get_selection") {
                const ids = new Set(current.selectedNodeIds || []);
                return { ok: true, message: `当前选中 ${ids.size} 个节点。`, data: { nodes: compactSnapshot({ ...current, nodes: current.nodes.filter((node) => ids.has(node.id)) }).nodes } };
            }
            if (name === "canvas_generate_image" || name === "canvas_generate_video") {
                const mode = name === "canvas_generate_image" ? "image" : "video";
                // Image tools use the user's configured model; the planner cannot switch providers.
                const settings = onlineAgentMediaSettings(mode === "video" ? { ...turn.settings, size: turn.videoSize } : turn.settings, mode, mode === "image" ? { ...args, model: turn.settings.imageModel } : args);
                const generationPrompt = mode === "image" && !imageModelProfile(settings.imageModel).requiresPrompt ? "" : requireString(args.prompt, "prompt");
                if (mode === "image") {
                    let edit: ReturnType<typeof resolveCanvasImageEdit>;
                    try {
                        edit = resolveCanvasImageEdit({ ...args, prompt: generationPrompt }, turn.imageEditContext || canvasImageEditContext([]), () => mediaReferencesForTool(args, turn), turn.userPrompt, turn.imageEditTarget);
                    } catch (error) {
                        if (!(error instanceof CanvasEditContractError)) throw error;
                        return { ok: false, message: IMAGE_TARGETS_INCOMPLETE_MESSAGE, data: {
                            code: error.code, phase: "image_preflight", submitted: error.submitted,
                            expectedMode: error.expectedMode || (turn.imageEditTarget ? turn.imageEditContext?.contract ? "update" : "complete" : undefined), reason: error.message,
                        } };
                    }
                    turn.writeOperationAttempted = true;
                    addOnlineLog("改图底图选择", { intent: edit.lineage.intent, references: edit.references.map(({ id, title, storageKey }) => ({ id, title, storageKey })) });
                    return await runDirectGeneration(sessionId, edit.prompt, settings, edit.references.map(referenceToImage), turn.config, edit.lineage, turn.signal);
                }
                const references = mediaReferencesForTool(args, turn).map(referenceToImage);
                return await runDirectGeneration(sessionId, generationPrompt, settings, references, turn.config, undefined, turn.signal);
            }
            const referenceTools = ["canvas_create_generation_flow", "canvas_create_image_prompt_flow", "canvas_create_config_node", "canvas_generate_text", "canvas_generate_audio"];
            if (turn.imageEditTarget) {
                // Validate before any supporting reference/config nodes can be inserted.
                const planned = onlineToolToOps(name, name === "canvas_create_generation_flow" && args.mode === undefined ? { ...args, mode: turn.settings.mode } : args, snapshotRef.current, turn.config);
                const imageRun = planned.some(op => op.type === "run_generation" && (op.mode || generationModeFromTarget(snapshotRef.current, op.nodeId) || "image") === "image");
                if (imageRun) throw new Error("已锁定编辑目标，请使用图片编辑工具；不会通过节点生成绕过所选底图与修改要求。");
            }
            let references: Array<CanvasAssistantReference & { dataUrl: string }> = [];
            if (referenceTools.includes(name)) {
                references = mediaReferencesForTool(args, turn);
                const missing = references.filter((reference) => !snapshotRef.current.nodes.some((node) => node.id === reference.id));
                if (missing.length) executeOps(missing.map((reference, index) => ({ type: "add_node", id: reference.id, nodeType: CanvasNodeType.Image, title: reference.title, position: { x: nextCanvasX(snapshotRef.current) + index * 380, y: 0 }, metadata: { content: reference.dataUrl, storageKey: reference.storageKey, status: "success" } })), turn.signal);
                args = { ...args, referenceNodeIds: references.map((reference) => reference.id) };
                if (name === "canvas_create_generation_flow" && args.mode === undefined) args.mode = turn.settings.mode;
                if (name === "canvas_create_config_node" && references.length) args.prompt = `${stringOptional(args.prompt)}\n${references.map((reference) => `@[node:${reference.id}]`).join("\n")}`;
            }
            const ops = onlineToolToOps(name, args, snapshotRef.current, turn.config);
            if (name === "canvas_create_config_node" && references.length) {
                const configNode = ops.find((op) => op.type === "add_node" && op.nodeType === CanvasNodeType.Config);
                if (configNode?.type === "add_node" && configNode.id) ops.splice(1, 0, ...references.map((reference): CanvasAgentOp => ({ type: "connect_nodes", fromNodeId: reference.id, toNodeId: configNode.id! })));
            }
            const before = snapshotSignature(snapshotRef.current);
            const generated = await executeOnlineAgentOperations(ops, mutations => executeOps(mutations, turn.signal), (op) => generateOnlineNode(sessionId, op, turn), turn.signal);
            const changed = before !== snapshotSignature(snapshotRef.current) || generated.length > 0;
            return { ok: changed, message: generated.length ? generated.map((item) => item.message).join("\n") : changed ? summarizeCanvasAgentOps(ops) || "画布操作已执行。" : explainNoop(ops, current), data: { generated, snapshot: compactSnapshot(snapshotRef.current) } };
        } catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : "工具执行失败", ...(error && typeof error === "object" && "taskId" in error ? { data: { taskId: error.taskId, canRecover: "canRecover" in error && error.canRecover, resubmitAllowed: false } } : {}) };
        }
    };

    const executeOnlineToolCall = async (sessionId: string, toolCall: ResponseToolCall, turn: OnlineTurnContext): Promise<OnlineExecutedToolCall> => {
        try {
            // For images this irreversible flag is set only after the explicit
            // preflight above. Every other write attempt closes the repair gate.
            if (toolCall.function.name !== "canvas_generate_image" && isWritableToolCall(toolCall)) turn.writeOperationAttempted = true;
            const result = await executeOnlineTool(sessionId, toolCall.function.name, parseToolArguments(toolCall.function.arguments), turn);
            return { toolCallId: toolCall.id, name: toolCall.function.name, result };
        } catch (error) {
            return { toolCallId: toolCall.id, name: toolCall.function.name, result: { ok: false, message: error instanceof Error ? error.message : "工具参数错误" } };
        }
    };

    const executeOnlineToolCalls = async (sessionId: string, toolCalls: ResponseToolCall[], turn: OnlineTurnContext) => {
        const results: OnlineExecutedToolCall[] = [];
        let stopped = false;
        for (const toolCall of toolCalls) {
            turn.signal?.throwIfAborted();
            if (stopped) {
                results.push({ toolCallId: toolCall.id, name: toolCall.function.name, result: { ok: false, message: "前一个工具调用失败，未继续执行。" } });
                continue;
            }
            const result = await executeOnlineToolCall(sessionId, toolCall, turn);
            turn.signal?.throwIfAborted();
            results.push(result);
            if (!result.result.ok) stopped = true;
        }
        return results;
    };

    const approveOnlineTool = async (messageId: string) => {
        if (isRunning || executingToolIdsRef.current.has(messageId)) return;
        const message = safeSessions.flatMap((session) => session.messages).find((item) => item.id === messageId);
        const detail = objectDetail(message?.detail);
        const pendingContext = pendingToolContextRef.current.get(messageId);
        const toolCalls = pendingContext?.toolCalls || toolCallsFromDetail(detail);
        const previousMessages = pendingContext?.messages || [];
        const session = safeSessions.find((session) => session.messages.some((item) => item.id === messageId));
        addOnlineLog("批准工具", { messageId, toolCalls });
        const assistantId = pendingContext?.assistantId || "";
        if (!session) return;
        if (!pendingContext || !toolCalls.length || !previousMessages.length || !assistantId) {
            upsertMessage(session.id, { id: messageId, role: "tool", title: "工具执行失败", text: "工具上下文不完整，无法执行。", detail: { ...detail, status: "failed" } });
            return;
        }
        try {
            pendingContext.turn.signal?.throwIfAborted();
            executingToolIdsRef.current.add(messageId);
            setIsRunning(true);
            pendingToolContextRef.current.delete(messageId);
            upsertMessage(session.id, { id: messageId, role: "tool", title: "工具执行中", text: message?.text || summarizeToolCalls(toolCalls), detail: { ...detail, status: "running" } });
            const results = await executeOnlineToolCalls(session.id, toolCalls, pendingContext.turn);
            pendingContext.turn.signal?.throwIfAborted();
            addOnlineLog("工具执行结果", results);
            const mediaWorkflow = mediaWorkflowFromResults(results);
            upsertMessage(session.id, {
                id: messageId,
                role: "tool",
                title: results.every((item) => item.result.ok) ? "工具执行完成" : "工具执行未完成",
                text: results.map((item) => toolResultText(item.result)).join("\n"),
                detail: { ...detail, results, status: results.every((item) => item.result.ok) ? "completed" : "failed", ...(mediaWorkflow ? { mediaWorkflow } : {}) },
            });
            pendingToolContextRef.current.delete(messageId);
            await continueOnlineToolLoopAfterResults(session.id, assistantId, previousMessages, toolCalls, results, pendingContext.step, pendingContext.turn, pendingContext.claudeAssistantContent, pendingContext.responsesOutputItems);
        } catch (error) {
            if (pendingContext.turn.signal?.aborted) return;
            addOnlineLog("工具续跑失败", error instanceof Error ? error.message : error);
            appendMessage(session.id, { id: nanoid(), role: "error", title: "操作失败", text: error instanceof Error ? error.message : "操作失败" });
        } finally {
            executingToolIdsRef.current.delete(messageId);
            await finishConversationTurn(session.id, pendingContext.turn.signal);
        }
    };

    const rejectOnlineTool = (messageId: string) => {
        if (executingToolIdsRef.current.has(messageId)) return;
        const session = safeSessions.find((session) => session.messages.some((item) => item.id === messageId));
        addOnlineLog("拒绝工具", { messageId });
        pendingToolContextRef.current.delete(messageId);
        if (session) upsertMessage(session.id, { id: messageId, role: "tool", title: "已拒绝执行", text: "工具调用已取消", detail: { ...objectDetail(session.messages.find((item) => item.id === messageId)?.detail), status: "rejected" } });
    };

    const updateGenerationSettings = (patch: Partial<AgentGenerationSettings>) => {
        if ((patch.mode || generationSettings.mode) === "video") {
            const size = generationSettings.mode === "video" ? patch.size || generationSettings.size : videoSizeRef.current;
            const capability = videoCapabilities.find((model) => model.modelId === (patch.videoModel || generationSettings.videoModel))?.capability;
            videoSizeRef.current = capability ? normalizeAgentVideoSettings({ ...generationSettings, ...patch, size }, capability).size : size;
            patch = { ...patch, size: videoSizeRef.current };
        }
        setGenerationSettings((current) => ({ ...current, ...patch }));
        if (patch.imageModel) updateConfig("imageModel", patch.imageModel);
        if (patch.videoModel) updateConfig("videoModel", patch.videoModel);
        if (patch.size) updateConfig("size", patch.size);
        if (patch.quality) updateConfig("quality", patch.quality);
        if (patch.imageOptions !== undefined) updateConfig("imageOptions", patch.imageOptions);
        if (patch.videoSeconds) updateConfig("videoSeconds", patch.videoSeconds);
        if (patch.videoQuality) updateConfig("vquality", patch.videoQuality);
        if (patch.videoGenerateAudio !== undefined) updateConfig("videoGenerateAudio", patch.videoGenerateAudio);
        if (patch.imageCount) updateConfig("canvasImageCount", patch.imageCount);
    };

    const savePendingOnlineTask = async (sessionId: string, messageId: string, pendingTask: PendingOnlineAgentTask, signal?: AbortSignal, beforeSubmission = false) => {
        signal?.throwIfAborted();
        const previous = localSessionsRef.current.find(session => session.id === sessionId)?.messages.find(item => item.id === messageId);
        upsertMessage(sessionId, { id: messageId, role: "assistant", text: "正在查询原任务；停止本地查询不会撤销服务端任务。", ...previous,
            detail: { ...previous?.detail, kind: "agent_generation", status: "running", pendingTask, resubmitAllowed: false } });
        try {
            await onSessionsChange(localSessionsRef.current, localActiveSessionIdRef.current || sessionId, { flush: true });
            signal?.throwIfAborted();
        } catch (error) {
            // This callback is awaited before POST: its rejection proves no job was submitted.
            if (beforeSubmission && onlineMountedRef.current && snapshotRef.current.projectId === pendingTask.projectId) {
                upsertMessage(sessionId, { id: messageId, role: "error", text: "本次请求未提交，可重新发送。", detail: { kind: "agent_generation", status: "failed" } });
                await Promise.resolve(onSessionsChange(localSessionsRef.current, localActiveSessionIdRef.current || sessionId, { flush: true })).catch(() => undefined);
            }
            throw error;
        }
    };

    const queryOriginalAgentTask = async (sessionId: string, item: CanvasAssistantMessage) => {
        const pending = pendingOnlineAgentTask(item.detail?.pendingTask);
        if (!pending || isRunning) return;
        if (pending.ownerId !== user?.id || pending.projectId !== snapshotRef.current.projectId) return;
        const signal = beginOnlineRequest();
        try {
            const result = await recoverOnlineAgentTask(pending, resolveAgentGeneratedMediaPosition(snapshotRef.current), signal);
            signal.throwIfAborted();
            const existing = new Set(snapshotRef.current.nodes.map(node => node.id));
            executeOps(result.ops.filter(op => op.type !== "add_node" || !op.id || !existing.has(op.id)), signal);
            upsertMessage(sessionId, { ...item, role: "assistant", text: "已取回原任务结果并放入画布，没有重新生成。", attachments: result.attachments,
                detail: { ...item.detail, pendingTask: undefined, status: "completed", imageEdit: pending.imageEdit } });
        } catch (error) {
            if (signal.aborted) return;
            upsertMessage(sessionId, { ...item, role: "error", text: error instanceof Error ? error.message : "原任务查询失败",
                detail: { ...item.detail, ...(error instanceof QueuedTaskFailedError ? { pendingTask: undefined, status: "failed" } : { status: "paused" }) } });
        } finally { await finishConversationTurn(sessionId, signal); }
    };

    const runDirectGeneration = async (sessionId: string, text: string, settings: AgentGenerationSettings, references: ReferenceImage[], baseConfig: AiConfig, imageEdit?: CanvasImageEditLineage, signal?: AbortSignal, nodeId?: string) => {
        const assertTarget = () => {
            signal?.throwIfAborted();
            if (nodeId && !snapshotRef.current.nodes.some(node => node.id === nodeId)) throw new DOMException("生成源节点已删除，可查询原任务", "AbortError");
        };
        assertTarget();
        const blend = settings.mode === "image" && imageModelProfile(settings.imageModel).kind === "midjourney-blend";
        const operation = settings.mode === "video" ? "video_generation" : references.length && !blend ? "inpaint" : "image_generation";
        const tool = canvasToolKey(settings.mode, references.length > 0, imageModelProfile(settings.imageModel).kind);
        const resolved = await resolveToolConfig({ ...baseConfig, model: settings.mode === "video" ? settings.videoModel : settings.imageModel }, operation, tool);
        assertTarget();
        baseConfig = resolved.config;
        settings = { ...settings, ...(settings.mode === "video" ? { videoModel: baseConfig.model } : { imageModel: baseConfig.model }) };
        const plan = buildAgentGenerationPlan(settings, text, references, imageModelProfile(resolved.model.modelId, [resolved.model]));
        const activeReferences = plan.kind === "video" ? selectAgentVideoReferences(plan.model, references) : references;
        const progressId = nanoid();
        let prompt = plan.kind === "image" && !plan.requiresPrompt ? "" : text.trim();
        const strategy = plan.kind === "image" ? `${!plan.requiresPrompt ? "合成参考图并输出" : references.length ? "以参考图为依据编辑" : "按文字描述生成"} ${plan.count} 张图片` : `${activeReferences.length ? "以所选图片为参考生成" : "按文字描述生成"} ${plan.seconds === "-1" ? "智能时长" : `${plan.seconds} 秒`}视频`;
        appendMessage(sessionId, { id: progressId, role: "assistant", text: `${strategy}，正在执行…`, meta: imageModelDisplayName(modelOptionName(plan.model)), detail: { kind: "agent_generation", status: "running", prompt, settings } });
        let submittedVideoTask: VideoGenerationTask | undefined;
        let pending: PendingOnlineAgentTask | undefined;
        try {
            if (plan.kind === "image") {
                prompt = await ensureEnglishImagePrompt(prompt, source => requestImageQuestion(
                    { ...baseConfig, model: baseConfig.textModel || baseConfig.model, systemPrompt: "" },
                    [{ role: "user", content: source }],
                    () => {}, { tool: "canvas-chat", signal, chatProfile: "canvas-assistant", profileContext: { stage: "english-image-prompt" } },
                ), { requiresPrompt: plan.requiresPrompt });
                signal?.throwIfAborted();
                const config = { ...baseConfig, model: plan.model, imageModel: plan.model, size: plan.size, quality: plan.quality, imageOptions: plan.imageOptions ?? baseConfig.imageOptions, count: String(plan.count), canvasImageCount: String(plan.count), systemPrompt: "" };
                const requestId = nanoid();
                const requestOptions = { requestId, signal, cancelOnAbort: () => false,
                    onSubmissionStarted: async () => {
                        pending = { requestId: `${requestId}:0`, ownerId: user?.id || "", projectId: snapshotRef.current.projectId, mode: "image", model: plan.model, prompt, imageEdit, nodeId };
                        try { await savePendingOnlineTask(sessionId, progressId, pending, signal, true); }
                        catch (error) { pending = undefined; throw error; }
                    },
                    onSubmitted: async (taskIds: string[]) => { if (pending) { pending = { ...pending, taskIds }; await savePendingOnlineTask(sessionId, progressId, pending, signal); } },
                };
                const generated = references.length && plan.requiresPrompt ? await requestEdit(config, prompt, references, undefined, { ...requestOptions, tool: "canvas-edit", referencePromptLanguage: "en" }) : await requestGeneration(config, prompt, { ...requestOptions, tool: "canvas-image" }, references);
                assertTarget();
                if (!generated.length) throw new Error("图片任务没有返回结果，尚未生成可见图片。");
                const storedImages = await Promise.all(generated.map(async (item) => ({ item, image: await uploadImage(item.dataUrl) })));
                assertTarget();
                const taskOutputCounts = new Map<string, number>();
                const attachments: CanvasAssistantAttachment[] = storedImages.map(({ item, image }, index) => {
                    const outputIndex = item.sourceTaskId ? taskOutputCounts.get(item.sourceTaskId) || 0 : index;
                    if (item.sourceTaskId) taskOutputCounts.set(item.sourceTaskId, outputIndex + 1);
                    return {
                        id: item.sourceTaskId ? `agent-${item.sourceTaskId}-${outputIndex}` : item.id, name: `生成图片 ${index + 1}`, url: image.url, storageKey: image.storageKey, width: image.width, height: image.height, mediaType: "image",
                        serverAssetId: serverAssetIdFromAsset({ kind: "image", data: { ...image, dataUrl: item.dataUrl } }),
                    };
                });
                executeOps(buildAgentGeneratedMediaOps(attachments, {
                    prompt, model: plan.model, ...resolveAgentGeneratedMediaPosition(snapshotRef.current),
                    imageMetadata: {
                        generationType: references.length && plan.requiresPrompt ? "edit" : "generation",
                        size: config.size, quality: config.quality, imageOptions: config.imageOptions || "", count: plan.count,
                        references: references.map((reference) => reference.storageKey || reference.url || reference.dataUrl).filter(Boolean),
                        compareSources: references.map(canvasCompareSource),
                    },
                }), signal);
                addAssets(storedImages.map(({ image }, index) => ({
                    kind: "image" as const,
                    title: prompt.slice(0, 24) || attachments[index].name,
                    coverUrl: image.url,
                    tags: ["无线画布", "Agent"],
                    source: "无线画布-Agent",
                    data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType },
                    metadata: { source: "canvas", module: "Agent", nodeId: attachments[index].id, projectId: snapshotRef.current.projectId, prompt, model: plan.model, serverAssetId: attachments[index].serverAssetId },
                })));
                const message = `${attachments.length} 张图片已生成并放入画布。`;
                const lineage = { ...(imageEdit || { intent: "explicit" as const, originalReferences: references.map(ref => ({ id: ref.id, type: CanvasNodeType.Image, title: ref.name, dataUrl: ref.dataUrl, storageKey: ref.storageKey })), originalPrompt: text, baseReferences: [] }), editPrompt: prompt };
                // For an initially text-only task, its first output becomes the original.
                if (!lineage.originalReferences.length) lineage.originalReferences = attachments.map(item => ({ id: item.id, type: CanvasNodeType.Image, title: item.name, dataUrl: item.url, storageKey: item.storageKey }));
                upsertMessage(sessionId, { id: progressId, role: "assistant", text: message, attachments, meta: `${attachments.length} 张 · ${imageModelDisplayName(modelOptionName(plan.model))} · ${plan.quality}`, detail: { kind: "agent_generation", status: "completed", prompt, settings, imageEdit: lineage } });
                return { ok: true as const, message, data: { nodeIds: attachments.map((item) => item.id), mediaType: "image", prompt } };
            }
            const config = { ...baseConfig, model: plan.model, videoModel: plan.model, size: plan.size, videoSeconds: plan.seconds, vquality: plan.quality, videoGenerateAudio: settings.videoGenerateAudio ?? baseConfig.videoGenerateAudio };
            const videoPrompt = buildAgentVideoPrompt(prompt, plan.requiresReference);
            const result = await requestVideoGeneration(config, videoPrompt, activeReferences, [], [], { toolKey: "canvas-video", signal, cancelOnAbort: () => false,
                onSubmissionStarted: async requestId => {
                    pending = { requestId, ownerId: user?.id || "", projectId: snapshotRef.current.projectId, mode: "video", model: plan.model, prompt: videoPrompt, nodeId };
                    try { await savePendingOnlineTask(sessionId, progressId, pending, signal, true); }
                    catch (error) { pending = undefined; throw error; }
                }, onSubmitted: async (task) => {
                submittedVideoTask = task;
                if (pending) { pending = { ...pending, taskIds: [task.id] }; await savePendingOnlineTask(sessionId, progressId, pending, signal); }
            } });
            signal?.throwIfAborted();
            const video = await storeGeneratedVideo(result);
            assertTarget();
            const attachments: CanvasAssistantAttachment[] = [{ id: submittedVideoTask ? `agent-${submittedVideoTask.id}-0` : nanoid(), name: "生成视频", mediaType: "video", ...video }];
            executeOps(buildAgentGeneratedMediaOps(attachments, { prompt: videoPrompt, model: plan.model, ...resolveAgentGeneratedMediaPosition(snapshotRef.current) }), signal);
            addAssets([{
                kind: "video", title: prompt.slice(0, 24) || "Agent 视频", coverUrl: "", tags: ["无线画布", "Agent"], source: "无线画布-Agent",
                data: { url: video.url, storageKey: video.storageKey, width: video.width || 0, height: video.height || 0, bytes: video.bytes, mimeType: video.mimeType },
                metadata: { source: "canvas", module: "Agent", nodeId: attachments[0].id, projectId: snapshotRef.current.projectId, prompt: videoPrompt, model: plan.model, serverAssetId: video.serverAssetId },
            }]);
            const message = "视频已生成并放入画布。";
            upsertMessage(sessionId, { id: progressId, role: "assistant", text: message, attachments, meta: `${plan.seconds} 秒 · ${modelOptionName(plan.model)}`, detail: { kind: "agent_generation", status: "completed", prompt: videoPrompt, settings } });
            return { ok: true as const, message, data: { nodeIds: attachments.map((item) => item.id), mediaType: "video", prompt: videoPrompt } };
        } catch (error) {
            if (signal?.aborted) throw error;
            const paused = error instanceof QueuedTaskPausedError;
            if (paused && !pending) pending = { requestId: error.task.requestId, taskIds: [error.taskId], ownerId: user?.id || "", projectId: snapshotRef.current.projectId, mode: settings.mode, model: plan.model, prompt, nodeId, imageEdit };
            const videoTask = paused ? { id: error.taskId, provider: "server" as const, model: plan.model } : error instanceof QueuedTaskFailedError ? undefined : submittedVideoTask;
            const canRecover = paused ? error.canRecover : Boolean(videoTask);
            const reason = error instanceof Error ? error.message : "生成失败";
            upsertMessage(sessionId, { id: progressId, role: "error", title: pending ? "原任务尚未完成" : "生成失败", text: reason, detail: { kind: "agent_generation", status: pending ? "paused" : "failed", prompt, settings,
                ...(pending && !(error instanceof QueuedTaskFailedError) ? { pendingTask: pending, resubmitAllowed: false } : {}), ...(videoTask ? { videoTask, taskId: videoTask.id, canRecover, resubmitAllowed: false } : {}) } });
            if (videoTask && error instanceof Error) Object.assign(error, { taskId: videoTask.id, canRecover });
            throw error;
        }
    };

    const runVideoFromImage = async (sessionId: string, image: CanvasAssistantAttachment, text: string) => {
        const signal = beginOnlineRequest();
        try {
            const reference: ReferenceImage = { id: image.id, name: image.name, type: "image/png", dataUrl: await imageToDataUrl(image), storageKey: image.storageKey };
            await runDirectGeneration(sessionId, text, { ...generationSettings, mode: "video" }, [reference], onlineAgentConfig(effectiveConfig, generationSettings), undefined, signal);
        } catch (error) {
            if (signal.aborted) return;
            addOnlineLog("视频生成未完成", error instanceof Error ? error.message : error);
        } finally {
            await finishConversationTurn(sessionId, signal);
        }
    };

    const submit = async () => {
        const text = prompt.trim();
        if (!onlineEnabled || !text || isRunning || attachmentReadRef.current.busy) return;
        await sendMessage(text, messages, draftReferences);
    };

    const addImagesToAgent = async (files: FileList | File[] | null) => {
        if (isRunning || attachmentReadRef.current.busy) return;
        const token = {};
        attachmentReadRef.current = { token, busy: true };
        setAttachmentsLoading(true);
        const current = () => onlineMountedRef.current && attachmentReadRef.current.token === token;
        try {
            const available = CANVAS_AGENT_ATTACHMENT_LIMIT - uploadedReferences.reduce((bytes, item) => bytes + (item.dataUrl?.length || 0), 0);
            const result = await readCanvasAgentAttachments(Array.from(files || []), available, fileToDataUrl, current);
            if (!current()) return;
            setUploadedReferences(previous => [...previous, ...result.images.map(image => ({ id: nanoid(), type: CanvasNodeType.Image, title: image.name, dataUrl: image.dataUrl }))]);
            setAttachmentErrors(result.errors);
        } finally {
            if (current()) { attachmentReadRef.current.busy = false; setAttachmentsLoading(false); }
        }
    };

    const useImageForVideo = (attachment: CanvasAgentChatAttachment) => {
        if (attachment.mediaType === "video") return;
        setImageSelection(null);
        const selectedImage: CanvasAssistantAttachment = { id: attachment.id, name: attachment.name, url: attachment.url, storageKey: attachment.storageKey, mediaType: "image" };
        const videoModel = videoCapabilities.find((model) => model.modelId === generationSettings.videoModel);
        const videoSettings: AgentGenerationSettings = { ...generationSettings, mode: "video", size: videoSizeRef.current };
        const settings = videoModel ? normalizeAgentVideoSettings(videoSettings, videoModel.capability) : videoSettings;
        const confirmation = createAgentVideoConfirmation(selectedImage, settings, prompt || "保持参考图中服装与人物一致，模特自然展示服装并缓慢向前走。");
        setUploadedReferences([{ id: attachment.id, type: CanvasNodeType.Image, title: attachment.name, dataUrl: attachment.url, storageKey: attachment.storageKey }]);
        updateGenerationSettings(settings);
        setPrompt(confirmation.prompt);
        setVideoConfirmation(confirmation);
        const session = activeSession || createSession();
        if (!activeSession) {
            setLocalSessions([session]);
            setLocalActiveSessionId(session.id);
        }
        appendMessage(session.id, {
            id: nanoid(),
            role: "assistant",
            title: "视频生成确认",
            text: "已选择图片作为视频首帧。请确认提示词和视频预设后再提交。",
            detail: { kind: "video_confirmation", status: "pending", selectedAttachmentId: attachment.id, settings },
        });
    };

    const useConversationImage = (action: ConversationImageAction, imageId: string) => {
        const image = conversationImages.find(item => item.id === imageId);
        if (!image || isRunning || attachmentReadRef.current.busy) return false;
        if (action === "download") { void imageTools.download(image); return true; }
        if (action === "compare") { imageTools.compare(image, canvasConversationOriginals(image, messages, conversationImages)); return true; }
        if (image.unavailableReason) { setAttachmentErrors([uiText(image.unavailableReason)]); return false; }
        if (action === "reference") {
            const reference = { ...image.reference, id: image.id };
            setUploadedReferences(current => current.some(item => (item.storageKey || item.dataUrl) === (reference.storageKey || reference.dataUrl)) ? current : [...current, reference]);
        } else {
            try { canvasConversationTarget(messages, image, action); }
            catch (error) { setAttachmentErrors([uiText(error instanceof Error ? error.message : "编辑目标已不可用，请重新选择图片")]); return false; }
            setImageSelection({ imageId, mode: action, sessionId: activeSession?.id, projectId: onlineProjectId, ownerId: user?.id });
            setVideoConfirmation(null);
            updateGenerationSettings({ mode: "image" });
        }
        setAttachmentErrors([]);
        setView("chat");
        return true;
    };

    onlineActionHandlersRef.current = { approve: approveOnlineTool, reject: rejectOnlineTool, useImage: useImageForVideo, imageAction: useConversationImage, queryOriginal: queryOriginalAgentTask };
    const handleConversationImageAction = useCallback((action: ConversationImageAction, imageId: string) => { onlineActionHandlersRef.current.imageAction(action, imageId); }, []);
    const handleMentionImage = useCallback((image: ConversationImageItem) => onlineActionHandlersRef.current.imageAction("edit", image.id), []);
    const handleApproveOnlineTool = useCallback((messageId: string) => {
        void onlineActionHandlersRef.current.approve(messageId);
    }, []);
    const handleRejectOnlineTool = useCallback((messageId: string) => {
        onlineActionHandlersRef.current.reject(messageId);
    }, []);
    const handleUseImageForVideo = useCallback((attachment: CanvasAgentChatAttachment) => {
        onlineActionHandlersRef.current.useImage(attachment);
    }, []);
    const handleQueryOriginalTask = useCallback((sessionId: string, item: CanvasAssistantMessage) => {
        void onlineActionHandlersRef.current.queryOriginal(sessionId, item);
    }, []);

    const confirmVideoFromSelectedImage = async () => {
        if (!videoConfirmation || isRunning) return;
        const session = activeSession || createSession();
        if (!activeSession) {
            setLocalSessions([session]);
            setLocalActiveSessionId(session.id);
        }
        const confirmation = videoConfirmation;
        setVideoConfirmation(null);
        setPrompt(confirmation.prompt);
        await runVideoFromImage(session.id, confirmation.selectedImage, confirmation.prompt);
    };

    const startResize = () => {
        const move = (event: MouseEvent) => setWidth(Math.min(760, Math.max(320, window.innerWidth - event.clientX)));
        const stop = () => {
            setResizing(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", stop);
        };
        setResizing(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", stop);
    };

    const collapse = () => {
        stopOnlineAgent();
        onCollapse();
    };

    // Typing updates the composer, not the entire long conversation subtree.
    const messageReferenceNodes = snapshotRef.current.nodes;
    const messageItems = useMemo(() => renderedMessages.map(({ source, display: message, pendingTask }) => (
        <div key={message.id} className="space-y-2">
            <AgentChatMessage item={message} theme={theme} user={user} onRejectTool={handleRejectOnlineTool} onApproveTool={handleApproveOnlineTool} onUseImageForVideo={handleUseImageForVideo}
                imageControls={conversationImageControls} activeImageId={selectedConversationImage?.id} imageActionsDisabled={isRunning} onImageAction={handleConversationImageAction} />
            {pendingTask ? <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: theme.node.muted }}>
                <span className="break-all">{t("原任务：")}{pendingTask.taskIds?.join("、") || pendingTask.requestId}</span>
                <Button size="small" disabled={isRunning} onClick={() => void handleQueryOriginalTask(activeSession!.id, source)}>{t("查询原任务")}</Button>
            </div> : null}
            {message.references?.length ? <MessageReferences message={message} nodes={messageReferenceNodes} images={conversationImages} disabled={isRunning} onSelect={handleMentionImage} /> : null}
            {message.detail?.mediaWorkflow ? (
                <CanvasAgentMediaWorkflowCard
                    workflow={message.detail.mediaWorkflow}
                    imageModels={mediaWorkflowModels.image}
                    videoModels={mediaWorkflowModels.video}
                    theme={theme}
                    onImageSettingsChange={onMediaWorkflowAction ? (key, value) => onMediaWorkflowAction({ type: "image_settings_change", messageId: message.id, key, value }) : undefined}
                    onImageModelChange={
                        onMediaWorkflowAction
                            ? (model) => {
                                  updateConfig("imageModel", model);
                                  onMediaWorkflowAction({ type: "image_model_change", messageId: message.id, model });
                              }
                            : undefined
                    }
                    onGenerateImages={onMediaWorkflowAction ? () => onMediaWorkflowAction({ type: "generate_images", messageId: message.id }) : undefined}
                    onImageCountChange={onMediaWorkflowAction ? (count) => onMediaWorkflowAction({ type: "image_count_change", messageId: message.id, count }) : undefined}
                    onSelectCandidate={onMediaWorkflowAction ? (nodeId) => onMediaWorkflowAction({ type: "select_candidate", messageId: message.id, nodeId }) : undefined}
                    onVideoModelChange={
                        onMediaWorkflowAction
                            ? (model) => {
                                  updateConfig("videoModel", model);
                                  onMediaWorkflowAction({ type: "video_model_change", messageId: message.id, model });
                              }
                            : undefined
                    }
                    onGenerateVideo={onMediaWorkflowAction ? () => onMediaWorkflowAction({ type: "generate_video", messageId: message.id }) : undefined}
                    onVideoSecondsChange={onMediaWorkflowAction ? (seconds) => onMediaWorkflowAction({ type: "video_seconds_change", messageId: message.id, seconds }) : undefined}
                    onAspectRatioChange={onMediaWorkflowAction ? (ratio) => onMediaWorkflowAction({ type: "aspect_ratio_change", messageId: message.id, ratio }) : undefined}
                    onRetry={onMediaWorkflowAction ? (stage) => onMediaWorkflowAction({ type: "retry", messageId: message.id, stage }) : undefined}
                    onOpenResult={onMediaWorkflowAction && message.detail.mediaWorkflow.videoResult ? () => onMediaWorkflowAction({ type: "open_result", messageId: message.id }) : undefined}
                />
            ) : null}
        </div>
    )), [renderedMessages, theme, user, isRunning, activeSession?.id, messageReferenceNodes, mediaWorkflowModels, onMediaWorkflowAction, updateConfig, handleRejectOnlineTool, handleApproveOnlineTool, handleUseImageForVideo, handleQueryOriginalTask, conversationImageControls, selectedConversationImage?.id, conversationImages, handleConversationImageAction, handleMentionImage, t]);

    const onlineContent = (
        <>
            {view !== "chat" ? <AgentPanelTabs
                value={view}
                theme={theme}
                items={[
                    ...(canManageConfig ? [{ value: "setup" as const, label: t("连接配置"), icon: <Settings2 className="size-3.5" /> }] : []),
                    { value: "chat", label: t("对话") },
                    { value: "history", label: t("历史"), icon: <History className="size-3.5" />, count: historySessions.length },
                    ...(canManageConfig ? [{ value: "log" as const, label: t("日志"), count: onlineLogs.length }] : []),
                ]}
                onChange={setView}
                right={
                    <>
                        {view === "history" ? (
                            <Tooltip title={t("删除全部")}>
                                <Button
                                    type="text"
                                    shape="circle"
                                    className="!h-8 !w-8 !min-w-8"
                                    style={iconButtonStyle}
                                    icon={<X className="size-4" />}
                                    disabled={!historySessions.length}
                                    onClick={() => setDeleteChatIds(historySessions.map((session) => session.id))}
                                />
                            </Tooltip>
                        ) : null}
                        <Tooltip title={t("新对话")}>
                            <Button
                                type="text"
                                shape="circle"
                                className="!h-8 !w-8 !min-w-8"
                                style={iconButtonStyle}
                                icon={<Plus className="size-4" />}
                                disabled={!hasMessages}
                                onClick={() => {
                                    startChatSession();
                                    setView("chat");
                                }}
                            />
                        </Tooltip>
                        {canManageConfig ? (
                            <Tooltip title={t("配置")}>
                                <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<Settings2 className="size-4" />} onClick={() => setView("setup")} />
                            </Tooltip>
                        ) : null}
                    </>
                }
            /> : null}

            {canManageConfig && view === "setup" ? (
                <OnlineAgentSetupView theme={theme} />
            ) : (
                <div className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                    {view === "history" ? (
                        <AssistantHistory
                            sessions={historySessions}
                            activeSession={activeSession}
                            onOpen={(id) => {
                                setLocalActiveSessionId(id);
                                setView("chat");
                            }}
                            onDelete={(id) => setDeleteChatIds([id])}
                        />
                    ) : view === "log" ? (
                        <OnlineAgentLogView
                            logs={onlineLogs}
                            theme={theme}
                            context={{ model: activeModel, running: isRunning, confirmTools, messages: messages.length, nodes: snapshotRef.current.nodes.length, connections: snapshotRef.current.connections.length }}
                            onClear={() => setOnlineLogs([])}
                        />
                    ) : messages.length ? (
                        <>
                            {renderedMessageWindow.hidden ? (
                                <div className="flex justify-center">
                                    <Button
                                        size="small"
                                        type="text"
                                        onClick={() => setChatMessageLimit((current) => expandAgentMessageWindow(current, messages.length))}
                                    >
                                        {t("加载更早消息（")}{renderedMessageWindow.hidden} {t(" 条）")}</Button>
                                </div>
                            ) : null}
                            {messageItems}
                            {isRunning ? <AgentWorkingMessage theme={theme} /> : null}
                        </>
                    ) : <><AgentQuickstart theme={theme} onSelect={(kind) => {
                        const preset = agentQuickstartPreset(kind);
                        updateGenerationSettings({ mode: preset.mode });
                        setPrompt(preset.prompt);
                    }} />{/*
                        <div className="flex h-full flex-col items-center justify-center px-1 text-center">
                            <div className="relative font-serif text-4xl font-bold italic tracking-normal" style={{ color: theme.node.text }}>
                                <span>{brandName}</span>
                                <DiaTextReveal className="absolute inset-0" colors={["#A97CF8", "#F38CB8", "#FDCC92"]} textColor="transparent" duration={1.8} startOnView={false} text={brandName} />
                            </div>
                            <div className="mt-3 font-serif text-base italic tracking-wide opacity-60">One canvas, infinite ideas</div>
                        </div>
                    */}</>}
                </div>
            )}

            {view === "chat" ? (
                <>
                    {selectedReferences.some(item => !item.dataUrl) ? (
                        <div className="thin-scrollbar flex max-w-full gap-1.5 overflow-x-auto px-3 pb-1">
                            {selectedReferences.filter(item => !item.dataUrl).map((item) => (
                                <AssistantReferenceChip
                                    key={item.id}
                                    item={item}
                                    onRemove={() => removeDraftReferences([item.id])}
                                />
                            ))}
                        </div>
                    ) : null}
                    {videoConfirmation ? (
                        <div className="mx-3 mb-2 rounded-xl border p-3 shadow-sm" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                            <div className="flex items-center gap-3">
                                <CanvasPersistedMediaPreview kind="image" url={videoConfirmation.selectedImage.url} storageKey={videoConfirmation.selectedImage.storageKey} alt={t("已选首帧")} className="size-12 rounded-md object-cover" />
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium" style={{ color: theme.node.text }}>{t("确认用这张图生成视频")}</div>
                                    <div className="mt-0.5 text-xs" style={{ color: theme.node.muted }}>{t("它将作为首帧；可先修改下方提示词与视频预设。")}</div>
                                </div>
                                <Button size="small" onClick={() => setVideoConfirmation(null)}>{t("返回选图")}</Button>
                                <Button size="small" type="primary" disabled={isRunning} onClick={() => void confirmVideoFromSelectedImage()}>{t("确认生成视频")}</Button>
                            </div>
                        </div>
                    ) : null}
                    {onlineEnabled && !effectiveConfig.textModel ? <p role="status" className="mx-4 mb-2 text-xs" style={{ color: theme.node.muted }}>{businessConfigStatus === "idle" || businessConfigStatus === "loading" ? t("正在读取对话配置…") : t("对话服务暂不可用，请联系管理员检查后台配置。")}</p> : null}
                    <div className="mx-4 mb-2 flex items-center justify-between gap-2 text-[11px]" style={{ color: theme.node.muted }} data-testid="canvas-auto-context">
                        <span title={t("发送时读取可见、选中和预览中的素材；视频提供抽样画面，不含声音。关闭后仍保留画布结构与手动参考。")}>{autoContext ? t("自动读取画布 · 图片、视频画面与文字") : t("自动读取已关闭 · 仅结构与手动参考")}</span>
                        <button type="button" className="shrink-0 hover:underline" aria-pressed={autoContext} onClick={() => setAutoContext((current) => !current)}>{autoContext ? t("关闭") : t("开启")}</button>
                    </div>
                    <AgentChatComposer
                        key={`${activeSession?.id}:${onlineProjectId}:${user?.id || ""}`}
                        disabled={!onlineEnabled || !effectiveConfig.textModel || attachmentsLoading}
                        prompt={prompt}
                        imageTarget={<ConversationImageTarget image={selectedConversationImage} mode={imageSelection?.mode} onCancel={() => setImageSelection(null)} />}
                        mentionImages={conversationImages}
                        onMentionImage={handleMentionImage}
                        attachments={uploadedReferences.map((item) => ({ id: item.id, name: item.title, url: item.dataUrl || "", storageKey: item.storageKey, mediaType: "image" as const }))}
                        attachmentPreview={<div className="min-w-0 [&_.cw-reference-preview]:!object-contain">
                            <CanvasQuickReferenceTray references={generationReferences.map(referenceToImage)} thumbnailSize={96} disabled={isRunning} labelForReference={draftImageLabel}
                                onMove={(id, targetId) => setReferenceOrder(moveImageReference(draftReferences, draftReferences.findIndex(item => item.id === id), draftReferences.findIndex(item => item.id === targetId)).map(item => item.id))}
                                onRemove={id => removeDraftReferences([id])} onClear={() => removeDraftReferences(generationReferences.map(item => item.id))} />
                        </div>}
                        sending={isRunning}
                        placeholder={t("直接问当前画布上的内容…")}
                        theme={theme}
                        onPromptChange={(value) => {
                            setPrompt(value);
                            setVideoConfirmation((current) => current ? { ...current, prompt: value } : null);
                        }}
                        onSubmit={submit}
                        onStop={stopOnlineAgent}
                        onAddFiles={addImagesToAgent}
                        onRemoveAttachment={(id) => setUploadedReferences((current) => current.filter((item) => item.id !== id))}
                        generationControls={<AgentGenerationControls editing={Boolean(selectedConversationImage) || generationReferences.length > 0} settings={generationSettings} config={effectiveConfig} imageCapabilities={imageCapabilities} videoCapabilities={videoCapabilities} theme={theme} onChange={updateGenerationSettings}
                            loading={capabilitiesLoading} error={capabilityError} onRetry={loadCapabilities}
                            extra={<div className="mt-3 grid gap-3 border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                                <div className="flex items-center justify-between"><span>Agent</span><AgentModeSwitch value={agentMode} theme={theme} onChange={mode => { if (mode === "local" ? localEnabled : onlineEnabled) onAgentModeChange(mode); }} /></div>
                                <label className="flex items-center justify-between">{t("工具执行前确认")}<Switch size="small" checked={confirmTools} onChange={(confirmTools) => setAgentState({ confirmTools })} /></label>
                                <CanvasPromptLibrary onSelect={setPrompt} />
                            </div>} />}
                    />
                    {attachmentsLoading ? <p role="status" className="mx-4 mb-2 text-xs" style={{ color: theme.node.muted }}>{t("正在读取图片…")}</p> : null}
                    {attachmentErrors.length ? <p role="alert" className="mx-4 mb-2 whitespace-pre-wrap text-xs" style={{ color: theme.node.text }}>{attachmentErrors.join("\n")}</p> : null}
                </>
            ) : null}

            {imageTools.compareDialog}

            <Modal
                title={t("删除对话记录？")}
                open={deleteChatIds.length > 0}
                centered
                onCancel={() => setDeleteChatIds([])}
                footer={
                    <>
                        <Button onClick={() => setDeleteChatIds([])}>{t("取消")}</Button>
                        <Button
                            danger
                            type="primary"
                            onClick={() => {
                                deleteChatIds.length === historySessions.length ? clearSessions() : removeSessions(deleteChatIds);
                                setDeleteChatIds([]);
                            }}
                        >
                            {t("删除")}</Button>
                    </>
                }
            >
                <p className="text-sm opacity-60">{t("将删除")}{deleteChatIds.length} {t(" 条对话记录，此操作不可撤销。")}</p>
            </Modal>
        </>
    );

    return (
        <motion.div
            className="flex shrink-0"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: closing ? 0 : width + 1, opacity: closing ? 0 : 1 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "clip", pointerEvents: closing ? "none" : undefined }}
        >
            <motion.aside
                className="relative flex shrink-0 flex-col border-l"
                initial={{ x: 48 }}
                animate={{ x: closing ? 28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
                style={{ width, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            >
                <button type="button" className="absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize" onMouseDown={startResize} aria-label={t("调整右侧面板宽度")} />
                <header className="cw-tabs" role="tablist" aria-label={t("创作方式")}>
                    <button type="button" role="tab" aria-selected={false} onClick={collapse}>{t("创建")}</button>
                    <button type="button" role="tab" aria-selected={true} onClick={() => setView("chat")}>{t("对话")}</button>
                    <div className="ml-auto flex items-center gap-1">
                        {layout !== "wide" ? <CanvasPanelSizeControl kind="chat" /> : null}
                        {onToggleLayout ? <Tooltip title={layout === "wide" ? t("切换为左侧窄栏") : t("切换为宽屏对话")}><button type="button" className="cw-icon" aria-label={layout === "wide" ? t("切换为左侧窄栏") : t("切换为宽屏对话")} onClick={onToggleLayout}>{layout === "wide" ? <PanelLeft className="size-4.5" /> : <Maximize2 className="size-4.5" />}</button></Tooltip> : null}
                        {hasMessages ? <Tooltip title={t("新对话")}><button type="button" className="cw-icon" aria-label={t("新对话")} onClick={() => { startChatSession(); setView("chat"); }}><Plus className="size-4" /></button></Tooltip> : null}
                        <Dropdown trigger={["click"]} menu={{ items: [
                            { key: "history", icon: <History className="size-4" />, label: t("对话历史"), onClick: () => { onAgentModeChange("online"); setView("history"); } },
                            ...(canManageConfig ? [{ key: "log", label: t("运行日志"), onClick: () => { onAgentModeChange("online"); setView("log"); } }] : []),
                            { type: "divider" },
                            { key: "online", disabled: !onlineEnabled, label: t("{value1}网站 Agent", { value1: agentMode === "online" ? "✓ " : "" }), onClick: () => onAgentModeChange("online") },
                            { key: "local", disabled: !localEnabled, label: t("{value1}本机 Agent", { value1: agentMode === "local" ? "✓ " : "" }), onClick: () => onAgentModeChange("local") },
                            ...(canManageConfig ? [{ key: "config", label: t("连接配置"), onClick: () => { onAgentModeChange("online"); setView("setup"); } }] : []),
                        ] }}><button type="button" className="cw-icon" aria-label={t("对话选项")}><MoreHorizontal className="size-4" /></button></Dropdown>
                    </div>
                </header>
                {agentMode === "local" ? localEnabled ? <CanvasLocalAgentPanel embedded snapshotRef={snapshotRef} canUndoOps={canUndoOps} onApplyOps={onApplyOps} onUndoOps={onUndoOps} autoConnect={autoConnectLocal} /> : <p role="status" className="p-4 text-sm">{t("本机 Agent 已停用，原有画布与对话仍保留。")}</p> : onlineContent}
            </motion.aside>
        </motion.div>
    );
}, canvasAssistantPanelPropsEqual);

function AgentQuickstart({ theme, onSelect }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onSelect: (kind: "video" | "lookbook" | "illustration" | "poster") => void }) {
    const t = useUiText();
    const items: Array<{ kind: "video" | "lookbook" | "illustration" | "poster"; label: string }> = [
        { kind: "video", label: "视频" },
        { kind: "lookbook", label: "实穿图像" },
        { kind: "illustration", label: "插画" },
        { kind: "poster", label: "海报" },
    ];
    return (
        <div className="flex h-full min-h-[360px] flex-col items-center justify-center px-5 text-center" style={{ color: theme.node.text }}>
            <div className="relative mb-5 h-20 w-44">
                <span className="absolute left-3 top-5 h-14 w-14 -rotate-6 rounded-sm bg-[#1d3564] shadow-md" />
                <span className="absolute left-[61px] top-1 h-20 w-14 rounded-sm bg-[linear-gradient(145deg,#ef9a70,#24304a)] shadow-lg" />
                <span className="absolute right-3 top-5 h-14 w-14 rotate-6 rounded-sm bg-[#6ec9c8] shadow-md" />
                <span className="absolute inset-x-0 bottom-0 text-[10px] font-semibold tracking-[.16em] text-white mix-blend-difference">CREATE</span>
            </div>
            <h2 className="text-lg font-semibold tracking-tight">{t("今天想创作什么？")}</h2>
            <p className="mt-1 text-sm opacity-55">{t("从提示词开始，或选择下方创作起点")}</p>
            <div className="mt-5 flex max-w-[290px] flex-wrap justify-center gap-2">
                {items.map((item) => <button key={item.kind} type="button" className="rounded-lg border bg-transparent px-3 py-2 text-sm font-medium transition hover:-translate-y-0.5 hover:shadow-sm" style={{ borderColor: theme.node.stroke }} onClick={() => onSelect(item.kind)}>{t(item.label)}</button>)}
            </div>
        </div>
    );
}

function modelLabel(modelId: string, isImage: boolean, imageModels: ImageGenerationModel[], videoModels: GenerationCapabilityModel[]) {
    if (isImage) return imageModelDisplayName(modelId, imageModels);
    return videoModels.find((model) => model.modelId === modelId)?.name || modelOptionName(modelId);
}

function AgentGenerationControls({ settings: savedSettings, config: baseConfig, imageCapabilities, videoCapabilities, theme, onChange, extra, loading, error, onRetry, editing = false }: { settings: AgentGenerationSettings; config: AiConfig; imageCapabilities: ImageGenerationModel[]; videoCapabilities: GenerationCapabilityModel[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (patch: Partial<AgentGenerationSettings>) => void; extra?: import("react").ReactNode; loading: boolean; error: string | null; onRetry: () => void; editing?: boolean }) {
    const t = useUiText();
    const savedProfile = useImageModelProfile(savedSettings.imageModel);
    const toolKey = canvasToolKey(savedSettings.mode, editing, savedProfile.kind);
    const config = useToolConfig({ ...baseConfig, model: savedSettings.mode === "image" ? savedSettings.imageModel : savedSettings.videoModel }, toolKey);
    const settings = { ...savedSettings, ...(savedSettings.mode === "image" ? { imageModel: config.model } : { videoModel: config.model }) };
    const isImage = settings.mode === "image";
    const imageProfile = useImageModelProfile(settings.imageModel);
    const imageSettings = normalizeAgentImageSettings(settings, imageProfile);
    const currentModel = isImage ? settings.imageModel : settings.videoModel;
    const currentModels = isImage ? imageCapabilities : videoCapabilities;
    const videoCapability = videoCapabilities.find((model) => model.modelId === settings.videoModel)?.capability;
    const videoSpec = getVideoModelParameterSpec(settings.videoModel);
    useEffect(() => {
        if (!isImage || loading || !imageCapabilities.some((model) => model.modelId === settings.imageModel)) return;
        if (settings.size !== imageSettings.size || settings.quality !== imageSettings.quality || settings.imageCount !== imageSettings.imageCount) onChange({ size: imageSettings.size, quality: imageSettings.quality, imageCount: imageSettings.imageCount });
    }, [isImage, loading, imageCapabilities, settings, imageSettings.size, imageSettings.quality, imageSettings.imageCount, onChange]);
    const changeModel = (model: string) => {
        if (isImage) { onChange(normalizeAgentImageSettings({ ...settings, imageModel: model }, imageModelProfile(model))); return; }
        const capability = videoCapabilities.find((item) => item.modelId === model)?.capability;
        onChange(capability ? normalizeAgentVideoSettings({ ...settings, videoModel: model }, capability) : { videoModel: model });
    };
    const modelPicker = <ModelPicker toolKey={toolKey} variant="canvas" fullWidth config={config} value={currentModel} capability={isImage ? "image" : "video"} onChange={changeModel} disabled={loading || !currentModels.length} className="h-auto min-h-11 w-full min-w-0 max-w-none rounded-lg border-0 bg-transparent px-2 text-base shadow-none" />;
    return (
        <>
            <div data-testid="canvas-agent-generation-model" className="col-span-2 min-w-0 w-full">
                {modelPicker}
            </div>
            <div data-testid="canvas-agent-generation-actions" className="flex min-w-0 flex-wrap items-center gap-1">
            <div className="inline-flex shrink-0 gap-1" role="tablist" aria-label={t("生成类型")}>
                <Tooltip title={t("图像")}><button type="button" role="tab" aria-label={t("图像")} aria-selected={isImage} className="grid size-11 shrink-0 place-items-center rounded-lg" style={{ background: isImage ? theme.node.fill : "transparent", color: theme.node.text }} onClick={() => onChange(normalizeAgentImageSettings({ ...settings, mode: "image" }, imageProfile))}><ImageIcon className="size-5" /></button></Tooltip>
                <Tooltip title={t("视频")}><button type="button" role="tab" aria-label={t("视频")} aria-selected={!isImage} className="grid size-11 shrink-0 place-items-center rounded-lg" style={{ background: !isImage ? theme.node.fill : "transparent", color: theme.node.text }} onClick={() => onChange(videoCapability ? normalizeAgentVideoSettings({ ...settings, mode: "video" }, videoCapability) : { mode: "video" })}><Video className="size-5" /></button></Tooltip>
            </div>
            <Popover trigger="click" placement="topLeft" content={
                <div data-canvas-no-zoom className="w-[280px] max-w-[calc(100vw-48px)] text-xs">
                    <div className="mb-3 text-sm font-semibold">{isImage ? t("图像设置") : t("视频设置")}</div>
                    {loading ? <p className="mb-3" role="status">{t("正在加载模型与参数…")}</p> : error ? <div className="mb-3 space-y-2" role="alert"><p>{error}</p><Button size="small" onClick={onRetry}>{t("重新加载")}</Button></div> : !currentModels.length ? <p className="mb-3" role="status">{t("尚未配置可用的")}{isImage ? t("图像") : t("视频")}{t("模型，请在后台启用模型后重新加载。")}</p> : null}
                    <div className="grid gap-2">
                        {isImage ? <ImageSettingsPanel config={{ ...config, model: settings.imageModel, imageModel: settings.imageModel, size: imageSettings.size, quality: imageSettings.quality, count: imageSettings.imageCount, imageOptions: imageSettings.imageOptions }} profile={imageProfile} referenceCount={editing ? 1 : 0} theme={theme} showTitle={false}
                            onConfigChange={(key, value) => onChange({ [key === "count" ? "imageCount" : key]: value })} /> : <>
                            <AgentParameterSelect label={t("时长")} value={settings.videoSeconds} values={videoCapability ? [...(videoSpec?.supportsAutoDuration ? ["-1"] : []), ...Array.from({ length: videoCapability.seconds[1] - videoCapability.seconds[0] + 1 }, (_, index) => String(videoCapability.seconds[0] + index))] : []} suffix={t(" 秒")} onChange={(videoSeconds) => onChange({ videoSeconds })} />
                            <AgentParameterSelect label={t("宽高比")} value={settings.size} values={videoCapability?.sizes.map((size) => size === "adaptive" ? "auto" : size) || []} onChange={(size) => onChange({ size })} />
                            <AgentParameterSelect label={t("分辨率")} value={settings.videoQuality} values={[...videoCapability?.resolutions || []]} onChange={(videoQuality) => onChange({ videoQuality })} />
                            {videoCapability?.supportsAudio ? <label className="flex min-h-9 items-center justify-between gap-3"><span className="opacity-60">{t("音频")}</span><Switch size="small" checked={settings.videoGenerateAudio === "true"} onChange={(value) => onChange({ videoGenerateAudio: String(value) })} /></label> : null}
                            <p className="mt-1 leading-5 opacity-55">{videoCapability ? t("参考图片：{value1}最多 {value2} 张", { value1: videoCapability.minImages ? uiText("至少 ") + videoCapability.minImages + uiText(" 张，") : uiText("可选，"), value2: videoCapability.maxImages }) : t("请先配置视频模型")}</p>
                        </>}
                    </div>
                    {extra}
                </div>
            }>
                <button type="button" aria-label={isImage ? t("图像设置") : t("视频设置")} className="grid size-11 shrink-0 place-items-center rounded-lg hover:opacity-60" style={{ color: theme.node.muted }}><Settings2 className="size-5" /></button>
            </Popover>
            </div>
        </>
    );
}

function AgentParameterSelect({ label, value, values, suffix = "", onChange }: { label: string; value: string; values: string[]; suffix?: string; onChange: (value: string) => void }) {
    const t = useUiText();
    return <label className="flex min-h-9 items-center justify-between gap-3"><span className="opacity-60">{label}</span><select aria-label={label} value={value} disabled={!values.length} className="h-8 max-w-[165px] rounded-md border-0 bg-transparent px-2 text-right outline-none" onChange={(event) => onChange(event.target.value)}>{values.map((item) => <option key={item} value={item}>{item === "-1" ? t("智能") : `${item === "auto" ? "自动" : item}${suffix}`}</option>)}</select></label>;
}
function AgentModelIcon({ model }: { model: string }) {
    const t = useUiText();
    const icon = imageModelIdentityHidden(model) ? "" : resolveModelIcon(modelOptionName(model));
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm")) return "/icons/glm.svg";
    return "";
}

function AssistantHistory({ sessions, activeSession, onOpen, onDelete }: { sessions: CanvasAssistantSession[]; activeSession: CanvasAssistantSession | null; onOpen: (id: string) => void; onDelete: (id: string) => void }) {
    const t = useUiText();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div className="space-y-3">
            <div className="text-sm" style={{ color: theme.node.muted }}>
                {sessions.length ? t("{value1} 条历史", { value1: sessions.length }) : t("暂无历史")}
            </div>
            {sessions.map((session) => (
                <div key={session.id} className="rounded-lg border px-2.5 py-1.5 transition" style={{ borderColor: session.id === activeSession?.id ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}>
                    <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                                {session.id === activeSession?.id ? (
                                    <span className="shrink-0 text-[10px] font-medium" style={{ color: theme.node.text }}>
                                        {t("当前")}</span>
                                ) : null}
                                <div className="truncate text-sm font-medium leading-5">{session.title}</div>
                            </div>
                            <div className="truncate text-[11px] leading-4 opacity-65">{sessionPreview(session)}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            <span className="text-[10px] opacity-55">{formatSessionTime(session.updatedAt || session.createdAt)}</span>
                            <Button size="small" className="!h-6 !px-2" onClick={() => onOpen(session.id)}>
                                {t("进入")}</Button>
                            <Tooltip title={t("删除记录")}>
                                <Button size="small" danger type="text" className="!h-6 !w-6 !min-w-6" icon={<Trash2 className="size-3.5" />} onClick={() => onDelete(session.id)} />
                            </Tooltip>
                        </div>
                    </div>
                </div>
            ))}
            {!sessions.length ? (
                <div className="px-3 py-8 text-center text-sm" style={{ color: theme.node.muted }}>
                    {t("网站 Agent 的对话记录会显示在这里")}</div>
            ) : null}
        </div>
    );
}

function OnlineAgentSetupView({ theme }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const t = useUiText();
    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
            <div className="space-y-4">
                <div>
                    <div className="text-base font-semibold leading-6">{t("连接配置")}</div>
                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                        {t("网站 Agent 的对话服务由后台统一配置，无需在这里选择模型或填写密钥。")}</div>
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <Button className="!h-8 !px-3" type="primary" icon={<Settings2 className="size-4" />} href="/admin?tab=api" target="_blank" rel="noopener noreferrer">
                            {t("后台模型配置")}</Button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function OnlineAgentLogView({ logs, theme, context, onClear }: { logs: OnlineAgentLog[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; context: OnlineAgentLogContext; onClear: () => void }) {
    const t = useUiText();
    const [mode, setMode] = useState<"text" | "json">("text");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const content = mode === "text" ? formatOnlineLogText(logs, context) : formatOnlineLogJson(logs, context);
    const lastError = [...logs].reverse().find((item) => /错误|失败|error/i.test(`${item.title}\n${stringifyLog(item.data)}`));
    const copy = async (value = content) => {
        if (await copyToClipboard(value)) return;
        textareaRef.current?.focus();
        textareaRef.current?.select();
    };
    return (
        <div className="flex min-h-full flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <Segmented
                    size="small"
                    value={mode}
                    onChange={(value) => setMode(value as "text" | "json")}
                    options={[
                        { label: t("排查日志"), value: "text" },
                        { label: t("原始 JSON"), value: "json" },
                    ]}
                />
                <div className="flex items-center gap-2">
                    <span className="text-xs" style={{ color: theme.node.muted }}>
                        {logs.length} {t(" 条")}</span>
                    <Button size="small" icon={<Copy className="size-3.5" />} disabled={!logs.length} onClick={() => void copy()}>
                        {t("复制")}</Button>
                    <Button size="small" disabled={!lastError} onClick={() => lastError && void copy(formatOnlineLogText([lastError], context))}>
                        {t("最近错误")}</Button>
                    <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} disabled={!logs.length} onClick={onClear}>
                        {t("清空")}</Button>
                </div>
            </div>
            <textarea
                ref={textareaRef}
                readOnly
                value={content}
                className="thin-scrollbar min-h-[360px] flex-1 resize-none rounded-lg border bg-transparent p-3 font-mono text-xs leading-5 outline-none"
                style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                onFocus={(event) => event.currentTarget.select()}
            />
        </div>
    );
}

function MessageReferences({ message, nodes, images = [], disabled, onSelect }: { message: CanvasAssistantMessage; nodes: CanvasNodeData[]; images?: CanvasConversationImage[]; disabled?: boolean; onSelect?: (image: ConversationImageItem) => unknown }) {
    const t = useUiText();
    return (
        <div className={`flex max-w-[88%] flex-wrap gap-2 ${message.role === "user" ? "ml-auto justify-end" : "ml-11 justify-start"}`}>
            {message.references?.map((item, index, references) => {
                const node = !item.storageKey && item.dataUrl?.startsWith("blob:") ? nodes.find((node) => node.id === item.id && node.type === CanvasNodeType.Image) : undefined;
                const reference = node?.metadata?.storageKey ? { ...item, storageKey: node.metadata.storageKey } : item;
                const image = canvasConversationImageForAsset(images, message.id, item);
                const label = image ? t("图{number}", { number: image.label.replace(/^图/u, "") }) : assistantImageReferenceLabel(references, index);
                return <AssistantReferenceChip key={`${item.id}-${index}`} item={reference} label={label} disabled={disabled || Boolean(image?.unavailableReason)} onSelect={image && onSelect ? () => onSelect(image) : undefined} />;
            })}
        </div>
    );
}

function AssistantReferenceChip({ item, label, onRemove, onSelect, disabled }: { item: CanvasAssistantReference; label?: string; onRemove?: () => void; onSelect?: () => unknown; disabled?: boolean }) {
    const t = useUiText();
    const displayLabel = label ? conversationImageLabel(label) : undefined;
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const text = (item.text || item.title).replace(/\s+/g, " ").trim().slice(0, 1) || "文";
    const preview = <>
        <CanvasPersistedMediaPreview kind="image" url={item.dataUrl} storageKey={item.storageKey} alt={item.title} className="size-full rounded-lg object-contain" />
        {displayLabel ? <span className="absolute bottom-1 left-1 rounded px-1 py-0.5 text-[10px] font-medium leading-none" style={{ background: theme.node.panel, color: theme.node.text }}>{displayLabel}</span> : null}
    </>;
    return (
        <div className="group/chip relative inline-flex max-w-[150px] shrink-0 items-center gap-1.5 rounded-lg text-sm" style={{ color: theme.node.text }}>
            {item.dataUrl || item.storageKey ? (
                onSelect ? <button type="button" disabled={disabled} onClick={onSelect} aria-label={t("选择 {label} 作为编辑目标", { label: displayLabel || item.title })} className="relative block size-20 shrink-0 rounded-lg border focus-visible:outline-2" style={{ borderColor: theme.node.stroke, outlineColor: theme.canvas.selectionStroke }}>{preview}</button>
                    : <span className="relative block size-20 shrink-0 rounded-lg border" style={{ borderColor: theme.node.stroke }}>{preview}</span>
            ) : (
                <span className="grid size-8 place-items-center rounded-lg border text-sm font-medium" style={{ background: theme.node.panel, borderColor: theme.node.activeStroke }}>
                    {text}
                </span>
            )}
            {onRemove ? (
                <button
                    type="button"
                    className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full border opacity-0 shadow-sm transition group-hover/chip:opacity-100"
                    style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}
                    onClick={onRemove}
                    aria-label={t("移除引用")}
                >
                    <X className="size-3" />
                </button>
            ) : null}
        </div>
    );
}

function assistantImageReferenceLabel(references: CanvasAssistantReference[], index: number) {
    if (!references[index]?.dataUrl) return undefined;
    const imageIndex = references.slice(0, index + 1).filter((item) => item.dataUrl).length - 1;
    return imageIndex >= 0 ? imageReferenceLabel(imageIndex) : undefined;
}

function formatSessionTime(value?: string) {
    return value ? new Date(value).toLocaleString() : "";
}

function sessionPreview(session: CanvasAssistantSession) {
    for (let index = session.messages.length - 1; index >= 0; index--) {
        const preview = canvasAssistantDisplayMessage(session.messages[index]!);
        if (preview?.text) return preview.text;
    }
    return `${session.messages.length} 条消息`;
}

function objectDetail(value: unknown) {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringifyLog(value: unknown) {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function formatOnlineLogText(logs: OnlineAgentLog[], context: OnlineAgentLogContext) {
    const head = [
        "无线画布 网站 Agent 诊断日志",
        `model: ${context.model || "none"}`,
        `running: ${context.running}`,
        `confirmTools: ${context.confirmTools}`,
        `messages: ${context.messages}`,
        `nodes: ${context.nodes}`,
        `connections: ${context.connections}`,
        `logs: ${logs.length}`,
    ].join("\n");
    const body = logs.map((log, index) => [`#${index + 1} ${log.time} ${log.title}`, log.data === undefined ? "" : stringifyLog(log.data)].filter(Boolean).join("\n")).join("\n\n---\n\n");
    return [head, body || "暂无事件日志"].join("\n\n");
}

function formatOnlineLogJson(logs: OnlineAgentLog[], context: OnlineAgentLogContext) {
    return JSON.stringify({ context, logs: logs.map(({ time, title, data }) => ({ time, title, data })) }, null, 2);
}

function describeCanvasSnapshot(snapshot: CanvasAgentSnapshot) {
    const counts = snapshot.nodes.reduce<Record<string, number>>((acc, node) => {
        acc[node.type] = (acc[node.type] || 0) + 1;
        return acc;
    }, {});
    return `当前画布有 ${snapshot.nodes.length} 个节点、${snapshot.connections.length} 条连线。文本 ${counts[CanvasNodeType.Text] || 0} 个，图片 ${counts[CanvasNodeType.Image] || 0} 个，生成配置 ${counts[CanvasNodeType.Config] || 0} 个，视频 ${counts[CanvasNodeType.Video] || 0} 个，音频 ${counts[CanvasNodeType.Audio] || 0} 个。`;
}

function parseToolArguments(value: string) {
    try {
        const parsed = JSON.parse(value || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("工具参数必须是 JSON 对象");
        return parsed as Record<string, unknown>;
    } catch {
        throw new Error("工具参数不是合法 JSON 对象");
    }
}

export function onlineToolToOps(name: string, input: Record<string, unknown>, snapshot: CanvasAgentSnapshot, config: AiConfig, forcedMediaMode?: "video"): CanvasAgentOp[] {
    if (name === "canvas_apply_ops") return forceGenerationOpsMediaMode(requireOps(input.ops), snapshot, config, forcedMediaMode);
    if (name === "canvas_create_node") {
        const nodeType = requireNodeType(input.nodeType);
        const x = numberOr(input.x, nextCanvasX(snapshot));
        const y = numberOr(input.y, 0);
        if (nodeType === CanvasNodeType.Config) return [configNodeOp(stringOptional(input.id) || `config-${nanoid()}`, { ...recordOptional(input.metadata), ...input }, x, y, config)];
        return [{ type: "add_node", nodeType, title: stringOptional(input.title), position: { x, y }, width: numberOptional(input.width), height: numberOptional(input.height), metadata: recordOptional(input.metadata) as CanvasNodeData["metadata"] }];
    }
    if (name === "canvas_create_text_node") return [textNodeOp(input, numberOr(input.x, nextCanvasX(snapshot)), numberOr(input.y, 0))];
    if (name === "canvas_create_text_nodes") {
        const items = requireRecordArray(input.items, "items");
        const x = numberOr(input.x, nextCanvasX(snapshot));
        const y = numberOr(input.y, 0);
        const gap = numberOr(input.gap, 40);
        const direction = input.direction === "row" ? "row" : "column";
        return items.map((item, index) =>
            textNodeOp(
                { ...item, text: requireString(item.text, "text") },
                numberOr(item.x, direction === "row" ? x + index * (NODE_DEFAULT_SIZE[CanvasNodeType.Text].width + gap) : x),
                numberOr(item.y, direction === "row" ? y : y + index * (NODE_DEFAULT_SIZE[CanvasNodeType.Text].height + gap)),
            ),
        );
    }
    if (name === "canvas_create_image_prompt_flow") return generationFlowOps({ ...input, mode: forcedMediaMode || "image" }, snapshot, config);
    if (name === "canvas_create_config_node") {
        const configId = `config-${nanoid()}`;
        const configInput = forcedMediaMode ? { ...input, mode: forcedMediaMode } : input;
        const mode = generationMode(configInput.mode);
        return [configNodeOp(configId, configInput, numberOr(configInput.x, nextCanvasX(snapshot)), numberOr(configInput.y, 0), config), ...(configInput.autoRun ? [runGenerationOp(configId, mode, stringOptional(configInput.prompt))] : [])];
    }
    if (name === "canvas_create_generation_flow") return generationFlowOps(forcedMediaMode ? { ...input, mode: forcedMediaMode } : input, snapshot, config);
    if (name === "canvas_generate_text") return generationFlowOps({ ...input, mode: "text", autoRun: true }, snapshot, config);
    if (name === "canvas_generate_image") return generationFlowOps({ ...input, mode: forcedMediaMode || (classifyAgentMediaIntent(stringOptional(input.prompt)) === "video" ? "video" : "image"), autoRun: true }, snapshot, config);
    if (name === "canvas_generate_video") return generationFlowOps({ ...input, mode: "video", autoRun: true }, snapshot, config);
    if (name === "canvas_generate_audio") return generationFlowOps({ ...input, mode: "audio", autoRun: true }, snapshot, config);
    if (name === "canvas_update_node") return [{ type: "update_node", id: requireString(input.id, "id"), patch: recordOptional(input.patch) as Partial<CanvasNodeData> | undefined, metadata: recordOptional(input.metadata) as CanvasNodeData["metadata"] }];
    if (name === "canvas_update_node_text")
        return [{ type: "update_node", id: requireString(input.id, "id"), patch: stringOptional(input.title) ? { title: stringOptional(input.title) } : undefined, metadata: { content: requireString(input.text, "text"), status: "success" } }];
    if (name === "canvas_move_nodes") {
        return requireRecordArray(input.items, "items").map((item) => {
            const id = requireString(item.id, "id");
            const current = snapshot.nodes.find((node) => node.id === id);
            return { type: "update_node", id, patch: { position: { x: numberOr(item.x, (current?.position.x || 0) + numberOr(item.dx, 0)), y: numberOr(item.y, (current?.position.y || 0) + numberOr(item.dy, 0)) } } };
        });
    }
    if (name === "canvas_resize_node")
        return [
            {
                type: "update_node",
                id: requireString(input.id, "id"),
                patch: { width: requireNumber(input.width, "width"), height: requireNumber(input.height, "height") },
                metadata: typeof input.freeResize === "boolean" ? { freeResize: input.freeResize } : undefined,
            },
        ];
    if (name === "canvas_delete_nodes") return [{ type: "delete_node", ids: requireStringArray(input.ids, "ids") }];
    if (name === "canvas_connect_nodes")
        return requireRecordArray(input.connections, "connections").map((connection) => ({ type: "connect_nodes", fromNodeId: requireString(connection.fromNodeId, "fromNodeId"), toNodeId: requireString(connection.toNodeId, "toNodeId") }));
    if (name === "canvas_select_nodes") return [{ type: "select_nodes", ids: requireStringArray(input.ids, "ids") }];
    if (name === "canvas_set_viewport") return [{ type: "set_viewport", viewport: requireViewport(input.viewport) }];
    if (name === "canvas_run_generation") {
        const nodeId = requireString(input.nodeId, "nodeId");
        const mode = forcedMediaMode || generationModeFromTarget(snapshot, nodeId) || generationMode(input.mode);
        const generation = runGenerationOp(nodeId, mode, stringOptional(input.prompt));
        return forcedMediaMode === "video" && snapshot.nodes.some((node) => node.id === nodeId && node.type === CanvasNodeType.Config)
            ? [{ type: "update_node", id: nodeId, metadata: generationConfigMetadata(config, forcedMediaMode) }, generation]
            : [generation];
    }
    throw new Error(`不支持的工具：${name}`);
}

export type OnlineToolExecution = { kind: "workflow"; workflow: CanvasAgentMediaWorkflow } | { kind: "ops"; ops: CanvasAgentOp[] };

export function resolveOnlineToolExecution(name: string, input: Record<string, unknown>, userPrompt: string, snapshot: CanvasAgentSnapshot, config: AiConfig): OnlineToolExecution {
    const imageModels = selectableModelsByCapability(config, "image");
    const videoModels = selectableModelsByCapability(config, "video");
    const mediaDispatch = resolveAgentMediaToolDispatch({
        userPrompt,
        toolName: name,
        toolPrompt: stringOptional(input.prompt),
        requestedMode: stringOptional(input.mode),
        targetGenerationMode: name === "canvas_run_generation" ? generationModeFromTarget(snapshot, stringOptional(input.nodeId)) : undefined,
        autoRun: input.autoRun === true,
        ops: Array.isArray(input.ops) ? input.ops.map((op) => (op && typeof op === "object" ? op as { type?: unknown; mode?: unknown; prompt?: unknown } : {})) : undefined,
        referenceNodeIds: Array.isArray(input.referenceNodeIds) ? input.referenceNodeIds.filter((id): id is string => typeof id === "string") : undefined,
        models: {
            imageModel: imageModels.includes(config.imageModel) ? config.imageModel : imageModels[0] || defaultGenerationModel(config, "image"),
            videoModel: videoModels.includes(config.videoModel) ? config.videoModel : videoModels[0] || defaultGenerationModel(config, "video"),
            imageCount: generationCount(config.canvasImageCount || config.count),
            imageQuality: config.quality,
            imageOptions: config.imageOptions,
            videoSeconds: config.videoSeconds,
            aspectRatio: config.size,
        },
    });
    if (mediaDispatch?.kind === "workflow") return { kind: "workflow", workflow: mediaDispatch.workflow };
    return {
        kind: "ops",
        ops: onlineToolToOps(name, input, snapshot, config, mediaDispatch?.kind === "generation" && mediaDispatch.mode === "video" ? "video" : undefined),
    };
}

function forceGenerationOpsMediaMode(ops: CanvasAgentOp[], snapshot: CanvasAgentSnapshot, config: AiConfig, forcedMediaMode?: "video") {
    if (!forcedMediaMode) return ops;
    const targetState = new Map(snapshot.nodes.map((node) => [node.id, { type: node.type, mode: node.metadata?.generationMode }]));
    const forcedRunIndexes = new Set<number>();
    const configNodeIds = new Set<string>();
    ops.forEach((op, index) => {
        if (op.type === "add_node" && op.id && op.nodeType) targetState.set(op.id, { type: op.nodeType, mode: op.metadata?.generationMode });
        if (op.type === "update_node") {
            const current = targetState.get(op.id);
            if (current && op.metadata?.generationMode) targetState.set(op.id, { ...current, mode: op.metadata.generationMode });
        }
        if (op.type !== "run_generation") return;
        const target = targetState.get(op.nodeId);
        const isExplicitVisualRun = op.mode === "image" || op.mode === "video";
        const isOmittedModeVisualConfig = op.mode === undefined && target?.type === CanvasNodeType.Config && (target.mode === "image" || target.mode === "video");
        if (!isExplicitVisualRun && !isOmittedModeVisualConfig) return;
        forcedRunIndexes.add(index);
        if (target?.type === CanvasNodeType.Config) configNodeIds.add(op.nodeId);
    });
    const videoMetadata = generationConfigMetadata(config, forcedMediaMode);
    return ops.reduce<CanvasAgentOp[]>((forcedOps, op, index) => {
        if (op.type === "add_node" && op.nodeType === CanvasNodeType.Config && op.id && configNodeIds.has(op.id)) {
            forcedOps.push({ ...op, metadata: { ...op.metadata, ...videoMetadata } });
            return forcedOps;
        }
        if (op.type === "update_node" && configNodeIds.has(op.id)) {
            forcedOps.push({ ...op, metadata: { ...op.metadata, ...videoMetadata } });
            return forcedOps;
        }
        if (op.type === "run_generation") {
            if (!forcedRunIndexes.has(index)) {
                forcedOps.push(op);
                return forcedOps;
            }
            const generation = { ...op, mode: forcedMediaMode };
            if (configNodeIds.has(op.nodeId)) forcedOps.push({ type: "update_node", id: op.nodeId, metadata: videoMetadata });
            forcedOps.push(generation);
            return forcedOps;
        }
        forcedOps.push(op);
        return forcedOps;
    }, []);
}

function generationFlowOps(input: Record<string, unknown>, snapshot: CanvasAgentSnapshot, config: AiConfig): CanvasAgentOp[] {
    const mode = generationMode(input.mode);
    const prompt = requireString(input.prompt, "prompt");
    const x = numberOr(input.x, nextCanvasX(snapshot));
    const y = numberOr(input.y, 0);
    const textId = `text-${nanoid()}`;
    const configId = `config-${nanoid()}`;
    const referenceNodeIds = Array.isArray(input.referenceNodeIds) ? input.referenceNodeIds.filter((id): id is string => typeof id === "string") : [];
    const tokens = [`@[node:${textId}]`, ...referenceNodeIds.map((id) => `@[node:${id}]`)];
    return [
        textNodeOp({ id: textId, text: prompt, title: stringOptional(input.title) || "提示词" }, x, y),
        configNodeOp(configId, { ...input, prompt: tokens.join("\n") }, x + NODE_DEFAULT_SIZE[CanvasNodeType.Text].width + 80, y, config),
        { type: "connect_nodes", fromNodeId: textId, toNodeId: configId },
        ...referenceNodeIds.map((fromNodeId) => ({ type: "connect_nodes" as const, fromNodeId, toNodeId: configId })),
        { type: "select_nodes", ids: [configId] },
        ...(input.autoRun ? [runGenerationOp(configId, mode, tokens.join("\n"))] : []),
    ];
}

function textNodeOp(input: Record<string, unknown>, x: number, y: number): CanvasAgentOp {
    return {
        type: "add_node",
        id: stringOptional(input.id),
        nodeType: CanvasNodeType.Text,
        title: stringOptional(input.title),
        position: { x, y },
        width: numberOptional(input.width),
        height: numberOptional(input.height),
        metadata: { content: stringOptional(input.text), status: "success", fontSize: 14 },
    };
}

function configNodeOp(id: string, input: Record<string, unknown>, x: number, y: number, config: AiConfig): CanvasAgentOp {
    const mode = generationMode(input.mode);
    const prompt = stringOptional(input.prompt);
    return {
        type: "add_node",
        id,
        nodeType: CanvasNodeType.Config,
        title: stringOptional(input.title) || generationTitle(mode),
        position: { x, y },
        width: numberOptional(input.width),
        height: numberOptional(input.height),
        metadata: cleanRecord({
            generationMode: mode,
            composerContent: prompt,
            prompt,
            status: "idle",
            model: resolveGenerationModel(config, mode, stringOptional(input.model)),
            size: stringOptional(input.size) || config.size,
            quality: stringOptional(input.quality) || config.quality,
            imageOptions: stringOptional(input.imageOptions) ?? config.imageOptions,
            count: numberOptional(input.count) ?? generationCount(mode === "image" ? config.canvasImageCount || config.count : config.count),
            seconds: stringOptional(input.seconds) || config.videoSeconds,
            vquality: stringOptional(input.vquality) || config.vquality,
            generateAudio: stringOptional(input.generateAudio) || config.videoGenerateAudio,
            watermark: stringOptional(input.watermark) || config.videoWatermark,
            audioVoice: stringOptional(input.audioVoice) || config.audioVoice,
            audioFormat: stringOptional(input.audioFormat) || config.audioFormat,
            audioSpeed: stringOptional(input.audioSpeed) || config.audioSpeed,
            audioInstructions: stringOptional(input.audioInstructions) || config.audioInstructions,
        }) as CanvasNodeData["metadata"],
    };
}

function runGenerationOp(nodeId: string, mode: "text" | "image" | "video" | "audio", prompt?: string): CanvasAgentOp {
    return { type: "run_generation", nodeId, mode, prompt };
}

function generationConfigMetadata(config: AiConfig, mode: "video"): CanvasNodeData["metadata"] {
    return { generationMode: mode, model: resolveGenerationModel(config, mode) };
}

function isWritableToolCall(call: ResponseToolCall) {
    return !ONLINE_READ_TOOLS.has(call.function.name);
}

function toolCallsFromDetail(detail: Record<string, unknown>): ResponseToolCall[] {
    return Array.isArray(detail.toolCalls) ? (detail.toolCalls.filter(isResponseToolCall) as ResponseToolCall[]) : [];
}

function isResponseToolCall(value: unknown): value is ResponseToolCall {
    const item = objectDetail(value);
    const fn = objectDetail(item.function);
    return typeof item.id === "string" && item.type === "function" && typeof fn.name === "string" && typeof fn.arguments === "string";
}

function summarizeToolCalls(calls: ResponseToolCall[]) {
    return calls.map((call) => toolCallLabel(call.function.name)).join("，") || "工具调用";
}

function toolCallLabel(name: string) {
    if (name === "canvas_apply_ops") return "画布操作";
    if (name === "canvas_get_state") return "读取画布";
    if (name === "canvas_get_selection") return "读取选区";
    if (name === "canvas_export_snapshot") return "导出快照";
    if (name === "canvas_create_node") return "创建节点";
    if (name === "canvas_create_text_node") return "创建文本";
    if (name === "canvas_create_text_nodes") return "批量创建文本";
    if (name === "canvas_create_config_node") return "创建生成配置";
    if (name === "canvas_create_image_prompt_flow") return "创建生图流程";
    if (name === "canvas_create_generation_flow") return "创建生成流程";
    if (name === "canvas_generate_text") return "生成文本";
    if (name === "canvas_generate_image") return "生成图片";
    if (name === "canvas_generate_video") return "生成视频";
    if (name === "canvas_generate_audio") return "生成音频";
    if (name === "canvas_update_node") return "更新节点";
    if (name === "canvas_update_node_text") return "更新文本";
    if (name === "canvas_move_nodes") return "移动节点";
    if (name === "canvas_resize_node") return "调整节点尺寸";
    if (name === "canvas_delete_nodes") return "删除节点";
    if (name === "canvas_connect_nodes") return "连接节点";
    if (name === "canvas_select_nodes") return "选择节点";
    if (name === "canvas_set_viewport") return "调整视口";
    if (name === "canvas_run_generation") return "触发生成";
    return name;
}

function toolResultText(result: OnlineToolResult) {
    return result.message;
}

function checkedImageContractRepairCall(original: ResponseToolCall, calls: ResponseToolCall[], turn: OnlineTurnContext): ResponseToolCall {
    if (calls.length !== 1 || calls[0].function.name !== "canvas_generate_image") throw new Error("参数纠正必须只返回原图片工具调用");
    const context = turn.imageEditContext || canvasImageEditContext([]);
    const previous = canvasImageEditToolArgs(parseToolArguments(original.function.arguments), context, turn.imageEditTarget), corrected = canvasImageEditToolArgs(parseToolArguments(calls[0].function.arguments), context, turn.imageEditTarget);
    const editable = ["prompt", "editContract", "editIntent"];
    for (const [key, value] of Object.entries(corrected)) {
        if (!editable.includes(key) && JSON.stringify(value) !== JSON.stringify(previous[key])) throw new Error("参数纠正不得改变数量、模型或生成设置");
    }
    if (corrected.editIntent !== previous.editIntent) {
        const context = turn.imageEditContext, known = [...(context?.originals || []), ...(context?.results || [])];
        const sameAsset = (ref: CanvasAssistantReference) => known.some(item => Boolean(item.storageKey || item.dataUrl) && (item.storageKey || item.dataUrl) === (ref.storageKey || ref.dataUrl));
        const sameTaskRedo = previous.editIntent === "new" && corrected.editIntent === "correct_original"
            && context?.originalPrompt && context.originals.length && context.originals.every(ref => ref.storageKey || ref.dataUrl)
            && [...turn.references, ...(turn.imageRepairReferences || [])].every(sameAsset);
        if (!sameTaskRedo) throw new Error("参数纠正不能更换任务、底图或替用户选择结果");
    }
    // Omitted non-editable options retain the originally requested values.
    const args = { ...previous };
    for (const key of editable) {
        if (key in corrected) args[key] = corrected[key];
        else delete args[key];
    }
    return { ...calls[0], function: { ...calls[0].function, arguments: JSON.stringify(args) } };
}

function requireStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`);
    if (!value.every((item) => typeof item === "string" && Boolean(item))) throw new Error(`${field} 必须只包含非空字符串`);
    return value as string[];
}

function requireOps(value: unknown): CanvasAgentOp[] {
    if (!Array.isArray(value)) throw new Error("ops 必须是数组");
    return value.map(toCanvasAgentOp);
}

function toCanvasAgentOp(value: unknown): CanvasAgentOp {
    const item = objectDetail(value);
    const type = item.type;
    if (type === "add_node") {
        return {
            type,
            id: stringOptional(item.id),
            nodeType: item.nodeType ? requireNodeType(item.nodeType) : undefined,
            title: stringOptional(item.title),
            position: recordOptional(item.position) ? { x: requireNumber(objectDetail(item.position).x, "position.x"), y: requireNumber(objectDetail(item.position).y, "position.y") } : undefined,
            x: numberOptional(item.x),
            y: numberOptional(item.y),
            width: numberOptional(item.width),
            height: numberOptional(item.height),
            metadata: recordOptional(item.metadata) as CanvasNodeData["metadata"],
        };
    }
    if (type === "update_node") return { type, id: requireString(item.id, "id"), patch: recordOptional(item.patch) as Partial<CanvasNodeData> | undefined, metadata: recordOptional(item.metadata) as CanvasNodeData["metadata"] };
    if (type === "delete_node") return { type, id: stringOptional(item.id), ids: Array.isArray(item.ids) ? requireStringArray(item.ids, "ids") : undefined };
    if (type === "delete_connections") return { type, id: stringOptional(item.id), ids: Array.isArray(item.ids) ? requireStringArray(item.ids, "ids") : undefined, all: typeof item.all === "boolean" ? item.all : undefined };
    if (type === "connect_nodes") return { type, id: stringOptional(item.id), fromNodeId: requireString(item.fromNodeId, "fromNodeId"), toNodeId: requireString(item.toNodeId, "toNodeId") };
    if (type === "set_viewport") return { type, viewport: requireViewport(item.viewport) };
    if (type === "select_nodes") return { type, ids: requireStringArray(item.ids, "ids") };
    if (type === "run_generation") {
        return {
            type,
            nodeId: requireString(item.nodeId, "nodeId"),
            mode: item.mode === undefined ? undefined : generationMode(item.mode),
            prompt: stringOptional(item.prompt),
        };
    }
    throw new Error("不支持的画布操作类型");
}

function requireRecordArray(value: unknown, field: string): Record<string, unknown>[] {
    if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
    return value.map((item) => {
        const record = objectDetail(item);
        if (!Object.keys(record).length) throw new Error(`${field} 必须只包含对象`);
        return record;
    });
}

function requireString(value: unknown, field: string) {
    if (typeof value !== "string" || !value) throw new Error(`${field} 必须是非空字符串`);
    return value;
}

function requireNumber(value: unknown, field: string) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} 必须是数字`);
    return value;
}

function requireNodeType(value: unknown): CanvasNodeType {
    if (Object.values(CanvasNodeType).includes(value as CanvasNodeType)) return value as CanvasNodeType;
    throw new Error("节点类型必须是 text、image、config、video 或 audio");
}

function requireViewport(value: unknown) {
    const item = objectDetail(value);
    return { x: requireNumber(item.x, "viewport.x"), y: requireNumber(item.y, "viewport.y"), k: requireNumber(item.k, "viewport.k") };
}

function recordOptional(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringOptional(value: unknown) {
    return typeof value === "string" ? value : "";
}

function numberOptional(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberOr(value: unknown, fallback: number) {
    return numberOptional(value) ?? fallback;
}

function nextCanvasX(snapshot: CanvasAgentSnapshot) {
    return snapshot.nodes.length ? Math.max(...snapshot.nodes.map((node) => node.position.x + node.width)) + 80 : 0;
}

function generationMode(value: unknown): "text" | "image" | "video" | "audio" {
    return value === "text" || value === "video" || value === "audio" ? value : "image";
}

function generationModeFromTarget(snapshot: CanvasAgentSnapshot, nodeId: string): "text" | "image" | "video" | "audio" | undefined {
    const mode = snapshot.nodes.find((node) => node.id === nodeId)?.metadata?.generationMode;
    return mode === "text" || mode === "image" || mode === "video" || mode === "audio" ? mode : undefined;
}

function generationTitle(mode: "text" | "image" | "video" | "audio") {
    if (mode === "text") return "文本生成";
    if (mode === "video") return "视频生成";
    if (mode === "audio") return "音频生成";
    return "图片生成";
}

function defaultGenerationModel(config: AiConfig, mode: "text" | "image" | "video" | "audio") {
    if (mode === "image") return config.imageModel || config.model;
    if (mode === "video") return config.videoModel || config.model;
    if (mode === "audio") return config.audioModel || config.model;
    return config.textModel || config.model;
}

function resolveGenerationModel(config: AiConfig, mode: "text" | "image" | "video" | "audio", model?: string) {
    const normalized = normalizeModelOptionValue(model, config.channels);
    return normalized && selectableModelsByCapability(config, mode).includes(normalized) ? normalized : defaultGenerationModel(config, mode);
}

function generationCount(value: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 1)));
}

function cleanRecord(value: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

function snapshotSignature(snapshot: CanvasAgentSnapshot) {
    return JSON.stringify({ nodes: snapshot.nodes, connections: snapshot.connections, selectedNodeIds: snapshot.selectedNodeIds, viewport: snapshot.viewport });
}

function explainNoop(ops: CanvasAgentOp[], snapshot: CanvasAgentSnapshot) {
    if (!ops.length) return "模型没有返回可执行的画布操作。";
    const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
    const connectionIds = new Set(snapshot.connections.map((conn) => conn.id));
    const deleteConnectionOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "delete_connections" }> => op.type === "delete_connections");
    const connectOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "connect_nodes" }> => op.type === "connect_nodes");
    const deleteNodeOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "delete_node" }> => op.type === "delete_node");
    const updateOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "update_node" }> => op.type === "update_node");
    const selectOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "select_nodes" }> => op.type === "select_nodes");
    const generationOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "run_generation" }> => op.type === "run_generation");
    if (deleteConnectionOps.length && !snapshot.connections.length) return "画布当前没有连线可删除。";
    if (deleteConnectionOps.length && deleteConnectionOps.every((op) => !op.all && [...(op.ids || []), ...(op.id ? [op.id] : [])].every((id) => !connectionIds.has(id)))) return "没有找到要删除的连线。";
    if (connectOps.length && connectOps.every((op) => snapshot.connections.some((conn) => conn.fromNodeId === op.fromNodeId && conn.toNodeId === op.toNodeId))) return "这些节点已经存在对应连线，无需重复连接。";
    if (connectOps.length && connectOps.every((op) => !nodeIds.has(op.fromNodeId) || !nodeIds.has(op.toNodeId))) return "没有找到要连接的节点。";
    if (deleteNodeOps.length && deleteNodeOps.every((op) => op.nodeType === CanvasNodeType.Config) && !snapshot.nodes.some((node) => node.type === CanvasNodeType.Config)) return "画布当前没有生成配置节点可删除。";
    if (deleteNodeOps.length && deleteNodeOps.every((op) => [...(op.ids || []), ...(op.id ? [op.id] : [])].every((id) => !nodeIds.has(id)))) return "没有找到要删除的节点。";
    if (updateOps.length && updateOps.every((op) => !nodeIds.has(op.id))) return "没有找到要更新的节点。";
    if (selectOps.length && selectOps.every((op) => !(op.ids || []).some((id) => nodeIds.has(id)))) return "没有找到要选择的节点。";
    if (generationOps.length && generationOps.every((op) => !nodeIds.has(op.nodeId))) return "没有找到要触发生成的节点。";
    if (ops.every((op) => op.type === "set_viewport")) return "视图已经是目标状态。";
    if (selectOps.length && selectOps.every((op) => JSON.stringify(op.ids || []) === JSON.stringify(snapshot.selectedNodeIds))) return "选区已经是目标状态。";
    return "工具已执行，但画布状态没有变化；请在日志 tab 查看工具参数和执行前后状态。";
}

function referenceToImage(reference: CanvasAssistantReference & { dataUrl: string }): ReferenceImage {
    return { id: reference.id, name: reference.title || "参考图片", type: "image/png", dataUrl: reference.dataUrl, storageKey: reference.storageKey };
}

function fileToDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.onabort = () => reject(new Error("读取图片已中止"));
        reader.readAsDataURL(file);
    });
}

async function refineAgentGenerationPrompt(config: AiConfig, settings: AgentGenerationSettings, prompt: string, references: ReferenceImage[]) {
    const messages: AiTextMessage[] = [
        {
            role: "user",
            content: [
                { type: "text", text: buildAgentGenerationBrief(settings, prompt, references.length > 0) },
                ...(await buildAgentReferenceImageContent(references, imageToDataUrl)),
            ],
        },
    ];
    return requestImageQuestion({ ...config, model: config.textModel || config.model, systemPrompt: "" }, messages, () => {}, { tool: "canvas-chat", chatProfile: "canvas-assistant", profileContext: { stage: "english-image-prompt" } });
}

function nodeToReference(node: CanvasNodeData): CanvasAssistantReference | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) {
        return { id: node.id, type: node.type, title: node.title, dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };
    }
    if (node.type === CanvasNodeType.Text && node.metadata?.content) {
        return { id: node.id, type: node.type, title: node.title, text: node.metadata.content };
    }
    return null;
}

function buildAssistantReferences(nodes: CanvasNodeData[]) {
    return nodes
        .map(nodeToReference)
        .filter((item): item is CanvasAssistantReference => Boolean(item));
}

function buildToolAgentMessages(_snapshot: CanvasAgentSnapshot, userMessage: CanvasAssistantMessage, _settings: AgentGenerationSettings, conversation: Awaited<ReturnType<typeof buildCanvasConversationHistory>>, editContext: CanvasImageEditContext, target?: CanvasImageEditTarget, labels?: Record<string, string>): ResponseInputMessage[] {
    const refs = userMessage.references || [];
    return [...conversation.messages, { role: "user", content: [
        ...conversation.currentContent,
        ...(target ? [{ type: "text" as const, text: `用户已在界面锁定编辑目标：${JSON.stringify({ mode: target.mode, baseImageIds: target.mode === "original" ? editContext.originals.map(image => image.id) : [target.reference.id], actualReferences: canvasImageTargetReferences(target, editContext).map(image => ({ id: image.id, label: labels?.[image.id] })) })}。如需生图，只使用 canvas_generate_image；所选目标必须作为 base，不能换成最新结果或用节点生成绕过。图N是会话中的固定编号，不是本次传图顺序。` }] : []),
        ...refs.flatMap(item => item.text ? [{ type: "text" as const, text: "选中节点 " + item.title + "：" + item.text }] : []),
        { type: "text", text: userMessage.text },
    ] }];
}

function canvasChatProfile(turn: OnlineTurnContext, stage: "plan" | "continue" | "repair-image-contract") {
    return { chatProfile: "canvas-assistant" as const, profileContext: {
        stage, userText: turn.userPrompt, snapshot: compactSnapshot(turn.canvasSnapshot, false), settings: turn.settings,
        references: turn.references.filter(item => item.dataUrl || item.storageKey).map((item, index) => ({
            id: item.id, label: turn.imageLabels?.[item.id] || "本轮" + imageReferenceLabel(index), title: item.title,
            source: turn.canvasSnapshot.nodes.some(node => node.id === item.id) ? "canvas" : "upload",
        })),
        editContext: { ...imageEditContextData(turn.imageEditContext || canvasImageEditContext([])), ...(turn.imageEditTarget ? { selectedTarget: { mode: turn.imageEditTarget.mode, baseImageIds: turn.imageEditTarget.mode === "original" ? turn.imageEditContext?.originals.map(image => image.id) : [turn.imageEditTarget.reference.id] } } : {}) },
    } };
}

function compactSnapshot(snapshot: CanvasAgentSnapshot, includeContent = true) {
    return {
        title: snapshot.title,
        viewport: snapshot.viewport,
        selectedNodeIds: snapshot.selectedNodeIds,
        nodes: snapshot.nodes.map((node) => ({
            id: node.id,
            type: node.type,
            title: node.title,
            position: node.position,
            width: node.width,
            height: node.height,
            metadata: compactMetadata(node, includeContent),
        })),
        connections: snapshot.connections,
    };
}

function compactMetadata(node: CanvasNodeData, includeContent: boolean) {
    const metadata = node.metadata;
    return {
        content: includeContent && (node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Config) ? String(metadata?.content || "").slice(0, 500) : undefined,
        prompt: includeContent ? String(metadata?.prompt || metadata?.composerContent || "").slice(0, 500) : undefined,
        status: metadata?.status,
        generationMode: metadata?.generationMode,
        model: metadata?.model,
        size: metadata?.size,
    };
}

function createSession(): CanvasAssistantSession {
    const now = new Date().toISOString();
    return { id: nanoid(), title: "新对话", messages: [], createdAt: now, updatedAt: now };
}
