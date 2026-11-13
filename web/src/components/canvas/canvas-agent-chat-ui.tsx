import { useUiText } from "@/lib/i18n";
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { App, Button, Tooltip } from "antd";
import { pastedConversationImageFiles } from "@/lib/conversation-image-clipboard";
import { ArrowUp, Bot, CheckCircle2, CircleAlert, Copy, ImagePlus, LoaderCircle, Pencil, Square, UserRound, WandSparkles, Wrench, X, XCircle } from "lucide-react";
import { ChatMarkdown } from "@/pages/chat/chat-markdown";
import { displayNotice, DisplayText, DisplayTranslationPreview, useDisplayValue  } from "@/hooks/use-display-text";

import { canvasThemes } from "@/lib/canvas-theme";
import { displayModelMetadata, maskImageModelText } from "@/lib/model-display";
import { CanvasPersistedMediaPreview } from "./canvas-persisted-media-preview";
import { ConversationImageActions, conversationImageLabel, type ConversationImageAction, type ConversationImageItem } from "@/components/conversation-image-controls";
import { ConversationImagePreview } from "@/components/conversation-image-preview";
import { useImageMentions } from "@/hooks/use-image-mentions";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { useCanManageConfig } from "@/hooks/use-can-manage-config";
import type { LocalUser } from "@/stores/use-user-store";
import { useCanvasAgentStore } from "@/stores/canvas/use-canvas-agent-store";

export type CanvasAgentChatAttachment = { id: string; name: string; url: string; storageKey?: string; width?: number; height?: number; mediaType?: "image" | "video" };
export type CanvasAgentMode = "online" | "local";
export type CanvasAgentChatImageControl = { image: ConversationImageItem; version?: number; originalDisabledReason?: string; compareDisabledReason?: string; onMask?: () => void };
export type CanvasAgentChatMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    attachments?: CanvasAgentChatAttachment[];
};

const WORKING_TEXT = "处理中…";

