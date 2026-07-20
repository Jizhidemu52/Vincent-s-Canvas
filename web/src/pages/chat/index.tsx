import { App, Button, Tooltip } from "antd";
import { Bot, CheckCircle2, ChevronDown, CornerDownLeft, FileText, ImagePlus, MessageSquarePlus, Paperclip, PanelLeftClose, PanelLeftOpen, Send, Sparkles, Trash2, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { requestEdit, requestGeneration, requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

type ChatModel = { modelId: string; name: string; creditCost: number; capabilities: string[] };
type ChatAttachment = { id: string; name: string; mimeType: string; size: number; dataUrl?: string; textContent?: string };
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
    return { id: crypto.randomUUID(), title: "新对话", mode, messages: [], updatedAt: new Date().toISOString() };
}

function sessionTitle(session: ChatSession) {
    const first = session.messages.find((item) => item.role === "user")?.content.trim();
    return first ? first.slice(0, 18) : session.title || "新对话";
}

function readSessions(key: string) {
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || "[]") as ChatSession[];
        return Array.isArray(parsed) && parsed.length ? parsed : [createSession()];
    } catch {
        return [createSession()];
    }
}

function readFileAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
    });
}

function readFileAsText(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(file);
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
    const { message } = App.useApp();
    const user = useUserStore((state) => state.user);
    const config = useEffectiveConfig();
    const storageKey = `${storagePrefix}${user?.id || "anonymous"}`;
    const [models, setModels] = useState<ChatModel[]>([]);
    const [selectedModel, setSelectedModel] = useState("");
    const [mode, setMode] = useState<ChatMode>("chat");
    const [agentTask, setAgentTask] = useState<AgentTask>("brief");
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [sessions, setSessions] = useState<ChatSession[]>([createSession()]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
    const [isSending, setIsSending] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setSessions(readSessions(storageKey));
    }, [storageKey]);

    useEffect(() => {
        const active = sessions.find((item) => item.id === activeSessionId);
        if (!active) setActiveSessionId(sessions[0]?.id || null);
        localStorage.setItem(storageKey, JSON.stringify(sessions.map((session) => ({
            ...session,
            messages: session.messages.map((item) => ({ ...item, attachments: item.attachments?.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })) })),
        }))));
    }, [activeSessionId, sessions, storageKey]);

    useEffect(() => {
        fetch("/api/models", { credentials: "include" })
            .then((response) => response.ok ? response.json() : Promise.reject(new Error("无法加载对话模型")))
            .then((data: { models: ChatModel[] }) => {
                const available = data.models.filter((item) => item.capabilities.includes("chat"));
                setModels(data.models);
                setSelectedModel((current) => current && available.some((item) => item.modelId === current) ? current : available[0]?.modelId || "");
            })
            .catch(() => setModels([]));
    }, []);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }, [sessions, activeSessionId, isSending]);

    const activeSession = useMemo(() => sessions.find((item) => item.id === activeSessionId) || sessions[0], [activeSessionId, sessions]);
    const chatModels = useMemo(() => models.filter((item) => item.capabilities.includes("chat")), [models]);
    // Demo-only models are useful in their dedicated workbenches, but the chat
    // creation mode submits real provider tasks and must never select one first.
    const imageModels = useMemo(() => models.filter((item) => !item.modelId.startsWith("demo-") && item.capabilities.some((capability) => ["generate", "edit"].includes(capability))), [models]);
    const availableModels = mode === "create" ? imageModels : chatModels;
    const selected = availableModels.find((item) => item.modelId === selectedModel);
    const agent = agentTasks.find((item) => item.id === agentTask)!;

    const updateSession = (id: string, update: (session: ChatSession) => ChatSession) => {
        setSessions((current) => current.map((session) => session.id === id ? update(session) : session));
    };

    const startSession = (nextMode: ChatMode = mode) => {
        const session = createSession(nextMode);
        setSessions((current) => [session, ...current]);
        setActiveSessionId(session.id);
        setMode(nextMode);
        setDraft("");
        setAttachments([]);
    };

    const switchMode = (nextMode: ChatMode) => {
        setMode(nextMode);
        const available = nextMode === "create" ? imageModels : chatModels;
        setSelectedModel((current) => available.some((item) => item.modelId === current) ? current : available[0]?.modelId || "");
    };

    const removeSession = (id: string) => {
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
        if ((!text && !attachments.length) || isSending || !activeSession) return;
        if (!selectedModel || !selected) {
            message.warning(mode === "create" ? "管理员尚未启用可用的图像生成模型" : "管理员尚未启用可用的对话模型");
            return;
        }

        if (mode === "create" && !text) {
            message.warning("请输入图片生成或编辑要求");
            return;
        }

        const sessionId = activeSession.id;
        const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text || "请分析我上传的内容。", attachments, createdAt: new Date().toISOString() };
        const assistantId = crypto.randomUUID();
        const taskInstruction = mode === "agent" ? `${agent.prompt}\n\n请使用清晰标题、短列表和具体可执行建议。` : "";
        const history: AiTextMessage[] = activeSession.messages
            .filter((item): item is ChatMessage & { role: "user" | "assistant" } => item.role === "user" || item.role === "assistant")
            .map((item) => ({ role: item.role, content: messageContent(item) }));

        updateSession(sessionId, (session) => ({ ...session, mode, title: session.messages.length ? session.title : text.slice(0, 18), messages: [...session.messages, userMessage], updatedAt: new Date().toISOString() }));
        setDraft("");
        setAttachments([]);
        setIsSending(true);
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
                [...history, { role: "user", content: messageContent(userMessage) }],
                () => undefined,
            );
            updateSession(sessionId, (session) => ({
                ...session,
                messages: [...session.messages, { id: assistantId, role: "assistant", content: response || "模型没有返回内容。", createdAt: new Date().toISOString() }],
                updatedAt: new Date().toISOString(),
            }));
        } catch (error) {
            updateSession(sessionId, (session) => ({
                ...session,
                messages: [...session.messages, { id: assistantId, role: "error", content: error instanceof Error ? error.message : "对话请求失败", createdAt: new Date().toISOString() }],
                updatedAt: new Date().toISOString(),
            }));
        } finally {
            setIsSending(false);
        }
    };

    const addFiles = async (files: FileList | null) => {
        if (!files?.length) return;
        const candidates = Array.from(files).slice(0, Math.max(0, 5 - attachments.length));
        const next: ChatAttachment[] = [];
        let totalBytes = attachments.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
        for (const file of candidates) {
            if (file.size > 5 * 1024 * 1024) {
                message.warning(`${file.name} 超过 5MB，未添加`);
                continue;
            }
            try {
                if (file.type.startsWith("image/")) {
                    const dataUrl = await compressChatImage(file);
                    const size = dataUrlBytes(dataUrl);
                    if (totalBytes + size > 8 * 1024 * 1024) {
                        message.warning("本次对话附件总大小不能超过 8MB");
                        break;
                    }
                    next.push({ id: crypto.randomUUID(), name: file.name, mimeType: "image/jpeg", size, dataUrl });
                    totalBytes += size;
                } else if (file.type.startsWith("text/") || /\.(md|csv|json)$/i.test(file.name)) {
                    if (totalBytes + file.size > 8 * 1024 * 1024) {
                        message.warning("本次对话附件总大小不能超过 8MB");
                        break;
                    }
                    next.push({ id: crypto.randomUUID(), name: file.name, mimeType: file.type || "text/plain", size: file.size, textContent: await readFileAsText(file) });
                    totalBytes += file.size;
                } else message.warning(`${file.name} 暂仅支持图片、TXT、MD、CSV 或 JSON 文件`);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "文件读取失败");
            }
        }
        if (next.length) setAttachments((current) => [...current, ...next].slice(0, 5));
    };

    return (
        <main className="h-full bg-[#f4f3ef] p-3 md:p-5">
            <div className="mx-auto flex h-full max-w-[1540px] overflow-hidden rounded-lg border border-orange-100 bg-[#fffdf8] shadow-[0_18px_50px_rgba(76,38,10,0.08)]">
                <aside className={cn("flex shrink-0 flex-col border-r border-orange-100 bg-[#fbf8f1] transition-[width] duration-200", sidebarOpen ? "w-[260px]" : "w-0 overflow-hidden border-r-0") }>
                    <div className="flex items-center justify-between px-4 py-4">
                        <div className="flex items-center gap-2 text-sm font-bold text-stone-900"><Bot className="size-4 text-orange-600" /> 对话记录</div>
                        <Tooltip title="新建对话"><button type="button" onClick={() => startSession()} className="grid size-8 place-items-center rounded-md border border-orange-200 bg-white text-orange-700 hover:bg-orange-50"><MessageSquarePlus className="size-4" /></button></Tooltip>
                    </div>
                    <div className="px-3"><Button block icon={<Sparkles className="size-4" />} onClick={() => startSession("agent")} className="!h-10 !border-0 !bg-orange-600 !font-semibold !text-white hover:!bg-orange-700">新建 Agent 任务</Button></div>
                    <div className="mt-5 min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3">
                        {sessions.map((session) => <button key={session.id} type="button" onClick={() => { setActiveSessionId(session.id); setMode(session.mode); }} className={cn("group flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left transition", session.id === activeSession?.id ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-white")}>
                            <span className={cn("grid size-7 shrink-0 place-items-center rounded-md", session.id === activeSession?.id ? "bg-white/10" : "bg-orange-50 text-orange-600")}>{session.mode === "agent" ? <WandSparkles className="size-3.5" /> : <Bot className="size-3.5" />}</span>
                            <span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold">{sessionTitle(session)}</span><span className={cn("mt-0.5 block text-[11px]", session.id === activeSession?.id ? "text-stone-300" : "text-stone-400")}>{session.mode === "agent" ? "Agent 任务" : "聊天"} · {new Date(session.updatedAt).toLocaleDateString()}</span></span>
                            <span onClick={(event) => { event.stopPropagation(); removeSession(session.id); }} className={cn("grid size-6 place-items-center rounded opacity-0 transition group-hover:opacity-100", session.id === activeSession?.id ? "hover:bg-white/10" : "hover:bg-orange-50")} aria-label="删除会话"><Trash2 className="size-3.5" /></span>
                        </button>)}
                    </div>
                    <div className="border-t border-orange-100 px-4 py-3 text-[11px] leading-5 text-stone-400">会话仅保存在当前浏览器；模型和密钥始终由服务端管理。</div>
                </aside>

                <section className="flex min-w-0 flex-1 flex-col">
                    <header className="flex min-h-16 items-center gap-3 border-b border-orange-100 px-4 md:px-6">
                        <Tooltip title={sidebarOpen ? "收起会话" : "展开会话"}><button type="button" onClick={() => setSidebarOpen((value) => !value)} className="grid size-8 place-items-center rounded-md text-stone-500 hover:bg-orange-50 hover:text-orange-700">{sidebarOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}</button></Tooltip>
                        <div className="min-w-0 flex-1"><h1 className="text-sm font-bold text-stone-900">LLM 对话</h1><p className="mt-0.5 truncate text-[11px] text-stone-400">{mode === "agent" ? `Agent · ${agent.description}` : mode === "create" ? "调用图像模型 · 生成与改图" : "一问一答 · 设计思路与提示词协作"}</p></div>
                        <div className="hidden items-center gap-2 sm:flex"><span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700"><CheckCircle2 className="size-3.5" /> 服务端已连接</span><div className="relative"><select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} className="h-8 max-w-[220px] appearance-none rounded-md border border-orange-200 bg-white py-0 pl-3 pr-8 text-xs font-semibold text-stone-700 outline-none focus:border-orange-500"><option value="">选择模型</option>{availableModels.map((item) => <option key={item.modelId} value={item.modelId}>{item.name}</option>)}</select><ChevronDown className="pointer-events-none absolute right-2 top-2 size-3.5 text-stone-400" /></div></div>
                    </header>

                    <div className="border-b border-orange-100 px-4 py-3 md:px-6"><div className="inline-flex rounded-md bg-orange-50 p-1"><button type="button" onClick={() => switchMode("chat")} className={cn("flex h-8 items-center gap-2 rounded px-3 text-xs font-bold transition", mode === "chat" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-800")}><Bot className="size-3.5" /> 聊天</button><button type="button" onClick={() => switchMode("create")} className={cn("flex h-8 items-center gap-2 rounded px-3 text-xs font-bold transition", mode === "create" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-800")}><ImagePlus className="size-3.5" /> 创作</button><button type="button" onClick={() => switchMode("agent")} className={cn("flex h-8 items-center gap-2 rounded px-3 text-xs font-bold transition", mode === "agent" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-800")}><WandSparkles className="size-3.5" /> Agent</button></div>{mode === "agent" ? <div className="mt-3 flex flex-wrap gap-2">{agentTasks.map((item) => <button key={item.id} type="button" onClick={() => setAgentTask(item.id)} className={cn("rounded-full border px-3 py-1.5 text-xs font-semibold transition", agentTask === item.id ? "border-orange-500 bg-orange-600 text-white" : "border-orange-200 bg-white text-stone-600 hover:border-orange-400")}>{item.label}</button>)}</div> : mode === "create" ? <p className="mt-3 text-xs text-stone-500">不上传图片时为文生图；上传图片后为图片编辑。生成会按后台价格扣除积分，并进入历史与素材库。</p> : null}</div>

                    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-8 md:px-[10%]">
                        {!activeSession?.messages.length ? <div className="mx-auto flex max-w-xl flex-col items-center pt-[10vh] text-center"><div className="grid size-12 place-items-center rounded-lg bg-orange-600 text-white shadow-lg shadow-orange-200">{mode === "create" ? <ImagePlus className="size-6" /> : <Bot className="size-6" />}</div><h2 className="mt-5 text-2xl font-bold text-stone-900">{mode === "agent" ? "开始一项设计任务" : mode === "create" ? "描述你要生成的图片" : "从一个问题开始"}</h2><p className="mt-2 max-w-md text-sm leading-6 text-stone-500">{mode === "agent" ? agent.description : mode === "create" ? "选择后台启用的图像模型；上传图片可直接进行 AI 改图。" : "向已启用的 LLM 询问设计方向、提示词、项目拆解或素材分析。"}</p><div className="mt-6 flex flex-wrap justify-center gap-2">{mode === "create" ? <button type="button" onClick={() => setDraft("为这件服装生成一组高级感棚拍主图") } className="rounded-md border border-orange-200 bg-white px-3 py-2 text-xs font-semibold text-stone-600 hover:border-orange-400 hover:text-orange-700">试试图片创作</button> : (mode === "agent" ? agentTasks : agentTasks.slice(0, 2)).map((item) => <button key={item.id} type="button" onClick={() => { if (mode === "agent") setAgentTask(item.id); setDraft(item.prompt); }} className="rounded-md border border-orange-200 bg-white px-3 py-2 text-xs font-semibold text-stone-600 hover:border-orange-400 hover:text-orange-700">{item.label}</button>)}</div></div> : <div className="mx-auto max-w-3xl space-y-6">{activeSession.messages.map((item) => <ChatBubble key={item.id} message={item} />)}{isSending ? <div className="flex items-center gap-2 text-sm text-stone-400"><span className="size-4 animate-spin rounded-full border-2 border-orange-200 border-t-orange-600" /> {mode === "create" ? "正在生成图片…" : "正在思考…"}</div> : null}</div>}
                    </div>

                    <div className="border-t border-orange-100 bg-[#fffdf8] px-4 py-4 md:px-[10%]"><div className="mx-auto max-w-3xl"><div className="rounded-lg border border-orange-200 bg-white p-2 shadow-sm focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-100">{attachments.length ? <div className="flex flex-wrap gap-2 px-1 pb-2">{attachments.map((item) => <div key={item.id} className="group relative flex h-14 max-w-[170px] items-center gap-2 rounded-md border border-orange-100 bg-orange-50/60 p-1.5">{item.dataUrl ? <img src={item.dataUrl} alt="" className="size-10 rounded object-cover" /> : <span className="grid size-10 place-items-center rounded bg-white text-orange-600"><FileText className="size-4" /></span>}<span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-stone-600">{item.name}</span><button type="button" aria-label={`移除 ${item.name}`} onClick={() => setAttachments((current) => current.filter((attachment) => attachment.id !== item.id))} className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-orange-200 bg-white text-stone-500 shadow-sm hover:text-red-600"><X className="size-3" /></button></div>)}</div> : null}<textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void send(); } }} placeholder={mode === "create" ? "描述要生成的图片；上传图片后可直接写改图要求…" : mode === "agent" ? `${agent.prompt}…` : "输入你的问题，或上传图片/文本文件…"} className="min-h-[78px] w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 text-stone-800 outline-none placeholder:text-stone-400" /><div className="flex items-center justify-between gap-3 border-t border-stone-100 px-1 pt-2"><div className="flex items-center gap-1"><Tooltip title="上传图片或文本文件"><button type="button" onClick={() => fileInputRef.current?.click()} className="grid size-8 place-items-center rounded-md text-stone-500 hover:bg-orange-50 hover:text-orange-700" aria-label="上传文件"><Paperclip className="size-4" /></button></Tooltip><Tooltip title="上传图片"><button type="button" onClick={() => { if (fileInputRef.current) { fileInputRef.current.accept = "image/*"; fileInputRef.current.click(); } }} className="grid size-8 place-items-center rounded-md text-stone-500 hover:bg-orange-50 hover:text-orange-700" aria-label="上传图片"><ImagePlus className="size-4" /></button></Tooltip><span className="hidden text-[11px] text-stone-400 sm:inline">图片 / 文本文件 · 最多 5 个</span></div><Button type="primary" disabled={(!draft.trim() && !attachments.length) || isSending || !selectedModel} loading={isSending} onClick={() => void send()} icon={mode === "create" ? <Sparkles className="size-3.5" /> : <Send className="size-3.5" />} className="!h-8 !border-0 !bg-orange-600 !px-3 !text-xs !font-bold hover:!bg-orange-700">{mode === "create" ? `生成图片${selected ? ` · ${selected.creditCost}积分` : ""}` : "发送"}</Button></div><input ref={fileInputRef} type="file" multiple accept="image/*,.txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json" className="hidden" onChange={(event) => { void addFiles(event.target.files); event.currentTarget.value = ""; }} /></div><p className="mt-2 flex items-center gap-1.5 text-[11px] text-stone-400"><CornerDownLeft className="size-3" /> {mode === "create" ? "调用图像模型才会扣积分；上传、预览和输入提示词不扣费。" : "模型和权限由管理员后台统一配置。"}</p></div></div>
                </section>
            </div>
        </main>
    );
}

