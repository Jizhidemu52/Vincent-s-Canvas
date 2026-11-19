import { useRef, useState } from "react";
import { ArrowDownToLine, Check, ChevronDown, ImagePlus, LoaderCircle, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, RefreshCw, Send, Square, X } from "lucide-react";
import type { PublicImageTurn as ImageTurn, PublicImageVersion as ImageVersion } from "../../../shared/image-conversation-public";
import { cn } from "@/lib/utils";
import { handleSubmitShortcut } from "@/lib/submit-shortcut";
import { useUserStore } from "@/stores/use-user-store";
import { useChatBottomFollow } from "@/hooks/use-chat-bottom-follow";
import { ChatMarkdown } from "@/pages/chat/chat-markdown";
import { conversationTurnStatus } from "./image-conversation-state";
import { useImageConversation, type ImageConversationOptions } from "./use-image-conversation";

export type ImageConversationPanelProps = ImageConversationOptions & { className?: string };
const assetUrl = (id: string) => `/api/assets/${encodeURIComponent(id)}/content`;
const control = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40";

export function ImageConversationPanel(props: ImageConversationPanelProps) {
    const ownerId = useUserStore(state => state.user?.id);
    if (!ownerId) return <div role="status" className="p-6">请登录后读取服务端会话。</div>;
    return <OwnedImageConversationPanel key={`${ownerId}:${props.entrypoint}:${props.canvasExternalId || "standalone"}`} {...props} ownerId={ownerId} />;
}

function VersionImage({ version, active, onRestore, disabled }: { version: ImageVersion; active: boolean; onRestore?: () => void; disabled: boolean }) {
    return <figure data-version-id={version.id} className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
        <a href={assetUrl(version.assetId)} target="_blank" rel="noreferrer" aria-label={`查看图${version.imageNo}原图`}><img src={assetUrl(version.assetId)} alt={`图${version.imageNo} · ${version.label}`} loading="lazy" className="max-h-80 w-full bg-muted/30 object-contain" /></a>
        <figcaption className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs text-muted-foreground">
            <span className="min-w-0 break-words">图{version.imageNo} · {version.label}{version.actualDimensions ? ` · ${version.actualDimensions.width} × ${version.actualDimensions.height}` : ""}{active ? <span className="ml-2 inline-flex items-center gap-1 text-foreground"><Check className="size-3" />当前图</span> : null}</span>
            <span className="flex gap-3"><a href={assetUrl(version.assetId)} download={`image-${version.imageNo}`} className="inline-flex items-center gap-1 hover:text-foreground"><ArrowDownToLine className="size-3.5" />原图</a>{onRestore && !active ? <button type="button" disabled={disabled} onClick={onRestore} className="hover:text-foreground disabled:opacity-40">恢复到此图</button> : null}</span>
        </figcaption>
    </figure>;
}

function TurnStatus({ turn }: { turn: ImageTurn }) {
    return <div data-turn-id={turn.id} data-turn-state={turn.state} className="space-y-1 text-xs leading-5 text-muted-foreground">
        <p>{conversationTurnStatus(turn)}</p>
        {turn.lastError ? <p className="break-words text-red-600 dark:text-red-400">{turn.lastError.message}</p> : null}
        {turn.taskId ? <details><summary className="cursor-pointer">原任务记录</summary><p className="break-all">{turn.taskId}</p></details> : null}
        {turn.settingsSnapshot ? <details><summary className="cursor-pointer">服务端自动参数</summary><p>画质 {turn.settingsSnapshot.effective.quality} · {turn.settingsSnapshot.effective.resolution?.toUpperCase() || "精确像素"} · {turn.settingsSnapshot.effective.size || "保留参考图比例"} · {turn.settingsSnapshot.effective.output_format.toUpperCase()}</p><p>实际结果：{turn.settingsSnapshot.actual ? `${turn.settingsSnapshot.actual.dimensions.width} × ${turn.settingsSnapshot.actual.dimensions.height}` : "尚无实际图片回执"}</p></details> : null}
    </div>;
}

