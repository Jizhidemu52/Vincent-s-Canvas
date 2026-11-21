import { describe, expect, test } from "bun:test";
import { MARK_IMAGE_PROVIDER_ID, MARK_PLATFORM_MODELS } from "../../shared/mark-image-models";
import { quickImageModelId } from "../../shared/quick-image-tools";
import { apiMartImageModel, buildApiMartImageRequest, stepApiMartImageTask } from "../src/apimart-image";
import { imageParameterProfile } from "../src/image-parameter-profile";
import { promptImageReferenceLimit } from "../src/image-task-policy";
import { presentPublicModel, selectCreativeModels } from "../src/model-presentation";

const base = { baseUrl: "https://provider.example/v1", apiKey: "fixture-secret", modelId: "mai-image-2.7-flash" as const, prompt: "保留商品结构并更换颜色", parameters: {} };
const reference = "https://images.example/reference.png";
const json = (value: unknown) => Response.json(value);

describe("MAI Image 2.7 Flash contract", () => {
  test("offers MAI 2.7 with a distinct profile while fixed quick tools retain their configured model", () => {
    const preset = MARK_PLATFORM_MODELS.find(model => model.modelId === base.modelId);
    expect(preset).toMatchObject({ name: "aplmart-mai2.7-flash", demoOrdinal: 16, defaultEnabled: true, capabilities: ["generate", "edit", "batch"] });
    expect(apiMartImageModel(base.modelId)).toBe(base.modelId);
    for (const alias of ["mai-image-2.7", "mai2.7", "mai-image-2.7-flash-extra"]) expect(apiMartImageModel(alias)).toBeNull();
    const model = { ...preset, id: "mai-uuid", modelId: base.modelId, providerId: MARK_IMAGE_PROVIDER_ID, protocol: "apimart", rmbCost: 0 };
    expect(selectCreativeModels([model])).toEqual([model]);
    for (const role of ["designer", "department_admin", "super_admin"]) {
      expect(presentPublicModel(model, role)).toMatchObject({ modelId: "mai-uuid", name: "aplmart-mai2.7-flash", imageParameterProfile: "mai-image-v2", imageSupportsMask: false, rmbCost: 0 });
    }
    expect(imageParameterProfile("apimart", base.modelId, MARK_IMAGE_PROVIDER_ID)).toBe("mai-image-v2");
    expect(quickImageModelId("remove-background")).toBe("mai-image-2.6-flash");
    expect(quickImageModelId("hd-upscale")).toBe("gemini-nano-banana-2.1");
    expect(promptImageReferenceLimit({ modelId: base.modelId, protocol: "apimart" })).toBe(5);
  });

  test("defaults to one 1K square and permits only documented ratio resolutions", () => {
    expect(buildApiMartImageRequest(base)).toMatchObject({ path: "/images/generations", pollIntervalMs: 3_000,
      payload: { model: base.modelId, prompt: base.prompt, n: 1, size: "1:1", resolution: "1K" } });
    for (const size of ["1:4", "4:1", "16:9", "9:16", "7:3"]) {
      expect(buildApiMartImageRequest({ ...base, parameters: { size, resolution: "2k" } }).payload).toEqual({ model: base.modelId, prompt: base.prompt, n: 1, size, resolution: "2K" });
    }
    for (const parameters of [{ size: "auto" }, { size: "5:1" }, { size: "1:5" }, { size: "0:1" }, { resolution: "4K" }, { resolution: 2048 }]) {
      expect(() => buildApiMartImageRequest({ ...base, parameters })).toThrow();
    }
  });

  test("pixel dimensions use the 4 MP boundary without inventing a 2048 edge or 4:1 pixel limit", () => {
    for (const size of ["2048x2048", "2560x1536", "5461x768", "768x5461", "1025x1024"]) {
      expect(buildApiMartImageRequest({ ...base, parameters: { size, resolution: "4k" } }).payload).toEqual({ model: base.modelId, prompt: base.prompt, n: 1, size });
    }
    for (const size of ["2560*1536", "2560×1536"]) {
      expect(buildApiMartImageRequest({ ...base, parameters: { size } }).payload.size).toBe("2560x1536");
    }
    const payload = buildApiMartImageRequest({ ...base, parameters: { width: 2560, height: 1536, size: "auto", resolution: "4k" } }).payload;
    expect(payload).toEqual({ model: base.modelId, prompt: base.prompt, n: 1, width: 2560, height: 1536 });
    for (const parameters of [{ size: "2080x2048" }, { size: "5462x768" }, { size: "767x1024" }, { width: 2048 }, { height: 2048 },
      { width: 2048, height: 2049 }, { width: 767, height: 1024 }, { width: 1024.5, height: 1024 }, { width: "1024", height: 1024 }]) {
      expect(() => buildApiMartImageRequest({ ...base, parameters })).toThrow();
    }
  });

  test("validates 20000-character prompts, single output, and unsupported controls before network access", async () => {
    expect(buildApiMartImageRequest({ ...base, prompt: "图".repeat(20_000) }).payload.prompt).toHaveLength(20_000);
    for (const prompt of ["", " \n\t", "图".repeat(20_001)]) expect(() => buildApiMartImageRequest({ ...base, prompt })).toThrow();
    const invalid = [{ n: 2 }, { n: "1" }, { web_grounding: true }, { auto_aspect_ratio: true }, { web_grounding: "false" },
      { auto_aspect_ratio: "false" }, { background: "transparent" }, { background: true }, { nsfw_check: "true" },
      { quality: "high" }, { output_format: "png" }, { mask_url: reference }];
    let calls = 0, claims = 0;
    for (const parameters of invalid) {
      await expect(stepApiMartImageTask({ ...base, parameters, sourceImages: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }], beforeSubmit: () => { claims++; } }, {
        fetch: async () => { calls++; return json({}); },
      })).rejects.toThrow();
    }
    expect({ calls, claims }).toEqual({ calls: 0, claims: 0 });
  });

  test("forwards optional opaque background and safety controls but never forwards deprecated false flags", () => {
    for (const background of ["auto", "opaque"]) {
      for (const nsfw_check of [false, true]) {
        const payload = buildApiMartImageRequest({ ...base, parameters: { background, nsfw_check, web_grounding: false, auto_aspect_ratio: false } }).payload;
        expect(payload).toMatchObject({ background, nsfw_check });
        expect(payload).not.toHaveProperty("web_grounding");
        expect(payload).not.toHaveProperty("auto_aspect_ratio");
      }
    }
    expect(buildApiMartImageRequest(base).payload).not.toHaveProperty("nsfw_check");
  });

  test("reference editing strips all text-to-image dimensions, preserves reference order and caps at five", () => {
    const references = Array.from({ length: 5 }, (_, index) => `https://images.example/reference-${index}.png`);
    const parameters = { size: "auto", resolution: "4k", width: 99999, height: 1, count: 15, background: "opaque", nsfw_check: true };
    expect(buildApiMartImageRequest({ ...base, sourceDataUrls: references, parameters }).payload).toEqual({ model: base.modelId, prompt: base.prompt, n: 1,
      background: "opaque", nsfw_check: true, image_urls: references });
    expect(() => buildApiMartImageRequest({ ...base, sourceDataUrls: [...references, reference] })).toThrow("5");
    expect(() => buildApiMartImageRequest({ ...base, sourceDataUrls: references, maskDataUrl: "data:image/png;base64,AQID" })).toThrow("蒙版");
    for (const url of ["https://localhost/a.png", "file:///a.png", "http://127.0.0.1/a.png"]) {
      expect(() => buildApiMartImageRequest({ ...base, sourceDataUrls: [url] })).toThrow();
    }
  });

  test("binary references upload once before one durable 2.7 submission with no obsolete parameters", async () => {
    const sequence: string[] = [];
    const result = await stepApiMartImageTask({ ...base, sourceImages: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }],
      beforeSubmit: () => { sequence.push("intent"); }, onSubmitted: id => { sequence.push(id); } }, {
      fetch: async (url, init) => {
        if (url.endsWith("/images/generations")) {
          sequence.push("submit");
          expect(JSON.parse(String(init?.body))).toEqual({ model: base.modelId, prompt: base.prompt, n: 1, image_urls: [reference] });
          return json({ data: [{ task_id: "mai27-task" }] });
        }
        expect(url).toEndWith("/uploads/images");
        sequence.push("upload"); return json({ url: reference });
      },
    });
    expect(result).toEqual({ status: "pending", upstreamTaskId: "mai27-task", nextPollMs: 3_000 });
    expect(sequence).toEqual(["upload", "intent", "submit", "mai27-task"]);
  });

  test("an uncertain submission never replays and a saved task only queries its original ID", async () => {
    let calls = 0;
    await expect(stepApiMartImageTask({ ...base, submissionStarted: true }, { fetch: async () => { calls++; return json({}); } })).rejects.toThrow("不会自动重新提交");
    expect(calls).toBe(0);
    const input = { ...base, upstreamTaskId: "saved-mai27-task", submissionStarted: true };
    const result = await stepApiMartImageTask(input, { fetch: async (url, init) => {
      expect(url).toEndWith("/tasks/saved-mai27-task?language=zh"); expect(init?.method ?? "GET").toBe("GET");
      return json({ data: { status: "completed", result: { images: [{ url: [reference] }] } } });
    } });
    expect(result).toMatchObject({ status: "completed", urls: [reference] });
    await expect(stepApiMartImageTask(input, { fetch: async () => json({ data: { status: "completed", result: { images: [{ url: ["http://127.0.0.1/result.png"] }] } } }) })).rejects.toThrow("无效结果地址");
  });
});
