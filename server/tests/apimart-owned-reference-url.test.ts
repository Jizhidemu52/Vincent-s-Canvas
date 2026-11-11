import { describe, expect, test } from "bun:test";
import { apiMartImageModel, preflightApiMartImageRequest, stepApiMartImageTask, type ApiMartImageInput } from "../src/apimart-image";

const base = { baseUrl: "https://provider.example/v1", apiKey: "fixture-only", prompt: "Keep the original product", parameters: {},
  submissionKey: "00000000-0000-4000-8000-000000000001" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8////fwYGBgYWEAHCAD4KBAICIHhuAAAAAElFTkSuQmCC", "base64");
const source = { bytes: png, mimeType: "image/png", filename: "original.png" };
const ownedUrls = (scheme: "http" | "https") => ["a", "b"].map(token => `${scheme}://owned.example/api/provider-images/${token.repeat(64)}/image`);
const resultUrl = "https://results.example/completed.png";

// Keep aliases explicit: matching one canonical ID does not prove every routed ID.
const modelCases = [
  ["seedream-5-5", "seedream-5-5", "seedream-5-5", "/images/generations"],
  ["gpt-image-2", "gpt-image-2", "gpt-image-2", "/images/generations"],
  ["gpt-image-2-ext", "gpt-image-2", "gpt-image-2", "/images/generations"],
  ["vcen-gpt2", "gpt-image-2", "gpt-image-2", "/images/generations"],
  ["gemini-3.1-flash-image-preview", "gemini-3.1-flash-image-preview", "gemini-3.1-flash-image-preview", "/images/generations"],
  ["gemini-3.1-flash-image-preview-official", "gemini-3.1-flash-image-preview", "gemini-3.1-flash-image-preview-official", "/images/generations"],
  ["nano-banana-2-ext", "gemini-3.1-flash-image-preview", "gemini-3.1-flash-image-preview", "/images/generations"],
  ["nano-banana-2", "gemini-3.1-flash-image-preview", "gemini-3.1-flash-image-preview-official", "/images/generations"],
  ["gpt-image-2.5-flare", "gpt-image-2.5-flare", "gpt-image-2.5-flare", "/images/generations"],
  ["gpt-image-2.5-sunburst", "gpt-image-2.5-sunburst", "gpt-image-2.5-sunburst", "/images/generations"],
  ["gpt-image-2.6-flare", "gpt-image-2.6-flare", "gpt-image-2.6-flare", "/images/generations"],
  ["gpt-image-2.6-sunburst", "gpt-image-2.6-sunburst", "gpt-image-2.6-sunburst", "/images/generations"],
  ["gemini-nano-banana-2.1", "gemini-nano-banana-2.1", "gemini-nano-banana-2.1", "/images/generations"],
  ["mai-image-2.6-flash", "mai-image-2.6-flash", "mai-image-2.6-flash", "/images/generations"],
  ["grok-imagine-image-2.0", "grok-imagine-image-2.0", "grok-imagine-image-2.0", "/images/generations"],
  ["midjourney", "midjourney", undefined, "/midjourney/generations"],
  ["midjourney-v7", "midjourney", undefined, "/midjourney/generations"],
  ["midjourney-blend", "midjourney-blend", undefined, "/midjourney/generations/blend"],
] as const;

async function submit(input: ApiMartImageInput, path = "/images/generations") {
  const events: string[] = [];
  let payload: Record<string, unknown> | undefined;
  const result = await stepApiMartImageTask({ ...base, ...input,
    beforeSubmit: () => { events.push("claim"); },
    onSubmitted: id => { events.push(`receipt:${id}`); },
  }, { fetch: async (url, init) => {
    // Any upload, source download, premature poll or second POST fails this mock.
    expect(url).toBe(`${base.baseUrl}${path}`);
    expect(init?.method).toBe("POST");
    events.push("submit");
    payload = JSON.parse(String(init?.body));
    return Response.json({ data: [{ task_id: "owned-url-task" }] });
  } });
  expect(result).toMatchObject({ status: "pending", upstreamTaskId: "owned-url-task" });
  expect(events).toEqual(["claim", "submit", "receipt:owned-url-task"]);
  expect(payload).toBeDefined();
  return payload!;
}

describe.each(modelCases)("owned-reference adapter: %s", (modelId, kind, wireModel, path) => {
  test("preflights original bytes, then submits owned HTTP/HTTPS URLs unchanged without supplier upload", async () => {
    expect(apiMartImageModel(modelId)).toBe(kind);
    expect(preflightApiMartImageRequest({ ...base, modelId, sourceImages: [source, source] }).path).toBe(path);
    for (const field of ["sourceImages", "sourceDataUrls"] as const) {
      const urls = ownedUrls(field === "sourceImages" ? "http" : "https");
      const expectedUrls = [...urls];
      const input: ApiMartImageInput = { ...base, modelId, [field]: urls };
      const preflight = preflightApiMartImageRequest(input);
      expect(preflight.payload.image_urls).toEqual(expectedUrls);
      const payload = await submit(input, path);
      expect(payload.model).toBe(wireModel);
      expect(payload.image_urls).toEqual(expectedUrls);
      expect(payload).not.toHaveProperty("mask_url");
      expect(input[field]).toEqual(expectedUrls);
    }
  });

  test("saved task polling never reads references or masks and never uploads or submits", async () => {
    const input = { ...base, modelId, prompt: "", parameters: { n: 2, resolution: "invalid" },
      upstreamTaskId: "saved/task + id", submissionStarted: true,
      beforeSubmit: () => { throw new Error("poll must not claim a submission"); },
      onSubmitted: () => { throw new Error("poll must not persist a new receipt"); },
    };
    for (const field of ["sourceImages", "sourceDataUrls", "maskImage", "maskDataUrl"]) {
      Object.defineProperty(input, field, { get: () => { throw new Error(`poll must not read ${field}`); } });
    }
    const calls: string[] = [];
    const result = await stepApiMartImageTask(input, { fetch: async (url, init) => {
      calls.push(`${init?.method || "GET"} ${url}`);
      expect(init?.body).toBeUndefined();
      return Response.json({ data: { status: "completed", result: { images: [{ url: [resultUrl] }] } } });
    } });
    expect(calls).toEqual([`GET ${base.baseUrl}/tasks/saved%2Ftask%20%2B%20id`]);
    expect(result).toMatchObject({ status: "completed", upstreamTaskId: input.upstreamTaskId, urls: [resultUrl] });
  });
});

const maskModels = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"];

test.each(maskModels)("%s keeps PNG masks inline and separate from the owned reference URLs", async modelId => {
  const padded = Buffer.concat([Buffer.from([99]), png, Buffer.from([88])]);
  const maskImage = { bytes: padded.subarray(1, padded.length - 1), mimeType: "image/png" };
  const maskDataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const urls = ownedUrls("http");
  for (const mask of [{ maskImage }, { maskDataUrl }]) {
    const input = { ...base, modelId, sourceImages: urls, ...mask };
    expect(preflightApiMartImageRequest(input).payload.mask_url).toBe(maskDataUrl);
    const payload = await submit(input);
    expect(payload.image_urls).toEqual(urls);
    expect(payload.mask_url).toBe(maskDataUrl);
    expect(payload.model).toBe(modelId);
  }
});

test.each(["gemini-nano-banana-2.1", "mai-image-2.6-flash", "grok-imagine-image-2.0", "midjourney-blend", "seedream-5-5"])("%s still rejects an independent mask before any request", async modelId => {
  let calls = 0, claims = 0;
  const input = { ...base, modelId, sourceImages: ownedUrls("http"), maskImage: source,
    beforeSubmit: () => { claims++; },
  };
  expect(() => preflightApiMartImageRequest(input)).toThrow("蒙版");
  await expect(stepApiMartImageTask(input, { fetch: async () => { calls++; return Response.json({}); } })).rejects.toThrow("蒙版");
  expect({ calls, claims }).toEqual({ calls: 0, claims: 0 });
});

test.each(maskModels)("%s retains mask validation after references become owned URLs", async modelId => {
  const invalid: Array<Partial<ApiMartImageInput>> = [
    { maskDataUrl: ownedUrls("http")[0] },
    { maskImage: { bytes: png, mimeType: "image/jpeg" } },
    { maskImage: { bytes: new Uint8Array(4 * 1024 * 1024), mimeType: "image/png" } },
    { sourceImages: [], maskImage: source },
  ];
  for (const extra of invalid) {
    let calls = 0, claims = 0;
    const input = { ...base, modelId, sourceImages: ownedUrls("http"), ...extra,
      beforeSubmit: () => { claims++; },
    };
    expect(() => preflightApiMartImageRequest(input)).toThrow();
    await expect(stepApiMartImageTask(input, { fetch: async () => { calls++; return Response.json({}); } })).rejects.toThrow();
    expect({ calls, claims }).toEqual({ calls: 0, claims: 0 });
  }
});
