import { lazy,Suspense,useEffect, useRef, useState, type CSSProperties } from "react";
import { IMAGE_AGENT_MAX_IMAGES } from "../../../shared/image-agent/focus";
import { turnResultUnconfirmed } from "../../../shared/image-conversation-turn-state";
import {
    ArrowDownToLine,
    Check,
    ChevronDown,
    Images,
    ImagePlus,
    LoaderCircle,
    MessageSquarePlus,
    PanelLeftClose,
    PanelLeftOpen,
    Pencil,
    RefreshCw,
    Send,
    Square,
    X,
} from "lucide-react";
import type {
    PublicImageTurn as ImageTurn,
    PublicImageVersion as ImageVersion,
} from "../../../shared/image-conversation-public";
import { cn } from "@/lib/utils";
import { handleSubmitShortcut } from "@/lib/submit-shortcut";
import { useUserStore } from "@/stores/use-user-store";
import { useChatBottomFollow } from "@/hooks/use-chat-bottom-follow";
import { ChatMarkdown } from "@/pages/chat/chat-markdown";
import { conversationTurnStatus } from "./image-conversation-state";
import { useImageConversation, type ImageConversationOptions } from "./use-image-conversation";
import { ConversationImagePreview } from "./conversation-image-preview";
import { ConversationImageModelChoice } from "./conversation-image-model-choice";
import type { ConversationImageItem } from "./conversation-image-controls";
import { ReferencePicker } from "./canvas/design-discussion/ReferencePicker";
import { pastedConversationImageFiles } from "@/lib/conversation-image-clipboard";
import { useImagePreview } from "@/hooks/use-image-preview";

export type ImageConversationPanelProps = ImageConversationOptions & { className?: string };
const ConversationVideo=lazy(()=>import("./conversation-video"));
const assetUrl = (id: string) => `/api/assets/${encodeURIComponent(id)}/content`;
const control =
    "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40";
const versionImage = (version: ImageVersion): ConversationImageItem => ({
    id: version.id,
    label: `图${version.imageNo}`,
    name: version.label,
    dataUrl: assetUrl(version.assetId),
    source: "conversation",
});

function ConversationThumbnail({
    assetId,
    alt,
    className,
    edge = 256,
}: {
    assetId: string;
    alt: string;
    className: string;
    edge?: 256 | 1024;
}) {
    const target = useRef<HTMLElement | null>(null);
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        if (typeof IntersectionObserver === "undefined") {
            setVisible(true);
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    observer.disconnect();
                    setVisible(true);
                }
            },
            { rootMargin: "200px" },
        );
        if (target.current) observer.observe(target.current);
        return () => observer.disconnect();
    }, [assetId, edge]);
    const source = useImagePreview({ dataUrl: assetUrl(assetId) }, edge, visible);
    const [failed, setFailed] = useState("");
    return source && source !== failed ? (
        <img
            ref={(node) => {
                target.current = node;
            }}
            src={source}
            alt={alt}
            loading="lazy"
            decoding="async"
            className={className}
            onError={() => setFailed(source)}
        />
    ) : (
        <span
            ref={(node) => {
                target.current = node;
            }}
            aria-label="缩略预览暂不可用，可点击查看原图"
            className={cn("grid place-items-center gap-1 bg-muted/30 text-xs text-muted-foreground", className)}
        >
            <Images className="size-5" />
            {edge === 1024 ? <span>点击查看原图</span> : null}
        </span>
    );
}

export function ImageConversationPanel(props: ImageConversationPanelProps) {
    const ownerId = useUserStore((state) => state.user?.id);
    if (!ownerId)
        return (
            <div role="status" className="p-6">
                请登录后读取服务端会话。
            </div>
        );
    return (
        <OwnedImageConversationPanel
            key={`${ownerId}:${props.entrypoint}:${props.canvasExternalId || "standalone"}`}
            {...props}
            ownerId={ownerId}
        />
    );
}

