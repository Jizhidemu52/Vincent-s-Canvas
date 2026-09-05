import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import copyToClipboard from "copy-to-clipboard";
import { Bot, Copy, Cpu, History, ImageIcon, Maximize2, MoreHorizontal, PanelLeft, PanelRightClose, Plus, Settings2, Trash2, Video, X } from "lucide-react";
import { Button, Dropdown, Modal, Popover, Segmented, Switch, Tooltip } from "antd";
import { motion } from "motion/react";

import { modelOptionName, normalizeModelOptionValue, resolveModelChannel, selectableModelsByCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { nanoid } from "nanoid";
import { requestEdit, requestGeneration, requestImageQuestion, requestToolResponse, toolResponseToInput, type AiTextMessage, type ClaudeAssistantContent, type ResponseFunctionTool, type ResponseInputMessage, type ResponseToolCall, type ToolResponseResult } from "@/services/api/image";
import { imageToDataUrl, uploadImage } from "@/services/image-storage";
import { requestVideoGeneration, storeGeneratedVideo, type VideoGenerationTask } from "@/services/api/video";
import { requestAudioGeneration, storeGeneratedAudio } from "@/services/api/audio";
import { serverAssetIdFromAsset, useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { DiaTextReveal } from "@/components/ui/dia-text-reveal";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasAgentMediaWorkflowCard } from "./canvas-agent-media-workflow-card";
import { CanvasPersistedMediaPreview } from "./canvas-persisted-media-preview";
import { AgentChatComposer, AgentChatMessage, AgentModeSwitch, AgentPanelTabs, AgentWorkingMessage, type CanvasAgentChatAttachment, type CanvasAgentMode } from "./canvas-agent-chat-ui";
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

const PANEL_MOTION_SECONDS = CANVAS_AGENT_PANEL_MOTION_MS / 1000;
const ONLINE_AGENT_MAX_STEPS = 4;
const ONLINE_AGENT_PROMPT =
    "你是无线画布内置的创作 Agent。先理解用户本轮请求：普通提问、讨论和图片分析直接用文字回答，不要因为预设选中了图片/视频，或句子出现相关词语，就擅自生成内容。只有用户要求生成或修改媒体时，才把理解后的完整可执行提示词交给对应生成工具：静态图片调用 canvas_generate_image，视频调用 canvas_generate_video。处理参考图时保留用户指定的主体、版型、材质、花型、颜色、Logo 和构图；referenceNodeIds 可使用本轮提供的画布图片或上传参考图的真实 id，必须传入需要保留的参考图，不得忽略。创作预设只提供模型、数量、比例、质量、视频时长与音频的默认值，除非用户明确要求其他值，否则沿用这些设置。需要读画布时调用只读工具；需要创建、移动、连接、删除或修改节点时调用相应画布工具。生成文本或音频可调用相应工具；仅要求搭建流程时创建配置，不自动运行。用户要求先出图再选图做视频时，先完成图片阶段，让用户选定图片之后再生成视频。关于最新信息的问题可使用已启用的联网检索，并保留来源。生成工具会等待真实任务完成并返回结果节点；收到成功结果之前不得声称完成，失败或暂停必须如实说明，不得自行重新提交同一生成任务。不要输出 JSON ops，不要编造节点 id、生成 URL 或执行结果。";
const JSON_RECORD_SCHEMA = { type: "object", additionalProperties: true };
const POSITION_SCHEMA = { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false };
const VIEWPORT_SCHEMA = { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, k: { type: "number" } }, required: ["x", "y", "k"], additionalProperties: false };
const NODE_TYPE_SCHEMA = { type: "string", enum: ["image", "text", "config", "video", "audio"] };
const GENERATION_MODE_SCHEMA = { type: "string", enum: ["text", "image", "video", "audio"] };
const GENERATION_OPTION_PROPERTIES = {
    model: { type: "string" },
    size: { type: "string" },
    quality: { type: "string" },
    count: { type: "number" },
    seconds: { type: "string" },
    vquality: { type: "string" },
    generateAudio: { type: "string" },
    watermark: { type: "string" },
    audioVoice: { type: "string" },
    audioFormat: { type: "string" },
    audioSpeed: { type: "string" },
    audioInstructions: { type: "string" },
};
const CANVAS_OP_SCHEMA = {
    type: "object",
    properties: {
        type: { type: "string", enum: ["add_node", "update_node", "delete_node", "delete_connections", "connect_nodes", "set_viewport", "select_nodes", "run_generation"] },
        id: { type: "string" },
        ids: { type: "array", items: { type: "string" } },
        nodeType: NODE_TYPE_SCHEMA,
        title: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        position: POSITION_SCHEMA,
        metadata: JSON_RECORD_SCHEMA,
        patch: JSON_RECORD_SCHEMA,
        all: { type: "boolean" },
        fromNodeId: { type: "string" },
        toNodeId: { type: "string" },
        viewport: VIEWPORT_SCHEMA,
        nodeId: { type: "string" },
        mode: GENERATION_MODE_SCHEMA,
        prompt: { type: "string" },
    },
    required: ["type"],
    additionalProperties: false,
};
const ONLINE_READ_TOOLS = new Set(["canvas_get_state", "canvas_get_selection", "canvas_export_snapshot"]);

function toolDefinition(name: string, description: string, properties: Record<string, unknown>, required: string[] = [], strict = false): ResponseFunctionTool {
    return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false }, strict } };
}

function generationToolDefinition(name: string, description: string, mode?: "text" | "image" | "video" | "audio") {
    return toolDefinition(
        name,
        description,
        {
            prompt: { type: "string" },
            title: { type: "string" },
            x: { type: "number" },
            y: { type: "number" },
            referenceNodeIds: { type: "array", items: { type: "string" } },
            ...(mode ? {} : { mode: GENERATION_MODE_SCHEMA }),
            autoRun: { type: "boolean" },
            ...GENERATION_OPTION_PROPERTIES,
        },
        ["prompt"],
    );
}

