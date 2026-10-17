import { App, Button, Tooltip } from "antd";
import { Bot, CornerDownLeft, FileText, ImagePlus, LoaderCircle, MessageSquarePlus, Paperclip, PanelLeftClose, PanelLeftOpen, Send, Trash2, WandSparkles, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { useNavigate } from "react-router-dom";

import { cn } from "@/lib/utils";
import { deploymentFeatures } from "@/lib/deployment-features";
import { createClientId } from "@/lib/client-id";
import { CHAT_ATTACHMENT_ACCEPT, openChatAttachmentPicker, parseChatAttachment, type ParsedChatAttachment } from "@/lib/chat-attachments";
import { buildCreativeImageCatalog, type CreativeImageLineage } from "@/lib/creative-chat";
import { createDeferredPersistQueue } from "@/lib/deferred-persist-queue";
import { createChatStreamBuffer } from "./chat-stream-buffer";
import { chatSessionStorage } from "./chat-session-storage";
import { chatImageQualitySettings, chatImageRequestOptions, preferredChatImageModel, resolveChatImageQuality } from "./image-quality";
import { useImageModelProfile } from "@/lib/image-model-settings";
import { modelLabelWithUsage } from "@/lib/model-picker-options";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useModuleEnabled } from "@/stores/use-module-store";
import { isClaudeModel, requestEdit, requestGeneration } from "@/services/api/image";
import { requestCreativeChatPlan } from "@/services/api/creative-chat";
import { resolveToolModel } from "@/services/api/business-config";
import { recoverChatImageTask, type PendingChatImageTask } from "@/services/api/chat-image-recovery";
import { imageToDataUrl, uploadImage } from "@/services/image-storage";
import { flushCanvasPersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType } from "@/types/canvas";

type ChatAttachment = Omit<ParsedChatAttachment, "kind"> & { id: string; kind?: ParsedChatAttachment["kind"] };
type ChatGeneratedImage = { id: string; dataUrl: string; prompt?: string; modelId?: string; quality?: string; resolution?: string; lineage?: CreativeImageLineage };
type ChatMessage = { id: string; parentMessageId?: string; editTargetImageId?: string; role: "user" | "assistant" | "error"; content: string; attachments?: ChatAttachment[]; generatedImages?: ChatGeneratedImage[]; pendingImageTask?: PendingChatImageTask; createdAt: string };
type ChatSession = { id: string; title: string; messages: ChatMessage[]; updatedAt: string; chatModelId?: string; imageModelId?: string; imageQuality?: string; imageResolution?: string; editTargetImageId?: string; canvasProjectId?: string };

const storagePrefix = "wireless-canvas:llm-chat:";
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
    return comma < 0 ? 0 : Math.floor((dataUrl.length - comma - 1) * 0.75);
}

