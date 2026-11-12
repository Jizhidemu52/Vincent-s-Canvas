import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoSettingsPanel, videoDurationOptions, videoSecondsLabel } from "@/components/video-settings-panel";
import { CanvasVideoSettingsPopover } from "@/components/canvas/canvas-video-settings-popover";
import { canvasThemes } from "@/lib/canvas-theme";
import { getVideoModelParameterSpec, normalizeVideoModelConfig, resolveVideoMode, videoModelRequestParameters, videoReferenceError, withVideoDurationDefault } from "@/lib/video-model-parameters";
import { createVideoMotionInput, motionVideoConfig } from "@/pages/video/video-motion";
import { VideoMotionPanel } from "@/pages/video/video-motion-panel";
import { createVideoGenerationTask } from "@/services/api/video";
import { defaultConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceVideo } from "@/types/media";
import { defaultVideoMotionSettings } from "../../shared/video-motion-options";

const model = "gemini-omni-1.2-flash";
const config = { ...defaultConfig, model, videoModel: model, videoSeconds: "", size: "16:9", vquality: "720p" };
const image = (index = 0): ReferenceImage => ({ id: String(index), name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,AQ==" });
const video: ReferenceVideo = { id: "video", name: "source.mp4", type: "video/mp4", url: "/api/assets/source-video/content", durationMs: 15000, bytes: 1 };
const spec = getVideoModelParameterSpec(model)!;
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });

describe("Gemini Omni frontend model contract", () => {
    test("uses its exact defaults without replacing saved valid seconds or Seedance defaults", () => {
        expect(normalizeVideoModelConfig(config)).toMatchObject({ videoSeconds: "10", vquality: "720p", size: "16:9", videoGenerateAudio: "true", videoWatermark: "false", videoSeed: "", videoOutputFormat: "mp4" });
        expect(normalizeVideoModelConfig({ ...config, videoSeconds: "5", vquality: "2160p", size: "9:16" })).toMatchObject({ videoSeconds: "5", vquality: "4k", size: "9:16" });
        expect(normalizeVideoModelConfig({ ...config, model: "doubao-seedance-2.5", videoModel: "doubao-seedance-2.5" })).toMatchObject({ videoSeconds: "5", vquality: "720p" });
        expect(spec).toMatchObject({ seconds: [3, 15], maxImages: 10, maxVideos: 1, maxAudios: 0, supportsAudio: false, supportsWatermark: false, supportsAutoDuration: false });
        expect(withVideoDurationDefault({ ...config, videoSeconds: "5" }).videoSeconds).toBe("10");
        expect(withVideoDurationDefault({ ...config, videoSeconds: "8" }, "8").videoSeconds).toBe("8");
        expect(withVideoDurationDefault({ ...defaultConfig, model: "doubao-seedance-2.5" }).videoSeconds).toBe("5");
    });

    test("only documented model parameters reach a text request", () => {
        expect(videoModelRequestParameters({ ...config, videoGenerateAudio: "false", videoWatermark: "true", videoSeed: "42", videoOutputFormat: "mov" })).toEqual({ videoMode: "auto", seconds: 10, resolution: "720p", size: "16:9" });
    });

    test("auto distinguishes text, one-image first frame, multi-image reference and source-video edit", () => {
        expect(resolveVideoMode(config, 0, 0, 0)).toBe("text");
        expect(resolveVideoMode(config, 1, 0, 0)).toBe("first-frame");
        expect(resolveVideoMode(config, 2, 0, 0)).toBe("reference");
        expect(resolveVideoMode(config, 2, 1, 0)).toBe("edit");
        expect(resolveVideoMode({ ...config, videoMode: "extend" }, 0, 1, 0)).toBe("extend");
    });

    test.each(["3.5", "2", "16", "-1", "Infinity", "bad"])("rejects invalid explicit duration %s before a request", seconds => {
        const invalid = { ...config, videoSeconds: seconds };
        expect(videoReferenceError(invalid)).toContain("3–15 秒的整数");
        expect(() => videoModelRequestParameters(invalid)).toThrow("3–15 秒的整数");
    });

    test.each(["first-last-frame", "extend"])("limits %s to 3–10 integer seconds", videoMode => {
        const value = { ...config, videoMode, videoSeconds: "11" };
        expect(videoReferenceError(value, [image(), image(1)], videoMode === "extend" ? [video] : [])).toContain("3–10 秒的整数");
        expect(() => videoModelRequestParameters(value)).toThrow("3–10 秒的整数");
        expect(videoDurationOptions(spec, videoMode).map(item => item.value)).toEqual(["3", "4", "5", "6", "7", "8", "9", "10"]);
        expect(normalizeVideoModelConfig(value).videoSeconds).toBe("10");
    });

    test("explicit and automatic editing omit duration even with stale duration input", () => {
        for (const videoMode of ["edit", "auto"]) {
            const value = { ...config, videoMode, videoSeconds: "999" };
            expect(videoReferenceError(value, [], [video])).toBe("");
            expect(videoModelRequestParameters(value, undefined, "edit")).not.toHaveProperty("seconds");
            expect(normalizeVideoModelConfig(value, undefined, "edit").videoSeconds).toBe("-1");
        }
    });

    test("frame slots and remaining subject references share the ten-image total", () => {
        const frames = { ...config, videoMode: "first-last-frame" };
        expect(videoReferenceError(frames, [image()])).toContain("至少 2 张");
        expect(videoReferenceError(frames, Array.from({ length: 10 }, (_, index) => image(index)))).toBe("");
        expect(videoReferenceError(frames, Array.from({ length: 11 }, (_, index) => image(index)))).toContain("最多支持 10 张");
        expect(videoReferenceError({ ...config, videoMode: "first-frame" }, [image(), image(1)])).toBe("");
        expect(videoReferenceError({ ...config, videoMode: "last-frame" }, [image()])).toContain("不支持尾帧");
    });

    test("one positive video at most fifteen seconds is allowed, without invented fps or dimension limits", () => {
        expect(videoReferenceError(config, [], [{ ...video, durationMs: 500, width: 100, height: 100, fps: 12 }])).toBe("");
        expect(videoReferenceError(config, [], [video])).toBe("");
        for (const durationMs of [0, NaN, 15001]) expect(videoReferenceError(config, [], [{ ...video, durationMs }])).toContain("不超过 15 秒");
        expect(videoReferenceError(config, [], [video, { ...video, id: "second" }])).toContain("最多支持 1 段视频");
        expect(videoReferenceError(config, [], [], [{ ...video, type: "audio/mpeg" }])).toContain("不支持音频参考");
        expect(videoReferenceError({ ...config, videoMode: "extend" })).toContain("至少需要 1 段源视频");
    });
});