const ONLINE_AGENT_TOOLS: ResponseFunctionTool[] = [
    toolDefinition("canvas_get_state", "读取当前网页画布的节点、连线、选区和视口。", {}),
    toolDefinition("canvas_get_selection", "读取当前网页画布选中的节点。", {}),
    toolDefinition("canvas_export_snapshot", "导出当前画布快照，用于理解布局。", {}),
    toolDefinition(
        "canvas_apply_ops",
        "批量操作当前网页画布。ops 支持 add_node、update_node、delete_node、delete_connections、connect_nodes、set_viewport、select_nodes、run_generation。",
        { ops: { type: "array", items: CANVAS_OP_SCHEMA } },
        ["ops"],
        false,
    ),
    toolDefinition(
        "canvas_create_node",
        "创建任意类型节点：text、image、config、video、audio。适合创建占位图、媒体占位、配置节点或自定义 metadata 节点。",
        { nodeType: NODE_TYPE_SCHEMA, title: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, metadata: JSON_RECORD_SCHEMA },
        ["nodeType"],
    ),
    toolDefinition("canvas_create_text_node", "在当前画布创建单个文本节点。", { text: { type: "string" }, x: { type: "number" }, y: { type: "number" }, title: { type: "string" }, width: { type: "number" }, height: { type: "number" } }),
    toolDefinition(
        "canvas_create_text_nodes",
        "批量创建文本节点，适合生成标题、段落、脚本、说明等内容块。",
        {
            items: {
                type: "array",
                minItems: 1,
                items: {
                    type: "object",
                    properties: { text: { type: "string" }, title: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
                    required: ["text"],
                    additionalProperties: false,
                },
            },
            x: { type: "number" },
            y: { type: "number" },
            gap: { type: "number" },
            direction: { type: "string", enum: ["row", "column"] },
        },
        ["items"],
    ),
    toolDefinition("canvas_create_config_node", "创建生成配置节点，可指定 text/image/video/audio 模式和生成参数，可选择立即触发生成。", {
        prompt: { type: "string" },
        mode: GENERATION_MODE_SCHEMA,
        title: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        autoRun: { type: "boolean" },
        ...GENERATION_OPTION_PROPERTIES,
    }),
    toolDefinition(
        "canvas_create_image_prompt_flow",
        "创建提示词文本节点和图片生成配置节点，并自动连线，可选择立即触发生图。",
        { prompt: { type: "string" }, x: { type: "number" }, y: { type: "number" }, autoRun: { type: "boolean" }, ...GENERATION_OPTION_PROPERTIES },
        ["prompt"],
    ),
    generationToolDefinition("canvas_create_generation_flow", "创建通用生成流程：提示词文本节点、生成配置节点、参考节点连线，可用于文案、生图、视频或音频。"),
    generationToolDefinition("canvas_generate_text", "创建通用文本生成流程并立即触发生成。", "text"),
    generationToolDefinition("canvas_generate_image", "按完整提示词生成静态图片，等待完成后返回可见结果节点；referenceNodeIds 可引用画布图片或本轮上传图片，省略时使用本轮参考图。", "image"),
    generationToolDefinition("canvas_generate_video", "按完整提示词生成视频，等待完成后返回可播放结果节点；referenceNodeIds 可引用画布图片或本轮上传的首帧/参考图。", "video"),
    generationToolDefinition("canvas_generate_audio", "创建通用音频生成流程并立即触发生成。", "audio"),
    toolDefinition("canvas_update_node", "更新节点基础字段或 metadata。", { id: { type: "string" }, patch: JSON_RECORD_SCHEMA, metadata: JSON_RECORD_SCHEMA }, ["id"]),
    toolDefinition("canvas_update_node_text", "更新文本节点内容和标题。", { id: { type: "string" }, text: { type: "string" }, title: { type: "string" } }, ["id", "text"]),
    toolDefinition(
        "canvas_move_nodes",
        "移动一个或多个节点，支持绝对坐标或 dx/dy 偏移。",
        {
            items: {
                type: "array",
                minItems: 1,
                items: { type: "object", properties: { id: { type: "string" }, x: { type: "number" }, y: { type: "number" }, dx: { type: "number" }, dy: { type: "number" } }, required: ["id"], additionalProperties: false },
            },
        },
        ["items"],
    ),
    toolDefinition("canvas_resize_node", "调整节点尺寸。", { id: { type: "string" }, width: { type: "number" }, height: { type: "number" }, freeResize: { type: "boolean" } }, ["id", "width", "height"]),
    toolDefinition("canvas_delete_nodes", "删除指定节点及相关连线。", { ids: { type: "array", items: { type: "string" }, minItems: 1 } }, ["ids"]),
    toolDefinition(
        "canvas_connect_nodes",
        "批量连接节点。",
        { connections: { type: "array", minItems: 1, items: { type: "object", properties: { fromNodeId: { type: "string" }, toNodeId: { type: "string" } }, required: ["fromNodeId", "toNodeId"], additionalProperties: false } } },
        ["connections"],
    ),
    toolDefinition("canvas_select_nodes", "设置当前选中节点。", { ids: { type: "array", items: { type: "string" } } }, ["ids"]),
    toolDefinition("canvas_set_viewport", "调整画布视口。", { viewport: VIEWPORT_SCHEMA }, ["viewport"]),
    toolDefinition("canvas_run_generation", "触发指定节点生成，通常用于配置节点或文本/图片/视频/音频节点。", { nodeId: { type: "string" }, mode: GENERATION_MODE_SCHEMA, prompt: { type: "string" } }, ["nodeId"]),
];
type OnlineAgentTab = "setup" | "chat" | "history" | "log";
type OnlineAgentLog = { id: string; time: string; title: string; data?: unknown };
type OnlineAgentLogContext = { model: string; running: boolean; confirmTools: boolean; messages: number; nodes: number; connections: number };
type OnlineLoopContext = { step: number };
type OnlineTurnContext = { userPrompt: string; references: CanvasAssistantReference[]; settings: AgentGenerationSettings; config: AiConfig };
type OnlineToolResult = { ok: true; message: string; data?: unknown; mediaWorkflow?: CanvasAgentMediaWorkflow } | { ok: false; message: string; data?: unknown };
type OnlineExecutedToolCall = { toolCallId: string; name: string; result: OnlineToolResult };
type PendingOnlineToolContext = { messages: ResponseInputMessage[]; toolCalls: ResponseToolCall[]; claudeAssistantContent?: ClaudeAssistantContent; assistantId: string; step: number; turn: OnlineTurnContext };

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
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const user = useUserStore((state) => state.user);
    const effectiveConfig = useEffectiveConfig();
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
    const [isRunning, setIsRunning] = useState(false);
    const [uploadedReferences, setUploadedReferences] = useState<CanvasAssistantReference[]>([]);
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
        imageCount: effectiveConfig.canvasImageCount || "3",
        videoSeconds: effectiveConfig.videoSeconds || "5",
        videoQuality: effectiveConfig.vquality || "1080P",
        videoGenerateAudio: effectiveConfig.videoGenerateAudio || "false",
        afterImage: "select_then_video",
        };
    });
    const [deleteChatIds, setDeleteChatIds] = useState<string[]>([]);
    const [onlineLogs, setOnlineLogs] = useState<OnlineAgentLog[]>([]);
    const [resizing, setResizing] = useState(false);
    const [removedReferenceIds, setRemovedReferenceIds] = useState<Set<string>>(new Set());
    const [localSessions, setLocalSessions] = useState<CanvasAssistantSession[]>(() => (sessions.length ? sessions : [createSession()]));
    const [localActiveSessionId, setLocalActiveSessionId] = useState<string | null>(activeSessionId);
    const [chatMessageLimit, setChatMessageLimit] = useState(DEFAULT_AGENT_MESSAGE_WINDOW);
    const pendingToolContextRef = useRef(new Map<string, PendingOnlineToolContext>());
    const executingToolIdsRef = useRef(new Set<string>());
    const onlineActionHandlersRef = useRef<{
        approve: (messageId: string) => unknown;
        reject: (messageId: string) => void;
        useImage: (attachment: CanvasAgentChatAttachment) => void;
    }>({
        approve: (_messageId: string) => undefined,
        reject: (_messageId: string) => undefined,
        useImage: (_attachment: CanvasAgentChatAttachment) => undefined,
    });

    useEffect(() => {
        if (!sessions.length) return;
        setLocalSessions(sessions);
        setLocalActiveSessionId(activeSessionId);
    }, [activeSessionId, sessions]);

    useEffect(() => {
        onSessionsChange(localSessions, localActiveSessionId);
    }, [localActiveSessionId, localSessions, onSessionsChange]);

    useEffect(() => {
        if (!canManageConfig && view === "setup") setView("chat");
    }, [canManageConfig, view]);

    const capabilitiesRequestRef = useRef(0);
    const loadCapabilities = useCallback(async () => {
        const request = ++capabilitiesRequestRef.current;
        setCapabilitiesLoading(true);
        setCapabilityError(null);
        const [images, videos] = await Promise.allSettled([getImageGenerationModels(), getGenerationCapabilities()]);
        if (request !== capabilitiesRequestRef.current) return;
        const errors: string[] = [];
        if (images.status === "fulfilled") {
            setImageCapabilities(images.value);
            setGenerationSettings((current) => {
                const selected = images.value.find((model) => model.modelId === current.imageModel) || images.value[0];
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
                const normalized = normalizeAgentVideoSettings({ ...current, videoModel: selected.modelId }, selected.capability);
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
    const renderedMessageWindow = useMemo(() => agentMessageWindow(messages.length, chatMessageLimit), [chatMessageLimit, messages.length]);
    const renderedMessages = useMemo(() => messages.slice(renderedMessageWindow.start), [messages, renderedMessageWindow.start]);
    const hasMessages = messages.length > 0;
    const activeModel = effectiveConfig.textModel || effectiveConfig.model;
    const mediaWorkflowImageModels = useMemo(() => selectableModelsByCapability(effectiveConfig, "image"), [effectiveConfig]);
    const mediaWorkflowVideoModels = useMemo(() => selectableModelsByCapability(effectiveConfig, "video"), [effectiveConfig]);
    const selectedNodeKey = useMemo(() => Array.from(selectedNodeIds).sort().join(","), [selectedNodeIds]);
    const allSelectedReferences = useMemo(() => buildAssistantReferences(selectedNodes), [selectedNodes]);
    const selectedReferences = useMemo(() => allSelectedReferences.filter((item) => !removedReferenceIds.has(item.id)), [allSelectedReferences, removedReferenceIds]);
    const generationReferences = useMemo(() => [...selectedReferences, ...uploadedReferences].filter((item): item is CanvasAssistantReference & { dataUrl: string } => Boolean(item.dataUrl)), [selectedReferences, uploadedReferences]);
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
        const requestConfig = { ...effectiveConfig, model: effectiveConfig.textModel || effectiveConfig.model };
        if (!isAiConfigReady(requestConfig, requestConfig.model)) {
            if (canManageConfig) {
                openConfigDialog(true);
            } else {
                Modal.warning({
                    title: "暂无可用模型",
                    content: "当前账号没有模型配置权限，请联系管理员统一配置模型和 API。",
                });
            }
            return;
        }

        const session = activeSession || createSession();
        if (!activeSession) {
            setLocalSessions([session]);
            setLocalActiveSessionId(session.id);
        }

        const refs = savedReferences || [...selectedReferences, ...uploadedReferences];
        const settings = { ...generationSettings };
        const turn: OnlineTurnContext = { userPrompt: text, references: refs, settings, config: onlineAgentConfig(effectiveConfig, settings) };
        const userMessage: CanvasAssistantMessage = { id: nanoid(), role: "user", text, references: refs, detail: { generationSettings: settings } };
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
            const messages = await buildToolAgentMessages(snapshotRef.current, history, userMessage, turn.settings);
            addOnlineLog(`Agent Tool Loop ${loop.step} 开始`, { toolChoice: "auto" });
            let streamed = "";
            const result = await requestToolResponse(
                { ...requestConfig, systemPrompt: "" },
                messages,
                ONLINE_AGENT_TOOLS,
                "auto",
                (text) => {
                    streamed = text;
                    if (text.trim()) upsertMessage(sessionId, { id: assistantId, role: "assistant", text });
                },
                { webSearch: true },
            );
            addOnlineLog("模型工具回复", { content: result.content, toolCalls: result.toolCalls, stopReason: result.stopReason });
            if (result.toolCalls.length) {
                const writableCalls = result.toolCalls.filter(isWritableToolCall);
                if (confirmTools && writableCalls.length) {
                    upsertMessage(sessionId, { id: assistantId, role: "assistant", text: result.content || streamed || "准备执行工具，等待确认。" });
                    const toolMessageId = nanoid();
                    pendingToolContextRef.current.set(toolMessageId, { messages, toolCalls: result.toolCalls, claudeAssistantContent: result.claudeAssistantContent, assistantId, step: loop.step, turn });
                    const toolMessage: CanvasAssistantMessage = { id: toolMessageId, role: "tool", title: "确认工具调用", text: summarizeToolCalls(result.toolCalls), detail: { status: "pending", step: loop.step, toolCalls: result.toolCalls, generationSettings: turn.settings, referenceImages: turn.references.map(({ id, title }) => ({ id, title })) } };
                    appendMessage(sessionId, toolMessage);
                    addOnlineLog("等待用户确认", result.toolCalls);
                    return;
                }
                if (result.content.trim()) upsertMessage(sessionId, { id: assistantId, role: "assistant", text: result.content });
                await continueOnlineToolLoop(sessionId, assistantId, messages, result, loop.step, turn);
            } else {
                if (!result.content.trim()) throw new Error("模型没有返回工具调用，画布操作未执行。");
                upsertMessage(sessionId, { id: assistantId, role: "assistant", text: result.content || streamed || "没有返回内容。" });
                addOnlineLog(`Agent Tool Loop ${loop.step} 结束`, { reply: result.content });
            }
        } catch (error) {
            addOnlineLog("请求失败", error instanceof Error ? error.message : error);
            appendMessage(sessionId, { id: nanoid(), role: "error", title: "操作失败", text: error instanceof Error ? error.message : "操作失败" });
        } finally {
            setIsRunning(false);
        }
    };

    const continueOnlineToolLoop = async (sessionId: string, assistantId: string, messages: ResponseInputMessage[], result: ToolResponseResult, step: number, turn: OnlineTurnContext) => {
        const toolResults = await executeOnlineToolCalls(sessionId, result.toolCalls, turn);
        addOnlineLog("工具执行结果", toolResults);
        const mediaWorkflow = mediaWorkflowFromResults(toolResults);
        appendMessage(sessionId, {
            id: nanoid(),
            role: "tool",
            title: toolResults.every((item) => item.result.ok) ? "工具自动执行完成" : "工具执行未完成",
            text: toolResults.map((item) => toolResultText(item.result)).join("\n"),
            detail: { status: toolResults.every((item) => item.result.ok) ? "completed" : "failed", step, toolCalls: result.toolCalls, results: toolResults, ...(mediaWorkflow ? { mediaWorkflow } : {}) },
        });
        await continueOnlineToolLoopAfterResults(sessionId, assistantId, messages, result.toolCalls, toolResults, step, turn, result.claudeAssistantContent);
    };

    const continueOnlineToolLoopAfterResults = async (sessionId: string, assistantId: string, messages: ResponseInputMessage[], toolCalls: ResponseToolCall[], toolResults: OnlineExecutedToolCall[], step: number, turn: OnlineTurnContext, claudeAssistantContent?: ClaudeAssistantContent) => {
        const assistantTurn = toolResponseToInput({ toolCalls, claudeAssistantContent });
        const nextMessages: ResponseInputMessage[] = [...messages, ...assistantTurn, ...toolResults.map((item) => ({ role: "tool" as const, tool_call_id: item.toolCallId, content: JSON.stringify(item.result) }))];
        if (toolResults.some((item) => !item.result.ok)) {
            upsertMessage(sessionId, { id: assistantId, role: "assistant", text: toolResults.map((item) => toolResultText(item.result)).join("\n") });
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
            ONLINE_AGENT_TOOLS,
            "auto",
            (text) => {
                streamed = text;
                if (text.trim()) upsertMessage(sessionId, { id: assistantId, role: "assistant", text });
            },
            { webSearch: true },
        );
        addOnlineLog(`Agent Tool Loop ${step + 1} 回复`, { content: next.content, toolCalls: next.toolCalls, stopReason: next.stopReason });
        if (next.toolCalls.length) {
            const writableCalls = next.toolCalls.filter(isWritableToolCall);
            if (confirmTools && writableCalls.length) {
                upsertMessage(sessionId, { id: assistantId, role: "assistant", text: next.content || streamed || "准备执行工具，等待确认。" });
                const toolMessageId = nanoid();
                pendingToolContextRef.current.set(toolMessageId, { messages: nextMessages, toolCalls: next.toolCalls, claudeAssistantContent: next.claudeAssistantContent, assistantId, step: step + 1, turn });
                appendMessage(sessionId, { id: toolMessageId, role: "tool", title: "确认工具调用", text: summarizeToolCalls(next.toolCalls), detail: { status: "pending", step: step + 1, toolCalls: next.toolCalls, generationSettings: turn.settings, referenceImages: turn.references.map(({ id, title }) => ({ id, title })) } });
                addOnlineLog("等待用户确认", next.toolCalls);
                return;
            }
            await continueOnlineToolLoop(sessionId, assistantId, nextMessages, next, step + 1, turn);
            return;
        }
        upsertMessage(sessionId, { id: assistantId, role: "assistant", text: next.content || streamed || toolResults.map((item) => toolResultText(item.result)).join("\n") || "工具已执行。" });
    };

    const executeOps = (ops: CanvasAgentOp[]) => {
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
        const available = new Map<string, CanvasAssistantReference>();
        for (const node of snapshotRef.current.nodes) {
            const reference = nodeToReference(node);
            if (reference?.dataUrl) available.set(reference.id, reference);
        }
        for (const reference of turn.references) if (reference.dataUrl) available.set(reference.id, reference);
        const defaults = turn.references.filter((reference) => reference.dataUrl).map((reference) => reference.id);
        const requestedIds = args.referenceNodeIds === undefined ? [] : requireStringArray(args.referenceNodeIds, "referenceNodeIds");
        const ids = requestedIds.length ? requestedIds : defaults;
        return Array.from(new Set(ids)).map((id) => {
            const reference = available.get(id);
            if (!reference?.dataUrl) throw new Error(`参考图片 ${id} 不存在，请使用当前画布或本轮上传图片的真实 id。`);
            return reference as CanvasAssistantReference & { dataUrl: string };
        });
    };

    const generateOnlineNode = async (sessionId: string, op: Extract<CanvasAgentOp, { type: "run_generation" }>, turn: OnlineTurnContext) => {
        const current = snapshotRef.current;
        const node = current.nodes.find((item) => item.id === op.nodeId);
        if (!node) throw new Error(`要生成的节点 ${op.nodeId} 不存在。`);
        const metadata = node.metadata || {};
        const mode = op.mode || metadata.generationMode || (node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image");
        const config: AiConfig = {
            ...turn.config, model: metadata.model || defaultGenerationModel(turn.config, mode),
            size: metadata.size || turn.config.size, quality: metadata.quality || turn.config.quality,
            count: String(metadata.count ?? turn.config.count), canvasImageCount: String(metadata.count ?? turn.config.canvasImageCount),
            videoSeconds: metadata.seconds || turn.config.videoSeconds, vquality: metadata.vquality || turn.config.vquality,
            videoGenerateAudio: metadata.generateAudio ?? turn.config.videoGenerateAudio,
            videoWatermark: metadata.watermark ?? turn.config.videoWatermark,
            audioVoice: metadata.audioVoice || turn.config.audioVoice, audioFormat: metadata.audioFormat || turn.config.audioFormat,
            audioSpeed: metadata.audioSpeed || turn.config.audioSpeed, audioInstructions: metadata.audioInstructions || turn.config.audioInstructions,
        };
        const context = buildNodeGenerationContext(node.id, current.nodes, current.connections, op.prompt || metadata.composerContent || metadata.prompt || turn.userPrompt);
        executeOps([{ type: "update_node", id: node.id, metadata: { status: "loading", errorDetails: undefined } }]);
        try {
            if (mode === "image" || mode === "video") {
                const settings = onlineAgentMediaSettings(turn.settings, mode, { model: config.model, size: config.size, quality: config.quality, count: Number(config.count), seconds: config.videoSeconds, vquality: config.vquality, generateAudio: config.videoGenerateAudio });
                const result = await runDirectGeneration(sessionId, context.prompt, settings, context.referenceImages, config);
                executeOps([{ type: "update_node", id: node.id, metadata: { status: "success" } }, ...result.data.nodeIds.map((id): CanvasAgentOp => ({ type: "connect_nodes", fromNodeId: node.id, toNodeId: id }))]);
                return result;
            }
            const id = nanoid();
            const position = { x: node.position.x + node.width + 80, y: node.position.y };
            if (mode === "text") {
                const content = await requestImageQuestion(config, buildNodeResponseMessages(await hydrateNodeGenerationContext(context)), () => undefined);
                executeOps([{ type: "add_node", id, nodeType: CanvasNodeType.Text, title: "生成文本", position, metadata: { content, prompt: context.prompt, model: config.model, status: "success" } }, { type: "connect_nodes", fromNodeId: node.id, toNodeId: id }, { type: "update_node", id: node.id, metadata: { status: "success" } }]);
                appendMessage(sessionId, { id: nanoid(), role: "assistant", title: "生成文本", text: content });
                return { ok: true as const, message: "文本已生成并放入画布。", data: { nodeIds: [id] } };
            }
            const audio = await storeGeneratedAudio(await requestAudioGeneration(config, context.prompt), config.audioFormat);
            executeOps([{ type: "add_node", id, nodeType: CanvasNodeType.Audio, title: "生成音频", position, metadata: { content: audio.url, storageKey: audio.storageKey, mimeType: audio.mimeType, prompt: context.prompt, model: config.model, status: "success" } }, { type: "connect_nodes", fromNodeId: node.id, toNodeId: id }, { type: "update_node", id: node.id, metadata: { status: "success" } }]);
            return { ok: true as const, message: "音频已生成，可在画布节点播放。", data: { nodeIds: [id], url: audio.url } };
        } catch (error) {
            executeOps([{ type: "update_node", id: node.id, metadata: { status: "error", errorDetails: error instanceof Error ? error.message : "生成失败" } }]);
            throw error;
        }
    };

    const executeOnlineTool = async (sessionId: string, name: string, args: Record<string, unknown>, turn: OnlineTurnContext): Promise<OnlineToolResult> => {
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
                const settings = onlineAgentMediaSettings(turn.settings, mode, args);
                const references = mediaReferencesForTool(args, turn).map(referenceToImage);
                const generationPrompt = mode === "image" && !imageModelProfile(settings.imageModel).requiresPrompt ? "" : requireString(args.prompt, "prompt");
                return await runDirectGeneration(sessionId, generationPrompt, settings, references, turn.config);
            }
            const referenceTools = ["canvas_create_generation_flow", "canvas_create_image_prompt_flow", "canvas_create_config_node", "canvas_generate_text", "canvas_generate_audio"];
            let references: Array<CanvasAssistantReference & { dataUrl: string }> = [];
            if (referenceTools.includes(name)) {
                references = mediaReferencesForTool(args, turn);
                const missing = references.filter((reference) => !snapshotRef.current.nodes.some((node) => node.id === reference.id));
                if (missing.length) executeOps(missing.map((reference, index) => ({ type: "add_node", id: reference.id, nodeType: CanvasNodeType.Image, title: reference.title, position: { x: nextCanvasX(snapshotRef.current) + index * 380, y: 0 }, metadata: { content: reference.dataUrl, storageKey: reference.storageKey, status: "success" } })));
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
            const generated = await executeOnlineAgentOperations(ops, executeOps, (op) => generateOnlineNode(sessionId, op, turn));
            const changed = before !== snapshotSignature(snapshotRef.current) || generated.length > 0;
            return { ok: changed, message: generated.length ? generated.map((item) => item.message).join("\n") : changed ? summarizeCanvasAgentOps(ops) || "画布操作已执行。" : explainNoop(ops, current), data: { generated, snapshot: compactSnapshot(snapshotRef.current) } };
        } catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : "工具执行失败", ...(error && typeof error === "object" && "taskId" in error ? { data: { taskId: error.taskId, canRecover: "canRecover" in error && error.canRecover, resubmitAllowed: false } } : {}) };
        }
    };

    const executeOnlineToolCall = async (sessionId: string, toolCall: ResponseToolCall, turn: OnlineTurnContext): Promise<OnlineExecutedToolCall> => {
        try {
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
            if (stopped) {
                results.push({ toolCallId: toolCall.id, name: toolCall.function.name, result: { ok: false, message: "前一个工具调用失败，未继续执行。" } });
                continue;
            }
            const result = await executeOnlineToolCall(sessionId, toolCall, turn);
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
            executingToolIdsRef.current.add(messageId);
            setIsRunning(true);
            pendingToolContextRef.current.delete(messageId);
            upsertMessage(session.id, { id: messageId, role: "tool", title: "工具执行中", text: message?.text || summarizeToolCalls(toolCalls), detail: { ...detail, status: "running" } });
            const results = await executeOnlineToolCalls(session.id, toolCalls, pendingContext.turn);
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
            await continueOnlineToolLoopAfterResults(session.id, assistantId, previousMessages, toolCalls, results, pendingContext.step, pendingContext.turn, pendingContext.claudeAssistantContent);
        } catch (error) {
            addOnlineLog("工具续跑失败", error instanceof Error ? error.message : error);
            appendMessage(session.id, { id: nanoid(), role: "error", title: "操作失败", text: error instanceof Error ? error.message : "操作失败" });
        } finally {
            executingToolIdsRef.current.delete(messageId);
            setIsRunning(false);
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
        setGenerationSettings((current) => ({ ...current, ...patch }));
        if (patch.imageModel) updateConfig("imageModel", patch.imageModel);
        if (patch.videoModel) updateConfig("videoModel", patch.videoModel);
        if (patch.size) updateConfig("size", patch.size);
        if (patch.quality) updateConfig("quality", patch.quality);
        if (patch.videoSeconds) updateConfig("videoSeconds", patch.videoSeconds);
        if (patch.videoQuality) updateConfig("vquality", patch.videoQuality);
        if (patch.videoGenerateAudio !== undefined) updateConfig("videoGenerateAudio", patch.videoGenerateAudio);
        if (patch.imageCount) updateConfig("canvasImageCount", patch.imageCount);
    };

    const runDirectGeneration = async (sessionId: string, text: string, settings: AgentGenerationSettings, references: ReferenceImage[], baseConfig: AiConfig) => {
        const plan = buildAgentGenerationPlan(settings, text, references);
        const activeReferences = plan.kind === "video" ? selectAgentVideoReferences(plan.model, references) : references;
        const progressId = nanoid();
        const prompt = plan.kind === "image" && !plan.requiresPrompt ? "" : text.trim();
        const strategy = plan.kind === "image" ? `${!plan.requiresPrompt ? "合成参考图并输出" : references.length ? "以参考图为依据编辑" : "按文字描述生成"} ${plan.count} 张图片` : `${activeReferences.length ? "以所选图片为参考生成" : "按文字描述生成"} ${plan.seconds === "-1" ? "智能时长" : `${plan.seconds} 秒`}视频`;
        appendMessage(sessionId, { id: progressId, role: "assistant", text: `${strategy}，正在执行…${prompt ? `\n\n生成提示词：\n${prompt}` : ""}`, meta: modelOptionName(plan.model), detail: { kind: "agent_generation", status: "running", prompt, settings } });
        let submittedVideoTask: VideoGenerationTask | undefined;
        try {
            if (plan.kind === "image") {
                const config = { ...baseConfig, model: plan.model, imageModel: plan.model, size: plan.size, quality: plan.quality, count: String(plan.count), canvasImageCount: String(plan.count), systemPrompt: "" };
                const generated = references.length ? await requestEdit(config, prompt, references, undefined, { tool: "agent-direct" }) : await requestGeneration(config, prompt, { tool: "agent-direct" });
                if (!generated.length) throw new Error("图片任务没有返回结果，尚未生成可见图片。");
                const storedImages = await Promise.all(generated.map(async (item) => ({ item, image: await uploadImage(item.dataUrl) })));
                const attachments: CanvasAssistantAttachment[] = storedImages.map(({ item, image }, index) => ({
                    id: item.id, name: `生成图片 ${index + 1}`, url: image.url, storageKey: image.storageKey, width: image.width, height: image.height, mediaType: "image",
                    serverAssetId: serverAssetIdFromAsset({ kind: "image", data: { ...image, dataUrl: item.dataUrl } }),
                }));
                executeOps(buildAgentGeneratedMediaOps(attachments, { prompt, model: plan.model, ...resolveAgentGeneratedMediaPosition(snapshotRef.current) }));
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
                upsertMessage(sessionId, { id: progressId, role: "assistant", text: `${message}${prompt ? `\n\n使用提示词：\n${prompt}` : ""}`, attachments, meta: `${attachments.length} 张 · ${modelOptionName(plan.model)} · ${plan.quality}`, detail: { kind: "agent_generation", status: "completed", prompt, settings } });
                return { ok: true as const, message, data: { nodeIds: attachments.map((item) => item.id), mediaType: "image", prompt } };
            }
            const config = { ...baseConfig, model: plan.model, videoModel: plan.model, size: plan.size, videoSeconds: plan.seconds, vquality: plan.quality, videoGenerateAudio: settings.videoGenerateAudio ?? baseConfig.videoGenerateAudio };
            const videoPrompt = buildAgentVideoPrompt(prompt, plan.requiresReference);
            const result = await requestVideoGeneration(config, videoPrompt, activeReferences, [], [], { onSubmitted: (task) => {
                submittedVideoTask = task;
                upsertMessage(sessionId, { id: progressId, role: "assistant", text: `${strategy}，正在等待原任务结果…\n\n生成提示词：\n${videoPrompt}`, meta: modelOptionName(plan.model), detail: { kind: "agent_generation", status: "running", prompt: videoPrompt, settings, videoTask: task } });
            } });
            const video = await storeGeneratedVideo(result);
            const attachments: CanvasAssistantAttachment[] = [{ id: nanoid(), name: "生成视频", mediaType: "video", ...video }];
            executeOps(buildAgentGeneratedMediaOps(attachments, { prompt: videoPrompt, model: plan.model, ...resolveAgentGeneratedMediaPosition(snapshotRef.current) }));
            addAssets([{
                kind: "video", title: prompt.slice(0, 24) || "Agent 视频", coverUrl: "", tags: ["无线画布", "Agent"], source: "无线画布-Agent",
                data: { url: video.url, storageKey: video.storageKey, width: video.width || 0, height: video.height || 0, bytes: video.bytes, mimeType: video.mimeType },
                metadata: { source: "canvas", module: "Agent", nodeId: attachments[0].id, projectId: snapshotRef.current.projectId, prompt: videoPrompt, model: plan.model, serverAssetId: video.serverAssetId },
            }]);
            const message = "视频已生成并放入画布。";
            upsertMessage(sessionId, { id: progressId, role: "assistant", text: `${message}\n\n使用提示词：\n${videoPrompt}`, attachments, meta: `${plan.seconds} 秒 · ${modelOptionName(plan.model)}`, detail: { kind: "agent_generation", status: "completed", prompt: videoPrompt, settings } });
            return { ok: true as const, message, data: { nodeIds: attachments.map((item) => item.id), mediaType: "video", prompt: videoPrompt } };
        } catch (error) {
            const paused = error instanceof QueuedTaskPausedError;
            const videoTask = paused ? { id: error.taskId, provider: "server" as const, model: plan.model } : error instanceof QueuedTaskFailedError ? undefined : submittedVideoTask;
            const canRecover = paused ? error.canRecover : Boolean(videoTask);
            const reason = error instanceof Error ? error.message : "生成失败";
            upsertMessage(sessionId, { id: progressId, role: "error", title: videoTask ? "视频任务尚未完成" : "生成失败", text: reason, detail: { kind: "agent_generation", status: videoTask ? "paused" : "failed", prompt, settings, ...(videoTask ? { videoTask, taskId: videoTask.id, canRecover, resubmitAllowed: false } : {}) } });
            if (videoTask && error instanceof Error) Object.assign(error, { taskId: videoTask.id, canRecover });
            throw error;
        }
    };

    const runVideoFromImage = async (sessionId: string, image: CanvasAssistantAttachment, text: string) => {
        setIsRunning(true);
        try {
            const reference: ReferenceImage = { id: image.id, name: image.name, type: "image/png", dataUrl: await imageToDataUrl(image), storageKey: image.storageKey };
            await runDirectGeneration(sessionId, text, { ...generationSettings, mode: "video" }, [reference], onlineAgentConfig(effectiveConfig, generationSettings));
        } catch (error) {
            addOnlineLog("视频生成未完成", error instanceof Error ? error.message : error);
        } finally {
            setIsRunning(false);
        }
    };

    const submit = async () => {
        const text = prompt.trim();
        if (!text || isRunning) return;
        await sendMessage(text, messages, [...selectedReferences, ...uploadedReferences]);
    };

    const addImagesToAgent = async (files: FileList | File[] | null) => {
        const images = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const references = await Promise.all(images.map(async (file) => ({ id: nanoid(), type: CanvasNodeType.Image, title: file.name || "上传图片", dataUrl: await fileToDataUrl(file) })));
        setUploadedReferences((current) => [...current, ...references]);
    };

    const useImageForVideo = (attachment: CanvasAgentChatAttachment) => {
        if (attachment.mediaType === "video") return;
        const selectedImage: CanvasAssistantAttachment = { id: attachment.id, name: attachment.name, url: attachment.url, storageKey: attachment.storageKey, mediaType: "image" };
        const videoModel = videoCapabilities.find((model) => model.modelId === generationSettings.videoModel);
        const settings: AgentGenerationSettings = videoModel ? normalizeAgentVideoSettings({ ...generationSettings, mode: "video" }, videoModel.capability) : { ...generationSettings, mode: "video" };
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

    onlineActionHandlersRef.current = { approve: approveOnlineTool, reject: rejectOnlineTool, useImage: useImageForVideo };
    const handleApproveOnlineTool = useCallback((messageId: string) => {
        void onlineActionHandlersRef.current.approve(messageId);
    }, []);
    const handleRejectOnlineTool = useCallback((messageId: string) => {
        onlineActionHandlersRef.current.reject(messageId);
    }, []);
    const handleUseImageForVideo = useCallback((attachment: CanvasAgentChatAttachment) => {
        onlineActionHandlersRef.current.useImage(attachment);
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
        onCollapse();
    };

    const onlineContent = (
        <>
            {view !== "chat" ? <AgentPanelTabs
                value={view}
                theme={theme}
                items={[
                    ...(canManageConfig ? [{ value: "setup" as const, label: "连接配置", icon: <Settings2 className="size-3.5" /> }] : []),
                    { value: "chat", label: "对话" },
                    { value: "history", label: "历史", icon: <History className="size-3.5" />, count: historySessions.length },
                    { value: "log", label: "日志", count: onlineLogs.length },
                ]}
                onChange={setView}
                right={
                    <>
                        {view === "history" ? (
                            <Tooltip title="删除全部">
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
                        <Tooltip title="新对话">
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
                            <Tooltip title="配置">
                                <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<Settings2 className="size-4" />} onClick={() => openConfigDialog(false)} />
                            </Tooltip>
                        ) : null}
                    </>
                }
            /> : null}

            {canManageConfig && view === "setup" ? (
                <OnlineAgentSetupView theme={theme} activeModel={activeModel} onOpenConfig={() => openConfigDialog(true)} />
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
                                        加载更早消息（{renderedMessageWindow.hidden} 条）
                                    </Button>
                                </div>
                            ) : null}
                            {renderedMessages.map((message) => (
                                <div key={message.id} className="space-y-2">
                                    <AgentChatMessage item={message} theme={theme} user={user} onRejectTool={handleRejectOnlineTool} onApproveTool={handleApproveOnlineTool} onUseImageForVideo={handleUseImageForVideo} />
                                    {message.references?.length ? <MessageReferences message={message} nodes={snapshotRef.current.nodes} /> : null}
                                    {message.detail?.mediaWorkflow ? (
                                        <CanvasAgentMediaWorkflowCard
                                            workflow={message.detail.mediaWorkflow}
                                            imageModels={mediaWorkflowImageModels}
                                            videoModels={mediaWorkflowVideoModels}
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
                            ))}
                            {isRunning ? <AgentWorkingMessage theme={theme} /> : null}
                        </>
                    ) : <><AgentQuickstart theme={theme} onSelect={(kind) => {
                        const preset = agentQuickstartPreset(kind);
                        updateGenerationSettings({ mode: preset.mode });
                        setPrompt(preset.prompt);
                    }} />{/*
                        <div className="flex h-full flex-col items-center justify-center px-1 text-center">
                            <div className="relative font-serif text-4xl font-bold italic tracking-normal" style={{ color: theme.node.text }}>
                                <span>无线画布</span>
                                <DiaTextReveal className="absolute inset-0" colors={["#A97CF8", "#F38CB8", "#FDCC92"]} textColor="transparent" duration={1.8} startOnView={false} text="无线画布" />
                            </div>
                            <div className="mt-3 font-serif text-base italic tracking-wide opacity-60">One canvas, infinite ideas</div>
                        </div>
                    */}</>}
                </div>
            )}

            {view === "chat" ? (
                <>
                    {selectedReferences.length ? (
                        <div className="thin-scrollbar flex max-w-full gap-1.5 overflow-x-auto px-3 pb-1">
                            {selectedReferences.map((item, index) => (
                                <AssistantReferenceChip
                                    key={item.id}
                                    item={item}
                                    label={assistantImageReferenceLabel(selectedReferences, index)}
                                    onRemove={() => {
                                        setRemovedReferenceIds((prev) => new Set(prev).add(item.id));
                                        if (selectedNodeIds.has(item.id)) onSelectNodeIds(new Set(Array.from(selectedNodeIds).filter((nodeId) => nodeId !== item.id)));
                                    }}
                                />
                            ))}
                        </div>
                    ) : null}
                    {videoConfirmation ? (
                        <div className="mx-3 mb-2 rounded-xl border p-3 shadow-sm" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                            <div className="flex items-center gap-3">
                                <CanvasPersistedMediaPreview kind="image" url={videoConfirmation.selectedImage.url} storageKey={videoConfirmation.selectedImage.storageKey} alt="已选首帧" className="size-12 rounded-md object-cover" />
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium" style={{ color: theme.node.text }}>确认用这张图生成视频</div>
                                    <div className="mt-0.5 text-xs" style={{ color: theme.node.muted }}>它将作为首帧；可先修改下方提示词与视频预设。</div>
                                </div>
                                <Button size="small" onClick={() => setVideoConfirmation(null)}>返回选图</Button>
                                <Button size="small" type="primary" disabled={isRunning} onClick={() => void confirmVideoFromSelectedImage()}>确认生成视频</Button>
                            </div>
                        </div>
                    ) : null}
                    <AgentChatComposer
                        disabled={capabilitiesLoading || (generationSettings.mode === "image" ? !imageCapabilities.length : !videoCapabilities.length)}
                        prompt={prompt}
                        attachments={uploadedReferences.map((item) => ({ id: item.id, name: item.title, url: item.dataUrl || "", storageKey: item.storageKey, mediaType: "image" as const }))}
                        sending={isRunning}
                        placeholder="尽管提问"
                        theme={theme}
                        onPromptChange={(value) => {
                            setPrompt(value);
                            setVideoConfirmation((current) => current ? { ...current, prompt: value } : null);
                        }}
                        onSubmit={submit}
                        onAddFiles={addImagesToAgent}
                        onRemoveAttachment={(id) => setUploadedReferences((current) => current.filter((item) => item.id !== id))}
                        generationControls={<AgentGenerationControls settings={generationSettings} config={effectiveConfig} imageCapabilities={imageCapabilities} videoCapabilities={videoCapabilities} theme={theme} onChange={updateGenerationSettings}
                            loading={capabilitiesLoading} error={capabilityError} onRetry={loadCapabilities}
                            extra={<div className="mt-3 grid gap-3 border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                                <div className="flex items-center justify-between gap-2"><span>对话模型</span><AgentTextModelPicker config={effectiveConfig} value={effectiveConfig.textModel} onChange={(model) => updateConfig("textModel", model)} /></div>
                                <div className="flex items-center justify-between"><span>Agent</span><AgentModeSwitch value={agentMode} theme={theme} onChange={onAgentModeChange} /></div>
                                <label className="flex items-center justify-between">工具执行前确认<Switch size="small" checked={confirmTools} onChange={(confirmTools) => setAgentState({ confirmTools })} /></label>
                                <CanvasPromptLibrary onSelect={setPrompt} />
                            </div>} />}
                    />
                </>
            ) : null}

            <Modal
                title="删除对话记录？"
                open={deleteChatIds.length > 0}
                centered
                onCancel={() => setDeleteChatIds([])}
                footer={
                    <>
                        <Button onClick={() => setDeleteChatIds([])}>取消</Button>
                        <Button
                            danger
                            type="primary"
                            onClick={() => {
                                deleteChatIds.length === historySessions.length ? clearSessions() : removeSessions(deleteChatIds);
                                setDeleteChatIds([]);
                            }}
                        >
                            删除
                        </Button>
                    </>
                }
            >
                <p className="text-sm opacity-60">将删除 {deleteChatIds.length} 条对话记录，此操作不可撤销。</p>
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
                <button type="button" className="absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize" onMouseDown={startResize} aria-label="调整右侧面板宽度" />
                <header className="cw-tabs" role="tablist" aria-label="创作方式">
                    <button type="button" role="tab" aria-selected={false} onClick={collapse}>创建</button>
                    <button type="button" role="tab" aria-selected={true} onClick={() => setView("chat")}>对话</button>
                    <div className="ml-auto flex items-center gap-1">
                        {onToggleLayout ? <Tooltip title={layout === "wide" ? "切换为左侧窄栏" : "切换为宽屏对话"}><button type="button" className="cw-icon" aria-label={layout === "wide" ? "切换为左侧窄栏" : "切换为宽屏对话"} onClick={onToggleLayout}>{layout === "wide" ? <PanelLeft className="size-4.5" /> : <Maximize2 className="size-4.5" />}</button></Tooltip> : null}
                        {hasMessages ? <Tooltip title="新对话"><button type="button" className="cw-icon" aria-label="新对话" onClick={() => { startChatSession(); setView("chat"); }}><Plus className="size-4" /></button></Tooltip> : null}
                        <Dropdown trigger={["click"]} menu={{ items: [
                            { key: "history", icon: <History className="size-4" />, label: "对话历史", onClick: () => { onAgentModeChange("online"); setView("history"); } },
                            { key: "log", label: "运行日志", onClick: () => { onAgentModeChange("online"); setView("log"); } },
                            { type: "divider" },
                            { key: "online", label: `${agentMode === "online" ? "✓ " : ""}网站 Agent`, onClick: () => onAgentModeChange("online") },
                            { key: "local", label: `${agentMode === "local" ? "✓ " : ""}本机 Agent`, onClick: () => onAgentModeChange("local") },
                            ...(canManageConfig ? [{ key: "config", label: "连接配置", onClick: () => openConfigDialog(false) }] : []),
                        ] }}><button type="button" className="cw-icon" aria-label="对话选项"><MoreHorizontal className="size-4" /></button></Dropdown>
                    </div>
                </header>
                {agentMode === "local" ? <CanvasLocalAgentPanel embedded snapshotRef={snapshotRef} canUndoOps={canUndoOps} onApplyOps={onApplyOps} onUndoOps={onUndoOps} autoConnect={autoConnectLocal} /> : onlineContent}
            </motion.aside>
        </motion.div>
    );
}, canvasAssistantPanelPropsEqual);

