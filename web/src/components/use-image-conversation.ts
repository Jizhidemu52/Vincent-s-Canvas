import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
    AttachmentPurpose,
    ConversationEntrypoint,
    ConversationSummary,
    CreateConversationRequest,
    SubmitTurnRequest,
} from "../../../shared/image-conversation-contracts";
import type {
    PublicConversationSnapshot,
    PublicImageTurn as ImageTurn,
    PublicImageVersion as ImageVersion,
} from "../../../shared/image-conversation-public";
import { createConversationRequestSchema, submitTurnRequestSchema } from "../../../shared/image-conversation-schemas";
import { createClientId } from "@/lib/client-id";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { uploadServerAsset } from "@/services/api/server-assets";
import { readMediaSource, readUploadedMedia, serverMediaId } from "@/services/canvas-media-links";
import { useUserStore } from "@/stores/use-user-store";
import {
    allConversationPages,
    createImageConversationApi,
    ImageConversationApiError,
} from "@/services/api/image-conversations";
import {
    applyConversationEvent,
    conversationRequestAttachments,
    conversationVersionCanInstall,
    emptyConversationDraft,
    emptyConversationLocalState,
    mergeConversationAttachments,
    type ConversationAttachment,
    type ConversationDraft,
    type ConversationLocalState,
    type ConversationView,
} from "./image-conversation-state";

export type ConversationSourceImage = {
    id: string;
    title: string;
    image: string;
    storageKey?: string;
    serverAssetId?: string;
    width?: number;
    height?: number;
};

export type ImageConversationOptions = {
    entrypoint: ConversationEntrypoint;
    canvasExternalId?: string;
    projectUuid?: string;
    conversationId?: string | null;
    initialAssetId?: string;
    canvasImages?: ConversationSourceImage[];
    selectedCanvasImageIds?: string[];
    onConversationIdChange?: (id: string | null) => void | Promise<void>;
    onVersionCreated?: (version: ImageVersion) => void | Promise<void>;
};

const problem = (error: unknown) => (error instanceof Error ? error.message : "服务端会话暂时无法读取");
const confirmedRejection = (error: unknown) =>
    error instanceof ImageConversationApiError &&
    error.code !== "INVALID_RESPONSE" &&
    !["IDEMPOTENCY_CONFLICT", "UPSTREAM_OUTCOME_UNKNOWN"].includes(error.code) &&
    [400, 401, 403, 404, 409, 422, 429].includes(error.status);
const retryableRead = (error: unknown) =>
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "TimeoutError") ||
    (error instanceof ImageConversationApiError &&
        error.code !== "INVALID_RESPONSE" &&
        ([408, 429].includes(error.status) || (error.status >= 500 && error.status < 600)));
const readSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(10_000)]);

