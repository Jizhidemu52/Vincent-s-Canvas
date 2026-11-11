import { expect, test } from "bun:test";
import { parseSeedream55Manifest, seedream55PublicDocument } from "../src/seedream55-image";
import { downloadLayerOriginal, hashLayerOriginal, persistLayerOriginals, type SavedLayerOriginal } from "../src/seedream55-storage";
import type { LayerStudioResultDocument } from "../../shared/layer-studio";
import { preflightStoredSeedream55Task } from "../src/stored-seedream55-preflight";
import { readBoundedImage, validateSeedream55Reference } from "../src/seedream55-reference";
import { stepApiMartImageTask } from "../src/apimart-image";

const manifest = parseSeedream55Manifest({ data: { result: { images: [{ url: Array.from({ length: 100 }, (_, i) => `https://images.example/${i}.png`) }] } } }, true);

test("original download preserves bytes, rejects redirects/unsafe hosts and uses no authorization", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8////fwYGBgYWEAHCAD4KBAICIHhuAAAAAElFTkSuQmCC", "base64");
  const original = await downloadLayerOriginal("https://cdn.example.com/layer.png", async (_url, init) => {
    expect(init?.redirect).toBe("error"); expect(init?.headers).toBeUndefined(); return new Response(png);
  });
  expect(original.bytes).toEqual(png); expect(original.sha256).toBe(hashLayerOriginal(png)); expect(original.width).toBe(2);
  await expect(downloadLayerOriginal("https://cdn.example.com/layer.png", async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }))).rejects.toThrow("302");
  for (const url of ["http://127.0.0.1/private", "http://169.254.169.254/metadata", "https://user:secret@cdn.example.com/private"]) {
    await expect(downloadLayerOriginal(url)).rejects.toThrow();
  }
  // Passes the legacy lexical check, but the actual isolated native worker
  // rejects reserved .test without any DNS or HTTP request.
  await expect(downloadLayerOriginal("https://reserved.test/result.png")).rejects.toThrow("安全下载失败");
});

test("100 original layers: fail after partial save, resume same task, verify/reuse hashes and never resubmit", async () => {
  const saved = new Map<number, SavedLayerOriginal>();
  let document: LayerStudioResultDocument | null = null, posts = 0, downloads = 0, inflight = 0, maximumInflight = 0, failAt = 3;
  const submit = { modelId: "seedream-5-5", baseUrl: "https://provider.example/v1", apiKey: "fixture", prompt: "", parameters: { layer_decomposition: true }, sourceImages: [{ bytes: Buffer.from("reference"), mimeType: "image/png" }] };
  await stepApiMartImageTask(submit, { fetch: async (_url, init) => { if (init?.method === "POST") posts++; return Response.json({ data: [{ task_id: "original" }] }); } });
  // Mirrors the durable boundary: private completed manifest is recorded before any download.
  document = seedream55PublicDocument("task", manifest);
  const persist = () => persistLayerOriginals({ taskId: "task", manifest, document,
    findSaved: async index => saved.get(index) ?? null,
    download: async url => {
      expect(document).not.toBeNull(); downloads++; inflight++; maximumInflight = Math.max(maximumInflight, inflight);
      const index = Number(/\/(\d+)\.png$/.exec(url)![1]);
      try { if (index === failAt) throw new Error("injected network failure");
        const bytes = Buffer.from(`exact-provider-original-${index}`);
        return { bytes, mimeType: index === 0 ? "image/jpeg" : "image/png", sha256: hashLayerOriginal(bytes), width: 1200 + index, height: 900 };
      } finally { inflight--; }
    },
    save: async (index, original) => { const item = { ...original, assetId: `asset-${index}`, contentUrl: `/api/assets/asset-${index}/content` }; saved.set(index, item); return item; },
    checkpoint: async next => { document = structuredClone(next); },
  });
  await expect(persist()).rejects.toThrow("injected");
  expect(document!.status).toBe("partial"); expect(saved.size).toBe(3); expect(downloads).toBe(4);
  failAt = -1;
  const result = await persist();
  expect(result.status).toBe("ready"); expect(result.items).toHaveLength(100); expect(downloads).toBe(101); expect(posts).toBe(1); expect(maximumInflight).toBe(1);
  expect(result.items[0]!.mimeType).toBe("image/jpeg"); expect(result.items.slice(1).every(item => item.mimeType === "image/png")).toBe(true);
  expect(saved.get(1)!.bytes).toEqual(Buffer.from("exact-provider-original-1"));
  await persist(); expect(downloads).toBe(101); expect(posts).toBe(1);
  saved.get(2)!.bytes = Buffer.from("tampered");
  await expect(persist()).rejects.toThrow("hash"); expect(posts).toBe(1); expect(downloads).toBe(101);
});

test("a saved document with missing original refuses silent download/overwrite", async () => {
  const one = { ...manifest, items: manifest.items.slice(0, 1) };
  const document = seedream55PublicDocument("task", one); document.items[0]!.state = "saved";
  let downloads = 0;
  await expect(persistLayerOriginals({ taskId: "task", manifest: one, document,
    findSaved: async () => null, download: async () => { downloads++; throw new Error(); }, save: async () => { throw new Error(); }, checkpoint: async () => {},
  })).rejects.toThrow("缺失"); expect(downloads).toBe(0);
});

test("source ownership is checked for every reference before reading bytes, and external URLs are rejected", async () => {
  const id = "11111111-1111-4111-8111-111111111111", queries: unknown[][] = [];
  let reads = 0;
  const db = { query: async (_sql: string, values: unknown[]) => { queries.push(values); return { rows: values[1] === "alice" ? [{ id, objectKey: "users/alice/original", mimeType: "image/png", byteSize: 3, sha256: null }] : [] }; } };
  const input = { userId: "bob", prompt: "", parameters: { layer_decomposition: true }, sourceUrls: [`/api/assets/${id}/content`] };
  const runtime = { readSource: async () => { reads++; return new Uint8Array(3); }, validate: async () => ({ width: 1, height: 1, mimeType: "image/png" }) };
  await expect(preflightStoredSeedream55Task(db as never, input, runtime)).rejects.toThrow("无权"); expect(reads).toBe(0); expect(queries[0]).toEqual([id, "bob"]);
  expect(await preflightStoredSeedream55Task(db as never, { ...input, userId: "alice" }, runtime)).toHaveLength(1); expect(reads).toBe(1);
  await expect(preflightStoredSeedream55Task(db as never, { ...input, sourceUrls: ["https://private.example/image.png"] }, runtime)).rejects.toThrow(); expect(reads).toBe(1);
});

test("bounded original reads reject oversized and truncated objects", async () => {
  const stream = () => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); controller.close(); } });
  await expect(readBoundedImage(stream(), 5)).rejects.toThrow("上限");
  await expect(readBoundedImage(stream(), 10, 7)).rejects.toThrow("不一致");
  expect((await readBoundedImage(stream(), 10, 6)).length).toBe(6);
});

test("true MIME/actual dimensions preflight rejects disguised and corrupt originals", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8////fwYGBgYWEAHCAD4KBAICIHhuAAAAAElFTkSuQmCC", "base64");
  expect(await validateSeedream55Reference({ bytes: png, mimeType: "image/png" })).toEqual({ width: 2, height: 2, mimeType: "image/png" });
  await expect(validateSeedream55Reference({ bytes: png, mimeType: "image/jpeg" })).rejects.toThrow("不一致");
  await expect(validateSeedream55Reference({ bytes: Buffer.from("bad"), mimeType: "image/png" })).rejects.toThrow();
});
