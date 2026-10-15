import { expect, test } from "bun:test";
import { buildApiMartImageRequest, runApiMartImageTask } from "../src/apimart-image";
const build = (modelId: string, parameters: Record<string, unknown>) => buildApiMartImageRequest({ modelId, parameters, prompt: "cloth" }).payload;

test("GPT and Gemini expose documented moderation/fallback and search fields", () => {
  expect(build("gpt-image-2", { official_fallback: true, nsfw_check: true })).toMatchObject({ official_fallback: true, nsfw_check: true });
  expect(build("gemini-3.1-flash-image-preview", { google_image_search: true, official_fallback: true })).toMatchObject({ google_search: true, google_image_search: true, official_fallback: true });
  expect(build("gemini-3.1-flash-image-preview-official", { official_fallback: true })).not.toHaveProperty("official_fallback");
});

test("MJ forwards all structured generation fields without confusing speed with quality", () => {
  const parameters = { midjourneySpeed: "fast", midjourneyQuality: "2", version: "7", style: "raw", seed: 0, negative_prompt: "blurry", stylize: 750, chaos: 50, weird: 1000, tile: true, niji: false, iw: 1.5, cw: 100, sw: 700, cref: "https://example.com/c.png", sref: "https://example.com/s.png", dref: "https://example.com/d.png", dw: 42.5, raw: true, draft: true, hd: false, stop: 75, extra: "--test", metadata: { order: "sample" }, nsfw_check: true };
  const { midjourneySpeed, midjourneyQuality, ...forwarded } = parameters;
  expect(build("midjourney", parameters)).toMatchObject({ ...forwarded, speed: "fast", quality: "2" });
});

test("blend keeps own presets and metadata without imagine-only fields", () => {
  const request = buildApiMartImageRequest({ modelId: "midjourney-blend", prompt: "", parameters: { dimensions: "PORTRAIT", metadata: { name: "test" }, nsfw_check: false, seed: 42 }, sourceDataUrls: ["https://example.com/a.png", "https://example.com/b.png"] });
  expect(request.payload).toMatchObject({ dimensions: "PORTRAIT", metadata: { name: "test" }, nsfw_check: false });
  expect(request.payload).not.toHaveProperty("seed"); expect(request.payload).not.toHaveProperty("size");
});

test("invalid fields are rejected before provider submission", () => {
  for (const parameters of [{ seed: -1 }, { chaos: 101 }, { tile: "false" }, { iw: 4 }, { midjourneyQuality: "high" }, { repeat: 41 }, { metadata: [] }]) expect(() => build("midjourney", parameters)).toThrow();
});

test.each([2, 40, 0, -1, 1.5, "2", null])("MJ rejects repeat=%s before any paid submission", async (repeat) => {
  let calls = 0;
  await expect(runApiMartImageTask({ modelId: "midjourney", prompt: "cloth", parameters: { repeat }, baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only" }, {
    sleep: async () => {}, fetch: async () => { calls++; return Response.json({}); },
  })).rejects.toThrow("单次仅允许生成 1 张");
  expect(calls).toBe(0);
});

test.each(["cloth --repeat 2", "cloth --r 40", "cloth --REPEAT=2", "cloth --r\n2", "cloth--r2", "--repeat 1"])("MJ rejects native repeat commands in prompt and extra: %s", async (command) => {
  for (const input of [{ prompt: command, parameters: {} }, { prompt: "cloth", parameters: { extra: command } }]) {
    let calls = 0;
    await expect(runApiMartImageTask({ modelId: "midjourney", ...input, baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only" }, {
      sleep: async () => {}, fetch: async () => { calls++; return Response.json({}); },
    })).rejects.toThrow("单次仅允许生成 1 张");
    expect(calls).toBe(0);
  }
});

test("MJ single generation leaves ordinary repeat wording and raw flags unchanged without forwarding repeat=1", () => {
  const prompt = "a repeating pattern --raw";
  expect(buildApiMartImageRequest({ modelId: "midjourney", prompt, parameters: { repeat: 1, extra: "--raw" } }).payload)
    .toEqual({ prompt, size: "1:1", speed: "relax", extra: "--raw" });
});

test("MJ existing task recovery ignores legacy repeat controls, preserves results and performs only GET", async () => {
  const calls: string[] = [];
  const urls = ["https://images.example/old-one.png", "https://images.example/old-two.png"];
  const results = await runApiMartImageTask({ modelId: "midjourney", prompt: "cloth --repeat 2", parameters: { repeat: 40 }, baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only", upstreamTaskId: "existing", submissionStarted: true }, {
    sleep: async () => {}, fetch: async (url, init) => {
      calls.push(`${init?.method || "GET"} ${url}`);
      return Response.json({ data: { status: "completed", result: { images: [{ url: urls }] } } });
    },
  });
  expect(results).toEqual(urls);
  expect(calls).toEqual(["GET https://fixture.invalid/v1/tasks/existing"]);
});