export const AgentChatMessage = memo(function AgentChatMessage({ item, theme, user, onRejectTool, onApproveTool, onUseImageForVideo, imageControls, activeImageId, imageActionsDisabled, onImageAction, onMaskImage, onEditMessage, conversationOnlyImages }: { item: CanvasAgentChatMessage; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; user: LocalUser | null; onRejectTool?: (id: string) => void; onApproveTool?: (id: string) => void; onUseImageForVideo?: (attachment: CanvasAgentChatAttachment) => void; imageControls?: ReadonlyMap<string, CanvasAgentChatImageControl>; activeImageId?: string; imageActionsDisabled?: boolean; onImageAction?: (action: ConversationImageAction, imageId: string) => void; onMaskImage?: (imageId: string) => void; onEditMessage?: (id: string) => void; conversationOnlyImages?: boolean }) {
    const t = useUiText();
    const copyFeedback = useCopyFeedback();
    const isUser = item.role === "user";
    const isSystem = item.role === "system";
    const color = item.role === "error" ? theme.node.danger : item.role === "tool" ? theme.canvas.selectionStroke : theme.node.text;
    if (isSystem) {
        return (
            <div className="flex justify-center text-xs">
                <div className="max-w-[88%] px-3 py-2 text-center" style={{ color: theme.node.muted }}>
                    <DisplayText text={item.text} />
                    {item.meta ? <span className="ml-2 opacity-60">{maskImageModelText(item.meta)}</span> : null}
                </div>
            </div>
        );
    }
    if (item.role === "tool") {
        if (["pending", "running"].includes(String(objectField(item.detail, "status")))) return <AgentPendingToolCard summary={item.text} detail={item.detail} theme={theme} onReject={() => onRejectTool?.(item.id)} onApprove={() => onApproveTool?.(item.id)} />;
        return (
            <div className="flex items-start gap-3">
                <AgentAvatar theme={theme} />
                <AgentToolCard title={item.title || t("工具调用")} text={item.text} detail={item.detail} theme={theme} />
            </div>
        );
    }
    return (
        <div data-message-role={item.role} className={`flex min-w-0 items-start gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
            <div className={`min-w-0 text-sm leading-7 [overflow-wrap:anywhere] ${isUser ? "max-w-[88%] rounded-2xl px-3 py-3 text-right" : "w-full text-left"}`} style={{ color, background: isUser ? theme.node.fill : undefined }}>
                <div className="break-words text-left">{isUser ? <div className="whitespace-pre-wrap"><DisplayText text={item.text} /></div> : <ChatMarkdown>{item.text}</ChatMarkdown>}</div>
                {item.attachments?.length ? <AgentMessageAttachments messageId={item.id} attachments={item.attachments} theme={theme} onUseImageForVideo={onUseImageForVideo} imageControls={imageControls} activeImageId={activeImageId} disabled={imageActionsDisabled} onImageAction={onImageAction} onMaskImage={onMaskImage} conversationOnlyImages={conversationOnlyImages} /> : null}
                {item.meta ? <div className="mt-1 text-xs opacity-45">{maskImageModelText(item.meta)}</div> : null}
                <div className="mt-1 flex flex-wrap gap-3 text-xs" style={{ color: theme.node.muted }}>
                    <button type="button" className="inline-flex min-h-7 items-center gap-1 hover:underline" onClick={() => void copyFeedback.copy(item.text)} aria-label={t("复制消息")}>{copyFeedback.copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}<span aria-live="polite">{t(copyFeedback.copied ? "已复制" : "复制")}</span></button>
                    {isUser && onEditMessage ? <button type="button" disabled={imageActionsDisabled} className="inline-flex min-h-7 items-center gap-1 hover:underline disabled:opacity-40" onClick={() => onEditMessage(item.id)}><Pencil size={12} />{t("编辑后重发")}</button> : null}
                </div>
            </div>
            {isUser ? <AgentUserAvatar user={user} theme={theme} /> : null}
        </div>
    );
}, (previous, next) => previous.item === next.item && previous.theme === next.theme && previous.user === next.user
    && previous.onRejectTool === next.onRejectTool && previous.onApproveTool === next.onApproveTool
    && previous.onEditMessage === next.onEditMessage && previous.imageActionsDisabled === next.imageActionsDisabled
    && (!next.item.attachments?.length || (previous.onUseImageForVideo === next.onUseImageForVideo && previous.imageControls === next.imageControls
        && previous.activeImageId === next.activeImageId && previous.onImageAction === next.onImageAction && previous.onMaskImage === next.onMaskImage && previous.conversationOnlyImages === next.conversationOnlyImages)));

export function AgentPendingToolCard({ summary, detail, theme, onReject, onApprove }: { summary: string; detail?: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onReject?: () => void; onApprove?: () => void }) {
    const t = useUiText();
    const showDetails = useToolDetailsEnabled() && Boolean(detail);
    const Container = showDetails ? "details" : "div";
    const Summary = showDetails ? "summary" : "div";
    const running = objectField(detail, "status") === "running";
    const preview = objectField(detail, "preview");
    const previewNodes = (ids: string[]) => useCanvasAgentStore.getState().setAgentState({ previewNodeIds: ids });
    return (
        <div className="flex items-start gap-3">
            <AgentAvatar theme={theme} />
            <div className="min-w-0 flex-1 rounded-xl border p-4" style={{ borderColor: theme.node.stroke, background: "transparent", color: theme.node.text }}>
                <Container>
                    <Summary className={showDetails ? "cursor-pointer list-none" : undefined}>
                        <div className="flex items-start gap-3">
                            <span className="mt-1 grid size-8 shrink-0 place-items-center rounded-lg border" style={{ borderColor: `${theme.node.warning}40`, color: theme.node.warning, background: `${theme.node.warning}0a` }}>
                                {running ? <LoaderCircle className="size-4 animate-spin" /> : <CircleAlert className="size-4" />}
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold leading-5">
                                    <span>{running ? t("工具执行中") : t("确认工具调用")}</span>
                                    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium" style={{ borderColor: `${theme.node.warning}40`, color: theme.node.warning, background: `${theme.node.warning}0a` }}>
                                        {running ? t("执行中") : t("等待确认")}
                                    </span>
                                    {showDetails ? <span className="ml-auto text-xs font-normal" style={{ color: theme.node.muted }}>{t("详情")}</span> : null}
                                </div>
                                <div className="mt-2 text-sm leading-6" style={{ color: theme.node.text }}>
                                    <DisplayText text={summary} />
                                </div>
                                {Array.isArray(preview) ? preview.map((action, index) => <div key={index} className="mt-2 text-xs" style={{ color: action.destructive ? theme.node.danger : theme.node.muted }} onPointerEnter={() => previewNodes(action.nodes?.map((node: { id: string }) => node.id) || [])} onPointerLeave={() => previewNodes([])}>
                                    <div>{action.destructive ? t("将删除 {count} 个对象", { count: action.count }) : action.outputCount ? t("生成 {count} 张 · {model}", { count: action.outputCount, model: maskImageModelText(action.model || t("当前模型")) }) : t("影响 {count} 个对象", { count: action.count })}</div>
                                    {action.nodes?.map((node: { id: string; title: string; url?: string; storageKey?: string }) => <span key={node.id} tabIndex={0} className="mr-2 inline-flex items-center gap-1" onPointerEnter={() => previewNodes([node.id])} onPointerLeave={() => previewNodes([])} onFocus={() => previewNodes([node.id])} onBlur={() => previewNodes([])}>{node.url || node.storageKey ? <CanvasPersistedMediaPreview kind="image" url={node.url} storageKey={node.storageKey} alt="" className="size-8 rounded object-cover" /> : null}<DisplayText text={node.title || t("未命名节点")} /></span>)}
                                    {action.prompt ? <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap">{t("最终提示词：")}<DisplayText text={action.prompt} /></p> : null}
                                </div>) : null}
                            </div>
                        </div>
                    </Summary>
                    {showDetails ? <AgentDetailBlock detail={detail} theme={theme} /> : null}
                </Container>
                {onReject || onApprove ? (
                    <div className="mt-4 grid grid-cols-2 gap-2">
                        <Button danger disabled={running} className="!h-9" icon={<XCircle className="size-4" />} onClick={() => { previewNodes([]); onReject?.(); }}>
                            {t("拒绝执行")}</Button>
                        <Button disabled={running} loading={running} className="!h-9" icon={<CheckCircle2 className="size-4" />} style={{ borderColor: theme.node.success, color: theme.node.success, background: "transparent" }} onClick={() => { previewNodes([]); onApprove?.(); }}>
                            {running ? t("正在执行") : t("批准执行")}
                        </Button>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

export function AgentToolCard({ title, text, detail, theme }: { title: string; text: string; detail?: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const t = useUiText();
    const showDetails = useToolDetailsEnabled() && Boolean(detail);
    const Container = showDetails ? "details" : "div";
    const Summary = showDetails ? "summary" : "div";
    const state = toolCardState(detail, theme);
    return (
        <Container className="min-w-0 flex-1 rounded-xl border px-4 py-4 text-left" style={{ borderColor: theme.node.stroke, background: "transparent", color: theme.node.text }}>
            <Summary className={showDetails ? "cursor-pointer list-none" : undefined}>
                <div className="flex items-start gap-3">
                    <span className="mt-1 grid size-8 shrink-0 place-items-center rounded-lg border" style={{ borderColor: state.softBorder, color: state.color, background: state.softBg }}>
                        {state.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold leading-5">
                            <span className="min-w-0 truncate"><DisplayText text={title} /></span>
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium" style={{ borderColor: state.softBorder, color: state.color, background: state.softBg }}>
                                {t(state.label)}
                            </span>
                            {showDetails ? <span className="ml-auto text-xs font-normal" style={{ color: theme.node.muted }}>{t("详情")}</span> : null}
                        </div>
                        <div className="mt-2 text-sm leading-6" style={{ color: state.isError ? state.color : theme.node.muted }}>
                            <DisplayText text={text} />
                        </div>
                    </div>
                </div>
            </Summary>
            {showDetails ? <AgentDetailBlock detail={detail} theme={theme} /> : null}
        </Container>
    );
}

export function AgentWorkingMessage({ theme }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const t = useUiText();
    const workingText = t(WORKING_TEXT);
    const [length, setLength] = useState(1);
    useEffect(() => {
        const timer = window.setInterval(() => setLength((value) => (value >= workingText.length + 4 ? 1 : value + 1)), 120);
        return () => window.clearInterval(timer);
    }, [setLength, workingText]);
    return (
        <div className="flex items-start gap-3">
            <AgentAvatar theme={theme} />
            <div className="min-w-0 max-w-[82%]">
                <div className="font-mono text-sm" style={{ color: theme.node.muted }} aria-label={t(WORKING_TEXT)}>
                    <span className="inline-block min-w-[76px]">{workingText.slice(0, Math.min(length, workingText.length))}</span>
                </div>
            </div>
        </div>
    );
}

export function AgentChatComposer({
    prompt,
    attachments = [],
    attachmentPreview,
    disabled,
    submitDisabled,
    sending,
    placeholder,
    theme,
    onPromptChange,
    onSubmit,
    onStop,
    onAddFiles,
    onRemoveAttachment,
    left,
    generationControls,
    imageTarget,
    mentionImages = [],
    onMentionImage,
    attachmentAccept = "image/*",
}: {
    prompt: string;
    attachments?: CanvasAgentChatAttachment[];
    attachmentPreview?: ReactNode;
    disabled?: boolean;
    submitDisabled?: boolean;
    sending?: boolean;
    placeholder: string;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onPromptChange: (value: string) => void;
    onSubmit: () => void;
    onStop?: () => void;
    onAddFiles?: (files: FileList | File[] | null) => void | Promise<void>;
    attachmentAccept?: string;
    onRemoveAttachment?: (id: string) => void;
    left?: ReactNode;
    generationControls?: ReactNode;
    imageTarget?: ReactNode;
    mentionImages?: ConversationImageItem[];
    onMentionImage?: (image: ConversationImageItem) => boolean | void | string | Promise<boolean | void | string>;
}) {
    const t = useUiText();
    const { message } = App.useApp();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    useLayoutEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(160, Math.max(56, textarea.scrollHeight))}px`;
    }, [prompt]);
    const canSubmit = !disabled && !submitDisabled && !sending && Boolean(prompt.trim());
    const mentions = useImageMentions({ value: prompt, onChange: onPromptChange, images: mentionImages, onSelect: onMentionImage || (() => false), disabled: disabled || sending || !onMentionImage });
    return (
        <div className="mx-auto w-full min-w-0 max-w-3xl shrink-0 px-3 pb-3 pt-2" onWheelCapture={(event) => event.stopPropagation()}>
            <div className="min-w-0 rounded-3xl border px-3 pb-2 pt-3 shadow-sm focus-within:outline focus-within:outline-1 focus-within:outline-[var(--composer-focus)]" style={{ background: theme.node.panel, borderColor: theme.node.stroke, "--composer-focus": theme.node.muted } as CSSProperties}>
                {imageTarget}
                {attachmentPreview ?? (attachments.length ? (
                    <div className="thin-scrollbar mb-2 flex gap-2 overflow-x-auto pb-1">
                        {attachments.map((item) => (
                            <Tooltip title={item.name} key={item.id}><div className="group relative size-14 shrink-0 overflow-hidden rounded-xl border" style={{ borderColor: theme.node.stroke }}>
                                <img src={item.url} alt={item.name} className="size-full object-cover" />
                                {onRemoveAttachment ? (
                                    <button type="button" className="absolute right-1 top-1 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition group-hover:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }} onClick={() => onRemoveAttachment(item.id)} aria-label={t("移除图片")}>
                                        <X className="size-3" />
                                    </button>
                                ) : null}
                            </div></Tooltip>
                        ))}
                    </div>
                ) : null)}
                <div className="relative">
                {mentions.menu}
                <textarea
                    {...(onMentionImage ? mentions.inputProps : {})}
                    ref={textareaRef}
                    value={prompt}
                    onChange={mentions.handleChange}
                    onSelect={mentions.handleSelect}
                    onPaste={(event) => {
                        const images = pastedConversationImageFiles(event.clipboardData);
                        if (!images) return;
                        void images.catch(() => undefined);
                        event.preventDefault();
                        if (!onAddFiles || sending || disabled) return;
                        void images.then(onAddFiles).catch(error => message.error(displayNotice(error instanceof Error ? t(error.message) : t("图片复制失败，请重试"))));
                    }}
                    onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                        if (mentions.handleKeyDown(event)) return;
                        if (event.key === "Escape" && sending && onStop) { event.preventDefault(); event.stopPropagation(); onStop(); return; }
                        if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
                        event.preventDefault();
                        if (canSubmit && !event.repeat) void onSubmit();
                    }}
                    className="thin-scrollbar block max-h-40 min-h-14 w-full resize-none overflow-y-auto overscroll-contain border-0 bg-transparent px-1 py-1 text-base leading-6 outline-none placeholder:text-[var(--canvas-placeholder)] placeholder:opacity-100"
                    style={{ color: theme.node.text, outline: "none", "--canvas-placeholder": theme.node.placeholder } as CSSProperties}
                    placeholder={placeholder}
                />
                </div>
                <DisplayTranslationPreview text={prompt} />
                {!prompt.trim() && attachments.length ? <p className="px-1 text-xs" style={{ color: theme.node.muted }}>{t("请写下希望如何处理这些图片")}</p> : null}
                <div data-testid="canvas-agent-composer-controls" className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1">
                    {generationControls ? <div data-testid="canvas-agent-generation-slot" className="contents">{generationControls}</div>
                        : <div className="flex min-w-0 flex-wrap items-center gap-1">{left}</div>}
                    <div data-testid="canvas-agent-composer-actions" className={`flex shrink-0 items-center justify-end gap-1${generationControls ? " col-start-2 row-start-2" : ""}`}>
                        {onAddFiles ? (
                            <>
                                <input ref={fileInputRef} hidden type="file" accept={attachmentAccept} multiple onChange={(event) => {
                                    void onAddFiles(event.target.files);
                                    event.target.value = "";
                                }} />
                                <Tooltip title={t(attachmentAccept === "image/*" ? "上传图片" : "上传图片、PDF、Word、表格或文本")}>
                                    <Button type="text" shape="circle" className="!h-11 !w-11 !min-w-11 !p-0" aria-label={t(attachmentAccept === "image/*" ? "添加参考图" : "上传设计文件或参考图")} disabled={sending || disabled} style={{ color: theme.node.muted }} icon={<ImagePlus className="size-5" />} onClick={() => fileInputRef.current?.click()} />
                                </Tooltip>
                            </>
                        ) : null}
                    {sending && onStop ? <Tooltip title={t("停止本地回复和查询；已提交的服务端任务可能继续")}><Button type="text" shape="circle" className="!h-11 !w-11 !min-w-11 !p-0" style={{ background: theme.node.text, color: theme.node.panel }} icon={<Square className="size-4" />} onClick={onStop} aria-label={t("停止本地回复和查询")} /></Tooltip>
                        : <Button type="text" shape="circle" className="!h-11 !w-11 !min-w-11 !p-0" style={{ background: canSubmit ? theme.node.text : theme.node.fill, color: canSubmit ? theme.node.panel : theme.node.faint }} disabled={!canSubmit} icon={sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />} onClick={() => void onSubmit()} aria-label={t("发送")} />}
                    </div>
                    {generationControls && left ? <div className="col-span-2 min-w-0">{left}</div> : null}
                </div>
            </div>
        </div>
    );
}