describe("Gemini Omni shared settings and motion UI", () => {
    const render = (videoMode = "auto", imageMode?: string) => renderToStaticMarkup(<VideoSettingsPanel config={{ ...config, videoMode }} onConfigChange={() => undefined} theme={canvasThemes.light} imageMode={imageMode} />);

    test("has supported ratio/resolution choices, native-audio disclosure and no invented switches", () => {
        const html = render();
        for (const text of ["360p", "720p", "1080p", "4k", "原生输出 24fps", "上采样输出", "SynthID", "不保证无声"]) expect(html).toContain(text);
        for (const text of ["生成声音", "添加水印", "随机种子", "视频输出格式", "智能时长", "4–30 秒源视频"]) expect(html).not.toContain(text);
        expect(videoDurationOptions(spec).map(item => item.value)).toEqual(Array.from({ length: 13 }, (_, index) => String(index + 3)));
        expect(videoDurationOptions(spec, "edit")).toEqual([{ value: "-1", label: "跟随源视频" }]);
    });

    test("both explicit and auto editing follow source duration without financial estimates or invented output duration", () => {
        for (const html of [render("edit"), render("auto", "edit")]) {
            expect(html).toContain("编辑结果时长跟随源视频。");
            expect(html).toContain("跟随源视频");
            for (const text of ["15 秒估算", "最多 30 秒输出预扣", "积分", "费用", "预扣", "计费"]) expect(html).not.toContain(text);
            expect(html).not.toContain("支持3–15");
        }
        const compact = renderToStaticMarkup(<CanvasVideoSettingsPopover config={config} imageMode="edit" onConfigChange={() => undefined} />);
        expect(compact).toContain("跟随源片");
    });

    test("extension explains added duration and compact settings label it with a plus", () => {
        const html = render("extend");
        expect(html).toContain("新增时长");
        expect(html).toContain("结果包含原片和新增片段");
        expect(videoSecondsLabel("8", "extend", true)).toBe("+8s");
        expect(videoSecondsLabel("8", "extend", false)).toBe("8s");
    });

    test("motion options remove mute only for Omni and retain saved Seedance behavior", () => {
        const native = renderToStaticMarkup(<VideoMotionPanel value={defaultVideoMotionSettings} onChange={() => undefined} nativeAudio />);
        expect(native).not.toContain("关闭声音输出");
        expect(native).not.toMatch(/>无\s*声</);
        expect(native).toContain("仅环境音");
        expect(native).toContain("声音偏好，不是静音开关");
        const seedance = renderToStaticMarkup(<VideoMotionPanel value={defaultVideoMotionSettings} onChange={() => undefined} />);
        // Tooltip descriptions are not emitted by SSR; assert the actual selectable mute option.
        expect(seedance).toMatch(/>无\s*声</);
        expect(seedance).not.toContain("声音偏好，不是静音开关");
    });

    test("motion keeps auto multi-images as references and communicates native audio rather than a mute flag", () => {
        const counts = { images: 3, videos: 0, audios: 0 };
        const normalized = motionVideoConfig(config, defaultVideoMotionSettings, counts, true);
        expect(normalized).toMatchObject({ videoMode: "auto", videoSeconds: "10", videoGenerateAudio: "true" });
        const input = createVideoMotionInput("动作", defaultVideoMotionSettings, normalized, counts);
        expect(input.fields).toMatchObject({ video_mode: "reference", duration: 10, audio: "ambient", generate_audio: true });
        expect(input.referenceRoles).toEqual(["参考图片1", "参考图片2", "参考图片3"]);
        expect(createVideoMotionInput("动作", defaultVideoMotionSettings, { ...normalized, videoMode: "first-last-frame" }, counts).referenceRoles).toEqual(["首帧", "尾帧", "参考图片3"]);
        const editCounts = { images: 0, videos: 1, audios: 0 };
        const edit = motionVideoConfig(config, defaultVideoMotionSettings, editCounts, true);
        expect(edit.videoSeconds).toBe("-1");
        expect(createVideoMotionInput("编辑", defaultVideoMotionSettings, edit, editCounts).fields).not.toHaveProperty("duration");
        expect(defaultVideoMotionSettings.audio).toBe("none");
    });
});

