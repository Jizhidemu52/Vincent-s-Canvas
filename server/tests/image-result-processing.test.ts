import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { createRequire } from "node:module";
import ts from "typescript";
import { processImageResult, ImageResultProcessingError } from "../src/image-result-processing";
import { hasNonIdentityImageOrientation, prepareImageEditInput } from "../src/image-edit-input";

const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
function codec(args: string[], input: Uint8Array) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
    input, encoding: "buffer", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(String(result.error || result.stderr));
  return result.stdout;
}
function png(rgba: number[] | Uint8Array, width = 4, height = 1, pixelFormat = "rgba") {
  return { mimeType: "image/png", bytes: codec([
    "-f", "rawvideo", "-pixel_format", pixelFormat, "-video_size", `${width}x${height}`, "-i", "pipe:0",
    "-frames:v", "1", "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1",
  ], Uint8Array.from(rgba)) };
}
function rgba(image: { bytes: Uint8Array }) {
  return codec(["-i", "pipe:0", "-frames:v", "1", "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], image.bytes);
}
// Fixed 4x1 RGBA inputs avoid launching synchronous subprocesses while Bun loads
// this module after the HTTP suites. Actual decode/encode work still runs below.
const original = { mimeType: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAGklEQVR4nGPkEpH77+ziyrhl1YL/x/8lOgIAM2oHblsijkgAAAAASUVORK5CYII=", "base64") };
const generated = { mimeType: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAGklEQVR4nGP89eHZfzZBGYYof5eTyyrkfgAASSYH7r6GSqYAAAAASUVORK5CYII=", "base64") };
const mask = { mimeType: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAGklEQVR4nGNkYGD4////f4bUlGTGOXPnNQAAPDIHgiSEJS4AAAAASUVORK5CYII=", "base64") };
const editInput = { references: [original], mask };
const expectedComposite = [10, 20, 30, 255, 77, 88, 99, 0, 90, 80, 70, 200, 100, 100, 100, 128];

// Generated once with Pillow Image.Exif()[274]; tests need only the deployed FFmpeg tools.
const orientedFixtures = [
  { mimeType: "image/jpeg", orientation: 1, base64: "/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAEAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCIBQiX/9k=" },
  { mimeType: "image/jpeg", orientation: 2, base64: "/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAIAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCIBQiX/9k=" },
  { mimeType: "image/jpeg", orientation: 3, base64: "/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAMAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCIBQiX/9k=" },
  { mimeType: "image/jpeg", orientation: 4, base64: "/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAQAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCIBQiX/9k=" },
  { mimeType: "image/jpeg", orientation: 5, base64: "/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAUAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCIBQiX/9k=" },
  { mimeType: "image/jpeg", orientation: 6, base64: "/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCIBQiX/9k=" },
  { mimeType: "image/jpeg", orientation: 7, base64: "/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAcAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCIBQiX/9k=" },
  { mimeType: "image/jpeg", orientation: 8, base64: "/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAgAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCIBQiX/9k=" },
  { mimeType: "image/png", orientation: 1, base64: "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAGmVYSWZNTQAqAAAACAABARIAAwAAAAEAAQAAAAAAABPAdecAAAATSURBVHjaYwyo2NLAgASYGNAAAD6CAgCYDl/zAAAAAElFTkSuQmCC" },
  { mimeType: "image/png", orientation: 4, base64: "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAGmVYSWZNTQAqAAAACAABARIAAwAAAAEABAAAAAAAAEH4WkAAAAATSURBVHjaYwyo2NLAgASYGNAAAD6CAgCYDl/zAAAAAElFTkSuQmCC" },
  { mimeType: "image/webp", orientation: 6, base64: "UklGRmoAAABXRUJQVlA4WAoAAAAIAAAAAwAAAQAAVlA4ICoAAACQAQCdASoEAAIAAUAmJaACdLoAA5gA/uUK//jePRD3lbef8W0joVGgAABFWElGGgAAAE1NACoAAAAIAAEBEgADAAAAAQAGAAAAAAAA" },
].map(({ base64, ...metadata }) => ({ ...metadata, bytes: Buffer.from(base64, "base64") }));

describe("local image result processing", () => {
  test("reads original EXIF when ffprobe omits direction, including a bounded buffer view", () => {
    // FFmpeg 6.1 returns exactly these empty objects for PNG eXIf orientation.
    const silentProbe = { frames: [{}], streams: [{}] };
    for (const fixture of orientedFixtures) {
      expect(hasNonIdentityImageOrientation(silentProbe, fixture.bytes)).toBe(fixture.orientation !== 1);
      const padded = Buffer.concat([Buffer.alloc(17, 0xff), fixture.bytes, Buffer.alloc(13, 0xff)]);
      expect(hasNonIdentityImageOrientation(silentProbe, padded.subarray(17, 17 + fixture.bytes.length))).toBe(fixture.orientation !== 1);
    }
    expect(hasNonIdentityImageOrientation(silentProbe, original.bytes)).toBe(false);
    expect(hasNonIdentityImageOrientation(silentProbe, new Uint8Array([1, 2, 3]))).toBe(true);
    // Byte-level identity must not hide a decoder-reported transform.
    expect(hasNonIdentityImageOrientation({ frames: [{ side_data_list: [{ rotation: 180 }] }] }, original.bytes)).toBe(true);
  });

  test("fixed inputs retain exact RGBA values, including transparent colors and feathered alpha", () => {
    expect([...rgba(original)]).toEqual([10, 20, 30, 255, 77, 88, 99, 0, 1, 2, 3, 255, 200, 0, 100, 64]);
    expect([...rgba(generated)]).toEqual([250, 240, 230, 255, 0, 1, 2, 255, 90, 80, 70, 200, 0, 200, 100, 192]);
    expect([...rgba(mask)]).toEqual([0, 0, 0, 255, 255, 255, 255, 255, 100, 99, 98, 0, 0, 0, 0, 128]);
  });

  test("does not re-encode, copy or mutate unrequested results", async () => {
    const before = Buffer.from(generated.bytes);
    const output = await processImageResult({ result: generated, parameters: {} });
    expect(output.display.bytes).toBe(generated.bytes);
    expect(output.display.mimeType).toBe("image/png");
    expect(output.export).toBeUndefined();
    expect(output.operations).toEqual([]);
    expect(generated.bytes).toEqual(before);
  });

  test("matching actual format with no compression keeps even a 16-bit PNG byte-identical", async () => {
    const highBit = png(new Uint8Array(32).fill(128), 4, 1, "rgba64be");
    const output = await processImageResult({ result: highBit, parameters: { output_format: "png" } });
    expect(output.display.bytes).toBe(highBit.bytes);
    expect(output.operations).toEqual([]);
  });

  test("keeps every protected RGBA byte, copies editable pixels and weights feathered pixels", async () => {
    const originalBefore = Buffer.from(original.bytes);
    const generatedBefore = Buffer.from(generated.bytes);
    const maskBefore = Buffer.from(mask.bytes);
    const output = await processImageResult({ result: generated, parameters: {}, editInput });
    expect(output.display.mimeType).toBe("image/png");
    expect([...rgba(output.display)]).toEqual(expectedComposite);
    expect(output.export).toBeUndefined();
    expect(output.operations).toContain("strict_mask_composite");
    expect(original.bytes).toEqual(originalBefore);
    expect(generated.bytes).toEqual(generatedBefore);
    expect(mask.bytes).toEqual(maskBefore);
  });

  test("uses the first reference only and cannot let another reference replace the original", async () => {
    const unrelated = png([255, 255, 255, 255], 1, 1);
    const output = await processImageResult({ result: generated, parameters: {}, editInput: { references: [original, unrelated], mask } });
    expect([...rgba(output.display)]).toEqual(expectedComposite);
  });

  for (const format of ["jpeg", "webp"] as const) {
    test(`actually encodes requested ${format} while preserving the provider bytes`, async () => {
      const before = Buffer.from(generated.bytes);
      const output = await processImageResult({ result: generated, parameters: { output_format: format, output_compression: 83 } });
      expect(output.display.mimeType).toBe(`image/${format}`);
      if (format === "jpeg") expect([...output.display.bytes.slice(0, 3)]).toEqual([255, 216, 255]);
      else expect(Buffer.from(output.display.bytes).toString("ascii", 8, 12)).toBe("WEBP");
      expect(rgba(output.display)).toHaveLength(16);
      expect(output.operations).toContain("compression_applied");
      expect(output.export).toBeUndefined();
      expect(generated.bytes).toEqual(before);
      const alreadyEncoded = await processImageResult({ result: output.display, parameters: { output_format: format } });
      expect(alreadyEncoded.display.bytes).toBe(output.display.bytes);
      expect(alreadyEncoded.operations).toEqual([]);
    });

    test(`keeps strict PNG display separate from lossy ${format} export`, async () => {
      const output = await processImageResult({ result: generated, parameters: { output_format: format, output_compression: 75 }, editInput });
      expect(output.display.mimeType).toBe("image/png");
      expect([...rgba(output.display)]).toEqual(expectedComposite);
      expect(output.export?.mimeType).toBe(`image/${format}`);
      expect(output.operations).toContain("strict_mask_composite");
      expect(output.operations).toContain("lossy_export_not_pixel_exact");
    });
  }

  test("JPEG flattens real transparency to white and records that operation", async () => {
    const transparent = png(Array.from({ length: 16 }, (_, i) => i % 4 === 3 ? 0 : 17), 2, 2);
    const output = await processImageResult({ result: transparent, parameters: { output_format: "jpeg", output_compression: 100 } });
    expect([...rgba(output.display)]).toEqual(Array(16).fill(255));
    expect(output.operations).toContain("jpeg_alpha_flattened_white");
  });

  test("explicit PNG preserves decoded RGBA and emits actual PNG even from WebP", async () => {
    const webp = await processImageResult({ result: generated, parameters: { output_format: "webp", output_compression: 100 } });
    const output = await processImageResult({ result: webp.display, parameters: { output_format: "png" } });
    expect([...output.display.bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(rgba(output.display)).toEqual(rgba(webp.display));
  });

  for (const format of ["jpeg", "webp"] as const) {
    test(`compression setting changes real ${format} encoding, including same-format re-encoding`, async () => {
      const pixels = Uint8Array.from({ length: 64 * 64 * 4 }, (_, i) => i % 4 === 3 ? 255 : (i * 71 + Math.floor(i / 13) * 41) % 256);
      const source = png(pixels, 64, 64);
      const high = await processImageResult({ result: source, parameters: { output_format: format, output_compression: 100 } });
      const low = await processImageResult({ result: high.display, parameters: { output_format: format, output_compression: 0 } });
      expect(low.display.bytes.byteLength).toBeLessThan(high.display.bytes.byteLength);
      expect(Buffer.from(low.display.bytes).equals(Buffer.from(high.display.bytes))).toBe(false);
      expect(rgba(low.display)).toHaveLength(pixels.length);
    });
  }

  for (const parameters of [
    { output_format: "gif" }, { output_format: "jpg" }, { output_format: null },
    { output_format: "jpeg", output_compression: -1 }, { output_format: "jpeg", output_compression: 101 },
    { output_format: "webp", output_compression: 1.5 }, { output_format: "webp", output_compression: true },
    { output_format: "jpeg", output_compression: null }, { output_format: "jpeg", output_compression: " " },
  ]) {
    test(`rejects invalid export options ${JSON.stringify(parameters)}`, async () => {
      await expect(processImageResult({ result: generated, parameters })).rejects.toMatchObject({ code: "INVALID_IMAGE_RESULT_PARAMETERS" });
    });
  }

  test("ignores stale PNG compression without jeopardizing a strict lossless result", async () => {
    const output = await processImageResult({ result: generated, parameters: { output_format: "png", output_compression: "old-value" }, editInput });
    expect([...rgba(output.display)]).toEqual(expectedComposite);
    expect(output.operations).not.toContain("compression_applied");
    expect((await processImageResult({ result: generated, parameters: { output_compression: 80 } })).display.bytes).toBe(generated.bytes);
    expect((await processImageResult({ result: generated, parameters: { output_format: "" } })).display.bytes).toBe(generated.bytes);
  });

  test("normalizes numeric string compression consistently with provider parameters", async () => {
    const numeric = await processImageResult({ result: generated, parameters: { output_format: "webp", output_compression: 80 } });
    const string = await processImageResult({ result: generated, parameters: { output_format: "webp", output_compression: "80" } });
    expect(string.display.bytes).toEqual(numeric.display.bytes);
    expect(string.operations).toContain("compression_applied");
  });

  test("a declared mask can never silently fall through to ordinary image success", async () => {
    await expect(processImageResult({ result: generated, parameters: { inputArchive: { maskReferenceIndex: 1 } } })).rejects.toMatchObject({ code: "INVALID_IMAGE_RESULT_INPUT" });
  });

  test("fails closed on original, mask or result dimension mismatch without stretching", async () => {
    const small = png([10, 20, 30, 255], 1, 1);
    for (const input of [
      { result: small, editInput },
      { result: generated, editInput: { references: [small], mask } },
      { result: generated, editInput: { references: [original], mask: small } },
    ]) await expect(processImageResult({ ...input, parameters: {} })).rejects.toMatchObject({ code: "IMAGE_RESULT_DIMENSION_MISMATCH" });
  });

  test("requires a real alpha PNG mask and an original", async () => {
    const rgbMask = png(Array(12).fill(255), 4, 1, "rgb24");
    await expect(processImageResult({ result: generated, parameters: {}, editInput: { references: [], mask } })).rejects.toMatchObject({ code: "INVALID_IMAGE_RESULT_INPUT" });
    await expect(processImageResult({ result: generated, parameters: {}, editInput: { references: [original], mask: rgbMask } })).rejects.toThrow("alpha");
  });

  test("rejects corrupt files and external URL playlists instead of contacting them", async () => {
    for (const bytes of [Buffer.from("invalid png"), Buffer.from("#EXTM3U\n#EXTINF:3\nhttp://127.0.0.1/private\n")]) {
      await expect(processImageResult({ result: { bytes, mimeType: "image/png" }, parameters: { output_format: "webp" } })).rejects.toBeInstanceOf(ImageResultProcessingError);
    }
  });

  test("does not silently keep the first image of a multi-frame input", async () => {
    await expect(processImageResult({ result: { bytes: Buffer.concat([generated.bytes, original.bytes]), mimeType: "image/png" }, parameters: { output_format: "webp" } })).rejects.toBeInstanceOf(ImageResultProcessingError);
  });

  test("rejects high-bit-depth strict source instead of weakening pixel preservation", async () => {
    const highBit = png(new Uint8Array(4 * 1 * 8).fill(128), 4, 1, "rgba64be");
    await expect(processImageResult({ result: generated, parameters: {}, editInput: { references: [highBit], mask } })).rejects.toThrow("8-bit");
  });

  test("returns a typed deployment error if FFmpeg is unavailable", async () => {
    const previous = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = "canvas-nonexistent-ffmpeg-test";
    try {
      await expect(processImageResult({ result: generated, parameters: { output_format: "webp" } })).rejects.toMatchObject({ code: "IMAGE_RESULT_TOOLS_UNAVAILABLE" });
    } finally {
      if (previous === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = previous;
    }
  });

  test("keeps the strict PNG when only the optional export encoder fails", async () => {
    const moduleUrl = new URL("../src/image-result-processing.ts", import.meta.url);
    const code = ts.transpileModule(await Bun.file(moduleUrl).text(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const realRequire = createRequire(moduleUrl);
    const exports: Record<string, unknown> = {};
    const require = (name: string) => name === "node:child_process" ? { ...childProcess, execFile: (...args: any[]) => {
      if (args[1].includes("libwebp")) return args[3](new Error("test encoder unavailable"), Buffer.alloc(0), Buffer.alloc(0));
      return (childProcess.execFile as (...input: any[]) => unknown)(...args);
    } } : realRequire(name);
    new Function("exports", "require", code)(exports, require);
    const processWithMissingExportCodec = exports.processImageResult as typeof processImageResult;
    const output = await processWithMissingExportCodec({ result: generated, parameters: { output_format: "webp", output_compression: 80 }, editInput });
    expect([...rgba(output.display)]).toEqual(expectedComposite);
    expect(output.export).toBeUndefined();
    expect(output.warning).toContain("WEBP 导出失败");
    expect(output.operations).toContain("export_encoding_failed");
    await expect(processWithMissingExportCodec({ result: generated, parameters: { output_format: "webp" } })).rejects.toMatchObject({ code: "IMAGE_RESULT_PROCESSING_FAILED" });
  });

  test("rejects strict source depth and dimensions before a paid request", async () => {
    const target = { protocol: "openai", modelId: "gpt-image-2", operationType: "inpaint" };
    const parameters = { inputArchive: { maskReferenceIndex: 1 } };
    const highBit = png(new Uint8Array(32).fill(128), 4, 1, "rgba64be");
    const wide = png(new Uint8Array(8193 * 4), 8193, 1);
    await expect(prepareImageEditInput([highBit, mask], parameters, target)).rejects.toThrow("尚未提交生成");
    await expect(prepareImageEditInput([original, highBit], parameters, target)).rejects.toThrow("8 位");
    await expect(prepareImageEditInput([wide, wide], parameters, target)).rejects.toThrow("8192");
  });

  for (const fixture of orientedFixtures.filter(item => item.orientation !== 1)) {
    test(`rejects ${fixture.mimeType} EXIF orientation ${fixture.orientation} instead of misaligning a mask or dropping orientation`, async () => {
      const plain = png(new Uint8Array(4 * 2 * 4).fill(128), 4, 2);
      const target = { protocol: "openai", modelId: "gpt-image-2", operationType: "inpaint" };
      await expect(prepareImageEditInput([fixture, plain], { inputArchive: { maskReferenceIndex: 1 } }, target)).rejects.toThrow("尚未提交生成");
      await expect(processImageResult({ result: plain, parameters: {}, editInput: { references: [fixture], mask: plain } })).rejects.toThrow("正常方向 PNG");
      await expect(processImageResult({ result: fixture, parameters: {}, editInput: { references: [plain], mask: plain } })).rejects.toThrow("正常方向 PNG");
      await expect(processImageResult({ result: fixture, parameters: { output_format: fixture.mimeType === "image/png" ? "webp" : "png" } })).rejects.toThrow("正常方向 PNG");
      const sameFormat = fixture.mimeType.split("/")[1];
      expect((await processImageResult({ result: fixture, parameters: { output_format: sameFormat } })).display.bytes).toBe(fixture.bytes);
    });
  }

  test("rejects mirrored alpha mask even when ffprobe rotation is zero", async () => {
    const mirroredMask = orientedFixtures.find(item => item.mimeType === "image/png" && item.orientation === 4)!;
    const plain = png(new Uint8Array(4 * 2 * 4).fill(128), 4, 2);
    await expect(prepareImageEditInput([plain, mirroredMask], { inputArchive: { maskReferenceIndex: 1 } }, { protocol: "openai", modelId: "gpt-image-2", operationType: "inpaint" })).rejects.toThrow("正常方向 PNG");
    await expect(processImageResult({ result: plain, parameters: {}, editInput: { references: [plain], mask: mirroredMask } })).rejects.toThrow("正常方向 PNG");
  });

  test("identity EXIF orientation remains valid for strict editing and ordinary conversion", async () => {
    const plain = png(new Uint8Array(4 * 2 * 4).fill(128), 4, 2);
    for (const fixture of orientedFixtures.filter(item => item.orientation === 1)) {
      await prepareImageEditInput([fixture, plain], { inputArchive: { maskReferenceIndex: 1 } }, { protocol: "openai", modelId: "gpt-image-2", operationType: "inpaint" });
      const strict = await processImageResult({ result: fixture, parameters: {}, editInput: { references: [fixture], mask: plain } });
      expect(rgba(strict.display)).toEqual(rgba(fixture));
      const converted = await processImageResult({ result: fixture, parameters: { output_format: fixture.mimeType === "image/png" ? "webp" : "png" } });
      expect(rgba(converted.display)).toHaveLength(32);
    }
  });
});