function AgentTextModelPicker({ config, value, onChange }: { config: AiConfig; value: string; onChange: (model: string) => void }) {
    const options = useMemo(() => Array.from(new Set([value, ...selectableModelsByCapability(config, "text")].filter(Boolean))), [config, value]);
    const current = value || "";
    return (
        <Select value={current} onValueChange={onChange}>
            <SelectTrigger
                hideChevron
                className="h-7 min-w-0 max-w-[220px] gap-1.5 border-0 bg-transparent px-1 py-0 text-xs font-normal shadow-none hover:bg-transparent hover:opacity-75 focus-visible:border-transparent focus-visible:ring-0 data-[state=open]:ring-0 dark:bg-transparent dark:hover:bg-transparent"
                title={current ? `${modelOptionName(current)} · ${resolveModelChannel(config, current).name}` : "选择文本模型"}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
            >
                <AgentModelIcon model={current} />
                <span className="min-w-0 truncate">{current ? modelOptionName(current) : "选择文本模型"}</span>
                {current ? <span className="shrink-0 opacity-55">{resolveModelChannel(config, current).name}</span> : null}
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className="z-[1200] w-72 max-w-[calc(100vw-24px)]"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {options.length ? (
                    options.map((model) => (
                        <SelectItem key={model} value={model} textValue={`${modelOptionName(model)} ${resolveModelChannel(config, model).name}`}>
                            <span className="flex min-w-0 items-center gap-2">
                                <AgentModelIcon model={model} />
                                <span className="min-w-0 flex-1 truncate">{modelOptionName(model)}</span>
                                <span className="shrink-0 text-xs opacity-55">{resolveModelChannel(config, model).name}</span>
                            </span>
                        </SelectItem>
                    ))
                ) : (
                    <SelectItem value="__empty_text_model__" disabled>
                        暂无文本模型
                    </SelectItem>
                )}
            </SelectContent>
        </Select>
    );
}

