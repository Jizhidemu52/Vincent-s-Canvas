import { execFile } from "node:child_process";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerImageMimeType } from "./provider-image-result";
import { hasNonIdentityImageOrientation, type ImageOrientationProbe } from "./image-edit-input";
import { quickImageResultAction } from "./quick-image-tools";

export type ProcessedResultImage = { bytes: Uint8Array; mimeType: string };
export type ImageResultProcessingInput = {
  result: ProcessedResultImage;
  parameters: Record<string, unknown>;
  editInput?: { references: ProcessedResultImage[]; mask?: ProcessedResultImage };
};
export type ProcessedImageResult = {
  display: ProcessedResultImage;
  export?: ProcessedResultImage;
  operations: string[];
  warning?: string;
};
type ProcessingErrorCode = "INVALID_IMAGE_RESULT_PARAMETERS" | "INVALID_IMAGE_RESULT_INPUT" | "IMAGE_RESULT_DIMENSION_MISMATCH"
  | "IMAGE_RESULT_TOOLS_UNAVAILABLE" | "IMAGE_RESULT_PROCESSING_TIMEOUT" | "IMAGE_RESULT_PROCESSING_FAILED" | "IMAGE_RESULT_TRANSPARENCY_MISSING" | "IMAGE_RESULT_MATTE_INVALID";
export class ImageResultProcessingError extends Error {
  constructor(readonly code: ProcessingErrorCode, message: string) { super(message); this.name = "ImageResultProcessingError"; }
}

type Format = "png" | "jpeg" | "webp";
type ImageMetadata = { width: number; height: number; pixelFormat: string };
const formats: Record<string, string> = { "image/png": "png_pipe", "image/jpeg": "jpeg_pipe", "image/webp": "webp_pipe" };
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PIXELS = 16_777_216;
const MAX_EDGE = 8192;
const TOOL_TIMEOUT_MS = 30_000;
const ALPHA_8BIT = /^(?:rgba|bgra|argb|abgr|ya8)$/;
const HIGH_BIT_DEPTH = /(?:9|10|12|14|16|48|64)(?:le|be)?$/;

function exportSettings(parameters: Record<string, unknown>) {
  const value = parameters.output_format === "" ? undefined : parameters.output_format;
  if (value !== undefined && value !== "png" && value !== "jpeg" && value !== "webp") {
    throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_PARAMETERS", "结果导出格式仅支持 png、jpeg 或 webp");
  }
  const format = value as Format | undefined;
  // PNG has no quality percentage; a stale value must not jeopardize a lossless result.
  const rawCompression = format === "jpeg" || format === "webp" ? parameters.output_compression : undefined;
  const compression = rawCompression === undefined || rawCompression === "" ? undefined : Number(rawCompression);
  if (compression !== undefined && (typeof rawCompression !== "number" && typeof rawCompression !== "string"
    || typeof rawCompression === "string" && !rawCompression.trim() || !Number.isInteger(compression) || compression < 0 || compression > 100)) {
    throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_PARAMETERS", "JPEG/WebP 的 output_compression 必须是 0–100 的整数");
  }
  return { format, compression };
}

function runTool(tool: "ffmpeg" | "ffprobe", args: string[], maxBuffer: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(process.env[tool === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"] || tool, args, {
      encoding: "buffer", timeout: TOOL_TIMEOUT_MS, maxBuffer, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error || stderr.toString().trim()) {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
          reject(new ImageResultProcessingError("IMAGE_RESULT_TOOLS_UNAVAILABLE", `服务端缺少 ${tool}，无法处理图片结果；请安装 FFmpeg 或配置对应路径。原始结果仍须保留`));
        } else if (error && "killed" in error && error.killed) {
          reject(new ImageResultProcessingError("IMAGE_RESULT_PROCESSING_TIMEOUT", "图片结果处理超时，未替换原始结果"));
        } else {
          reject(new ImageResultProcessingError("IMAGE_RESULT_PROCESSING_FAILED", "图片结果无法安全解码或编码，可能损坏、超出限制或所需编码器不可用；未替换原始结果"));
        }
      } else resolve(stdout);
    });
  });
}

