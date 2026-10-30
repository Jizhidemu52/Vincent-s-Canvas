import type { CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import { type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "@/constant/canvas";
import { canvasCompareSource } from "@/lib/canvas/canvas-image-compare-source";
import { canvasImageReferenceIdentity, originalReferenceFileName } from "@/lib/canvas/canvas-image-filename";
import { nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { QueuedTaskFailedError, QueuedTaskPausedError } from "@/services/api/generation-tasks";
import { type UploadedFile } from "@/services/file-storage";
import { type UploadedImage } from "@/services/image-storage";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasAgentMediaWorkflow, type CanvasImageGenerationType, type CanvasNodeData, type CanvasNodeMetadata, type Position } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";

export const INTERRUPTED_IMAGE_TASK_ERROR = "本地查询已中断，可恢复原图片任务，不会重新生成。";

export function hasPendingImageTask(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    return node.type === CanvasNodeType.Image && (node.metadata?.imageTask || (node.metadata?.isBatchRoot && nodes.some(child => child.metadata?.batchRootId === node.id && child.metadata.imageTask)));
}

export type CanvasGenerationOutput = {
    nodeId: string;
    status: "success" | "failed";
    url?: string;
    storageKey?: string;
    error?: string;
};

export type CanvasGenerationResult = {
    mode: CanvasNodeGenerationMode;
    outputs: CanvasGenerationOutput[];
};

export function createCanvasNode(type: CanvasNodeType, position: Position, metadata?: CanvasNodeMetadata): CanvasNodeData {
    const spec = getNodeSpec(type);
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    return {
        id,
        type,
        title: spec.title,
        position: {
            x: position.x - spec.width / 2,
            y: position.y - spec.height / 2,
        },
        width: spec.width,
        height: spec.height,
        metadata: { ...spec.metadata, ...metadata },
    };
}

export function audioExtension(mimeType?: string) {
    if (mimeType?.includes("wav")) return "wav";
    if (mimeType?.includes("opus")) return "opus";
    if (mimeType?.includes("aac")) return "aac";
    if (mimeType?.includes("flac")) return "flac";
    if (mimeType?.includes("pcm")) return "pcm";
    return "mp3";
}

export function imageMetadata(image: UploadedImage): CanvasNodeMetadata {
    return { imageTask: undefined, errorDetails: undefined, content: image.url, storageKey: image.storageKey, status: "success", naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType, ...(image.originalFileName ? { originalFileName: image.originalFileName, imageName: image.originalFileName.replace(/\.[^.]+$/, ""), imageVersion: 1 } : {}) };
}

export function workflowImageCandidatesFromResult(result: CanvasGenerationResult | undefined): CanvasAgentMediaWorkflow["candidates"] {
    return (result?.outputs || []).map((output) => ({
        nodeId: output.nodeId,
        status: output.status,
        ...(output.url ? { url: output.url } : {}),
        ...(output.storageKey ? { storageKey: output.storageKey } : {}),
    }));
}

export function videoMetadata(video: UploadedFile): CanvasNodeMetadata {
    return { content: video.url, storageKey: video.storageKey, status: "success", naturalWidth: video.width, naturalHeight: video.height, bytes: video.bytes, mimeType: video.mimeType || "video/mp4", durationMs: video.durationMs, ...(video.serverAssetId ? { serverAssetId: video.serverAssetId } : {}) };
}

export function audioMetadata(audio: UploadedFile): CanvasNodeMetadata {
    return { content: audio.url, storageKey: audio.storageKey, status: "success", bytes: audio.bytes, mimeType: audio.mimeType || "audio/mpeg", durationMs: audio.durationMs };
}

export function buildImageGenerationMetadata(type: CanvasImageGenerationType, config: AiConfig, count: number, references: ReferenceImage[]): CanvasNodeMetadata {
    return {
        originalFileName: originalReferenceFileName(references),
        ...canvasImageReferenceIdentity(references[0]),
        generationType: type,
        model: config.model,
        size: config.size,
        quality: config.quality,
        imageOptions: config.imageOptions || "",
        count,
        references: references.map(referenceUrl).filter((url): url is string => Boolean(url)),
        compareSources: references.map(canvasCompareSource),
    };
}

export function buildAudioGenerationMetadata(config: AiConfig): CanvasNodeMetadata {
    return {
        model: config.model,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioInstructions: config.audioInstructions,
    };
}

function referenceUrl(image: ReferenceImage) {
    return image.storageKey || image.url || (!image.dataUrl.startsWith("data:") ? image.dataUrl : undefined);
}

export function getGenerationCount(count: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(count)) || 1)));
}