function OwnedImageConversationPanel({ ownerId, className, ...options }: ImageConversationPanelProps & { ownerId: string }) {
    const state = useImageConversation(ownerId, options);
    const [sidebar, setSidebar] = useState(() => options.entrypoint === "standalone" && typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches);
    const [versionsOpen, setVersionsOpen] = useState(false);
    const files = useRef<HTMLInputElement>(null);
    const pending = state.view?.snapshot.pendingTurn;
    const blocked = !state.ready || state.busy || Boolean(state.receipt || state.createReceipt || pending) || Boolean(state.id && !state.view);
    const canSend = !blocked && state.draft.text.trim().length > 0 && state.draft.text.length <= 10000;
    const versions = state.view?.versions || [], messages = state.view?.messages || [];
    const follow = useChatBottomFollow(state.view?.messages, state.id || undefined);
    const attachmentVersions = new Set(messages.flatMap(message => message.attachments));
    const uploadVersions = versions.filter(version => version.source === "upload" && !attachmentVersions.has(version.id));
    return <section data-testid="server-image-conversation" className={cn("relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background text-foreground", className)}>
        {sidebar ? <aside aria-label="服务端会话记录" className="absolute inset-y-0 left-0 z-20 flex w-[min(280px,85%)] shrink-0 flex-col border-r border-border bg-background p-3 shadow-lg md:static md:w-60 md:shadow-none">
            <div className="mb-3 flex items-center justify-between"><strong className="text-sm">服务端会话</strong><button type="button" aria-label="收起会话" onClick={() => setSidebar(false)} className="grid size-9 place-items-center rounded-lg hover:bg-muted"><PanelLeftClose className="size-4" /></button></div>
            <button type="button" className={control} disabled={!state.ready || state.busy || Boolean(state.receipt || state.createReceipt)} onClick={() => { state.select(null); if (window.innerWidth < 768) setSidebar(false); }}><MessageSquarePlus className="size-4" />新会话</button>
            <nav className="mt-3 flex-1 space-y-1 overflow-y-auto" aria-label="会话列表">{state.conversations.map(conversation => <button key={conversation.id} type="button" aria-current={state.id === conversation.id ? "page" : undefined} disabled={state.busy} onClick={() => { state.select(conversation.id); if (window.innerWidth < 768) setSidebar(false); }} className={cn("block w-full rounded-lg px-3 py-3 text-left text-sm hover:bg-muted disabled:opacity-40", state.id === conversation.id && "bg-muted")}><span className="block truncate">{conversation.title || "图片会话"}</span><span className="text-xs text-muted-foreground">{new Date(conversation.updatedAt).toLocaleDateString()}</span></button>)}{state.listCursor ? <button type="button" className={cn(control, "w-full")} disabled={state.busy} onClick={state.moreConversations}>加载更多会话</button> : null}</nav>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">消息与图片版本由服务端保存。旧浏览器聊天记录不会自动导入。</p>
        </aside> : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 sm:px-5">
                <div className="flex min-w-0 items-center gap-2">{!sidebar ? <button type="button" aria-label="展开会话" onClick={() => setSidebar(true)} className="grid size-9 place-items-center rounded-lg hover:bg-muted"><PanelLeftOpen className="size-4" /></button> : null}<div className="min-w-0"><h2 className="truncate text-sm font-medium">对话改图</h2><p className="text-[11px] text-muted-foreground" role="status">{state.connection}</p></div></div>
                <div className="flex items-center gap-1"><button type="button" aria-expanded={versionsOpen} className={cn(control, "border-transparent px-2")} onClick={() => setVersionsOpen(value => !value)}>图片版本 {versions.length}<ChevronDown className="size-3" /></button><button type="button" aria-label="刷新服务端记录" disabled={state.busy} onClick={state.refresh} className="grid size-9 place-items-center rounded-lg hover:bg-muted"><RefreshCw className="size-4" /></button></div>
            </header>
            <div ref={follow.listRef} onScroll={follow.onScroll} data-testid="conversation-messages" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-5 sm:px-6">
                <div ref={follow.contentRef} className="mx-auto max-w-3xl space-y-5">
                    {!state.id ? <div className="mx-auto max-w-lg py-12 text-center"><h3 className="text-2xl font-medium">直接说怎么改</h3><p className="mt-3 text-sm leading-7 text-muted-foreground">上传原图，或描述新设计。继续修改、回到原图、查看上一版，都可以直接对话。</p>{options.initialAssetId ? <img src={assetUrl(options.initialAssetId)} alt="将用于新会话的画布原图" className="mx-auto mt-5 max-h-48 max-w-full rounded-lg object-contain" /> : null}<p className="mt-4 text-xs text-muted-foreground">画质与尺寸由服务端自动决策，也可直接在消息中提出要求。</p></div> : null}
                    {state.id && !state.view && !state.error ? <p role="status" className="flex items-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" />正在恢复服务端会话…</p> : null}
                    {uploadVersions.map(version => <VersionImage key={version.id} version={version} active={state.view?.snapshot.activeVersionId === version.id} disabled={blocked} />)}
                    {versionsOpen ? <div aria-label="图片版本目录" className="grid gap-3 sm:grid-cols-2">{versions.map(version => <VersionImage key={version.id} version={version} active={state.view?.snapshot.activeVersionId === version.id} disabled={blocked} onRestore={() => void state.submit(`恢复到图${version.imageNo}`)} />)}</div> : null}
                    {messages.map(message => {
                        const turn = state.view?.turns.find(item => item.id === message.turnId);
                        return <article key={message.id} data-message-id={message.id} className={cn("min-w-0 space-y-3 text-sm leading-7", message.role === "user" ? "ml-auto max-w-[90%] rounded-2xl bg-muted px-4 py-3" : "w-full")}>
                            {message.text ? <ChatMarkdown>{message.text}</ChatMarkdown> : null}
                            {message.attachments.map(versionId => { const version = versions.find(item => item.id === versionId); return version ? <VersionImage key={version.id} version={version} active={state.view?.snapshot.activeVersionId === version.id} disabled={blocked} /> : <p key={versionId} className="text-xs text-muted-foreground">图片版本正在同步，请刷新服务端记录。</p>; })}
                            {turn && messages.findLast(item => item.turnId === turn.id)?.id === message.id ? <TurnStatus turn={turn} /> : null}
                        </article>;
                    })}
                </div>
            </div>
            <div className="shrink-0 border-t border-border bg-background px-3 pb-3 pt-2 sm:px-6">
                <div className="mx-auto max-w-3xl space-y-2">
                    {follow.hasNewMessages ? <button type="button" className="w-full text-center text-xs text-muted-foreground" onClick={follow.scrollToBottom}>↓ 新消息</button> : null}
                    {pending ? <div role="status" className="rounded-lg bg-muted/50 px-3 py-2"><TurnStatus turn={pending} /><p className="mt-1 text-xs text-muted-foreground">{pending.assistant.text}</p></div> : null}
                    {state.notice ? <p role="status" className="text-xs leading-5 text-muted-foreground">{state.notice}</p> : null}
                    {state.error ? <p role="alert" className="break-words text-sm leading-6 text-red-600 dark:text-red-400">{state.error}</p> : null}
                    {state.receipt ? <div className="flex flex-wrap items-center gap-2 text-xs"><span>原请求 {state.receipt.clientRequestId}</span><button type="button" className={control} disabled={state.busy} onClick={state.queryOriginal}>查询原请求</button></div> : null}
                    {state.createReceipt ? <div className="flex flex-wrap items-center gap-2 text-xs"><span>创建回执未确认，不会自动创建或发送消息。</span><button type="button" className={control} disabled={state.busy} onClick={state.recoverCreate}>查询原创建请求</button><button type="button" className={control} disabled={state.busy} onClick={state.completeCreate}>按原编号完成创建</button></div> : null}
                    <div className="rounded-xl border border-input bg-card p-3 focus-within:border-ring">
                        {state.draft.attachments.length ? <div className="mb-2 flex flex-wrap gap-2">{state.draft.attachments.map(item => <div key={item.assetId} className="flex max-w-48 items-center gap-2 rounded-lg border border-border p-1.5"><img src={assetUrl(item.assetId)} alt="" className="size-9 rounded object-contain" /><span className="truncate text-xs">{item.name}</span><button type="button" aria-label={`移除 ${item.name}`} disabled={blocked} onClick={() => state.changeDraft(current => ({ ...current, attachments: current.attachments.filter(attachment => attachment.assetId !== item.assetId) }))}><X className="size-3.5" /></button></div>)}</div> : null}
                        <textarea aria-label="对话内容" value={state.draft.text} maxLength={10000} disabled={!state.ready || state.busy || Boolean(state.receipt)} onChange={event => state.changeDraft(current => ({ ...current, text: event.target.value }))} onKeyDown={event => { if (!event.nativeEvent.isComposing) handleSubmitShortcut(event, canSend, () => void state.submit()); }} placeholder="直接说怎么改 · Ctrl / ⌘ + Enter 发送" style={{ outline: "none" }} className="block max-h-40 min-h-16 w-full resize-none bg-transparent text-base leading-7 placeholder:text-muted-foreground" />
                        <div className="mt-2 flex items-center justify-between gap-2"><div className="flex flex-wrap items-center gap-1"><button type="button" aria-label="上传图片原件" className={cn(control, "border-transparent")} disabled={blocked} onClick={() => files.current?.click()}><ImagePlus className="size-4" /><span className="hidden sm:inline">上传原图</span></button><span className="text-xs text-muted-foreground">自动参数</span>{pending || state.receipt ? <button type="button" aria-label="查询原任务状态" className={cn(control, "border-transparent px-2")} disabled={state.busy} onClick={state.queryOriginal}><RefreshCw className="size-4" /></button> : null}</div>{pending?.assistant.canCancel ? <button type="button" className={control} disabled={state.busy} onClick={state.cancel}><Square className="size-4" />停止本轮</button> : <button type="button" disabled={!canSend} style={{ color: "var(--primary-foreground)" }} className={cn(control, "border-transparent bg-primary hover:bg-primary/90")} onClick={() => void state.submit()}>{state.busy ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}发送</button>}</div>
                        <input ref={files} type="file" accept="image/*" multiple className="hidden" disabled={blocked} onChange={event => { const selected = Array.from(event.currentTarget.files || []); event.currentTarget.value = ""; if (selected.length) void state.upload(selected); }} />
                    </div>
                    <p className="text-right text-[11px] leading-4 text-muted-foreground">刷新只恢复原会话，不会重复发送或生成。</p>
                </div>
            </div>
        </div>
    </section>;
}
