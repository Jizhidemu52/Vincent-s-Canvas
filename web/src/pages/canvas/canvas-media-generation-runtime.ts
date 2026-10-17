import type { Dispatch, RefObject, SetStateAction } from "react";
import { flushSync } from "react-dom";
import { nanoid } from "nanoid";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import type { NodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { fitNodeSize, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { requestAudioGeneration, storeGeneratedAudio } from "@/services/api/audio";
import { getQueuedTask, getQueuedTaskByRequestId, QueuedTaskFailedError, QueuedTaskPausedError, QueuedTaskSubmissionUncertainError, recoverQueuedMedia } from "@/services/api/generation-tasks";
import { requestVideoGeneration, storeGeneratedVideo } from "@/services/api/video";
import type { UploadedFile } from "@/services/file-storage";
import { flushCanvasPersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import type { CanvasGenerationOutput } from "./canvas-shared-generation-runtime";

type MediaBinding = NonNullable<CanvasNodeMetadata["mediaTask"]>;
type MediaCanvas = {
    projectId: string;
    nodes: RefObject<CanvasNodeData[]>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    flushSave: () => void;
    isCurrent?: () => boolean;
    persist?: (nodes: CanvasNodeData[]) => Promise<void>;
};
type Generation = MediaCanvas & {
    nodeId: string; mode: "video" | "audio"; source?: CanvasNodeData; shared: boolean;
    config: AiConfig; context: NodeGenerationContext; origin: CanvasNodeMetadata["generationOrigin"];
    controller: AbortController; runningId: string;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    start: (targetId: string, sourceId: string, runningId: string, controller: AbortController) => AbortController;
    finish: (targetId: string, controller: AbortController) => void;
};

const canceled = (error: unknown) => error instanceof Error && error.name === "AbortError";
const findNode = (context: MediaCanvas, id: string) => context.nodes.current.find(node => node.id === id);
async function persist(context: MediaCanvas) {
    context.flushSave();
    if (context.persist) await context.persist(context.nodes.current);
    else {
        useCanvasStore.getState().updateProject(context.projectId, { nodes: context.nodes.current });
        await flushCanvasPersistence();
    }
}

/** Persist the request identity before the POST. A stopped/failed view is not evidence of an unsubmitted job. */
export function createCanvasMediaSubmission(nodeId: string, context: MediaCanvas) {
    const ownerId = useUserStore.getState().user?.id;
    if (!ownerId) throw new Error("当前账号不可用");
    let binding: MediaBinding | undefined = findNode(context, nodeId)?.metadata?.mediaTask;
    const current = () => (!context.isCurrent || context.isCurrent()) && Boolean(findNode(context, nodeId)) && useUserStore.getState().user?.id === ownerId;
    const patch = async (metadata: Partial<CanvasNodeMetadata>) => {
        if (!current()) throw new DOMException("画布或账号已变化", "AbortError");
        flushSync(() => context.setNodes(previous => previous.map(node => node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...metadata } } : node)));
        await persist(context);
        if (!current()) throw new DOMException("画布或账号已变化", "AbortError");
    };
    return {
        async onSubmissionStarted(requestId: string) {
            if (findNode(context, nodeId)?.metadata?.mediaTask) throw new Error("该结果仍有关联的原任务，请先查询，勿重复生成");
            binding = { requestId, ownerId, projectId: context.projectId };
            try { await patch({ mediaTask: binding, generationSubmissionUncertain: true }); }
            catch (error) {
                // This callback is awaited before POST, so a failed save has not submitted anything.
                binding = undefined;
                if (current()) await patch({ mediaTask: undefined, generationSubmissionUncertain: undefined }).catch(() => undefined);
                throw error;
            }
        },
        async onSubmitted(task: { id: string; requestId?: string }) {
            if (!binding) throw new Error("音视频任务缺少提交前的请求记录");
            binding = { ...binding, taskId: task.id };
            await patch({ mediaTask: binding, ...(findNode(context, nodeId)?.type === CanvasNodeType.Video ? { videoTaskId: task.id, videoTaskCanRecover: true } : {}) });
        },
        async complete(metadata: Partial<CanvasNodeMetadata>) {
            await patch({ ...metadata, mediaTask: undefined, generationSubmissionUncertain: undefined, videoTaskCanRecover: undefined, errorDetails: undefined });
        },
        async fail(error: unknown) {
            const uncertain = error instanceof QueuedTaskSubmissionUncertainError;
            const paused = error instanceof QueuedTaskPausedError;
            if (uncertain) binding = { requestId: error.requestId, taskId: error.taskId || binding?.taskId, ownerId, projectId: context.projectId };
            if (paused) binding = { requestId: error.task.requestId || binding?.requestId || "", taskId: error.taskId, ownerId, projectId: context.projectId };
            const pending = Boolean(binding && (uncertain || paused || (!canceled(error) && !(error instanceof QueuedTaskFailedError) && binding.taskId)));
            const detail = pending ? `${error instanceof Error ? error.message : "原任务结果尚未保存"}（已保留原任务，重试只查询，不重新生成）` : canceled(error) ? "生成已取消" : error instanceof Error ? error.message : "生成失败";
            await patch({ status: canceled(error) && !pending ? "idle" : "error", errorDetails: detail, mediaTask: pending ? binding : undefined, generationSubmissionUncertain: pending || undefined,
                ...(findNode(context, nodeId)?.type === CanvasNodeType.Video ? { videoTaskId: pending ? binding?.taskId : undefined, videoTaskCanRecover: pending ? Boolean(binding?.taskId) : undefined } : {}) }).catch(() => undefined);
            return detail;
        },
    };
}

function outputMetadata(file: UploadedFile, mode: "video" | "audio"): CanvasNodeMetadata {
    return { content: file.url, storageKey: file.storageKey, status: "success", bytes: file.bytes, mimeType: file.mimeType || (mode === "video" ? "video/mp4" : "audio/mpeg"), durationMs: file.durationMs,
        ...(mode === "video" ? { naturalWidth: file.width, naturalHeight: file.height, ...(file.serverAssetId ? { serverAssetId: file.serverAssetId } : {}) } : {}) };
}
function configMetadata(config: AiConfig, mode: "video" | "audio", context: NodeGenerationContext): CanvasNodeMetadata {
    return mode === "audio" ? { model: config.model, audioVoice: config.audioVoice, audioFormat: config.audioFormat, audioSpeed: config.audioSpeed, audioInstructions: config.audioInstructions }
        : { model: config.model, size: config.size, seconds: config.videoSeconds, videoMode: config.videoMode, vquality: config.vquality, generateAudio: config.videoGenerateAudio, watermark: config.videoWatermark,
            references: [...context.referenceImages.map(image => image.storageKey || image.url || (!image.dataUrl.startsWith("data:") ? image.dataUrl : undefined)), ...context.referenceVideos.map(video => video.storageKey || video.url), ...context.referenceAudios.map(audio => audio.storageKey || audio.url)].filter((url): url is string => Boolean(url)) };
}

export async function runCanvasMediaGeneration(input: Generation): Promise<CanvasGenerationOutput> {
    const { nodeId, mode, source, config, context, controller } = input;
    const base = NODE_DEFAULT_SIZE[mode === "video" ? CanvasNodeType.Video : CanvasNodeType.Audio];
    const spec = mode === "video" ? nodeSizeFromRatio(config.size, base.width, base.height) || base : base;
    const empty = source?.type === mode && !source.metadata?.content && !source.metadata?.storageKey;
    const outputId = empty ? nodeId : nanoid();
    const parent = source?.position || { x: 0, y: 0 };
    const output: CanvasNodeData = { id: outputId, type: mode === "video" ? CanvasNodeType.Video : CanvasNodeType.Audio,
        title: context.prompt.slice(0, 32) || (mode === "video" ? "Generated Video" : "Generated Audio"),
        position: empty ? source.position : { x: parent.x + (source?.width || spec.width) + 96, y: parent.y + (mode === "audio" ? ((source?.height || spec.height) - spec.height) / 2 : 0) },
        width: empty ? source.width : spec.width, height: empty ? source.height : spec.height,
        metadata: { prompt: context.prompt, generationOrigin: input.origin || { sourceNodeId: nodeId, runId: nanoid(), mode }, systemPrompt: config.systemPrompt, status: "loading", ...configMetadata(config, mode, context) } };
    flushSync(() => input.setNodes(previous => empty ? previous.map(node => node.id === nodeId ? { ...node, ...output } : node)
        : [...previous.map(node => node.id === nodeId && !input.shared ? { ...node, metadata: { ...node.metadata, status: "success" as const } } : node), output]));
    if (!empty) input.setConnections(previous => [...previous, { id: nanoid(), fromNodeId: nodeId, toNodeId: outputId, kind: "generation-output" }]);
    input.start(outputId, nodeId, input.runningId, controller);
    const submission = createCanvasMediaSubmission(outputId, input);
    try {
        const options = { signal: controller.signal, onSubmissionStarted: submission.onSubmissionStarted, onSubmitted: submission.onSubmitted };
        const file = mode === "video"
            ? await storeGeneratedVideo(await requestVideoGeneration(config, context.prompt, context.referenceImages, context.referenceVideos, context.referenceAudios, { ...options, toolKey: "canvas-video" }))
            : await storeGeneratedAudio(await requestAudioGeneration(config, context.prompt, options), config.audioFormat);
        if (mode === "video") {
            const size = fitNodeSize(file.width || spec.width, file.height || spec.height, 420, 420);
            flushSync(() => input.setNodes(previous => previous.map(node => node.id === outputId ? { ...node, ...size, position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 } } : node)));
        }
        await submission.complete(outputMetadata(file, mode));
        return { nodeId: outputId, status: "success", url: file.url, storageKey: file.storageKey };
    } catch (error) {
        const detail = await submission.fail(error);
        if (!input.shared && nodeId !== outputId) input.setNodes(previous => previous.map(node => node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: canceled(error) ? "idle" : "error", errorDetails: detail } } : node));
        return { nodeId: outputId, status: "failed", error: detail };
    } finally { input.finish(outputId, controller); }
}

