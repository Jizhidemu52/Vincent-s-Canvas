import type { PublicConversationSnapshot } from "../../../../shared/image-conversation-public";
import { createConversationRequestSchema, submitTurnRequestSchema } from "../../../../shared/image-conversation-schemas";
import { conversationSnapshotSchema, imageTurnSchema, imageVersionSchema } from "../../../../shared/image-conversation-public-schemas";
import {
    buildDesignConversationText, designConversationCreateRequest, designConversationExecutionId, designConversationFingerprint,
    designConversationTurnRequest, designReferenceAsset, projectDesignConversationTurn,
    type DesignConversationInput, type DesignConversationTask, type DesignReference,
} from "../../components/canvas/design-discussion/conversation-execution";
import type { createImageConversationApi } from "./image-conversations";

type ConversationApi = Pick<ReturnType<typeof createImageConversationApi>, "create" | "createByRequest" | "submit" | "byRequest" | "snapshot" | "turn" | "versions">;
type Storage = { setItem(key: string, value: unknown): Promise<unknown>; iterate(visitor: (value: unknown) => void): Promise<unknown> };
type Options = { api: ConversationApi; storage: Storage; ownerId: string; canvasExternalId: string;
    uploadReference(reference: DesignReference): Promise<DesignReference>; assertOwner(): Promise<unknown>;
    assertWritable?(): void | Promise<void>;
    onChange(tasks: DesignConversationTask[]): void };
const slotOperations = new Map<string, Promise<unknown>>();
async function withSlotLock<T>(id: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (globalThis.navigator?.locks) return await navigator.locks.request(`design-image:${id}`, { signal }, operation);
    const previous = slotOperations.get(id) || Promise.resolve();
    const pending = previous.catch(() => undefined).then(() => { signal.throwIfAborted(); return operation(); });
    slotOperations.set(id, pending);
    void pending.finally(() => { if (slotOperations.get(id) === pending) slotOperations.delete(id); }).catch(() => undefined);
    return pending;
}
const message = (error: unknown) => error instanceof Error ? error.message : "会话请求尚未确认";
const rejected = (error: unknown) => error !== null && typeof error === "object" && "status" in error && "code" in error
    && error.code !== "INVALID_RESPONSE" && error.code !== "UPSTREAM_OUTCOME_UNKNOWN"
    && [400, 401, 403, 404, 409, 413, 422, 429].includes(Number(error.status));
const isTask = (value: unknown): value is DesignConversationTask => value !== null && typeof value === "object" && "kind" in value && value.kind === "image-conversation-execution";