export function AgentModeSwitch({ value, theme, onChange }: { value: CanvasAgentMode; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (value: CanvasAgentMode) => void }) {
    const t = useUiText();
    return (
        <div className="inline-flex shrink-0 rounded-lg border p-1 text-xs" style={{ borderColor: theme.node.stroke }}>
            {(["online", "local"] as const).map((item) => (
                <button key={item} type="button" className="rounded-md px-2 py-1 transition" style={{ background: value === item ? theme.node.fill : "transparent", color: value === item ? theme.node.text : theme.node.muted }} onClick={() => onChange(item)}>
                    {item === "online" ? t("网站") : t("本机")}
                </button>
            ))}
        </div>
    );
}

export function AgentPanelTabs<T extends string>({ value, items, theme, right, onChange }: { value: T; items: { value: T; label: string; icon?: ReactNode; count?: number }[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; right?: ReactNode; onChange: (value: T) => void }) {
    const t = useUiText();
    return (
        <div className="border-b px-3" style={{ borderColor: theme.node.stroke }}>
            <div className="flex min-h-11 items-center justify-between gap-3">
                <nav className="thin-scrollbar flex min-w-0 flex-1 items-center gap-3 overflow-x-auto text-sm" role="tablist" aria-label={t("Agent 面板")}>
                    {items.map((item) => (
                        <button key={item.value} type="button" role="tab" aria-selected={value === item.value} className={`inline-flex h-11 shrink-0 items-center gap-2 border-b-2 px-1 transition ${value === item.value ? "font-medium" : "font-normal"}`} style={{ borderColor: value === item.value ? theme.node.text : "transparent", color: value === item.value ? theme.node.text : theme.node.muted }} onClick={() => onChange(item.value)}>
                            {item.icon}
                            {t(item.label)}{item.count ? ` ${item.count}` : ""}
                        </button>
                    ))}
                </nav>
                {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
            </div>
        </div>
    );
}

function useToolDetailsEnabled() {
    const canManageConfig = useCanManageConfig();
    const enabled = useCanvasAgentStore(state => state.showToolDetails);
    return canManageConfig && enabled;
}

function AgentDetailBlock({ detail, theme }: { detail: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const display = useDisplayValue();
    return (
        <pre data-testid="canvas-agent-tool-detail" className="thin-scrollbar mt-3 max-h-64 overflow-auto rounded-lg border p-3 text-xs leading-4" style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel, color: theme.node.muted }}>
            {JSON.stringify(display(displayModelMetadata(toolDetailPreview(detail))), null, 2)}
        </pre>
    );
}

// Continuation signatures remain in the original tool call, never in its visual preview.
function toolDetailPreview(detail: unknown): unknown {
    const calls = objectField(detail, "toolCalls");
    if (!Array.isArray(calls)) return stripToolSignatures(detail);
    const settings = objectField(detail, "generationSettings");
    const references = objectField(detail, "referenceImages");
    return calls.map((call) => {
        const fn = objectField(call, "function");
        const name = objectField(fn, "name");
        let args = objectField(fn, "arguments");
        if (typeof args === "string") {
            try { args = JSON.parse(args); } catch { return { tool: name, parameters: "无法解析工具参数" }; }
        }
        const parameters = stripToolSignatures(args) as Record<string, unknown> | undefined;
        if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return { tool: name, parameters };
        const { model, prompt, referenceNodeIds, ...rest } = parameters;
        const mode = name === "canvas_generate_image" ? "image" : name === "canvas_generate_video" ? "video" : parameters.mode;
        const defaults = mode === "image"
            ? { size: objectField(settings, "size"), quality: objectField(settings, "quality"), count: objectField(settings, "imageCount") }
            : mode === "video"
              ? { size: objectField(settings, "size"), seconds: objectField(settings, "videoSeconds"), vquality: objectField(settings, "videoQuality"), generateAudio: objectField(settings, "videoGenerateAudio") }
              : {};
        const selectedReferences = Array.isArray(referenceNodeIds) && referenceNodeIds.length
            ? referenceNodeIds.map((id) => Array.isArray(references) ? references.find((reference) => objectField(reference, "id") === id) || { id } : { id })
            : mode === "image" || mode === "video" ? references : referenceNodeIds;
        return {
            tool: name,
            model: model || (mode === "image" ? objectField(settings, "imageModel") : mode === "video" ? objectField(settings, "videoModel") : undefined),
            prompt,
            references: selectedReferences,
            parameters: { ...defaults, ...rest },
        };
    });
}

function stripToolSignatures(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripToolSignatures);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "thoughtSignature" && key !== "thought_signature").map(([key, item]) => [key, stripToolSignatures(item)]));
}

