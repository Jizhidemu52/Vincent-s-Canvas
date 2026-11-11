import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateSeedream55Reference } from "../src/seedream55-reference";
import { validateAssetUpload } from "../src/asset-delivery";
import { hashAssetContent } from "../src/asset-content-hash";
import { loadView } from "exifreader";

const exec = promisify(execFile);
test.each([
  ["image/png", "png"], ["image/jpeg", "mjpeg"], ["image/webp", "libwebp"],
  ["image/bmp", "bmp"], ["image/tiff", "tiff"], ["image/gif", "gif"],
])("original %s is accepted through upload + actual-dimension preflight without conversion", async (mimeType, codec) => {
  const { stdout } = await exec(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x32", "-frames:v", "1", "-c:v", codec!, "-threads", "1", "-f", "image2pipe", "pipe:1"], { encoding: "buffer", windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 });
  const before = hashAssetContent(stdout);
  expect(await validateAssetUpload(stdout, mimeType!)).toBe(mimeType);
  expect(await validateSeedream55Reference({ bytes: stdout, mimeType: mimeType! })).toEqual({ width: 64, height: 32, mimeType });
  expect(hashAssetContent(stdout)).toBe(before);
}, 25_000);

test("HEIC and generic-brand HEIF read primary dimensions with preserved original payload", async () => {
  const heic = Buffer.from(await Bun.file(new URL("./fixtures/seedream55-reference.heic", import.meta.url)).arrayBuffer());
  const originalHash = "4ea589f9728e7e3c08060473ffde0189719a1810550571de693d743e1bf86292";
  expect(hashAssetContent(heic)).toBe(originalHash);
  expect(await validateAssetUpload(heic, "image/heic")).toBe("image/heic");
  const previousFfmpeg = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = "no-ffmpeg-needed-for-heif";
  try {
    expect(await validateSeedream55Reference({ bytes: heic, mimeType: "image/heic" })).toEqual({ width: 3024, height: 4032, mimeType: "image/heic" });
    const heif = Buffer.from(heic); heif.write("mif1", 8, "ascii");
    expect(await validateAssetUpload(heif, "image/heif")).toBe("image/heif");
    expect(await validateSeedream55Reference({ bytes: heif, mimeType: "image/heif" })).toEqual({ width: 3024, height: 4032, mimeType: "image/heif" });
    expect(heif.subarray(12)).toEqual(heic.subarray(12)); expect(hashAssetContent(heic)).toBe(originalHash);
  } finally {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
  }
});

test("HEIC metadata without a decodable image payload is rejected before provider submission", async () => {
  const bytes = Buffer.from(await Bun.file(new URL("./fixtures/seedream55-reference.heic", import.meta.url)).arrayBuffer());
  const mdat = bytes.indexOf("mdat"); expect(mdat).toBeGreaterThan(0);
  bytes.fill(0, mdat + 4);
  const tags = loadView(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), { expanded: true, includeTags: { file: ["Image Width", "Image Height"] } });
  expect(tags.file?.["Image Width"]?.value).toBe(4032); expect(tags.file?.["Image Height"]?.value).toBe(3024);
  await expect(validateAssetUpload(bytes, "image/heic")).rejects.toThrow("无法解码");
  await expect(validateSeedream55Reference({ bytes, mimeType: "image/heic" })).rejects.toThrow("无法解码");
});

test("real over-36MP input and over-30MiB bytes are rejected before submission", async () => {
  const { stdout } = await exec(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=7000x6000", "-frames:v", "1", "-c:v", "png", "-threads", "1", "-f", "image2pipe", "pipe:1"], { encoding: "buffer", windowsHide: true, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  await expect(validateSeedream55Reference({ bytes: stdout, mimeType: "image/png" })).rejects.toThrow("3600 万");
  await expect(validateSeedream55Reference({ bytes: new Uint8Array(30 * 1024 * 1024 + 1), mimeType: "image/png" })).rejects.toThrow("30 MiB");
}, 25_000);
