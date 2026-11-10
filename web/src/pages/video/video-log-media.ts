import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { QueuedTask } from "@/services/api/generation-tasks";
import { completedTaskDurationMs } from "@/lib/completed-task-duration";

type VideoLogMedia = {
    video?: { storageKey: string; url: string; serverAssetId?: string; playbackSourceError?: string; durationMs?: number | null };
    task?: { id: string };
    status?: string;
    durationMs?: number | null;
    references: ReferenceImage[];
    videoReferences: ReferenceVideo[];
    audioReferences: ReferenceAudio[];
};

type MediaResolvers = {
    image: (storageKey: string | undefined, fallback: string) => Promise<string>;
    media: (storageKey: string, fallback: string) => Promise<string>;
    task?: (id: string, signal?: AbortSignal) => Promise<Pick<QueuedTask, "status" | "resultUrls" | "queuedAt" | "startedAt" | "completedAt" | "createdAt" | "updatedAt"> & { id?: string } | null>;
    refreshDuration?: boolean;
};

const assetIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function videoAssetId(log: VideoLogMedia, read: MediaResolvers["task"], signal?: AbortSignal) {
    if (log.video?.serverAssetId && assetIdPattern.test(log.video.serverAssetId)) return log.video.serverAssetId;
    if (!log.video || !log.task?.id || !read) return undefined;
    const task = await read(log.task.id, signal);
    signal?.throwIfAborted();
    if (!task || task.status !== "success" || (task.id && task.id !== log.task.id)) return undefined;
    const id = task.resultUrls[0]?.match(/^\/api\/assets\/([^/]+)\/content(?:\?[^#]*)?$/i)?.[1];
    return id && assetIdPattern.test(id) ? id : undefined;
}

/** Resolve blobs only for the selected record, never while listing the history. */
export async function hydrateVideoLogMedia<T extends VideoLogMedia>(log: T, resolve: MediaResolvers, includeReferences = true, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    // One selected record can need both its original asset identity and timing.
    // Share the same GET; neither lookup submits or resumes provider work.
    let originalTask: ReturnType<NonNullable<MediaResolvers["task"]>> | undefined;
    const readOriginalTask: MediaResolvers["task"] = resolve.task ? (id, taskSignal) => originalTask ??= resolve.task!(id, taskSignal) : undefined;
    let checkedDuration: number | null | undefined;
    if (resolve.refreshDuration && log.status === "成功" && log.video && log.task?.id && readOriginalTask) {
        try {
            const task = await readOriginalTask(log.task.id, signal);
            signal?.throwIfAborted();
            if (task?.id === log.task.id && task.status === "success") checkedDuration = completedTaskDurationMs(task);
        } catch { signal?.throwIfAborted(); }
    }
    let playbackSourceError: string | undefined;
    let serverAssetId = log.video?.serverAssetId && assetIdPattern.test(log.video.serverAssetId) ? log.video.serverAssetId : undefined;
    if (!serverAssetId && log.video && log.task?.id && resolve.task) {
        serverAssetId = await videoAssetId(log, readOriginalTask, signal).catch(error => {
            signal?.throwIfAborted();
            playbackSourceError = error instanceof Error ? error.message : "原任务视频来源暂时无法读取";
            return undefined;
        });
    }
    const [video, references, videoReferences, audioReferences] = await Promise.all([
        log.video?.storageKey ? resolve.media(log.video.storageKey, log.video.url).then((url) => ({ ...log.video!, url })) : log.video,
        includeReferences ? Promise.all(log.references.map(async (item) => ({ ...item, dataUrl: await resolve.image(item.storageKey, item.dataUrl) }))) : log.references,
        includeReferences ? Promise.all(log.videoReferences.map(async (item) => ({ ...item, url: item.storageKey ? await resolve.media(item.storageKey, item.url) : item.url }))) : log.videoReferences,
        includeReferences ? Promise.all(log.audioReferences.map(async (item) => ({ ...item, url: item.storageKey ? await resolve.media(item.storageKey, item.url) : item.url }))) : log.audioReferences,
    ]);
    signal?.throwIfAborted();
    if (log.video && !video?.url && !serverAssetId) throw new Error(playbackSourceError || "这条记录的视频文件不在当前浏览器中，请从素材库查找或重新导入原文件。");
    const resolvedVideo = video ? { ...video } : video;
    if (resolvedVideo) {
        if (checkedDuration !== undefined) resolvedVideo.durationMs = checkedDuration;
        if (serverAssetId) resolvedVideo.serverAssetId = serverAssetId;
        else delete resolvedVideo.serverAssetId;
        if (playbackSourceError) resolvedVideo.playbackSourceError = playbackSourceError;
    }
    return { ...log, ...(checkedDuration !== undefined ? { durationMs: checkedDuration } : {}), video: resolvedVideo, references, videoReferences, audioReferences };
}

/** A slow earlier selection must not replace the newer selection or a new session. */
export function createLatestVideoPreview() {
    let revision = 0;
    let controller: AbortController | undefined;
    return {
        invalidate() { revision += 1; controller?.abort(); },
        async load<T>(read: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void, fail: (error: unknown) => void) {
            const current = ++revision;
            controller?.abort();
            controller = new AbortController();
            try {
                const value = await read(controller.signal);
                if (current === revision) accept(value);
            } catch (error) {
                if (current === revision) fail(error);
            }
        },
    };
}
