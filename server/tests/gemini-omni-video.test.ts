import { describe, expect, test } from "bun:test";
import { buildVideoProviderRequest, getVideoModelCapability, isSupportedVideoModelId, preflightVideoProviderRequest, type ProviderVideoSource } from "../src/video-models";
import { stepApiMartVideoTask, runApiMartVideoTask, VideoProviderFailure, type ApiMartVideoInput } from "../src/media-runtime";
import { preflightStoredVideoTask, validateStoredVideoPreflightSnapshot } from "../src/stored-video-preflight";
import { videoMotionParameters } from "../src/video-motion-input";
import { promptInputSchema } from "../../shared/prompt-contracts";

const model = "gemini-omni-1.2-flash";
const image = (id = 1): ProviderVideoSource => ({ mimeType: "image/png", bytes: new Uint8Array([id]), byteSize: 1, width: 1600, height: 900, publicUrl: `http://owned.example/api/provider-images/image-${id}` });
const video: ProviderVideoSource = { mimeType: "video/mp4", bytes: new Uint8Array([1]), byteSize: 1, durationMs: 5000, width: 1600, height: 900, fps: 24, publicUrl: "http://owned.example/api/provider-images/video" };
const json = (body: unknown, status = 200) => Response.json(body, { status });
const input: ApiMartVideoInput = { modelId: model, baseUrl: "https://provider.example/v1", apiKey: "fixture", prompt: "自然移动", parameters: {}, beforeSubmit: async () => true, onSubmitted: async () => undefined };

