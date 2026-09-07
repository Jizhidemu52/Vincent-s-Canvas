import { dataUrlToFile } from "@/lib/image-utils";
import { videoModelRequestParameters, videoReferenceError } from "@/lib/video-model-parameters";
import { getQueuedTask, QueuedTaskPausedError, recoverQueuedMedia, requestQueuedMedia, submitQueuedMediaTask } from "@/services/api/generation-tasks";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import type { HappyHorseMode } from "@/lib/happyhorse-video";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type RequestOptions = { signal?: AbortSignal; onSubmitted?: (task: VideoGenerationTask) => void };

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = { id: string; provider: "server"; model: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    const input = await queuedVideoInput(config, prompt, references, videoReferences, audioReferences, options);
    const [url] = await requestQueuedMedia({ ...input, onSubmitted: (task) => options?.onSubmitted?.({ id: task.id, provider: "server", model: input.modelId }) });
    if (!url) throw new Error("视频任务没有返回结果");
    return { url, mimeType: "video/mp4" };
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions, happyHorseMode?: HappyHorseMode): Promise<VideoGenerationTask> {
    const task = await submitQueuedMediaTask(await queuedVideoInput(config, prompt, references, videoReferences, audioReferences, options, happyHorseMode));
    return { id: task.id, provider: "server", model: modelOptionName(config.model || config.videoModel) };
}

export async function recoverVideoGenerationTask(task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationResult> {
    const [url] = await recoverQueuedMedia(task.id, options?.signal);
    if (!url) throw new Error("原视频任务没有返回结果");
    return { url, mimeType: "video/mp4" };
}

export async function pollVideoGenerationTask(_config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (options?.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    const current = await getQueuedTask(task.id);
    if (!current) return { status: "failed", error: "视频任务不存在或已过期" };
    if (current.status === "paused") throw new QueuedTaskPausedError(current);
    if (current.status === "failed" || current.status === "cancelled") return { status: "failed", error: current.failureReason || "视频生成失败" };
    if (current.status !== "success") return { status: "pending" };
    const url = current.resultUrls[0];
    return url ? { status: "completed", result: { url, mimeType: "video/mp4" } } : { status: "failed", error: "视频任务成功但没有返回结果" };
}

export async function storeGeneratedVideo(result: VideoGenerationResult, options: { saveBlob?: (blob: Blob, prefix?: string) => Promise<UploadedFile>; fetch?: typeof fetch } = {}): Promise<UploadedFile> {
    if (result.url) {
        const response = await (options.fetch || fetch)(result.url, { credentials: "include" });
        if (!response.ok) throw new Error(`视频结果读取失败（${response.status}），可恢复原任务`);
        const bytes = await response.blob();
        if (!bytes.size) throw new Error("视频结果为空，可恢复原任务");
        if (bytes.type && !bytes.type.startsWith("video/") && bytes.type !== "application/octet-stream") throw new Error("视频结果格式无效，可恢复原任务");
        const blob = bytes.type.startsWith("video/") ? bytes : new Blob([bytes], { type: result.mimeType || "video/mp4" });
        const stored = await (options.saveBlob || uploadMediaFile)(blob, "video");
        const serverAssetId = result.url.match(/^\/api\/assets\/([0-9a-f-]+)\/content(?:\?|$)/i)?.[1];
        return { ...stored, ...(serverAssetId ? { serverAssetId } : {}) };
    }
    if (result.blob) return (options.saveBlob || uploadMediaFile)(result.blob, "video");
    throw new Error("视频接口没有返回可播放的视频");
}

async function queuedVideoInput(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions, happyHorseMode?: HappyHorseMode) {
    const modelId = modelOptionName(config.model || config.videoModel);
    // Preserve the legacy HappyHorse mode when callers still carry the default auto mode.
    const requestConfig = happyHorseMode && (!config.videoMode || config.videoMode === "auto") ? { ...config, videoMode: happyHorseMode } : config;
    const error = videoReferenceError(requestConfig, references, videoReferences, audioReferences);
    if (error) throw new Error(error);
    const parameters = { ...videoModelRequestParameters(requestConfig), ...(modelId === "happyhorse-1.1" && happyHorseMode ? { happyHorseMode } : {}) };
    const sourceFiles: File[] = [];
    const sourceUrls: string[] = [];
    const sourceMetadata: Record<string, unknown>[] = [];
    const sourceOrder: Array<{ kind: "file" | "url"; index: number }> = [];
    const addFile = (file: File, metadata: Record<string, unknown>) => {
        sourceOrder.push({ kind: "file", index: sourceFiles.length });
        sourceFiles.push(file);
        sourceMetadata.push(metadata);
    };
    const resolvedImages: ReferenceImage[] = [];
    const resolvedVideos: ReferenceVideo[] = [];
    const resolvedAudios: ReferenceAudio[] = [];
    for (const image of references) {
        const file = dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) });
        resolvedImages.push({ ...image, bytes: file.size, type: file.type });
        addFile(file, { width: image.width, height: image.height });
    }
    for (const [kind, items] of [["video", videoReferences], ["audio", audioReferences]] as const) {
        for (const item of items) {
            const source = await resolveVideoReferenceSource(item, kind, options?.signal);
            const resolved = { ...item, ...(source instanceof File ? { bytes: source.size, type: source.type } : {}) };
            if (kind === "video") resolvedVideos.push(resolved as ReferenceVideo);
            else resolvedAudios.push(resolved as ReferenceAudio);
            if (source instanceof File) addFile(source, { durationMs: item.durationMs, width: (item as ReferenceVideo).width, height: (item as ReferenceVideo).height, fps: (item as ReferenceVideo).fps });
            else { sourceOrder.push({ kind: "url", index: sourceUrls.length }); sourceUrls.push(source); }
        }
    }
    const resolvedError = videoReferenceError(requestConfig, resolvedImages, resolvedVideos, resolvedAudios);
    if (resolvedError) throw new Error(resolvedError);
    return {
        modelId,
        prompt,
        operationType: "video_generation",
        parameters,
        sourceFiles,
        sourceUrls,
        sourceMetadata,
        sourceOrder,
        signal: options?.signal,
    };
}

