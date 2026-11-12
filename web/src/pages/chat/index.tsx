import { getUiLocale, uiText, useUiText } from "@/lib/i18n";
import { handleSubmitShortcut } from "@/lib/submit-shortcut";
import { GenerationDiagnostic } from "@/components/generation-diagnostic";
import { GenerationTaskCancel } from "@/components/generation-task-cancel";
import { PracticeExampleRecord } from "@/components/design-examples";
import { ConversationExamples } from "@/components/conversation-examples";
import { ImageAgentKeepControls } from "@/components/image-agent-keep-controls";
import { App, Button, Checkbox, Popover, Select, Tooltip } from "antd";
import { Bot, Brush, CircleHelp, Copy, FileText, ImagePlus, LoaderCircle, MessageSquarePlus, Paperclip, PanelLeftClose, PanelLeftOpen, Pencil, RotateCcw, Send, Settings2, Square, Trash2, WandSparkles, X } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type SetStateAction } from "react";
import { useNavigate } from "react-router-dom";

import { cn } from "@/lib/utils";
import { deploymentFeatures } from "@/lib/deployment-features";
import { createClientId } from "@/lib/client-id";
import { pastedConversationImageFiles } from "@/lib/conversation-image-clipboard";
import { CHAT_ATTACHMENT_ACCEPT, openChatAttachmentPicker, parseChatAttachment } from "@/lib/chat-attachments";
import { assertCreativeChatImageSelection, buildCreativeImageCatalog, type CreativeChatImageSelection, type CreativeImageCatalogEntry } from "@/lib/creative-chat";
import { conversationImageLabel, type ConversationImageAction, type ConversationImageItem } from "@/components/conversation-image-controls";
import { imageAgentWorkNoteText } from "@/lib/image-agent/work-note";
import { useConversationImageTools } from "@/hooks/use-conversation-image-tools";
import { useImageDrop } from "@/hooks/use-image-drop";
import { useChatBottomFollow } from "@/hooks/use-chat-bottom-follow";
import { useCopyText } from "@/hooks/use-copy-text";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { createDeferredPersistQueue } from "@/lib/deferred-persist-queue";
import { createChatStreamBuffer } from "./chat-stream-buffer";
import { chatSessionStorage } from "./chat-session-storage";
import { chatMedia } from "./chat-media";
import { ChatMarkdown } from "./chat-markdown";
import { ChatImage } from "./chat-image";
import { chatSourceTurn, createChatBranch } from "./chat-message-actions";
import { chatFocusImage, chatImageOriginal } from "./chat-image-selection";
import { chatImageTaskSignature, completeChatImageTask, duplicateChatImageTask } from "./chat-image-tasks";
import { useChatTaskRecovery } from "./use-chat-task-recovery";
import { prepareChatRegionEdit, restoreChatMaskResult, saveChatRegionSelection } from "@/lib/image-agent/mask";
import type { ChatAttachment, ChatGeneratedImage, ChatMessage, ChatRegionSelection, ChatSession } from "./chat-types";
import type { SceneImage } from "@/pages/creative/use-scene-workspace";
import { chatImageQualitySettings, chatImageRequestOptions, filterChatImageModels, preferredChatImageModel, resolveChatImageQuality, selectChatImageModel } from "./image-quality";
import { CHAT_AUTO_IMAGE_SIZE, chatImageSizeOptions, resolveChatImageSize } from "./image-size";
import { automaticReferenceSizeNotice, imageModelProfile, imageReferenceSizeIsAutomatic, useImageModelProfile } from "@/lib/image-model-settings";
import { modelLabelWithUsage } from "@/lib/model-picker-options";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useModuleEnabled } from "@/stores/use-module-store";
import { isClaudeModel, requestEdit, requestGeneration } from "@/services/api/image";
import { requestCreativeChatPlan } from "@/services/api/creative-chat";
import { imageAgentSpecText } from "@/lib/image-agent/compile";
import { requestImageAgentReview } from "@/services/api/image-agent-inspection";
import { prepareChatImageCorrection } from "./chat-image-review";
import { resolveToolModel } from "@/services/api/business-config";
import type { PendingChatImageTask } from "@/services/api/chat-image-recovery";
import { uploadImage } from "@/services/image-storage";
import { flushCanvasPersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType } from "@/types/canvas";
import { AgentDocumentPanel } from "./agent-document-panel";
import { agentDocumentCatalog } from "@/lib/agent-documents";
import { confirmedDesignRequirements } from "@/lib/image-agent/document-tools";
import { mapAgentDocumentMedia } from "@/lib/image-agent/document-media";
import { AGENT_DOCUMENT_LIMITS } from "../../../../shared/image-agent-documents";

const storagePrefix = "wireless-canvas:llm-chat:";
type ChatSendLifetime = {
    sessionId: string;
    controller: AbortController;
    submitted: boolean;
    stopRequested: boolean;
    detached: boolean;
    phase: string;
    stream?: ReturnType<typeof createChatStreamBuffer>;
};
type ChatComposerDraft = {
    draft: string;
    editing: { messageId: string; content: string } | null;
    attachments: ChatAttachment[];
    imageTarget: { id: string; mode: "region" | "correction"; sessionId: string } | null;
    referenceImageIds: string[];
    regionImage: SceneImage | null;
    regionSelection: ChatRegionSelection | null;
};
const emptyComposerDraft = (): ChatComposerDraft => ({ draft: "", editing: null, attachments: [], imageTarget: null, referenceImageIds: [], regionImage: null, regionSelection: null });
const RegionSelectionDialog = lazy(() => import("@/pages/creative/region-selection-dialog").then(module => ({ default: module.RegionSelectionDialog })));
function createSession(): ChatSession {
    return { id: createClientId(), title: "新对话", messages: [], updatedAt: new Date().toISOString() };
}

function sessionTitle(session: ChatSession) {
    const first = session.messages.find((item) => item.role === "user")?.content.trim();
    return first ? first.slice(0, 18) : session.title || "新对话";
}

function readFileAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
    });
}

function dataUrlBytes(dataUrl: string) {
    const comma = dataUrl.indexOf(",");
    return comma < 0 ? 0 : Math.floor((dataUrl.length - comma - 1) * 0.75) - (dataUrl.endsWith("==") ? 2 : dataUrl.endsWith("=") ? 1 : 0);
}

