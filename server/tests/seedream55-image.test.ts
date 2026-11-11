import { describe, expect, test } from "bun:test";
import { buildApiMartImageRequest, stepApiMartImageTask } from "../src/apimart-image";
import { parseSeedream55Manifest, seedream55PublicDocument } from "../src/seedream55-image";
import { LAYER_STUDIO_RATIOS, validateLayerStudioOptions } from "../../shared/layer-studio-options";

const input = { modelId: "seedream-5-5", prompt: "A scarf", parameters: {} as Record<string, unknown> };
const image = { bytes: Buffer.from("opaque test reference"), mimeType: "image/png" };
describe("dedicated image/layer parameters", () => {
  test("empty prompt is accepted only for one-input decomposition; layer size alias is normalized and background absent", () => {
    const payload = buildApiMartImageRequest({ ...input, prompt: "", sourceImages: [image], parameters: { layer_decomposition: true, resolution: "1.5K", layer_decomposition_options: { max_images: 100, text_recognition: true }, output_format: "jpeg", nsfw_check: true, watermark: false, optimize_prompt_options: { mode: "standard" } } }).payload;
    expect(payload).toMatchObject({ model: "seedream-5-5", n: 1, size: "1.5K", output_format: "jpeg", nsfw_check: true, layer_decomposition_options: { max_images: 100, text_recognition: true } });
    expect(payload).not.toHaveProperty("prompt"); expect(payload).not.toHaveProperty("resolution"); expect(payload).not.toHaveProperty("background");
    expect((payload.image_urls as string[])[0]).toBe(`data:image/png;base64,${image.bytes.toString("base64")}`);
    expect(() => buildApiMartImageRequest({ ...input, prompt: "" })).toThrow();
  });
  test("all documented generation ratios, aliases, tiers and exact limits are accepted", () => {
    for (const ratio of LAYER_STUDIO_RATIOS) for (const size of [ratio, ratio.replace(":", "x")]) expect(validateLayerStudioOptions({ size, resolution: "1.5K" }, "x", 10).size).toBe(size);
    for (const size of ["auto", "1K", "1.5K", "2K", "960x960", "2048x1152", "4624x1000"]) expect(validateLayerStudioOptions({ size }, "x", 0).size).toBe(size);
    expect(buildApiMartImageRequest({ ...input, parameters: { background: "transparent", output_format: "png" } }).payload.background).toBe("transparent");
    expect(buildApiMartImageRequest({ ...input, sourceImages: Array(10).fill(image) }).payload.image_urls).toHaveLength(10);
  });
  test.each([
    { n: 2 }, { n: "1" }, { size: "4K" }, { size: "959x960" }, { size: "4625x1000" }, { size: "32768x32" },
    { size: "2048x1152", resolution: "2K" }, { resolution: "auto" }, { output_format: "webp" },
    { background: "transparent", output_format: "jpeg" }, { optimize_prompt_options: { mode: "disabled" } },
    { optimize_prompt_options: { mode: "standard", extra: true } }, { layer_decomposition_options: { max_images: 3 } },
    { stream: false }, { tools: [] }, { sequential_image_generation: "auto" }, { image_urls: ["https://attacker.example/x.png"] }, { nsfw_check: "false" },
  ])("rejects invalid generation parameters before any POST: %j", async parameters => {
    let requests = 0;
    await expect(stepApiMartImageTask({ ...input, parameters, baseUrl: "https://provider.example/v1", apiKey: "fixture" }, { fetch: async () => { requests++; return Response.json({}); } })).rejects.toThrow();
    expect(requests).toBe(0);
  });
  test.each([
    { background: "auto" }, { size: "16:9" }, { size: "1024x1024" },
    { layer_decomposition_options: { max_images: 1 } }, { layer_decomposition_options: { max_images: 101 } },
    { layer_decomposition_options: { max_images: 2.1 } }, { layer_decomposition_options: { max_images: "10" } },
    { layer_decomposition_options: { text_recognition: "true" } },
  ])("rejects invalid layer controls: %j", parameters => expect(() => buildApiMartImageRequest({ ...input, sourceImages: [image], parameters: { ...parameters, layer_decomposition: true } })).toThrow());
  test("decomposition uses size over resolution, validates reference count and one paid operation", () => {
    expect(buildApiMartImageRequest({ ...input, sourceImages: [image], parameters: { layer_decomposition: true, size: "1K", resolution: "2K" } }).payload.size).toBe("1K");
    for (const count of [0, 2, 10]) expect(() => buildApiMartImageRequest({ ...input, sourceImages: Array(count).fill(image), parameters: { layer_decomposition: true } })).toThrow();
    expect(() => buildApiMartImageRequest({ ...input, sourceImages: Array(11).fill(image) })).toThrow();
  });
});