function AgentQuickstart({ theme, onSelect }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onSelect: (kind: "video" | "lookbook" | "illustration" | "poster") => void }) {
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
            <h2 className="text-lg font-semibold tracking-tight">今天想创作什么？</h2>
            <p className="mt-1 text-sm opacity-55">从提示词开始，或选择下方创作起点</p>
            <div className="mt-5 flex max-w-[290px] flex-wrap justify-center gap-2">
                {items.map((item) => <button key={item.kind} type="button" className="rounded-lg border bg-transparent px-3 py-2 text-sm font-medium transition hover:-translate-y-0.5 hover:shadow-sm" style={{ borderColor: theme.node.stroke }} onClick={() => onSelect(item.kind)}>{item.label}</button>)}
            </div>
        </div>
    );
}

function modelLabel(modelId: string, isImage: boolean, imageModels: ImageGenerationModel[], videoModels: GenerationCapabilityModel[]) {
    if (isImage) return imageModels.find((model) => model.modelId === modelId)?.name || modelOptionName(modelId);
    return videoModels.find((model) => model.modelId === modelId)?.name || modelOptionName(modelId);
}

function AgentGenerationControls({ settings, config: _config, imageCapabilities, videoCapabilities, theme, onChange, extra, loading, error, onRetry }: { settings: AgentGenerationSettings; config: AiConfig; imageCapabilities: ImageGenerationModel[]; videoCapabilities: GenerationCapabilityModel[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (patch: Partial<AgentGenerationSettings>) => void; extra?: import("react").ReactNode; loading: boolean; error: string | null; onRetry: () => void }) {
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
    const modelPicker = (
        <Select value={currentModel || undefined} onValueChange={changeModel} disabled={loading || !currentModels.length}>
            <SelectTrigger hideChevron className="h-8 min-w-0 max-w-[165px] gap-1.5 border-0 bg-transparent px-1 text-xs shadow-none hover:bg-transparent focus-visible:ring-0 dark:bg-transparent" aria-label={isImage ? "图像模型" : "视频模型"}>
                <AgentModelIcon model={currentModel} />
                <span className="min-w-0 truncate">{loading ? "加载中" : currentModel ? modelLabel(currentModel, isImage, imageCapabilities, videoCapabilities) : "未配置模型"}</span>
            </SelectTrigger>
            <SelectContent data-canvas-no-zoom className="z-[1200] w-72" position="popper" align="start">
                {currentModels.map((model) => <SelectItem key={model.modelId} value={model.modelId} textValue={model.name}><span className="flex items-center gap-2"><AgentModelIcon model={model.modelId} /><span>{model.name}</span></span></SelectItem>)}
            </SelectContent>
        </Select>
    );
    return (
        <>
            <div className="inline-flex shrink-0 gap-0.5" role="tablist" aria-label="生成类型">
                <Tooltip title="图像"><button type="button" role="tab" aria-label="图像" aria-selected={isImage} className="grid size-9 place-items-center rounded-md" style={{ background: isImage ? theme.node.fill : "transparent", color: theme.node.text }} onClick={() => onChange(normalizeAgentImageSettings({ ...settings, mode: "image" }, imageProfile))}><ImageIcon className="size-5" /></button></Tooltip>
                <Tooltip title="视频"><button type="button" role="tab" aria-label="视频" aria-selected={!isImage} className="grid size-9 place-items-center rounded-md" style={{ background: !isImage ? theme.node.fill : "transparent", color: theme.node.text }} onClick={() => onChange(videoCapability ? normalizeAgentVideoSettings({ ...settings, mode: "video" }, videoCapability) : { mode: "video" })}><Video className="size-5" /></button></Tooltip>
            </div>
            {isImage ? <div className="min-w-0 max-w-[115px]">{modelPicker}</div> : null}
            <Popover trigger="click" placement="topLeft" content={
                <div data-canvas-no-zoom className="w-[280px] max-w-[calc(100vw-48px)] text-xs">
                    <div className="mb-3 text-sm font-semibold">{isImage ? "图像设置" : "视频设置"}</div>
                    {loading ? <p className="mb-3" role="status">正在加载模型与参数…</p> : error ? <div className="mb-3 space-y-2" role="alert"><p>{error}</p><Button size="small" onClick={onRetry}>重新加载</Button></div> : !currentModels.length ? <p className="mb-3" role="status">尚未配置可用的{isImage ? "图像" : "视频"}模型，请在后台启用模型后重新加载。</p> : null}
                    <div className="grid gap-2">
                        {!isImage ? <div className="flex min-h-9 items-center justify-between gap-3"><span className="opacity-60">模型</span>{modelPicker}</div> : null}
                        {isImage ? <>
                            {imageProfile.verified ? <AgentParameterSelect label={imageProfile.kind === "standard" ? "尺寸" : "宽高比"} value={imageSettings.size} values={[...imageProfile.sizes, ...(!imageProfile.sizes.includes(imageSettings.size) ? [imageSettings.size] : [])]} onChange={(size) => onChange({ size })} /> : null}
                            {imageProfile.maxCount > 1 ? <AgentParameterSelect label="数量" value={imageSettings.imageCount} values={Array.from({ length: imageProfile.maxCount }, (_, index) => String(index + 1))} suffix=" 张" onChange={(imageCount) => onChange({ imageCount })} /> : null}
                            {imageProfile.verified ? <AgentParameterSelect label={imageProfile.qualityLabel} value={imageSettings.quality} values={imageProfile.qualities} onChange={(quality) => onChange({ quality })} /> : null}
                            <p className="mt-1 leading-5 opacity-55">{imageProfile.tip}</p>
                        </> : <>
                            <AgentParameterSelect label="时长" value={settings.videoSeconds} values={videoCapability ? [...(videoSpec?.supportsAutoDuration ? ["-1"] : []), ...Array.from({ length: videoCapability.seconds[1] - videoCapability.seconds[0] + 1 }, (_, index) => String(videoCapability.seconds[0] + index))] : []} suffix=" 秒" onChange={(videoSeconds) => onChange({ videoSeconds })} />
                            <AgentParameterSelect label="宽高比" value={settings.size} values={videoCapability?.sizes.map((size) => size === "adaptive" ? "auto" : size) || []} onChange={(size) => onChange({ size })} />
                            <AgentParameterSelect label="分辨率" value={settings.videoQuality} values={[...videoCapability?.resolutions || []]} onChange={(videoQuality) => onChange({ videoQuality })} />
                            {videoCapability?.supportsAudio ? <label className="flex min-h-9 items-center justify-between gap-3"><span className="opacity-60">音频</span><Switch size="small" checked={settings.videoGenerateAudio === "true"} onChange={(value) => onChange({ videoGenerateAudio: String(value) })} /></label> : null}
                            <p className="mt-1 leading-5 opacity-55">{videoCapability ? `参考图片：${videoCapability.minImages ? "至少 " + videoCapability.minImages + " 张，" : "可选，"}最多 ${videoCapability.maxImages} 张` : "请先配置视频模型"}</p>
                        </>}
                    </div>
                    {extra}
                </div>
            }>
                <button type="button" aria-label={isImage ? "图像设置" : "视频设置"} className="grid size-9 shrink-0 place-items-center rounded-md hover:opacity-60" style={{ color: theme.node.muted }}><Settings2 className="size-5" /></button>
            </Popover>
        </>
    );
}

function AgentParameterSelect({ label, value, values, suffix = "", onChange }: { label: string; value: string; values: string[]; suffix?: string; onChange: (value: string) => void }) {
    return <label className="flex min-h-9 items-center justify-between gap-3"><span className="opacity-60">{label}</span><select aria-label={label} value={value} disabled={!values.length} className="h-8 max-w-[165px] rounded-md border-0 bg-transparent px-2 text-right outline-none" onChange={(event) => onChange(event.target.value)}>{values.map((item) => <option key={item} value={item}>{item === "-1" ? "智能" : `${item === "auto" ? "自动" : item}${suffix}`}</option>)}</select></label>;
}
function AgentModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(modelOptionName(model));
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
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div className="space-y-3">
            <div className="text-sm" style={{ color: theme.node.muted }}>
                {sessions.length ? `${sessions.length} 条历史` : "暂无历史"}
            </div>
            {sessions.map((session) => (
                <div key={session.id} className="rounded-lg border px-2.5 py-1.5 transition" style={{ borderColor: session.id === activeSession?.id ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}>
                    <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                                {session.id === activeSession?.id ? (
                                    <span className="shrink-0 text-[10px] font-medium" style={{ color: theme.node.text }}>
                                        当前
                                    </span>
                                ) : null}
                                <div className="truncate text-sm font-medium leading-5">{session.title}</div>
                            </div>
                            <div className="truncate text-[11px] leading-4 opacity-65">{sessionPreview(session)}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            <span className="text-[10px] opacity-55">{formatSessionTime(session.updatedAt || session.createdAt)}</span>
                            <Button size="small" className="!h-6 !px-2" onClick={() => onOpen(session.id)}>
                                进入
                            </Button>
                            <Tooltip title="删除记录">
                                <Button size="small" danger type="text" className="!h-6 !w-6 !min-w-6" icon={<Trash2 className="size-3.5" />} onClick={() => onDelete(session.id)} />
                            </Tooltip>
                        </div>
                    </div>
                </div>
            ))}
            {!sessions.length ? (
                <div className="px-3 py-8 text-center text-sm" style={{ color: theme.node.muted }}>
                    网站 Agent 的对话记录会显示在这里
                </div>
            ) : null}
        </div>
    );
}