function VersionImage({
    version,
    active,
    onRestore,
    onPreview,
    onUseAsBase,
    disabled,
}: {
    version: ImageVersion;
    active: boolean;
    onRestore?: () => void;
    onPreview: () => void;
    onUseAsBase: () => void;
    disabled: boolean;
}) {
    return (
        <figure
            data-version-id={version.id}
            className="min-w-0 overflow-hidden rounded-xl border border-border bg-card"
        >
            <button
                type="button"
                onClick={onPreview}
                className="block w-full cursor-zoom-in"
                aria-label={`查看图${version.imageNo}原图`}
            >
                <ConversationThumbnail
                    assetId={version.assetId}
                    alt={`图${version.imageNo} · ${version.label}`}
                    edge={1024}
                    className="h-64 w-full bg-muted/30 object-contain sm:h-80"
                />
            </button>
            <figcaption className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs text-muted-foreground">
                <span className="min-w-0 break-words">
                    图{version.imageNo} · {version.label}
                    {version.actualDimensions
                        ? ` · ${version.actualDimensions.width} × ${version.actualDimensions.height}`
                        : ""}
                    {active ? (
                        <span className="ml-2 inline-flex items-center gap-1 text-foreground">
                            <Check className="size-3" />
                            当前图
                        </span>
                    ) : null}
                </span>
                <span className="flex flex-wrap items-center gap-3">
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={onUseAsBase}
                        className="inline-flex min-h-8 items-center gap-1 hover:text-foreground disabled:opacity-40"
                    >
                        <Pencil className="size-3.5" />
                        基于此图修改
                    </button>
                    <a
                        href={assetUrl(version.assetId)}
                        download={`image-${version.imageNo}`}
                        className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                        <ArrowDownToLine className="size-3.5" />
                        原图
                    </a>
                    {onRestore && !active ? (
                        <button
                            type="button"
                            disabled={disabled}
                            onClick={onRestore}
                            className="hover:text-foreground disabled:opacity-40"
                        >
                            恢复到此图
                        </button>
                    ) : null}
                </span>
            </figcaption>
        </figure>
    );
}

function TurnStatus({ turn }: { turn: ImageTurn }) {
    return (
        <div
            data-turn-id={turn.id}
            data-turn-state={turn.state}
            className="space-y-1 text-xs leading-5 text-muted-foreground"
        >
            <p>{conversationTurnStatus(turn)}</p>
            {turn.lastError ? (
                <p className="break-words text-red-600 dark:text-red-400">{turn.lastError.message}</p>
            ) : null}
            {turn.taskId ? (
                <details>
                    <summary className="cursor-pointer">原任务记录</summary>
                    <p className="break-all">{turn.taskId}</p>
                </details>
            ) : null}
            {turn.settingsSnapshot ? (
                <details>
                    <summary className="cursor-pointer">服务端自动参数</summary>
                    <p>
                        画质 {turn.settingsSnapshot.effective.quality} ·{" "}
                        {turn.settingsSnapshot.effective.resolution?.toUpperCase() || "精确像素"} ·{" "}
                        {turn.settingsSnapshot.effective.size || "保留参考图比例"} ·{" "}
                        {turn.settingsSnapshot.effective.output_format.toUpperCase()}
                    </p>
                    <p>
                        实际结果：
                        {turn.settingsSnapshot.actual
                            ? `${turn.settingsSnapshot.actual.dimensions.width} × ${turn.settingsSnapshot.actual.dimensions.height}`
                            : "尚无实际图片回执"}
                    </p>
                </details>
            ) : null}
        </div>
    );
}

