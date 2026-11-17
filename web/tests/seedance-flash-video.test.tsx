import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoSettingsPanel, videoDurationOptions } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { getVideoModelParameterSpec, normalizeVideoModelConfig, resolveVideoMode, videoModelRequestParameters, videoReferenceError } from "@/lib/video-model-parameters";
import { motionVideoConfig, createVideoMotionInput } from "@/pages/video/video-motion";
import { defaultConfig, modelMatchesCapability } from "@/stores/use-config-store";
import { defaultVideoMotionSettings } from "../../shared/video-motion-options";
import { buildVideoProviderRequest } from "../../server/src/video-models";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceVideo, ReferenceAudio } from "@/types/media";

const model = "seedance-2-5-flash";
const config = { ...defaultConfig, model, videoModel: model };
const spec = getVideoModelParameterSpec(model)!;
const image: ReferenceImage = { id: "image", name: "hat.png", type: "image/png", dataUrl: "data:image/png;base64,AQ==", width: 640, height: 640 };
const video: ReferenceVideo = { id: "video", name: "source.mp4", type: "video/mp4", url: "/api/assets/video/content", durationMs: 5000, width: 640, height: 640, fps: 24 };
const audio: ReferenceAudio = { id: "audio", name: "source.mp3", type: "audio/mpeg", url: "/api/assets/audio/content", durationMs: 5000 };

describe("Seedance 2.5 Flash frontend contract", () => {
    test("is selectable independently without replacing the existing default", () => {
        expect(defaultConfig.videoModels).toContain(`default::${model}`);
        expect(defaultConfig.channels[0]!.models).toContain(model);
        expect(defaultConfig.videoModel).toBe("default::doubao-seedance-2.5");
        expect(modelMatchesCapability(model, "video")).toBe(true);
        expect(spec).toMatchObject({ maxImages: 10, maxVideos: 5, maxAudios: 5, resolutions: ["480p", "720p"], supportsAutoDuration: true });
        expect(videoDurationOptions(spec).map(item => item.value)).toEqual(["-1", ...Array.from({ length: 27 }, (_, index) => String(index + 4))]);
    });

    test("switches stale 1080p to Flash 720p and preserves explicit supported output choices", () => {
        expect(normalizeVideoModelConfig({ ...config, vquality: "1080p" }).vquality).toBe("720p");
        const selected = { ...config, videoMode: "text", videoSeconds: "30", vquality: "480P", size: "9:16", videoGenerateAudio: "false", videoSeed: "0", videoOutputFormat: "mov" };
        const parameters = videoModelRequestParameters(selected);
        expect(parameters).toEqual({ videoMode: "text", seconds: 30, resolution: "480p", size: "9:16", generateAudio: false, watermark: false, seed: 0, outputFormat: "mov" });
        expect(buildVideoProviderRequest(model, "无付费契约回归", parameters).body).toMatchObject({ model, duration: 30, resolution: "480p", size: "9:16", generate_audio: false, seed: 0, output_format: "mov" });
    });

    test("frame and edit modes lock ratio and preserve motion planning roles", () => {
        const counts = { images: 2, videos: 0, audios: 0 };
        const next = motionVideoConfig(config, defaultVideoMotionSettings, counts, true);
        expect(next).toMatchObject({ videoMode: "first-last-frame", size: "adaptive", videoGenerateAudio: "false" });
        expect(createVideoMotionInput("转身", defaultVideoMotionSettings, next, counts)).toMatchObject({ referenceRoles: ["首帧", "尾帧"], fields: { video_mode: "first-last-frame", ratio: "adaptive" } });
        expect(normalizeVideoModelConfig({ ...config, videoMode: "edit", size: "16:9", videoSeconds: "8" })).toMatchObject({ videoSeconds: "-1", size: "adaptive" });
        expect(resolveVideoMode(config, 1)).toBe("reference");
    });

    test("enforces Flash-specific media limits and physical validation", () => {
        expect(videoReferenceError(config, Array(10).fill(image), Array(5).fill(video), Array(5).fill(audio))).toBe("");
        expect(videoReferenceError(config, Array(11).fill(image))).toContain("10 张");
        expect(videoReferenceError(config, [], Array(6).fill(video))).toContain("5 段视频");
        expect(videoReferenceError(config, [], [], Array(6).fill(audio))).toContain("5 段音频");
        expect(videoReferenceError(config, [{ ...image, width: 299 }])).toContain("300–6000");
        expect(videoReferenceError(config, [], [{ ...video, width: 300, height: 300 }])).toContain("409600");
        expect(videoReferenceError({ ...config, videoMode: "first-frame" }, [image], [], [audio])).toContain("不可混用");
        expect(videoReferenceError({ ...config, videoMode: "edit" }, [], [{ ...video, durationMs: 3999 }])).toContain("4–30");
    });

    test("renders only supported resolution choices and actual audio/output controls", () => {
        const html = renderToStaticMarkup(<VideoSettingsPanel config={config} onConfigChange={() => {}} theme={canvasThemes.light} />);
        for (const name of ["480p", "720p", "生成声音", "视频输出格式", "视频随机种子"]) expect(html).toContain(name);
        expect(html).not.toContain(">1080p</button>");
        expect(html).toContain("不支持 1080p 或样片模式");
    });
});