function OnlineAgentSetupView({ theme, activeModel, onOpenConfig }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; activeModel: string; onOpenConfig: () => void }) {
    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
            <div className="space-y-4">
                <div>
                    <div className="text-base font-semibold leading-6">连接配置</div>
                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                        网站 Agent 直接使用当前网页配置的文本模型和 API。
                    </div>
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium leading-5">文本模型</div>
                            <div className="mt-1 truncate text-xs leading-5" style={{ color: theme.node.muted }}>
                                {activeModel || "未配置模型"}
                            </div>
                        </div>
                        <Button className="!h-8 !px-3" type="primary" icon={<Settings2 className="size-4" />} onClick={onOpenConfig}>
                            配置
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function OnlineAgentLogView({ logs, theme, context, onClear }: { logs: OnlineAgentLog[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; context: OnlineAgentLogContext; onClear: () => void }) {
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
                        { label: "排查日志", value: "text" },
                        { label: "原始 JSON", value: "json" },
                    ]}
                />
                <div className="flex items-center gap-2">
                    <span className="text-xs" style={{ color: theme.node.muted }}>
                        {logs.length} 条
                    </span>
                    <Button size="small" icon={<Copy className="size-3.5" />} disabled={!logs.length} onClick={() => void copy()}>
                        复制
                    </Button>
                    <Button size="small" disabled={!lastError} onClick={() => lastError && void copy(formatOnlineLogText([lastError], context))}>
                        最近错误
                    </Button>
                    <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} disabled={!logs.length} onClick={onClear}>
                        清空
                    </Button>
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

