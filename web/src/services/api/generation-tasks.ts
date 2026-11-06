import { nanoid } from "nanoid";
import { generationErrorMessage, generationSubmissionRejected } from "@/lib/generation-feedback";
import { cancelOriginalTask } from "@/lib/generation-task-cancel";
import type { PromptInputData } from "../../../../shared/prompt-contracts";
import { getPromptCompilation } from "./prompt-compilations";
import type { TaskSubmission } from "../../../../shared/task-contracts";

import { dataUrlToFile } from "@/lib/image-utils";
import { imageReferenceFileError } from "@/lib/image-reference-policy";
import { imageModelProfile } from "@/lib/image-model-settings";
import { createClientId } from "@/lib/client-id";
import { assertServerAssetContent, fetchServerAsset, ServerAssetContentError, uploadServerAsset } from "@/services/api/server-assets";
import { observeTask } from "./task-observation";
import { classifyTaskRecovery, submissionInvestigationMessage } from "./task-result-reconciliation";
import { watchTaskEvents } from "./task-events";
import { readTaskSnapshot } from "./task-snapshot-query";
import { workspaceOwnerHeaders } from "@/services/api/workspace-owner";
import { imageToDataUrl } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import { fingerprintImage, type ArchivedReference, type GenerationDraftInput, type GenerationInputArchive } from "./generation-history";
import { readImageOptions } from "@/lib/image-advanced-settings";
import { getBusinessConfig } from "./business-config";
import { requireToolKey, resolveConfiguredToolModel } from "./tool-runtime";
import { quickImageModelId, type QuickImageAction } from "@/lib/quick-image-tools";

type ImageOperationType = "image_generation" | "inpaint" | "upscale" | "batch_image" | "seamless_stitch";
type PublicModel = { id: string; name: string; modelId: string; capabilities: string[]; creditCost: number; rmbCost: number };
export type ImageGenerationModel = PublicModel;
export type QueuedTaskProgress = {
    taskId: string;
    status: string;
    runtime: "worker" | "demo";
    phase: "waiting" | "delayed" | "processing" | "preparing" | "paused" | "complete";
    queuePosition: number | null;
    estimatedWaitSeconds: number | null;
    estimatedRemainingSeconds: number | null;
    sampleCount: number;
    estimateReason: string | null;
    retryAfterSeconds: number | null;
};
export type QueuedTask = { prompt?: string; summaryZh?: string; userInput?: PromptInputData; optimized?: boolean; id: string; requestId: string; operationType?: string; attempts?: number; status: string; stage?: string; errorCode?: string | null; upstreamTaskId?: string | null; submissionStartedAt?: string | null; resultUrls: string[]; failureReason: string | null; createdAt?: string; updatedAt?: string; userId?: string; ownerUserId?: string; parameters?: Record<string, unknown> };