describe("Gemini Omni fresh API submission", () => {
    test("auto-video edit omits seconds identically from preflight and submission", async () => {
        globalThis.window = { location: { pathname: "/video" } } as Window & typeof globalThis;
        const payloads: Array<Record<string, any>> = [];
        globalThis.fetch = (async (input, init) => {
            const url = String(input);
            if (url === "/api/models") return Response.json({ models: [{ id: "omni", modelId: model, name: model, capabilities: ["video"], creditCost: 0, rmbCost: 0 }], tools: [], prices: [] });
            if (url === "/api/auth/session") return Response.json({ user: null });
            if (url === video.url && init?.method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "video/mp4" } });
            if (url === "/api/tasks/preflight" || url === "/api/tasks") {
                payloads.push(JSON.parse(String(init?.body)));
                return Response.json(url === "/api/tasks/preflight" ? { ok: true, normalized: {} } : { task: { id: "omni-task" } });
            }
            throw new Error(`Unexpected request: ${url}`);
        }) as typeof fetch;
        await expect(createVideoGenerationTask({ ...config, videoSeconds: "999" }, "只修改背景", [], [video])).resolves.toMatchObject({ id: "omni-task" });
        expect(payloads).toHaveLength(2);
        for (const payload of payloads) {
            expect(payload.parameters).toEqual({ tool: "video", videoMode: "auto", size: "16:9", resolution: "720p" });
            expect(payload.sourceUrls).toEqual([video.url]);
        }
    });

    test("invalid duration or media is rejected before upload/preflight/task POST", async () => {
        let mutations = 0;
        globalThis.fetch = (async input => {
            if (String(input) === "/api/models") return Response.json({ models: [{ id: "omni", modelId: model, name: model, capabilities: ["video"], creditCost: 0, rmbCost: 0 }], tools: [], prices: [] });
            mutations++;
            throw new Error("No network writes permitted");
        }) as typeof fetch;
        await expect(createVideoGenerationTask({ ...config, videoSeconds: "15.5" }, "invalid")).rejects.toThrow("整数");
        await expect(createVideoGenerationTask(config, "invalid", [], [{ ...video, durationMs: 15001 }])).rejects.toThrow("15 秒");
        await expect(createVideoGenerationTask(config, "invalid", [], [], [{ ...video, type: "audio/mpeg" }])).rejects.toThrow("不支持音频参考");
        expect(mutations).toBe(0);
    });
});
