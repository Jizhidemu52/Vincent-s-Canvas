import { expect, test } from "bun:test";
import { createLatestVideoPreview, hydrateVideoLogMedia } from "../src/pages/video/video-log-media";

const log = {
    id: "record-1", title: "原任务",
    video: { id: "output", url: "", storageKey: "video:output", width: 1280 },
    references: [{ id: "image", name: "参考图", type: "image/png", dataUrl: "", storageKey: "image:reference" }],
    videoReferences: [{ id: "video", name: "参考视频", type: "video/mp4", url: "", storageKey: "video:reference" }],
    audioReferences: [{ id: "audio", name: "参考音频", type: "audio/mpeg", url: "https://example.test/audio.mp3" }],
};

test("restoring the latest result reads one video and no historical references", async () => {
    const calls: string[] = [];
    const resolved = await hydrateVideoLogMedia(log, {
        media: async (key) => { calls.push(key); return `blob:${key}`; },
        image: async (key) => { throw new Error(`unexpected reference read: ${key}`); },
    }, false);
    expect(calls).toEqual(["video:output"]);
    expect(resolved.video).toEqual({ ...log.video, url: "blob:video:output" });
    expect(resolved.references).toBe(log.references);
    expect(log.video.url).toBe("");
});

test("selecting a record restores only its media and preserves all metadata and direct URLs", async () => {
    const calls: string[] = [];
    const resolved = await hydrateVideoLogMedia(log, {
        media: async (key) => { calls.push(key); return `blob:${key}`; },
        image: async (key) => { calls.push(key!); return `blob:${key}`; },
    });
    expect(calls.sort()).toEqual(["image:reference", "video:output", "video:reference"]);
    expect(resolved.references[0]?.dataUrl).toBe("blob:image:reference");
    expect(resolved.videoReferences[0]?.url).toBe("blob:video:reference");
    expect(resolved.audioReferences).toEqual(log.audioReferences);
    expect(resolved.id).toBe(log.id);
    expect(resolved.video?.width).toBe(1280);
});

test("a missing persisted video is an actionable error, not an empty video src", async () => {
    await expect(hydrateVideoLogMedia(log, { media: async () => "", image: async () => "" }, false)).rejects.toThrow("视频文件不在当前浏览器");
});

test("a slow older record does not overwrite a newer preview", async () => {
    const loader = createLatestVideoPreview();
    const accepted: string[] = [];
    let finishOld!: (value: string) => void;
    const old = loader.load(() => new Promise<string>((resolve) => { finishOld = resolve; }), (value) => accepted.push(value), () => {});
    await loader.load(async () => "newer", (value) => accepted.push(value), () => {});
    finishOld("older");
    await old;
    expect(accepted).toEqual(["newer"]);
});

test("starting a new session or leaving the page drops pending preview errors/results", async () => {
    const loader = createLatestVideoPreview();
    const accepted: string[] = [];
    const errors: unknown[] = [];
    let reject!: (error: Error) => void;
    const pending = loader.load(() => new Promise<string>((_resolve, fail) => { reject = fail; }), (value) => accepted.push(value), (error) => errors.push(error));
    loader.invalidate();
    reject(new Error("old missing blob"));
    await pending;
    expect(accepted).toEqual([]);
    expect(errors).toEqual([]);
});

test("server asset identity takes priority and preserves original bytes and storage key", async () => {
    const serverAssetId = "7075c394-1184-44cc-9077-068d78e8b36d";
    const source = { ...log, task: { id: "old-task" }, video: { ...log.video, serverAssetId } };
    const resolved = await hydrateVideoLogMedia(source, {
        media: async () => "", image: async () => "",
        task: async () => { throw new Error("must not query an already identified asset"); },
    }, false);
    expect(resolved.video).toEqual(source.video);
    expect(source.video.url).toBe("");
});

test("historical success resolves only the existing task's original result identity", async () => {
    const serverAssetId = "7075c394-1184-44cc-9077-068d78e8b36d";
    const reads: string[] = [];
    const resolved = await hydrateVideoLogMedia({ ...log, task: { id: "paid-original" } }, {
        media: async () => "", image: async () => "",
        task: async id => { reads.push(id); return { status: "success", resultUrls: [`/api/assets/${serverAssetId}/content`] }; },
    }, false);
    expect(reads).toEqual(["paid-original"]);
    expect(resolved.video).toEqual({ ...log.video, serverAssetId });
    expect(log.video.url).toBe("");
});

test("a local-only log does not request a task or manufacture a server asset", async () => {
    const resolved = await hydrateVideoLogMedia(log, {
        media: async () => "blob:original", image: async () => "",
        task: async () => { throw new Error("must not look up an unrelated task"); },
    }, false);
    expect(resolved.video?.url).toBe("blob:original");
    expect(resolved.video).not.toHaveProperty("serverAssetId");
});

test("invalid or unrelated task results cannot become a server preview identity", async () => {
    for (const url of ["/api/assets/not-a-uuid/content", "https://untrusted.test/api/assets/7075c394-1184-44cc-9077-068d78e8b36d/content", "/api/assets/7075c394-1184-44cc-9077-068d78e8b36d/playback"]) {
        const resolved = await hydrateVideoLogMedia({ ...log, task: { id: "original" } }, { media: async () => "blob:original", image: async () => "", task: async () => ({ status: "success", resultUrls: [url] }) }, false);
        expect(resolved.video).not.toHaveProperty("serverAssetId");
    }
});

test("an invalid saved asset identity is not used as a playback source or written back", async () => {
    const source = { ...log, video: { ...log.video, serverAssetId: "../unrelated" } };
    const resolved = await hydrateVideoLogMedia(source, { media: async () => "blob:original", image: async () => "" }, false);
    expect(resolved.video).not.toHaveProperty("serverAssetId");
    expect(source.video.serverAssetId).toBe("../unrelated");
});

test("changing selected logs aborts the previous read", async () => {
    const loader = createLatestVideoPreview();
    let priorSignal: AbortSignal | undefined;
    const first = loader.load(async signal => { priorSignal = signal; await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); }, () => {}, () => {});
    await loader.load(async () => "newer", () => {}, () => {});
    await first;
    expect(priorSignal?.aborted).toBe(true);
});