describe("Gemini Omni 1.2 Flash request contract", () => {
  test("uses the exact distinct model, documented defaults and no inherited unsupported controls", () => {
    expect(isSupportedVideoModelId(model)).toBe(true);
    expect(isSupportedVideoModelId("gemini-omni-1.2-flash-ext")).toBe(false);
    expect(getVideoModelCapability(model)).toMatchObject({ seconds: [3, 15], maxImages: 10, supportsAudio: false, supportsWatermark: false, sizes: ["16:9", "9:16"] });
    expect(buildVideoProviderRequest(model, " 自然移动 ", { generateAudio: false, watermark: true, seed: 42, outputFormat: "mov" })).toEqual({
      mode: "text", duration: 10, resolution: "720p", size: "16:9",
      body: { model, prompt: "自然移动", duration: 10, resolution: "720p", aspect_ratio: "16:9" },
    });
    for (const resolution of ["4K", "2160p", "2160P"]) expect(buildVideoProviderRequest(model, "move", { resolution }).body.resolution).toBe("4k");
    for (const resolution of ["360P", "720P", "1080P"]) expect(buildVideoProviderRequest(model, "move", { resolution }).body.resolution).toBe(resolution.toLowerCase());
    expect(buildVideoProviderRequest(model, "move", { size: "1:1" }).body.aspect_ratio).toBe("16:9");
    expect(buildVideoProviderRequest("doubao-seedance-2.5", "move", { seconds: -1, generateAudio: false, watermark: true, outputFormat: "mov" }).body).toMatchObject({ model: "seedance-2.5", duration: -1, generate_audio: false, watermark: true, output_format: "mov" });
  });

  test("maps text, one image, multiple references and ordered first/last images without losing extras", () => {
    const images = Array.from({ length: 10 }, (_, index) => image(index + 1));
    expect(buildVideoProviderRequest(model, "move", {}, [images[0]!]).body).toMatchObject({ first_frame_image: images[0]!.publicUrl });
    expect(buildVideoProviderRequest(model, "move", {}, images).body).toMatchObject({ image_urls: images.map(item => item.publicUrl), omni_reference_task_type: "reference" });
    const first = buildVideoProviderRequest(model, "move", { videoMode: "first-frame", seconds: 15 }, images);
    expect(first.body).toMatchObject({ first_frame_image: images[0]!.publicUrl, image_urls: images.slice(1).map(item => item.publicUrl), duration: 15 });
    const pair = buildVideoProviderRequest(model, "move", { videoMode: "first-last-frame", seconds: 8 }, images);
    expect(pair.body).toMatchObject({ first_frame_image: images[0]!.publicUrl, last_frame_image: images[1]!.publicUrl, image_urls: images.slice(2).map(item => item.publicUrl), duration: 8, aspect_ratio: "16:9" });
    expect(pair.body).not.toHaveProperty("image_with_roles");
    expect(() => buildVideoProviderRequest(model, "move", { videoMode: "last-frame" }, [image()])).toThrow("mode only");
    expect(() => buildVideoProviderRequest(model, "move", { videoMode: "first-last-frame" }, [image()])).toThrow("at least two");
    expect(() => buildVideoProviderRequest(model, "move", {}, [...images, image(11)])).toThrow("up to 10");
  });

  test("video input defaults to edit; edit follows the source and extend bills only added duration", () => {
    const edit = preflightVideoProviderRequest(model, "只修改背景", { seconds: 99 }, [image(), { ...video, durationMs: 12500 }]);
    expect(edit.request.body).toMatchObject({ video_urls: [video.publicUrl], image_urls: [image().publicUrl], omni_reference_task_type: "edit" });
    expect(edit.request.body).not.toHaveProperty("duration");
    expect(edit.normalized).toMatchObject({ videoMode: "edit", seconds: 12.5, upstreamBillingSeconds: 12.5, upstreamDepositSeconds: 15 });
    const extend = preflightVideoProviderRequest(model, "继续平移", { videoMode: "extend", seconds: 3 }, [video, image()]);
    expect(extend.request.body).toMatchObject({ duration: 3, video_urls: [video.publicUrl], image_urls: [image().publicUrl], omni_reference_task_type: "extend" });
    expect(extend.normalized).toMatchObject({ seconds: 3, upstreamBillingSeconds: 3, upstreamDepositSeconds: 15 });
    expect(preflightVideoProviderRequest(model, "move", { seconds: 3 }).normalized.upstreamDepositSeconds).toBe(10);
    expect(preflightVideoProviderRequest(model, "move", { seconds: 15 }).normalized.upstreamDepositSeconds).toBe(15);
    expect(() => buildVideoProviderRequest(model, "move", { videoMode: "extend" }, [image()])).toThrow("至少需要一个视频");
  });

  test("validates integer duration without clamping and keeps interpolation/extension at ten seconds", () => {
    for (const seconds of [-1, 0, 2, 16, 3.5, "", null, true, NaN, Infinity]) expect(() => buildVideoProviderRequest(model, "move", { seconds })).toThrow("整数秒");
    for (const seconds of [3, 10, 15]) expect(buildVideoProviderRequest(model, "move", { seconds }).body.duration).toBe(seconds);
    for (const videoMode of ["first-last-frame", "extend"]) expect(() => buildVideoProviderRequest(model, "move", { videoMode, seconds: 11 }, videoMode === "extend" ? [video] : [image(), image(2)])).toThrow("3–10");
    expect(() => buildVideoProviderRequest(model, "move", { resolution: "2K" })).toThrow("分辨率");
    expect(() => buildVideoProviderRequest(model, "  ")).toThrow("prompt is required");
    expect(() => buildVideoProviderRequest(model, "move", { videoMode: "first-last-frame" }, [image(), { ...image(2), width: 900, height: 1600 }])).toThrow("首尾帧比例");
  });

  test("rejects excess/long videos and audio without importing Seedance's input floors or fps/dimension limits", () => {
    expect(() => buildVideoProviderRequest(model, "move", {}, [video, video])).toThrow("1 个视频和 0 个音频");
    expect(() => buildVideoProviderRequest(model, "move", {}, [{ ...video, durationMs: 15001 }])).toThrow("15 秒");
    expect(() => buildVideoProviderRequest(model, "move", {}, [{ ...video, mimeType: "audio/mpeg" }])).toThrow("0 个音频");
    expect(buildVideoProviderRequest(model, "move", {}, [{ ...video, durationMs: 500, width: 200, height: 50, fps: 12 }]).mode).toBe("edit");
    expect(buildVideoProviderRequest(model, "move", {}, [{ ...video, durationMs: 15000 }]).duration).toBe(15);
  });

  test("only admission permits internal placeholders; final bodies require public HTTP(S)", () => {
    expect(preflightVideoProviderRequest(model, "move", {}, [{ ...image(), publicUrl: "asset://pending-owned-media" }]).normalized.referenceCount).toBe(1);
    for (const publicUrl of [undefined, "asset://pending-owned-media", "data:image/png;base64,AQ==", "AQ==", "blob:https://owned.example/one", "https://localhost/image.png", "http://10.0.0.1/image.png", "http://127.0.0.1/image.png", "https://user:pass@owned.example/image.png"]) {
      expect(() => buildVideoProviderRequest(model, "move", {}, [{ ...image(), publicUrl }])).toThrow("公开 HTTP(S)");
    }
    expect(buildVideoProviderRequest(model, "move", {}, [image()]).body.first_frame_image).toBe(image().publicUrl);
  });

  test("motion planning removes the mute flag while retaining Omni auto/edit semantics", () => {
    const motion = promptInputSchema.parse({ scene: "video-motion", mode: "video", fields: { audio: "none" } });
    expect(videoMotionParameters({ generateAudio: false }, motion, ["image/png"], model)).toEqual({ videoMode: "first-frame" });
    expect(videoMotionParameters({ generateAudio: false }, motion, ["image/png", "image/png"], model)).toEqual({ videoMode: "reference" });
    const parameters = videoMotionParameters({ videoMode: "auto", generateAudio: false }, motion, ["video/mp4"], model);
    expect(parameters).toEqual({ videoMode: "auto" });
    expect(buildVideoProviderRequest(model, "move", parameters, [video]).mode).toBe("edit");
  });
});

