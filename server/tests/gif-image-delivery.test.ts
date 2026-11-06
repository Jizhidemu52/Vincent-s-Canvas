import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createAssetThumbnailBytes } from "../src/asset-thumbnails";
import { inspectGifFrames } from "../src/gif-image";
import { providerImageMimeType } from "../src/provider-image-result";
import { imageResultExtension, ImageResultPersistenceError, storeImageResult } from "../src/image-result-storage";
import { readImageResultMetadata } from "../src/image-result-variants";

function ffmpeg(args: string[]) {
  return new Promise<Buffer>((resolve, reject) => execFile(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", ...args],
    { windowsHide: true, encoding: "buffer", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function chunks(bytes: Buffer) {
  const names: string[] = [];
  for (let index = 12; index + 8 <= bytes.length;) {
    names.push(bytes.toString("ascii", index, index + 4));
    const size = bytes.readUInt32LE(index + 4);
    index += 8 + size + size % 2;
  }
  return names;
}
const animated = await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=512x512:rate=5", "-frames:v", "9", "-f", "gif", "pipe:1"]);

test("real animated GIF is sniffed, archived and downloaded byte-identically without a static converter", async () => {
  const before = sha(animated), calls: string[] = [];
  const original = { assetId: crypto.randomUUID(), mimeType: "image/gif", filename: "result.gif" };
  expect(providerImageMimeType(animated, "image/png")).toBe("image/gif");
  expect(imageResultExtension("image/gif")).toBe("gif");
  expect(await inspectGifFrames(animated)).toMatchObject({ width: 512, height: 512, frames: 9 });
  const result = await storeImageResult({ result: { bytes: animated, mimeType: "image/gif" }, parameters: { output_format: "gif" }, resultIndex: 0,
    process: async () => { throw new Error("GIF must never enter static FFmpeg conversion"); },
    prepareEditInput: async () => { throw new Error("GIF must not load edit references"); },
    save: async (role, image) => { calls.push(role); expect(sha(image.bytes)).toBe(before); expect(image.bytes).toBe(animated); return original; },
    updateMetadata: async (_asset, metadata) => {
      calls.push("metadata"); expect(metadata.imageResult).toMatchObject({ role: "primary", animated: true, frameCount: 9, requestedOutputFormat: "gif" });
      expect(readImageResultMetadata(metadata)).toMatchObject({ original, maskComposited: false });
    },
  });
  expect(result).toBe(original);
  expect(calls).toEqual(["provider-original", "metadata"]);
  expect(sha(animated)).toBe(before);
});

test("GIF thumbnail endpoints return bounded animated WebP rather than a first frame or original GIF", async () => {
  const before = sha(animated);
  const thumbs = await createAssetThumbnailBytes(animated);
  for (const edge of [256, 1024] as const) {
    expect(thumbs[edge].toString("ascii", 0, 4)).toBe("RIFF");
    expect(thumbs[edge].toString("ascii", 8, 12)).toBe("WEBP");
    expect(chunks(thumbs[edge])).toContain("ANIM");
    expect(chunks(thumbs[edge]).filter(value => value === "ANMF")).toHaveLength(9);
    expect(thumbs[edge].length).toBeLessThan(8 * 1024 * 1024);
    expect(sha(thumbs[edge])).not.toBe(before);
  }
  expect(sha(animated)).toBe(before);
}, 40_000);

test("static PNG and JPEG thumbnails remain static WebP", async () => {
  for (const codec of ["png", "mjpeg"]) {
    const source = await ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=320x240", "-frames:v", "1", "-c:v", codec, "-f", "image2pipe", "pipe:1"]);
    const before = sha(source), thumbnails = await createAssetThumbnailBytes(source, [256]);
    expect(chunks(thumbnails[256])).not.toContain("ANIM");
    expect(chunks(thumbnails[256])).not.toContain("ANMF");
    expect(sha(source)).toBe(before);
  }
}, 40_000);

test("long frame delays do not truncate a valid short-frame-count animation preview", async () => {
  const slow = await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=1/5", "-frames:v", "9", "-f", "gif", "pipe:1"]);
  const thumbnails = await createAssetThumbnailBytes(slow, [256]);
  expect(chunks(thumbnails[256]).filter(value => value === "ANMF")).toHaveLength(9);
});

test("an incomplete GIF retains its provider original and pauses without paid replay", async () => {
  const incomplete = animated.subarray(0, animated.length - 1), calls: string[] = [];
  const error = await storeImageResult({ result: { bytes: incomplete, mimeType: "image/gif" }, parameters: { output_format: "gif" }, resultIndex: 0,
    save: async (role, image) => { calls.push(role); expect(image.bytes).toBe(incomplete); return { assetId: "recoverable", mimeType: "image/gif", filename: "original.gif" }; },
    updateMetadata: async () => { calls.push("metadata"); },
  }).catch(error => error);
  expect(error).toBeInstanceOf(ImageResultPersistenceError);
  expect(calls).toEqual(["provider-original"]);
});

test("a valid GIF with the wrong requested frame count is preserved but not reported as complete", async () => {
  const calls: string[] = [];
  await expect(storeImageResult({ result: { bytes: animated, mimeType: "image/gif" }, parameters: { output_format: "gif", frame_count: 8 }, resultIndex: 0,
    save: async role => { calls.push(role); return { assetId: "recoverable", mimeType: "image/gif", filename: "original.gif" }; },
    updateMetadata: async () => { calls.push("metadata"); },
  })).rejects.toBeInstanceOf(ImageResultPersistenceError);
  expect(calls).toEqual(["provider-original"]);
});

test("structurally framed but corrupt GIF compressed pixels are rejected by the real decoder", async () => {
  const broken = Buffer.from(animated);
  let index = 13 + (broken[10]! & 0x80 ? 3 * 2 ** ((broken[10]! & 7) + 1) : 0);
  while (broken[index] === 0x21) {
    index += 2;
    while (broken[index]) index += broken[index]! + 1;
    index++;
  }
  expect(broken[index]).toBe(0x2c);
  const flags = broken[index + 9]!;
  index += 10 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0) + 1;
  const blockSize = broken[index]!;
  expect(blockSize).toBeGreaterThan(2);
  broken[index - 1] = 12; // Invalid LZW code width; all image/extension block lengths remain intact.
  while (broken[index]) {
    const size = broken[index]!;
    broken.fill(0xff, index + 1, index + 1 + size);
    index += 1 + size;
  }
  expect(broken.at(-1)).toBe(0x3b);
  await expect(inspectGifFrames(broken)).rejects.toThrow("有效帧");
});
