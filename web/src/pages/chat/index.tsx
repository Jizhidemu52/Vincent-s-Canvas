import { App, Button, Tooltip } from "antd";
import { Bot, CheckCircle2, ChevronDown, CornerDownLeft, FileText, ImagePlus, LoaderCircle, MessageSquarePlus, Paperclip, PanelLeftClose, PanelLeftOpen, Send, Sparkles, Trash2, WandSparkles, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";

import { cn } from "@/lib/utils";
import { deploymentFeatures } from "@/lib/deployment-features";
import { createClientId } from "@/lib/client-id";
import { CHAT_ATTACHMENT_ACCEPT, openChatAttachmentPicker, parseChatAttachment, type ParsedChatAttachment } from "@/lib/chat-attachments";
import { buildChatRequestMessages } from "@/lib/chat-context";
import { createDeferredPersistQueue } from "@/lib/deferred-persist-queue";
import { createChatStreamBuffer } from "./chat-stream-buffer";
import { chatSessionStorage } from "./chat-session-storage";
import { isClaudeModel, requestEdit, requestGeneration, requestImageQuestion } from "@/services/api/image";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

type ChatModel = { modelId: string; name: string; creditCost: number; capabilities: string[] };
type ChatAttachment = Omit<ParsedChatAttachment, "kind"> & { id: string; kind?: ParsedChatAttachment["kind"] };
type ChatMessage = { id: string; role: "user" | "assistant" | "error"; content: string; attachments?: ChatAttachment[]; generatedImages?: Array<{ id: string; dataUrl: string }>; createdAt: string };
type ChatSession = { id: string; title: string; mode: ChatMode; messages: ChatMessage[]; updatedAt: string };
type ChatMode = "chat" | "agent" | "create";
type AgentTask = "brief" | "prompt" | "plan";

const storagePrefix = "wireless-canvas:llm-chat:";
const agentTasks: Array<{ id: AgentTask; label: string; description: string; prompt: string }> = [
    { id: "brief", label: "分析需求", description: "梳理目标、限制与缺失信息", prompt: "请分析这份设计需求，列出目标、限制条件、需要补充的信息和可执行建议：" },
    { id: "prompt", label: "整理提示词", description: "将设计语言转成可用提示词", prompt: "请把下面的设计需求整理成可直接用于生图的中文提示词，并给出负面限制和参数建议：" },
    { id: "plan", label: "生成方案", description: "拆成清晰的执行步骤", prompt: "请把下面的设计需求拆成可执行的设计任务清单，按优先级、输入、输出和验收标准说明：" },
];

function createSession(mode: ChatMode = "chat"): ChatSession {
    return { id: createClientId(), title: "新对话", mode, messages: [], updatedAt: new Date().toISOString() };
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

async function compressChatImage(file: File) {
    const source = await readFileAsDataUrl(file);
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error(`${file.name} 不是可用图片`));
        element.src = source;
    });
    const maxDimension = 1024;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法处理图片");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.78);
}

