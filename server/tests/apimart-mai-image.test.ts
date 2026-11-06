import { describe, expect, test } from "bun:test";
import { MARK_IMAGE_PROVIDER_ID, MARK_PLATFORM_MODELS } from "../../shared/mark-image-models";
import { quickImageModelId } from "../../shared/quick-image-tools";
import { apiMartImageModel, buildApiMartImageRequest, stepApiMartImageTask } from "../src/apimart-image";
import { presentPublicModel, selectCreativeModels } from "../src/model-presentation";

const base = { baseUrl: "https://provider.example/v1", apiKey: "fixture-secret", modelId: "mai-image-2.6-flash" as const, prompt: "Restore this product", parameters: {} };
const reference = "https://images.example/reference.png";
const json = (value: unknown) => Response.json(value);

describe("MAI Image 2.6 Flash independent contract", () => {
  test("catalog appends MAI without replacing Nano or changing public opaque identifiers", () => {
    expect(MARK_PLATFORM_MODELS[2]!.modelId).toBe("gemini-nano-banana-2.1");
    expect(MARK_PLATFORM_MODELS[12]!.modelId).toBe(base.modelId);
    expect(apiMartImageModel(base.modelId)).toBe(base.modelId);
    expect(apiMartImageModel("mai-image-2.6")).toBeNull();
    const model = { id: "mai-uuid", modelId: base.modelId, providerId: MARK_IMAGE_PROVIDER_ID, protocol: "apimart", capabilities: ["generate", "edit", "batch"], rmbCost: 0 };
    expect(selectCreativeModels([model])).toEqual([model]);
    for (const role of ["designer", "super_admin"]) expect(presentPublicModel(model, role)).toMatchObject({ modelId: "mai-uuid", name: "aplmart-mai2.6-flash", imageParameterProfile: "mai-image", imageSupportsMask: false, rmbCost: 0 });
    expect(presentPublicModel(model, "designer")).not.toHaveProperty("imageCost");
    expect(quickImageModelId("remove-background")).toBe(base.modelId);
    expect(quickImageModelId("hd-upscale")).toBe("gemini-nano-banana-2.1");
  });

  test("text-to-image permits only documented 1K/2K, ratios and exact pixels", () => {
    expect(buildApiMartImageRequest(base).payload).toEqual({ model: base.modelId, prompt: base.prompt, n: 1, size: "1:1", resolution: "1K", web_grounding: false });
    expect(buildApiMartImageRequest({ ...base, parameters: { auto_aspect_ratio: true } }).payload).toMatchObject({ size: "auto", auto_aspect_ratio: true });
    for (const size of ["1536*1024", "1536×1024"]) expect(buildApiMartImageRequest({ ...base, parameters: { size } }).payload.size).toBe("1536x1024");
    expect(() => buildApiMartImageRequest({ ...base, parameters: { auto_aspect_ratio: "yes" } })).toThrow("auto_aspect_ratio");
    for (const size of ["1:4", "4:1", "16:9", "9:16", "1536x1536", "768x3072", "1025x1024"]) {
      expect(buildApiMartImageRequest({ ...base, parameters: { size, resolution: "2k", web_grounding: true } }).payload).toMatchObject({ size, resolution: "2K", web_grounding: true });
    }
    expect(buildApiMartImageRequest({ ...base, parameters: { width: 1024, height: 1536 } }).payload).toMatchObject({ width: 1024, height: 1536 });
    for (const parameters of [{ resolution: "4k" }, { size: "1:5" }, { size: "5:1" }, { size: "0:1" }, { size: "767x1024" }, { size: "2048x2048" }, { width: 768 }, { width: 768, height: 4000 }, { web_grounding: "true" }]) {
      expect(() => buildApiMartImageRequest({ ...base, parameters })).toThrow();
    }
  });

  test("reference editing strips every size control, caps references at five and has no mask or output knobs", () => {
    const payload = buildApiMartImageRequest({ ...base, sourceDataUrls: [reference], parameters: { size: "4:1", resolution: "4k", width: 4096, height: 4096, count: 5, web_grounding: false } }).payload;
    expect(payload).toEqual({ model: base.modelId, prompt: base.prompt, n: 1, web_grounding: false, image_urls: [reference] });
    expect(buildApiMartImageRequest({ ...base, sourceDataUrls: Array(5).fill(reference) }).payload.image_urls).toHaveLength(5);
    expect(() => buildApiMartImageRequest({ ...base, sourceDataUrls: Array(6).fill(reference) })).toThrow("5");
    for (const key of ["quality", "style", "background", "output_format", "response_format", "mask_url"]) expect(() => buildApiMartImageRequest({ ...base, parameters: { [key]: "auto" } })).toThrow(key);
    expect(() => buildApiMartImageRequest({ ...base, maskDataUrl: "data:image/png;base64,AQID" })).toThrow("蒙版");
    expect(() => buildApiMartImageRequest({ ...base, parameters: { n: 2 } })).toThrow();
    for (const url of ["https://localhost/a.png", "file:///a.png", "http://127.0.0.1/a.png"]) expect(() => buildApiMartImageRequest({ ...base, sourceDataUrls: [url] })).toThrow();
  });

  test("invalid settings fail before upload; valid binary sources upload once before one durable submission", async () => {
    const sourceImages = [{ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }];
    let calls = 0;
    await expect(stepApiMartImageTask({ ...base, sourceImages, parameters: { quality: "high" } }, { fetch: async () => { calls++; return json({}); } })).rejects.toThrow("quality");
    expect(calls).toBe(0);
    const sequence: string[] = [];
    const result = await stepApiMartImageTask({ ...base, sourceImages, beforeSubmit: () => { sequence.push("intent"); }, onSubmitted: id => { sequence.push(id); } }, {
      fetch: async (url, init) => {
        if (url.endsWith("/images/generations")) {
          sequence.push("submit");
          expect(JSON.parse(String(init?.body))).toEqual({ model: base.modelId, prompt: base.prompt, n: 1, web_grounding: false, image_urls: [reference] });
          return json({ data: [{ task_id: "mai-task" }] });
        }
        sequence.push("upload"); return json({ url: reference });
      },
    });
    expect(result).toMatchObject({ status: "pending", upstreamTaskId: "mai-task" });
    expect(sequence).toEqual(["upload", "intent", "submit", "mai-task"]);
  });

  test("unknown submission is never replayed; existing tasks only query and require public result URLs", async () => {
    let calls = 0;
    await expect(stepApiMartImageTask({ ...base, submissionStarted: true }, { fetch: async () => { calls++; return json({}); } })).rejects.toThrow("不会自动重新提交");
    expect(calls).toBe(0);
    const input = { ...base, upstreamTaskId: "saved-mai-task", submissionStarted: true };
    const result = await stepApiMartImageTask(input, { fetch: async (url, init) => {
      expect(url).toEndWith("/tasks/saved-mai-task"); expect(init?.method ?? "GET").toBe("GET");
      return json({ data: { status: "completed", result: { images: [{ url: [reference] }] } } });
    } });
    expect(result).toMatchObject({ status: "completed", urls: [reference] });
    await expect(stepApiMartImageTask(input, { fetch: async () => json({ data: { status: "completed", result: { images: [{ url: ["http://127.0.0.1/result.png"] }] } } }) })).rejects.toThrow("无效结果地址");
  });
});
