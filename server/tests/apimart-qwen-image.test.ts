import { expect, test } from "bun:test";
import { MARK_IMAGE_PROVIDER_ID, MARK_PLATFORM_MODELS } from "../../shared/mark-image-models";
import { QWEN_IMAGE_MODEL, QWEN_IMAGE_REFERENCE_MAX_BYTES } from "../../shared/qwen-image-options";
import { apiMartImageModel, buildApiMartImageRequest, stepApiMartImageTask } from "../src/apimart-image";
import { applyImagePromptExclusions } from "../src/image-prompt-exclusions";
import { presentPublicModel, selectCreativeModels } from "../src/model-presentation";
import { promptImageReferenceLimit } from "../src/image-task-policy";

const input = { modelId: QWEN_IMAGE_MODEL, prompt: "生成一张杯子商品照片", parameters: {} };
const reference = { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" };

test("the standard Qwen model is a selectable APIMart image model, advertised without mask support", () => {
  const preset = MARK_PLATFORM_MODELS.find(model => model.modelId === QWEN_IMAGE_MODEL)!;
  const model = { ...preset, id: "qwen-config", protocol: "apimart", providerId: MARK_IMAGE_PROVIDER_ID };
  expect(selectCreativeModels([model])).toEqual([model]);
  expect(presentPublicModel(model, "designer")).toMatchObject({ modelId: model.id, name: "Qwen Image 3.0", imageParameterProfile: "qwen-image", imageSupportsMask: false, capabilities: ["generate", "edit", "batch"] });
  expect(promptImageReferenceLimit(model)).toBe(3);
  expect(apiMartImageModel("qwen-image-3.0-pro")).toBeNull();
});

test("Qwen maps ratio, resolution, exclusions and ordered references to the documented wire format", () => {
  const excluded = applyImagePromptExclusions({ ...input, operationType: "inpaint", parameters: { size: "16x9", resolution: "2k", negative_prompt: "水印" } }, { ...input, protocol: "apimart" });
  const request = buildApiMartImageRequest({ ...excluded, sourceImages: [reference, "https://images.example/reference.png"] });
  expect(request.path).toBe("/images/generations");
  expect(request.payload).toEqual({ model: QWEN_IMAGE_MODEL, prompt: input.prompt, n: 1, size: "16:9", resolution: "2K", negative_prompt: "水印",
    image_urls: ["data:image/png;base64,AQID", "https://images.example/reference.png"] });
  expect(buildApiMartImageRequest({ ...input, parameters: { size: "1800x1200", resolution: "2k" } }).payload).toEqual({ model: QWEN_IMAGE_MODEL, prompt: input.prompt, n: 1, size: "1800x1200" });
});

test("invalid source and output settings cannot reach the Qwen submission endpoint", async () => {
  const credentials = { baseUrl: "https://provider.example/v1", apiKey: "test-only-key" };
  const fetch = async () => { throw new Error("unexpected network call"); };
  for (const [overrides, error] of [
    [{ sourceImages: Array.from({ length: 4 }, () => reference) }, "最多支持 3 张"],
    [{ sourceImages: [{ ...reference, bytes: new Uint8Array(QWEN_IMAGE_REFERENCE_MAX_BYTES + 1) }] }, "10 MiB"],
    [{ sourceImages: ["data:image/png;base64,A="] }, "10 MiB"],
    [{ maskImage: reference }, "独立蒙版"],
    [{ parameters: { size: "4096x2048" } }, "512–2048"],
    [{ parameters: { resolution: "4K" } }, "1K/2K"],
    [{ parameters: { n: 2 } }, "n 必须为 1"],
  ] as const) {
    await expect(stepApiMartImageTask({ ...credentials, ...input, ...overrides, sourceImages: "sourceImages" in overrides ? [...overrides.sourceImages] : [] }, { fetch })).rejects.toThrow(error);
  }
});

test("Qwen submits once and resumes polling the saved task for a completed image", async () => {
  const provider = { ...input, baseUrl: "https://provider.example/v1", apiKey: "test-only-key", sourceImages: [reference] };
  const calls: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method || "GET"} ${url}`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-only-key");
    if (init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toMatchObject({ n: 1, size: "1:1", resolution: "1K", image_urls: ["data:image/png;base64,AQID"] });
      return Response.json({ code: 200, data: [{ task_id: "qwen-saved-task" }] });
    }
    return Response.json({ code: 200, data: { status: "completed", result: { images: [{ url: ["https://images.example/result.png"] }] } } });
  };
  const pending = await stepApiMartImageTask(provider, { fetch });
  expect(pending).toMatchObject({ status: "pending", upstreamTaskId: "qwen-saved-task" });
  expect(await stepApiMartImageTask({ ...provider, upstreamTaskId: "qwen-saved-task", submissionStarted: true }, { fetch })).toMatchObject({ status: "completed", urls: ["https://images.example/result.png"] });
  expect(calls).toEqual(["POST https://provider.example/v1/images/generations", "GET https://provider.example/v1/tasks/qwen-saved-task?language=zh"]);
});