function MessageReferences({ message, nodes }: { message: CanvasAssistantMessage; nodes: CanvasNodeData[] }) {
    return (
        <div className={`flex max-w-[88%] flex-wrap gap-2 ${message.role === "user" ? "ml-auto justify-end" : "ml-11 justify-start"}`}>
            {message.references?.map((item, index, references) => {
                const node = !item.storageKey && item.dataUrl?.startsWith("blob:") ? nodes.find((node) => node.id === item.id && node.type === CanvasNodeType.Image) : undefined;
                const reference = node?.metadata?.storageKey ? { ...item, storageKey: node.metadata.storageKey } : item;
                return <AssistantReferenceChip key={`${item.id}-${index}`} item={reference} label={assistantImageReferenceLabel(references, index)} />;
            })}
        </div>
    );
}

function AssistantReferenceChip({ item, label, onRemove }: { item: CanvasAssistantReference; label?: string; onRemove?: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const text = (item.text || item.title).replace(/\s+/g, " ").trim().slice(0, 1) || "文";
    return (
        <div className="group/chip relative inline-flex h-8 max-w-[150px] shrink-0 items-center gap-1.5 rounded-lg text-sm" style={{ color: theme.node.text }}>
            {item.dataUrl || item.storageKey ? (
                <span className="relative block size-8 shrink-0">
                    <CanvasPersistedMediaPreview kind="image" url={item.dataUrl} storageKey={item.storageKey} alt={item.title} className="size-8 rounded-lg object-cover" />
                    {label ? <span className="absolute left-0.5 top-0.5 rounded bg-black/60 px-1 py-0.5 text-[8px] font-medium leading-none text-white">{label}</span> : null}
                </span>
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
                    aria-label="移除引用"
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
    return session.messages.at(-1)?.text || `${session.messages.length} 条消息`;
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
        reader.readAsDataURL(file);
    });
}

async function refineAgentGenerationPrompt(config: AiConfig, settings: AgentGenerationSettings, prompt: string, references: ReferenceImage[]) {
    const messages: AiTextMessage[] = [
        {
            role: "system",
            content: "你是创作编排 Agent。根据用户需求、参考图和预设，输出一段可直接交给指定图片或视频模型的中文生成提示词。只输出最终提示词，不解释、不加标题。保留用户明确要求；有参考图时必须锁定主体、服装、材质、花型、颜色、Logo 与构图中需要保留的元素。",
        },
        {
            role: "user",
            content: [
                { type: "text", text: buildAgentGenerationBrief(settings, prompt, references.length > 0) },
                ...(await buildAgentReferenceImageContent(references, imageToDataUrl)),
            ],
        },
    ];
    return requestImageQuestion({ ...config, model: config.textModel || config.model, systemPrompt: "" }, messages, () => {});
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

async function buildToolAgentMessages(snapshot: CanvasAgentSnapshot, history: CanvasAssistantMessage[], userMessage: CanvasAssistantMessage, settings: AgentGenerationSettings): Promise<ResponseInputMessage[]> {
    const refs = userMessage.references || [];
    return [
        {
            role: "system",
            content: ONLINE_AGENT_PROMPT,
        },
        ...history
            .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "system")
            .slice(-8)
            .map((message): ResponseInputMessage => ({ role: message.role as "system" | "user" | "assistant", content: message.text })),
        {
            role: "user",
            content: [
                ...refs.flatMap((item) => (item.text ? [{ type: "text" as const, text: `选中节点 ${item.title}：${item.text}` }] : [])),
                { type: "text", text: `当前画布：${JSON.stringify(compactSnapshot(snapshot))}\n\n可用参考图片（id可用于referenceNodeIds）：${JSON.stringify(refs.filter((item) => item.dataUrl).map((item) => ({ id: item.id, title: item.title, source: snapshot.nodes.some((node) => node.id === item.id) ? "canvas" : "upload" })))}\n\n创作预设（仅为用户要求生成时的默认参数，不是生成指令）：${JSON.stringify(settings)}\n\n用户需求：${userMessage.text}` },
                ...(await Promise.all(refs.filter((item) => item.dataUrl).map(async (item) => ({ type: "image_url" as const, image_url: { url: await imageToDataUrl(item) } })))),
            ],
        },
    ];
}

function compactSnapshot(snapshot: CanvasAgentSnapshot) {
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
            metadata: compactMetadata(node.metadata || {}),
        })),
        connections: snapshot.connections,
    };
}

function compactMetadata(metadata: CanvasNodeData["metadata"]) {
    return {
        content: String(metadata?.content || "").slice(0, 500),
        prompt: String(metadata?.prompt || metadata?.composerContent || "").slice(0, 500),
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