test("group/index and duplicate URLs are preserved; mismatched arrays never shift metadata", () => {
  const manifest = parseSeedream55Manifest({ data: { result: { images: [
    { url: ["https://images.example/base.jpg", "https://images.example/same.png", "https://images.example/same.png"], sizes: ["100x100"], layers: [{ z_index: 0 }, { z_index: 2, name: "title", bounding_box: { absolute: [10, 20, 70, 60], normalized: [100, 200, 700, 600] }, text_recognition: { text: "SALE", lines: [{ runs: [{ text: "SALE", style: { similar_font_family: "unknown", foreground_color: "#002244", bold: true } }] }] } }, { name: "icon" }] },
    { url: ["https://images.example/second-base.png"], sizes: ["900x1200"], backgrounds: ["opaque"], expires_at: 123456 },
  ] } } }, true);
  expect(manifest.items).toHaveLength(4);
  expect(manifest.items.map(item => [item.public.index, item.public.groupIndex, item.public.urlIndex, item.public.role])).toEqual([[0, 0, 0, "base"], [1, 0, 1, "layer"], [2, 0, 2, "layer"], [3, 1, 0, "base"]]);
  expect(manifest.items[1]!.public.width).toBeUndefined();
  expect(manifest.items[1]!.public.textRecognition).toMatchObject({ text: "SALE", lines: [{ runs: [{ style: { similarFontFamily: "unknown", foregroundColor: "#002244", bold: true } }] }] });
  expect(manifest.items[2]!.url).toBe(manifest.items[1]!.url);
  expect(manifest.items[3]!.public).toMatchObject({ width: 900, height: 1200 });
  const document = seedream55PublicDocument("local-task", manifest);
  expect(JSON.stringify(document)).not.toContain("https:"); expect(JSON.stringify(document)).not.toContain("expiresAt");
});

test("missing metadata/OCR is optional; invalid URL, 101 outputs and multi-output generation reject", () => {
  const payload = (url: unknown[]) => ({ data: { result: { images: [{ url }] } } });
  const hundred = Array.from({ length: 100 }, (_, i) => `https://images.example/${i}.png`);
  expect(parseSeedream55Manifest(payload(hundred), true).items).toHaveLength(100);
  expect(parseSeedream55Manifest(payload(hundred), true).items[1]!.public).not.toHaveProperty("boundingBox");
  for (const urls of [[...hundred, "https://images.example/100.png"], ["https://images.example/base.png", null], ["http://127.0.0.1/private"]]) expect(() => parseSeedream55Manifest(payload(urls), true)).toThrow();
  expect(() => parseSeedream55Manifest(payload(hundred.slice(0, 2)), false)).toThrow();
});

test("single submit intent precedes POST; subsequent polls keep original ID and cadence", async () => {
  const events: string[] = [];
  const start = Date.now();
  const base = { ...input, prompt: "", parameters: { layer_decomposition: true }, sourceImages: [image], baseUrl: "https://provider.example/v1", apiKey: "fixture",
    beforeSubmit: () => { events.push("claim"); }, onSubmitted: (id: string) => { events.push(id); } };
  const submitted = await stepApiMartImageTask(base, { fetch: async (_url, init) => { events.push(init!.method!); return Response.json({ data: [{ task_id: "original" }] }); } });
  expect(events).toEqual(["claim", "POST", "original"]); expect(submitted).toMatchObject({ nextPollMs: 3000 });
  for (const [elapsed, interval] of [[10_000, 3000], [45_000, 5000], [130_000, 10000]]) {
    const pending = await stepApiMartImageTask({ ...base, sourceImages: [], upstreamTaskId: "original", submissionStartedAt: new Date(start).toISOString() }, { now: () => start + elapsed!, fetch: async (url, init) => { expect(init?.method).toBe("GET"); expect(url).toEndWith("/tasks/original"); return Response.json({ data: { status: "processing" } }); } });
    expect(pending).toMatchObject({ nextPollMs: interval });
  }
  let replay = 0;
  await expect(stepApiMartImageTask({ ...base, submissionStarted: true }, { fetch: async () => { replay++; return Response.json({}); } })).rejects.toThrow();
  expect(replay).toBe(0);
});
