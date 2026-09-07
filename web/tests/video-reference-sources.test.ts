import { afterEach, expect, test } from "bun:test";
import { resolveVideoReferenceSource } from "@/services/api/video";
import { submitQueuedMediaTask } from "@/services/api/generation-tasks";
import { videoReferenceError } from "@/lib/video-model-parameters";
import { defaultConfig } from "@/stores/use-config-store";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });

test("persisted media bytes take precedence over expired blob URLs", async () => {
    globalThis.fetch = (async () => { throw new Error("Expired URL must not be fetched"); }) as typeof fetch;
    const source = await resolveVideoReferenceSource({ id: "clip", name: "clip.mp4", storageKey: "saved", url: "blob:expired", type: "video/mp4" }, "video", undefined, async () => new Blob(["local bytes"], { type: "video/mp4" }));
    expect(source).toBeInstanceOf(File);
    expect(await (source as File).text()).toBe("local bytes");
    expect((source as File).name).toBe("clip.mp4");
});

test("missing bytes fall back to owned URLs while empty, wrong-kind and credential URLs fail", async () => {
    const reference = { id: "clip", name: "clip.mp4", type: "video/mp4", storageKey: "saved", url: "/api/assets/owned/content" };
    expect(await resolveVideoReferenceSource(reference, "video", undefined, async () => null)).toBe(reference.url);
    await expect(resolveVideoReferenceSource(reference, "video", undefined, async () => new Blob([]))).rejects.toThrow("文件为空");
    await expect(resolveVideoReferenceSource(reference, "video", undefined, async () => new Blob(["x"], { type: "audio/wav" }))).rejects.toThrow("格式与视频/音频类型不一致");
    await expect(resolveVideoReferenceSource({ ...reference, url: "https://user:pass@example.com/clip.mp4" }, "video", undefined, async () => null)).rejects.toThrow("不能包含账号凭据");
    await expect(resolveVideoReferenceSource({ ...reference, url: "" }, "video", undefined, async () => null)).rejects.toThrow("已丢失");
});

test("uploads and existing asset URLs retain source order through preflight and submission", async () => {
    globalThis.window = { location: { pathname: "/video" } } as Window & typeof globalThis;
    const payloads: any[] = [];
    const uploads: any[] = [];
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path === "/api/models") return Response.json({ models: [{ id: "seedance", modelId: "doubao-seedance-2.5" }] });
        if (path === "/api/auth/session") return Response.json({ user: null });
        if (path === "/api/assets/upload-request") {
            uploads.push(JSON.parse(String(init?.body)));
            return Response.json({ assetId: `upload-${uploads.length}`, uploadUrl: null });
        }
        if (path === "/api/tasks/preflight" || path === "/api/tasks") {
            payloads.push(JSON.parse(String(init?.body)));
            return Response.json(path.endsWith("preflight") ? { ok: true, normalized: { seconds: -1, size: "adaptive" } } : { task: { id: "task" } });
        }
        throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    await submitQueuedMediaTask({ modelId: "doubao-seedance-2.5", operationType: "video_generation", prompt: "edit background", parameters: { videoMode: "edit", seconds: -1 }, sourceFiles: [new File(["first"], "a.mp4", { type: "video/mp4" }), new File(["third"], "c.wav", { type: "audio/wav" })], sourceUrls: ["/api/assets/second/content"], sourceMetadata: [{ durationMs: 4000, fps: 24 }, { durationMs: 2000 }], sourceOrder: [{ kind: "file", index: 0 }, { kind: "url", index: 0 }, { kind: "file", index: 1 }] });
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) expect(payload.sourceUrls).toEqual(["/api/assets/upload-1/content", "/api/assets/second/content", "/api/assets/upload-2/content"]);
    expect(payloads[1].parameters).toEqual({ videoMode: "edit", seconds: -1, size: "adaptive" });
    expect(uploads[0].metadata).toMatchObject({ durationMs: 4000, fps: 24 });
});

test("Wan continuation rejects output durations that do not extend the source", () => {
    const config = { ...defaultConfig, model: "wan2.7", videoModel: "wan2.7", videoMode: "extend", videoSeconds: "4" };
    const video = { id: "clip", url: "/api/assets/owned/content", type: "video/mp4", durationMs: 4458, width: 768, height: 768, bytes: 100 };
    expect(videoReferenceError(config, [], [video])).toContain("输出总时长必须大于源视频时长");
    expect(videoReferenceError({ ...config, videoSeconds: "5" }, [], [video])).toBe("");
});

test("HappyHorse rejects undersized first frames but keeps valid reference images", () => {
    const config = { ...defaultConfig, model: "happyhorse-1.1", videoMode: "first-frame" };
    const image = { id: "frame", name: "frame.png", type: "image/png", dataUrl: "data:image/png;base64,AQ==", width: 299, height: 500 };
    expect(videoReferenceError(config, [image])).toContain("首帧短边至少 300px");
    expect(videoReferenceError({ ...config, videoMode: "reference" }, [{ ...image, width: 500 }])).toBe("");
});
