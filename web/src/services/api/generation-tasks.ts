import { nanoid } from "nanoid";

import { dataUrlToFile } from "@/lib/image-utils";
import { createClientId } from "@/lib/client-id";
import { uploadServerAsset } from "@/services/api/server-assets";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionName } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

type ImageOperationType = "image_generation" | "inpaint" | "upscale" | "batch_image" | "seamless_stitch";
type PublicModel = { id: string; name: string; modelId: string; capabilities: string[]; creditCost: number; rmbCost: number };
export type ImageGenerationModel = PublicModel;
export type QueuedTask = { id: string; requestId: string; operationType?: string; status: string; stage?: string; errorCode?: string | null; upstreamTaskId?: string | null; submissionStartedAt?: string | null; resultUrls: string[]; failureReason: string | null; createdAt?: string; updatedAt?: string };
export class QueuedTaskPausedError extends Error {
    readonly taskId: string;
    readonly canRecover: boolean;
    constructor(readonly task: QueuedTask, message?: string) {
        const canRecover = task.operationType === "video_generation" && Boolean(task.upstreamTaskId);
        super(`${message || task.failureReason || "任务查询已暂停"}（任务 ${task.id}）。${canRecover ? "可恢复查询原任务，不会重新生成。" : "提交状态待核查，请勿重复生成。"}`);
        this.name = "QueuedTaskPausedError";
        this.taskId = task.id;
        this.canRecover = canRecover;
    }
}
export class QueuedTaskFailedError extends Error {
    constructor(readonly task: QueuedTask) {
        super(task.failureReason || "生成任务已失败或取消");
        this.name = "QueuedTaskFailedError";
    }
}
export type GenerationVideoCapability = { seconds: readonly [number, number]; resolutions: readonly string[]; sizes: readonly string[]; minImages: number; maxImages: number; firstFrameRequired: boolean; supportsAudio: boolean };
export type GenerationCapabilityModel = { id: string; name: string; modelId: string; capability: GenerationVideoCapability };
export type QueuedMediaInput = { modelId: string; prompt: string; operationType: string; parameters?: Record<string, unknown>; sourceFiles?: File[]; sourceUrls?: string[]; sourceMetadata?: Record<string, unknown>[]; sourceOrder?: Array<{ kind: "file" | "url"; index: number }>; signal?: AbortSignal; onSubmitted?: (task: QueuedTask) => void };
export type QueuedBatchItem = QueuedTask & { itemIndex: number };
export type QueuedBatchFailure = { index: number; reason: string };
export type QueuedBatchAction = "pause" | "resume" | "cancel";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
        ...init,
        credentials: "include",
        headers: { "content-type": "application/json", ...init?.headers },
    });
    if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || "任务提交失败");
    }
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export function createImageTaskRequests(input: {
    requestId: string;
    projectId: string;
    operationType: ImageOperationType;
    modelConfigId: string;
    prompt: string;
    parameters?: Record<string, unknown>;
    sourceUrls: string[];
    count: number;
}) {
    return Array.from({ length: input.count }, (_, index) => ({
        requestId: `${input.requestId}:${index}`,
        projectId: input.projectId,
        operationType: input.operationType,
        modelConfigId: input.modelConfigId,
        prompt: input.prompt,
        parameters: { ...input.parameters, count: 1 },
        sourceUrls: input.sourceUrls,
        priority: "normal" as const,
    }));
}

