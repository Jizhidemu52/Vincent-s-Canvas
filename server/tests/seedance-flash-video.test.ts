import { describe, expect, test } from "bun:test";
import { isSeedanceVideoModel } from "../../shared/video-model-identity";
import { defaultVideoMotionSettings } from "../../shared/video-motion-options";
import { promptInputSchema } from "../../shared/prompt-contracts";
import { buildVideoProviderRequest, getVideoModelCapability, isSupportedVideoModelId, preflightVideoProviderRequest, validateVideoSources, type ProviderVideoSource } from "../src/video-models";
import { runApiMartVideoTask } from "../src/media-runtime";
import { videoMotionParameters } from "../src/video-motion-input";

const model = "seedance-2-5-flash";
const image: ProviderVideoSource = { mimeType: "image/png", bytes: new Uint8Array([1]), publicUrl: "https://fixture.invalid/image.png", width: 640, height: 640 };
const video: ProviderVideoSource = { ...image, mimeType: "video/mp4", publicUrl: "https://fixture.invalid/video.mp4", durationMs: 5000, fps: 24 };
const audio: ProviderVideoSource = { mimeType: "audio/mpeg", bytes: new Uint8Array([1]), publicUrl: "https://fixture.invalid/audio.mp3", durationMs: 5000 };

describe("Seedance 2.5 Flash APIMart contract", () => {
  test("uses the exact distinct model ID and retains standard Seedance", () => {
    expect(isSupportedVideoModelId(model)).toBe(true);
    for (const alias of ["seedance-2.5-flash", "doubao-seedance-2.5-flash", "seedance-2.0-fast"]) {
      expect(isSupportedVideoModelId(alias)).toBe(false);
      expect(isSeedanceVideoModel(alias)).toBe(false);
    }
    expect(getVideoModelCapability(model)).toMatchObject({ seconds: [4, 30], resolutions: ["480p", "720p"], maxImages: 10, supportsAudio: true });
    expect(buildVideoProviderRequest(model, "旋转展示帽子").body).toEqual({ model, prompt: "旋转展示帽子", duration: 5, resolution: "720p", size: "adaptive", watermark: false, generate_audio: true });
    expect(buildVideoProviderRequest("doubao-seedance-2.5", "原型号", { resolution: "1080p" }).body).toMatchObject({ model: "seedance-2.5", resolution: "1080p" });
    expect(getVideoModelCapability("doubao-seedance-2.5").maxImages).toBe(30);
  });

  test("maps first/last frames, audio, seed and MOV without reference-field mixing", () => {
    const last = { ...image, publicUrl: "https://fixture.invalid/last.png" };
    const request = buildVideoProviderRequest(model, "首尾衔接", { videoMode: "first-last-frame", seconds: 30, size: "16:9", resolution: "480P", generateAudio: false, watermark: true, seed: 0, outputFormat: "mov" }, [image, last]);
    expect(request.body).toEqual({ model, prompt: "首尾衔接", duration: 30, resolution: "480p", size: "adaptive", generate_audio: false, watermark: true, seed: 0, output_format: "mov", image_with_roles: [{ url: image.publicUrl, role: "first_frame" }, { url: last.publicUrl, role: "last_frame" }] });
    expect(() => buildVideoProviderRequest(model, "错误格式", { outputFormat: "webm" })).toThrow("输出格式");
  });

  test("keeps editing and extension adaptive with correct input-plus-output estimate", () => {
    const edit = preflightVideoProviderRequest(model, "只换背景", { videoMode: "edit", seconds: 8, size: "16:9" }, [video]);
    expect(edit.request.body).toMatchObject({ model, duration: -1, size: "adaptive", omni_reference_task_type: "edit", video_urls: [video.publicUrl] });
    expect(edit.normalized.upstreamBillingSeconds).toBe(35);
    const extend = preflightVideoProviderRequest(model, "延长动作", { videoMode: "extend", seconds: 8, size: "16:9" }, [video]);
    expect(extend.request.body).toMatchObject({ duration: 8, size: "adaptive", omni_reference_task_type: "extend" });
    expect(extend.normalized.upstreamBillingSeconds).toBe(13);
  });

  test("accepts exactly ten images, five videos and five audio references", () => {
    const sources = [...Array(10).fill(image), ...Array(5).fill(video), ...Array(5).fill(audio)];
    const request = buildVideoProviderRequest(model, "综合参考", { videoMode: "reference", seconds: -1 }, sources);
    expect(request.body.image_urls).toHaveLength(10);
    expect(request.body.video_urls).toHaveLength(5);
    expect(request.body.audio_urls).toHaveLength(5);
    expect(request.duration).toBe(-1);
    for (const [source, count] of [[image, 11], [video, 6], [audio, 6]] as const) expect(() => validateVideoSources(model, { videoMode: "reference" }, Array(count).fill(source))).toThrow();
    expect(buildVideoProviderRequest(model, "纯音频参考", {}, [audio]).body).toMatchObject({ audio_urls: [audio.publicUrl], omni_reference_task_type: "reference" });
  });

  test("rejects dimension, pixel, duration, framerate and frame-mode conflicts", () => {
    for (const source of [{ ...image, width: 299 }, { ...video, width: 300, height: 300 }, { ...video, fps: 23 }, { ...video, durationMs: 30001 }, { ...audio, durationMs: 1999 }]) {
      expect(() => validateVideoSources(model, { videoMode: "reference" }, [source])).toThrow();
    }
    expect(() => validateVideoSources(model, { videoMode: "reference" }, [{ ...video, durationMs: 16000 }, { ...video, durationMs: 16000 }])).toThrow("总时长");
    expect(() => validateVideoSources(model, { videoMode: "edit" }, [{ ...video, durationMs: 3999 }])).toThrow("4–30");
    expect(() => validateVideoSources(model, { videoMode: "first-frame" }, [image, audio])).toThrow("不可混合");
  });

  test("motion planning uses one-image first frame and two-image frame pair", () => {
    const input = promptInputSchema.parse({ scene: "video-motion", mode: "video", outputLanguage: "zh", userText: "", fields: defaultVideoMotionSettings });
    expect(videoMotionParameters({}, input, ["image/png"], model)).toEqual({ generateAudio: false, videoMode: "first-frame" });
    expect(videoMotionParameters({}, input, ["image/png", "image/jpeg"], model)).toEqual({ generateAudio: false, videoMode: "first-last-frame" });
    expect(videoMotionParameters({ videoMode: "reference" }, input, ["image/png"], model)).toEqual({ generateAudio: false, videoMode: "reference" });
  });

  test("unsupported resolutions and excess media stop before claiming or provider requests", async () => {
    let requests = 0;
    let claims = 0;
    for (const [parameters, sources] of [[{ resolution: "1080p" }, []], [{ resolution: "4k" }, []], [{}, Array(11).fill(image)], [{}, Array(6).fill(audio)]] as const) {
      await expect(runApiMartVideoTask({ modelId: model, prompt: "无付费回归", parameters, sources: [...sources], baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only", beforeSubmit: async () => { claims++; return true; }, onSubmitted: async () => {} }, { fetch: async () => { requests++; throw new Error("No network allowed"); } })).rejects.toThrow();
    }
    expect(claims).toBe(0);
    expect(requests).toBe(0);
  });
});
