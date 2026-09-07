import { describe, expect, test } from "bun:test";
import { buildVideoProviderRequest, preflightVideoProviderRequest, type ProviderVideoSource, type SupportedVideoModelId } from "../src/video-models";
import { prepareVideoProviderSources, preflightVideoSources } from "../src/video-source-preparation";
import { runApiMartVideoTask } from "../src/media-runtime";

const image: ProviderVideoSource = { mimeType: "image/png", bytes: new Uint8Array([1]), publicUrl: "https://cdn.example/start.png", width: 1280, height: 720 };
const last: ProviderVideoSource = { ...image, publicUrl: "https://cdn.example/end.png" };
const video: ProviderVideoSource = { mimeType: "video/mp4", bytes: new Uint8Array([1]), publicUrl: "https://cdn.example/clip.mp4", durationMs: 5000, width: 1280, height: 720 };
const audio: ProviderVideoSource = { mimeType: "audio/mpeg", bytes: new Uint8Array([1]), publicUrl: "https://cdn.example/voice.mp3", durationMs: 3000 };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("advanced video provider contracts", () => {
  test("MiniMax maps explicit first, last and first-last frames without reference fields", () => {
    for (const [mode, sources, fields] of [
      ["first-frame", [image], { first_frame_image: image.publicUrl }],
      ["last-frame", [image], { last_frame_image: image.publicUrl }],
      ["first-last-frame", [image, last], { first_frame_image: image.publicUrl, last_frame_image: last.publicUrl }],
    ] as const) {
      const request = buildVideoProviderRequest("MiniMax-H3", "move", { videoMode: mode, size: "16:9" }, [...sources]);
      expect(request.body).toMatchObject(fields);
      expect(request.body).not.toHaveProperty("image_urls");
      expect(request.body).not.toHaveProperty("aspect_ratio");
      expect(request.size).toBe("adaptive");
    }
  });

  test("multimodal reference arrays preserve every source and each modality's order", () => {
    for (const model of ["MiniMax-H3", "doubao-seedance-2.5"] as const) {
      const request = buildVideoProviderRequest(model, "use all references", { videoMode: "reference" }, [image, video, audio, last, { ...video, publicUrl: "https://cdn.example/second.mp4" }]);
      expect(request.body).toMatchObject({ image_urls: ["https://cdn.example/start.png", "https://cdn.example/end.png"], video_urls: ["https://cdn.example/clip.mp4", "https://cdn.example/second.mp4"], audio_urls: ["https://cdn.example/voice.mp3"] });
      expect(request.body).not.toHaveProperty("first_frame_image");
      expect(request.body).not.toHaveProperty("image_with_roles");
      if (model === "doubao-seedance-2.5") expect(request.body.omni_reference_task_type).toBe("reference");
    }
  });

  test("Seedance frame, edit and extend payloads enforce adaptive while edit reserves the upstream 30s maximum", () => {
    const firstLast = buildVideoProviderRequest("doubao-seedance-2.5", "move", { videoMode: "first-last-frame", size: "16:9" }, [image, last]);
    expect(firstLast.body).toMatchObject({ image_with_roles: [{ url: image.publicUrl, role: "first_frame" }, { url: last.publicUrl, role: "last_frame" }], size: "adaptive" });
    expect(firstLast.body).not.toHaveProperty("image_urls");
    const first = buildVideoProviderRequest("doubao-seedance-2.5", "move", { videoMode: "first-frame" }, [image]);
    expect(first.body.image_with_roles).toEqual([{ url: image.publicUrl, role: "first_frame" }]);
    const edit = preflightVideoProviderRequest("doubao-seedance-2.5", "编辑视频，替换背景", { videoMode: "edit", seconds: 5, size: "16:9" }, [video]);
    expect(edit.request.body).toMatchObject({ omni_reference_task_type: "edit", duration: -1, size: "adaptive", video_urls: [video.publicUrl] });
    expect(edit.normalized).toMatchObject({ seconds: -1, upstreamBillingSeconds: 35, videoMode: "edit" });
    const extend = buildVideoProviderRequest("doubao-seedance-2.5", "续写视频", { videoMode: "extend", seconds: 9, size: "1:1" }, [video]);
    expect(extend.body).toMatchObject({ omni_reference_task_type: "extend", duration: 9, size: "adaptive" });
    expect(() => buildVideoProviderRequest("doubao-seedance-2.5", "编辑视频", { videoMode: "edit" }, [{ ...video, durationMs: 3999 }])).toThrow("4–30");
  });

  test("Seedance accepts the full 30/10/10 limit and audio-only references; MiniMax rejects audio-only", () => {
    const sources = [...Array(30).fill(image), ...Array(10).fill({ ...video, durationMs: 3000 }), ...Array(10).fill(audio)];
    const request = buildVideoProviderRequest("doubao-seedance-2.5", "references", { videoMode: "reference" }, sources);
    expect(request.body.image_urls).toHaveLength(30);
    expect(request.body.video_urls).toHaveLength(10);
    expect(request.body.audio_urls).toHaveLength(10);
    expect(buildVideoProviderRequest("doubao-seedance-2.5", "voice", { videoMode: "reference" }, [audio]).body.audio_urls).toEqual([audio.publicUrl]);
    expect(() => buildVideoProviderRequest("MiniMax-H3", "voice", { videoMode: "reference" }, [audio])).toThrow("不能单独");
  });

  test("Wan custom audio is retained and extend maps the optional image only to last_frame", () => {
    expect(buildVideoProviderRequest("wan2.7", "dance", { videoMode: "text" }, [audio]).body).toMatchObject({ audio_url: audio.publicUrl, size: "16:9" });
    expect(buildVideoProviderRequest("wan2.7", "dance", { videoMode: "first-frame" }, [image, audio]).body).toMatchObject({ audio_url: audio.publicUrl, image_urls: [image.publicUrl] });
    const extend = buildVideoProviderRequest("wan2.7", "continue", { videoMode: "extend", seconds: 6 }, [video, last]);
    expect(extend.body).toMatchObject({ video_urls: [video.publicUrl], image_with_roles: [{ url: last.publicUrl, role: "last_frame" }] });
    expect(extend.body).not.toHaveProperty("image_urls");
    expect(extend.body).not.toHaveProperty("size");
    for (const seconds of [2, 5]) expect(() => buildVideoProviderRequest("wan2.7", "continue", { videoMode: "extend", seconds }, [video])).toThrow("输出总时长必须大于源视频时长");
    expect(() => buildVideoProviderRequest("wan2.7", "continue", { videoMode: "extend" }, [video, audio])).toThrow("不可搭配");
    expect(() => buildVideoProviderRequest("wan2.7", "continue", { videoMode: "first-frame" }, [image, video])).toThrow("不可混合");
    expect(() => buildVideoProviderRequest("wan2.7", "continue", { videoMode: "extend" }, [video, video])).toThrow("最多支持");
  });

  test("mode precedence preserves the legacy fallback without letting it override a valid videoMode", () => {
    expect(buildVideoProviderRequest("happyhorse-1.1", "test", { happyHorseMode: "reference" }, [image]).body.image_urls).toEqual([image.publicUrl]);
    expect(buildVideoProviderRequest("happyhorse-1.1", "test", { videoMode: "first-frame", happyHorseMode: "reference" }, [image]).body.first_frame_image).toBe(image.publicUrl);
    expect(buildVideoProviderRequest("happyhorse-1.1", "test", { videoMode: "auto", happyHorseMode: "reference" }, [image]).body.first_frame_image).toBe(image.publicUrl);
    expect(() => buildVideoProviderRequest("happyhorse-1.1", "test", { videoMode: "edit" }, [video])).toThrow("mode only");
    expect(() => buildVideoProviderRequest("wan2.7", "test", { videoMode: "last-frame" }, [last])).toThrow("mode only");
  });

  test("HappyHorse validates the documented first-frame dimensions without turning reference recommendations into hard limits", () => {
    for (const dimensions of [{ width: 299, height: 720 }, { width: 1200, height: 300 }]) expect(() => buildVideoProviderRequest("happyhorse-1.1", "move", { videoMode: "first-frame" }, [{ ...image, ...dimensions }])).toThrow("首帧短边至少 300px");
    expect(buildVideoProviderRequest("happyhorse-1.1", "move", { videoMode: "first-frame" }, [{ ...image, width: 300, height: 750 }]).body.first_frame_image).toBe(image.publicUrl);
    expect(buildVideoProviderRequest("happyhorse-1.1", "move", { videoMode: "reference" }, [{ ...image, width: 500, height: 500 }]).body.image_urls).toEqual([image.publicUrl]);
  });
});