export async function requestQueuedImages(input: { modelId: string; prompt: string; count: number; operationType: ImageOperationType; tool?: string; parameters?: Record<string, unknown>; references?: ReferenceImage[]; signal?: AbortSignal; onSubmitted?: () => void }) {
    const model = await resolvePublicModel(input.modelId);
    const sourceUrls: string[] = [];
    for (const reference of input.references || []) {
        const dataUrl = await imageToDataUrl(reference);
        const file = dataUrlToFile({ ...reference, dataUrl });
        const assetId = await uploadServerAsset(file, { title: reference.name, source: "task-reference" });
        sourceUrls.push(`/api/assets/${assetId}/content`);
    }

    const rootRequestId = createClientId();
    const projectId = currentProjectId("image-workbench");
    const taskRequests = createImageTaskRequests({
        requestId: rootRequestId,
        projectId,
        operationType: input.operationType,
        modelConfigId: model.id,
        prompt: input.prompt,
        parameters: { ...input.parameters, ...(input.tool ? { tool: input.tool } : {}) },
        sourceUrls,
        count: input.count,
    });
    const submitted = await Promise.allSettled(
        taskRequests.map((task) => request<{ task: { id: string } }>("/api/tasks", {
            method: "POST",
            body: JSON.stringify(task),
        })),
    );
    const rejected = submitted.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason instanceof Error ? rejected.reason : new Error("任务提交失败");
    const ids = submitted.map((result) => (result as PromiseFulfilledResult<{ task: { id: string } }>).value.task.id);
    input.onSubmitted?.();

    void refreshSessionBalance();
    try {
        const tasks = await waitForTasks(ids, input.signal);
        const failed = tasks.find((task) => task.status === "failed" || task.status === "cancelled");
        if (failed) throw new Error(failed.failureReason || "生成任务失败");
        return tasks.flatMap((task) => task.resultUrls.map((dataUrl) => ({ id: nanoid(), dataUrl, sourceTaskId: task.id })));
    } catch (error) {
        if (input.signal?.aborted) await cancelTasks(ids);
        throw error;
    } finally {
        await refreshSessionBalance();
    }
}

export async function requestQueuedImageBatch(input: { modelId: string; prompt: string; files: Array<{ file: File; title: string }>; signal?: AbortSignal; onSubmitted?: (batchId: string) => void; onProgress?: (items: QueuedBatchItem[]) => void }) {
    const model = await resolvePublicModel(input.modelId);
    const uploadedItems: Array<{ itemIndex: number; sourceUrl: string }> = [];
    const uploadFailures: QueuedBatchFailure[] = [];
    for (const [itemIndex, item] of input.files.entries()) {
        try {
            const assetId = await uploadServerAsset(item.file, { title: item.title, source: "canvas-batch-reference" });
            uploadedItems.push({ itemIndex, sourceUrl: `/api/assets/${assetId}/content` });
        } catch (error) {
            uploadFailures.push({ index: itemIndex, reason: error instanceof Error ? error.message : "源图片上传失败" });
        }
    }
    if (!uploadedItems.length) throw new Error(uploadFailures[0]?.reason || "没有可提交的源图片");

    const result = await request<{
        batchId: string;
        tasks: Array<{ id: string; itemIndex: number }>;
        failures: QueuedBatchFailure[];
    }>("/api/tasks/batch", {
        method: "POST",
        body: JSON.stringify({
            requestId: createClientId(),
            projectId: currentProjectId("canvas-batch-edit"),
            operationType: "batch_image",
            modelConfigId: model.id,
            prompt: input.prompt,
            priority: "normal",
            items: uploadedItems.map((item) => ({ sourceUrls: [item.sourceUrl] })),
        }),
    });
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
        }
        throw error;
    } finally {
        await refreshSessionBalance();
    }
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
    requestId: string;
    projectId: string;
    operationType: string;
    modelConfigId: string;
    prompt: string;
    parameters?: Record<string, unknown>;
    sourceUrls: string[];
}) {
    const payload = {
        requestId: input.requestId,
        projectId: input.projectId,
        operationType: input.operationType,
        modelConfigId: input.modelConfigId,
        prompt: input.prompt,
        parameters: input.parameters || {},
        sourceUrls: input.sourceUrls,
        priority: "normal" as const,
    };
    return [payload, { ...payload, parameters: { ...payload.parameters }, sourceUrls: [...payload.sourceUrls] }];
}

export async function submitQueuedMediaTask(input: QueuedMediaInput) {
    const model = await resolvePublicModel(input.modelId);
    const sourceUrls = [...(input.sourceUrls || [])];
    const uploadedUrls: string[] = [];
    for (const [index, file] of (input.sourceFiles || []).entries()) {
        const id = await uploadServerAsset(file, { ...input.sourceMetadata?.[index], title: file.name, source: "task-reference" });
        uploadedUrls.push(`/api/assets/${id}/content`);
        sourceUrls.push(`/api/assets/${id}/content`);
    }
    const [preflightPayload, submitPayload] = createQueuedMediaTaskPayloads({
        requestId: createClientId(),
        projectId: currentProjectId(input.operationType === "audio_generation" ? "audio-workbench" : "video-workbench"),
        operationType: input.operationType,
        modelConfigId: model.id,
        prompt: input.prompt,
        parameters: input.parameters || {},
        sourceUrls: input.sourceOrder ? input.sourceOrder.map((source) => source.kind === "file" ? uploadedUrls[source.index] : input.sourceUrls![source.index]) : sourceUrls,
    });
    if (input.operationType === "video_generation") {
        const preflight = await request<{ ok: boolean; normalized: Record<string, unknown> }>("/api/tasks/preflight", {
            method: "POST",
            body: JSON.stringify(preflightPayload),
        });
        if (!preflight.ok) throw new Error("Video preflight failed");
        submitPayload.parameters = { ...submitPayload.parameters, ...preflight.normalized };
    }
    const result = await request<{ task: QueuedTask }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify(submitPayload),
    });
    void refreshSessionBalance();
    return result.task;
}

