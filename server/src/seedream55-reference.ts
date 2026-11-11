import { fileTypeFromBuffer } from "file-type";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadView } from "exifreader";
import { SEEDREAM55_MIMES } from "./seedream55-image";
import { probeMediaBytes } from "./media-probe";
import { LAYER_STUDIO_MAX_REFERENCE_BYTES, LAYER_STUDIO_MAX_REFERENCE_PIXELS } from "../../shared/layer-studio-options";
import { withTemporaryMediaFile } from "./media-file";

async function verifyImageDecoding(bytes: Uint8Array, heif: boolean) {
  return withTemporaryMediaFile((async function* () { yield bytes; })(), { maxBytes: LAYER_STUDIO_MAX_REFERENCE_BYTES }, async file => {
    if (heif) {
      const node = Bun.which("node");
      if (!node) throw new Error("服务端缺少原生 Node.js 图片解码运行时；尚未提交生成");
      const output = await new Promise<string>((resolve, reject) => {
        execFile(node, ["--max-old-space-size=128", "--wasm-max-mem-pages=8192", fileURLToPath(new URL("./seedream55-heif-decoder.mjs", import.meta.url)), file.path],
          { timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true, env: { ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) } }, (error, stdout) => error
            ? reject(new Error("HEIC/HEIF 原始图片无法解码或超过解码资源限制；尚未提交生成")) : resolve(stdout));
      });
      return JSON.parse(output) as { width: number; height: number };
    }
    await new Promise<void>((resolve, reject) => {
      execFile(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-max_alloc", "134217728", "-threads", "1",
        "-protocol_whitelist", "file,pipe", "-format_whitelist", "png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,tiff_pipe,gif,mov",
        "-i", file.path, "-map", "0:v", "-frames:v", "1", "-f", "null", "-"],
      { timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true }, error => error
        ? reject(new Error("原始图片无法解码、文件损坏或服务器尚不支持此格式；尚未提交生成，请联系管理员检查图片解码支持")) : resolve());
    });
  });
}

/** True format and primary image dimensions, without converting original bytes. */
export async function validateSeedream55Reference(source: { bytes: Uint8Array; mimeType: string }) {
  if (!source.bytes.length || source.bytes.length > LAYER_STUDIO_MAX_REFERENCE_BYTES) throw new Error("参考图必须非空且不超过 30 MiB");
  const detected = await fileTypeFromBuffer(source.bytes).catch(() => undefined);
  if (!detected || !SEEDREAM55_MIMES.has(detected.mime) || detected.mime !== source.mimeType) throw new Error("参考图真实格式与声明不一致或不受支持（不支持 AVIF/JP2）");
  let dimensions: { width?: number; height?: number };
  if (detected.mime === "image/heic" || detected.mime === "image/heif") {
    // The established ISO-BMFF parser resolves the primary item's ispe rather
    // than thumbnail/EXIF claims. Decoder verification follows separately;
    // metadata alone is not proof that the encoded image can be consumed.
    const tags = loadView(new DataView(source.bytes.buffer, source.bytes.byteOffset, source.bytes.byteLength), { expanded: true, includeTags: { file: ["Image Width", "Image Height"] } });
    const file = tags.file;
    dimensions = { width: Number(file?.["Image Width"]?.value), height: Number(file?.["Image Height"]?.value) };
  } else dimensions = await probeMediaBytes(source.bytes, detected.mime);
  const { width, height } = dimensions;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width! <= 0 || height! <= 0 || width! * height! > LAYER_STUDIO_MAX_REFERENCE_PIXELS) throw new Error("参考图尺寸无法安全读取或超过 3600 万总像素");
  const decoded = await verifyImageDecoding(source.bytes, detected.mime === "image/heic" || detected.mime === "image/heif");
  // libheif returns the primary image after its orientation transform; ispe
  // above still bounds the encoded primary before allocating decoded pixels.
  return { width: decoded?.width ?? width!, height: decoded?.height ?? height!, mimeType: detected.mime };
}

export async function readBoundedImage(stream: ReadableStream<Uint8Array>, limit: number, expectedBytes?: number) {
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error("图片超过安全文件大小上限");
      chunks.push(chunk.value);
    }
    if (!size || (expectedBytes !== undefined && size !== expectedBytes)) throw new Error("图片原件大小与存储记录不一致");
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