function OwnedImageConversationPanel({
    ownerId,
    className,
    ...options
}: ImageConversationPanelProps & { ownerId: string }) {
    const state = useImageConversation(ownerId, options);
    const [sidebar, setSidebar] = useState(
        () =>
            options.entrypoint === "standalone" &&
            typeof window !== "undefined" &&
            window.matchMedia("(min-width: 768px)").matches,
    );
    const [versionsOpen, setVersionsOpen] = useState(false);
    const [preview, setPreview] = useState<ConversationImageItem | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [mediaError, setMediaError] = useState("");
    const mediaScope = useRef({ active: true, id: state.id });
    mediaScope.current.id = state.id;
    useEffect(() => {
        mediaScope.current.active = true;
        return () => {
            mediaScope.current.active = false;
        };
    }, []);
    useEffect(() => setMediaError(""), [state.id]);
    const files = useRef<HTMLInputElement>(null);
    const composer = useRef<HTMLTextAreaElement>(null);
    const pending = state.view?.snapshot.pendingTurn;
    const blocked =
        !state.ready ||
        state.busy ||
        Boolean(state.receipt || state.createReceipt || pending) ||
        Boolean(state.id && !state.view);
    const canSend = !blocked && state.imageCount <= IMAGE_AGENT_MAX_IMAGES && state.draft.text.trim().length > 0 && state.draft.text.length <= 10000;
    const versions = state.view?.versions || [],
        messages = state.view?.messages || [];
    const follow = useChatBottomFollow(state.view?.messages, state.id || undefined);
    const latestTurn = state.view?.turns.reduce<ImageTurn | undefined>((latest, turn) =>
        !latest || turn.acceptedRevision > latest.acceptedRevision ? turn : latest, undefined);
    const unresolvedPrevious = latestTurn && turnResultUnconfirmed(latestTurn.state, latestTurn.outputVersionId);
    useEffect(() => { if (state.acceptedCount) follow.scrollToBottom(); }, [state.acceptedCount, follow.scrollToBottom]);
    useEffect(() => { if (state.draft.source) composer.current?.focus(); }, [state.draft.source?.turnId]);
    const attachmentVersions = new Set(messages.flatMap((message) => message.attachments));
    const uploadVersions = versions.filter(
        (version) => version.source === "upload" && !attachmentVersions.has(version.id),
    );
    const selectedCanvasImages = (options.canvasImages || []).filter((item) =>
        options.selectedCanvasImageIds?.includes(item.id),
    );
    const addImages = (items: Array<{ id: string; title: string; image: string; storageKey?: string; serverAssetId?: string; width?: number; height?: number }>) => state.attachImages(items);
    const baseVersion = (version: ImageVersion) => {
        void state.selectBase(version.assetId, `图${version.imageNo} · ${version.label}`);
    };
    return (
        <section
            data-testid="server-image-conversation"
            className={cn(
                "relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background text-foreground",
                className,
            )}
        >
            {sidebar ? (
                <aside
                    aria-label="服务端会话记录"
                    className="absolute inset-y-0 left-0 z-20 flex w-[min(280px,85%)] shrink-0 flex-col border-r border-border bg-background p-3 shadow-lg md:static md:w-60 md:shadow-none"
                >
                    <div className="mb-3 flex items-center justify-between">
                        <strong className="text-sm">服务端会话</strong>
                        <button
                            type="button"
                            aria-label="收起会话"
                            onClick={() => setSidebar(false)}
                            className="grid size-9 place-items-center rounded-lg hover:bg-muted"
                        >
                            <PanelLeftClose className="size-4" />
                        </button>
                    </div>
                    <button
                        type="button"
                        className={control}
                        disabled={!state.ready || state.busy || Boolean(state.receipt || state.createReceipt)}
                        onClick={() => {
                            state.select(null);
                            if (window.innerWidth < 768) setSidebar(false);
                        }}
                    >
                        <MessageSquarePlus className="size-4" />
                        新会话
                    </button>
                    <nav className="mt-3 flex-1 space-y-1 overflow-y-auto" aria-label="会话列表">
                        {state.conversations.map((conversation) => (
                            <button
                                key={conversation.id}
                                type="button"
                                aria-current={state.id === conversation.id ? "page" : undefined}
                                disabled={state.busy}
                                onClick={() => {
                                    state.select(conversation.id);
                                    if (window.innerWidth < 768) setSidebar(false);
                                }}
                                className={cn(
                                    "block w-full rounded-lg px-3 py-3 text-left text-sm hover:bg-muted disabled:opacity-40",
                                    state.id === conversation.id && "bg-muted",
                                )}
                            >
                                <span className="block truncate">{conversation.title || "图片会话"}</span>
                                <span className="text-xs text-muted-foreground">
                                    {new Date(conversation.updatedAt).toLocaleDateString()}
                                </span>
                            </button>
                        ))}
                        {state.listCursor ? (
                            <button
                                type="button"
                                className={cn(control, "w-full")}
                                disabled={state.busy}
                                onClick={state.moreConversations}
                            >
                                加载更多会话
                            </button>
                        ) : null}
                    </nav>
                    <p className="mt-3 text-xs leading-5 text-muted-foreground">
                        消息与图片版本由服务端保存。旧浏览器聊天记录不会自动导入。
                    </p>
                </aside>
            ) : null}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 sm:px-5">
                    <div className="flex min-w-0 items-center gap-2">
                        {!sidebar ? (
                            <button
                                type="button"
                                aria-label="展开会话"
                                onClick={() => setSidebar(true)}
                                className="grid size-9 place-items-center rounded-lg hover:bg-muted"
                            >
                                <PanelLeftOpen className="size-4" />
                            </button>
                        ) : null}
                        <div className="min-w-0">
                            <h2 className="truncate text-sm font-medium">对话改图</h2>
                            <p className="text-[11px] text-muted-foreground" role="status">
                                {state.connection}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            aria-expanded={versionsOpen}
                            className={cn(control, "border-transparent px-2")}
                            onClick={() => setVersionsOpen((value) => !value)}
                        >
                            图片版本 {versions.length}
                            <ChevronDown className="size-3" />
                        </button>
                        <button
                            type="button"
                            aria-label="查询原任务（不重新生成）"
                            title="查询原任务（不重新生成）"
                            disabled={state.busy}
                            onClick={state.receipt || pending ? state.queryOriginal : state.refresh}
                            className="inline-flex min-h-9 min-w-9 items-center justify-center gap-2 rounded-lg px-2 text-xs hover:bg-muted"
                        >
                            <RefreshCw className="size-4" />
                            <span className="hidden sm:inline">查询原任务（不重新生成）</span>
                        </button>
                    </div>
                </header>
                <div
                    ref={follow.listRef}
                    onScroll={follow.onScroll}
                    data-testid="conversation-messages"
                    className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-5 sm:px-6"
                >
                    <div ref={follow.contentRef} className="mx-auto max-w-3xl space-y-5">
                        {!state.id ? (
                            <div className="mx-auto max-w-lg py-12 text-center">
                                <h3 className="text-2xl font-medium">直接说怎么改</h3>
                                <p className="mt-3 text-sm leading-7 text-muted-foreground">
                                    上传原图，或描述新设计。继续修改、回到原图、查看上一版，都可以直接对话。
                                </p>
                                {options.initialAssetId ? (
                                    <button
                                        type="button"
                                        className="mx-auto mt-5 block cursor-zoom-in"
                                        aria-label="查看画布原图"
                                        onClick={() =>
                                            setPreview({
                                                id: options.initialAssetId!,
                                                label: "画布原图",
                                                name: "画布原图",
                                                dataUrl: assetUrl(options.initialAssetId!),
                                                source: "canvas",
                                            })
                                        }
                                    >
                                        <ConversationThumbnail
                                            assetId={options.initialAssetId}
                                            alt="将用于新会话的画布原图"
                                            className="h-48 max-w-full rounded-lg object-contain"
                                        />
                                    </button>
                                ) : null}
                                <p className="mt-4 text-xs text-muted-foreground">
                                    画质与尺寸由服务端自动决策，也可直接在消息中提出要求。
                                </p>
                            </div>
                        ) : null}
                        {state.id && !state.view && !state.error ? (
                            <p role="status" className="flex items-center gap-2 text-sm">
                                <LoaderCircle className="size-4 animate-spin" />
                                正在恢复服务端会话…
                            </p>
                        ) : null}
                        {uploadVersions.map((version) => (
                            <VersionImage
                                key={version.id}
                                version={version}
                                active={state.view?.snapshot.activeVersionId === version.id}
                                disabled={blocked}
                                onPreview={() => setPreview(versionImage(version))}
                                onUseAsBase={() => baseVersion(version)}
                            />
                        ))}
                        {versionsOpen ? (
                            <div aria-label="图片版本目录" className="grid gap-3 sm:grid-cols-2">
                                {versions.map((version) => (
                                    <VersionImage
                                        key={version.id}
                                        version={version}
                                        active={state.view?.snapshot.activeVersionId === version.id}
                                        disabled={blocked}
                                        onPreview={() => setPreview(versionImage(version))}
                                        onUseAsBase={() => baseVersion(version)}
                                        onRestore={() => void state.submit(`恢复到图${version.imageNo}`)}
                                    />
                                ))}
                            </div>
                        ) : null}
                        {messages.map((message) => {
                            const turn = state.view?.turns.find((item) => item.id === message.turnId);
                            return (
                                <article
                                    key={message.id}
                                    data-message-id={message.id}
                                    className={cn(
                                        "min-w-0 space-y-3 text-sm leading-7",
                                        message.role === "user"
                                            ? "ml-auto max-w-[90%] rounded-2xl bg-muted px-4 py-3"
                                            : "w-full",
                                    )}
                                >
                                    {message.text ? <ChatMarkdown>{message.text}</ChatMarkdown> : null}
                                    {message.role==="assistant"&&message.kind==="text"&&turn?.videoProposal?<Suspense fallback={null}><ConversationVideo key={turn.id} owner={ownerId} entry={options.entrypoint} projectId={options.canvasExternalId||turn.conversationId} turnId={turn.id} proposal={turn.videoProposal}/></Suspense>:null}
                                    {message.attachments.map((versionId) => {
                                        const version = versions.find((item) => item.id === versionId);
                                        return version ? (
                                            <VersionImage
                                                key={version.id}
                                                version={version}
                                                active={state.view?.snapshot.activeVersionId === version.id}
                                                disabled={blocked}
                                                onPreview={() => setPreview(versionImage(version))}
                                                onUseAsBase={() => baseVersion(version)}
                                            />
                                        ) : (
                                            <p key={versionId} className="text-xs text-muted-foreground">
                                                图片版本正在同步，可查询原任务（不重新生成）。
                                            </p>
                                        );
                                    })}
                                    {turn && messages.findLast((item) => item.turnId === turn.id)?.id === message.id ? (
                                        <TurnStatus turn={turn} />
                                    ) : null}
                                    {message.role === "user" && turn && (
                                        <div className="mt-2 flex flex-wrap gap-2 text-xs">
                                            <button type="button" className={control}
                                                disabled={blocked || unresolvedPrevious || turnResultUnconfirmed(turn.state, turn.outputVersionId)}
                                                onClick={() => {
                                                    if ((state.draft.text || state.draft.attachments.length) && !window.confirm("用这条历史消息替换当前未发送的草稿？")) return;
                                                    void state.reuseTurn(turn.id, false);
                                                }}>编辑后重发</button>
                                            {(turn.taskId || turn.outputVersionId || turn.intent === "edit" || turn.intent === "generate_new") && (
                                                <button type="button" className={control}
                                                    disabled={blocked || unresolvedPrevious || turnResultUnconfirmed(turn.state, turn.outputVersionId)}
                                                    onClick={() => {
                                                        if (window.confirm("将创建一次新的图片生成，可能再次计费。继续吗？"))
                                                            void state.reuseTurn(turn.id, true);
                                                    }}>重新生成</button>
                                            )}
                                        </div>
                                    )}
                                </article>
                            );
                        })}
                    </div>
                </div>
                <div className="shrink-0 border-t border-border bg-background px-3 pb-3 pt-2 sm:px-6">
                    <div className="mx-auto max-w-3xl space-y-2">
                        {follow.hasNewMessages ? (
                            <button
                                type="button"
                                className="w-full text-center text-xs text-muted-foreground"
                                onClick={follow.scrollToBottom}
                            >
                                ↓ 新消息
                            </button>
                        ) : null}
                        {pending ? (
                            <div role="status" className="rounded-lg bg-muted/50 px-3 py-2">
                                <TurnStatus turn={pending} />
                                <p className="mt-1 text-xs text-muted-foreground">{pending.assistant.text}</p>
                            </div>
                        ) : null}
                        {state.notice ? (
                            <p role="status" className="text-xs leading-5 text-muted-foreground">
                                {state.notice}
                            </p>
                        ) : null}
                        {state.error ? (
                            <p role="alert" className="break-words text-sm leading-6 text-red-600 dark:text-red-400">
                                {state.error}
                            </p>
                        ) : null}
                        {mediaError ? (
                            <p role="alert" className="break-words text-sm leading-6 text-red-600 dark:text-red-400">
                                {mediaError}
                            </p>
                        ) : null}
                        {state.receipt ? (
                            <div role="group" aria-label="待确认的发送回执" className="flex flex-wrap items-center gap-2 text-xs">
                                <span>原请求 {state.receipt.clientRequestId}</span>
                                <button
                                    type="button"
                                    className={control}
                                    disabled={state.busy}
                                    onClick={state.queryOriginal}
                                >
                                    查询原任务（不重新生成）
                                </button>
                            </div>
                        ) : null}
                        {state.createReceipt ? (
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                                <span>创建回执未确认，不会自动创建或发送消息。</span>
                                <button
                                    type="button"
                                    className={control}
                                    disabled={state.busy}
                                    onClick={state.recoverCreate}
                                >
                                    查询原创建请求
                                </button>
                                <button
                                    type="button"
                                    className={control}
                                    disabled={state.busy}
                                    onClick={state.completeCreate}
                                >
                                    按原编号完成创建
                                </button>
                            </div>
                        ) : null}
                        <div
                            className="rounded-xl border border-input bg-card p-3 focus-within:border-ring"
                            onPaste={(event) => {
                                const images = pastedConversationImageFiles(event.clipboardData);
                                if (!images) return;
                                event.preventDefault();
                                event.stopPropagation();
                                const target = state.id;
                                const current = () =>
                                    mediaScope.current.active &&
                                    mediaScope.current.id === target &&
                                    useUserStore.getState().user?.id === ownerId;
                                void images
                                    .then((items) => {
                                        if (!blocked && current()) {
                                            setMediaError("");
                                            return state.upload(items);
                                        }
                                    })
                                    .catch((error) => {
                                        if (current())
                                            setMediaError(
                                                error instanceof Error ? error.message : "图片粘贴失败，请重试",
                                            );
                                    });
                            }}
                            onDragOver={(event) => {
                                if (
                                    Array.from(event.dataTransfer.items).some(
                                        (item) => item.kind === "file" && item.type.startsWith("image/"),
                                    )
                                ) {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    event.dataTransfer.dropEffect = blocked ? "none" : "copy";
                                }
                            }}
                            onDrop={(event) => {
                                const images = Array.from(event.dataTransfer.files).filter((file) =>
                                    file.type.startsWith("image/"),
                                );
                                if (!images.length) return;
                                event.preventDefault();
                                event.stopPropagation();
                                if (!blocked) void state.upload(images);
                            }}
                        >
                            {state.draft.attachments.length ? (
                                <div className="mb-2 flex flex-wrap gap-2">
                                    {state.draft.attachments.map((item) => (
                                        <div
                                            key={item.assetId}
                                            data-draft-asset-id={item.assetId}
                                            className="flex w-full max-w-64 items-center gap-2 rounded-lg border border-border p-1.5"
                                        >
                                            <button
                                                type="button"
                                                className="shrink-0 cursor-zoom-in"
                                                aria-label={`查看 ${item.name} 原图`}
                                                onClick={() =>
                                                    setPreview({
                                                        id: item.assetId,
                                                        label: item.name,
                                                        name: item.name,
                                                        dataUrl: assetUrl(item.assetId),
                                                        source: "conversation",
                                                    })
                                                }
                                            >
                                                <ConversationThumbnail
                                                    assetId={item.assetId}
                                                    alt=""
                                                    className="size-10 rounded object-contain"
                                                />
                                            </button>
                                            <div className="min-w-0 flex-1">
                                                <span className="block truncate text-xs" title={item.name}>
                                                    {item.name}
                                                </span>
                                                <select
                                                    aria-label={`${item.name}用途`}
                                                    value={item.purpose || "auto"}
                                                    disabled={blocked}
                                                    className="mt-1 w-full rounded bg-background text-xs"
                                                    onChange={(event) => {
                                                        if (event.target.value === "new_base") {
                                                            void state.selectBase(item.assetId, item.name);
                                                            return;
                                                        }
                                                        const purpose =
                                                            event.target.value === "reference" ? "reference" : "auto";
                                                        state.changeDraft((current) => ({
                                                            ...current,
                                                            attachments: current.attachments.map((attachment) =>
                                                                attachment.assetId === item.assetId
                                                                    ? { ...attachment, purpose }
                                                                    : attachment,
                                                            ),
                                                        }));
                                                    }}
                                                >
                                                    <option value="auto">自动判断</option>
                                                    <option value="new_base">修改底图</option>
                                                    <option value="reference">参考图</option>
                                                </select>
                                            </div>
                                            <button
                                                type="button"
                                                aria-label={`移除 ${item.name}`}
                                                disabled={blocked}
                                                className="grid size-8 shrink-0 place-items-center"
                                                onClick={() =>
                                                    state.changeDraft((current) => ({
                                                        ...current,
                                                        attachments: current.attachments.filter(
                                                            (attachment) => attachment.assetId !== item.assetId,
                                                        ),
                                                    }))
                                                }
                                            >
                                                <X className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                            {state.draft.source && <div className="mb-1 flex items-center gap-2 text-xs">
                                正在编辑历史消息，发送后会创建新轮次。
                                <button type="button" className={control} disabled={blocked} onClick={() => state.changeDraft(() => ({ text: "", attachments: [] }))}>放弃编辑</button>
                            </div>}
                            <textarea ref={composer}
                                aria-label="对话内容"
                                value={state.draft.text}
                                maxLength={10000}
                                disabled={!state.ready || state.busy || Boolean(state.receipt)}
                                onChange={(event) =>
                                    state.changeDraft((current) => ({ ...current, text: event.target.value }))
                                }
                                onKeyDown={(event) => {
                                    if (!event.nativeEvent.isComposing)
                                        handleSubmitShortcut(event, canSend, () => void state.submit());
                                }}
                                placeholder="直接说怎么改 · Ctrl / ⌘ + Enter 发送"
                                style={{ outline: "none" }}
                                className="block max-h-40 min-h-16 w-full resize-none bg-transparent text-base leading-7 placeholder:text-muted-foreground"
                            />
                            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                                <div className="w-full"><ConversationImageModelChoice value={state.imageModel} onChange={state.selectImageModel} disabled={blocked} /></div>
                                <div className="flex flex-wrap items-center gap-1">
                                    <button
                                        type="button"
                                        aria-label="上传图片原件"
                                        className={cn(control, "border-transparent px-2")}
                                        disabled={blocked || !state.remainingImages}
                                        onClick={() => files.current?.click()}
                                    >
                                        <ImagePlus className="size-4" />
                                        <span className="hidden sm:inline">上传原图</span>
                                    </button>
                                    <button
                                        type="button"
                                        className={cn(control, "border-transparent px-2")}
                                        disabled={blocked || !state.remainingImages}
                                        onClick={() => setPickerOpen(true)}
                                    >
                                        <Images className="size-4" />
                                        素材库选图
                                    </button>
                                    <span aria-live="polite" className="text-xs text-muted-foreground">
                                        当前图 + 附件 共 {state.imageCount}/{IMAGE_AGENT_MAX_IMAGES}{state.remainingImages === 0 ? " · 名额已满" : ""}
                                    </span>
                                    {selectedCanvasImages.length ? (
                                        <button
                                            type="button"
                                            className={cn(control, "border-transparent px-2")}
                                            disabled={blocked || !state.remainingImages}
                                            onClick={() => void addImages(selectedCanvasImages)}
                                        >
                                            <ImagePlus className="size-4" />
                                            添加选中图片
                                        </button>
                                    ) : null}
                                    {pending || state.receipt ? (
                                        <button
                                            type="button"
                                            aria-label="查询原任务（不重新生成）"
                                            className={cn(control, "border-transparent px-2")}
                                            disabled={state.busy}
                                            onClick={state.queryOriginal}
                                        >
                                            <RefreshCw className="size-4" />
                                        </button>
                                    ) : null}
                                </div>
                                {pending?.assistant.canCancel ? (
                                    <button
                                        type="button"
                                        className={control}
                                        disabled={state.busy}
                                        onClick={state.cancel}
                                    >
                                        <Square className="size-4" />
                                        停止本轮
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        disabled={!canSend}
                                        style={{ color: "var(--primary-foreground)" }}
                                        className={cn(control, "border-transparent bg-primary hover:bg-primary/90")}
                                        onClick={() => void state.submit()}
                                    >
                                        {state.busy ? (
                                            <LoaderCircle className="size-4 animate-spin" />
                                        ) : (
                                            <Send className="size-4" />
                                        )}
                                        发送
                                    </button>
                                )}
                            </div>
                            <input
                                ref={files}
                                type="file"
                                accept="image/*"
                                multiple
                                className="hidden"
                                disabled={blocked}
                                onChange={(event) => {
                                    const selected = Array.from(event.currentTarget.files || []);
                                    event.currentTarget.value = "";
                                    if (selected.length) void state.upload(selected);
                                }}
                            />
                        </div>
                        <p className="text-right text-[11px] leading-4 text-muted-foreground">
                            支持粘贴或拖入图片；选图只加入草稿，点击发送后执行。
                        </p>
                    </div>
                </div>
            </div>
            <div
                className="contents"
                style={
                    {
                        "--surface": "var(--card)",
                        "--text": "var(--foreground)",
                        "--muted": "var(--muted-foreground)",
                        "--canvas": "var(--background)",
                        "--soft": "var(--secondary)",
                        "--accent": "var(--primary)",
                        "--selection": "var(--primary)",
                    } as CSSProperties
                }
            >
                <ReferencePicker
                    open={pickerOpen && state.remainingImages > 0}
                    initialTab="assets"
                    items={options.canvasImages || []}
                    max={state.remainingImages}
                    onChoose={addImages}
                    onClose={() => setPickerOpen(false)}
                />
            </div>
            {preview ? <ConversationImagePreview image={preview} onClose={() => setPreview(null)} /> : null}
        </section>
    );
}