export async function getQueuedTask(id: string) {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { credentials: "include" });
    if (response.status === 404) return null;
    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message || `任务查询失败（${response.status}）`);
    }
    const result = await response.json() as { task: QueuedTask };
    return result.task;
}

export async function recoverQueuedTask(id: string) {
    const result = await request<{ task: QueuedTask; recovered?: boolean; message?: string }>(`/api/tasks/${id}/recover`, { method: "POST" });
    if (result.task.status === "paused") throw new QueuedTaskPausedError(result.task, result.message);
    return result.task;
}

export function getGenerationCapabilities() {
    return request<{ models: GenerationCapabilityModel[] }>("/api/generation-capabilities");
}

export function selectImageGenerationModels(models: ImageGenerationModel[]) {
    return models.filter((model) => !model.modelId.startsWith("demo-") && model.capabilities.some((capability) => capability === "generate" || capability === "edit"));
}

export function getImageGenerationModels() {
    return request<{ models: ImageGenerationModel[] }>("/api/models").then(({ models }) => selectImageGenerationModels(models));
}

export async function listQueuedTasks() {
    const result = await request<{ tasks: QueuedTask[] }>("/api/tasks");
    return result.tasks;
}

export async function requestQueuedMedia(input: QueuedMediaInput) {
    const submitted = await submitQueuedMediaTask(input);
    input.onSubmitted?.(submitted);
    return waitForQueuedMedia(submitted, input.signal);
}

export async function recoverQueuedMedia(id: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    const original = await recoverQueuedTask(id);
    return waitForQueuedMedia(original, signal);
}

async function waitForQueuedMedia(submitted: QueuedTask, signal?: AbortSignal) {
    const ids = [submitted.id];
    try {
        const [completed] = await waitForTasks(ids, signal, undefined, true);
        if (!completed) throw new Error("任务不存在");
        if (completed.status !== "success") throw new QueuedTaskFailedError(completed);
        return completed.resultUrls;
    } catch (error) {
        if (signal?.aborted) await cancelTasks(ids);
        throw error;
    } finally {
        await refreshSessionBalance();
    }
}

async function resolvePublicModel(modelId: string) {
    const result = await request<{ models: PublicModel[] }>("/api/models");
    const normalized = modelOptionName(modelId);
    const model = result.models.find((item) => item.id === modelId || item.modelId === normalized || item.name === modelId);
    if (!model) throw new Error(`管理员尚未启用模型：${modelId}`);
    return model;
}

async function waitForTasks(ids: string[], signal?: AbortSignal, onPoll?: (tasks: QueuedTask[]) => void, haltOnPaused = false) {
    const wanted = new Set(ids);
    for (;;) {
        if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
        const tasks = haltOnPaused
            ? await Promise.all(ids.map(async (id) => {
                const task = await getQueuedTask(id);
                if (!task) throw new Error(`原任务 ${id} 不存在或无权访问`);
                return task;
            }))
            : (await request<{ tasks: QueuedTask[] }>("/api/tasks")).tasks.filter((task) => wanted.has(task.id));
        onPoll?.(tasks);
        const paused = haltOnPaused ? tasks.find((task) => task.status === "paused") : undefined;
        if (paused) throw new QueuedTaskPausedError(paused);
        if (tasks.length === ids.length && tasks.every((task) => ["success", "failed", "cancelled"].includes(task.status))) return tasks;
        await delay(1_000, signal);
    }
}

async function cancelTasks(ids: string[]) {
    await Promise.allSettled(ids.map((id) => request<void>(`/api/tasks/${id}/cancel`, { method: "POST" })));
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

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("请求已取消", "AbortError"));
            return;
        }
        const timer = window.setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                window.clearTimeout(timer);
                reject(new DOMException("请求已取消", "AbortError"));
            },
            { once: true },
        );
    });
}
