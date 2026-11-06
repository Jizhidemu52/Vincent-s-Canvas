import { describe, expect, test } from "bun:test";
import { buildApiMartImageRequest, stepApiMartImageTask } from "../src/apimart-image";
import { imageParameterProfile } from "../src/image-parameter-profile";
import { MARK_IMAGE_PROVIDER_ID } from "../../shared/mark-image-models";
import { imageResultExtension } from "../src/image-result-storage";

for (const modelId of ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"]) describe(modelId, () => {
  const base = { modelId, prompt: "A gently waving blue ribbon", parameters: {} };
  test("advertises 2.6-only capabilities without changing the 2.5 profile", () => {
    expect(imageParameterProfile("apimart", modelId, MARK_IMAGE_PROVIDER_ID)).toBe("quality-resolution-v2");
    expect(imageParameterProfile("apimart", "gpt-image-2.5-flare", MARK_IMAGE_PROVIDER_ID)).toBe("quality-resolution");
  });
  test("forwards planning complexity independently of rendering quality", () => {
    expect(buildApiMartImageRequest({ ...base, parameters: { quality: "low", complexity: "high", moderation: "auto" } }).payload)
      .toMatchObject({ quality: "low", complexity: "high", moderation: "auto" });
  });
  test("GIF frames use their own sizing and retain documented defaults", () => {
    expect(buildApiMartImageRequest({ ...base, parameters: { output_format: "gif" } }).payload)
      .toMatchObject({ output_format: "gif", size: "auto", frame_count: 9, frame_duration_ms: 200 });
    for (let frame_count = 2; frame_count <= 16; frame_count++) {
      expect(buildApiMartImageRequest({ ...base, parameters: { output_format: "gif", size: "512x512", frame_count, frame_duration_ms: 20 } }).payload)
        .toMatchObject({ size: "512x512", frame_count, frame_duration_ms: 20 });
    }
    expect(buildApiMartImageRequest({ ...base, parameters: { output_format: "gif", size: "768x768", frame_count: 12 } }).payload.size).toBe("768x768");
    expect(buildApiMartImageRequest({ ...base, parameters: { output_format: "gif", size: "1024x512", frame_count: 8 } }).payload.size).toBe("1024x512");
  });
  test("invalid combinations never upload or send a paid request", async () => {
    for (const extra of [
      { parameters: { complexity: "max" } }, { parameters: { output_format: "svg" } },
      { parameters: { output_format: "gif", size: "1:1" } },
      { parameters: { output_format: "gif", size: "1024x1024", frame_count: 2 } },
      { parameters: { output_format: "gif", size: "768x768", frame_count: 13 } },
      { parameters: { output_format: "gif", size: "511x512" } },
      { parameters: { output_format: "gif", frame_count: 1 } }, { parameters: { output_format: "gif", frame_count: 17 } },
      { parameters: { output_format: "gif", frame_duration_ms: 10 } }, { parameters: { output_format: "gif", frame_duration_ms: 25 } },
      { parameters: { output_format: "gif", background: "transparent" } }, { parameters: { output_format: "gif", output_compression: 1 } },
      { parameters: { output_format: "gif" }, sourceDataUrls: ["https://images.example/source.png"] },
      { parameters: { frame_count: 9 } }, { parameters: { frame_duration_ms: 200 } },
      { parameters: { markup_url: "https://images.example/layer.png" }, sourceDataUrls: ["https://images.example/source.png"] },
    ]) {
      let calls = 0;
      await expect(stepApiMartImageTask({ ...base, ...extra, baseUrl: "https://provider.example/v1", apiKey: "test-only" }, {
        fetch: async () => { calls++; return Response.json({}); },
      })).rejects.toThrow();
      expect(calls).toBe(0);
    }
  });
});

test("GIF downloads keep a GIF filename", () => expect(imageResultExtension("image/gif")).toBe("gif"));