async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const run = async () => {
        while (true) {
            const index = cursor++;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
    return results;
}

export function useImageConversation(ownerId: string, options: ImageConversationOptions) {
    const api = useMemo(() => createImageConversationApi(ownerId), [ownerId]);
    const storage = useMemo(() => createWorkspaceStorage("app_state"), [ownerId]);
    const scope = `image-conversation-ui:${options.entrypoint}:${options.canvasExternalId || "standalone"}`;
    const [local, setLocal] = useState(emptyConversationLocalState);
    const localRef = useRef(local),
        writeRef = useRef(Promise.resolve());
    const [ready, setReady] = useState(false),
        [view, setView] = useState<ConversationView | null>(null);
    const viewRef = useRef(view),
        [conversations, setConversations] = useState<ConversationSummary[]>([]);
    const [listCursor, setListCursor] = useState<string | null>(null);
    const [busy, setBusy] = useState(false),
        busyRef = useRef(false);
    const [error, setError] = useState(""),
        [notice, setNotice] = useState(""),
        [connection, setConnection] = useState("正在连接服务端");
    const [reload, setReload] = useState(0);
    const lifetime = useRef<AbortController | null>(null),
        stream = useRef<AbortController | null>(null);
    const callbacks = useRef(options);
    callbacks.current = options;
    const projected = useRef(new Set<string>());
    const id = options.conversationId !== undefined ? options.conversationId : local.conversationId;
    const idRef = useRef(id);
    idRef.current = id;
    const draftKey = id || "new",
        draft = local.drafts[draftKey] || emptyConversationDraft();
    const receipt = id ? local.receipts[id] : undefined;
    const save = useCallback(
        (update: (value: ConversationLocalState) => ConversationLocalState) => {
            const next = update(localRef.current);
            localRef.current = next;
            setLocal(next);
            const write = writeRef.current
                .catch(() => undefined)
                .then(async () => {
                    await storage.setItem(scope, next);
                });
            writeRef.current = write;
            return write;
        },
        [storage, scope],
    );
    const install = (next: ConversationView | null) => {
        viewRef.current = next;
        setView(next);
    };
    const project = async (versions: ImageVersion[], signal: AbortSignal, turns: ImageTurn[] = []) => {
        if (!callbacks.current.onVersionCreated) return;
        for (const version of versions) {
            signal.throwIfAborted();
            if (
                version.source !== "generated" ||
                !version.turnId ||
                projected.current.has(`${version.conversationId}:${version.id}`)
            )
                continue;
            const turn =
                turns.find((item) => item.id === version.turnId) ||
                (await api.turn(version.conversationId, version.turnId, readSignal(signal))).turn;
            if (!conversationVersionCanInstall(version, turn)) continue;
            await callbacks.current.onVersionCreated?.(version);
            signal.throwIfAborted();
            projected.current.add(`${version.conversationId}:${version.id}`);
        }
    };
    const clearReceipt = async (conversationId: string, request: SubmitTurnRequest) =>
        save((current) => {
            const receipts = { ...current.receipts };
            delete receipts[conversationId];
            const drafts = { ...current.drafts },
                existing = drafts[conversationId];
            if (
                existing?.text.trim() === request.text &&
                JSON.stringify(conversationRequestAttachments(existing.attachments)) ===
                    JSON.stringify(
                        (request.attachments || []).map((item) => ({ ...item, purpose: item.purpose || "auto" })),
                    )
            )
                drafts[conversationId] = emptyConversationDraft();
            return { ...current, receipts, drafts };
        });
    const select = async (nextId: string | null) => {
        stream.current?.abort();
        install(null);
        setError("");
        setNotice("");
        await save((current) => ({ ...current, conversationId: nextId }));
        await callbacks.current.onConversationIdChange?.(nextId);
    };
    const refreshList = async (cursor?: string, signal = lifetime.current?.signal) => {
        const page = await api.list(cursor, signal);
        signal?.throwIfAborted();
        setConversations((current) =>
            cursor ? [...new Map([...current, ...page.items].map((item) => [item.id, item])).values()] : page.items,
        );
        setListCursor(page.nextCursor);
    };
    const readView = async (conversationId: string, signal: AbortSignal, forceHistory = false) => {
        const cached = !forceHistory && viewRef.current?.snapshot.id === conversationId ? viewRef.current : null;
        const snapshot = await api.snapshot(conversationId, readSignal(signal));
        if (
            snapshot.entrypoint !== options.entrypoint ||
            (options.entrypoint === "canvas" && snapshot.canvasExternalId !== options.canvasExternalId)
        )
            throw new Error("会话与当前入口不匹配，未发送任何请求。");
        const [messages, versions] = await Promise.all([
            allConversationPages((cursor) => api.messages(conversationId, cursor, readSignal(signal))),
            allConversationPages((cursor) => api.versions(conversationId, cursor, readSignal(signal))),
        ]);
        if ([...messages, ...versions].some((item) => item.conversationId !== conversationId))
            throw new Error("服务端记录与当前会话不一致，未发送任何请求。");
        const turnIds = [
            ...new Set(
                [
                    ...messages.map((message) => message.turnId),
                    ...versions.map((version) => version.turnId),
                    ...(cached?.turns.map((turn) => turn.id) || []),
                    snapshot.pendingTurn?.id,
                ].filter((value): value is string => Boolean(value)),
            ),
        ];
        let turns =
            cached?.turns.filter(
                (turn) =>
                    (turn.state === "completed" || (!turn.taskId && ["failed", "cancelled"].includes(turn.state))) &&
                    turn.id !== snapshot.pendingTurn?.id,
            ) || [];
        if (snapshot.pendingTurn) turns.push(snapshot.pendingTurn);
        const retained = new Set(turns.map((turn) => turn.id));
        const missing = turnIds.filter((turnId) => !retained.has(turnId));
        if (!cached || missing.length > 1)
            turns = await allConversationPages((cursor) => api.turns(conversationId, cursor, readSignal(signal)));
        else if (missing.length) turns.push((await api.turn(conversationId, missing[0], readSignal(signal))).turn);
        const received = new Set(turns.map((turn) => turn.id));
        if (
            turns.some((turn) => turn.conversationId !== conversationId) ||
            turnIds.some((turnId) => !received.has(turnId))
        )
            throw new ImageConversationApiError(200, "INVALID_RESPONSE", "服务端轮次记录不完整或不属于当前会话。");
        signal.throwIfAborted();
        await project(versions, signal, turns);
        signal.throwIfAborted();
        if (snapshot.activeVersion && !versions.some((version) => version.id === snapshot.activeVersionId))
            versions.push(snapshot.activeVersion);
        return { snapshot, messages, versions, turns };
    };
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        void (async () => {
            const stored = await storage.getItem<ConversationLocalState>(scope);
            controller.signal.throwIfAborted();
            if (stored) {
                if (!stored.drafts || !stored.receipts || !("conversationId" in stored))
                    throw new Error("本地未发草稿格式异常，请保留数据并联系管理员。");
                for (const request of Object.values(stored.receipts)) submitTurnRequestSchema.parse(request);
                if (stored.create) createConversationRequestSchema.parse(stored.create);
                localRef.current = stored;
                setLocal(stored);
            }
            setReady(true);
            await refreshList(undefined, controller.signal);
        })().catch((failure) => {
            if (!controller.signal.aborted) setError(problem(failure));
        });
        return () => {
            controller.abort();
            stream.current?.abort();
        };
    }, [storage, scope]);
    useEffect(() => {
        if (!ready || !id) {
            install(null);
            return;
        }
        const controller = new AbortController();
        stream.current?.abort();
        stream.current = controller;
        const signal = controller.signal;
        const pause = () =>
            new Promise<void>((resolve) => {
                const done = () => {
                    clearTimeout(timer);
                    signal.removeEventListener("abort", done);
                    resolve();
                };
                const timer = setTimeout(done, 1500);
                signal.addEventListener("abort", done, { once: true });
                if (signal.aborted) done();
            });
        void (async () => {
            let next: ConversationView | null = null;
            let forceHistory = false;
            while (!signal.aborted) {
                try {
                    if (!next) {
                        setConnection("正在读取服务端记录");
                        next = await readView(id, signal, forceHistory);
                        forceHistory = false;
                        install(next);
                        const pendingReceipt = localRef.current.receipts[id];
                        if (pendingReceipt) {
                            try {
                                await api.byRequest(id, pendingReceipt.clientRequestId, readSignal(signal));
                                await clearReceipt(id, pendingReceipt);
                            } catch (failure) {
                                if (!signal.aborted)
                                    setError(
                                        failure instanceof ImageConversationApiError && failure.status === 404
                                            ? "尚未查到原请求，不代表未提交；请继续查询，不要重新发送。"
                                            : problem(failure),
                                    );
                            }
                        }
                    }
                    signal.throwIfAborted();
                    setConnection("已连接服务端");
                    await api.events(
                        id,
                        next.snapshot.latestEventSeq,
                        async (event) => {
                            if (!next || event.seq <= next.snapshot.latestEventSeq) return;
                            if (event.type === "version.created") await project([event.payload.version], signal);
                            if (event.type === "turn.completed")
                                await project(
                                    next.versions.filter((version) => version.turnId === event.payload.turn.id),
                                    signal,
                                    [event.payload.turn],
                                );
                            next = applyConversationEvent(next, event);
                            install(next);
                            if (event.type === "turn.completed" || event.type === "turn.failed") setNotice("");
                        },
                        signal,
                    );
                } catch (failure) {
                    if (signal.aborted) break;
                    if (failure instanceof ImageConversationApiError && [401, 403, 404].includes(failure.status))
                        throw failure;
                    if (failure instanceof ImageConversationApiError && failure.code === "EVENT_CURSOR_EXPIRED") {
                        setConnection("事件已过期，正在恢复服务端记录");
                        forceHistory = true;
                        next = null;
                    } else if (retryableRead(failure)) setConnection("连接暂时中断，只读重连中");
                    else throw failure;
                }
                if (!signal.aborted) await pause();
            }
        })().catch((failure) => {
            if (!signal.aborted) {
                setError(problem(failure));
                setConnection("服务端记录尚未同步");
            }
        });
        return () => controller.abort();
    }, [api, ready, id, reload]);
    const action = async (run: (signal: AbortSignal) => Promise<void>) => {
        if (busyRef.current || !ready || !lifetime.current) return;
        busyRef.current = true;
        setBusy(true);
        setError("");
        try {
            await run(lifetime.current.signal);
        } catch (failure) {
            if (!lifetime.current.signal.aborted) setError(problem(failure));
        } finally {
            busyRef.current = false;
            if (!lifetime.current.signal.aborted) setBusy(false);
        }
    };
    const finishCreate = async (snapshot: PublicConversationSnapshot, signal: AbortSignal) => {
        signal.throwIfAborted();
        if (
            snapshot.entrypoint !== options.entrypoint ||
            (options.entrypoint === "canvas" && snapshot.canvasExternalId !== options.canvasExternalId)
        )
            throw new Error("创建回执与当前入口不匹配，未发送任何消息。");
        await callbacks.current.onConversationIdChange?.(snapshot.id);
        await save((current) => ({
            ...current,
            create: null,
            conversationId: snapshot.id,
            drafts: {
                ...current.drafts,
                [snapshot.id]: current.drafts.new || emptyConversationDraft(),
                new: emptyConversationDraft(),
            },
        }));
        await refreshList(undefined, signal);
        return snapshot;
    };
    const create = async (initialAssetId: string | undefined, signal: AbortSignal) => {
        const input: CreateConversationRequest = localRef.current.create || {
            clientRequestId: createClientId(),
            entrypoint: options.entrypoint,
            ...(options.entrypoint === "canvas" ? { canvasExternalId: options.canvasExternalId } : {}),
            ...(options.projectUuid ? { projectUuid: options.projectUuid } : {}),
            ...(initialAssetId ? { initialAssetId } : {}),
        };
        await save((current) => ({ ...current, create: input }));
        try {
            return await finishCreate(await api.create(input, signal), signal);
        } catch (failure) {
            if (confirmedRejection(failure)) await save((current) => ({ ...current, create: null }));
            throw failure;
        }
    };
    const submit = (text = draft.text) =>
        action(async (signal) => {
            const requestedText = text.trim();
            if (
                !requestedText ||
                requestedText.length > 10000 ||
                receipt ||
                localRef.current.create ||
                viewRef.current?.snapshot.pendingTurn
            )
                return;
            const snapshot = id ? viewRef.current?.snapshot : await create(options.initialAssetId, signal);
            if (!snapshot) throw new Error("会话尚未读取完成，请稍后发送。");
            const currentDraft = localRef.current.drafts[snapshot.id] || emptyConversationDraft();
            const input: SubmitTurnRequest = {
                clientRequestId: createClientId(),
                expectedStateRevision: snapshot.stateRevision,
                text: requestedText,
                attachments: conversationRequestAttachments(currentDraft.attachments),
                outputPreferences: { mode: "auto" },
            };
            await save((current) => ({ ...current, receipts: { ...current.receipts, [snapshot.id]: input } }));
            try {
                const accepted = await api.submit(snapshot.id, input, signal);
                setNotice(
                    accepted.state === "completed"
                        ? "本轮已完成，正在读取服务端结果。"
                        : "已持久受理，正在等待服务端处理；尚不代表图片已生成。",
                );
                await clearReceipt(snapshot.id, input);
                setReload((value) => value + 1);
            } catch (failure) {
                if (confirmedRejection(failure)) {
                    await save((current) => {
                        const receipts = { ...current.receipts };
                        delete receipts[snapshot.id];
                        return { ...current, receipts };
                    });
                    setReload((value) => value + 1);
                    throw failure;
                }
                setError("发送回执尚未确认，已保留原请求编号；正在查询，不会重新发送。");
                try {
                    await api.byRequest(snapshot.id, input.clientRequestId, signal);
                    await clearReceipt(snapshot.id, input);
                    setReload((value) => value + 1);
                } catch {
                    throw new Error("原请求结果尚未确认。请查询原请求，不要重新发送；刷新不会重发。");
                }
            }
        });
    const queryOriginal = () =>
        action(async (signal) => {
            if (!id) return;
            const pending = localRef.current.receipts[id];
            if (pending) {
                await api.byRequest(id, pending.clientRequestId, signal);
                await clearReceipt(id, pending);
            } else if (viewRef.current?.snapshot.pendingTurn)
                await api.turn(id, viewRef.current.snapshot.pendingTurn.id, signal);
            setReload((value) => value + 1);
        });
    const cancel = () =>
        action(async (signal) => {
            const current = viewRef.current?.snapshot;
            if (!current?.pendingTurn || !current.pendingTurn.assistant.canCancel) return;
            const result = await api.cancel(current.id, current.pendingTurn.id, current.stateRevision, signal);
            setNotice(
                result.disposition === "cancelled_before_submission"
                    ? "本轮已在提交前取消。"
                    : result.disposition === "detached_task_continues"
                      ? "已停止采用本轮结果；原任务可能仍在执行，不会自动切换当前图。"
                      : "本轮已经结束，正在读取实际结果。",
            );
            setReload((value) => value + 1);
        });
    const upload = (files: File[]) =>
        action(async (signal) => {
            if (receipt || localRef.current.create || viewRef.current?.snapshot.pendingTurn) return;
            if (files.length + draft.attachments.length > 16) throw new Error("每轮最多添加 16 张图片。");
            if (files.some((file) => !file.type.startsWith("image/")))
                throw new Error("此会话入口目前只接收图片原件。");
            if (!files.length) return;
            const uploadFile = async (file: File) => {
                const assetId = await uploadServerAsset(
                    file,
                    { source: "image-conversation" },
                    {
                        expectedOwnerId: ownerId,
                        signal,
                        ...(options.projectUuid ? { projectId: options.projectUuid } : {}),
                        clientReferenceId: createClientId(),
                    },
                );
                signal.throwIfAborted();
                return { assetId, name: file.name };
            };
            let conversationId = id;
            let filesToUpload = files;
            if (!conversationId) {
                const first = await uploadFile(files[0]!);
                const snapshot = await create(first.assetId, signal);
                conversationId = snapshot.id;
                filesToUpload = files.slice(1);
            }
            await mapConcurrent(filesToUpload, 4, async (file) => {
                await addAttachments([await uploadFile(file)], conversationId!);
            });
        });
    const addAttachments = async (items: ConversationAttachment[], key: string) => {
        await save((current) => {
            const currentDraft = current.drafts[key] || emptyConversationDraft();
            return {
                ...current,
                drafts: {
                    ...current.drafts,
                    [key]: {
                        ...currentDraft,
                        attachments: mergeConversationAttachments(currentDraft.attachments, items),
                    },
                },
            };
        });
    };
    const attachAssets = (items: ConversationAttachment[]) =>
        action(async (signal) => {
            if (receipt || localRef.current.create || viewRef.current?.snapshot.pendingTurn) return;
            signal.throwIfAborted();
            if (useUserStore.getState().user?.id !== ownerId) throw new Error("员工身份已变化，未添加图片。");
            await addAttachments(items, draftKey);
            setNotice("图片已加入本轮草稿，尚未发送或生成。");
        });
    const attachImages = (images: ConversationSourceImage[], purpose?: AttachmentPurpose) =>
        action(async (signal) => {
            if (receipt || localRef.current.create || viewRef.current?.snapshot.pendingTurn || !images.length) return;
            if (purpose === "new_base" && images.length !== 1) throw new Error("每轮只能指定一张修改底图。");
            const selected = new Map(images.map((image) => [image.id, image]));
            const sourceId = idRef.current,
                key = sourceId || "new";
            const assertCurrent = () => {
                signal.throwIfAborted();
                if (useUserStore.getState().user?.id !== ownerId || idRef.current !== sourceId)
                    throw new Error("当前账号或会话已变化，未加入其他会话。");
            };
            assertCurrent();
            const candidates = [...selected.values()].map(
                (image) => callbacks.current.canvasImages?.find((item) => item.id === image.id) || image,
            );
            const resolved = await Promise.all(
                candidates.map(async (image) => {
                    const assetId = image.serverAssetId || serverMediaId(image.image);
                    if (assetId) return { ...image, assetId };
                    const source = (image.storageKey ? await readMediaSource(image.storageKey) : null) ||
                        (await readUploadedMedia(ownerId, image.storageKey || image.image));
                    return { ...image, assetId: source ? serverMediaId(source) : "" };
                }),
            );
            assertCurrent();
            const prepared = [
                ...new Map(
                    resolved.map((image) => [image.assetId || image.storageKey || image.image || image.id, image]),
                ).values(),
            ];
            const currentDraft = localRef.current.drafts[key] || emptyConversationDraft();
            const currentIds = new Set(currentDraft.attachments.map((item) => item.assetId));
            if (prepared.every((image) => Boolean(image.assetId))) {
                const newIncomingCount = prepared.filter((image) => !currentIds.has(image.assetId!)).length;
                if (currentIds.size + newIncomingCount > 16) throw new Error("每轮最多添加 16 张图片。");
            }
            const attachments = await mapConcurrent(prepared, 4, async (image) => {
                assertCurrent();
                let assetId = image.assetId;
                if (!assetId) {
                    const { ensureCloudMedia } = await import("@/services/canvas-cloud-media");
                    assertCurrent();
                    const source = await ensureCloudMedia(
                        ownerId,
                        { url: image.image, storageKey: image.storageKey, name: image.title },
                        { source: "image-conversation-reference" },
                    );
                    assertCurrent();
                    assetId = serverMediaId(source);
                    if (!assetId) throw new Error("图片原件未保存为正式素材，未添加到会话。");
                }
                assertCurrent();
                return { assetId, name: image.title, ...(purpose ? { purpose } : {}) };
            });
            await addAttachments([...new Map(attachments.map((item) => [item.assetId, item])).values()], key);
            setNotice("图片已加入本轮草稿，尚未发送或生成。");
        });
    const selectBase = (assetId: string, name: string) => attachAssets([{ assetId, name, purpose: "new_base" }]);
    const changeDraft = (update: (current: ConversationDraft) => ConversationDraft) => {
        void save((current) => ({
            ...current,
            drafts: { ...current.drafts, [draftKey]: update(current.drafts[draftKey] || emptyConversationDraft()) },
        })).catch((failure) => setError(`未发草稿保存失败：${problem(failure)}`));
    };
    return {
        ready,
        view,
        conversations: conversations.filter(
            (item) =>
                item.entrypoint === options.entrypoint &&
                (options.entrypoint !== "canvas" || item.canvasExternalId === options.canvasExternalId),
        ),
        listCursor,
        id,
        draft,
        receipt,
        createReceipt: local.create,
        busy,
        error,
        notice,
        connection,
        submit,
        upload,
        attachAssets,
        attachImages,
        selectBase,
        cancel,
        queryOriginal,
        changeDraft,
        select: (nextId: string | null) =>
            action(async () => {
                await select(nextId);
            }),
        refresh: () => {
            setReload((value) => value + 1);
            void refreshList().catch((failure) => setError(problem(failure)));
        },
        moreConversations: () =>
            action(async (signal) => {
                if (listCursor) await refreshList(listCursor, signal);
            }),
        recoverCreate: () =>
            action(async (signal) => {
                const pending = localRef.current.create;
                if (!pending) return;
                try {
                    await finishCreate(await api.createByRequest(pending.clientRequestId, signal), signal);
                } catch (failure) {
                    if (failure instanceof ImageConversationApiError && failure.status === 404)
                        throw new Error(
                            "原编号尚未查到，已保留创建回执。可继续查询，或手动按原编号完成空会话创建；不会自动发送消息。",
                        );
                    throw failure;
                }
            }),
        completeCreate: () =>
            action(async (signal) => {
                if (localRef.current.create) {
                    await create(undefined, signal);
                    setNotice("空会话创建已确认，未发送草稿；请检查后手动发送。");
                }
            }),
    };
}