export default function ChatPage() {
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
    const [draft, setDraft] = useState("");
    const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
    const [readingAttachments, setReadingAttachments] = useState(false);
    const [isSending, setIsSending] = useState(false);
    const sendingRef = useRef(false);
    const activeSendRef = useRef<{ controller: AbortController; submitted: boolean } | null>(null);
    const [sendPhase, setSendPhase] = useState("");
    const [placingImage, setPlacingImage] = useState(false);
    const placingImageRef = useRef(false);
    const [imageRecoveryReload, setImageRecoveryReload] = useState(0);
    const imageRecoveryRequestRef = useRef<{ storageKey: string; sessionId: string; messageId: string; requestId: string; taskId?: string } | null>(null);
    const [recoveringImageTask, setRecoveringImageTask] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const followBottomRef = useRef(true);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const activeStreamRef = useRef<ReturnType<typeof createChatStreamBuffer> | null>(null);
    const preparingMessageRef = useRef(false);
    const persistSessions = useCallback(async (value: ChatSession[]) => {
        try {
            await chatSessionStorage.save(storageKey, value);
            if (loadedStorageKeyRef.current === storageKey) setSessionSaveError("");
        } catch (error) {
            if (loadedStorageKeyRef.current === storageKey) setSessionSaveError(`聊天记录保存失败：${error instanceof Error ? error.message : "本地存储不可用"}。当前内容仍保留在本页，请勿刷新。`);
            throw error;
        }
    }, [storageKey]);
    const persistence = useMemo(() => createDeferredPersistQueue<ChatSession[]>(400, (value) => {
        void persistSessions(value).catch(() => undefined);
    }), [persistSessions]);

    useEffect(() => {
        const flush = () => {
            activeStreamRef.current?.flush();
            if (loadedStorageKeyRef.current === storageKey && !preparingMessageRef.current) persistence.schedule(sessionsRef.current);
            persistence.flush();
        };
        window.addEventListener("pagehide", flush);
        return () => {
            window.removeEventListener("pagehide", flush);
            flush();
            activeStreamRef.current?.dispose();
            // A submitted task belongs to the server and keeps running. Only
            // abandon preparation/LLM planning that must not create a new task.
            if (!activeSendRef.current?.submitted) activeSendRef.current?.controller.abort();
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
        setDraft("");
        setAttachments([]);
        void chatSessionStorage.load<ChatSession>(storageKey, () => deploymentFeatures.authenticationEnabled ? null : localStorage.getItem(storageKey))
            .then((stored) => {
                if (cancelled) return;
                const restored = stored.length ? stored : [createSession()];
                setSessions(restored);
                setActiveSessionId(restored[0]!.id);
                loadedStorageKeyRef.current = storageKey;
                setLoadedStorageKey(storageKey);
            })
            .catch((error: unknown) => {
                if (!cancelled) setSessionLoadError(`聊天记录读取失败：${error instanceof Error ? error.message : "本地存储不可用"}。未覆盖原记录。`);
            });
        return () => { cancelled = true; };
    }, [sessionReload, setSessions, storageKey]);

    useEffect(() => {
        const active = sessions.find((item) => item.id === activeSessionId);
        if (!active) setActiveSessionId(sessions[0]?.id || null);
    }, [activeSessionId, sessions]);

    useEffect(() => {
        // Account changes must not persist the previous account's sessions under the new key.
        if (loadedStorageKey !== storageKey || preparingMessageRef.current) return;
        persistence.schedule(sessions);
        if (!isSending) persistence.flush();
    }, [isSending, loadedStorageKey, persistence, sessions, storageKey]);

    useEffect(() => {
        if (modelsStatus === "idle") void refreshModels().catch(() => undefined);
    }, [modelsStatus, refreshModels]);

    useEffect(() => {
        followBottomRef.current = true;
    }, [activeSessionId]);

    useEffect(() => {
        const current = sessions.find((item) => item.id === activeSessionId) || sessions[0];
        if (!current?.messages.length) {
            scrollRef.current?.scrollTo({ top: 0, behavior: "instant" });
            return;
        }
        if (followBottomRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "instant" });
    }, [sessions, activeSessionId, isSending]);

    const activeSession = useMemo(() => sessions.find((item) => item.id === activeSessionId) || sessions[0], [activeSessionId, sessions]);
    const pendingImageMessage = activeSession?.messages.find((item) => item.pendingImageTask);
    const imageBinding = toolBindings.find(item => item.toolKey === "gpt-chat-image");
    const chatImageEnabled = useModuleEnabled("gpt-chat-image");
    const selected = modelsStatus === "ready" ? resolveToolModel(businessConfig, "gpt-chat") : undefined;
    const selectedModel = selected?.modelId || "";
    // The conversation chooses whether an image task is needed. Demo-only
    // models must never be picked for a real provider task.
    const imageModels = useMemo(() => modelsStatus === "ready" ? models.filter((item) => chatImageEnabled && imageBinding?.enabled !== false && (!imageBinding?.modelConfigId || item.id === imageBinding.modelConfigId) && !item.modelId.startsWith("demo-") && item.capabilities.some((capability) => ["generate", "edit"].includes(capability))) : [], [models, modelsStatus, imageBinding, chatImageEnabled]);
    const preferredImageModel = preferredChatImageModel(imageModels, [activeSession?.imageModelId, config.imageModel, config.model]);
    const qualityProfile = useImageModelProfile(preferredImageModel?.modelId || "");
    const imageQualitySettings = chatImageQualitySettings(qualityProfile, activeSession?.imageQuality, activeSession?.imageResolution);
    const creativeModelId = selectedModel;
    const imageCatalog = useMemo(() => buildCreativeImageCatalog(activeSession?.messages || []), [activeSession?.messages]);
    const imageLabels = useMemo(() => new Map(imageCatalog.map((item) => [item.id, item.label])), [imageCatalog]);
    const selectedParameterModel = selected?.parameterModelId || selected?.modelId || selectedModel;
    const selectedClaude = isClaudeModel(selectedParameterModel);

    const updateSession = (id: string, update: (session: ChatSession) => ChatSession) => {
        if (loadedStorageKeyRef.current !== storageKey) return;
        setSessions((current) => current.map((session) => session.id === id ? update(session) : session));
    };

    useEffect(() => {
        const resumeRequest = imageRecoveryRequestRef.current;
        imageRecoveryRequestRef.current = null;
        const pending = pendingImageMessage?.pendingImageTask;
        if (!sessionsReady || isSending || !activeSession || !pending || !pendingImageMessage) { setRecoveringImageTask(false); return; }
        const controller = new AbortController();
        const { signal } = controller;
        const sessionId = activeSession.id;
        const assistantId = pendingImageMessage.id;
        const resumePaused = Boolean(resumeRequest && resumeRequest.storageKey === storageKey && resumeRequest.sessionId === sessionId
            && resumeRequest.messageId === assistantId && resumeRequest.requestId === pending.requestId && resumeRequest.taskId === pending.taskId);
        const stillCurrent = () => !signal.aborted && loadedStorageKeyRef.current === storageKey;
        const saveUpdate = async (update: (item: ChatMessage) => ChatMessage, editTargetImageId?: string) => {
            if (!stillCurrent()) return;
            updateSession(sessionId, (session) => ({ ...session, ...(editTargetImageId ? { editTargetImageId } : {}), messages: session.messages.map((item) => item.id === assistantId ? update(item) : item), updatedAt: new Date().toISOString() }));
            if (!stillCurrent()) return;
            persistence.clear();
            await persistSessions(sessionsRef.current);
        };
        setRecoveringImageTask(true);
        void (async () => {
            const result = await recoverChatImageTask(pending, {
                signal,
                resumePaused,
                onTask: (task) => saveUpdate((item) => ({ ...item, pendingImageTask: { ...pending, taskId: task.id }, content: `正在查询原图片任务 ${task.id}，不会重新生成或扣费。` })),
            });
            if (!stillCurrent()) return;
            if (result.kind === "success") {
                const images = await Promise.all(result.resultUrls.map(async (url, index) => ({ id: `${result.task.id}:${index}`, dataUrl: await imageToDataUrl({ dataUrl: url }).catch(() => url), prompt: pending.prompt, modelId: pending.modelId, quality: pending.quality, ...(pending.resolution ? { resolution: pending.resolution } : {}), lineage: pending.lineage })));
                if (!stillCurrent()) return;
                await saveUpdate((item) => {
                    const { pendingImageTask: _pending, ...saved } = item;
                    return { ...saved, parentMessageId: pending.parentMessageId, role: "assistant", content: `${pending.explanation ? `${pending.explanation}\n\n` : ""}已找回原图片任务结果，可以直接继续提修改要求；未重新生成或扣费。`, generatedImages: images };
                }, images[0]?.id);
            } else if (result.kind === "failed") {
                await saveUpdate((item) => {
                    const { pendingImageTask: _pending, ...saved } = item;
                    return { ...saved, role: "error", content: result.content };
                });
            } else {
                await saveUpdate((item) => ({ ...item, pendingImageTask: { ...pending, ...(result.task ? { taskId: result.task.id } : {}) }, content: result.content }));
            }
        })().catch((error: unknown) => {
            if (!stillCurrent()) return;
            void saveUpdate((item) => ({ ...item, content: `原图片任务查询未完成：${error instanceof Error ? error.message : "读取失败"}。请查询原任务，勿重复生成。` })).catch(() => undefined);
        }).finally(() => { if (stillCurrent()) setRecoveringImageTask(false); });
        return () => controller.abort();
    }, [sessionsReady, isSending, activeSession?.id, pendingImageMessage?.id, pendingImageMessage?.pendingImageTask?.requestId, storageKey, imageRecoveryReload]);

    const queryOriginalImageTask = () => {
        const pending = pendingImageMessage?.pendingImageTask;
        if (!sessionsReady || isSending || recoveringImageTask || imageRecoveryRequestRef.current || !activeSession || !pending || !pendingImageMessage) return;
        imageRecoveryRequestRef.current = { storageKey, sessionId: activeSession.id, messageId: pendingImageMessage.id, requestId: pending.requestId, taskId: pending.taskId };
        setImageRecoveryReload((value) => value + 1);
    };

    const startSession = () => {
        if (!sessionsReady || sendingRef.current || placingImageRef.current) return;
        const session = createSession();
        setSessions((current) => [session, ...current]);
        setActiveSessionId(session.id);
        setDraft("");
        setAttachments([]);
    };

    const placeImageOnCanvas = async (image: ChatGeneratedImage) => {
        if (!sessionsReady || !activeSession || sendingRef.current || placingImageRef.current) return;
        if (!useCanvasStore.getState().hydrated) { message.warning("画布记录仍在读取，请稍后再试"); return; }
        placingImageRef.current = true;
        setPlacingImage(true);
        const sessionId = activeSession.id;
        try {
            let project = useCanvasStore.getState().projects.find((item) => item.id === activeSession.canvasProjectId);
            const nodeId = `chat-image:${image.id}`;
            if (!project?.nodes.some((node) => node.id === nodeId)) {
                const response = await fetch(image.dataUrl);
                if (!response.ok) throw new Error("图片读取失败，尚未添加到画布");
                const blob = await response.blob();
                if (!blob.type.startsWith("image/")) throw new Error("返回内容不是可用图片");
                const stored = await uploadImage(blob);
                if (loadedStorageKeyRef.current !== storageKey) return;
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
            persistence.clear();
            await persistSessions(sessionsRef.current);
            if (loadedStorageKeyRef.current !== storageKey) return;
            navigate(`/canvas/${project!.id}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "添加到画布失败");
        } finally {
            placingImageRef.current = false;
            setPlacingImage(false);
        }
    };

    const removeSession = (id: string) => {
        if (!sessionsReady || sendingRef.current || placingImageRef.current) return;
        setSessions((current) => {
            const next = current.filter((item) => item.id !== id);
            if (next.length) return next;
            const session = createSession();
            setActiveSessionId(session.id);
            return [session];
        });
    };

    const send = async () => {
        const text = draft.trim();
        if (!sessionsReady || (!text && !attachments.length) || sendingRef.current || placingImageRef.current || readingAttachments || !activeSession) return;
        if (activeSession.messages.some((item) => item.pendingImageTask)) { message.warning("本会话有尚未核实的图片任务，请先查询原任务，勿重复生成"); return; }
        if (!selectedModel || !selected) {
            message.warning("管理员尚未启用可用的对话模型");
            return;
        }

        const sessionId = activeSession.id;
        const sendLifetime = { controller: new AbortController(), submitted: false };
        const signal = sendLifetime.controller.signal;
        activeSendRef.current = sendLifetime;
        const userMessage: ChatMessage = { id: createClientId(), parentMessageId: activeSession.messages.at(-1)?.id, editTargetImageId: activeSession.editTargetImageId, role: "user", content: text, attachments, createdAt: new Date().toISOString() };
        const assistantId = createClientId();
        const requestedImageQuality = activeSession.imageQuality;
        const requestedImageResolution = activeSession.imageResolution;

        // Commit the full user turn before clearing its draft or making a model
        // request. A failed write must leave the user's attachments available.
        const selectedSessionModels = { chatModelId: creativeModelId };
        const conversationTitle = (text || attachments[0]?.name || "新对话").slice(0, 18);
        const nextSessions = sessionsRef.current.map((session) => session.id === sessionId ? { ...session, ...selectedSessionModels, title: session.messages.length ? session.title : conversationTitle, messages: [...session.messages, userMessage], updatedAt: new Date().toISOString() } : session);
        preparingMessageRef.current = true;
        sendingRef.current = true;
        persistence.clear();
        setIsSending(true);
        setSendPhase("正在理解需求…");
        try {
            await persistSessions(nextSessions);
        } catch {
            preparingMessageRef.current = false;
            sendingRef.current = false;
            if (activeSendRef.current === sendLifetime) activeSendRef.current = null;
            setIsSending(false);
            message.error("聊天记录未保存，消息尚未发送；草稿和附件已保留。");
            return;
        }
        preparingMessageRef.current = false;
        if (signal.aborted || loadedStorageKeyRef.current !== storageKey) { sendingRef.current = false; if (activeSendRef.current === sendLifetime) activeSendRef.current = null; setIsSending(false); return; }
        updateSession(sessionId, (session) => ({ ...session, ...selectedSessionModels, title: session.messages.length ? session.title : conversationTitle, messages: [...session.messages, userMessage], updatedAt: new Date().toISOString() }));
        setDraft((current) => current === draft ? "" : current);
        const sentAttachmentIds = new Set(attachments.map((item) => item.id));
        setAttachments((current) => current.filter((item) => !sentAttachmentIds.has(item.id)));
        followBottomRef.current = true;
        const stream = createChatStreamBuffer((content) => updateSession(sessionId, (session) => ({
            ...session,
            messages: [...session.messages.filter((item) => item.id !== assistantId), { id: assistantId, parentMessageId: userMessage.id, role: "assistant", content, createdAt: new Date().toISOString() }],
            updatedAt: new Date().toISOString(),
        })));
        activeStreamRef.current = stream;
        let imageSubmissionStarted = false;
        try {
            const plan = await requestCreativeChatPlan({ ...config, model: creativeModelId, textModel: creativeModelId, systemPrompt: "" }, activeSession.messages, userMessage, { signal, selectedImageId: activeSession.editTargetImageId, onPhase: setSendPhase, onDelta: stream.push });
            signal.throwIfAborted();
            if (loadedStorageKeyRef.current !== storageKey) throw new Error("登录账户已改变，未提交图片任务");
            stream.cancel();
            if (plan.kind === "discussion") {
                updateSession(sessionId, (session) => ({ ...session, messages: [...session.messages.filter((item) => item.id !== assistantId), { id: assistantId, parentMessageId: userMessage.id, role: "assistant", content: plan.content, createdAt: new Date().toISOString() }], updatedAt: new Date().toISOString() }));
                return;
            }
            const { prompt: imagePrompt, references, action, content: explanation, lineage } = plan;
            signal.throwIfAborted();
            if (loadedStorageKeyRef.current !== storageKey) throw new Error("登录账户已改变，未提交图片任务");
            const imageModel = preferredChatImageModel(imageModels, [activeSession.imageModelId, config.imageModel, config.model], action);
            if (!imageModel) throw new Error(`当前尚未配置可用的图片${action === "edit" ? "编辑" : "生成"}服务。可以继续讨论，图片处理需管理员启用。`);
            const imageModelId = imageModel.modelId;
            const qualitySettings = resolveChatImageQuality(imageModelId, requestedImageQuality, requestedImageResolution);
            if (!qualitySettings.supported) {
                updateSession(sessionId, session => ({ ...session, imageModelId, imageQuality: qualitySettings.quality, imageResolution: qualitySettings.resolution }));
                throw new Error("本次图片操作所用模型不支持原清晰度或图片质量，已更新可选档位。请在输入框下方调整后重新发送；图片任务尚未提交。");
            }
            const quality = qualitySettings.quality;
            const resolution = qualitySettings.resolution;
            setSendPhase(action === "edit" ? "正在按你的要求修改图片…" : "正在生成图片…");
            const imageConfig = { ...config, model: imageModelId, imageModel: imageModelId, quality, imageOptions: chatImageRequestOptions(config.imageOptions, resolution), systemPrompt: "", count: "1" };
            const pendingImageTask: PendingChatImageTask = { requestId: createClientId(), prompt: imagePrompt, modelId: imageModelId, quality, ...(resolution ? { resolution } : {}), action, parentMessageId: userMessage.id, lineage, explanation };
            updateSession(sessionId, (session) => ({ ...session, imageModelId, imageQuality: quality, imageResolution: resolution, messages: [...session.messages.filter((item) => item.id !== assistantId), { id: assistantId, parentMessageId: userMessage.id, role: "assistant", content: `${explanation ? `${explanation}\n\n` : ""}正在准备图片…`, pendingImageTask, createdAt: new Date().toISOString() }], updatedAt: new Date().toISOString() }));
            persistence.clear();
            await persistSessions(sessionsRef.current);
            signal.throwIfAborted();
            if (loadedStorageKeyRef.current !== storageKey) throw new Error("登录账户已改变，未提交图片任务");
            const onSubmissionStarted = () => { imageSubmissionStarted = true; };
            const onSubmitted = async (taskIds: string[]) => {
                sendLifetime.submitted = true;
                if (loadedStorageKeyRef.current !== storageKey) return;
                updateSession(sessionId, (session) => ({ ...session, messages: session.messages.map((item) => item.id === assistantId ? { ...item, pendingImageTask: { ...pendingImageTask, taskId: taskIds[0] }, content: "正在处理图片，完成后会直接显示在这里。" } : item), updatedAt: new Date().toISOString() }));
                persistence.clear();
                await persistSessions(sessionsRef.current);
            };
            const generated = action === "edit"
                ? await requestEdit(imageConfig, imagePrompt, references, undefined, { operationType: "inpaint", tool: "gpt-chat-image", requestId: pendingImageTask.requestId, signal, onSubmissionStarted, onSubmitted })
                : await requestGeneration(imageConfig, imagePrompt, { operationType: "image_generation", tool: "gpt-chat-image", requestId: pendingImageTask.requestId, signal, onSubmissionStarted, onSubmitted });
            if (!generated.length) throw new Error("图像模型没有返回图片");
            const savedImages = await Promise.all(generated.map(async (item, index) => ({ id: item.sourceTaskId ? `${item.sourceTaskId}:${index}` : item.id, dataUrl: await imageToDataUrl(item).catch(() => item.dataUrl), prompt: imagePrompt, modelId: imageModelId, quality, ...(resolution ? { resolution } : {}), lineage })));
            updateSession(sessionId, (session) => ({
                ...session,
                editTargetImageId: savedImages[0]?.id,
                messages: [...session.messages.filter((item) => item.id !== assistantId), { id: assistantId, parentMessageId: userMessage.id, role: "assistant", content: "", generatedImages: savedImages, createdAt: new Date().toISOString() }],
                updatedAt: new Date().toISOString(),
            }));
            return;
        } catch (error) {
            stream.flush();
            updateSession(sessionId, (session) => ({
                ...session,
                messages: session.messages.some((item) => item.id === assistantId && item.pendingImageTask)
                    ? session.messages.map((item) => {
                        if (item.id !== assistantId) return item;
                        if (imageSubmissionStarted || sendLifetime.submitted) return { ...item, content: `图片任务结果尚未确认：${error instanceof Error ? error.message : "请求失败"}。请查询原任务，勿重复生成。` };
                        const { pendingImageTask: _pending, ...saved } = item;
                        return { ...saved, role: "error", content: `图片任务尚未提交：${error instanceof Error ? error.message : "准备失败"}。可以修正后重新发送。` };
                    })
                    : [...session.messages, { id: createClientId(), role: "error", content: error instanceof Error ? error.message : "对话请求失败", createdAt: new Date().toISOString() }],
                updatedAt: new Date().toISOString(),
            }));
        } finally {
            stream.cancel();
            if (activeStreamRef.current === stream) activeStreamRef.current = null;
            if (loadedStorageKeyRef.current === storageKey) {
                persistence.clear();
                await persistSessions(sessionsRef.current).catch(() => undefined);
            }
            sendingRef.current = false;
            if (activeSendRef.current === sendLifetime) activeSendRef.current = null;
            setIsSending(false);
        }
    };

    const addFiles = async (files: FileList | null) => {
        if (!sessionsReady || !files?.length || readingAttachments) return;
        setReadingAttachments(true);
        const candidates = Array.from(files).slice(0, Math.max(0, 5 - attachments.length));
        const next: ChatAttachment[] = [];
        let totalBytes = attachments.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
        for (const file of candidates) {
            if (file.size > 5 * 1024 * 1024) {
                message.warning(`${file.name} 超过 5MB，未添加`);
                continue;
            }
            try {
                const parsed = await parseChatAttachment(file, { imageToDataUrl: readFileAsDataUrl });
                const size = parsed.dataUrl ? dataUrlBytes(parsed.dataUrl) : file.size;
                if (totalBytes + size > 8 * 1024 * 1024) {
                    message.warning("\u672c\u6b21\u5bf9\u8bdd\u9644\u4ef6\u603b\u5927\u5c0f\u4e0d\u80fd\u8d85\u8fc7 8MB");
                    break;
                }
                next.push({ id: createClientId(), ...parsed, size });
                totalBytes += size;
            } catch (error) {
                message.error(error instanceof Error ? error.message : "文件读取失败");
            }
        }
        if (next.length) setAttachments((current) => [...current, ...next].slice(0, 5));
        setReadingAttachments(false);
    };

    return (
        <main className="wb-page h-full min-h-0 p-3 md:p-5">
            <div className="wb-surface relative mx-auto flex h-full max-w-[1600px] overflow-hidden">
                {sidebarOpen ? <button type="button" aria-label="关闭会话列表" className="absolute inset-0 z-10 bg-black/25 md:hidden" onClick={() => setSidebarOpen(false)} /> : null}
                <aside inert={!sidebarOpen} aria-hidden={!sidebarOpen} className={cn("absolute inset-y-0 left-0 z-20 flex shrink-0 flex-col border-r border-border bg-background transition-[width] duration-200 md:relative md:inset-auto", sidebarOpen ? "w-[260px]" : "w-0 overflow-hidden border-r-0")}>
                    <div className="flex items-center justify-between px-4 py-4">
                        <div className="flex items-center gap-2 text-sm font-semibold"><Bot className="size-4 text-orange-600" /> 对话记录</div>
                        <div className="flex">
                            <Tooltip title="新建对话"><button type="button" aria-label="新建对话" onClick={() => startSession()} className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted"><MessageSquarePlus className="size-4" /></button></Tooltip>
                            <button type="button" aria-label="收起会话" onClick={() => setSidebarOpen(false)} className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted md:hidden"><X className="size-4" /></button>
                        </div>
                    </div>
                    <div className="px-3"><Button type="primary" block icon={<MessageSquarePlus className="size-4" />} onClick={() => startSession()} className="!h-10">新对话</Button></div>
                    <div className="mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3">
                        {sessions.map((session) => <div key={session.id} className={cn("group flex w-full items-center gap-1 rounded-xl pr-1 transition-colors", session.id === activeSession?.id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted")}>
                            <button type="button" disabled={isSending || placingImage} onClick={() => { setActiveSessionId(session.id); if (window.innerWidth < 768) setSidebarOpen(false); }} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-3 text-left disabled:opacity-60">
                                <span className="grid size-7 shrink-0 place-items-center rounded-lg opacity-75"><Bot className="size-4" /></span>
                                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{sessionTitle(session)}</span><span className="mt-1 block text-[11px] opacity-65">{new Date(session.updatedAt).toLocaleDateString()}</span></span>
                            </button>
                            <button type="button" disabled={isSending || placingImage} onClick={() => modal.confirm({ title: "删除这段对话？", content: "会话仅保存在当前浏览器，删除后无法恢复。", okText: "删除", cancelText: "保留", okButtonProps: { danger: true }, onOk: () => removeSession(session.id) })} className="grid size-8 shrink-0 place-items-center rounded-lg opacity-50 transition hover:opacity-100 focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-60" aria-label="删除会话"><Trash2 className="size-4" /></button>
                        </div>)}
                    </div>
                    <div className="border-t border-border px-4 py-4 text-xs leading-6 text-muted-foreground">对话保存在当前浏览器。<br />模型与密钥由服务端统一管理。</div>
                </aside>

                <section className="flex min-w-0 flex-1 flex-col">
                    <header className="flex min-h-24 flex-wrap items-center gap-3 border-b border-border px-4 py-4 md:px-6">
                        <Tooltip title={sidebarOpen ? "收起会话" : "展开会话"}><button type="button" aria-label={sidebarOpen ? "收起会话" : "展开会话"} onClick={() => setSidebarOpen((value) => !value)} className="grid size-10 place-items-center rounded-xl text-muted-foreground hover:bg-muted">{sidebarOpen ? <PanelLeftClose className="size-5" /> : <PanelLeftOpen className="size-5" />}</button></Tooltip>
                        <div className="min-w-0 flex-1"><h1 className="wb-title">对话改图</h1><p className="mt-1 text-sm text-muted-foreground">直接发消息、图片或文件，接着聊、接着改。</p></div>
                        {modelsLoading ? <LoaderCircle role="status" aria-label="正在读取对话配置" className="size-4 animate-spin text-muted-foreground" /> : null}
                    </header>
                    {modelError ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/60 px-6 py-3 text-sm"><span>{modelError}</span><Button onClick={() => void refreshModels().catch(() => undefined)}>重试加载</Button></div> : null}
                    {modelsStatus === "ready" && !selected ? <p role="status" className="border-b border-border px-6 py-3 text-sm text-muted-foreground">对话服务暂不可用，请联系管理员检查后台配置。</p> : null}
                    {!sessionsReady ? <div role={sessionLoadError ? "alert" : "status"} className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/60 px-6 py-3 text-sm"><span>{sessionLoadError || "正在读取本地聊天记录…"}</span>{sessionLoadError ? <Button onClick={() => setSessionReload((value) => value + 1)}>重试读取记录</Button> : null}</div> : null}
                    {sessionSaveError ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/60 px-6 py-3 text-sm"><span>{sessionSaveError}</span><Button onClick={() => { if (sessionsReady && !preparingMessageRef.current) { persistence.clear(); void persistSessions(sessionsRef.current).catch(() => undefined); } }}>重试保存记录</Button></div> : null}

                    {selectedClaude ? <details className="border-b border-border px-4 py-2 text-xs text-muted-foreground md:px-6"><summary className="w-fit cursor-pointer">模型设置</summary><ClaudeChatControls model={selectedParameterModel} stream={config.claudeStream !== "false"} thinking={config.claudeThinking === "true"} maxTokens={config.claudeMaxTokens} onStreamChange={(value) => updateConfig("claudeStream", String(value))} onThinkingChange={(value) => updateConfig("claudeThinking", String(value))} onMaxTokensChange={(value) => updateConfig("claudeMaxTokens", value)} /></details> : null}

                    <div ref={scrollRef} onScroll={(event) => { const element = event.currentTarget; followBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-[8%]">
                        {!activeSession?.messages.length ? <div className="wb-empty mx-auto max-w-xl !min-h-0 !py-2">
                            <div className="hidden size-12 place-items-center rounded-2xl bg-muted text-foreground [@media(min-height:850px)]:grid"><WandSparkles className="size-6" /></div>
                            <h2 className="mt-2 text-xl font-semibold text-foreground sm:text-2xl">有什么想法，直接说。</h2>
                            <p>问问题、生成图片，或上传图片和文件，接着聊、接着改。</p>
                        </div> : <div className="mx-auto max-w-3xl space-y-6">{activeSession.messages.map((item) => <ChatBubble key={item.id} message={item} imageLabels={imageLabels} actionsDisabled={isSending || placingImage || Boolean(pendingImageMessage)} onPlaceOnCanvas={(image) => void placeImageOnCanvas(image)} />)}{isSending ? <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{sendPhase}</div> : null}</div>}
                    </div>

                    <div className="border-t border-border bg-card px-4 py-4 md:px-[8%]">
                        <div className="mx-auto max-w-3xl">
                            {pendingImageMessage && !isSending ? <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground"><span>{recoveringImageTask ? "正在查询原图片任务，不会重新生成…" : "本会话有图片任务尚未核实；确认结果前不能继续发送。"}</span><Button size="small" disabled={recoveringImageTask} onClick={queryOriginalImageTask}>查询原任务</Button></div> : null}
                            <div className="rounded-2xl border border-input bg-background p-3 focus-within:border-orange-400">
                                {attachments.length ? <div className="flex flex-wrap gap-2 pb-3">{attachments.map((item) => <div key={item.id} className="group relative flex h-14 max-w-[180px] items-center gap-2 rounded-xl border border-border bg-card p-1.5">{item.dataUrl ? <img src={item.dataUrl} alt="" className="size-10 rounded-lg object-cover" /> : <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground"><FileText className="size-5" /></span>}<span className="min-w-0 flex-1 truncate text-xs font-medium">{item.name}</span><button type="button" aria-label={"移除 " + item.name} onClick={() => setAttachments((current) => current.filter((attachment) => attachment.id !== item.id))} className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full border border-border bg-card text-muted-foreground hover:text-red-600"><X className="size-3.5" /></button></div>)}</div> : null}
                                {readingAttachments ? <div role="status" className="mb-2 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取附件，请稍候…</div> : null}
                                <textarea aria-label="对话内容" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void send(); } }} placeholder="发消息，或上传图片、文件告诉我怎么改…" className="min-h-[80px] w-full resize-none bg-transparent px-1 py-1 text-sm leading-7 text-foreground outline-none placeholder:text-muted-foreground" />
                                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
                                    <div className="flex min-w-0 flex-wrap items-center gap-1">
                                        <Tooltip title="上传图片、PDF、Word、表格或文本"><button type="button" disabled={!sessionsReady || readingAttachments || attachments.length >= 5} onClick={() => openChatAttachmentPicker(fileInputRef.current)} className="grid size-10 place-items-center rounded-xl text-muted-foreground hover:bg-muted disabled:opacity-40" aria-label="上传文件"><Paperclip className="size-5" /></button></Tooltip>
                                        <Tooltip title="上传图片"><button type="button" disabled={!sessionsReady || readingAttachments || attachments.length >= 5} onClick={() => openChatAttachmentPicker(fileInputRef.current, true)} className="grid size-10 place-items-center rounded-xl text-muted-foreground hover:bg-muted disabled:opacity-40" aria-label="上传图片"><ImagePlus className="size-5" /></button></Tooltip>
                                        <label className="flex min-w-0 items-center gap-1.5 pl-1 text-xs text-muted-foreground" title={imageBinding?.modelConfigId ? "当前出图模型由后台指定" : "仅影响本会话出图和改图"}>出图模型<select data-usage-control="model" aria-label="出图模型" value={preferredImageModel?.modelId || ""} disabled={!sessionsReady || modelsLoading || isSending || Boolean(pendingImageMessage) || !imageModels.length || Boolean(imageBinding?.modelConfigId)} onChange={event => { const modelId = event.target.value; if (activeSession && imageModels.some(model => model.modelId === modelId)) updateSession(activeSession.id, session => { const settings = resolveChatImageQuality(modelId, session.imageQuality, session.imageResolution); return { ...session, imageModelId: modelId, imageQuality: settings.quality, imageResolution: settings.resolution }; }); }} className="h-8 max-w-[200px] rounded-lg border border-border bg-card px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{!preferredImageModel ? <option value="">{modelsLoading ? "正在读取模型" : "暂无可用模型"}</option> : null}{imageModels.map(model => <option key={model.id} value={model.modelId}>{modelLabelWithUsage(model.name, model.publicDescription)}</option>)}</select></label>
                                        {imageQualitySettings.independentResolution ? <label className="flex min-w-0 items-center gap-1.5 pl-1 text-xs text-muted-foreground" title="本会话的图片清晰度，与图片质量独立设置">清晰度<select data-usage-control="resolution" aria-label="图片分辨率" data-testid="chat-image-resolution" value={imageQualitySettings.resolution} disabled={!sessionsReady || modelsLoading || isSending || Boolean(pendingImageMessage) || !preferredImageModel} onChange={event => { if (activeSession && preferredImageModel) updateSession(activeSession.id, session => ({ ...session, imageModelId: preferredImageModel.modelId, imageResolution: event.target.value })); }} className="h-8 max-w-[110px] rounded-lg border border-border bg-card px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{imageQualitySettings.resolutionOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label> : null}
                                        <label className="flex min-w-0 items-center gap-1.5 pl-1 text-xs text-muted-foreground" title={imageQualitySettings.adjustable ? "仅影响本会话出图和改图；图片质量与清晰度为不同参数" : "当前模型没有可调档位，使用模型默认设置"}>{imageQualitySettings.label}<select data-usage-control={imageQualitySettings.independentResolution ? "quality" : "resolution"} aria-label={imageQualitySettings.independentResolution ? "图片质量" : "图片清晰度"} data-testid="chat-image-quality" value={imageQualitySettings.quality} disabled={!sessionsReady || modelsLoading || isSending || Boolean(pendingImageMessage) || !preferredImageModel || !imageQualitySettings.adjustable} onChange={event => { if (activeSession && preferredImageModel) updateSession(activeSession.id, session => ({ ...session, imageModelId: preferredImageModel.modelId, imageQuality: event.target.value })); }} className="h-8 max-w-[110px] rounded-lg border border-border bg-card px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{imageQualitySettings.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                                    </div>
                                    <Button type="primary" disabled={!sessionsReady || (!draft.trim() && !attachments.length) || isSending || placingImage || Boolean(pendingImageMessage) || readingAttachments || !selectedModel} loading={isSending} onClick={() => void send()} icon={<Send className="size-4" />} className="!h-10 !px-4">发送</Button>
                                </div>
                                <input ref={fileInputRef} type="file" multiple disabled={!sessionsReady || readingAttachments} accept={CHAT_ATTACHMENT_ACCEPT} className="hidden" onChange={(event) => { void addFiles(event.target.files); event.currentTarget.value = ""; }} />
                            </div>
                            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"><CornerDownLeft className="size-3.5" /><span>Ctrl / ⌘ + Enter 发送</span><span className="opacity-45">·</span><span>{deploymentFeatures.creditsEnabled ? "对话按成功模型调用计费（含工具续答），生成图片另计积分" : "直接继续提要求，无需重复上传"}</span></p>
                        </div>
                    </div>
                </section>
            </div>
        </main>
    );
}

const ChatBubble = memo(function ChatBubble({ message, imageLabels, actionsDisabled, onPlaceOnCanvas }: { message: ChatMessage; imageLabels: Map<string, string>; actionsDisabled: boolean; onPlaceOnCanvas: (image: ChatGeneratedImage) => void }) {
    const isUser = message.role === "user";
    return (
        <div className={cn("flex gap-3", isUser ? "justify-end" : "justify-start")}>
            <div className={cn("grid size-8 shrink-0 place-items-center rounded-xl", isUser ? "order-2 bg-foreground text-background" : message.role === "error" ? "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-300" : "bg-muted text-muted-foreground")}>{isUser ? <span className="text-xs font-semibold">我</span> : message.role === "error" ? <span className="text-xs font-semibold">!</span> : <Bot className="size-4" />}</div>
            <div className={cn("min-w-0 max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-7", isUser ? "order-1 bg-foreground text-background" : message.role === "error" ? "border border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200" : "border border-border bg-card text-foreground")}>
                {message.content ? <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.content}</div> : null}
                {message.generatedImages?.length ? <div className={cn("grid grid-cols-1 gap-3", message.content && "mt-3", message.generatedImages.length > 1 && "sm:grid-cols-2")}>{message.generatedImages.map((item) => <div key={item.id} className="overflow-hidden rounded-xl border border-border bg-muted">
                    <img src={item.dataUrl} alt={imageLabels.get(item.id) || "生成结果"} loading="lazy" decoding="async" className="max-h-[480px] w-full object-contain" />
                    <div className="flex items-center gap-1 border-t border-border text-xs text-muted-foreground"><span className="flex-1 px-3">{imageLabels.get(item.id) || "生成结果"}</span><button type="button" disabled={actionsDisabled} onClick={() => onPlaceOnCanvas(item)} className="min-h-10 px-3 py-2 hover:bg-card disabled:opacity-50">放入画布</button><a href={item.dataUrl} download="wireless-canvas.png" className="min-h-10 px-3 py-2 hover:bg-card">下载</a></div>
                </div>)}</div> : null}
                {message.attachments?.length ? <div className={cn("flex flex-wrap gap-2", message.content && "mt-3")}>{message.attachments.map((item) => item.dataUrl ? <div key={item.id}><img src={item.dataUrl} alt={item.name} loading="lazy" decoding="async" className="max-h-40 rounded-xl border border-border object-contain" /><span className="text-xs opacity-75">{imageLabels.get(item.id) || item.name}</span></div> : <span key={item.id} className={cn("inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs", isUser ? "bg-background/10" : "bg-muted text-muted-foreground")}><FileText className="size-3.5" />{item.name}</span>)}</div> : null}
            </div>
        </div>
    );
});

function ClaudeChatControls({ model, stream, thinking, maxTokens, onStreamChange, onThinkingChange, onMaxTokensChange }: { model: string; stream: boolean; thinking: boolean; maxTokens: string; onStreamChange: (value: boolean) => void; onThinkingChange: (value: boolean) => void; onMaxTokensChange: (value: string) => void }) {
    const alwaysThinking = model.toLowerCase() === "claude-fable-5";
    const openTokenClaude = model.toLowerCase() === "claude-fable-5-1";
    const channelDefaultThinking = openTokenClaude || model.toLowerCase() === "claude-sonnet-5-5";
    return <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">回复参数</span>
        <label className="inline-flex cursor-pointer items-center gap-1.5"><input type="checkbox" checked={stream} onChange={(event) => onStreamChange(event.target.checked)} /> 流式输出</label>
        {channelDefaultThinking ? <span title="使用后台配置对应的默认思考行为。">思考模式 · 渠道默认</span> : alwaysThinking ? <span title="当前服务始终启用自适应思考，不支持关闭或固定思考预算。">自适应思考 · 始终开启</span> : <label className="inline-flex cursor-pointer items-center gap-1.5"><input type="checkbox" checked={thinking} onChange={(event) => onThinkingChange(event.target.checked)} /> 自适应思考</label>}
        <label className="inline-flex items-center gap-1.5" title="总输出预算包含思考与可见回复；16384 是当前项目限制，不是模型官方最大值。">总输出预算
            <select value={maxTokens} onChange={(event) => onMaxTokensChange(event.target.value)} className="h-8 rounded-lg border border-border bg-card px-2 text-xs text-foreground outline-none">
                {["1024", "2048", "4096", "8192", "16384"].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
        </label>
        <a href={openTokenClaude ? "https://docs.opentoken.io/api/claude/messages-api/" : "https://docs.apib.ai/cn/api-reference/texts/general/claude-messages"} target="_blank" rel="noreferrer" className="underline underline-offset-2">接口说明</a>
        <span className="w-full text-[11px] leading-4">预算包含思考与回复；当前项目上限 16384 tokens。参数不适用于其他模型。</span>
    </div>;
}