describe("advanced video preflight safety", () => {
  test("checks MIME, per-file bytes, duration totals, dimensions and conflicts before the first upstream upload", async () => {
    const cases: Array<{ model: SupportedVideoModelId; mode?: string; sources: ProviderVideoSource[] }> = [
      { model: "MiniMax-H3", sources: [image, { ...video, byteSize: 50 * 1024 * 1024 + 1 }] },
      { model: "doubao-seedance-2.5", sources: [image, { ...video, byteSize: 200 * 1024 * 1024 + 1 }] },
      { model: "wan2.7", mode: "extend", sources: [{ ...video, byteSize: 100 * 1024 * 1024 + 1 }] },
      { model: "MiniMax-H3", sources: [image, { ...audio, byteSize: 15 * 1024 * 1024 + 1 }] },
      { model: "MiniMax-H3", sources: [image, { ...video, durationMs: 8000 }, { ...video, durationMs: 8000 }] },
      { model: "doubao-seedance-2.5", sources: [image, { ...video, durationMs: 16000 }, { ...video, durationMs: 16000 }] },
      { model: "doubao-seedance-2.5", sources: [image, { ...audio, durationMs: 16000 }, { ...audio, durationMs: 16000 }] },
      { model: "doubao-seedance-2.5", sources: [image, { ...video, width: 300, height: 300 }] },
      { model: "doubao-seedance-2.5", sources: [image, { ...video, width: 6000, height: 6000 }] },
      { model: "MiniMax-H3", sources: [image, { ...video, durationMs: 1999 }] },
      { model: "wan2.7", mode: "extend", sources: [{ ...video, durationMs: 10001 }] },
      { model: "MiniMax-H3", sources: [image, { ...video, mimeType: "video/webm" }] },
      { model: "MiniMax-H3", sources: [image, { ...audio, mimeType: "audio/aac" }] },
      { model: "MiniMax-H3", mode: "first-frame", sources: [image, video] },
      { model: "doubao-seedance-2.5", mode: "first-last-frame", sources: [image, last, audio] },
      { model: "doubao-seedance-2.5", mode: "edit", sources: [image] },
      { model: "happyhorse-1.1", sources: [image, video] },
    ];
    for (const scenario of cases) {
      let calls = 0;
      await expect(prepareVideoProviderSources({ ...scenario, prompt: "test", parameters: { videoMode: scenario.mode || "reference" }, baseUrl: "https://provider.example/v1", apiKey: "test-key" }, { fetch: async () => { calls++; return json({}); } })).rejects.toThrow();
      expect(calls).toBe(0);
    }
  });

  test("rejects missing/private audio-video URLs without exposing image bytes or provider credentials", async () => {
    for (const publicUrl of [undefined, "asset://untrusted", "https://localhost/video.mp4", "http://minio:9000/video.mp4", "https://10.0.0.1/video.mp4"]) {
      let calls = 0;
      await expect(prepareVideoProviderSources({ model: "MiniMax-H3", prompt: "test", parameters: { videoMode: "reference" }, sources: [image, { ...video, publicUrl }], baseUrl: "https://provider.example/v1", apiKey: "test-key" }, { fetch: async () => { calls++; return json({}); } })).rejects.toThrow("公开 HTTPS");
      expect(calls).toBe(0);
    }
  });

  test("formal runtime and demo source preparation use the same mapping, only upload images and preserve public audio/video", async () => {
    const sources = [image, video, audio, last];
    const events: string[] = [];
    const expected = { image_urls: ["https://cdn.example/upload-1.png", "https://cdn.example/upload-2.png"], video_urls: [video.publicUrl], audio_urls: [audio.publicUrl], omni_reference_task_type: "reference" };
    let uploads = 0;
    const result = await runApiMartVideoTask({ modelId: "doubao-seedance-2.5", prompt: "参考素材", parameters: { videoMode: "reference" }, sources, baseUrl: "https://provider.example/v1", apiKey: "test-key", beforeSubmit: async () => { events.push("claim"); return true; }, onSubmitted: async () => { events.push("persist"); } }, { sleep: async () => undefined, fetch: async (url, init) => {
      if (url.endsWith("/uploads/images")) { uploads++; events.push("upload-image"); return json({ url: `https://cdn.example/upload-${uploads}.png` }); }
      if (url.endsWith("/videos/generations")) { events.push("generate"); expect(JSON.parse(String(init?.body))).toMatchObject(expected); return json({ data: [{ task_id: "original" }] }); }
      events.push("poll"); return json({ data: { status: "completed", result: { videos: ["https://cdn.example/result.mp4"] } } });
    } });
    expect(result).toBe("https://cdn.example/result.mp4");
    expect(events).toEqual(["upload-image", "upload-image", "claim", "generate", "persist", "poll"]);
    expect(preflightVideoSources("doubao-seedance-2.5", "参考素材", { videoMode: "reference" }, sources).normalized.referenceCount).toBe(4);
  });
});
