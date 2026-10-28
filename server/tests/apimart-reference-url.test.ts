import { expect, test } from "bun:test";
import { normalizeApiMartImageUrl, uploadApiMartImage } from "../src/apimart-upload";
import { buildApiMartImageRequest, stepApiMartImageTask } from "../src/apimart-image";

const input = { baseUrl: "https://provider.example/v1", apiKey: "fixture-key", bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" };
const rawUrl = "https://cdn.example/参考图/% 图片_v2 100%.png?name=原图 100%&sig=a%2Fb%2B%3D&part=1&part=2";
const escapedUrl = "https://cdn.example/%E5%8F%82%E8%80%83%E5%9B%BE/%25%20%E5%9B%BE%E7%89%87_v2%20100%25.png?name=%E5%8E%9F%E5%9B%BE%20100%25&sig=a%2Fb%2B%3D&part=1&part=2";

test("reference URLs escape Unicode, spaces and bare percent without changing existing escapes or signed query order", () => {
  expect(normalizeApiMartImageUrl(rawUrl)).toBe(escapedUrl);
  expect(normalizeApiMartImageUrl(escapedUrl)).toBe(escapedUrl);
  const signed = "https://cdn.example/a%2fb%20c.png?X-Signature=a%2fb%2Bc%3d&x=1&x=2";
  expect(normalizeApiMartImageUrl(signed)).toBe(signed);
  expect(normalizeApiMartImageUrl("http://cdn.example/100%Q1.png")).toBe("http://cdn.example/100%25Q1.png");
});

test.each(["图片_v2.png", "图 片%100#.png", "C:\\素材\\图片_v2.png", "name%22\r\n.png"])("upstream transport filenames are independent of the original name: %s", async filename => {
  const source = { ...input, filename, purpose: "image" as const };
  const url = await uploadApiMartImage(source, { fetch: async (_url, init) => {
    const file = (init!.body as FormData).get("file") as File;
    expect(file.name).toBe("reference.png");
    expect(file.type).toBe(input.mimeType);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(input.bytes);
    return Response.json({ url: rawUrl });
  } });
  expect(url).toBe(escapedUrl);
  expect(source.filename).toBe(filename);
});

test.each(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gemini-nano-banana-2.1", "grok-imagine-image-2.0", "midjourney-blend"])("%s submits normalized uploaded and direct reference URLs exactly once", async modelId => {
  let uploads = 0, submissions = 0, claims = 0;
  const result = await stepApiMartImageTask({
    ...input, modelId, submissionKey: "00000000-0000-4000-8000-000000000001", prompt: "参考图测试", parameters: {},
    sourceImages: [{ bytes: input.bytes, mimeType: input.mimeType, filename: "图片_v2.png" }, rawUrl],
    beforeSubmit: () => { claims++; },
  }, { fetch: async (url, init) => {
    if (url.endsWith("/uploads/images")) {
      uploads++;
      expect(((init!.body as FormData).get("file") as File).name).toBe("reference.png");
      return Response.json({ url: rawUrl });
    }
    submissions++;
    expect(JSON.parse(String(init!.body)).image_urls).toEqual([escapedUrl, escapedUrl]);
    return Response.json({ data: [{ task_id: "single-task" }] });
  } });
  expect(result.status).toBe("pending");
  expect({ uploads, submissions, claims }).toEqual({ uploads: 1, submissions: 1, claims: 1 });
});

test.each(["gpt-image-2", "gemini-3.1-flash-image-preview", "midjourney"])("legacy %s normalizes URL references but keeps inline data unchanged", modelId => {
  const inline = "data:image/png;base64,iVBORw==";
  expect(buildApiMartImageRequest({ modelId, prompt: "reference", parameters: {}, sourceDataUrls: [rawUrl, inline] }).payload.image_urls).toEqual([escapedUrl, inline]);
});

test.each(["https://127.0.0.1/图片.png", "https://user:secret@cdn.example/图片.png", "https://cdn.internal/图片.png", "data:image/png;base64,AA=="])("normalization does not bypass the existing public URL boundary: %s", url => {
  expect(() => normalizeApiMartImageUrl(url)).toThrow();
});

test("invalid upload URLs cannot claim or submit a paid generation", async () => {
  let requests = 0, claims = 0;
  await expect(stepApiMartImageTask({ ...input, modelId: "gpt-image-2.5-sunburst", prompt: "reference", parameters: {},
    sourceImages: [{ bytes: input.bytes, mimeType: input.mimeType }], beforeSubmit: () => { claims++; },
  }, { fetch: async url => { requests++; expect(url).toEndWith("/uploads/images"); return Response.json({ url: "https://private.lan/图片.png" }); } })).rejects.toThrow("公开 HTTPS");
  expect({ requests, claims }).toEqual({ requests: 1, claims: 0 });
});
