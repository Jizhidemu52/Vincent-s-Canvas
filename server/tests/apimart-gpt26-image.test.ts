import { describe, expect, test } from "bun:test";
import { apiMartImageModel, buildApiMartImageRequest, runApiMartImageTask } from "../src/apimart-image";
import { assertImageEditMaskSupport } from "../src/image-edit-input";

const models = ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"] as const;
const reference = "https://images.example/reference.png";
const mask = "data:image/png;base64,AQID";
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

describe.each(models.map(modelId => [modelId] as const))("APIMart %s static images", modelId => {
  const base = { modelId, prompt: "Edit the ribbon while preserving the product", parameters: {} };

  test("keeps the exact model ID and independent quality/resolution for sixteen references and mask", () => {
    expect(apiMartImageModel(modelId)).toBe(modelId);
    const request = buildApiMartImageRequest({ ...base, sourceDataUrls: Array(16).fill(reference), maskDataUrl: mask,
      parameters: { quality: "max", resolution: "4K", size: "16:9", background: "transparent", output_format: "webp", output_compression: 0, moderation: "low" } });
    expect(request.path).toBe("/images/generations");
    expect(request.payload).toEqual({ model: modelId, prompt: base.prompt, n: 1, quality: "max", resolution: "4k", size: "16:9",
      background: "transparent", output_format: "webp", output_compression: 0, moderation: "low", image_urls: Array(16).fill(reference), mask_url: mask });
    expect(() => assertImageEditMaskSupport({ inputArchive: { maskReferenceIndex: 1 } }, { protocol: "apimart", modelId, operationType: "inpaint" }, 2)).not.toThrow();
  });

  test("preserves adaptive edits, exact dimensions and all documented static quality levels", () => {
    const payload = buildApiMartImageRequest({ ...base, sourceDataUrls: [reference] }).payload;
    expect(payload).toMatchObject({ model: modelId, resolution: "1k", quality: "auto" });
    expect(payload).not.toHaveProperty("size");
    expect(payload).not.toHaveProperty("complexity");
    for (const quality of ["low", "medium", "high", "xhigh", "max", "auto"])
      expect(buildApiMartImageRequest({ ...base, parameters: { quality, size: "1600x1200" } }).payload).toMatchObject({ quality, size: "1600x1200" });
  });

  test("rejects invalid and excluded requests before sending credentials or creating a paid task", async () => {
    const invalid = [
      { sourceDataUrls: Array(17).fill(reference) }, { prompt: "x".repeat(32_001) },
      { parameters: { quality: "ultra" } }, { parameters: { resolution: "3k" } }, { parameters: { n: 2 } },
      { parameters: { size: "4000x2048" } }, { parameters: { background: "transparent", output_format: "jpeg" } },
      { parameters: { output_format: "gif", size: "1:1" } }, { parameters: { output_format: "svg" } },
      { parameters: { markup_url: reference } }, { parameters: { frame_count: 9 } }, { parameters: { stream: true } },
      { sourceDataUrls: [], maskDataUrl: mask },
    ];
    for (const extra of invalid) {
      let calls = 0;
      await expect(runApiMartImageTask({ ...base, ...extra, baseUrl: "https://provider.example/v1", apiKey: "fixture-only" }, {
        fetch: async () => { calls++; return json({}); }, sleep: async () => {},
      })).rejects.toThrow();
      expect(calls).toBe(0);
    }
  });

  test("uploads references then submits the exact 2.6 ID once and polls the returned task", async () => {
    const requests: string[] = [];
    const result = await runApiMartImageTask({ ...base, baseUrl: "https://provider.example/v1", apiKey: "fixture-only", sourceDataUrls: [mask], maskDataUrl: mask }, {
      sleep: async () => {}, fetch: async (url, init) => {
        requests.push(url);
        if (url.endsWith("/uploads/images")) return json({ url: reference });
        if (url.endsWith("/images/generations")) {
          expect(JSON.parse(String(init?.body))).toMatchObject({ model: modelId, image_urls: [reference], mask_url: mask, n: 1 });
          return json({ data: [{ task_id: "gpt26-task" }] });
        }
        expect(url).toBe("https://provider.example/v1/tasks/gpt26-task");
        return json({ data: { status: "completed", result: { images: [{ url: ["https://images.example/result.png"] }] } } });
      },
    });
    expect(requests).toHaveLength(3);
    expect(result).toEqual(["https://images.example/result.png"]);
  });
});

test("unknown 2.6 variants never alias to another paid model", () => {
  expect(apiMartImageModel("gpt-image-2.6-unknown")).toBeNull();
});
