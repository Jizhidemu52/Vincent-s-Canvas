import { describe, expect, spyOn, test } from "bun:test";
import { fetchProviderResult, fetchProviderMediaResult, MAX_PROVIDER_IMAGE_BYTES, MAX_PROVIDER_MEDIA_BYTES } from "../src/provider-result";
import { createGenerationTiming } from "../src/generation-timing";
import type { PublicResourceOptions } from "../src/public-resource";
import { PublicResourceError } from "../src/public-resource";
import { imageTaskFailureDetail } from "../src/image-task-diagnostics";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0VQAAAABJRU5ErkJggg==";

describe("provider result materialization", () => {
  test.each([403, 404, 410, 503])("remote HTTP %i remains available for original-result recovery without signed URL leakage", async status => {
    const download = async () => { throw new PublicResourceError(502, "REMOTE_HTTP_ERROR", "fixture remote rejection", status); };
    for (const operation of [fetchProviderResult, fetchProviderMediaResult]) {
      const error = await operation("https://cdn.example/image?signature=secret", undefined, download).catch(error => error);
      expect(imageTaskFailureDetail(error, "download")).toEqual({ phase: "download", code: "RESULT_DOWNLOAD_HTTP_ERROR", httpStatus: status });
      expect(error.message).not.toContain("secret");
      expect(error.message).not.toContain("cdn.example");
    }
  });

  test.each([png, `data:image/png;base64,${png}`])("inline images are decoded without network or download timing", async value => {
    const records: Record<string, unknown>[] = [];
    const log = spyOn(console, "log").mockImplementation(line => { records.push(JSON.parse(line)); });
    const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => { throw new Error("unexpected download"); }, { preconnect() {} }));
    try {
      const result = await fetchProviderResult(value, createGenerationTiming({ taskId: "inline-result", runtime: "worker" }));
      expect(result.mimeType).toBe("image/png");
      expect(result.bytes).toEqual(Buffer.from(png, "base64"));
      expect(network).not.toHaveBeenCalled();
      expect(records).toEqual([]);
    } finally { log.mockRestore(); network.mockRestore(); }
  });

  test("remote timing ends only after the complete original response body is read", async () => {
    const records: Record<string, unknown>[] = [];
    const log = spyOn(console, "log").mockImplementation(line => { records.push(JSON.parse(line)); });
    let finish!: (value: { bytes: Buffer; mime: string; finalUrl: string }) => void;
    const response = new Promise<{ bytes: Buffer; mime: string; finalUrl: string }>(resolve => { finish = resolve; });
    const calls: PublicResourceOptions[] = [];
    const download = async (_url: string, options: PublicResourceOptions) => { calls.push(options); return response; };
    try {
      const pending = fetchProviderResult("https://provider.example/image.webp", createGenerationTiming({ taskId: "remote-result", runtime: "worker" }), download);
      await Promise.resolve();
      expect(records.map(record => record.phase)).toEqual(["start"]);
      finish({ bytes: Buffer.from(png, "base64"), mime: "image/webp", finalUrl: "https://provider.example/image.webp" });
      expect(await pending).toEqual({ bytes: Buffer.from(png, "base64"), mimeType: "image/png" });
      expect(records.map(record => [record.stage, record.phase, record.status])).toEqual([["result_download", "start", undefined], ["result_download", "end", "success"]]);
      expect(calls).toEqual([{ kind: "provider-image", maxBytes: MAX_PROVIDER_IMAGE_BYTES, timeoutMs: 60_000 }]);
    } finally { log.mockRestore(); }
  });

  test("invalid inline images fail locally, without a download or resubmission", async () => {
    const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => { throw new Error("unexpected download"); }, { preconnect() {} }));
    try {
      await expect(fetchProviderResult("data:image/png;base64,INVALID")).rejects.toThrow("Provider 返回了无法识别的内联图片");
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  test("result downloads reject private and metadata addresses before any socket is opened", async () => {
    for (const url of ["http://127.0.0.1/image.png", "http://169.254.169.254/latest/meta-data", "http://10.0.0.1/video.mp4", "https://name:secret@example.com/result"]) {
      await expect(fetchProviderResult(url)).rejects.toMatchObject({ code: expect.stringMatching(/^UNSAFE_/) });
      await expect(fetchProviderMediaResult(url)).rejects.toMatchObject({ code: expect.stringMatching(/^UNSAFE_/) });
    }
  });

  test("unrecognized image bytes cannot be stored just because a header says image/png", async () => {
    await expect(fetchProviderResult("https://provider.example/output", undefined, async url => ({ bytes: Buffer.from("<html>private response</html>"), mime: "image/png", finalUrl: url }))).rejects.toMatchObject({ code: "UNSUPPORTED_TYPE" });
  });

  test("video and audio use the same pinned downloader with an explicit byte and time bound", async () => {
    const calls: PublicResourceOptions[] = [];
    const bytes = Buffer.from("media fixture");
    const result = await fetchProviderMediaResult("https://provider.example/movie.mp4", undefined, async (url, options) => {
      calls.push(options);
      return { bytes, mime: "video/mp4", finalUrl: url };
    });
    expect(result).toEqual({ bytes, mimeType: "video/mp4" });
    expect(calls).toEqual([{ kind: "provider-media", maxBytes: MAX_PROVIDER_MEDIA_BYTES, timeoutMs: 180_000 }]);
  });
});