describe("Gemini Omni submission, polling and final cost", () => {
  test("persists the ID before five-second polling and reads the URL array and final USD cost", async () => {
    const events: string[] = [];
    const pending = await stepApiMartVideoTask({ ...input, sources: [image()], beforeSubmit: async () => { events.push("claim"); return true; }, onSubmitted: async id => { events.push(`persist:${id}`); } }, {
      fetch: async (url, init) => {
        events.push(`POST:${url}`);
        expect(url).toBe("https://provider.example/v1/videos/generations");
        expect(JSON.parse(String(init?.body))).toMatchObject({ model, first_frame_image: image().publicUrl });
        return json({ code: 200, data: [{ status: "submitted", task_id: "omni-original" }] });
      },
    });
    expect(pending).toEqual({ status: "pending", upstreamTaskId: "omni-original", nextPollMs: 5000 });
    expect(events).toEqual(["claim", "POST:https://provider.example/v1/videos/generations", "persist:omni-original"]);
    const completed = await stepApiMartVideoTask({ ...input, upstreamTaskId: pending.upstreamTaskId }, { fetch: async url => {
      expect(url).toBe("https://provider.example/v1/tasks/omni-original");
      return json({ data: { status: "completed", cost: 0.12345, result: { videos: [{ url: ["https://cdn.example/omni.mp4"] }] } } });
    } });
    expect(completed).toEqual({ status: "completed", upstreamTaskId: "omni-original", url: "https://cdn.example/omni.mp4", costUsd: 0.12345 });
  });

  test("only nonnegative finite numeric final costs are exposed, including exact zero", async () => {
    for (const cost of [0, 0.25, -1, "0.25", null, undefined]) {
      const result = await stepApiMartVideoTask({ ...input, upstreamTaskId: "original" }, { fetch: async () => json({ data: { status: "completed", cost, result: { videos: [{ url: ["https://cdn.example/omni.mp4"] }] } } }) });
      if (typeof cost === "number" && cost >= 0) expect(result).toHaveProperty("costUsd", cost);
      else expect(result).not.toHaveProperty("costUsd");
    }
    for (const cost of [NaN, Infinity]) {
      const result = await stepApiMartVideoTask({ ...input, upstreamTaskId: "original" }, { fetch: async () => ({ ok: true, json: async () => ({ data: { status: "completed", cost, result: { videos: [{ url: ["https://cdn.example/omni.mp4"] }] } } }) }) as Response });
      expect(result).not.toHaveProperty("costUsd");
    }
  });

  test("queries pending work every five seconds even after a worker restart without another POST", async () => {
    for (const status of ["pending", "processing"]) {
      const calls: string[] = [];
      const result = await stepApiMartVideoTask({ ...input, upstreamTaskId: "original/id", submissionStarted: true, submissionStartedAt: "2020-01-01T00:00:00Z" }, { fetch: async (url, init) => {
        calls.push(`${init?.method || "GET"}:${url}`); return json({ data: { status } });
      } });
      expect(result).toEqual({ status: "pending", upstreamTaskId: "original/id", nextPollMs: 5000 });
      expect(calls).toEqual(["GET:https://provider.example/v1/tasks/original%2Fid"]);
    }
  });

  test("a ten-minute wait timeout retains its accepted task and resumes only that task", async () => {
    let now = 0, posts = 0, saved = "";
    await expect(runApiMartVideoTask({ ...input, onSubmitted: async id => { saved = id; } }, { now: () => now, sleep: async ms => { expect(ms).toBe(5000); now += 600000; }, fetch: async (_url, init) => {
      if (init?.method === "POST") { posts++; return json({ data: [{ task_id: "accepted" }] }); }
      return json({ data: { status: "processing" } });
    } })).rejects.toThrow("可恢复查询原任务");
    expect(saved).toBe("accepted"); expect(posts).toBe(1);
    expect(await runApiMartVideoTask({ ...input, upstreamTaskId: saved, submissionStarted: true }, { sleep: async () => undefined, fetch: async (_url, init) => {
      expect(init?.method || "GET").toBe("GET"); return json({ data: { status: "completed", result: { videos: [{ url: ["https://cdn.example/omni.mp4"] }] } } });
    } })).toBe("https://cdn.example/omni.mp4");
    let calls = 0;
    await expect(stepApiMartVideoTask({ ...input, submissionStarted: true }, { fetch: async () => { calls++; return json({}); } })).rejects.toThrow("为避免重复收费");
    expect(calls).toBe(0);
  });

  test("failed task and malformed source fail without resubmission or provider uploads", async () => {
    await expect(stepApiMartVideoTask({ ...input, upstreamTaskId: "original" }, { fetch: async () => json({ data: { status: "failed", error: { message: "invalid_duration" } } }) })).rejects.toBeInstanceOf(VideoProviderFailure);
    let calls = 0, claims = 0;
    await expect(stepApiMartVideoTask({ ...input, sources: [{ ...image(), publicUrl: "asset://pending-owned-media" }], beforeSubmit: async () => { claims++; return true; } }, { fetch: async () => { calls++; return json({}); } })).rejects.toThrow("公开 HTTP(S)");
    expect(calls).toBe(0); expect(claims).toBe(0);
  });
});