function AgentAvatar({ theme }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const t = useUiText();
    return (
        <span className="grid size-8 shrink-0 place-items-center" role="img" aria-label={t("画布助手")}>
            <Bot className="size-5 opacity-80" style={{ color: theme.node.text }} />
        </span>
    );
}

function AgentUserAvatar({ user, theme }: { user: LocalUser | null; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const t = useUiText();
    const avatarUrl = user?.avatarUrl?.trim();
    return (
        <span className="mt-2 grid size-6 shrink-0 place-items-center overflow-hidden rounded-full" style={{ color: theme.node.text }}>
            {avatarUrl ? <img src={avatarUrl} alt="" className="size-full object-cover" referrerPolicy="no-referrer" /> : <UserRound className="size-4" />}
        </span>
    );
}

function AgentMessageAttachments({ messageId, attachments, theme, onUseImageForVideo, imageControls, activeImageId, disabled, onImageAction, onMaskImage, conversationOnlyImages }: { messageId: string; attachments: CanvasAgentChatAttachment[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onUseImageForVideo?: (attachment: CanvasAgentChatAttachment) => void; imageControls?: ReadonlyMap<string, CanvasAgentChatImageControl>; activeImageId?: string; disabled?: boolean; onImageAction?: (action: ConversationImageAction, imageId: string) => void; onMaskImage?: (imageId: string) => void; conversationOnlyImages?: boolean }) {
    const t = useUiText();
    const [previewImage, setPreviewImage] = useState<ConversationImageItem | null>(null);
    return (
        <div className="mt-3 grid min-w-0 max-w-[36rem] gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))" }}>
            {attachments.map((item) => {
                const control = imageControls?.get(`${messageId}:${item.id}`);
                const selected = !conversationOnlyImages && Boolean(control && control.image.id === activeImageId);
                const version = !conversationOnlyImages && control?.version && Number.isInteger(control.version) && control.version > 0 ? control.version : undefined;
                const preview = (
                    <CanvasPersistedMediaPreview
                        kind={item.mediaType === "video" ? "video" : "image"}
                        url={item.url}
                        storageKey={item.storageKey}
                        width={item.width}
                        height={item.height}
                        alt={item.name}
                        controls={item.mediaType === "video"}
                        className={item.mediaType === "video" ? "aspect-video w-full bg-black object-contain" : "aspect-[4/3] max-h-96 w-full object-contain"}
                    />
                );
                const videoAction = item.mediaType !== "video" && onUseImageForVideo ? (
                        <button type="button" disabled={disabled} className="inline-flex min-h-9 items-center justify-center gap-2 px-2 py-2 text-xs font-medium transition hover:opacity-70 disabled:opacity-35" onClick={() => onUseImageForVideo(item)}>
                            <WandSparkles className="size-3.5" />
                            {t("选此图生成视频")}</button>) : null;
                return <div key={item.id} data-testid="canvas-agent-image-result" data-image-id={control?.image.id} className="group/result relative min-w-0 overflow-hidden rounded-2xl" style={{ outline: selected ? `1px solid ${theme.node.activeStroke}` : undefined }}>
                    {item.mediaType !== "video" ? <button type="button" disabled={Boolean(control?.image.unavailableReason) || (!item.url && !item.storageKey)} onClick={() => setPreviewImage(control?.image || { id: item.id, label: item.name, name: item.name, dataUrl: item.url, storageKey: item.storageKey })} aria-haspopup="dialog" aria-label={`${t("查看大图")} · ${conversationImageLabel(control?.image.label || item.name)}`} className="relative block w-full overflow-hidden rounded-2xl cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-[-2px]" style={{ outlineColor: theme.canvas.selectionStroke, background: theme.node.fill }}>
                        {preview}{control ? <span className="pointer-events-none absolute left-2 top-2 rounded px-2 py-1 text-xs" style={{ color: theme.node.text, background: theme.node.panel }}>{conversationImageLabel(control.image.label)}{version ? ` · V${version}` : ""}</span> : null}
                        {selected ? <span data-testid="canvas-agent-image-current" className="pointer-events-none absolute right-2 top-2 rounded px-2 py-1 text-xs font-medium" style={{ color: theme.node.panel, background: theme.canvas.selectionStroke }}>{t("当前")}</span> : null}
                    </button> : preview}
                    {control && onImageAction ? <div data-testid="canvas-agent-image-actions" className="mt-1 min-h-9 transition-opacity group-hover/result:pointer-events-auto group-hover/result:opacity-100 group-focus-within/result:pointer-events-auto group-focus-within/result:opacity-100 [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:opacity-0 motion-reduce:transition-none">
                        {conversationOnlyImages ? <div className="flex flex-wrap items-center gap-2 rounded px-2" style={{ color: theme.node.text, background: theme.node.panel }}>
                            <button type="button" disabled={disabled || Boolean(control.image.unavailableReason)} className="min-h-9 text-xs hover:underline disabled:opacity-35" onClick={() => onImageAction("copy", control.image.id)}>{t("复制图片")}</button>
                            <button type="button" disabled={disabled || Boolean(control.image.unavailableReason)} className="min-h-9 text-xs hover:underline disabled:opacity-35" onClick={() => onImageAction("download", control.image.id)}>{t("下载")}</button>
                            {onMaskImage ? <button type="button" disabled={disabled || Boolean(control.image.unavailableReason)} className="min-h-9 text-xs hover:underline disabled:opacity-35" onClick={() => onMaskImage(control.image.id)}>{t("圈选修改")}</button> : null}
                            {videoAction}
                        </div> : <ConversationImageActions {...control} compact disabled={disabled} onAction={onImageAction} onMask={control.onMask || (onMaskImage ? () => onMaskImage(control.image.id) : undefined)} extra={videoAction} />}
                    </div> : videoAction}
                    {control && onMaskImage ? <p className="px-2 text-xs leading-5" style={{ color: theme.node.muted }}>{t("只改局部时，先涂选；选区外保留原图")}</p> : null}
                </div>
            })}
            {previewImage ? <ConversationImagePreview key={previewImage.id} image={previewImage} onClose={() => setPreviewImage(null)} /> : null}
        </div>
    );
}

function toolCardState(detail: unknown, theme: (typeof canvasThemes)[keyof typeof canvasThemes]) {
    const status = objectField(detail, "status");
    const colors = (color: string) => ({ color, softBorder: `${color}38`, softBg: `${color}0a` });
    if (status === "noop" || status === "expired") return { label: status === "expired" ? "确认已过期" : "未生效", ...colors(theme.node.warning), icon: <CircleAlert className="size-4" />, isError: false };
    if (status === "rejected" || status === "cancelled") return { label: "已取消", ...colors(theme.node.danger), icon: <XCircle className="size-4" />, isError: true };
    if (status === "failed" || status === "error") return { label: "执行失败", ...colors(theme.node.danger), icon: <XCircle className="size-4" />, isError: true };
    if (status === "completed" || status === "succeeded") return { label: "执行完成", ...colors(theme.node.success), icon: <CheckCircle2 className="size-4" />, isError: false };
    return { label: "工具调用", ...colors(theme.canvas.selectionStroke), icon: <Wrench className="size-4" />, isError: false };
}

function normalizeText(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (value instanceof Error) return value.message;
    if (value == null) return "";
    return JSON.stringify(value, null, 2);
}

function objectField(value: unknown, key: string) {
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}