export function createDesignConversationController(options: Options) {
    const { api, storage, ownerId, canvasExternalId } = options;
    const tasks = new Map<string, DesignConversationTask>();
    const operations = new Map<string, Promise<DesignConversationTask>>();
    const lifetime = new AbortController();
    let polling = false;
    const emit = () => { if (!lifetime.signal.aborted) options.onChange([...tasks.values()].sort((left, right) => left.startedAt - right.startedAt)); };
    const assertOwner = async () => { lifetime.signal.throwIfAborted(); await options.assertOwner(); lifetime.signal.throwIfAborted(); };
    const assertWritable = async () => { await assertOwner(); await options.assertWritable?.(); lifetime.signal.throwIfAborted(); };
    const publish = (task: DesignConversationTask) => { tasks.set(task.id, task); emit(); return task; };
    const save = async (task: DesignConversationTask, required = false) => {
        lifetime.signal.throwIfAborted();
        const stored = { ...task, persistenceError: "" };
        try { await storage.setItem(task.id, stored); lifetime.signal.throwIfAborted(); return publish(stored); }
        catch (error) {
            const unsaved = publish({ ...task, persistenceError: `回执保存失败：${message(error)}` });
            if (required || lifetime.signal.aborted) throw error;
            return unsaved;
        }
    };
    const snapshot = (value: unknown, task: DesignConversationTask) => {
        const parsed = conversationSnapshotSchema.parse(value);
        if (parsed.entrypoint !== "canvas" || parsed.canvasExternalId !== canvasExternalId
            || task.conversationExecution.conversationId && parsed.id !== task.conversationExecution.conversationId) throw new Error("恢复的会话不属于当前画布，未发送任何请求。");
        return parsed;
    };
    const versions = async (conversationId: string) => {
        const found = [], cursors = new Set<string>();
        let cursor: string | undefined;
        do {
            const page = await api.versions(conversationId, cursor, lifetime.signal);
            for (const item of page.items) {
                const version = imageVersionSchema.parse(item);
                if (version.conversationId !== conversationId) throw new Error("图片版本不属于原会话，已停止接收结果。");
                found.push(version);
            }
            cursor = page.nextCursor || undefined;
            if (cursor && cursors.has(cursor)) throw new Error("版本分页游标重复，未重复执行任务。");
            if (cursor) cursors.add(cursor);
        } while (cursor);
        return found;
    };
    const read = async (task: DesignConversationTask) => {
        await assertOwner();
        let current = task, receipt = current.conversationExecution;
        if (!receipt.conversationId) {
            if (!receipt.createDispatchStartedAt || !receipt.createRequest) return save(current);
            const restored = snapshot(await api.createByRequest(receipt.createRequest.clientRequestId, lifetime.signal), current);
            current = await save({ ...current, status: "paused", queryError: "", failureReason: "原会话已恢复，图片请求尚未发送；可继续已记录的生成操作。",
                conversationExecution: { ...receipt, conversationId: restored.id, phase: "ready_to_submit", latestEventSeq: restored.latestEventSeq } });
            receipt = current.conversationExecution;
        }
        if (!receipt.turnDispatchStartedAt || !receipt.turnRequest) return save({ ...current, status: "paused", queryError: "",
            failureReason: "原会话已恢复，图片请求尚未发送；可继续已记录的生成操作。" });
        const turn = imageTurnSchema.parse((receipt.turnId ? await api.turn(receipt.conversationId!, receipt.turnId, lifetime.signal)
            : await api.byRequest(receipt.conversationId!, receipt.turnRequest.clientRequestId, lifetime.signal)).turn);
        const outputs = turn.outputVersionId ? await versions(turn.conversationId) : [];
        await assertOwner();
        return save(projectDesignConversationTurn(current, turn, outputs));
    };
    const readSafely = async (task: DesignConversationTask) => {
        try { return await read(task); }
        catch (error) {
            if (lifetime.signal.aborted) throw error;
            return save({ ...tasks.get(task.id) || task, queryError: `原请求尚未查明：${message(error)}；仅查询，不会重新提交。` });
        }
    };
    const prepare = async (task: DesignConversationTask) => {
        if (task.conversationExecution.createRequest) return task;
        buildDesignConversationText(task, []);
        const assets = [];
        for (const reference of task.references) {
            await assertWritable();
            const uploaded = await options.uploadReference(reference);
            assets.push(designReferenceAsset({ ...reference, ...uploaded }));
        }
        buildDesignConversationText(task, assets);
        const createRequest = designConversationCreateRequest(task.id, canvasExternalId, task, assets);
        return save({ ...task, references: assets, conversationExecution: { ...task.conversationExecution, assets, createRequest } }, true);
    };
    const dispatch = async (task: DesignConversationTask) => {
        await assertWritable();
        let current = await prepare(task), receipt = current.conversationExecution;
        if (receipt.turnDispatchStartedAt) return readSafely(current);
        let created: PublicConversationSnapshot;
        if (receipt.conversationId) created = snapshot(await api.snapshot(receipt.conversationId, lifetime.signal), current);
        else {
            if (receipt.createDispatchStartedAt) return readSafely(current);
            current = await save({ ...current, status: "submitting", conversationExecution: { ...receipt, phase: "creating", createDispatchStartedAt: new Date().toISOString() } }, true);
            try { await assertWritable(); created = snapshot(await api.create(current.conversationExecution.createRequest!, lifetime.signal), current); }
            catch (error) {
                if (lifetime.signal.aborted) throw error;
                current = await save({ ...current, status: rejected(error) ? "failed" : "uncertain", failureReason: message(error),
                    conversationExecution: { ...current.conversationExecution, phase: rejected(error) ? "failed" : "create_unknown" } });
                return rejected(error) ? current : readSafely(current);
            }
            current = await save({ ...current, conversationExecution: { ...current.conversationExecution, conversationId: created.id, phase: "ready_to_submit", latestEventSeq: created.latestEventSeq } }, true);
        }
        receipt = current.conversationExecution;
        const input = receipt.turnRequest || designConversationTurnRequest(current, created);
        await assertWritable();
        current = await save({ ...current, status: "submitting", queryError: "", failureReason: "",
            conversationExecution: { ...receipt, turnRequest: input, turnDispatchStartedAt: new Date().toISOString(), phase: "submitting" } }, true);
        try {
            await assertWritable();
            const accepted = await api.submit(created.id, input, lifetime.signal);
            current = await save({ ...current, status: "waiting", conversationExecution: { ...current.conversationExecution, phase: "accepted", turnId: accepted.turnId } }, true);
        } catch (error) {
            if (lifetime.signal.aborted) throw error;
            current = await save({ ...tasks.get(current.id) || current, status: rejected(error) ? "failed" : "uncertain", failureReason: message(error),
                conversationExecution: { ...(tasks.get(current.id) || current).conversationExecution, phase: rejected(error) ? "failed" : "turn_unknown" } });
            return rejected(error) ? current : readSafely(current);
        }
        return readSafely(current);
    };
    const run = (id: string, operation: () => Promise<DesignConversationTask>) => {
        const existing = operations.get(id);
        if (existing) return existing;
        const pending = withSlotLock(id, lifetime.signal, async () => {
            await storage.iterate(value => { if (isTask(value) && value.id === id) collect(value, true); });
            return operation();
        }).finally(() => { operations.delete(id); });
        operations.set(id, pending);
        return pending;
    };
    const collect = (value: unknown, replace = false) => {
        if (!isTask(value) || value.ownerId !== ownerId || value.projectId !== canvasExternalId) return;
        if (value.id !== designConversationExecutionId(ownerId, canvasExternalId, value) || value.requestId !== value.id
            || value.conversationExecution?.schemaVersion !== 1) throw new Error("图片执行回执格式异常；保留原记录，未重新提交。");
        if (value.conversationExecution.createRequest) {
            const create = createConversationRequestSchema.parse(value.conversationExecution.createRequest);
            if (create.clientRequestId !== `${value.id}:create` || create.entrypoint !== "canvas" || create.canvasExternalId !== canvasExternalId) throw new Error("原会话创建请求身份不一致，未重新提交。");
        }
        if (value.conversationExecution.turnRequest) {
            const turn = submitTurnRequestSchema.parse(value.conversationExecution.turnRequest);
            if (turn.clientRequestId !== `${value.id}:turn`) throw new Error("原会话轮次请求身份不一致，未重新提交。");
        }
        if (replace || !operations.has(value.id) || !tasks.has(value.id)) tasks.set(value.id, value);
    };
    return {
        has: (id: string) => tasks.has(id),
        async load() { await storage.iterate(value => collect(value)); emit(); },
        async start(input: DesignConversationInput) {
            if (input.generationAllowed !== true || input.mediaKind === "video") throw new Error("本轮没有明确的图片生成操作，未提交生成。");
            const id = designConversationExecutionId(ownerId, canvasExternalId, input);
            return run(id, async () => {
                await assertWritable();
                const existing = tasks.get(id);
                if (existing) return existing;
                buildDesignConversationText(input, []);
                const task: DesignConversationTask = { ...structuredClone(input), kind: "image-conversation-execution", id, requestId: id,
                    ownerId, projectId: canvasExternalId, mediaKind: "image", model: "自动图片服务", modelId: "", status: "preparing",
                    startedAt: Date.now(), observing: true, resultUrls: [], resultVersions: [], failureReason: "", queryError: "", persistenceError: "",
                    feedback: { status: "unreviewed", note: "" }, feedbackHistory: [],
                    conversationExecution: { schemaVersion: 1, phase: "preparing", fingerprint: designConversationFingerprint(input), assets: [], createRequest: null,
                        createDispatchStartedAt: null, conversationId: null, turnRequest: null, turnDispatchStartedAt: null, turnId: null, latestEventSeq: 0 } };
                await save(task, true);
                try { return await dispatch(task); }
                catch (error) {
                    if (lifetime.signal.aborted) throw error;
                    const current = tasks.get(id) || task;
                    return save({ ...current, status: current.conversationExecution.createDispatchStartedAt ? "uncertain" : "failed", failureReason: message(error) });
                }
            });
        },
        async refreshAll() {
            if (polling) return;
            polling = true;
            try {
                await assertOwner();
                for (const task of tasks.values()) if (task.observing !== false && (task.persistenceError || task.queryError
                    || ["preparing", "submitting", "uncertain", "waiting", "processing", "paused", "detached"].includes(task.status))) await run(task.id, () => readSafely(tasks.get(task.id)!));
            } finally { polling = false; }
        },
        async action(id: string, action: string) {
            if (!tasks.has(id)) return;
            return run(id, async () => {
                await assertOwner();
                const task = tasks.get(id)!;
                if (action === "stop") return save({ ...task, observing: false });
                const current = await save({ ...task, observing: true }, true);
                if (action === "continue" && !current.conversationExecution.turnDispatchStartedAt
                    && ["preparing", "ready_to_submit"].includes(current.conversationExecution.phase)) return dispatch(current);
                return readSafely(current);
            });
        },
        async saveReview(id: string, review: unknown) {
            if (!tasks.has(id)) return;
            await run(id, async () => {
                await assertOwner();
                const task = tasks.get(id)!;
                return task.status === "success" ? save({ ...task, review }, true) : task;
            });
        },
        async saveFeedback(id: string, feedback: DesignConversationTask["feedback"]) {
            if (!tasks.has(id)) throw new Error("只有实际生成结果可以记录反馈。");
            await run(id, async () => {
                await assertOwner();
                const task = tasks.get(id)!;
                if (task.status !== "success" || !task.resultUrls.length) throw new Error("只有实际生成结果可以记录反馈。");
                return save({ ...task, feedback, feedbackHistory: [...task.feedbackHistory, feedback] }, true);
            });
        },
        dispose() { lifetime.abort(); },
    };
}