/** The server snapshot keeps exclusion text out of the editable/replay prompt. */
export function imageTaskPrompts(task: Pick<QueuedTask, "prompt" | "parameters">, fallback = ""): { prompt: string; submittedPrompt?: string } {
    const snapshot = task.parameters?.promptExclusions;
    if (snapshot && typeof snapshot === "object" && "sourcePrompt" in snapshot && "submittedPrompt" in snapshot
        && typeof snapshot.sourcePrompt === "string" && typeof snapshot.submittedPrompt === "string" && snapshot.submittedPrompt === task.prompt) {
        return { prompt: snapshot.sourcePrompt, submittedPrompt: snapshot.submittedPrompt };
    }
    return { prompt: task.prompt ?? fallback, submittedPrompt: undefined };
}
export class QueuedTaskPausedError extends Error {
    readonly taskId: string;
    readonly requestId: string;
    readonly canRecover: boolean;
    readonly recovery: "resume" | "investigate";
    constructor(readonly task: QueuedTask, message?: string) {
        const canRecover = classifyTaskRecovery(task) === "resume";
        super(`${message || task.failureReason || "任务查询已暂停"}（任务 ${task.id}）。${canRecover ? "可恢复查询原任务，不会重新生成。" : submissionInvestigationMessage}`);
        this.name = "QueuedTaskPausedError";
        this.taskId = task.id;
        this.requestId = task.requestId;
        this.canRecover = canRecover;
        this.recovery = canRecover ? "resume" : "investigate";
    }
}
export class QueuedTaskFailedError extends Error {
    readonly taskId: string;
    readonly requestId: string;
    constructor(readonly task: QueuedTask) {
        super(task.failureReason || "生成任务已失败或取消");
        this.name = "QueuedTaskFailedError";
        this.taskId = task.id;
        this.requestId = task.requestId;
    }
}
/** A POST may have been accepted, or an accepted task could not be settled locally. Never generate again to recover it. */
export class QueuedTaskSubmissionUncertainError extends Error {
    constructor(readonly requestId: string, readonly taskId?: string, readonly cause?: unknown) {
        super(`原任务状态待核查${taskId ? `（任务 ${taskId}）` : ""}，请查询原任务，勿重复生成。`);
        this.name = "QueuedTaskSubmissionUncertainError";
    }
}
export class QueuedTaskHttpError extends Error {
    get submissionRejected() { return generationSubmissionRejected(this.status, this.code); }
    constructor(readonly status: number, readonly diagnostic: string, readonly code?: string) { super(generationErrorMessage(diagnostic, status, code)); this.name = "QueuedTaskHttpError"; }
}
export type GenerationVideoCapability = { seconds: readonly [number, number]; resolutions: readonly string[]; sizes: readonly string[]; minImages: number; maxImages: number; firstFrameRequired: boolean; supportsAudio: boolean };
export type GenerationCapabilityModel = { id: string; name: string; modelId: string; capability: GenerationVideoCapability };
export type QueuedMediaInput = { modelId: string; resolvedModel?: PublicModel; prompt: string; promptInput?: PromptInputData; operationType: string; toolKey?: string; parameters?: Record<string, unknown>; sourceFiles?: File[]; sourceUrls?: string[]; sourceMetadata?: Record<string, unknown>[]; sourceOrder?: Array<{ kind: "file" | "url"; index: number }>; signal?: AbortSignal; cancelOnAbort?: () => boolean; onSubmissionStarted?: (requestId: string) => void | Promise<void>; onSubmitted?: (task: QueuedTask) => void | Promise<void> };
export type QueuedBatchItem = QueuedTask & { itemIndex: number };
export type QueuedBatchFailure = { index: number; reason: string };
export type QueuedBatchAction = "pause" | "resume" | "cancel";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
        ...init,
        credentials: "include",
        headers: { "content-type": "application/json", ...init?.headers, ...workspaceOwnerHeaders() },
    }).catch(error => {
        if (init?.signal?.aborted) throw error;
        throw new Error(generationErrorMessage(error), { cause: error });
    });
    if (!response.ok) {
        if (response.status === 401) useUserStore.getState().expireSession();
        const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string; code?: string };
        throw new QueuedTaskHttpError(response.status, body.message || "任务提交失败", body.error || body.code);
    }
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export function cancelQueuedTask(id: string) {
    const ownerId = useUserStore.getState().user?.id;
    return cancelOriginalTask(id, {
        read: getQueuedTask,
        cancel: taskId => request<void>(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" }),
        assertCurrent: () => {
            if (!ownerId || useUserStore.getState().user?.id !== ownerId || useUserStore.getState().user?.status !== "active") throw new Error("员工会话已变化，未继续取消任务。");
        },
    });
}

export function createImageTaskRequests(input: {
    quickImageAction?: QuickImageAction;
    toolKey?: string;
    requestId: string;
    projectId: string;
    operationType: ImageOperationType;
    modelConfigId: string;
    prompt: string;
    promptInput?: PromptInputData;
    parameters?: Record<string, unknown>;
    sourceUrls: string[];
    count: number;
}) {
    return Array.from({ length: 1 }, (_, index) => ({
        requestId: `${input.requestId}:${index}`,
        projectId: input.projectId,
        operationType: input.operationType,
        toolKey: requireToolKey(input.operationType, input.toolKey),
        ...(!input.quickImageAction ? { modelConfigId: input.modelConfigId, prompt: input.prompt, ...(input.promptInput ? { promptInput: input.promptInput } : {}) } : {}),
        parameters: input.quickImageAction ? { quickImageAction: input.quickImageAction } : { ...input.parameters, count: 1, n: 1 },
        sourceUrls: input.sourceUrls,
        priority: "normal" as const,
    } satisfies Omit<TaskSubmission, "promptInput" | "prompt"> & { prompt?: string; promptInput?: PromptInputData }));
}

export async function requestQueuedImages(input: { quickImageAction?: QuickImageAction; modelId: string; resolvedModel?: PublicModel; prompt: string; promptInput?: PromptInputData; onOptimizing?: () => void; onCompiled?: (prompt: string, optimized: boolean, submittedPrompt?: string) => void; count: number; operationType: ImageOperationType; tool?: string; parameters?: Record<string, unknown>; draft?: GenerationDraftInput; references?: ReferenceImage[]; requestId?: string; signal?: AbortSignal; cancelOnAbort?: () => boolean; onSubmissionStarted?: () => void | Promise<void>; onSubmitted?: (taskIds: string[]) => void | Promise<void> }) {
    input.signal?.throwIfAborted();
    const ownerId = useUserStore.getState().user?.id;
    if (!ownerId) throw new Error("当前账号不可用");
    const assertOwner = () => { if (useUserStore.getState().user?.id !== ownerId) throw new Error("员工会话已变化，已取消生成提交"); };
    input.signal?.throwIfAborted();
    const toolKey = requireToolKey(input.operationType, input.tool);
    // Keep the exact model snapshot used to normalize parameters. A concurrent
    // admin rebind is rejected by the server, never silently renormalized here.
    const preset = Boolean(input.quickImageAction);
    if (preset && input.references?.length !== 1) throw new Error("请只添加一张原图");
    const model = preset ? undefined : input.resolvedModel || await resolvePublicModel(input.modelId, input.operationType, toolKey);
    assertOwner();
    input.signal?.throwIfAborted();
    const referenceProfile = model ? imageModelProfile(model.id, [model]) : imageModelProfile(quickImageModelId(input.quickImageAction!));
    const sourceUrls: string[] = [];
    const archivedReferences: ArchivedReference[] = [];
    for (const [referenceIndex, reference] of (input.references || []).entries()) {
        input.signal?.throwIfAborted();
        const dataUrl = await readGenerationReferenceDataUrl(reference, input.signal);
        input.signal?.throwIfAborted();
        const file = dataUrlToFile({ ...reference, dataUrl });
        input.signal?.throwIfAborted();
        const isMarkup = referenceProfile.supportsMarkup && input.draft?.markupReferenceIndex === referenceIndex;
        const referenceError = isMarkup ? file.type !== "image/png" ? "标注层必须为独立透明 PNG" : file.size > 50 * 1024 * 1024 ? "标注层不能超过 50 MB" : "" : imageReferenceFileError(file, referenceProfile);
        if (referenceError) throw new Error(referenceError);
        const hash = await fingerprintImage(file);
        assertOwner();
        const assetId = await uploadImageReference(reference, file, hash, ownerId, input.signal);
        assertOwner();
        input.signal?.throwIfAborted();
        sourceUrls.push(`/api/assets/${assetId}/content`);
        archivedReferences.push({ id: reference.id, name: reference.name, originalFileName: reference.originalFileName, type: file.type, bytes: file.size, sha256: hash, url: sourceUrls[sourceUrls.length - 1]!, sourceAssetId: assetId });
    }

    const rootRequestId = input.requestId || createClientId();
    const projectId = currentProjectId("image-workbench");
    const archivedConfig = input.draft ? { ...input.draft.config } : undefined;
    if (archivedConfig && input.draft?.markupReferenceIndex !== undefined) {
        const options = readImageOptions(archivedConfig.imageOptions);
        delete options.markup_reference;
        archivedConfig.imageOptions = JSON.stringify(options);
    }
    const archive: GenerationInputArchive | undefined = input.draft && model ? {
        version: 1, ownerId, modelConfigId: model.id, modelId: model.modelId,
        prompt: input.draft.prompt, userInput: input.promptInput, effectivePrompt: input.prompt, config: { ...archivedConfig!, model: model.id, imageModel: model.id, count: "1" },
        parameters: { ...input.parameters }, references: archivedReferences, maskReferenceIndex: input.draft.maskReferenceIndex,
        ...(input.draft.markupReferenceIndex !== undefined ? { markupReferenceIndex: input.draft.markupReferenceIndex } : {}),
    } : undefined;
    const taskRequests = createImageTaskRequests({
        quickImageAction: input.quickImageAction,
        toolKey,
        requestId: rootRequestId,
        projectId,
        operationType: input.operationType,
        modelConfigId: model?.id || "",
        prompt: input.prompt,
        promptInput: input.promptInput,
        parameters: { ...input.parameters, ...(input.tool ? { tool: input.tool } : {}), ...(archive ? { inputArchive: archive } : {}) },
        sourceUrls,
        count: input.count,
    });
    input.signal?.throwIfAborted();
    const submitted = await Promise.allSettled(
        taskRequests.map(async (task) => {
            assertOwner();
            input.signal?.throwIfAborted();
            await input.onSubmissionStarted?.();
            assertOwner();
            input.signal?.throwIfAborted();
            try {
                if (input.promptInput) input.onOptimizing?.();
                const result = await request<{ task: QueuedTask }>("/api/tasks", {
                method: "POST",
                body: JSON.stringify(task),
                signal: input.signal,
                });
                if (typeof result?.task?.id !== "string" || !result.task.id.trim()) throw new Error("服务器未返回任务编号");
                if (result.task.prompt !== undefined) { const prompts = imageTaskPrompts(result.task); input.onCompiled?.(prompts.prompt, result.task.optimized === true, prompts.submittedPrompt); }
                return result;
            } catch (error) {
                if (error instanceof QueuedTaskHttpError && error.submissionRejected) throw error;
                // Both the optimizer and image submission are looked up; neither POST is replayed.
                const [original] = await Promise.all([getQueuedTaskByRequestId(task.requestId).catch(() => null), input.promptInput ? getPromptCompilation(task.requestId).catch(() => null) : Promise.resolve(null)]);
                if (original?.id) { const prompts = imageTaskPrompts(original, input.prompt); input.onCompiled?.(prompts.prompt, original.optimized === true, prompts.submittedPrompt); return { task: original }; }
                throw new QueuedTaskSubmissionUncertainError(task.requestId, undefined, error);
            }
        }),
    );
    const rejected = submitted.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason instanceof Error ? rejected.reason : new Error("任务提交失败");
    const ids = submitted.map((result) => (result as PromiseFulfilledResult<{ task: QueuedTask }>).value.task.id);
    try {
        try { await input.onSubmitted?.(ids); }
        catch (error) { if (input.signal?.aborted) throw error; throw new QueuedTaskSubmissionUncertainError(taskRequests[0]!.requestId, ids[0], error); }
        void refreshSessionBalance();
        const tasks = await waitForTasks(ids, input.signal, undefined, true);
        const failed = tasks.find((task) => task.status === "failed" || task.status === "cancelled");
        if (failed) throw new QueuedTaskFailedError(failed);
        return tasks.flatMap((task) => task.resultUrls.map((dataUrl) => ({ id: nanoid(), dataUrl, sourceTaskId: task.id, ...imageTaskPrompts(task, input.prompt), userInput: task.userInput || input.promptInput, optimized: task.optimized === true })));
    } catch (error) {
        if (input.signal?.aborted && (input.cancelOnAbort?.() ?? true)) await cancelTasks(ids);
        throw error;
    } finally {
        void refreshSessionBalance();
    }
}

export async function requestQueuedImageBatch(input: { modelId: string; resolvedModel?: PublicModel; prompt: string; promptInput?: PromptInputData; onOptimizing?: () => void; onCompiled?: (prompt: string, optimized: boolean, submittedPrompt?: string) => void; parameters?: Record<string, unknown>; files: Array<{ file: File; title: string }>; onSubmissionStarted?: (requestId: string, items: Array<{ itemIndex: number }>) => void | Promise<void>; signal?: AbortSignal; onSubmitted?: (batchId: string) => void; onProgress?: (items: QueuedBatchItem[]) => void }) {
    if (!input.files.length || input.files.length > 100) throw new Error("每批请选择 1–100 张图片，每张独立生成 1 张结果。");
    const ownerId = useUserStore.getState().user?.id;
    if (!ownerId) throw new Error("当前账号不可用");
    const assertOwner = () => { input.signal?.throwIfAborted(); if (useUserStore.getState().user?.id !== ownerId) throw new Error("员工会话已变化，批次未提交"); };
    assertOwner();
    const model = input.resolvedModel || await resolvePublicModel(input.modelId, "batch_image", "canvas-batch");
    assertOwner();
    const referenceProfile = imageModelProfile(model.id, [model]);
    const uploadedItems: Array<{ itemIndex: number; sourceUrl: string }> = [];
    const uploadFailures: QueuedBatchFailure[] = [];
    for (const [itemIndex, item] of input.files.entries()) {
        try {
            assertOwner();
            const referenceError = imageReferenceFileError(item.file, referenceProfile);
            if (referenceError) throw new Error(referenceError);
            const assetId = await uploadServerAsset(item.file, { title: item.title, source: "canvas-batch-reference" }, { signal: input.signal, expectedOwnerId: ownerId });
            assertOwner();
            uploadedItems.push({ itemIndex, sourceUrl: `/api/assets/${assetId}/content` });
        } catch (error) {
            uploadFailures.push({ index: itemIndex, reason: error instanceof Error ? error.message : "源图片上传失败" });
        }
    }
    if (!uploadedItems.length) throw new Error(uploadFailures[0]?.reason || "没有可提交的源图片");

    const requestId = createClientId();
    assertOwner();
    await input.onSubmissionStarted?.(requestId, uploadedItems);
    assertOwner();
    if (input.promptInput) input.onOptimizing?.();
    const result = await request<{
        prompt?: string; optimized?: boolean;
        batchId: string;
        tasks: Array<{ id: string; itemIndex: number; prompt?: string; parameters?: Record<string, unknown> }>;
        failures: QueuedBatchFailure[];
    }>("/api/tasks/batch", {
        method: "POST",
        body: JSON.stringify({
            requestId,
            projectId: currentProjectId("canvas-batch-edit"),
            operationType: "batch_image",
            toolKey: "canvas-batch",
            modelConfigId: model.id,
            prompt: input.prompt,
            ...(input.promptInput ? { promptInput: input.promptInput } : {}),
            parameters: { ...input.parameters, tool: "canvas-batch", count: 1, n: 1 },
            priority: "normal",
            items: uploadedItems.map((item) => ({ sourceUrls: [item.sourceUrl] })),
        }),
        signal: input.signal,
    }).catch(async error => {
        if (error instanceof QueuedTaskHttpError && error.submissionRejected) throw error;
        const [original] = await Promise.all([getQueuedBatchByRequestId(requestId).catch(() => null), getPromptCompilation(requestId).catch(() => null), getQueuedTaskByRequestId(`${requestId}:0`).catch(() => null)]);
        if (original && original.submissionComplete !== false) return original;
        throw new QueuedTaskSubmissionUncertainError(requestId, undefined, error);
    });
    if (result.prompt !== undefined) { const prompts = imageTaskPrompts(result.tasks.find(task => task.parameters?.promptExclusions) || { prompt: result.prompt }); input.onCompiled?.(prompts.prompt, result.optimized === true, prompts.submittedPrompt); }
    const remapped = restoreBatchItemIndices(uploadedItems, result.tasks, result.failures);
    const itemIndexByTaskId = new Map(remapped.tasks.map((task) => [task.id, task.itemIndex]));
    const failures = [...uploadFailures, ...remapped.failures];
    const ids = result.tasks.map((task) => task.id);
    input.onSubmitted?.(result.batchId);
    void refreshSessionBalance();
    if (!ids.length) return { batchId: result.batchId, tasks: [] as QueuedBatchItem[], failures };
    try {
        const tasks = await waitForTasks(ids, input.signal, (current) => input.onProgress?.(current.map((task) => ({ ...task, itemIndex: itemIndexByTaskId.get(task.id)! }))));
        return {
            batchId: result.batchId,
            tasks: tasks.map((task) => ({ ...task, itemIndex: itemIndexByTaskId.get(task.id)! })),
            failures,
        };
    } catch (error) {
        if (input.signal?.aborted) {
            await request<{ changed: number }>(`/api/tasks/batches/${result.batchId}/cancel`, { method: "POST" }).catch(() => undefined);
            throw error;
        }
        throw new QueuedTaskSubmissionUncertainError(requestId, undefined, error);
    } finally {
        void refreshSessionBalance();
    }
}

export async function getQueuedBatchByRequestId(requestId: string) {
    const response = await fetch(`/api/tasks/batches/by-request/${encodeURIComponent(requestId)}`, { credentials: "include", headers: workspaceOwnerHeaders(), cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("原批次查询失败");
    return response.json() as Promise<{ batchId: string; tasks: Array<QueuedTask & { itemIndex: number }>; failures: QueuedBatchFailure[]; prompt?: string; optimized?: boolean; submissionComplete?: boolean; totalItems?: number }>;
}

export function controlQueuedBatch(batchId: string, action: QueuedBatchAction) {
    return request<{ changed: number }>(`/api/tasks/batches/${batchId}/${action}`, { method: "POST" });
}

export function restoreBatchItemIndices(uploadedItems: Array<{ itemIndex: number }>, tasks: Array<{ id: string; itemIndex: number }>, failures: QueuedBatchFailure[]) {
    const originalIndex = (submittedIndex: number) => uploadedItems[submittedIndex]?.itemIndex ?? submittedIndex;
    return {
        tasks: tasks.map((task) => ({ ...task, itemIndex: originalIndex(task.itemIndex) })),
        failures: failures.map((failure) => ({ ...failure, index: originalIndex(failure.index) })),
    };
}

export function createQueuedMediaTaskPayloads(input: {
    toolKey?: string;
    requestId: string;
    projectId: string;
    operationType: string;
    modelConfigId: string;
    prompt: string;
    promptInput?: PromptInputData;
    parameters?: Record<string, unknown>;
    sourceUrls: string[];
}) {
    const payload = {
        requestId: input.requestId,
        projectId: input.projectId,
        operationType: input.operationType,
        toolKey: requireToolKey(input.operationType, input.toolKey),
        modelConfigId: input.modelConfigId,
        prompt: input.prompt,
        ...(input.promptInput ? { promptInput: input.promptInput } : {}),
        parameters: input.parameters || {},
        sourceUrls: input.sourceUrls,
        priority: "normal" as const,
    };
    return [payload, { ...payload, parameters: { ...payload.parameters }, sourceUrls: [...payload.sourceUrls] }];
}

export async function submitQueuedMediaTask(input: QueuedMediaInput) {
    input.signal?.throwIfAborted();
    const toolKey = requireToolKey(input.operationType, input.toolKey);
    const model = input.resolvedModel || await resolvePublicModel(input.modelId, input.operationType, toolKey);
    input.signal?.throwIfAborted();
    const sourceUrls = [...(input.sourceUrls || [])];
    for (const sourceUrl of sourceUrls) {
        const assetId = sourceUrl.match(/^\/api\/assets\/([\w-]+)\/content(?:\?[^#]*)?$/)?.[1];
        if (assetId) await assertServerAssetContent(assetId, input.signal);
    }
    const uploadedUrls: string[] = [];
    for (const [index, file] of (input.sourceFiles || []).entries()) {
        input.signal?.throwIfAborted();
        const id = await uploadServerAsset(file, { ...input.sourceMetadata?.[index], title: file.name, source: "task-reference" }, { signal: input.signal });
        input.signal?.throwIfAborted();
        uploadedUrls.push(`/api/assets/${id}/content`);
        sourceUrls.push(`/api/assets/${id}/content`);
    }
    const [preflightPayload, submitPayload] = createQueuedMediaTaskPayloads({
        toolKey,
        requestId: createClientId(),
        projectId: currentProjectId(input.operationType === "audio_generation" ? "audio-workbench" : "video-workbench"),
        operationType: input.operationType,
        modelConfigId: model.id,
        prompt: input.prompt,
        promptInput: input.promptInput,
        parameters: { ...input.parameters, tool: toolKey },
        sourceUrls: input.sourceOrder ? input.sourceOrder.map((source) => source.kind === "file" ? uploadedUrls[source.index] : input.sourceUrls![source.index]) : sourceUrls,
    });
    input.signal?.throwIfAborted();
    if (input.operationType === "video_generation") {
        const preflight = await request<{ ok: boolean; normalized: Record<string, unknown> }>("/api/tasks/preflight", {
            method: "POST",
            body: JSON.stringify(preflightPayload),
            signal: input.signal,
        });
        input.signal?.throwIfAborted();
        if (!preflight.ok) throw new Error("视频参数检查未通过，请检查模型、生成方式和参考素材后再提交。");
        submitPayload.parameters = { ...submitPayload.parameters, ...preflight.normalized };
    }
    input.signal?.throwIfAborted();
    await input.onSubmissionStarted?.(submitPayload.requestId);
    input.signal?.throwIfAborted();
    let task: QueuedTask;
    try {
        const result = await request<{ task: QueuedTask }>("/api/tasks", {
            method: "POST",
            body: JSON.stringify(submitPayload),
            signal: input.signal,
        });
        if (!result?.task?.id) throw new Error("服务器未返回任务编号");
        task = { ...result.task, requestId: submitPayload.requestId };
    } catch (error) {
        // An explicit client rejection is known not to have created a new task.
        if (error instanceof QueuedTaskHttpError && error.submissionRejected) throw error;
        // A slow planner or lost acknowledgement must never replay the paid POST.
        const original = await getQueuedTaskByRequestId(submitPayload.requestId).catch(() => null);
        if (original?.id) return original;
        throw new QueuedTaskSubmissionUncertainError(submitPayload.requestId, undefined, error);
    }
    // Once acknowledged, keep the ID available to onSubmitted and cancellation;
    // do not turn a known accepted task into an unknown submission on a late abort.
    void refreshSessionBalance();
    return task;
}

export async function getQueuedTask(id: string, signal?: AbortSignal) {
    return queryQueuedTask(`/api/tasks/${encodeURIComponent(id)}`, signal);
}

/** Only the currently displayed generation uses this; history lists do not. */
export async function getQueuedTaskProgress(id: string, signal?: AbortSignal) {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/progress`, {
        credentials: "include", signal, headers: workspaceOwnerHeaders(), cache: "no-store",
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("暂时无法查询排队状态");
    const result = await response.json() as { progress: QueuedTaskProgress };
    return result.progress;
}

export async function getQueuedTaskByRequestId(requestId: string, signal?: AbortSignal) {
    return queryQueuedTask(`/api/tasks/by-request/${encodeURIComponent(requestId)}`, signal);
}

async function queryQueuedTask(path: string, signal?: AbortSignal) {
    const response = await fetch(path, { credentials: "include", signal, headers: workspaceOwnerHeaders() });
    if (response.status === 404) return null;
    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message || `任务查询失败（${response.status}）`);
    }
    const result = await response.json() as { task: QueuedTask };
    return result.task;
}

export async function recoverQueuedTask(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const result = await request<{ task: QueuedTask; recovered?: boolean; message?: string }>(`/api/tasks/${id}/recover`, { method: "POST", signal });
    signal?.throwIfAborted();
    if (result.task.status === "paused") throw new QueuedTaskPausedError(result.task, result.message);
    return result.task;
}

export function getGenerationCapabilities(toolKey: "video" | "canvas-video" = "video") {
    return request<{ models: GenerationCapabilityModel[] }>(`/api/generation-capabilities?toolKey=${toolKey}`);
}

export function selectImageGenerationModels(models: ImageGenerationModel[]) {
    return models.filter((model) => !model.modelId.startsWith("demo-") && model.capabilities.some((capability) => capability === "generate" || capability === "edit"));
}

export function getImageGenerationModels() {
    return request<{ models: ImageGenerationModel[] }>("/api/models").then(({ models }) => selectImageGenerationModels(models));
}

export async function listQueuedTasks(signal?: AbortSignal, operationType?: string) {
    const query = new URLSearchParams({ limit: "60", ...(operationType ? { operationType } : {}) });
    const result = await request<{ tasks: QueuedTask[] }>(`/api/tasks?${query}`, { signal });
    return result.tasks;
}

export async function requestQueuedMedia(input: QueuedMediaInput) {
    const submitted = await submitQueuedMediaTask(input);
    try { await input.onSubmitted?.(submitted); }
    catch (error) { throw new QueuedTaskSubmissionUncertainError(submitted.requestId, submitted.id, error); }
    return waitForQueuedMedia(submitted, input.signal, input.cancelOnAbort);
}

export async function recoverQueuedMedia(id: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    const original = await recoverQueuedTask(id, signal);
    return waitForQueuedMedia(original, signal, () => false);
}

async function waitForQueuedMedia(submitted: QueuedTask, signal?: AbortSignal, cancelOnAbort?: () => boolean) {
    const ids = [submitted.id];
    try {
        const [completed] = await waitForTasks(ids, signal, undefined, true);
        if (!completed) throw new Error("任务不存在");
        if (completed.status !== "success") throw new QueuedTaskFailedError(completed);
        return completed.resultUrls;
    } catch (error) {
        if (signal?.aborted) {
            if (cancelOnAbort?.() === false) throw error;
            try { await request<void>(`/api/tasks/${submitted.id}/cancel`, { method: "POST" }); }
            catch (cancelError) { throw new QueuedTaskSubmissionUncertainError(submitted.requestId, submitted.id, cancelError); }
            throw error;
        }
        if (error instanceof QueuedTaskFailedError || error instanceof QueuedTaskPausedError) throw error;
        throw new QueuedTaskSubmissionUncertainError(submitted.requestId, submitted.id, error);
    } finally {
        void refreshSessionBalance();
    }
}

async function resolvePublicModel(modelId: string, operationType: string, toolKey?: string) {
    return resolveConfiguredToolModel(await getBusinessConfig(), requireToolKey(operationType, toolKey), modelId);
}

export async function waitForTasks(ids: string[], signal?: AbortSignal, onPoll?: (tasks: QueuedTask[]) => void, haltOnPaused = false) {
    if (!ids.length) return [];
    const events = watchTaskEvents(ids, { background: true });
    let revision = events.version;
    try { return await observeTask({ taskIds: ids, signal, ready: events.ready,
        waitForChange: (remaining, nextSignal) => events.next(revision, remaining, nextSignal),
        read: async querySignal => {
            revision = events.version;
            return readTaskSnapshot(ids, async snapshotSignal => {
                if (ids.length === 1) {
                    const task = await getQueuedTask(ids[0]!, snapshotSignal);
                    if (!task) throw new Error(`原任务 ${ids[0]} 不存在或无权访问`);
                    return [task];
                }
                const tasks = (await request<{ tasks: QueuedTask[] }>(`/api/tasks?${new URLSearchParams({ ids: ids.join(",") })}`, { signal: snapshotSignal })).tasks;
                if (tasks.length !== ids.length) throw new Error("部分原任务不存在或无权访问");
                return tasks;
            }, querySignal);
        },
        done: tasks => {
        onPoll?.(tasks);
        const paused = haltOnPaused ? tasks.find((task) => task.status === "paused") : undefined;
        if (paused) throw new QueuedTaskPausedError(paused);
        return tasks.length === ids.length && tasks.every((task) => ["success", "failed", "cancelled"].includes(task.status));
    } }); } finally { events.close(); }
}

async function cancelTasks(ids: string[]) {
    const results = await Promise.allSettled(ids.map(id => cancelQueuedTask(id)));
    const unresolved = results.findIndex(result => result.status === "rejected" || result.value.status !== "cancelled");
    if (unresolved >= 0) {
        const outcome = results[unresolved]!;
        const error = new QueuedTaskSubmissionUncertainError(outcome.status === "fulfilled" ? outcome.value.requestId : "", ids[unresolved], outcome.status === "rejected" ? outcome.reason : undefined);
        error.message = "已停止本页等待，但上游任务未确认取消，仍可能完成并产生费用；请查询原任务，不要重复生成。";
        throw error;
    }
}

async function refreshSessionBalance() {
    await useUserStore
        .getState()
        .hydrateSession()
        .catch(() => undefined);
}

function currentProjectId(fallback: string) {
    return window.location.pathname.match(/^\/canvas\/([^/]+)/)?.[1] || fallback;
}

const referenceUploads = new Map<string, Promise<string>>();
let referenceUploadOwner: string | undefined;
useUserStore.subscribe((state, previous) => {
    if (state.user?.id !== previous.user?.id) { referenceUploads.clear(); referenceUploadOwner = undefined; }
});

export async function uploadImageReference(reference: ReferenceImage, file: File, hash: string, ownerId: string, signal?: AbortSignal) {
    const assertOwner = () => { signal?.throwIfAborted(); if (useUserStore.getState().user?.id !== ownerId) throw new Error("员工会话已变化"); };
    assertOwner();
    if (referenceUploadOwner !== ownerId) { referenceUploads.clear(); referenceUploadOwner = ownerId; }
    if (reference.sourceAssetId) {
        const { asset } = await fetchServerAsset(reference.sourceAssetId, signal);
        assertOwner();
        if (asset.kind !== "image" || asset.status !== "ready") throw new Error("原参考图不可用，请重新选择素材");
        try { await assertServerAssetContent(asset.id, signal); assertOwner(); return asset.id; }
        catch (error) {
            assertOwner();
            if (!(error instanceof ServerAssetContentError) || error.code !== "ASSET_OBJECT_MISSING") throw error;
            return uploadReferenceBytes(reference, file, hash, ownerId, assertOwner, asset.id);
        }
    }
    const key = `${ownerId}:${hash}`;
    const existing = referenceUploads.get(key);
    if (existing) {
        const assetId = await existing;
        assertOwner();
        // Permissions/deletion may change during this browser session.
        const { asset } = await fetchServerAsset(assetId, signal);
        assertOwner();
        if (asset.kind !== "image" || asset.status !== "ready") throw new Error("原参考图不可用，请重新选择素材");
        try { await assertServerAssetContent(assetId, signal); assertOwner(); return assetId; }
        catch (error) {
            assertOwner();
            if (!(error instanceof ServerAssetContentError) || error.code !== "ASSET_OBJECT_MISSING") throw error;
            const repaired = await uploadReferenceBytes(reference, file, hash, ownerId, assertOwner, assetId);
            if (referenceUploads.get(key) === existing) referenceUploads.set(key, Promise.resolve(repaired));
            return repaired;
        }
    }
    return uploadReferenceBytes(reference, file, hash, ownerId, assertOwner);
}

async function uploadReferenceBytes(reference: ReferenceImage, file: File, hash: string, ownerId: string, assertOwner: () => void, repairAssetId?: string) {
    assertOwner();
    const key = `${ownerId}:${repairAssetId ? `repair:${repairAssetId}:` : ""}${hash}`;
    const existing = referenceUploads.get(key);
    if (existing) { const id = await existing; assertOwner(); return id; }
    const pending = uploadServerAsset(file, { title: reference.name, source: "task-reference", contentSha256: hash }, { expectedOwnerId: ownerId, ...(repairAssetId ? { repairAssetId } : {}) });
    referenceUploads.set(key, pending);
    try { const id = await pending; assertOwner(); return id; }
    catch (error) { if (referenceUploads.get(key) === pending) referenceUploads.delete(key); assertOwner(); throw error; }
    finally {
        // Repair deduplication is in-flight only: a later missing object must be checked again.
        if (repairAssetId && referenceUploads.get(key) === pending) referenceUploads.delete(key);
        if (referenceUploads.size > 128) referenceUploads.delete(referenceUploads.keys().next().value!);
    }
}

/** Missing local bytes must not turn a broken server reference into a successful reuse. */
export async function readGenerationReferenceDataUrl(reference: ReferenceImage, signal?: AbortSignal) {
    signal?.throwIfAborted();
    try {
        const dataUrl = await imageToDataUrl(reference);
        signal?.throwIfAborted();
        if (!dataUrl) throw new Error("原参考图没有可读取的原始文件，请重新导入原文件；尚未提交生成。");
        return dataUrl;
    } catch (error) {
        signal?.throwIfAborted();
        const assetId = reference.sourceAssetId || (reference.dataUrl || reference.url || "").match(/^\/api\/assets\/([\w-]+)\/content(?:\?[^#]*)?$/)?.[1];
        if (assetId) await assertServerAssetContent(assetId, signal);
        throw error;
    }
}