/** Local persistent bytes take priority over expired object URLs; never send blob: to the server. */
export async function resolveVideoReferenceSource(reference: ReferenceVideo | ReferenceAudio, kind: "video" | "audio", signal?: AbortSignal, readBlob = getMediaBlob): Promise<File | string> {
    if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    const stored = reference.storageKey ? await readBlob(reference.storageKey) : null;
    const toFile = (blob: Blob) => {
        if (!blob.size) throw new Error(`${reference.name || "参考素材"} 文件为空`);
        const mime = blob.type && blob.type !== "application/octet-stream" ? blob.type : reference.type;
        if (!mime?.startsWith(`${kind}/`)) throw new Error("参考素材格式与视频/音频类型不一致，请重新导入");
        return new File([blob], reference.name || `${kind}-reference.${kind === "video" ? "mp4" : "mp3"}`, { type: mime });
    };
    if (stored) return toFile(stored);
    const url = reference.url?.trim();
    if (!url) throw new Error("本地参考素材已丢失，请重新导入原文件");
    if (/^\/api\/assets\/[\w-]+\/content(?:\?[^#]*)?$/.test(url)) return url;
    if (/^https?:\/\//i.test(url)) {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) throw new Error("参考素材 URL 不能包含账号凭据");
        return url;
    }
    if (!url.startsWith("blob:") && !url.startsWith(`data:${kind}/`)) throw new Error("参考素材地址无效，请重新导入原文件");
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("本地参考素材读取失败，请重新导入原文件");
    return toFile(await response.blob());
}