export default function ChatPage() {
    const { message, modal } = App.useApp();
    const user = useUserStore((state) => state.user);
    const config = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const storageKey = `${storagePrefix}${user?.id || "anonymous"}`;
    const [models, setModels] = useState<ChatModel[]>([]);
    const [modelsLoading, setModelsLoading] = useState(true);
    const [modelError, setModelError] = useState("");
    const [modelReload, setModelReload] = useState(0);
    const [selectedModel, setSelectedModel] = useState("");
    const [mode, setMode] = useState<ChatMode>("chat");
    const [agentTask, setAgentTask] = useState<AgentTask>("brief");
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
        void chatSessionStorage.load<ChatSession>(storageKey, () => localStorage.getItem(storageKey))
            .then((stored) => {
                if (cancelled) return;
                setSessions(stored.length ? stored : [createSession()]);
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
        let active = true;
        setModelsLoading(true);
        setModelError("");
        fetch("/api/models", { credentials: "include" })
            .then((response) => response.ok ? response.json() : Promise.reject(new Error("无法加载对话模型")))
            .then((data: { models: ChatModel[] }) => {
                if (!active) return;
                const available = data.models.filter((item) => item.capabilities.includes("chat"));
                setModels(data.models);
                setSelectedModel((current) => current && available.some((item) => item.modelId === current) ? current : available[0]?.modelId || "");
            })
            .catch(() => { if (active) { setModels([]); setModelError("模型列表暂时无法读取，请重试。"); } })
            .finally(() => { if (active) setModelsLoading(false); });
        return () => { active = false; };
    }, [modelReload]);

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
    const chatModels = useMemo(() => models.filter((item) => item.capabilities.includes("chat")), [models]);
    // Demo-only models are useful in their dedicated workbenches, but the chat
    // creation mode submits real provider tasks and must never select one first.
    const imageModels = useMemo(() => models.filter((item) => !item.modelId.startsWith("demo-") && item.capabilities.some((capability) => ["generate", "edit"].includes(capability))), [models]);
    const availableModels = mode === "create" ? imageModels : chatModels;
    useEffect(() => {
        setSelectedModel((current) => availableModels.some((item) => item.modelId === current) ? current : availableModels[0]?.modelId || "");
    }, [availableModels]);
    const selected = availableModels.find((item) => item.modelId === selectedModel);
    const selectedClaude = isClaudeModel(selectedModel);
    const agent = agentTasks.find((item) => item.id === agentTask)!;

    const updateSession = (id: string, update: (session: ChatSession) => ChatSession) => {
        if (loadedStorageKeyRef.current !== storageKey) return;
        setSessions((current) => current.map((session) => session.id === id ? update(session) : session));
    };

    const startSession = (nextMode: ChatMode = mode) => {
        if (!sessionsReady) return;
        const session = createSession(nextMode);
        setSessions((current) => [session, ...current]);
        setActiveSessionId(session.id);
        setMode(nextMode);
        setDraft("");
        setAttachments([]);
    };

    const switchMode = useCallback((nextMode: ChatMode) => {
        setMode(nextMode);
        const available = nextMode === "create" ? imageModels : chatModels;
        setSelectedModel((current) => available.some((item) => item.modelId === current) ? current : available[0]?.modelId || "");
    }, [chatModels, imageModels]);

    const continueEditing = useCallback((image: { id: string; dataUrl: string }) => {
        switchMode("create");
        setAttachments([{ id: createClientId(), name: "上一版生成结果.png", mimeType: "image/png", size: dataUrlBytes(image.dataUrl), dataUrl: image.dataUrl }]);
        setDraft("");
        message.success("已带入上一版图片，输入修改要求后即可继续编辑");
    }, [message, switchMode]);

    const removeSession = (id: string) => {
        if (!sessionsReady) return;
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
        if (!sessionsReady || (!text && !attachments.length) || isSending || readingAttachments || !activeSession) return;
        if (!selectedModel || !selected) {
            message.warning(mode === "create" ? "管理员尚未启用可用的图像生成模型" : "管理员尚未启用可用的对话模型");
            return;
        }

        if (mode === "create" && !text) {
            message.warning("请输入图片生成或编辑要求");
            return;
        }

        const sessionId = activeSession.id;
        const userMessage: ChatMessage = { id: createClientId(), role: "user", content: text || "请分析我上传的内容。", attachments, createdAt: new Date().toISOString() };
        const assistantId = createClientId();
        const taskInstruction = mode === "agent" ? `${agent.prompt}\n\n请使用清晰标题、短列表和具体可执行建议。` : "";
        const requestMessages = buildChatRequestMessages(activeSession.messages, userMessage);

        // Commit the full user turn before clearing its draft or making a model
        // request. A failed write must leave the user's attachments available.
        const nextSessions = sessionsRef.current.map((session) => session.id === sessionId ? { ...session, mode, title: session.messages.length ? session.title : text.slice(0, 18), messages: [...session.messages, userMessage], updatedAt: new Date().toISOString() } : session);
        preparingMessageRef.current = true;
        persistence.clear();
        setIsSending(true);
        try {
            await persistSessions(nextSessions);
        } catch {
            preparingMessageRef.current = false;
            setIsSending(false);
            message.error("聊天记录未保存，消息尚未发送；草稿和附件已保留。");
            return;
        }
        preparingMessageRef.current = false;
        if (loadedStorageKeyRef.current !== storageKey) { setIsSending(false); return; }
        updateSession(sessionId, (session) => ({ ...session, mode, title: session.messages.length ? session.title : text.slice(0, 18), messages: [...session.messages, userMessage], updatedAt: new Date().toISOString() }));
        setDraft((current) => current === draft ? "" : current);
        const sentAttachmentIds = new Set(attachments.map((item) => item.id));
        setAttachments((current) => current.filter((item) => !sentAttachmentIds.has(item.id)));
        followBottomRef.current = true;
        const stream = createChatStreamBuffer((content) => updateSession(sessionId, (session) => ({
            ...session,
            messages: [...session.messages.filter((item) => item.id !== assistantId), { id: assistantId, role: "assistant", content, createdAt: new Date().toISOString() }],
            updatedAt: new Date().toISOString(),
        })));
        activeStreamRef.current = stream;
        try {
            if (mode === "create") {
                const references: ReferenceImage[] = attachments
                    .filter((item): item is ChatAttachment & { dataUrl: string } => Boolean(item.dataUrl))
                    .map((item) => ({ id: item.id, name: item.name, type: item.mimeType, dataUrl: item.dataUrl }));
                const imageConfig = { ...config, model: selectedModel, imageModel: selectedModel, count: "1" };
                const generated = references.length
                    ? await requestEdit(imageConfig, text, references, undefined, { operationType: "inpaint", tool: "gpt-chat" })
                    : await requestGeneration(imageConfig, text, { operationType: "image_generation", tool: "gpt-chat" });
                if (!generated.length) throw new Error("图像模型没有返回图片");
                updateSession(sessionId, (session) => ({
                    ...session,
                    messages: [...session.messages, { id: assistantId, role: "assistant", content: `已生成 ${generated.length} 张图片`, generatedImages: generated.map((item) => ({ id: item.id, dataUrl: item.dataUrl })), createdAt: new Date().toISOString() }],
                    updatedAt: new Date().toISOString(),
                }));
                return;
            }
            const response = await requestImageQuestion(
                { ...config, model: selectedModel, textModel: selectedModel, systemPrompt: taskInstruction },
                requestMessages,
                stream.push,
            );
            stream.cancel();
            updateSession(sessionId, (session) => ({
                ...session,
                messages: [...session.messages.filter((item) => item.id !== assistantId), { id: assistantId, role: "assistant", content: response || "模型没有返回内容。", createdAt: new Date().toISOString() }],
                updatedAt: new Date().toISOString(),
            }));
        } catch (error) {
            stream.flush();
            updateSession(sessionId, (session) => ({
                ...session,
                messages: [...session.messages, { id: createClientId(), role: "error", content: error instanceof Error ? error.message : "对话请求失败", createdAt: new Date().toISOString() }],
                updatedAt: new Date().toISOString(),
            }));
        } finally {
            stream.cancel();
            if (activeStreamRef.current === stream) activeStreamRef.current = null;
            if (loadedStorageKeyRef.current === storageKey) {
                persistence.clear();
                await persistSessions(sessionsRef.current).catch(() => undefined);
            }
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
                const parsed = await parseChatAttachment(file, { imageToDataUrl: compressChatImage });
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
                    <div className="px-3"><Button type="primary" block icon={<Sparkles className="size-4" />} onClick={() => startSession("agent")} className="!h-10">新建 Agent 任务</Button></div>
                    <div className="mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3">
                        {sessions.map((session) => <div key={session.id} className={cn("group flex w-full items-center gap-1 rounded-xl pr-1 transition-colors", session.id === activeSession?.id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted")}>
                            <button type="button" onClick={() => { setActiveSessionId(session.id); setMode(session.mode); if (window.innerWidth < 768) setSidebarOpen(false); }} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-3 text-left">
                                <span className="grid size-7 shrink-0 place-items-center rounded-lg opacity-75">{session.mode === "agent" ? <WandSparkles className="size-4" /> : session.mode === "create" ? <ImagePlus className="size-4" /> : <Bot className="size-4" />}</span>
                                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{sessionTitle(session)}</span><span className="mt-1 block text-[11px] opacity-65">{session.mode === "agent" ? "Agent 任务" : session.mode === "create" ? "图片创作" : "聊天"} · {new Date(session.updatedAt).toLocaleDateString()}</span></span>
                            </button>
                            <button type="button" onClick={() => modal.confirm({ title: "删除这段对话？", content: "会话仅保存在当前浏览器，删除后无法恢复。", okText: "删除", cancelText: "保留", okButtonProps: { danger: true }, onOk: () => removeSession(session.id) })} className="grid size-8 shrink-0 place-items-center rounded-lg opacity-50 transition hover:opacity-100 focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-60" aria-label="删除会话"><Trash2 className="size-4" /></button>
                        </div>)}
                    </div>
                    <div className="border-t border-border px-4 py-4 text-xs leading-6 text-muted-foreground">对话保存在当前浏览器。<br />模型与密钥由服务端统一管理。</div>
                </aside>

                <section className="flex min-w-0 flex-1 flex-col">
                    <header className="flex min-h-24 flex-wrap items-center gap-3 border-b border-border px-4 py-4 md:px-6">
                        <Tooltip title={sidebarOpen ? "收起会话" : "展开会话"}><button type="button" aria-label={sidebarOpen ? "收起会话" : "展开会话"} onClick={() => setSidebarOpen((value) => !value)} className="grid size-10 place-items-center rounded-xl text-muted-foreground hover:bg-muted">{sidebarOpen ? <PanelLeftClose className="size-5" /> : <PanelLeftOpen className="size-5" />}</button></Tooltip>
                        <div className="min-w-0 flex-1"><h1 className="wb-title">LLM 对话</h1><p className="mt-1 text-sm text-muted-foreground">{mode === "agent" ? "把设计需求，拆成下一步行动。" : mode === "create" ? "聊一个想法，也创作一张图片。" : "设计思路、提示词、素材分析，一起想清楚。"}</p></div>
                        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
                            <span role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">{modelsLoading ? <LoaderCircle className="size-3.5 animate-spin" /> : availableModels.length ? <CheckCircle2 className="size-3.5" /> : null}{modelsLoading ? "读取模型中" : availableModels.length ? availableModels.length + " 个可用模型" : "暂无可用模型"}</span>
                            <div className="relative min-w-0"><select aria-label="对话模型" disabled={modelsLoading || !availableModels.length} value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} className="h-10 max-w-[240px] appearance-none rounded-xl border border-border bg-card py-0 pl-3 pr-9 text-sm text-foreground outline-none disabled:opacity-50"><option value="">{modelsLoading ? "正在读取模型" : "选择模型"}</option>{availableModels.map((item) => <option key={item.modelId} value={item.modelId}>{item.name}</option>)}</select><ChevronDown className="pointer-events-none absolute right-3 top-3 size-4 text-muted-foreground" /></div>
                        </div>
                    </header>
                    {modelError ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/60 px-6 py-3 text-sm"><span>{modelError}</span><Button onClick={() => setModelReload((value) => value + 1)}>重试加载</Button></div> : null}
                    {!sessionsReady ? <div role={sessionLoadError ? "alert" : "status"} className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/60 px-6 py-3 text-sm"><span>{sessionLoadError || "正在读取本地聊天记录…"}</span>{sessionLoadError ? <Button onClick={() => setSessionReload((value) => value + 1)}>重试读取记录</Button> : null}</div> : null}
                    {sessionSaveError ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/60 px-6 py-3 text-sm"><span>{sessionSaveError}</span><Button onClick={() => { if (sessionsReady && !preparingMessageRef.current) { persistence.clear(); void persistSessions(sessionsRef.current).catch(() => undefined); } }}>重试保存记录</Button></div> : null}

                    <div className="border-b border-border px-4 py-3 md:px-6">
                        <div className="inline-flex gap-1 rounded-xl bg-muted p-1">
                            <button type="button" aria-pressed={mode === "chat"} onClick={() => switchMode("chat")} className={cn("flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors", mode === "chat" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}><Bot className="size-4" />聊天</button>
                            <button type="button" aria-pressed={mode === "create"} onClick={() => switchMode("create")} className={cn("flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors", mode === "create" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}><ImagePlus className="size-4" />创作</button>
                            <button type="button" aria-pressed={mode === "agent"} onClick={() => switchMode("agent")} className={cn("flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors", mode === "agent" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}><WandSparkles className="size-4" />Agent</button>
                        </div>
                        {selectedClaude && mode !== "create" ? <ClaudeChatControls model={selectedModel} stream={config.claudeStream !== "false"} thinking={config.claudeThinking === "true"} maxTokens={config.claudeMaxTokens} onStreamChange={(value) => updateConfig("claudeStream", String(value))} onThinkingChange={(value) => updateConfig("claudeThinking", String(value))} onMaxTokensChange={(value) => updateConfig("claudeMaxTokens", value)} /> : null}
                        {mode === "agent" ? <div className="mt-3 flex flex-wrap gap-2">{agentTasks.map((item) => <button key={item.id} type="button" aria-pressed={agentTask === item.id} onClick={() => setAgentTask(item.id)} className={cn("min-h-9 rounded-lg border px-3 py-1.5 text-sm transition-colors", agentTask === item.id ? "border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-800 dark:bg-orange-950/30 dark:text-orange-200" : "border-border text-muted-foreground hover:bg-muted")}>{item.label}</button>)}</div> : mode === "create" ? <p className="mt-3 text-sm text-muted-foreground">直接描述即可生图；上传参考图片后，输入想修改的地方。</p> : null}
                    </div>

                    <div ref={scrollRef} onScroll={(event) => { const element = event.currentTarget; followBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-[8%]">
                        {!activeSession?.messages.length ? <div className="wb-empty mx-auto max-w-xl !min-h-0 !py-2">
                            <div className="hidden size-12 place-items-center rounded-2xl bg-muted text-foreground [@media(min-height:850px)]:grid">{mode === "create" ? <ImagePlus className="size-6" /> : <Bot className="size-6" />}</div>
                            <h2 className="mt-2 text-xl font-semibold text-foreground sm:text-2xl">{mode === "agent" ? "把想法，变成一项设计任务" : mode === "create" ? "下一张作品，从一个想法开始" : "从一个问题开始"}</h2>
                            <p>{mode === "agent" ? agent.description : mode === "create" ? "选择图像模型，写下画面；也可以上传已有图片，继续修改。" : "聊聊设计方向，整理提示词，或上传素材一起分析。"}</p>
                            <div className="mt-3 flex flex-wrap justify-center gap-2">{mode === "create" ? <Button className="!h-10" onClick={() => setDraft("为这件服装生成一组高级感棚拍主图")}>试试图片创作</Button> : (mode === "agent" ? agentTasks : agentTasks.slice(0, 2)).map((item) => <Button key={item.id} className="!h-10" onClick={() => { if (mode === "agent") setAgentTask(item.id); setDraft(item.prompt); }}>{item.label}</Button>)}</div>
                        </div> : <div className="mx-auto max-w-3xl space-y-6">{activeSession.messages.map((item) => <ChatBubble key={item.id} message={item} onContinueEditing={continueEditing} />)}{isSending ? <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{mode === "create" ? "正在生成图片…" : "正在思考与整理…"}</div> : null}</div>}
                    </div>

                    <div className="border-t border-border bg-card px-4 py-4 md:px-[8%]">
                        <div className="mx-auto max-w-3xl">
                            <div className="rounded-2xl border border-input bg-background p-3 focus-within:border-orange-400">
                                {attachments.length ? <div className="flex flex-wrap gap-2 pb-3">{attachments.map((item) => <div key={item.id} className="group relative flex h-14 max-w-[180px] items-center gap-2 rounded-xl border border-border bg-card p-1.5">{item.dataUrl ? <img src={item.dataUrl} alt="" className="size-10 rounded-lg object-cover" /> : <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground"><FileText className="size-5" /></span>}<span className="min-w-0 flex-1 truncate text-xs font-medium">{item.name}</span><button type="button" aria-label={"移除 " + item.name} onClick={() => setAttachments((current) => current.filter((attachment) => attachment.id !== item.id))} className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full border border-border bg-card text-muted-foreground hover:text-red-600"><X className="size-3.5" /></button></div>)}</div> : null}
                                {readingAttachments ? <div role="status" className="mb-2 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取附件，请稍候…</div> : null}
                                <textarea aria-label="对话内容" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void send(); } }} placeholder={mode === "create" ? "描述要生成的图片，或写下对参考图片的修改要求…" : mode === "agent" ? agent.prompt + "…" : "输入你的问题，或上传图片、文档一起分析…"} className="min-h-[80px] w-full resize-none bg-transparent px-1 py-1 text-sm leading-7 text-foreground outline-none placeholder:text-muted-foreground" />
                                <div className="flex items-center justify-between gap-3 border-t border-border pt-2">
                                    <div className="flex items-center gap-1">
                                        <Tooltip title="上传图片、PDF、Word、表格或文本"><button type="button" disabled={!sessionsReady || readingAttachments || attachments.length >= 5} onClick={() => openChatAttachmentPicker(fileInputRef.current)} className="grid size-10 place-items-center rounded-xl text-muted-foreground hover:bg-muted disabled:opacity-40" aria-label="上传文件"><Paperclip className="size-5" /></button></Tooltip>
                                        <Tooltip title="上传图片"><button type="button" disabled={!sessionsReady || readingAttachments || attachments.length >= 5} onClick={() => openChatAttachmentPicker(fileInputRef.current, true)} className="grid size-10 place-items-center rounded-xl text-muted-foreground hover:bg-muted disabled:opacity-40" aria-label="上传图片"><ImagePlus className="size-5" /></button></Tooltip>
                                        <span className="hidden text-xs text-muted-foreground sm:inline">图片 / 文档 / 表格 · 最多 5 个</span>
                                    </div>
                                    <Button type="primary" disabled={!sessionsReady || (!draft.trim() && !attachments.length) || isSending || readingAttachments || !selectedModel} loading={isSending} onClick={() => void send()} icon={mode === "create" ? <Sparkles className="size-4" /> : <Send className="size-4" />} className="!h-10 !px-4">{mode === "create" ? (!deploymentFeatures.creditsEnabled ? "生成图片" : "生成图片" + (selected ? " · " + selected.creditCost + "积分" : "")) : "发送"}</Button>
                                </div>
                                <input ref={fileInputRef} type="file" multiple disabled={!sessionsReady || readingAttachments} accept={CHAT_ATTACHMENT_ACCEPT} className="hidden" onChange={(event) => { void addFiles(event.target.files); event.currentTarget.value = ""; }} />
                            </div>
                            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"><CornerDownLeft className="size-3.5" /><span>Ctrl / ⌘ + Enter 发送</span><span className="opacity-45">·</span><span>{mode === "create" ? (!deploymentFeatures.creditsEnabled ? "生成结果会保存在素材库" : "上传与预览不扣费，生成图片才会扣积分") : (!deploymentFeatures.authenticationEnabled ? "免登录创作" : "模型由管理员统一配置")}</span></p>
                        </div>
                    </div>
                </section>
            </div>
        </main>
    );
}

const ChatBubble = memo(function ChatBubble({ message, onContinueEditing }: { message: ChatMessage; onContinueEditing: (image: { id: string; dataUrl: string }) => void }) {
    const isUser = message.role === "user";
    return (
        <div className={cn("flex gap-3", isUser ? "justify-end" : "justify-start")}>
            <div className={cn("grid size-8 shrink-0 place-items-center rounded-xl", isUser ? "order-2 bg-foreground text-background" : message.role === "error" ? "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-300" : "bg-muted text-muted-foreground")}>{isUser ? <span className="text-xs font-semibold">我</span> : message.role === "error" ? <span className="text-xs font-semibold">!</span> : <Bot className="size-4" />}</div>
            <div className={cn("min-w-0 max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-7", isUser ? "order-1 bg-foreground text-background" : message.role === "error" ? "border border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200" : "border border-border bg-card text-foreground")}>
                <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.content}</div>
                {message.generatedImages?.length ? <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">{message.generatedImages.map((item) => <div key={item.id} className="overflow-hidden rounded-xl border border-border bg-muted">
                    <img src={item.dataUrl} alt="生成结果" loading="lazy" decoding="async" className="max-h-80 w-full object-contain" />
                    <div className="flex border-t border-border"><button type="button" onClick={() => onContinueEditing(item)} className="min-h-10 flex-1 px-3 py-2 text-xs font-medium text-foreground hover:bg-card">继续编辑</button><a href={item.dataUrl} download="wireless-canvas.png" className="min-h-10 border-l border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-card">下载</a></div>
                </div>)}</div> : null}
                {message.attachments?.length ? <div className="mt-3 flex flex-wrap gap-2">{message.attachments.map((item) => item.dataUrl ? <img key={item.id} src={item.dataUrl} alt={item.name} loading="lazy" decoding="async" className="max-h-40 rounded-xl border border-border object-contain" /> : <span key={item.id} className={cn("inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs", isUser ? "bg-background/10" : "bg-muted text-muted-foreground")}><FileText className="size-3.5" />{item.name}</span>)}</div> : null}
            </div>
        </div>
    );
});

function ClaudeChatControls({ model, stream, thinking, maxTokens, onStreamChange, onThinkingChange, onMaxTokensChange }: { model: string; stream: boolean; thinking: boolean; maxTokens: string; onStreamChange: (value: boolean) => void; onThinkingChange: (value: boolean) => void; onMaxTokensChange: (value: string) => void }) {
    const alwaysThinking = model.toLowerCase() === "claude-fable-5";
    const channelDefaultThinking = model.toLowerCase() === "claude-fable-5-1";
    return <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Claude 原生参数</span>
        <label className="inline-flex cursor-pointer items-center gap-1.5"><input type="checkbox" checked={stream} onChange={(event) => onStreamChange(event.target.checked)} /> 流式输出</label>
        {channelDefaultThinking ? <span title="OpenToken 文档未指定该模型的思考覆盖参数，使用渠道默认行为。">思考模式 · 渠道默认</span> : alwaysThinking ? <span title="Fable 5 不支持关闭思考，也不支持旧版固定思考预算。">自适应思考 · 始终开启</span> : <label className="inline-flex cursor-pointer items-center gap-1.5"><input type="checkbox" checked={thinking} onChange={(event) => onThinkingChange(event.target.checked)} /> 自适应思考</label>}
        <label className="inline-flex items-center gap-1.5" title="总输出预算包含思考与可见回复；16384 是当前项目限制，不是模型官方最大值。">总输出预算
            <select value={maxTokens} onChange={(event) => onMaxTokensChange(event.target.value)} className="h-8 rounded-lg border border-border bg-card px-2 text-xs text-foreground outline-none">
                {["1024", "2048", "4096", "8192", "16384"].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
        </label>
        <a href={channelDefaultThinking ? "https://docs.opentoken.io/api/claude/messages-api/" : "https://docs.apimart.ai/cn/api-reference/texts/general/claude-messages"} target="_blank" rel="noreferrer" className="underline underline-offset-2">接口说明</a>
        <span className="w-full text-[11px] leading-4">预算包含思考与回复；当前项目上限 16384 tokens。参数不适用于其他模型。</span>
    </div>;
}