describe("stored Omni authoritative preflight", () => {
  const assetId = "30000000-0000-4000-8000-000000000001";
  const storedInput = { userId: "owner", modelConfigId: "omni-model", prompt: "编辑源视频", parameters: {}, sourceUrls: [`/api/assets/${assetId}/content`] };
  const asset = { id: assetId, objectKey: "owned/clip.mp4", mimeType: "video/mp4", byteSize: 1, metadata: { durationMs: 3000 } };
  const fixture = (changedAsset = asset) => ({ query: async (sql: string, parameters: unknown[] = []) => {
    if (sql.includes("FROM model_configs")) return { rows: [{ modelId: model }] };
    expect(sql).toContain("owner_user_id=$2"); expect(parameters).toEqual([assetId, "owner"]);
    return { rows: [changedAsset] };
  } });
  const readSource = async () => (async function* () { yield new Uint8Array([1]); })();

  test("uses actual probed source length, the owned HTTP origin and a read-only identity snapshot", async () => {
    const checked = await preflightStoredVideoTask(fixture() as never, storedInput, "http://owned.example", { readSource, probe: async () => ({ durationMs: 6500, width: 200, height: 50, fps: 12 }) });
    expect(checked.normalized).toMatchObject({ videoMode: "edit", seconds: 6.5, upstreamBillingSeconds: 6.5, upstreamDepositSeconds: 15 });
    expect(checked.request.body).not.toHaveProperty("duration");
    await expect(validateStoredVideoPreflightSnapshot(fixture() as never, storedInput, checked.snapshot)).resolves.toBeUndefined();
    await expect(validateStoredVideoPreflightSnapshot(fixture({ ...asset, objectKey: "changed" }) as never, storedInput, checked.snapshot)).rejects.toThrow("已变化");
  });

  test("actual media probing catches a stale duration before any admission or charge", async () => {
    await expect(preflightStoredVideoTask(fixture() as never, storedInput, "http://owned.example", { readSource, probe: async () => ({ durationMs: 15001, width: 1600, height: 900, fps: 24 }) })).rejects.toThrow("15 秒");
  });

  test("all media require an owned public origin before reading source bytes", async () => {
    let reads = 0;
    for (const mimeType of ["image/png", "video/mp4"]) {
      await expect(preflightStoredVideoTask(fixture({ ...asset, mimeType }) as never, storedInput, "", { readSource: async () => { reads++; return readSource(); } })).rejects.toThrow("PROVIDER_IMAGE_PUBLIC_ORIGIN");
    }
    expect(reads).toBe(0);
  });
});