const toolLimits = ["-v", "error", "-max_alloc", "134217728", "-threads", "1"];
const safeImageInput = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "png_pipe,jpeg_pipe,webp_pipe"];

async function inspect(file: string, mimeType: string, bytes: Uint8Array): Promise<ImageMetadata> {
  const output = await runTool("ffprobe", [...toolLimits, ...safeImageInput,
    "-show_entries", "format=format_name:stream=codec_type,width,height,pix_fmt", "-of", "json", file,
  ], 64 * 1024);
  let info: { format?: { format_name?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number; pix_fmt?: string }> };
  try { info = JSON.parse(output.toString()); }
  catch { throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_INPUT", "图片结果的元数据无效，无法安全处理"); }
  const streams = info.streams?.filter(item => item.codec_type === "video") || [];
  const image = streams[0];
  if (info.format?.format_name !== formats[mimeType] || streams.length !== 1 || !image
    || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width! < 1 || image.height! < 1
    || image.width! > MAX_EDGE || image.height! > MAX_EDGE || image.width! * image.height! > MAX_PIXELS) {
    throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_INPUT", "图片真实格式或尺寸无效；后处理仅支持单帧 PNG/JPEG/WebP、单边不超过 8192 且不超过 16777216 像素");
  }
  // JPEG/PNG/WebP EXIF direction is usually frame side data, not stream rotation.
  // Decode only one bounded frame after validating dimensions, and fail instead of guessing alignment.
  const orientationOutput = await runTool("ffprobe", [...toolLimits, ...safeImageInput,
    "-read_intervals", "%+#1", "-show_entries", "stream_tags:stream_side_data:frame_tags:frame_side_data", "-of", "json", file,
  ], 64 * 1024);
  let orientation: ImageOrientationProbe;
  try { orientation = JSON.parse(orientationOutput.toString()); }
  catch { throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_INPUT", "无法验证图片显示方向；请先另存为正常方向 PNG 再处理"); }
  if (hasNonIdentityImageOrientation(orientation, bytes)) {
    throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_INPUT", "图片含旋转、镜像或无法验证的方向信息，无法安全对齐蒙版或转换格式；请先另存为正常方向 PNG，原始结果未被替换");
  }
  return { width: image.width!, height: image.height!, pixelFormat: image.pix_fmt || "" };
}

async function decode(file: string, metadata: ImageMetadata, pixelFormat: "rgba" | "rgba64le" = "rgba") {
  const expected = metadata.width * metadata.height * (pixelFormat === "rgba64le" ? 8 : 4);
  // Read at most two frames. The second is only for detecting and rejecting animation/concatenation.
  const pixels = await runTool("ffmpeg", ["-nostdin", ...toolLimits, ...safeImageInput, "-noautorotate", "-i", file,
    "-map", "0:v:0", "-frames:v", "2", "-threads", "1", "-f", "rawvideo", "-pix_fmt", pixelFormat, "pipe:1",
  ], expected * 2 + 64 * 1024);
  if (pixels.byteLength !== expected) throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_INPUT", "图片不是完整单帧内容，不能安全合成或导出");
  return pixels;
}

function pixelsHaveTransparency(pixels: Buffer, highBitDepth = false) {
  const stride = highBitDepth ? 8 : 4;
  for (let index = highBitDepth ? 6 : 3; index < pixels.length; index += stride) {
    if (highBitDepth ? pixels.readUInt16LE(index) !== 65535 : pixels[index] !== 255) return true;
  }
  return false;
}

async function createImageProcessingFiles() {
  const directory = await mkdtemp(join(tmpdir(), "canvas-image-result-")).catch(() => {
    throw new ImageResultProcessingError("IMAGE_RESULT_PROCESSING_FAILED", "无法创建图片处理临时目录；原始结果未被替换");
  });
  const files = new Set<string>();
  const localFile = async (name: string, bytes: Uint8Array) => {
    const file = join(directory, name);
    files.add(file);
    await writeFile(file, bytes);
    return file;
  };
  const load = async (name: string, image: ProcessedResultImage) => {
    const mimeType = providerImageMimeType(image.bytes, image.mimeType);
    if (!formats[mimeType] || !image.bytes.byteLength || image.bytes.byteLength > MAX_FILE_BYTES) {
      throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_INPUT", "后处理图片必须是非空且不超过 50 MiB 的 PNG、JPEG 或 WebP");
    }
    const file = await localFile(name, image.bytes);
    return { file, mimeType, metadata: await inspect(file, mimeType, image.bytes) };
  };
  const cleanup = async () => {
    try {
      for (const file of files) await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
      await rmdir(directory);
    } catch {
      throw new ImageResultProcessingError("IMAGE_RESULT_PROCESSING_FAILED", "图片处理临时文件清理失败；原始生成结果未被替换");
    }
  };
  return { localFile, load, cleanup };
}

/** Inspect already-authorized bytes only; no network or source re-encoding. */
export async function hasImageTransparency(image: ProcessedResultImage): Promise<boolean> {
  const { load, cleanup } = await createImageProcessingFiles();
  try {
    const source = await load("alpha-check", image);
    const highBitDepth = HIGH_BIT_DEPTH.test(source.metadata.pixelFormat);
    const pixels = await decode(source.file, source.metadata, highBitDepth ? "rgba64le" : "rgba");
    return pixelsHaveTransparency(pixels, highBitDepth);
  } catch (error) {
    if (error instanceof ImageResultProcessingError) throw error;
    throw new ImageResultProcessingError("IMAGE_RESULT_PROCESSING_FAILED", "无法安全读取图片透明度；原始文件未被修改");
  } finally {
    await cleanup();
  }
}

/** Validate original bytes and local codecs before submitting the single paid model request. */
export async function validateQuickImageSource(image: ProcessedResultImage | undefined, parameters: Record<string, unknown>) {
  const action = quickImageResultAction(parameters);
  if (!action) return;
  if (!image) throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_INPUT", "请上传或选择一张需要处理的图片；尚未提交生成");
  const { load, cleanup } = await createImageProcessingFiles();
  try {
    const source = await load("quick-source", image);
    if (HIGH_BIT_DEPTH.test(source.metadata.pixelFormat)) throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_INPUT", "一键图片工具暂仅支持 8 位 PNG、JPEG、WebP 原图；尚未提交生成");
    const ratio = source.metadata.width / source.metadata.height;
    if (ratio < 1 / 8 || ratio > 8) throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_INPUT", "原图宽高比超出 Nano 2.1 支持范围（1:8 至 8:1）；尚未提交生成");
    if (action === "hd-upscale" && Math.max(source.metadata.width, source.metadata.height) > 4096) {
      throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_INPUT", "原图已超过 4K，无需使用此高清放大功能；尚未提交生成");
    }
    // Decoding also verifies the original is complete, single-frame and that FFmpeg is available.
    await decode(source.file, source.metadata);
  } finally {
    await cleanup();
  }
}

function composite(original: Buffer, generated: Buffer, mask: Buffer) {
  const result = Buffer.allocUnsafe(original.length);
  for (let index = 0; index < result.length; index += 4) {
    const preserve = mask[index + 3]!;
    for (let channel = 0; channel < 4; channel++) {
      result[index + channel] = Math.round((original[index + channel]! * preserve + generated[index + channel]! * (255 - preserve)) / 255);
    }
  }
  return result;
}

function flattenWhite(pixels: Buffer) {
  const result = Buffer.allocUnsafe(pixels.length);
  let changed = false;
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3]!;
    if (alpha !== 255) changed = true;
    for (let channel = 0; channel < 3; channel++) result[index + channel] = Math.round((pixels[index + channel]! * alpha + 255 * (255 - alpha)) / 255);
    result[index + 3] = 255;
  }
  return { pixels: result, changed };
}

