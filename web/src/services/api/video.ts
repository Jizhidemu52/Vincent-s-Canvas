import { dataUrlToFile } from "@/lib/image-utils";
import { getVideoModelParameterSpec, videoModelRequestParameters } from "@/lib/video-model-parameters";
import { getQueuedTask, QueuedTaskPausedError, recoverQueuedMedia, requestQueuedMedia, submitQueuedMediaTask } from "@/services/api/generation-tasks";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
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
    const spec = getVideoModelParameterSpec(config);
    if (references.length > (spec?.maxImages ?? 0)) throw new Error(`当前视频模型最多支持 ${spec?.maxImages ?? 0} 张参考图`);
    if (videoReferences.length || audioReferences.length) throw new Error("当前视频接口尚未接入视频或音频参考，请移除这些参考后重试。");
    if (happyHorseMode === "edit") throw new Error("HappyHorse 1.1 不支持视频编辑，请切换文生、首帧或参考图模式。");
    if (modelId === "happyhorse-1.1") {
        if (happyHorseMode === "text" && references.length) throw new Error("文生视频模式不接收图片，请移除参考图或切换模式。");
        if (happyHorseMode === "first-frame" && references.length !== 1) throw new Error("首帧图生视频需要恰好 1 张图片。");
        if (happyHorseMode === "reference" && !references.length) throw new Error("参考图模式需要 1–9 张图片。");
    }
    const parameters = { ...videoModelRequestParameters(config), ...(modelId === "happyhorse-1.1" && happyHorseMode ? { happyHorseMode } : {}) };
    const sourceFiles: File[] = [];
    const sourceUrls: string[] = [];
    for (const image of references) sourceFiles.push(dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) }));
    return {
        modelId,
        prompt,
        operationType: "video_generation",
        parameters,
        sourceFiles,
        sourceUrls,
        signal: options?.signal,
    };
}