export function applyNodeConfigPatch(node: CanvasNodeData, patch: Partial<CanvasNodeData["metadata"]>) {
    const safePatch = patch || {};
    const next = { ...node, metadata: { ...node.metadata, ...safePatch } };
    const spec = node.type === CanvasNodeType.Video ? NODE_DEFAULT_SIZE[CanvasNodeType.Video] : NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    const size = typeof safePatch.size === "string" && !node.metadata?.content ? nodeSizeFromRatio(safePatch.size, spec.width, spec.height) : null;
    return size && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) ? { ...next, ...size, position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 } } : next;
}

export function getInputSummary(inputs: NodeGenerationInput[]) {
    return {
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: inputs.filter((input) => input.type === "image").length,
        videoCount: inputs.filter((input) => input.type === "video").length,
        audioCount: inputs.filter((input) => input.type === "audio").length,
    };
}

export function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasNodeGenerationMode): AiConfig {
    const defaultModel = mode === "image" ? config.imageModel : mode === "video" ? config.videoModel : mode === "audio" ? config.audioModel : config.textModel;
    const recorded = mode === "image" ? node?.metadata?.generationRecord?.parameters : undefined;
    return {
        ...config,
        systemPrompt: node?.metadata?.systemPrompt ?? recorded?.systemPrompt ?? config.systemPrompt,
        model: node?.metadata?.model || recorded?.model || defaultModel || (mode === "audio" ? defaultConfig.audioModel : config.model || defaultConfig.model),
        quality: mode === "image" ? node?.metadata?.quality ?? recorded?.quality ?? config.quality ?? defaultConfig.quality : node?.metadata?.quality || config.quality || defaultConfig.quality,
        imageOptions: node?.metadata?.imageOptions ?? recorded?.imageOptions ?? config.imageOptions,
        size: node?.metadata?.size || recorded?.size || config.size || defaultConfig.size,
        videoSeconds: node?.metadata?.seconds || config.videoSeconds || defaultConfig.videoSeconds,
        videoMode: node?.metadata?.videoMode || config.videoMode || defaultConfig.videoMode,
        vquality: node?.metadata?.vquality || config.vquality || defaultConfig.vquality,
        videoGenerateAudio: node?.metadata?.generateAudio || config.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node?.metadata?.watermark || config.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node?.metadata?.audioVoice || config.audioVoice || defaultConfig.audioVoice,
        audioFormat: node?.metadata?.audioFormat || config.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node?.metadata?.audioSpeed || config.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node?.metadata?.audioInstructions || config.audioInstructions || defaultConfig.audioInstructions,
        count: mode === "image" ? "1" : String(node?.metadata?.count || config.count || defaultConfig.count),
    };
}

export function videoTaskErrorMetadata(error: unknown): Partial<CanvasNodeMetadata> {
    if (error instanceof QueuedTaskPausedError) return { videoTaskId: error.taskId, videoTaskCanRecover: error.canRecover };
    if (error instanceof QueuedTaskFailedError) return { videoTaskId: undefined, videoTaskCanRecover: undefined };
    return {};
}

export function isGenerationCanceled(error: unknown) {
    return error instanceof Error && (error.message === "请求已取消" || error.name === "AbortError");
}

export function buildAngleLabel(params: CanvasImageAngleParams) {
    const horizontal = params.horizontalAngle === 0 ? "正面视角" : params.horizontalAngle > 0 ? `向右旋转 ${params.horizontalAngle} 度` : `向左旋转 ${Math.abs(params.horizontalAngle)} 度`;
    const pitch = params.pitchAngle === 0 ? "水平视角" : params.pitchAngle > 0 ? `俯视 ${params.pitchAngle} 度` : `仰视 ${Math.abs(params.pitchAngle)} 度`;
    return `AI 多角度：${horizontal}，${pitch}，镜头距离 ${params.cameraDistance.toFixed(1)}，${params.wideAngle ? "广角" : "标准"}镜头`;
}

export function buildAnglePrompt(params: CanvasImageAngleParams) {
    return `基于参考图重新生成同一主体的新视角，保持主体、颜色、材质和画面风格一致，不要只做透视变形。${buildAngleLabel(params)}。`;
}