/** Query/recover the recorded task only. A missing response or a 404 never authorizes a replacement POST. */
export async function recoverCanvasMediaTask(nodeId: string, context: MediaCanvas, signal?: AbortSignal): Promise<CanvasGenerationOutput | null> {
    const node = findNode(context, nodeId);
    const binding = node?.metadata?.mediaTask;
    if (!node || !binding) return null;
    if (binding.projectId !== context.projectId || binding.ownerId !== useUserStore.getState().user?.id) throw new Error("原任务属于其他画布或账号，不能恢复");
    const submission = createCanvasMediaSubmission(nodeId, context);
    try {
        signal?.throwIfAborted();
        const task = binding.taskId ? await getQueuedTask(binding.taskId, signal) : await getQueuedTaskByRequestId(binding.requestId, signal);
        if (!task) throw new QueuedTaskSubmissionUncertainError(binding.requestId, binding.taskId);
        await submission.onSubmitted(task);
        if (task.status === "failed" || task.status === "cancelled") throw new QueuedTaskFailedError(task);
        const [url] = task.status === "success" ? task.resultUrls : await recoverQueuedMedia(task.id, signal);
        if (!url) throw new QueuedTaskSubmissionUncertainError(binding.requestId, task.id);
        const mode = node.type === CanvasNodeType.Video ? "video" : "audio";
        let file: UploadedFile;
        if (mode === "video") file = await storeGeneratedVideo({ url, mimeType: "video/mp4" });
        else {
            const response = await fetch(url, { credentials: "include", signal });
            if (!response.ok) throw new Error("原音频结果读取失败");
            file = await storeGeneratedAudio(await response.blob(), node.metadata?.audioFormat);
        }
        signal?.throwIfAborted();
        if (mode === "video") {
            const size = fitNodeSize(file.width || node.width, file.height || node.height, 420, 420);
            flushSync(() => context.setNodes(previous => previous.map(item => item.id === nodeId ? { ...item, ...size } : item)));
        }
        await submission.complete(outputMetadata(file, mode));
        return { nodeId, status: "success", url: file.url, storageKey: file.storageKey };
    } catch (error) {
        // A failed lookup, even before a task ID is learned, is never evidence that the POST was absent.
        const failure = error instanceof QueuedTaskFailedError || error instanceof QueuedTaskPausedError || error instanceof QueuedTaskSubmissionUncertainError
            ? error : new QueuedTaskSubmissionUncertainError(binding.requestId, binding.taskId, error);
        return { nodeId, status: "failed", error: await submission.fail(failure) };
    }
}

