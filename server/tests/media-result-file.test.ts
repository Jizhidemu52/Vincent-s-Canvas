import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { downloadVideoResult, disposeProviderResults } from "../src/media-result-file";

test("video download streams original byte views to disk without arrayBuffer and cleans all result owners", async () => {
  const source = new Uint8Array([99, 1, 2, 3, 88]);
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(source.subarray(1, 3)); controller.enqueue(source.subarray(3, 4)); controller.close();
  } }), { headers: { "content-type": "application/octet-stream" } });
  response.arrayBuffer = async () => { throw new Error("Full video buffering is forbidden"); };
  const result = await downloadVideoResult("https://fixture.invalid/video", (async (_url, options) => {
    expect(options?.signal).toBeInstanceOf(AbortSignal); return response;
  }));
  try {
    expect(result.mimeType).toBe("video/mp4"); expect(result.byteSize).toBe(3);
    expect(await readFile(result.filePath)).toEqual(Buffer.from([1, 2, 3]));
    const cleanup = await disposeProviderResults([{ bytes: new Uint8Array(), mimeType: "image/png" },
      { ...result, dispose: async () => { throw new Error("one failed cleanup"); } }, result]);
    expect(cleanup.map(item => item.status)).toEqual(["rejected", "fulfilled"]);
    expect(await Bun.file(result.filePath).exists()).toBe(false);
  } finally { await result.dispose(); }
});

test("video HTTP or type rejection cancels the body, stream errors leave no partial file", async () => {
  for (const status of [200, 503]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { "content-type": "text/html" } });
    await expect(downloadVideoResult("https://fixture.invalid/video", async () => response)).rejects.toThrow();
    expect(cancelled).toBe(true);
  }
  const before = (await readdir(tmpdir())).filter(name => name.startsWith("canvas-video-result-"));
  const response = new Response(new ReadableStream({ pull(controller) { controller.error(new Error("fixture download disconnected")); } }, { highWaterMark: 0 }), { headers: { "content-type": "video/mp4" } });
  await expect(downloadVideoResult("https://fixture.invalid/video", async () => response)).rejects.toThrow("fixture download disconnected");
  expect((await readdir(tmpdir())).filter(name => name.startsWith("canvas-video-result-"))).toEqual(before);
});