/** No network, storage or database writes. The caller must archive the provider result BEFORE calling. */
export async function processImageResult({ result, parameters, editInput }: ImageResultProcessingInput): Promise<ProcessedImageResult> {
  const quickAction = quickImageResultAction(parameters);
  const { format, compression } = exportSettings(parameters);
  const requireTransparency = parameters.background === "transparent";
  if (requireTransparency && format === "jpeg") {
    throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_PARAMETERS", "透明背景仅支持 PNG 或 WebP，不能导出为 JPEG；原始结果未被替换");
  }
  const mask = editInput?.mask;
  const archive = parameters.inputArchive;
  if (archive && typeof archive === "object" && "maskReferenceIndex" in archive && archive.maskReferenceIndex !== undefined && !mask) {
    throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_INPUT", "任务包含蒙版编辑标记，但后处理缺少独立蒙版；不能将渠道原件当作严格合成结果");
  }
  if (!quickAction && !mask && !format && !requireTransparency) return { display: result, operations: [] };
  const actualMimeType = providerImageMimeType(result.bytes, "");
  if (!quickAction && !mask && !requireTransparency && compression === undefined && actualMimeType === `image/${format}`) {
    return { display: { bytes: result.bytes, mimeType: actualMimeType }, operations: [] };
  }
  const original = editInput?.references[0];
  if (quickAction && !original) throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_INPUT", "一键图片处理缺少原图；渠道原件已保留，未输出处理结果");
  if (mask && !original) throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_INPUT", "严格蒙版合成缺少第一张编辑原图；原始生成结果未被替换");

  const { localFile, load, cleanup } = await createImageProcessingFiles();
  const operations: string[] = [];
  const verifyTransparency = (pixels: Buffer, highBitDepth = false) => {
    if (!requireTransparency) return;
    if (!pixelsHaveTransparency(pixels, highBitDepth)) {
      throw new ImageResultProcessingError("IMAGE_RESULT_TRANSPARENCY_MISSING", "请求透明背景，但结果所有像素均不透明；未自动抠图或重新生成，请检查已保存的渠道原件");
    }
    if (!operations.includes("transparent_alpha_verified")) operations.push("transparent_alpha_verified");
  };
  const encode = async (pixels: Buffer, metadata: ImageMetadata, target: Format, quality?: number) => {
    const flattened = target === "jpeg" ? flattenWhite(pixels) : { pixels, changed: false };
    const file = await localFile(`encode-${target}.rgba`, flattened.pixels);
    const codec = target === "png" ? ["-c:v", "png", "-pix_fmt", "rgba"]
      : target === "webp" ? ["-c:v", "libwebp", "-lossless", "0", "-quality", String(quality ?? 100), "-pix_fmt", "bgra"]
      // MJPEG uses a quantizer rather than a percentage; map 100 -> 2 (highest) and 0 -> 31.
      : ["-c:v", "mjpeg", "-q:v", String(2 + (100 - (quality ?? 100)) * 29 / 100), "-pix_fmt", "yuvj444p"];
    const bytes = await runTool("ffmpeg", ["-nostdin", ...toolLimits,
      "-protocol_whitelist", "file,pipe", "-format_whitelist", "rawvideo", "-f", "rawvideo", "-pixel_format", "rgba",
      "-video_size", `${metadata.width}x${metadata.height}`, "-i", file,
      "-frames:v", "1", "-threads", "1", ...codec, "-f", "image2pipe", "pipe:1",
    ], MAX_FILE_BYTES);
    const mimeType = `image/${target}`;
    if (!bytes.byteLength || providerImageMimeType(bytes, "") !== mimeType) {
      throw new ImageResultProcessingError("IMAGE_RESULT_PROCESSING_FAILED", "编码器未返回请求的真实图片格式；原始结果未被替换");
    }
    if (flattened.changed) operations.push("jpeg_alpha_flattened_white");
    return { bytes, mimeType };
  };
  try {
    const generated = await load("generated", result);
    if (quickAction && original) {
      const source = await load("original", original);
      const sourceRatio = source.metadata.width / source.metadata.height;
      const resultRatio = generated.metadata.width / generated.metadata.height;
      if (Math.abs(resultRatio / sourceRatio - 1) > 0.01) {
        throw new ImageResultProcessingError("IMAGE_RESULT_DIMENSION_MISMATCH", "结果宽高比与原图不一致；未拉伸、裁剪或替换原图，请检查已保存的渠道原件");
      }
      if (quickAction === "hd-upscale") {
        if (Math.max(generated.metadata.width, generated.metadata.height) < 3840
          || generated.metadata.width < source.metadata.width || generated.metadata.height < source.metadata.height) {
          throw new ImageResultProcessingError("IMAGE_RESULT_DIMENSION_MISMATCH", "高清结果未达到 4K 或小于原图尺寸；渠道原件已保留，不会把低清结果标记为高清放大成功");
        }
        await decode(generated.file, generated.metadata);
        return { display: { bytes: result.bytes, mimeType: generated.mimeType }, operations: ["quick_image_4k_dimensions_verified"],
          warning: "AI 高清修复结果，已验证输出尺寸与宽高比；文字及细节请结合原图检查。" };
      }
      if (HIGH_BIT_DEPTH.test(source.metadata.pixelFormat)) throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_INPUT", "一键去背景暂仅支持 8 位原图，不会自动降低高位深图片精度");
      const mattePixels = await decode(generated.file, generated.metadata);
      let colored = 0, background = 0, foreground = 0;
      for (let index = 0; index < mattePixels.length; index += 4) {
        const red = mattePixels[index]!, green = mattePixels[index + 1]!, blue = mattePixels[index + 2]!;
        if (Math.max(red, green, blue) - Math.min(red, green, blue) > 12 || mattePixels[index + 3]! < 247) colored++;
        const value = Math.round((red + green + blue) / 3);
        if (value <= 8) background++;
        if (value >= 247) foreground++;
      }
      if (colored > mattePixels.length / 4 * 0.005 || !background || !foreground) {
        throw new ImageResultProcessingError("IMAGE_RESULT_MATTE_INVALID", "模型未返回有效的黑白前景蒙版（非灰度、全黑、全白或缺少主体）；渠道原件已保留，未生成假透明结果");
      }
      const alignedMatte = source.metadata.width === generated.metadata.width && source.metadata.height === generated.metadata.height
        ? mattePixels : await runTool("ffmpeg", ["-nostdin", ...toolLimits, ...safeImageInput, "-noautorotate", "-i", generated.file,
          "-map", "0:v:0", "-frames:v", "1", "-vf", `scale=${source.metadata.width}:${source.metadata.height}:flags=lanczos`,
          "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], source.metadata.width * source.metadata.height * 4 + 64 * 1024);
      const sourcePixels = await decode(source.file, source.metadata);
      if (alignedMatte.length !== sourcePixels.length) throw new ImageResultProcessingError("IMAGE_RESULT_MATTE_INVALID", "前景蒙版无法与原图对齐，未输出处理结果");
      // Only opacity changes: original RGB, image size and all interior pixels stay intact.
      const output = Buffer.from(sourcePixels);
      let retained = 0, transparent = 0;
      for (let index = 0; index < output.length; index += 4) {
        const value = Math.round((alignedMatte[index]! + alignedMatte[index + 1]! + alignedMatte[index + 2]!) / 3);
        const alpha = value <= 8 ? 0 : value >= 247 ? 255 : value;
        output[index + 3] = Math.round(sourcePixels[index + 3]! * alpha / 255);
        if (output[index + 3]! > 0) retained++;
        if (output[index + 3] === 0) transparent++;
      }
      if (!retained || !transparent) throw new ImageResultProcessingError("IMAGE_RESULT_MATTE_INVALID", "蒙版合成后没有有效主体或透明区域，未输出处理结果");
      const display = await encode(output, source.metadata, "png");
      return { display, operations: ["ai_foreground_matte", "original_rgb_preserved", "original_dimensions_preserved", "transparent_alpha_verified"],
        warning: "使用 AI 识别的前景蒙版合成，原图颜色和尺寸已保留；发丝、孔洞及半透明边缘请检查，不承诺像素级完美抠图。" };
    }
    let pixels: Buffer;
    if (mask && original) {
      const source = await load("original", original);
      const alpha = await load("mask", mask);
      if (alpha.mimeType !== "image/png" || !ALPHA_8BIT.test(alpha.metadata.pixelFormat)) {
        throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_INPUT", "严格蒙版必须为带 alpha 透明通道的 8 位 PNG 文件");
      }
      if (HIGH_BIT_DEPTH.test(source.metadata.pixelFormat) || HIGH_BIT_DEPTH.test(generated.metadata.pixelFormat)) {
        throw new ImageResultProcessingError("INVALID_IMAGE_RESULT_INPUT", "严格蒙版合成仅支持 8 位（8-bit）原图和结果；不自动降低高位深图片精度");
      }
      if ([source, alpha].some(item => item.metadata.width !== generated.metadata.width || item.metadata.height !== generated.metadata.height)) {
        throw new ImageResultProcessingError("IMAGE_RESULT_DIMENSION_MISMATCH", `原图 ${source.metadata.width}×${source.metadata.height}、蒙版 ${alpha.metadata.width}×${alpha.metadata.height}、结果 ${generated.metadata.width}×${generated.metadata.height} 尺寸不一致，不能严格合成；未拉伸或替换原始结果`);
      }
      // Sequential decoding bounds simultaneous subprocess memory. All buffers remain local to this call.
      const sourcePixels = await decode(source.file, source.metadata);
      const generatedPixels = await decode(generated.file, generated.metadata);
      const maskPixels = await decode(alpha.file, alpha.metadata);
      pixels = composite(sourcePixels, generatedPixels, maskPixels);
      verifyTransparency(pixels);
      const display = await encode(pixels, generated.metadata, "png");
      operations.push("strict_mask_composite");
      if (format === "jpeg" || format === "webp") {
        try {
          const exported = await encode(pixels, generated.metadata, format, compression);
          operations.push("format_conversion", "lossy_export_not_pixel_exact");
          if (compression !== undefined) operations.push("compression_applied");
          return { display, export: exported, operations };
        } catch (error) {
          operations.push("export_encoding_failed");
          const detail = error instanceof ImageResultProcessingError ? error.message : "导出编码器不可用";
          return { display, operations, warning: `严格蒙版 PNG 已完成；${format.toUpperCase()} 导出失败：${detail}` };
        }
      }
      return { display, operations };
    }
    const highBitDepth = requireTransparency && HIGH_BIT_DEPTH.test(generated.metadata.pixelFormat);
    pixels = await decode(generated.file, generated.metadata, highBitDepth ? "rgba64le" : "rgba");
    verifyTransparency(pixels, highBitDepth);
    if (!format || compression === undefined && actualMimeType === `image/${format}`) {
      return { display: { bytes: result.bytes, mimeType: generated.mimeType }, operations };
    }
    if (highBitDepth) {
      pixels = await decode(generated.file, generated.metadata);
      // A later 8-bit export must not round the only translucent pixels to opaque.
      verifyTransparency(pixels);
    }
    const display = await encode(pixels, generated.metadata, format!, compression);
    operations.push("format_conversion");
    if (compression !== undefined) operations.push("compression_applied");
    return { display, operations };
  } catch (error) {
    if (error instanceof ImageResultProcessingError) throw error;
    throw new ImageResultProcessingError("IMAGE_RESULT_PROCESSING_FAILED", "图片后处理失败，原始生成结果未被替换");
  } finally {
    await cleanup();
  }
}