export default function ChatPage() {
    useUiText();
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const user = useUserStore((state) => state.user);
    const config = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const storageKey = `${storagePrefix}${user?.id || "anonymous"}`;
    // Model options and tool bindings must come from the same refresh snapshot.
    const businessConfig = useBusinessConfigStore();
    const { models, tools: toolBindings, status: modelsStatus, refresh: refreshModels } = businessConfig;
    const modelsLoading = modelsStatus === "idle" || modelsStatus === "loading";
    const modelError = modelsStatus === "error" ? businessConfig.error || "模型列表暂时无法读取，请重试。" : "";
    const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches);
    const [sessions, setSessionsState] = useState<ChatSession[]>([]);
    const sessionsRef = useRef(sessions);
    const [loadedStorageKey, setLoadedStorageKey] = useState<string | null>(null);
    const loadedStorageKeyRef = useRef<string | null>(null);
    const isCurrentScope = () => loadedStorageKeyRef.current === storageKey && useUserStore.getState().user?.id === user?.id;
    const [sessionLoadError, setSessionLoadError] = useState("");
    const [sessionSaveError, setSessionSaveError] = useState("");
    const [sessionReload, setSessionReload] = useState(0);
    const sessionsReady = loadedStorageKey === storageKey;
    const setSessions = useCallback((update: SetStateAction<ChatSession[]>) => {
        const next = typeof update === "function" ? update(sessionsRef.current) : update;
        // Keep a synchronous snapshot: pagehide cannot wait for another React commit.
        sessionsRef.current = next;
        setSessionsState(next);
    }, []);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const activeSessionIdRef = useRef(activeSessionId);
    activeSessionIdRef.current = activeSessionId;
    const [composerDraft, setComposerDraftState] = useState(emptyComposerDraft);
    const composerDraftRef = useRef(composerDraft);
    const sessionDraftsRef = useRef(new Map<string, ChatComposerDraft>());
    const { draft, editing, attachments, imageTarget, referenceImageIds, regionImage, regionSelection } = composerDraft;
    const setComposerDraft = (value: ChatComposerDraft) => { composerDraftRef.current = value; setComposerDraftState(value); };
    const updateComposerDraft = <K extends keyof ChatComposerDraft,>(key: K, update: SetStateAction<ChatComposerDraft[K]>) => {
        const current = composerDraftRef.current;
        const value = typeof update === "function" ? (update as (previous: ChatComposerDraft[K]) => ChatComposerDraft[K])(current[key]) : update;
        if (value !== current[key]) setComposerDraft({ ...current, [key]: value });
    };
    const setDraft = (value: SetStateAction<string>) => updateComposerDraft("draft", value);
    const setEditing = (value: SetStateAction<ChatComposerDraft["editing"]>) => updateComposerDraft("editing", value);
    const setAttachments = (value: SetStateAction<ChatAttachment[]>) => updateComposerDraft("attachments", value);
    const setImageTarget = (value: SetStateAction<ChatComposerDraft["imageTarget"]>) => updateComposerDraft("imageTarget", value);
    const setReferenceImageIds = (value: SetStateAction<string[]>) => updateComposerDraft("referenceImageIds", value);
    const setRegionImage = (value: SetStateAction<SceneImage | null>) => updateComposerDraft("regionImage", value);
    const setRegionSelection = (value: SetStateAction<ChatRegionSelection | null>) => updateComposerDraft("regionSelection", value);
    const [readingAttachments, setReadingAttachments] = useState(false);
    const attachmentReadRef = useRef<object | null>(null);
    const [hydratingMedia, setHydratingMedia] = useState(false);
    const [mediaError, setMediaError] = useState("");
    const [mediaReload, setMediaReload] = useState(0);
    const [isSending, setIsSending] = useState(false);
    const sendingRef = useRef(false);
    const activeSendRef = useRef<ChatSendLifetime | null>(null);
    const sendLifetimesRef = useRef(new Set<ChatSendLifetime>());
    const imageRequestsRef = useRef(new Map<string, AbortController>());
    const reviewRequestsRef = useRef(new Map<string, AbortController>());
    const [reviewingImageIds, setReviewingImageIds] = useState<ReadonlySet<string>>(new Set());
    const [activeImageRequestIds, setActiveImageRequestIds] = useState<ReadonlySet<string>>(new Set());
    const [sendPhase, setSendPhase] = useState("");
    const [placingImage, setPlacingImage] = useState(false);
    const placingImageRef = useRef(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const composerRef = useRef<HTMLTextAreaElement>(null);
    const preparingSendsRef = useRef(new Set<ChatSendLifetime>());
    const preparationQueueRef = useRef(Promise.resolve());
    const syncVisibleSend = (sessionId = activeSessionIdRef.current) => {
        const current = [...sendLifetimesRef.current].find(item => item.sessionId === sessionId && !item.detached) || null;
        activeSendRef.current = current;
        sendingRef.current = Boolean(current);
        setIsSending(Boolean(current));
        setSendPhase(current?.phase || "");
    };
    const switchComposerSession = (id: string | null, preserveCurrent = true) => {
        if (preserveCurrent && activeSessionIdRef.current) sessionDraftsRef.current.set(activeSessionIdRef.current, composerDraftRef.current);
        activeSessionIdRef.current = id;
        setActiveSessionId(id);
        setComposerDraft((id && sessionDraftsRef.current.get(id)) || emptyComposerDraft());
        syncVisibleSend(id);
    };
    const clearSubmittedComposer = (id: string, submitted: ChatComposerDraft, branched: boolean) => {
        const current = activeSessionIdRef.current === id ? composerDraftRef.current : sessionDraftsRef.current.get(id);
        if (!current) return;
        // A new draft is a different object, even if the user types the same text
        // again. Only clear the exact submitted version after its durable save.
        const next = branched
            ? current.editing && current.editing === submitted.editing ? { ...current, editing: null } : current
            : current === submitted ? emptyComposerDraft() : current;
        sessionDraftsRef.current.set(id, next);
        if (activeSessionIdRef.current === id) setComposerDraft(next);
    };
    const persistSessions = useCallback(async (value: ChatSession[]) => {
        try {
            await chatSessionStorage.save(storageKey, value);
            if (loadedStorageKeyRef.current === storageKey) setSessionSaveError("");
        } catch (error) {
            if (loadedStorageKeyRef.current === storageKey) setSessionSaveError(uiText("聊天记录保存失败：{value1}。当前内容仍保留在本页，请勿刷新。", { value1: error instanceof Error ? error.message : "本地存储不可用" }));
            throw error;
        }
    }, [storageKey]);
    const persistence = useMemo(() => createDeferredPersistQueue<ChatSession[]>(400, (value) => {
        void persistSessions(value).catch(() => undefined);
    }), [persistSessions]);

    useEffect(() => {
        const flush = () => {
            for (const lifetime of sendLifetimesRef.current) lifetime.stream?.flush();
            if (loadedStorageKeyRef.current === storageKey && !preparingSendsRef.current.size) persistence.schedule(sessionsRef.current);
            persistence.flush();
        };
        window.addEventListener("pagehide", flush);
        return () => {
            window.removeEventListener("pagehide", flush);
            flush();
            // Stop local waits too; submitted image tasks retain their durable
            // recovery marker and are never treated as cancelled or refunded.
            for (const lifetime of sendLifetimesRef.current) { lifetime.stream?.dispose(); lifetime.controller.abort(); }
            sendLifetimesRef.current.clear();
            preparingSendsRef.current.clear();
            activeSendRef.current = null;
            for (const controller of imageRequestsRef.current.values()) controller.abort();
            imageRequestsRef.current.clear();
            for (const controller of reviewRequestsRef.current.values()) controller.abort();
            reviewRequestsRef.current.clear();
            attachmentReadRef.current = null;
            loadedStorageKeyRef.current = null;
        };
    }, [persistence, storageKey]);

    useEffect(() => {
        let cancelled = false;
        loadedStorageKeyRef.current = null;
        setLoadedStorageKey(null);
        setSessionLoadError("");
        setSessionSaveError("");
        setSessions([]);
        sessionDraftsRef.current.clear();
        setComposerDraft(emptyComposerDraft());
        activeSessionIdRef.current = null;
        setActiveSessionId(null);
        setActiveImageRequestIds(new Set());
        sendingRef.current = false;
        preparingSendsRef.current.clear();
        preparationQueueRef.current = Promise.resolve();
        setIsSending(false);
        setReadingAttachments(false);
        setHydratingMedia(false);
        setMediaError("");
        void chatSessionStorage.load(storageKey, () => deploymentFeatures.authenticationEnabled ? null : localStorage.getItem(storageKey))
            .then((stored) => {
                if (cancelled) return;
                const restored = stored.length ? stored : [createSession()];
                setSessions(restored);
                activeSessionIdRef.current = restored[0]!.id;
                setActiveSessionId(restored[0]!.id);
                loadedStorageKeyRef.current = storageKey;
                setLoadedStorageKey(storageKey);
            })
            .catch((error: unknown) => {
                if (!cancelled) setSessionLoadError(uiText("聊天记录读取失败：{value1}。未覆盖原记录。", { value1: error instanceof Error ? error.message : "本地存储不可用" }));
            });
        return () => { cancelled = true; };
    }, [sessionReload, setSessions, storageKey]);

    useEffect(() => {
        const active = sessions.find((item) => item.id === activeSessionId);
        if (!active && activeSessionIdRef.current !== (sessions[0]?.id || null)) switchComposerSession(sessions[0]?.id || null, false);
    }, [activeSessionId, sessions]);

    useEffect(() => {
        // Account changes must not persist the previous account's sessions under the new key.
        if (loadedStorageKey !== storageKey || preparingSendsRef.current.size) return;
        persistence.schedule(sessions);
        if (!isSending) persistence.flush();
    }, [isSending, loadedStorageKey, persistence, sessions, storageKey]);

    useEffect(() => {
        if (modelsStatus === "idle") void refreshModels().catch(() => undefined);
    }, [modelsStatus, refreshModels]);

    const activeSession = useMemo(() => sessions.find((item) => item.id === activeSessionId) || sessions[0], [activeSessionId, sessions]);
    const chatFollow = useChatBottomFollow(activeSession?.messages, activeSessionId || undefined);
    const imageBinding = toolBindings.find(item => item.toolKey === "gpt-chat-image");
    const chatImageEnabled = useModuleEnabled("gpt-chat-image");
    const selected = modelsStatus === "ready" ? resolveToolModel(businessConfig, "gpt-chat") : undefined;
    const selectedModel = selected?.modelId || "";
    // The conversation chooses whether an image task is needed. Demo-only
    // models must never be picked for a real provider task.
    const imageModels = useMemo(() => modelsStatus === "ready" ? filterChatImageModels(models.filter((item) => chatImageEnabled && imageBinding?.enabled !== false && (!imageBinding?.modelConfigId || item.id === imageBinding.modelConfigId) && !item.modelId.startsWith("demo-"))) : [], [models, modelsStatus, imageBinding, chatImageEnabled]);
    const preferredImageModel = preferredChatImageModel(imageModels, [activeSession?.imageModelId, config.imageModel, config.model]);
    const qualityProfile = useImageModelProfile(preferredImageModel?.modelId || "");
    const imageQualitySettings = chatImageQualitySettings(qualityProfile, activeSession?.imageQuality, activeSession?.imageResolution);
    const creativeModelId = selectedModel;
    const imageCatalog = useMemo(() => buildCreativeImageCatalog(activeSession?.messages || []), [activeSession?.messages]);
    const imageLabels = useMemo(() => new Map(imageCatalog.map(item => [item.id, item.label])), [imageCatalog]);
    const composerImageCatalog = useMemo(() => buildCreativeImageCatalog(activeSession?.messages || [], { role: "user", content: "", attachments }), [activeSession?.messages, attachments]);
    const operationTargetId = regionSelection?.imageId || (imageTarget?.sessionId === activeSession?.id && imageTarget?.mode === "correction" ? imageTarget.id : undefined);
    const selectedImage = chatFocusImage(composerImageCatalog, { focusImageId: operationTargetId || (!activeSession?.focusLocked ? activeSession?.focusImageId || activeSession?.editTargetImageId : undefined) });
    const imageReferenceParametersAutomatic = imageReferenceSizeIsAutomatic(qualityProfile, selectedImage || attachments.some(item => item.kind === "image") ? 1 : 0);
    const imageTools = useConversationImageTools();
    const imageActionsDisabled = !sessionsReady || isSending || placingImage || readingAttachments || hydratingMedia || Boolean(editing);
    const selectedParameterModel = selected?.parameterModelId || selected?.modelId || selectedModel;
    const selectedClaude = isClaudeModel(selectedParameterModel);

    useEffect(() => {
        for (const controller of reviewRequestsRef.current.values()) controller.abort();
        reviewRequestsRef.current.clear();
        setReviewingImageIds(new Set());
    }, [activeSession?.id, storageKey]);

    const updateSession = (id: string, update: (session: ChatSession) => ChatSession) => {
        if (!isCurrentScope()) return;
        setSessions((current) => current.map((session) => session.id === id ? update(session) : session));
    };

    useEffect(() => {
        if (!sessionsReady || !activeSession) return;
        let cancelled = false;
        const snapshot = activeSession;
        const assertCurrent = () => { if (cancelled || !isCurrentScope()) throw new DOMException("会话已切换", "AbortError"); };
        setHydratingMedia(true);
        setMediaError("");
        void chatMedia.hydrateSession(snapshot, assertCurrent).then((restored) => {
            assertCurrent();
            // A concurrently recovered image answer must not be overwritten.
            updateSession(snapshot.id, (current) => ({ ...current, ...(current.messages === snapshot.messages ? { messages: restored.messages } : {}), ...(current.documents === snapshot.documents ? { documents: restored.documents } : {}) }));
        }).catch((error: unknown) => {
            if (!cancelled && isCurrentScope()) setMediaError(uiText("历史图片读取未完成：{value1}。原记录未删除。", { value1: error instanceof Error ? error.message : "本地存储不可用" }));
        }).finally(() => { if (!cancelled && isCurrentScope()) setHydratingMedia(false); });
        return () => { cancelled = true; };
    }, [sessionsReady, activeSession?.id, storageKey, mediaReload]);

    const taskRecovery = useChatTaskRecovery({ storageKey, session: activeSession, ready: sessionsReady, sessionsRef, activeRequestIds: activeImageRequestIds, isCurrentScope, updateSession,
        persist: async () => {
            // The prepared user-turn snapshot is already queued. A background
            // completion must not queue an older snapshot without that new turn.
            if (preparingSendsRef.current.size) return;
            persistence.clear(); await persistSessions(sessionsRef.current);
        },
    });

    const startSession = () => {
        if (!sessionsReady || placingImageRef.current || readingAttachments) return;
        const session = createSession();
        setSessions((current) => [session, ...current]);
        switchComposerSession(session.id);
    };

    const selectSession = (id: string) => {
        if (placingImageRef.current || readingAttachments) return;
        switchComposerSession(id);
        if (window.innerWidth < 768) setSidebarOpen(false);
    };

    const stopSending = () => {
        const current = activeSendRef.current;
        if (!current || current.stopRequested) return;
        current.stream?.flush();
        current.stopRequested = true;
        current.controller.abort();
        current.phase = "正在停止本页等待…";
        setSendPhase(current.phase);
    };

    const stopImageWaiting = (item: ChatMessage) => {
        if (!activeSession || !item.pendingImageTask) return;
        updateSession(activeSession.id, session => ({ ...session, messages: session.messages.map(saved => saved.id === item.id ? { ...saved, stopped: true } : saved) }));
        imageRequestsRef.current.get(item.pendingImageTask.requestId)?.abort();
    };

    const selectImageTarget = (image: ConversationImageItem, mode: "region" | "correction") => {
        if (imageActionsDisabled || !activeSession || !isCurrentScope()) return false;
        if (image.unavailableReason) { message.warning(uiText(image.unavailableReason)); return false; }
        const attachedIds = buildCreativeImageCatalog([], { role: "user", content: "", attachments }).map((item) => item.id);
        if (new Set([...attachedIds, image.id]).size > 5) { message.warning(uiText("编辑目标与参考图片合计最多 5 张，请先移除一张图片")); return false; }
        setImageTarget({ id: image.id, mode, sessionId: activeSession.id });
        updateSession(activeSession.id, session => ({ ...session, focusImageId: image.id, editTargetImageId: image.id, focusLocked: true, newCreation: false, focusRevision: (session.focusRevision || 0) + 1 }));
        setRegionSelection(selection => selection?.imageId === image.id ? selection : null);
        composerRef.current?.focus();
        return true;
    };

    const startNewCreation = () => {
        if (imageActionsDisabled || !activeSession) return;
        updateSession(activeSession.id, session => ({ ...session, focusImageId: undefined, editTargetImageId: undefined, focusLocked: false, newCreation: true, focusRevision: (session.focusRevision || 0) + 1 }));
        setImageTarget(null); setRegionSelection(null); composerRef.current?.focus();
    };

    const openRegionSelection = async (imageId: string) => {
        const image = composerImageCatalog.find(item => item.id === imageId);
        if (!image || !activeSession || !selectImageTarget(image, "region")) return;
        const sessionId = activeSession.id;
        const assertCurrent = () => { if (!isCurrentScope() || activeSessionIdRef.current !== sessionId) throw new DOMException("会话已切换", "AbortError"); };
        try {
            const source = await chatMedia.hydrate(image, assertCurrent);
            const { readCanvasMaskImageSize } = await import("@/components/canvas/canvas-node-mask-edit-dialog");
            const size = await readCanvasMaskImageSize(source.dataUrl); assertCurrent();
            setRegionImage({ ...source, ...size, bytes: 0, mimeType: source.type });
        } catch (error) { if (isCurrentScope() && activeSessionIdRef.current === sessionId) message.error(error instanceof Error ? error.message : "无法打开修改区域"); }
    };

    const addImageReference = (image: CreativeImageCatalogEntry) => {
        if (imageActionsDisabled || !isCurrentScope()) return false;
        if (image.unavailableReason) { message.warning(uiText(image.unavailableReason)); return false; }
        const exists = attachments.some((item) => item.id === image.id);
        if (!exists && attachments.length >= 5) { message.warning(uiText("最多添加 5 个附件，请先移除一个附件")); return false; }
        const attachedIds = buildCreativeImageCatalog([], { role: "user", content: "", attachments }).map((item) => item.id);
        if (new Set([...attachedIds, image.id, ...(selectedImage ? [selectedImage.id] : [])]).size > 5) { message.warning(uiText("编辑目标与参考图片合计最多 5 张，请先移除一张图片")); return false; }
        if (!exists) setAttachments((items) => [...items, { id: image.id, name: image.name, kind: "image", mimeType: image.type, dataUrl: image.dataUrl, storageKey: image.storageKey, size: dataUrlBytes(image.dataUrl) }]);
        setReferenceImageIds((ids) => ids.includes(image.id) ? ids : [...ids, image.id]);
        composerRef.current?.focus();
        return true;
    };

    const imageAction = (action: ConversationImageAction, imageId: string) => {
        if (imageActionsDisabled || !isCurrentScope()) return;
        const image = composerImageCatalog.find((item) => item.id === imageId);
        if (!image) return;
        if (action === "copy") { void imageTools.copy(image); return; }
        if (action === "download") { void imageTools.download(image); return; }
        if (action !== "compare") return;
        const original = chatImageOriginal(composerImageCatalog, image.id);
        if (!original.image || original.image.id === image.id) { message.warning(uiText(original.reason || "这张图已经是原图")); return; }
        imageTools.compare(image, [original.image]);
    };

    const reviewImage = async (image: ChatGeneratedImage) => {
        if (imageActionsDisabled || !activeSession || !creativeModelId || !isCurrentScope() || reviewRequestsRef.current.has(image.id)) return;
        const sessionId = activeSession.id, controller = new AbortController();
        const assertCurrent = () => {
            controller.signal.throwIfAborted();
            if (!isCurrentScope() || activeSessionIdRef.current !== sessionId || !sessionsRef.current.find(session => session.id === sessionId)?.messages.some(item => item.generatedImages?.some(saved => saved.id === image.id))) throw new DOMException("会话已切换", "AbortError");
        };
        reviewRequestsRef.current.set(image.id, controller);
        setReviewingImageIds(previous => new Set(previous).add(image.id));
        try {
            assertCurrent();
            const base = imageCatalog.find(item => item.id === image.parentId && !item.unavailableReason);
            const result = imageCatalog.find(item => item.id === image.id && !item.unavailableReason);
            if (!result) throw new Error("生成结果原件不可用，未开始检查。");
            const report = await requestImageAgentReview({ ...config, model: creativeModelId, textModel: creativeModelId, systemPrompt: "" }, { profile: "creative-chat", base, result, prompt: image.prompt || "", spec: image.spec, signal: controller.signal, assertCurrent });
            assertCurrent();
            const review = { report, reviewedAt: new Date().toISOString(), baseImageId: base?.id, baseUnavailable: !base };
            updateSession(sessionId, session => ({ ...session, messages: session.messages.map(item => ({ ...item, ...(item.generatedImages ? { generatedImages: item.generatedImages.map(saved => saved.id === image.id ? { ...saved, review } : saved) } : {}) })) }));
            // A prepared new turn owns its queued snapshot; do not enqueue an
            // older history after it. The normal persistence effect follows commit.
            if (!preparingSendsRef.current.size) { persistence.clear(); await persistSessions(sessionsRef.current); }
        } catch (error) {
            if (!controller.signal.aborted && isCurrentScope() && activeSessionIdRef.current === sessionId) message.error(error instanceof Error ? error.message : "检查失败，原生成结果已保留。");
        } finally {
            if (reviewRequestsRef.current.get(image.id) === controller) reviewRequestsRef.current.delete(image.id);
            if (isCurrentScope() && activeSessionIdRef.current === sessionId) setReviewingImageIds(previous => { const next = new Set(previous); next.delete(image.id); return next; });
        }
    };

    const prepareCorrection = (image: ChatGeneratedImage) => {
        if (imageActionsDisabled || !isCurrentScope() || !activeSession) return;
        if (draft.trim() || attachments.length || referenceImageIds.length || regionSelection) { message.warning("请先发送或清空当前草稿、附件和选区，再准备纠正；已有内容未改动。"); return; }
        try {
            const prepared = prepareChatImageCorrection(image, imageCatalog);
            const sourceReply = activeSession.messages.find(item => item.generatedImages?.some(saved => saved.id === image.id));
            const sourceRegion = activeSession.messages.find(item => item.id === sourceReply?.parentMessageId)?.regionSelection;
            if (image.regionComposite && sourceRegion?.imageId !== prepared.base.id) throw new Error("原局部选区不可重用，请在原图片上重新圈选后描述纠正要求。");
            if (!selectImageTarget(prepared.base, "correction")) return;
            setAttachments(prepared.references.map(reference => ({ id: reference.id, name: reference.name, kind: "image", mimeType: reference.type, dataUrl: reference.dataUrl, storageKey: reference.storageKey, size: dataUrlBytes(reference.dataUrl) })));
            setReferenceImageIds(prepared.references.map(reference => reference.id));
            setRegionSelection(sourceRegion?.imageId === prepared.base.id ? sourceRegion : null);
            setDraft(prepared.prompt); composerRef.current?.focus();
            message.success("已准备纠正草稿；点击发送才会生成新任务。");
        } catch (error) { message.warning(error instanceof Error ? error.message : "无法准备纠正，原结果未改动。"); }
    };

    const placeImageOnCanvas = async (image: ChatGeneratedImage) => {
        if (!sessionsReady || !activeSession || sendingRef.current || placingImageRef.current) return;
        if (!useCanvasStore.getState().hydrated) { message.warning(uiText("画布记录仍在读取，请稍后再试")); return; }
        placingImageRef.current = true;
        setPlacingImage(true);
        const sessionId = activeSession.id;
        try {
            let project = useCanvasStore.getState().projects.find((item) => item.id === activeSession.canvasProjectId);
            const nodeId = `chat-image:${image.id}`;
            if (!project?.nodes.some((node) => node.id === nodeId)) {
                const source = await chatMedia.hydrate(image, () => { if (!isCurrentScope()) throw new DOMException("会话已切换", "AbortError"); });
                const response = await fetch(source.dataUrl);
                if (!response.ok) throw new Error("图片读取失败，尚未添加到画布");
                const blob = await response.blob();
                if (!isCurrentScope()) return;
                if (!blob.type.startsWith("image/")) throw new Error("返回内容不是可用图片");
                const stored = await uploadImage(blob);
                if (!isCurrentScope()) return;
                if (!project) {
                    const projectId = useCanvasStore.getState().createProject(`对话创作 · ${sessionTitle(activeSession)}`);
                    project = useCanvasStore.getState().openProject(projectId)!;
                }
                // Re-read before appending so another canvas tab's local edits survive.
                project = useCanvasStore.getState().openProject(project.id)!;
                const width = Math.min(640, stored.width);
                const x = project.nodes.reduce((right, node) => Math.max(right, node.position.x + node.width + 40), 0);
                useCanvasStore.getState().updateProject(project.id, { nodes: [...project.nodes, {
                    id: nodeId, type: CanvasNodeType.Image, title: "对话创作", position: { x, y: 0 }, width,
                    height: width * stored.height / stored.width,
                    metadata: { content: stored.url, storageKey: stored.storageKey, status: "success", naturalWidth: stored.width, naturalHeight: stored.height, bytes: stored.bytes, mimeType: stored.mimeType, prompt: image.prompt, model: image.modelId, quality: image.quality, imageOptions: image.resolution ? JSON.stringify({ resolution: image.resolution }) : "", imageName: "对话创作", imageVersion: 1 },
                }] });
            }
            // Remember the target before asynchronous persistence, including a
            // failed write. Retrying reuses the same project, node and blob.
            updateSession(sessionId, (session) => ({ ...session, canvasProjectId: project!.id }));
            const latestProject = useCanvasStore.getState().openProject(project!.id)!;
            useCanvasStore.getState().updateProject(project!.id, { nodes: [...latestProject.nodes] });
            await flushCanvasPersistence();
            if (loadedStorageKeyRef.current !== storageKey) return;
            // A background conversation may still own a prepared user-turn
            // write. Do not navigate after overwriting it with an older snapshot.
            while (preparingSendsRef.current.size) {
                await preparationQueueRef.current;
                if (!isCurrentScope()) return;
            }
            persistence.clear();
            await persistSessions(sessionsRef.current);
            if (loadedStorageKeyRef.current !== storageKey) return;
            navigate(`/canvas/${project!.id}`);
        } catch (error) {
            message.error(error instanceof Error ? uiText(error.message) : uiText("添加到画布失败"));
        } finally {
            placingImageRef.current = false;
            setPlacingImage(false);
        }
    };

    const removeSession = (id: string) => {
        if (!sessionsReady || [...sendLifetimesRef.current].some(item => item.sessionId === id) || placingImageRef.current) return;
        const remaining = sessionsRef.current.filter((item) => item.id !== id);
        const next = remaining.length ? remaining : [createSession()];
        setSessions(next);
        sessionDraftsRef.current.delete(id);
        if (activeSessionIdRef.current === id) switchComposerSession(next[0]!.id, false);
    };

    const send = async (resend?: { messageId: string; content?: string }) => {
        if (!sessionsReady || !isCurrentScope() || sendingRef.current || placingImageRef.current || readingAttachments || hydratingMedia || !activeSession) return;
        if (!selectedModel || !selected) {
            message.warning(uiText("管理员尚未启用可用的对话模型"));
            return;
        }
        let branch: ReturnType<typeof createChatBranch> | undefined;
        if (resend) {
            try { branch = createChatBranch(activeSession, resend.messageId, createClientId(), new Date().toISOString()); }
            catch (error) { message.warning(error instanceof Error ? uiText(error.message) : uiText("无法重新发送")); return; }
        }
        const requestSession = branch?.session || activeSession;
        const text = (resend ? resend.content ?? branch!.source.content : draft).trim();
        const turnAttachments = branch?.source.attachments || (resend ? [] : attachments);
        if (!text && !turnAttachments.length) return;
        const turnRegion = resend ? branch!.source.regionSelection || null : regionSelection;
        // Old picker locks are historical state, not authority over a new sentence.
        // Only this turn's region/correction operation or an explicit replay is locked.
        const operationTarget = turnRegion?.imageId || (!resend && imageTarget?.sessionId === requestSession.id && imageTarget.mode === "correction" ? imageTarget.id : undefined);
        const focusContext = resend ? requestSession : { focusImageId: operationTarget || (!requestSession.focusLocked ? requestSession.focusImageId || requestSession.editTargetImageId : undefined) };
        const imageSelection: CreativeChatImageSelection = {
            explicitTargetImageId: operationTarget || (resend && requestSession.focusLocked ? requestSession.focusImageId : undefined),
            referenceImageIds: referenceImageIds.filter((id) => turnAttachments.some((item) => item.id === id)),
            newCreation: resend ? requestSession.newCreation : false,
        };
        const turnFocus = chatFocusImage(buildCreativeImageCatalog(requestSession.messages, { role: "user", content: text, attachments: turnAttachments }), focusContext);
        if (turnRegion && turnRegion.imageId !== turnFocus?.id) { message.warning(uiText("原局部选区与本轮图片不一致，未重新调用模型。请在原图片上重新圈选后发送。")); return; }
        const selectedInputIds = buildCreativeImageCatalog([], { role: "user", content: "", attachments: turnAttachments }).map((item) => item.id);
        if (new Set([...selectedInputIds, ...(imageSelection.explicitTargetImageId ? [imageSelection.explicitTargetImageId] : [])]).size > 5) { message.warning(uiText("编辑目标与参考图片合计最多 5 张，请先移除一张图片")); return; }
        const sessionId = requestSession.id;
        const submittedComposer = composerDraftRef.current;
        const sendLifetime: ChatSendLifetime = { sessionId: activeSession.id, controller: new AbortController(), submitted: false, stopRequested: false, detached: false, phase: "正在理解需求…" };
        const signal = sendLifetime.controller.signal;
        sendLifetimesRef.current.add(sendLifetime);
        syncVisibleSend();
        const assertSendCurrent = () => {
            signal.throwIfAborted();
            if (!isCurrentScope() || !sendLifetimesRef.current.has(sendLifetime)) throw new DOMException("登录会话已变化", "AbortError");
        };
        const persistImageTaskMarker = async () => {
            // A different conversation may still be committing its user turn.
            // Read the snapshot only after that commit enters sessionsRef;
            // queueing the older snapshot would erase its durably saved turn.
            while (preparingSendsRef.current.size) {
                await preparationQueueRef.current;
                assertSendCurrent();
            }
            assertSendCurrent();
            persistence.clear();
            await persistSessions(sessionsRef.current);
            assertSendCurrent();
        };
        const updateSendPhase = (phase: string) => {
            sendLifetime.phase = phase;
            if (!signal.aborted && isCurrentScope() && activeSendRef.current === sendLifetime) setSendPhase(phase);
        };
        const userMessage: ChatMessage = { id: createClientId(), parentMessageId: requestSession.messages.at(-1)?.id, editTargetImageId: turnFocus?.id, focusImageId: turnFocus?.id, focusLocked: Boolean(imageSelection.explicitTargetImageId), newCreation: imageSelection.newCreation, role: "user", content: text, attachments: turnAttachments, documentIds: requestSession.documents?.map(document => document.id), requirementCard: requestSession.requirementCard, ...(turnRegion ? { regionSelection: { ...turnRegion, mask: { ...turnRegion.mask, dataUrl: "", url: undefined }, selection: { ...turnRegion.selection, dataUrl: "", url: undefined } } } : {}), createdAt: new Date().toISOString() };
        const assistantId = createClientId();
        const requestedImageQuality = requestSession.imageQuality;
        const requestedImageResolution = requestSession.imageResolution;
        const requestedImageSize = requestSession.imageSize;

        // Commit the full user turn before clearing its draft or making a model
        // request. A failed write must leave the user's attachments available.
        const selectedSessionModels = { chatModelId: creativeModelId };
        const conversationTitle = (text || turnAttachments[0]?.name || "新对话").slice(0, 18);
        const committedSession = { ...requestSession, ...selectedSessionModels, focusImageId: turnFocus?.id, focusLocked: false, newCreation: imageSelection.newCreation, title: requestSession.messages.length || branch ? requestSession.title : conversationTitle, messages: [...requestSession.messages, userMessage], updatedAt: new Date().toISOString() };
        // Serialize only the durable user-turn commit, not the model requests.
        // Each queued commit reads the newest history so concurrent sessions
        // cannot save a snapshot that loses a just-committed turn.
        const previousPreparation = preparationQueueRef.current;
        let releasePreparation!: () => void;
        preparationQueueRef.current = new Promise<void>(resolve => { releasePreparation = resolve; });
        preparingSendsRef.current.add(sendLifetime);
        persistence.clear();
        try {
            await previousPreparation;
            assertSendCurrent();
            const nextSessions = branch ? [committedSession, ...sessionsRef.current] : sessionsRef.current.map((session) => session.id === sessionId ? { ...session, ...selectedSessionModels, title: committedSession.title, messages: [...session.messages, userMessage], updatedAt: committedSession.updatedAt } : session);
            await persistSessions(nextSessions);
            // Stop during the write still leaves the durably saved user turn
            // visible; the request's abort is checked before any model call.
            if (!isCurrentScope() || !sendLifetimesRef.current.has(sendLifetime)) throw new DOMException("登录会话已变化", "AbortError");
            if (branch) {
                setSessions(current => [committedSession, ...current]);
                sendLifetime.sessionId = sessionId;
                if (activeSessionIdRef.current === activeSession.id) switchComposerSession(sessionId);
                syncVisibleSend();
            }
            else {
                // A previous accepted image task may complete during this write.
                // Append this turn without replacing its newly arrived result.
                updateSession(sessionId, session => ({ ...session, ...selectedSessionModels,
                    ...(requestSession.focusLocked && !imageSelection.explicitTargetImageId && session.focusLocked && session.focusImageId === requestSession.focusImageId && session.focusRevision === requestSession.focusRevision
                        ? { focusImageId: turnFocus?.id, editTargetImageId: turnFocus?.id } : {}),
                    focusLocked: false, newCreation: imageSelection.newCreation,
                    title: committedSession.title, messages: [...session.messages, userMessage], updatedAt: committedSession.updatedAt }));
            }
        } catch {
            sendLifetimesRef.current.delete(sendLifetime);
            if (isCurrentScope()) {
                syncVisibleSend();
                message.error(uiText("聊天记录未保存，消息尚未发送；草稿和附件已保留。"));
            }
            return;
        } finally {
            preparingSendsRef.current.delete(sendLifetime);
            releasePreparation();
        }
        // The user may already be composing in another conversation. Never
        // clear its draft/attachments or pull it back to the completed save.
        clearSubmittedComposer(activeSession.id, submittedComposer, Boolean(branch));
        if (activeSessionIdRef.current === sessionId) chatFollow.scrollToBottom();
        const stream = createChatStreamBuffer((content) => { if (signal.aborted || !sendLifetimesRef.current.has(sendLifetime)) return; updateSession(sessionId, (session) => ({
            ...session,
            messages: [...session.messages.filter((item) => item.id !== assistantId), { id: assistantId, parentMessageId: userMessage.id, role: "assistant", content, createdAt: new Date().toISOString() }],
            updatedAt: new Date().toISOString(),
        })); });
        sendLifetime.stream = stream;
        let imageSubmissionStarted = false;
        let imageRequestId: string | undefined;
        try {
            assertSendCurrent();
            const history = await chatMedia.hydrateSession(requestSession, assertSendCurrent);
            const currentTurn = await chatMedia.hydrateSession({ ...requestSession, messages: [userMessage] }, assertSendCurrent);
            const requirements = confirmedDesignRequirements(requestSession.requirementCard);
            const plan = await requestCreativeChatPlan({ ...config, model: creativeModelId, textModel: creativeModelId, systemPrompt: "" }, history.messages, currentTurn.messages[0]!, { signal, selectedImageId: userMessage.focusImageId, ...imageSelection, documents: history.documents, requirements, onPhase: updateSendPhase, onDelta: stream.push });
            assertSendCurrent();
            stream.cancel();
            assertCreativeChatImageSelection(plan, imageSelection);
            if (plan.kind === "requirements") {
                updateSession(sessionId, session => ({ ...session, requirementCard: { ...plan.requirements, id: createClientId(), status: "draft", updatedAt: new Date().toISOString() }, messages: [...session.messages.filter(item => item.id !== assistantId), { id: assistantId, parentMessageId: userMessage.id, role: "assistant", content: plan.content, createdAt: new Date().toISOString() }] }));
                return;
            }
            if (plan.kind === "discussion") {
                updateSession(sessionId, (session) => ({ ...session, messages: [...session.messages.filter((item) => item.id !== assistantId), { id: assistantId, parentMessageId: userMessage.id, role: "assistant", content: plan.content, candidateImageIds: plan.candidateImageIds, createdAt: new Date().toISOString() }], updatedAt: new Date().toISOString() }));
                return;
            }
            const { references, action, content: explanation, parentId, workId, workNote, spec } = plan;
            assertSendCurrent();
            const imageModel = preferredChatImageModel(imageModels, [requestSession.imageModelId, config.imageModel, config.model], action);
            if (!imageModel) throw new Error(`当前尚未配置可用的图片${action === "edit" ? "编辑" : "生成"}服务。可以继续讨论，图片处理需管理员启用。`);
            const imageModelId = imageModel.modelId;
            const qualitySettings = resolveChatImageQuality(imageModelId, requestedImageQuality, requestedImageResolution);
            if (!qualitySettings.supported) {
                updateSession(sessionId, session => ({ ...session, imageModelId, imageQuality: qualitySettings.quality, imageResolution: qualitySettings.resolution }));
                throw new Error("本次图片操作所用模型不支持原清晰度或图片质量，已更新可选档位。请在输入框下方调整后重新发送；图片任务尚未提交。");
            }
            const quality = qualitySettings.quality;
            const resolution = qualitySettings.resolution;
            updateSendPhase(action === "edit" ? "正在按你的要求修改图片…" : "正在生成图片…");
            let imageConfig: AiConfig = { ...config, model: imageModelId, imageModel: imageModelId, quality, imageOptions: chatImageRequestOptions(config.imageOptions, resolution), systemPrompt: "", count: "1" };
            if (!turnRegion || !imageModelProfile(imageModelId).supportsMask) imageConfig.size = await resolveChatImageSize(imageConfig, requestedImageSize, action, references[0], assertSendCurrent);
            const maskInput = turnRegion ? await prepareChatRegionEdit(imageConfig, references, turnRegion, assertSendCurrent) : undefined;
            if (maskInput) imageConfig = maskInput.config;
            const imagePrompt = maskInput ? `${maskInput.promptPrefix}\n${plan.prompt}` : plan.prompt;
            const currentSession = sessionsRef.current.find(session => session.id === sessionId)!;
            const pendingImageTask: PendingChatImageTask = { requestId: createClientId(), prompt: imagePrompt, modelId: imageModelId, quality, size: imageConfig.size, ...(resolution ? { resolution } : {}), action, parentMessageId: userMessage.id, parentId, workId, workNote, referenceImageIds: references.map(image => image.id), focusRevision: (currentSession.focusRevision || 0) + 1, ...(maskInput?.adaptation ? { maskAdaptation: maskInput.adaptation } : {}), ...(maskInput?.regionComposite ? { regionComposite: maskInput.regionComposite } : {}), explanation };
            pendingImageTask.requirements = requirements;
            pendingImageTask.spec = spec;
            pendingImageTask.signature = chatImageTaskSignature(pendingImageTask);
            if (duplicateChatImageTask(currentSession, pendingImageTask)) throw new Error("已有相同要求的图片任务等待核实，未重复提交。请查询那条原任务；可以继续聊天或发送不同的新要求。");
            imageRequestId = pendingImageTask.requestId;
            imageRequestsRef.current.set(imageRequestId, sendLifetime.controller);
            setActiveImageRequestIds(previous => new Set(previous).add(pendingImageTask.requestId));
            updateSession(sessionId, (session) => ({ ...session, focusRevision: pendingImageTask.focusRevision, imageModelId, imageQuality: quality, imageResolution: resolution, messages: [...session.messages.filter((item) => item.id !== assistantId), { id: assistantId, parentMessageId: userMessage.id, role: "assistant", content: `${explanation ? `${explanation}\n\n` : ""}正在准备图片…`, pendingImageTask, createdAt: new Date().toISOString() }], updatedAt: new Date().toISOString() }));
            await persistImageTaskMarker();
            const onSubmissionStarted = () => { imageSubmissionStarted = true; };
            const onSubmitted = async (taskIds: string[]) => {
                sendLifetime.submitted = true;
                if (!isCurrentScope() || !sendLifetimesRef.current.has(sendLifetime)) return;
                updateSession(sessionId, (session) => ({ ...session, messages: session.messages.map((item) => item.id === assistantId ? { ...item, pendingImageTask: { ...pendingImageTask, taskId: taskIds[0] }, content: "正在处理图片，完成后会直接显示在这里。" } : item), updatedAt: new Date().toISOString() }));
                await persistImageTaskMarker();
                // The accepted request owns its own observer. The composer is free
                // for a different conversation or task without replaying this one.
                sendLifetime.detached = true;
                syncVisibleSend();
            };
            const documentOptions = requirements ? { imageAgentRequirements: requirements, imageAgentDocumentCatalog: agentDocumentCatalog(history.documents || []) } : {};
            const generated = action === "edit"
                ? await requestEdit(imageConfig, imagePrompt, maskInput?.references || references, maskInput?.mask, { operationType: "inpaint", tool: "gpt-chat-image", imageAgentProfile: "creative-chat", ...documentOptions, requestId: pendingImageTask.requestId, signal, cancelOnAbort: () => false, onSubmissionStarted, onSubmitted })
                : await requestGeneration(imageConfig, imagePrompt, { operationType: "image_generation", tool: "gpt-chat-image", imageAgentProfile: "creative-chat", ...documentOptions, requestId: pendingImageTask.requestId, signal, cancelOnAbort: () => false, onSubmissionStarted, onSubmitted });
            assertSendCurrent();
            if (!generated.length) throw new Error("图像模型没有返回图片");
            const savedImages: ChatGeneratedImage[] = [];
            for (const [index, item] of generated.entries()) {
                const dataUrl = await restoreChatMaskResult(pendingImageTask, item.dataUrl); assertSendCurrent();
                savedImages.push(await chatMedia.persist({ id: item.sourceTaskId ? `${item.sourceTaskId}:${index}` : item.id, dataUrl, prompt: imagePrompt, modelId: imageModelId, quality, size: imageConfig.size, ...(resolution ? { resolution } : {}), parentId, workId, workNote, sourceTaskId: item.sourceTaskId, ...(item.dataUrl.startsWith("/api/assets/") ? { sourceResultUrl: item.dataUrl } : {}), ...(pendingImageTask.regionComposite ? { regionComposite: pendingImageTask.regionComposite } : {}) }, assertSendCurrent));
            }
            updateSession(sessionId, session => completeChatImageTask(session, assistantId, pendingImageTask, savedImages));
            if (activeSessionIdRef.current === sessionId) setRegionSelection(selection => selection === turnRegion ? null : selection);
            return;
        } catch (error) {
            stream.flush();
            updateSession(sessionId, (session) => ({
                ...session,
                messages: session.messages.some((item) => item.id === assistantId && item.pendingImageTask)
                    ? session.messages.map((item) => {
                        if (item.id !== assistantId) return item;
                        if (imageSubmissionStarted || sendLifetime.submitted) return { ...item, ...(sendLifetime.stopRequested ? { stopped: true } : {}), content: sendLifetime.stopRequested || item.stopped ? "已停止本页等待。图片任务可能仍在服务端执行；请查询原任务，勿重复生成。" : `图片任务结果尚未确认：${error instanceof Error ? error.message : "请求失败"}。请查询原任务，勿重复生成。` };
                        const { pendingImageTask: _pending, ...saved } = item;
                        if (sendLifetime.stopRequested) return { ...saved, role: "assistant", stopped: true, content: "已停止。图片任务尚未提交；此前的对话请求可能仍在服务端执行。" };
                        return { ...saved, role: "error", content: `图片任务尚未提交：${error instanceof Error ? error.message : "准备失败"}。可以修正后重新发送。` };
                    })
                    : sendLifetime.stopRequested
                        ? [...session.messages.filter((item) => item.id !== assistantId), { id: assistantId, parentMessageId: userMessage.id, role: "assistant", stopped: true, content: session.messages.find((item) => item.id === assistantId)?.content || "已停止接收回复。", createdAt: new Date().toISOString() }]
                        : [...session.messages, { id: createClientId(), parentMessageId: userMessage.id, role: "error", content: error instanceof Error ? uiText(error.message) : uiText("对话请求失败"), createdAt: new Date().toISOString() }],
                updatedAt: new Date().toISOString(),
            }));
        } finally {
            if (imageRequestId) {
                imageRequestsRef.current.delete(imageRequestId);
                if (isCurrentScope()) setActiveImageRequestIds(previous => { const next = new Set(previous); next.delete(imageRequestId!); return next; });
            }
            stream.cancel();
            if (isCurrentScope() && !preparingSendsRef.current.size) {
                persistence.clear();
                await persistSessions(sessionsRef.current).catch(() => undefined);
            }
            sendLifetimesRef.current.delete(sendLifetime);
            if (isCurrentScope()) syncVisibleSend();
        }
    };

    const addFiles = async (files: FileList | File[] | null) => {
        if (!sessionsReady || !files?.length || attachmentReadRef.current || readingAttachments || sendingRef.current || editing) return;
        const remaining = Math.max(0, 5 - attachments.length);
        if (files.length > remaining) message.warning(uiText("每次最多添加 5 个附件，超出的图片或文件未添加"));
        if (!remaining) return;
        const read = {};
        const sessionId = activeSessionId;
        attachmentReadRef.current = read;
        const stillCurrent = () => attachmentReadRef.current === read && isCurrentScope() && activeSessionIdRef.current === sessionId;
        const assertCurrent = () => { if (!stillCurrent()) throw new DOMException("会话已切换", "AbortError"); };
        setReadingAttachments(true);
        const candidates = Array.from(files).slice(0, remaining);
        const next: ChatAttachment[] = [];
        let totalBytes = attachments.filter(item => item.kind !== "text").reduce((sum, item) => sum + (Number(item.size) || 0), 0);
        for (const file of candidates) {
            if (!stillCurrent()) break;
            const imageFile = file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
            if (file.size > (imageFile ? 5 * 1024 * 1024 : AGENT_DOCUMENT_LIMITS.fileBytes)) {
                message.warning(`${file.name} 超过 ${imageFile ? "5MB" : "20MB"}，未添加`);
                continue;
            }
            try {
                const parsed = await parseChatAttachment(file, { imageToDataUrl: readFileAsDataUrl });
                assertCurrent();
                if (parsed.document) {
                    const documents = sessionsRef.current.find(session => session.id === sessionId)?.documents || [];
                    if (documents.length >= AGENT_DOCUMENT_LIMITS.files) throw new Error("每个会话最多保存 8 个设计文件，请另建会话。");
                    const document = await mapAgentDocumentMedia(parsed.document, "persist", assertCurrent);
                    updateSession(sessionId!, session => ({ ...session, documents: [...session.documents || [], document], requirementCard: session.requirementCard ? { ...session.requirementCard, status: "draft" } : undefined }));
                    next.push({ id: createClientId(), name: parsed.name, kind: "text", mimeType: parsed.mimeType, size: file.size, textContent: `设计文件已保存：${document.id}。请从本会话文件目录按页查阅，不视为全文已读。` });
                    continue;
                }
                const size = parsed.dataUrl ? dataUrlBytes(parsed.dataUrl) : file.size;
                if (totalBytes + size > 8 * 1024 * 1024) {
                    message.warning(uiText("本次对话附件总大小不能超过 8MB"));
                    break;
                }
                const attachment = { id: createClientId(), ...parsed, size };
                next.push(parsed.dataUrl ? await chatMedia.persist(attachment, assertCurrent) : attachment);
                totalBytes += size;
            } catch (error) {
                if (stillCurrent()) message.error(error instanceof Error ? uiText(error.message) : uiText("文件读取失败"));
            }
        }
        if (stillCurrent()) {
            if (next.length) setAttachments((current) => [...current, ...next].slice(0, 5));
            setReadingAttachments(false);
            attachmentReadRef.current = null;
        }
    };

    const pasteAttachments = (event: ClipboardEvent<HTMLTextAreaElement>) => {
        const files = pastedConversationImageFiles(event.clipboardData);
        if (!files) return; // Let the browser insert ordinary text at the caret.
        void files.catch(() => undefined);
        event.preventDefault();
        if (editing) { message.warning(uiText("编辑历史消息时保留原附件，请取消编辑后再粘贴新图片")); return; }
        if (sendingRef.current) { message.warning(uiText("请等待当前回复结束后再添加图片")); return; }
        if (attachmentReadRef.current || readingAttachments) { message.warning(uiText("正在读取附件，请稍后再粘贴图片")); return; }
        void files.then(addFiles).catch(error => message.error(error instanceof Error ? uiText(error.message) : uiText("图片复制失败，请重试")));
    };

    const imageDrop = useImageDrop({
        onFiles: addFiles,
        scopeKey: `chat:${storageKey}:${activeSessionId || "new"}`,
        disabled: imageActionsDisabled,
        disabledMessage: editing ? "编辑历史消息时保留原附件，请取消编辑后再拖入新图片。" : "当前暂不能添加图片，请完成正在进行的操作后再拖入。",
        allowNonImages: true,
    });

    const composerAttachments = editing && activeSession ? chatSourceTurn(activeSession, editing.messageId)?.attachments || [] : attachments;
    const composerText = editing?.content ?? draft;
    useLayoutEffect(() => {
        const textarea = composerRef.current;
        if (!textarea) return;
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(176, Math.max(56, textarea.scrollHeight))}px`;
    }, [composerText]);
    const sendComposer = () => void send(editing || undefined);
    const sessionDisabledReason = !sessionsReady ? uiText("正在读取对话，请稍候") : placingImage ? uiText("正在添加图片到画布，请稍候") : readingAttachments ? uiText("正在读取附件，请稍候") : undefined;
    const attachmentDisabledReason = !sessionsReady ? uiText("正在读取对话，请稍候") : isSending ? uiText("当前请求处理中，完成或停止后可添加附件") : editing ? uiText("编辑消息时保留原附件") : readingAttachments ? uiText("正在读取附件，请稍候") : attachments.length >= 5 ? uiText("最多添加 5 个附件，请先移除一个") : undefined;
    const sendDisabledReason = sessionDisabledReason || (hydratingMedia ? uiText("正在读取图片，请稍候") : !selectedModel ? uiText("暂无可用模型") : !composerText.trim() && !composerAttachments.length ? uiText("先写下想法或添加附件") : undefined);
    const editMessage = (item: ChatMessage) => {
        if (isSending || placingImage || readingAttachments || hydratingMedia) return;
        setImageTarget(null);
        setEditing({ messageId: item.id, content: item.content });
        composerRef.current?.focus();
    };

    return (
        <main className="h-full min-h-0 bg-background">
            <div className="relative mx-auto flex h-full min-h-0 max-w-[1600px] overflow-hidden">
                {sidebarOpen ? <button type="button" aria-label={uiText("关闭会话列表")} className="absolute inset-0 z-10 bg-black/25 md:hidden" onClick={() => setSidebarOpen(false)} /> : null}
                <aside inert={!sidebarOpen} aria-hidden={!sidebarOpen} className={cn("absolute inset-y-0 left-0 z-20 flex shrink-0 flex-col border-r border-border bg-background transition-[width] duration-200 md:relative md:inset-auto", sidebarOpen ? "w-[260px]" : "w-0 overflow-hidden border-r-0")}>
                    <div className="flex items-center justify-between px-4 py-4">
                        <div className="flex items-center gap-2 text-sm font-semibold"><Bot className="size-4 text-muted-foreground" /> {uiText(" 对话记录")}</div>
                        <div className="flex">
                            <Tooltip title={sessionDisabledReason || uiText("新建对话")}><span><button type="button" aria-label={uiText("新建对话")} aria-description={sessionDisabledReason} disabled={!sessionsReady || placingImage || readingAttachments} onClick={() => startSession()} className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted disabled:opacity-40"><MessageSquarePlus className="size-4" /></button></span></Tooltip>
                            <button type="button" aria-label={uiText("收起会话")} onClick={() => setSidebarOpen(false)} className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted md:hidden"><X className="size-4" /></button>
                        </div>
                    </div>
                    <div className="px-3"><Tooltip title={sessionDisabledReason}><span className="block"><Button block aria-description={sessionDisabledReason} disabled={!sessionsReady || placingImage || readingAttachments} icon={<MessageSquarePlus className="size-4" />} onClick={() => startSession()} className="!h-9">{uiText("新对话")}</Button></span></Tooltip></div>
                    <div className="mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3">
                        <PracticeExampleRecord />
                        {sessions.map((session) => <div key={session.id} data-chat-session={session.id} className={cn("group relative flex w-full items-center gap-1 rounded-lg pr-1 transition-colors", session.id === activeSession?.id ? "bg-muted text-foreground before:absolute before:left-0 before:top-3 before:bottom-3 before:w-0.5 before:bg-foreground" : "text-muted-foreground hover:bg-muted/70")}>
                            <button type="button" aria-current={session.id === activeSession?.id ? "true" : undefined} disabled={placingImage || readingAttachments} onClick={() => selectSession(session.id)} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-3 text-left disabled:opacity-60">
                                <span className="grid size-7 shrink-0 place-items-center rounded-lg opacity-75">{[...sendLifetimesRef.current].some(item => item.sessionId === session.id) ? <LoaderCircle aria-label={uiText("正在处理")} className="size-4 animate-spin" /> : <Bot className="size-4" />}</span>
                                <span className="min-w-0 flex-1"><span className={cn("block truncate text-sm", session.id === activeSession?.id ? "font-semibold" : "font-medium")}>{sessionTitle(session)}{session.branchOf ? uiText(" · 分支") : ""}</span><span className="mt-1 block text-xs opacity-65">{new Date(session.updatedAt).toLocaleDateString(getUiLocale())}</span></span>
                            </button>
                            <Tooltip title={[...sendLifetimesRef.current].some(item => item.sessionId === session.id) ? uiText("这段对话仍在处理，完成后可删除") : uiText("删除会话")}><button type="button" disabled={[...sendLifetimesRef.current].some(item => item.sessionId === session.id) || placingImage} onClick={() => modal.confirm({ title: uiText("删除这段对话？"), content: uiText("会话仅保存在当前浏览器，删除后无法恢复。"), okText: uiText("删除"), cancelText: uiText("保留"), okButtonProps: { danger: true }, onOk: () => removeSession(session.id) })} className="grid size-8 shrink-0 place-items-center rounded-lg opacity-50 transition hover:opacity-100 focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-60" aria-label={uiText("删除会话")}><Trash2 className="size-4" /></button></Tooltip>
                        </div>)}
                    </div>
                    <div className="border-t border-border px-3 py-2"><Popover trigger="click" content={<p className="max-w-64 text-[13px] leading-6">{uiText("对话保存在当前浏览器。")}<br />{uiText("模型与密钥由服务端统一管理。")}</p>}><button type="button" aria-label={uiText("对话保存说明")} className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted"><CircleHelp className="size-4" /></button></Popover></div>
                </aside>

                <section {...imageDrop.dropProps} aria-label={uiText("对话图片拖入区域")} aria-busy={imageDrop.reading || readingAttachments} className={cn("flex min-h-0 min-w-0 flex-1 flex-col", imageDrop.dragging && "outline outline-2 -outline-offset-2 outline-primary")}>
                    <header data-testid="chat-header" className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-5">
                        <Tooltip title={sidebarOpen ? uiText("收起会话") : uiText("展开会话")}><button type="button" aria-label={sidebarOpen ? uiText("收起会话") : uiText("展开会话")} onClick={() => setSidebarOpen((value) => !value)} className="grid size-10 place-items-center rounded-xl text-muted-foreground hover:bg-muted">{sidebarOpen ? <PanelLeftClose className="size-5" /> : <PanelLeftOpen className="size-5" />}</button></Tooltip>
                        <h1 className="min-w-0 flex-1 truncate text-base font-medium">{uiText("对话改图")}</h1>
                        {modelsLoading ? <LoaderCircle role="status" aria-label={uiText("正在读取对话配置")} className="size-4 animate-spin text-muted-foreground" /> : null}
                    </header>
                    {imageDrop.dragging ? <p role="status" className="border-b border-border bg-primary/10 px-6 py-3 text-sm text-foreground">{uiText("松开以添加图片或文件，不会自动发送。")}</p> : null}
                    {modelError ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/60 px-6 py-3 text-sm"><span>{uiText(modelError || "")}</span><Button onClick={() => void refreshModels().catch(() => undefined)}>{uiText("重试加载")}</Button></div> : null}
                    {modelsStatus === "ready" && !selected ? <p role="status" className="border-b border-border px-6 py-3 text-sm text-muted-foreground">{uiText("对话服务暂不可用，请联系管理员检查后台配置。")}</p> : null}
                    {!sessionsReady ? <div role={sessionLoadError ? "alert" : "status"} className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/60 px-6 py-3 text-sm"><span>{sessionLoadError || uiText("正在读取本地聊天记录…")}</span>{sessionLoadError ? <Button onClick={() => setSessionReload((value) => value + 1)}>{uiText("重试读取记录")}</Button> : null}</div> : null}
                    {sessionSaveError ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/60 px-6 py-3 text-sm"><span>{uiText(sessionSaveError || "")}</span><Button onClick={() => { if (sessionsReady && !preparingSendsRef.current.size) { persistence.clear(); void persistSessions(sessionsRef.current).catch(() => undefined); } }}>{uiText("重试保存记录")}</Button></div> : null}
                    {mediaError ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/60 px-6 py-3 text-sm"><span>{uiText(mediaError || "")}</span><Button disabled={hydratingMedia || isSending} onClick={() => setMediaReload((value) => value + 1)}>{uiText("重试读取图片")}</Button></div> : null}

                    {activeSession ? <AgentDocumentPanel key={activeSession.id} documents={activeSession.documents} card={activeSession.requirementCard} disabled={imageActionsDisabled} onChange={card => { if (isCurrentScope()) updateSession(activeSession.id, session => ({ ...session, requirementCard: card })); }} onReference={figure => {
                        if (selectedImage) updateSession(activeSession.id, session => ({ ...session, focusImageId: selectedImage.id }));
                        else startNewCreation();
                        addImageReference({ ...figure, type: figure.mimeType, messageId: `document:${figure.id}`, label: figure.label, kind: "upload" });
                    }} /> : null}

                    <div ref={chatFollow.listRef} onScroll={chatFollow.onScroll} data-testid="chat-message-list" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [overflow-anchor:none] sm:px-6 sm:py-8" style={{ scrollbarGutter: "stable" }}>
                        <div ref={chatFollow.contentRef} className="mx-auto w-full max-w-3xl">
                        {!activeSession?.messages.length ? <div className="wb-empty mx-auto max-w-xl !min-h-0 !py-2">
                            <div className="hidden size-12 place-items-center rounded-2xl bg-muted text-foreground [@media(min-height:850px)]:grid"><WandSparkles className="size-6" /></div>
                            <h2 className="mt-2 text-xl font-semibold text-foreground sm:text-2xl">{uiText("有什么想法，直接说。")}</h2>
                            <p>{uiText("问问题、生成图片，或上传图片和文件，接着聊、接着改。")}</p>
                        </div> : <div className="space-y-8 sm:space-y-10">{activeSession.messages.map((item) => <ChatBubble key={item.id} message={item} imageLabels={imageLabels} imageCatalog={imageCatalog} actionsDisabled={imageActionsDisabled} onImageAction={imageAction} onMask={id => void openRegionSelection(id)} onPlaceOnCanvas={(image) => void placeImageOnCanvas(image)} onReview={image => void reviewImage(image)} onCorrect={prepareCorrection} reviewingImageIds={reviewingImageIds} onEdit={() => editMessage(item)} onRegenerate={chatSourceTurn(activeSession, item.id) ? () => void send({ messageId: item.id }) : undefined} checkingTask={taskRecovery.checking.has(item.id) || Boolean(item.pendingImageTask && activeImageRequestIds.has(item.pendingImageTask.requestId))} onQueryTask={() => taskRecovery.query(item)} onStopWaiting={item.pendingImageTask && activeImageRequestIds.has(item.pendingImageTask.requestId) ? () => stopImageWaiting(item) : undefined} />)}{isSending ? <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{sendPhase}</div> : null}</div>}
                        </div>
                    </div>
                    {chatFollow.hasNewMessages ? <div className="flex shrink-0 justify-center pb-1"><button type="button" onClick={chatFollow.scrollToBottom} className="rounded-full border border-border bg-background px-3 py-2 text-xs text-muted-foreground shadow-sm hover:text-foreground">↓ {uiText("新消息")}</button></div> : null}
                    <div data-testid="chat-composer-dock" className="shrink-0 bg-background px-3 pb-3 pt-2 sm:px-6 sm:pb-4">
                        <div className="mx-auto w-full max-w-3xl">
                            <ConversationExamples className="mb-2 text-muted-foreground" />
                            {editing ? <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{uiText("编辑后将从这条消息创建新分支，原会话和附件保留；发送会重新调用模型。")}</span><Button size="small" disabled={isSending} onClick={() => setEditing(null)}>{uiText("取消编辑")}</Button></div> : null}
                            <div className="relative rounded-xl border border-input bg-card p-3 transition-colors focus-within:border-ring motion-reduce:transition-none sm:p-4">
                                {!editing ? <div className="mb-2 text-muted-foreground"><ImageAgentKeepControls keep={selectedImage?.note?.keep || []} draft={draft} onChange={setDraft} disabled={imageActionsDisabled} /></div> : null}
                                {regionSelection && selectedImage?.id === regionSelection.imageId ? <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground"><Brush className="size-3.5" /><span>{uiText("已圈选局部区域，仅修改选区内")}</span><button type="button" onClick={() => void openRegionSelection(regionSelection.imageId)} className="underline">{uiText("调整选区")}</button><button type="button" aria-label={uiText("清除局部选区")} onClick={() => setRegionSelection(null)}><X className="size-3.5" /></button></div> : null}
                                {regionSelection ? <p className="mb-2 text-xs leading-relaxed text-muted-foreground">{uiText("涂选后只合入选区，区域外保留原图；选区内结构、接缝与光影仍需核对。")}</p> : null}
                                {composerAttachments.length ? <div className="flex flex-wrap gap-2 pb-3">{composerAttachments.map((item) => <div key={item.id} className="group relative flex h-14 max-w-[180px] items-center gap-2 rounded-xl border border-border bg-card p-2">{item.dataUrl ? <img src={item.dataUrl} alt="" className="size-10 rounded-lg object-cover" /> : <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground"><FileText className="size-5" /></span>}<span className="min-w-0 flex-1 truncate text-xs font-medium">{!editing && referenceImageIds.includes(item.id) ? uiText("参考 · {value1}", { value1: conversationImageLabel(imageLabels.get(item.id) || "") || item.name }) : item.name}</span>{!editing ? <button type="button" aria-label={uiText("移除 ") + item.name} onClick={() => { setAttachments((current) => current.filter((attachment) => attachment.id !== item.id)); setReferenceImageIds((ids) => ids.filter((id) => id !== item.id)); if (imageTarget?.id === item.id && !imageCatalog.some((image) => image.id === item.id)) setImageTarget(null); }} className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full border border-border bg-card text-muted-foreground hover:text-red-600"><X className="size-3.5" /></button> : null}</div>)}</div> : null}
                                {readingAttachments || imageDrop.reading ? <div role="status" className="mb-2 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{uiText("正在读取附件，请稍候…")}</div> : null}
                                <textarea ref={composerRef} aria-label={editing ? uiText("编辑消息") : uiText("对话内容")} value={composerText} disabled={!sessionsReady} onChange={event => { if (editing) setEditing({ ...editing, content: event.target.value }); else { setDraft(event.target.value); if (!event.target.value.trim() && imageTarget?.mode === "correction") setImageTarget(null); } }} onPaste={pasteAttachments} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) return; handleSubmitShortcut(event, sessionsReady && !isSending && !readingAttachments && !hydratingMedia && !!selectedModel, sendComposer); }} placeholder={uiText("直接说怎么改 · Ctrl / ⌘ + Enter 发送")} style={{ outline: "none" }} className="block max-h-44 min-h-14 w-full resize-none overflow-y-auto overscroll-contain bg-transparent px-1 py-1 text-base leading-7 text-foreground placeholder:text-muted-foreground" />
                                {composerText.length > 240 ? <p className="mb-1 text-right text-[12px] text-muted-foreground">{composerText.length} {uiText("字")}</p> : null}
                                <div className="mt-2 flex items-end justify-between gap-2">
                                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                                        <Tooltip title={attachmentDisabledReason || uiText("上传图片、PDF、Word、表格或文本")}><span><button type="button" disabled={!sessionsReady || isSending || Boolean(editing) || readingAttachments || attachments.length >= 5} aria-description={attachmentDisabledReason} onClick={() => openChatAttachmentPicker(fileInputRef.current)} className="grid size-10 place-items-center rounded-xl text-muted-foreground hover:bg-muted disabled:opacity-40" aria-label={uiText("上传文件")}><Paperclip className="size-5" /></button></span></Tooltip>
                                        <Tooltip title={attachmentDisabledReason || uiText("上传图片")}><span><button type="button" disabled={!sessionsReady || isSending || Boolean(editing) || readingAttachments || attachments.length >= 5} aria-description={attachmentDisabledReason} onClick={() => openChatAttachmentPicker(fileInputRef.current, true)} className="grid size-10 place-items-center rounded-xl text-muted-foreground hover:bg-muted disabled:opacity-40" aria-label={uiText("上传图片")}><ImagePlus className="size-5" /></button></span></Tooltip>
                                        {selectedClaude ? <Popover trigger="click" placement="topLeft" title={uiText("模型设置")} content={<div className="max-w-[min(360px,80vw)]"><ClaudeChatControls model={selectedParameterModel} stream={config.claudeStream !== "false"} thinking={config.claudeThinking === "true"} maxTokens={config.claudeMaxTokens} onStreamChange={(value) => updateConfig("claudeStream", String(value))} onThinkingChange={(value) => updateConfig("claudeThinking", String(value))} onMaxTokensChange={(value) => updateConfig("claudeMaxTokens", value)} /></div>}><button type="button" aria-label={uiText("模型设置")} className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted"><Settings2 className="size-4" /></button></Popover> : null}
                                        <Popover trigger="click" placement="topRight" title={uiText("出图设置")} content={<div className="grid w-[min(300px,75vw)] gap-3">
                                            <label className="grid gap-1 text-xs text-muted-foreground">{uiText("出图模型")}<Select data-usage-control="model" aria-label={uiText("出图模型")} value={preferredImageModel?.modelId} placeholder={modelsLoading ? uiText("正在读取模型") : uiText("暂无可用模型")} disabled={!sessionsReady || modelsLoading || isSending || !imageModels.length || Boolean(imageBinding?.modelConfigId)} onChange={modelId => { if (activeSession && imageModels.some(model => model.modelId === modelId)) updateSession(activeSession.id, session => ({ ...session, ...selectChatImageModel(modelId, session) })); }} options={imageModels.map(model => ({ value: model.modelId, label: modelLabelWithUsage(model.name, model.publicDescription) }))} /></label>
                                            <label className="grid gap-1 text-xs text-muted-foreground">{uiText("画幅比例 / 尺寸")}<Select aria-label={uiText("图片尺寸")} data-testid="chat-image-size" value={activeSession?.imageSize || CHAT_AUTO_IMAGE_SIZE} disabled={imageReferenceParametersAutomatic || !sessionsReady || modelsLoading || isSending || !preferredImageModel} onChange={value => { if (activeSession) updateSession(activeSession.id, session => ({ ...session, imageSize: value === CHAT_AUTO_IMAGE_SIZE ? undefined : value })); }} options={chatImageSizeOptions(qualityProfile).map(option => ({ ...option, label: uiText(option.label) }))} /></label>
                                            <p role={imageReferenceParametersAutomatic ? "status" : undefined} className="text-xs text-muted-foreground">{uiText(imageReferenceParametersAutomatic ? automaticReferenceSizeNotice : "默认自动选择画幅，也可手动指定比例。")}</p>
                                            {imageQualitySettings.independentResolution ? <label className="grid gap-1 text-xs text-muted-foreground">{uiText("清晰度")}<Select data-usage-control="resolution" aria-label={uiText("图片分辨率")} data-testid="chat-image-resolution" value={imageQualitySettings.resolution} disabled={imageReferenceParametersAutomatic || !sessionsReady || modelsLoading || isSending || !preferredImageModel} onChange={value => { if (activeSession && preferredImageModel) updateSession(activeSession.id, session => ({ ...session, imageModelId: preferredImageModel.modelId, imageResolution: value })); }} options={imageQualitySettings.resolutionOptions.map(option => ({ ...option, label: uiText(option.label) }))} /></label> : null}
                                            {qualityProfile.kind !== "mai-image" ? <label className="grid gap-1 text-xs text-muted-foreground">{uiText(imageQualitySettings.label || "")}<Select data-usage-control={imageQualitySettings.independentResolution ? "quality" : "resolution"} aria-label={imageQualitySettings.independentResolution ? uiText("图片质量") : uiText("图片清晰度")} data-testid="chat-image-quality" value={imageQualitySettings.quality} disabled={!sessionsReady || modelsLoading || isSending || !preferredImageModel || !imageQualitySettings.adjustable} onChange={value => { if (activeSession && preferredImageModel) updateSession(activeSession.id, session => ({ ...session, imageModelId: preferredImageModel.modelId, imageQuality: value })); }} options={imageQualitySettings.options.map(option => ({ ...option, label: uiText(option.label) }))} /></label> : null}
                                            {imageBinding?.modelConfigId ? <p className="text-xs text-muted-foreground">{uiText("当前出图模型由管理员固定，无需选择。")}</p> : null}
                                        </div>}><button type="button" aria-label={uiText("出图设置")} className="inline-flex min-h-10 max-w-full items-center gap-2 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted"><Settings2 className="size-4 shrink-0" /><span className="shrink-0">{uiText("出图设置")}</span><span className="hidden max-w-28 truncate opacity-70 sm:block">{preferredImageModel?.name}</span></button></Popover>
                                        <Popover trigger="click" placement="topLeft" content={<div className="max-w-72 space-y-2 text-[13px] leading-6"><p>{uiText("直接发消息、图片或文件，接着聊、接着改。")}</p><p>{uiText("Ctrl / ⌘ + V 粘贴图片；Ctrl / ⌘ + Enter 发送；直接说回原图、上一版或图号")}</p><p>{uiText("处理中可以新建或切换对话，回复会保留在原对话。")}</p></div>}><button type="button" aria-label={uiText("对话操作帮助")} className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted"><CircleHelp className="size-4" /></button></Popover>
                                    </div>
                                    {isSending ? <Tooltip title={uiText("停止本页请求和等待，不保证取消服务端执行")}><Button danger onClick={stopSending} icon={<Square className="size-4" />} className="!h-11 !shrink-0 !rounded-lg !px-3">{uiText("停止")}</Button></Tooltip> : <Tooltip title={sendDisabledReason}><span className="shrink-0"><Button type="primary" aria-description={sendDisabledReason} disabled={!sessionsReady || (!composerText.trim() && !composerAttachments.length) || placingImage || readingAttachments || hydratingMedia || !selectedModel} onClick={sendComposer} icon={<Send className="size-4" />} className="!h-11 !shrink-0 !rounded-lg !px-3">{editing ? uiText("发送为新分支") : uiText("发送")}</Button></span></Tooltip>}
                                </div>
                                <input ref={fileInputRef} type="file" multiple disabled={!sessionsReady || isSending || Boolean(editing) || readingAttachments} accept={CHAT_ATTACHMENT_ACCEPT} className="hidden" onChange={(event) => { void addFiles(event.target.files); event.currentTarget.value = ""; }} />
                                {!isSending && (!sessionsReady || !selectedModel || placingImage || readingAttachments || hydratingMedia) ? <p role="status" className="mt-2 text-xs text-muted-foreground">{!sessionsReady ? uiText("正在读取对话，请稍候") : !selectedModel ? uiText("暂无可用对话模型，请联系管理员") : readingAttachments ? uiText("正在读取附件，请稍候") : hydratingMedia ? uiText("正在恢复图片，请稍候") : uiText("正在保存画布，请稍候")}</p> : null}
                            </div>
                            <p className="mt-2 text-right text-xs text-muted-foreground">{uiText("Ctrl / ⌘ + Enter 发送")}</p>
                            {isSending ? <p className="mt-1 text-[13px] text-muted-foreground">{uiText("停止仅中断本页等待，服务端任务可能仍在执行。")}</p> : null}
                        </div>
                    </div>
                </section>
            </div>
            {imageTools.compareDialog}
            {regionImage ? <Suspense fallback={<div role="status">{uiText("正在打开局部选区…")}</div>}><RegionSelectionDialog source={regionImage} initialMask={regionSelection?.imageId === regionImage.id ? regionSelection.selection.dataUrl : undefined} nativeMask={qualityProfile.supportsMask} onClose={() => setRegionImage(null)} onSave={async blob => {
                const imageId = regionImage.id, sessionId = activeSession?.id;
                const selection = await saveChatRegionSelection(imageId, blob, () => { if (!isCurrentScope() || activeSessionIdRef.current !== sessionId) throw new DOMException("会话已切换", "AbortError"); });
                setRegionSelection(selection); composerRef.current?.focus();
            }} /></Suspense> : null}
        </main>
    );
}

const ChatBubble = memo(function ChatBubble({ message, imageLabels, imageCatalog, actionsDisabled, onImageAction, onMask, onPlaceOnCanvas, onReview, onCorrect, reviewingImageIds, onEdit, onRegenerate, checkingTask, onQueryTask, onStopWaiting }: {
    message: ChatMessage; imageLabels: Map<string, string>; imageCatalog: CreativeImageCatalogEntry[]; actionsDisabled: boolean;
    onImageAction: (action: ConversationImageAction, imageId: string) => void; onMask: (imageId: string) => void;
    onPlaceOnCanvas: (image: ChatGeneratedImage) => void; onEdit: () => void; onRegenerate?: () => void;
    onReview: (image: ChatGeneratedImage) => void; onCorrect: (image: ChatGeneratedImage) => void; reviewingImageIds: ReadonlySet<string>;
    checkingTask?: boolean; onQueryTask: () => void; onStopWaiting?: () => void;
}) {
    useUiText();
    const isUser = message.role === "user";
    const copyText = useCopyText();
    const diagnosticClipboard = useCopyFeedback();
    const [copied, setCopied] = useState(false);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(copyTimer.current), []);
    const copyMessage = async () => {
        if (!await copyText(message.content)) return;
        clearTimeout(copyTimer.current); setCopied(true);
        copyTimer.current = setTimeout(() => setCopied(false), 1200);
    };
    const imageWork = message.generatedImages?.[0] || message.pendingImageTask;
    const imageControls = (imageId: string) => {
        const original = chatImageOriginal(imageCatalog, imageId);
        const reason = original.reason || (original.image?.id === imageId ? "这张图已经是原图" : undefined);
        return { onAction: onImageAction, onMask: () => onMask(imageId), disabled: actionsDisabled, compareDisabledReason: reason };
    };
    return (
        <div data-message-id={message.id} data-message-role={message.role} className={cn("flex min-w-0", isUser ? "justify-end" : "justify-start")}>
            <div className={cn("min-w-0 text-[14px] leading-7 [overflow-wrap:anywhere] sm:text-base", isUser ? "max-w-[90%] rounded-3xl bg-muted px-4 py-3 text-foreground sm:max-w-[85%] sm:px-5" : message.role === "error" ? "w-full rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200" : "w-full text-foreground")}>
                {message.content ? message.role === "error" ? <GenerationDiagnostic error={message.content} /> : <ChatMarkdown>{message.content}</ChatMarkdown> : null}
                {message.stopped ? <p className="mt-2 text-[13px] opacity-70">{uiText("已停止接收；已有内容已保留，不代表服务端执行已取消。")}</p> : null}
                {message.generatedImages?.length ? <div className={cn("grid min-w-0 grid-cols-1 gap-5", message.content && "mt-4", message.generatedImages.length > 1 && "sm:grid-cols-2")}>{message.generatedImages.map((item) => <div key={item.id} className="min-w-0">
                    <ChatImage image={item} label={imageLabels.get(item.id) || uiText("生成结果")} {...imageControls(item.id)} onPlace={() => onPlaceOnCanvas(item)} />
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]"><Tooltip title={uiText("额外调用当前对话模型检查图片，不会重新生成")}><Button size="small" loading={reviewingImageIds.has(item.id)} disabled={actionsDisabled || reviewingImageIds.has(item.id)} onClick={() => onReview(item)}>{uiText("检查结果")}</Button></Tooltip><span className="text-muted-foreground">{uiText("仅手动检查，不自动重绘")}</span></div>
                    {item.review ? <div data-testid="chat-image-review" className="mt-2 space-y-1 text-xs text-muted-foreground">
                        <p className="font-medium">{uiText("AI 检查建议（非像素级认证）")}</p>
                        {item.review.baseUnavailable ? <p>{uiText("未取得本轮底图，保留项无法进行前后核验。")}</p> : null}
                        <p>{item.review.report.summary}</p>
                        <ul className="list-inside list-disc space-y-1">{item.review.report.checks.map((check, index) => <li key={`${index}:${check.criterion}`}><span>{check.result === "pass" ? "观察符合" : check.result === "warning" ? "发现疑点" : "无法核验"} · {check.criterion}</span><p className="pl-3">{check.evidence}</p></li>)}</ul>
                        {item.review.report.checks.some(check => check.result !== "pass") ? <Button size="small" disabled={actionsDisabled || item.review.baseUnavailable} onClick={() => onCorrect(item)}>{uiText("准备纠正草稿")}</Button> : null}
                    </div> : null}
                </div>)}</div> : null}
                {message.generatedImages?.[0]?.workNote ? <details className="mt-2 text-xs text-muted-foreground"><summary className="w-fit cursor-pointer">{uiText("本次修改与作品说明")}</summary><p className="mt-2 whitespace-pre-wrap">{imageAgentWorkNoteText(message.generatedImages[0].workNote)}</p></details> : null}
                {imageWork?.spec ? <div data-testid="chat-image-spec" className="mt-2 text-xs text-muted-foreground">
                    {imageWork.spec.assumptions?.length ? <p className="whitespace-pre-wrap">{uiText("本轮假设")}：{imageWork.spec.assumptions.join("；")}</p> : null}
                    <details><summary className="w-fit cursor-pointer">{uiText("本轮改图要求（待核对，不代表验收通过）")}</summary><p className="mt-2 whitespace-pre-wrap">{imageAgentSpecText(imageWork.spec)}</p></details>
                </div> : null}
                {message.pendingImageTask ? <div data-testid="chat-pending-image-card" className="mt-3 grid gap-2 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
                    <span role="status">{checkingTask ? uiText("正在等待原任务结果…") : uiText("原图片任务等待核实")}</span>
                    <span>{uiText("可以继续聊天或发送不同的新要求；请勿重复提交这条原任务。")}</span>
                    <div className="flex flex-wrap gap-2"><Button data-testid="chat-image-recovery-action" size="small" disabled={checkingTask} onClick={onQueryTask}>{message.pendingImageTask.recovery === "resume" ? uiText("恢复原任务查询") : uiText("查询结果")}</Button>{onStopWaiting ? <Button size="small" onClick={onStopWaiting}>{uiText("停止本页等待")}</Button> : null}</div>
                    {message.pendingImageTask.taskId && message.pendingImageTask.recovery !== "investigate" ? <GenerationTaskCancel taskId={message.pendingImageTask.taskId} /> : null}
                    <details><summary className="w-fit cursor-pointer">{uiText("任务信息")}</summary><Button aria-label={uiText("复制诊断信息")} size="small" type="text" onClick={() => void diagnosticClipboard.copy(JSON.stringify({ requestId: `${message.pendingImageTask!.requestId}:0`, taskId: message.pendingImageTask?.taskId, status: message.pendingImageTask?.taskStatus, recovery: message.pendingImageTask?.recovery }, null, 2))}>{diagnosticClipboard.copied ? uiText("已复制 ✓") : uiText("复制诊断信息")}</Button></details>
                </div> : null}
                {message.attachments?.length ? <div className={cn("flex flex-wrap gap-2", message.content && "mt-3")}>{message.attachments.map((item) => item.dataUrl || item.storageKey || item.kind === "image" ? <ChatImage key={item.id} image={item} label={imageLabels.get(item.id) || item.name} {...imageControls(item.id)} /> : <span key={item.id} className={cn("inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs", isUser ? "bg-background/10" : "bg-muted text-muted-foreground")}><FileText className="size-3.5" />{item.name}</span>)}</div> : null}
                <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    {message.content ? <button type="button" aria-label={uiText("复制消息")} onClick={() => void copyMessage()} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 hover:bg-current/10"><Copy className="size-3" />{copied ? uiText("已复制 ✓") : uiText("复制")}</button> : null}
                    {isUser ? <button type="button" disabled={actionsDisabled} aria-label={uiText("编辑消息")} onClick={onEdit} className="inline-flex min-h-8 items-center gap-1 rounded px-2 hover:bg-current/10 disabled:opacity-40"><Pencil className="size-3" />{uiText("编辑")}</button> : onRegenerate && !message.pendingImageTask ? <Tooltip title={uiText("按当前配置重新发送到新分支，原会话保留；这会重新调用模型")}><button type="button" disabled={actionsDisabled} aria-label={uiText("重新生成")} onClick={onRegenerate} className="inline-flex min-h-8 items-center gap-1 rounded px-2 hover:bg-current/10 disabled:opacity-40"><RotateCcw className="size-3" />{uiText("重新生成")}</button></Tooltip> : null}
                </div>
            </div>
        </div>
    );
});

function ClaudeChatControls({ model, stream, thinking, maxTokens, onStreamChange, onThinkingChange, onMaxTokensChange }: { model: string; stream: boolean; thinking: boolean; maxTokens: string; onStreamChange: (value: boolean) => void; onThinkingChange: (value: boolean) => void; onMaxTokensChange: (value: string) => void }) {
    useUiText();
    const alwaysThinking = model.toLowerCase() === "claude-fable-5";
    const openTokenClaude = model.toLowerCase() === "claude-fable-5-1";
    const channelDefaultThinking = openTokenClaude || model.toLowerCase() === "claude-sonnet-5-5";
    return <div className="flex flex-wrap items-center gap-x-4 gap-y-3 text-[13px] text-muted-foreground">
        <Checkbox checked={stream} onChange={(event) => onStreamChange(event.target.checked)}>{uiText("流式输出")}</Checkbox>
        {channelDefaultThinking ? <Tooltip title={uiText("使用后台配置对应的默认思考行为。")}><span>{uiText("思考模式 · 默认")}</span></Tooltip> : alwaysThinking ? <Tooltip title={uiText("当前服务始终启用自适应思考，不支持关闭或固定思考预算。")}><span>{uiText("自适应思考 · 始终开启")}</span></Tooltip> : <Checkbox checked={thinking} onChange={(event) => onThinkingChange(event.target.checked)}>{uiText("自适应思考")}</Checkbox>}
        <label className="inline-flex items-center gap-2">{uiText("回复长度")}<Select aria-label={uiText("回复长度")} value={maxTokens} onChange={onMaxTokensChange} options={[{ value: "1024", label: uiText("短") }, { value: "2048", label: uiText("较短") }, { value: "4096", label: uiText("中") }, { value: "8192", label: uiText("长") }, { value: "16384", label: uiText("更长") }]} size="small" className="w-[100px]" /></label>
        <a href={openTokenClaude ? "https://docs.opentoken.io/api/claude/messages-api/" : "https://docs.apib.ai/cn/api-reference/texts/general/claude-messages"} target="_blank" rel="noreferrer" className="underline underline-offset-2">{uiText("接口说明")}</a>
        <span className="w-full text-xs leading-5">{uiText("长度设置包含思考与回复，仅适用于当前对话模型。")}</span>
    </div>;
}
