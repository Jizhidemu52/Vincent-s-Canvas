import { nanoid } from "nanoid";

import { dataUrlToFile } from "@/lib/image-utils";
import { uploadServerAsset } from "@/services/api/server-assets";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionName } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

type ImageOperationType = "image_generation" | "inpaint" | "upscale" | "batch_image" | "seamless_stitch";
type PublicModel = { id: string; name: string; modelId: string; capabilities: string[]; creditCost: number; rmbCost: number };
export type QueuedTask = { id: string; requestId: string; status: string; resultUrls: string[]; failureReason: string | null };
export type QueuedMediaInput = { modelId: string; prompt: string; operationType: string; parameters?: Record<string, unknown>; sourceFiles?: File[]; sourceUrls?: string[]; signal?: AbortSignal };
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

export async function requestQueuedImages(input: { modelId: string; prompt: string; count: number; operationType: ImageOperationType; tool?: string; references?: ReferenceImage[]; signal?: AbortSignal }) {
    const model = await resolvePublicModel(input.modelId);
    const sourceUrls: string[] = [];
    for (const reference of input.references || []) {
        const dataUrl = await imageToDataUrl(reference);
        const file = dataUrlToFile({ ...reference, dataUrl });
        const assetId = await uploadServerAsset(file, { title: reference.name, source: "task-reference" });
        sourceUrls.push(`/api/assets/${assetId}/content`);
    }

    const rootRequestId = crypto.randomUUID();
    const projectId = currentProjectId("image-workbench");
    let ids: string[];
    if (input.count === 1) {
        const result = await request<{ task: { id: string } }>("/api/tasks", {
            method: "POST",
            body: JSON.stringify({ requestId: rootRequestId, projectId, operationType: input.operationType, modelConfigId: model.id, prompt: input.prompt, parameters: input.tool ? { tool: input.tool } : {}, sourceUrls, priority: "normal" }),
        });
        ids = [result.task.id];
    } else {
        const result = await request<{ tasks: Array<{ id: string }>; failures: Array<{ reason: string }> }>("/api/tasks/batch", {
            method: "POST",
            body: JSON.stringify({ requestId: rootRequestId, projectId, operationType: input.operationType, modelConfigId: model.id, prompt: input.prompt, parameters: input.tool ? { tool: input.tool } : {}, priority: "normal", items: Array.from({ length: input.count }, () => ({ sourceUrls })) }),
        });
        if (result.failures.length && !result.tasks.length) throw new Error(result.failures[0]!.reason);
        ids = result.tasks.map((task) => task.id);
    }

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
            requestId: crypto.randomUUID(),
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

export async function submitQueuedMediaTask(input: QueuedMediaInput) {
    const model = await resolvePublicModel(input.modelId);
    const sourceUrls = [...(input.sourceUrls || [])];
    for (const file of input.sourceFiles || []) {
        const id = await uploadServerAsset(file, { title: file.name, source: "task-reference" });
        sourceUrls.push(`/api/assets/${id}/content`);
    }
    const result = await request<{ task: QueuedTask }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
            requestId: crypto.randomUUID(),
            projectId: currentProjectId(input.operationType === "audio_generation" ? "audio-workbench" : "video-workbench"),
            operationType: input.operationType,
            modelConfigId: model.id,
            prompt: input.prompt,
            parameters: input.parameters || {},
            sourceUrls,
            priority: "normal",
        }),
    });
    void refreshSessionBalance();
    return result.task;
}

export async function getQueuedTask(id: string) {
    const result = await request<{ tasks: QueuedTask[] }>("/api/tasks");
    return result.tasks.find((task) => task.id === id) || null;
}

export async function requestQueuedMedia(input: QueuedMediaInput) {
    const submitted = await submitQueuedMediaTask(input);
    const ids = [submitted.id];
    try {
        const [completed] = await waitForTasks(ids, input.signal);
        if (!completed || completed.status !== "success") throw new Error(completed?.failureReason || "任务失败");
        return completed.resultUrls;
    } catch (error) {
        if (input.signal?.aborted) await cancelTasks(ids);
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

async function waitForTasks(ids: string[], signal?: AbortSignal, onPoll?: (tasks: QueuedTask[]) => void) {
    const wanted = new Set(ids);
    for (;;) {
        if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
        const result = await request<{ tasks: QueuedTask[] }>("/api/tasks");
        const tasks = result.tasks.filter((task) => wanted.has(task.id));
        onPoll?.(tasks);
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
