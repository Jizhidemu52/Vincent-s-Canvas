import { getQueuedTask, getQueuedTaskByRequestId, recoverQueuedTask, waitForTasks, QueuedTaskFailedError, QueuedTaskPausedError } from "@/services/api/generation-tasks";
import { classifyTaskRecovery } from "@/services/api/task-result-reconciliation";
import { uploadImage } from "@/services/image-storage";
import { storeGeneratedVideo } from "@/services/api/video";
import { storeGeneratedAudio } from "@/services/api/audio";
import { buildAgentGeneratedMediaOps } from "@/lib/agent-direct-generation";
import type { CanvasImageEditLineage } from "./canvas-assistant-image-edit";
import type { CanvasImageAgentRecord } from "./canvas-image-agent";
import type { CanvasAssistantAttachment } from "@/types/canvas";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasAgentOp } from "./canvas-agent-ops";
import { restoreChatMaskResult, type ChatRegionComposite } from "@/lib/image-agent/mask";
import type { CanvasMaskAdaptation } from "./canvas-mask-adaptation";

export type PendingOnlineAgentTask = {
    ownerId: string; projectId: string; requestId: string; taskIds?: string[];
    mode: "image" | "video" | "audio"; prompt: string; model: string;
    nodeId?: string; imageEdit?: CanvasImageEditLineage;
    imageAgent?: CanvasImageAgentRecord;
    signature?: string;
    maskAdaptation?: CanvasMaskAdaptation;
    regionComposite?: ChatRegionComposite;
};

export function pendingOnlineAgentTask(value: unknown): PendingOnlineAgentTask | null {
    if (!value || typeof value !== "object") return null;
    const task = value as PendingOnlineAgentTask;
    return typeof task.requestId === "string" && Boolean(task.requestId) && typeof task.ownerId === "string" && typeof task.projectId === "string"
        && ["image", "video", "audio"].includes(task.mode) ? task : null;
}

const services = { getQueuedTask, getQueuedTaskByRequestId, recoverQueuedTask, waitForTasks, uploadImage, storeGeneratedVideo, storeGeneratedAudio, restoreChatMaskResult,
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args) };

/** Only query the recorded request/task. Never create replacement generation. */
export async function recoverOnlineAgentTask(pending: PendingOnlineAgentTask, position: { x: number; y: number }, signal: AbortSignal, io = services) {
    signal.throwIfAborted();
    const originals = pending.taskIds?.length
        ? await Promise.all(pending.taskIds.map(id => io.getQueuedTask(id, signal)))
        : [await io.getQueuedTaskByRequestId(pending.requestId, signal)];
    signal.throwIfAborted();
    const attachments: CanvasAssistantAttachment[] = [], ops: CanvasAgentOp[] = [];
    const assertReceipt = (task: (typeof originals)[number], requestId: string, taskId?: string) => {
        if (!task) throw new Error("原任务尚未查到或无权读取，请稍后查询；不会重复生成。");
        if (!task.id || task.requestId !== requestId || (taskId && task.id !== taskId)) throw new Error("原任务回执身份不匹配，未接入结果；请稍后查询，不会重复生成。");
    };
    // Older saved requests may contain one task per output, in submission order.
    // Validate the entire batch before any result is stored or resumed.
    originals.forEach((original, index) => {
        const requestId = pending.mode === "image" && originals.length > 1 && pending.requestId.endsWith(":0")
            ? `${pending.requestId.slice(0, -2)}:${index}` : pending.requestId;
        assertReceipt(original, requestId, pending.taskIds?.[index]);
    });
    for (const original of originals) {
        if (!original) throw new Error("原任务尚未查到或无权读取，请稍后查询；不会重复生成。");
        let task = original;
        if (task.status !== "success" && classifyTaskRecovery(task) === "terminal") throw new QueuedTaskFailedError(task);
        if (task.status === "paused") {
            if (classifyTaskRecovery(task) !== "resume") throw new QueuedTaskPausedError(task);
            task = await io.recoverQueuedTask(task.id, signal);
            signal.throwIfAborted();
            assertReceipt(task, original.requestId, original.id);
        }
        if (task.status !== "success" && !["failed", "cancelled"].includes(task.status)) [task] = await io.waitForTasks([task.id], signal, undefined, true);
        signal.throwIfAborted();
        assertReceipt(task, original.requestId, original.id);
        if (!task || task.status !== "success") throw new QueuedTaskFailedError(task || original);
        if (!task.resultUrls.length) throw new Error("原任务结果暂不可用，请稍后查询。");
        for (const [index, url] of task.resultUrls.entries()) {
            signal.throwIfAborted();
            const id = `agent-${task.id}-${index}`;
            if (pending.mode === "audio") {
                const response = await io.fetch(url, { credentials: "include", signal });
                if (!response.ok) throw new Error(`音频结果读取失败（${response.status}）`);
                const audio = await io.storeGeneratedAudio(await response.blob());
                signal.throwIfAborted();
                ops.push({ type: "add_node", id, nodeType: CanvasNodeType.Audio, title: "生成音频", position,
                    metadata: { content: audio.url, storageKey: audio.storageKey, mimeType: audio.mimeType, prompt: pending.prompt, model: pending.model, status: "success", sourceTaskId: task.id } });
            } else {
                const file = pending.mode === "image" ? await io.uploadImage(pending.maskAdaptation || pending.regionComposite ? await io.restoreChatMaskResult(pending, url) : url) : await io.storeGeneratedVideo({ url, mimeType: "video/mp4" });
                signal.throwIfAborted();
                attachments.push({ id, name: pending.mode === "image" ? `生成图片 ${index + 1}` : "生成视频", mediaType: pending.mode, ...file });
            }
        }
    }
    ops.push(...buildAgentGeneratedMediaOps(attachments, { prompt: pending.prompt, model: pending.model, ...position }));
    const ids = ops.flatMap(op => op.type === "add_node" && op.id ? [op.id] : []);
    if (pending.nodeId) ops.push({ type: "update_node", id: pending.nodeId, metadata: { status: "success", errorDetails: undefined } },
        ...ids.map(id => ({ type: "connect_nodes" as const, fromNodeId: pending.nodeId!, toNodeId: id })));
    return { attachments, ops };
}
