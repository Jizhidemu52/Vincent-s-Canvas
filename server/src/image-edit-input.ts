import { execFile } from "node:child_process";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ImageEditSource = { bytes: Uint8Array; mimeType: string; filename?: string };
type ImageEditTarget = { protocol: string; modelId: string; operationType: string; workflow?: boolean };
export type ImageEditInput<T> = { references: T[]; mask?: T };

export class ImageEditInputError extends Error {
  readonly code = "INVALID_IMAGE_MASK";
}

type OrientationMetadata = {
  tags?: Record<string, unknown>;
  side_data_list?: Array<{ side_data_type?: string; displaymatrix?: string; rotation?: number }>;
};
export type ImageOrientationProbe = { frames?: OrientationMetadata[]; streams?: OrientationMetadata[] };

/** Inspect FFprobe-decoded metadata, never parse EXIF bytes ourselves. Rotation alone misses mirrors. */
export function hasNonIdentityImageOrientation(probe: ImageOrientationProbe) {
  const identity = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
  return [...(probe.frames || []), ...(probe.streams || [])].some(item => {
    for (const [key, value] of Object.entries(item.tags || {})) {
      if (/^orientation$/i.test(key) && Number(value) !== 1) return true;
      if (/^rotate$/i.test(key) && (!Number.isFinite(Number(value)) || Number(value) % 360 !== 0)) return true;
    }
    return (item.side_data_list || []).some(data => {
      if (data.rotation !== undefined && (!Number.isFinite(data.rotation) || data.rotation % 360 !== 0)) return true;
      if (data.displaymatrix !== undefined || /display\s*matrix/i.test(data.side_data_type || "")) {
        // FFprobe emits three numbered rows; require the complete identity matrix, including reflections.
        const matrix = data.displaymatrix?.replace(/^\s*\d+:/gm, "").trim().split(/\s+/).map(Number);
        return !matrix || matrix.length !== 9 || matrix.some((value, index) => value !== identity[index]);
      }
      return false;
    });
  });
}

function archivedMaskIndex(parameters: Record<string, unknown>) {
  const archive = parameters.inputArchive;
  if (!archive || typeof archive !== "object" || !("maskReferenceIndex" in archive)) return undefined;
  return (archive as Record<string, unknown>).maskReferenceIndex;
}

/** Reject unsupported mask routes instead of silently treating the mask as a reference image. */
export function assertImageEditMaskSupport(parameters: Record<string, unknown>, target: ImageEditTarget, sourceCount?: number) {
  const index = archivedMaskIndex(parameters);
  if (index === undefined) return;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1) throw new ImageEditInputError("蒙版引用索引无效，请重新绘制蒙版；尚未提交生成");
  if (sourceCount !== undefined && index >= sourceCount) throw new ImageEditInputError("蒙版引用索引越界或缺少编辑原图，请重新添加蒙版；尚未提交生成");
  const supportsMask = target.protocol === "openai" && /^gpt-image-(?:1|1-mini|1\.5|2|2\.5-flare|2\.5-sunburst)$/.test(target.modelId)
    || target.protocol === "apimart" && /^gpt-image-2\.5-(?:flare|sunburst)$/.test(target.modelId);
  if (!supportsMask || target.workflow) {
    throw new ImageEditInputError("当前模型或渠道不支持独立 PNG 蒙版，请切换支持蒙版的 GPT Image 编辑渠道；尚未提交生成");
  }
  if (target.operationType !== "inpaint") throw new ImageEditInputError("蒙版仅用于图像局部重绘，不能用于文生图或其他操作；尚未提交生成");
}

