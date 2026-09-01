import { dataUrlToFile } from "@/lib/image-utils";
import { getQueuedTask, requestQueuedMedia, submitQueuedMediaTask } from "@/services/api/generation-tasks";
import { getMediaBlob, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import type { HappyHorseMode } from "@/lib/happyhorse-video";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type RequestOptions = { signal?: AbortSignal };

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = { id: string; provider: "server"; model: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    const [url] = await requestQueuedMedia(await queuedVideoInput(config, prompt, references, videoReferences, audioReferences, options));
    if (!url) throw new Error("视频任务没有返回结果");
    return { url, mimeType: "video/mp4" };
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions, happyHorseMode?: HappyHorseMode): Promise<VideoGenerationTask> {
    const task = await submitQueuedMediaTask(await queuedVideoInput(config, prompt, references, videoReferences, audioReferences, options, happyHorseMode));
    return { id: task.id, provider: "server", model: modelOptionName(config.model || config.videoModel) };
}

export async function pollVideoGenerationTask(_config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (options?.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    const current = await getQueuedTask(task.id);
    if (!current) return { status: "failed", error: "视频任务不存在或已过期" };
    if (current.status === "failed" || current.status === "cancelled") return { status: "failed", error: current.failureReason || "视频生成失败" };
    if (current.status !== "success") return { status: "pending" };
    const url = current.resultUrls[0];
    return url ? { status: "completed", result: { url, mimeType: "video/mp4" } } : { status: "failed", error: "视频任务成功但没有返回结果" };
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.url) return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
    if (result.blob) return { url: URL.createObjectURL(result.blob), storageKey: "", bytes: result.blob.size, mimeType: result.blob.type || "video/mp4" };
    throw new Error("视频接口没有返回可播放的视频");
}

async function queuedVideoInput(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions, _happyHorseMode?: HappyHorseMode) {
    const sourceFiles: File[] = [];
    const sourceUrls: string[] = [];
    for (const image of references) sourceFiles.push(dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) }));
    for (const media of [...videoReferences, ...audioReferences]) {
        if (media.url.startsWith("/api/assets/")) {
            sourceUrls.push(media.url);
            continue;
        }
        let blob: Blob | null = null;
        if (media.storageKey) blob = await getMediaBlob(media.storageKey);
        if (!blob && media.url) blob = await fetch(media.url, { credentials: "include", signal: options?.signal }).then((response) => response.blob());
        if (blob) sourceFiles.push(new File([blob], `${media.id}.${blob.type.split("/")[1] || "bin"}`, { type: blob.type }));
    }
    return {
        modelId: modelOptionName(config.model || config.videoModel),
        prompt,
        operationType: "video_generation",
        parameters: {
            seconds: Number.isFinite(Number(config.videoSeconds)) ? Number(config.videoSeconds) : 5,
            size: config.size || "auto",
            resolution: config.vquality || "auto",
            generateAudio: config.videoGenerateAudio === "true",
            watermark: config.videoWatermark === "true",
        },
        sourceFiles,
        sourceUrls,
        signal: options?.signal,
    };
}
