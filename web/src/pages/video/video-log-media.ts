import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoLogMedia = {
    video?: { storageKey: string; url: string };
    references: ReferenceImage[];
    videoReferences: ReferenceVideo[];
    audioReferences: ReferenceAudio[];
};

type MediaResolvers = {
    image: (storageKey: string | undefined, fallback: string) => Promise<string>;
    media: (storageKey: string, fallback: string) => Promise<string>;
};

/** Resolve blobs only for the selected record, never while listing the history. */
export async function hydrateVideoLogMedia<T extends VideoLogMedia>(log: T, resolve: MediaResolvers, includeReferences = true): Promise<T> {
    const [video, references, videoReferences, audioReferences] = await Promise.all([
        log.video?.storageKey ? resolve.media(log.video.storageKey, log.video.url).then((url) => ({ ...log.video!, url })) : log.video,
        includeReferences ? Promise.all(log.references.map(async (item) => ({ ...item, dataUrl: await resolve.image(item.storageKey, item.dataUrl) }))) : log.references,
        includeReferences ? Promise.all(log.videoReferences.map(async (item) => ({ ...item, url: item.storageKey ? await resolve.media(item.storageKey, item.url) : item.url }))) : log.videoReferences,
        includeReferences ? Promise.all(log.audioReferences.map(async (item) => ({ ...item, url: item.storageKey ? await resolve.media(item.storageKey, item.url) : item.url }))) : log.audioReferences,
    ]);
    if (log.video && !video?.url) throw new Error("这条记录的视频文件不在当前浏览器中，请从素材库查找或重新导入原文件。");
    return { ...log, video, references, videoReferences, audioReferences };
}

/** A slow earlier selection must not replace the newer selection or a new session. */
export function createLatestVideoPreview() {
    let revision = 0;
    return {
        invalidate() { revision += 1; },
        async load<T>(read: () => Promise<T>, accept: (value: T) => void, fail: (error: unknown) => void) {
            const current = ++revision;
            try {
                const value = await read();
                if (current === revision) accept(value);
            } catch (error) {
                if (current === revision) fail(error);
            }
        },
    };
}