export function confirmCanvasTextRetry(node: CanvasNodeData, context: {
    nodes: RefObject<CanvasNodeData[]>; setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>; locks: Set<string>;
    generate: (nodeId: string, mode: CanvasGenerationMode, prompt: string) => Promise<void>;
    message: { info: (text: string) => unknown; warning: (text: string) => unknown };
    modal: { confirm: (options: { title: string; content: string; okText: string; cancelText: string; onOk: () => Promise<void> }) => unknown };
}) {
    const origin = node.metadata?.generationOrigin;
    if (!origin) { context.message.warning("原文本任务状态待核查，请先检查原结果"); return; }
    context.modal.confirm({ title: "重新提交文本任务？", content: "原文本请求已发出但结果未完整保存，无法恢复原响应。继续将创建新任务，可能再次扣费。", okText: "确认新任务", cancelText: "取消", onOk: async () => {
        if (context.locks.size) { context.message.info("当前任务仍在执行，请稍后重试"); return; }
        const config = context.nodes.current.find(item => item.id === origin.configNodeId);
        if (config?.metadata?.generationMode !== "text" || !context.nodes.current.some(item => item.id === origin.sourceNodeId)) { context.message.warning("原文本配置或输入已变化，请先检查公共配置"); return; }
        context.nodes.current = context.nodes.current.map(item => item.id === node.id ? { ...item, metadata: { ...item.metadata, generationSubmissionUncertain: undefined } } : item);
        context.setNodes(context.nodes.current);
        await context.generate(origin.sourceNodeId, "text", "");
    } });
}

export async function retryCanvasMediaNode(nodeId: string, context: MediaCanvas & {
    locks: Set<string>; start: (targetId: string, sourceId: string, runningId: string) => AbortController;
    finish: (targetId: string, controller: AbortController) => void; setRunning: Dispatch<SetStateAction<string | null>>;
    message: { success: (text: string) => unknown; warning: (text: string) => unknown; error: (text: string) => unknown };
}) {
    if (context.locks.size) return;
    context.locks.add(nodeId);
    const controller = context.start(nodeId, nodeId, nodeId);
    context.setRunning(nodeId);
    try {
        const result = await recoverCanvasMediaTask(nodeId, context, controller.signal);
        if (result?.status === "success") context.message.success("已取回原任务结果");
        else context.message.warning(result?.error || "提交状态待核查，请先检查原任务，勿重复生成");
    } catch (error) { context.message.error(error instanceof Error ? error.message : "原任务查询失败"); }
    finally { context.finish(nodeId, controller); context.setRunning(null); context.locks.delete(nodeId); }
}