/** The archive indexes sourceUrls, including its mask. Keep all actual reference images in order. */
export async function prepareImageEditInput<T extends ImageEditSource>(sources: T[], parameters: Record<string, unknown>, target: ImageEditTarget): Promise<ImageEditInput<T>> {
  assertImageEditMaskSupport(parameters, target, sources.length);
  const index = archivedMaskIndex(parameters);
  if (index === undefined) return { references: sources };
  if (typeof index !== "number") throw new ImageEditInputError("蒙版引用索引无效；尚未提交生成");
  const mask = sources[index]!;
  const references = sources.filter((_, sourceIndex) => sourceIndex !== index);
  const original = references[0];
  if (!original) throw new ImageEditInputError("蒙版编辑必须提供原图；尚未提交生成");
  if (mask.mimeType !== "image/png" || !mask.bytes.byteLength || mask.bytes.byteLength >= 4 * 1024 * 1024) {
    throw new ImageEditInputError("蒙版必须是小于 4 MiB、带透明通道的 PNG 文件；尚未提交生成");
  }
  const sourceMeta = await inspectEditImage(original);
  const maskMeta = await inspectEditImage(mask);
  if (!/^(?:rgba|bgra|argb|abgr|ya8)$/.test(maskMeta.pixelFormat)) {
    throw new ImageEditInputError("PNG 蒙版缺少 alpha 透明通道，请重新绘制蒙版；尚未提交生成");
  }
  if (maskMeta.width !== sourceMeta.width || maskMeta.height !== sourceMeta.height) {
    throw new ImageEditInputError(`蒙版尺寸 ${maskMeta.width}×${maskMeta.height} 与第一张原图 ${sourceMeta.width}×${sourceMeta.height} 不一致，请重新绘制；尚未提交生成`);
  }
  return { references, mask };
}

/** Decode bounded local files with the existing FFmpeg installation; never fetch a client URL. */
async function inspectEditImage(source: ImageEditSource) {
  const formats: Record<string, string> = { "image/png": "png_pipe", "image/jpeg": "jpeg_pipe", "image/webp": "webp_pipe" };
  if (!formats[source.mimeType] || !source.bytes.byteLength || source.bytes.byteLength > 50 * 1024 * 1024) {
    throw new ImageEditInputError("蒙版编辑原图必须为不超过 50 MiB 的 PNG、JPEG 或 WebP；尚未提交生成");
  }
  const directory = await mkdtemp(join(tmpdir(), "canvas-image-mask-"));
  const file = join(directory, "source");
  try {
    await writeFile(file, source.bytes);
    const output = await new Promise<string>((resolve, reject) => {
      execFile(process.env.FFPROBE_PATH || "ffprobe", [
        "-v", "error", "-max_alloc", "268435456", "-threads", "1",
        "-protocol_whitelist", "file,pipe", "-format_whitelist", "png_pipe,jpeg_pipe,webp_pipe",
        "-read_intervals", "%+#2", "-count_frames", "-show_entries", "format=format_name:stream=codec_type,width,height,pix_fmt,nb_read_frames:stream_tags:stream_side_data:frame_tags:frame_side_data",
        "-of", "json", file,
      ], { timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error || stderr.trim()) reject(new ImageEditInputError((error as NodeJS.ErrnoException | null)?.code === "ENOENT"
          ? "服务端缺少 ffprobe，无法安全验证蒙版；请安装 FFmpeg 或配置 FFPROBE_PATH，尚未提交生成"
          : "原图或蒙版无法完整解码、文件损坏或验证超时；尚未提交生成"));
        else resolve(stdout);
      });
    });
    const decoded = JSON.parse(output) as { format?: { format_name?: string }; frames?: OrientationMetadata[];
      streams?: Array<OrientationMetadata & { codec_type?: string; width?: number; height?: number; pix_fmt?: string; nb_read_frames?: string }> };
    const image = decoded.streams?.find(stream => stream.codec_type === "video");
    if (decoded.format?.format_name !== formats[source.mimeType] || !image || Number(image.nb_read_frames) !== 1 || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width! < 1 || image.height! < 1) {
      throw new ImageEditInputError("原图或蒙版的真实格式、像素尺寸或单帧内容无效；尚未提交生成");
    }
    if (image.width! > 8192 || image.height! > 8192 || image.width! * image.height! > 16_777_216) {
      throw new ImageEditInputError("严格蒙版编辑仅支持单边不超过 8192、总像素不超过 16777216 的原图和蒙版；尚未提交生成");
    }
    if (/(?:9|10|12|14|16|48|64)(?:le|be)?$/.test(image.pix_fmt || "")) {
      throw new ImageEditInputError("严格蒙版编辑仅支持 8 位（8-bit）原图和蒙版，不自动降低高位深图片精度；尚未提交生成");
    }
    if (hasNonIdentityImageOrientation(decoded)) {
      throw new ImageEditInputError("原图或蒙版含旋转或镜像方向信息，无法保证蒙版坐标一致；请先另存为正常方向 PNG 再编辑，尚未提交生成");
    }
    return { width: image.width!, height: image.height!, pixelFormat: image.pix_fmt || "" };
  } finally {
    await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
}