function messageContent(message: ChatMessage): AiTextMessage["content"] {
    const textFiles = message.attachments?.filter((item) => item.textContent).map((item) => `\n\n[附件：${item.name}]\n${item.textContent}`).join("") || "";
    const text = `${message.content}${textFiles}`;
    const images = message.attachments?.filter((item) => item.dataUrl).map((item) => ({ type: "image_url" as const, image_url: { url: item.dataUrl! } })) || [];
    return images.length ? [{ type: "text" as const, text }, ...images] : text;
}

function ChatBubble({ message }: { message: ChatMessage }) {
    const isUser = message.role === "user";
    return <div className={cn("flex gap-3", isUser ? "justify-end" : "justify-start")}><div className={cn("grid size-8 shrink-0 place-items-center rounded-md", isUser ? "order-2 bg-stone-900 text-white" : message.role === "error" ? "bg-red-50 text-red-600" : "bg-orange-100 text-orange-700")}>{isUser ? <span className="text-xs font-bold">我</span> : message.role === "error" ? <span className="text-xs font-bold">!</span> : <Bot className="size-4" />}</div><div className={cn("max-w-[86%] rounded-lg px-4 py-3 text-sm leading-7", isUser ? "order-1 bg-stone-900 text-white" : message.role === "error" ? "border border-red-100 bg-red-50 text-red-700" : "border border-orange-100 bg-white text-stone-700 shadow-sm")}><div className="whitespace-pre-wrap">{message.content}</div>{message.generatedImages?.length ? <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">{message.generatedImages.map((item) => <a key={item.id} href={item.dataUrl} download="wireless-canvas.png" className="block overflow-hidden rounded-md border border-orange-100 bg-orange-50/30"><img src={item.dataUrl} alt="生成结果" className="aspect-square w-full object-cover" /><span className="block border-t border-orange-100 px-2 py-1 text-[11px] font-semibold text-orange-700">点击下载原图</span></a>)}</div> : null}{message.attachments?.length ? <div className="mt-3 flex flex-wrap gap-2">{message.attachments.map((item) => item.dataUrl ? <img key={item.id} src={item.dataUrl} alt={item.name} className="max-h-40 rounded-md border border-white/20 object-cover" /> : <span key={item.id} className={cn("inline-flex items-center gap-1 rounded px-2 py-1 text-xs", isUser ? "bg-white/10" : "bg-orange-50 text-orange-700")}><FileText className="size-3.5" />{item.name}</span>)}</div> : null}</div></div>;
}
