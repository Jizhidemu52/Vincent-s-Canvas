import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileTypeFromBuffer } from "file-type";
import type { Database } from "./db";
import type { ObjectStorage } from "./object-storage";

const maxBytes = 200 * 1024 * 1024;
const formats = "png_pipe,jpeg_pipe,webp_pipe,gif,mov,mp4,m4a,3gp,3g2,mj2,avif";
function run(tool: "ffmpeg" | "ffprobe", args: string[], maxBuffer = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(process.env[tool === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"] || tool, args,
      { encoding: "buffer", windowsHide: true, timeout: 30_000, maxBuffer },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
const limits = ["-v", "error", "-max_alloc", "134217728", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", formats];
async function thumbnailsFromFile(file: string) {
  const info = JSON.parse((await run("ffprobe", [...limits, "-show_entries", "stream=width,height", "-of", "json", file], 64 * 1024)).toString());
  const { width, height } = info.streams?.[0] || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 67_108_864) {
    throw new Error("缩略图原图尺寸无效或超出安全限制");
  }
  const result = {} as Record<256 | 1024, Buffer>;
  for (const size of [256, 1024] as const) {
    result[size] = await run("ffmpeg", ["-nostdin", ...limits, "-i", file, "-map", "0:v:0", "-frames:v", "1",
      "-vf", `scale=w='min(${size},iw)':h='min(${size},ih)':force_original_aspect_ratio=decrease`,
      "-threads", "1", "-c:v", "libwebp", "-quality", "82", "-f", "image2pipe", "pipe:1"]);
    if ((await fileTypeFromBuffer(result[size]))?.mime !== "image/webp") throw new Error("缩略图编码器未返回 WebP");
  }
  return result;
}
async function withInput(write: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "canvas-asset-thumb-"));
  const input = join(directory, "original");
  try { await write(input); return await thumbnailsFromFile(input); }
  finally { await unlink(input).catch(() => undefined); await rmdir(directory).catch(() => undefined); }
}

/** Also used by the local demo. Does not alter the input bytes. */
export async function createAssetThumbnailBytes(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > maxBytes) throw new Error("缩略图原文件超过限制");
  return withInput(path => writeFile(path, bytes));
}

export async function generateAssetThumbnails(db: Database, storage: ObjectStorage, assetId: string) {
  const result = await db.query<{ object_key: string; thumbnail_256_key: string | null; thumbnail_1024_key: string | null }>(
    "SELECT object_key,thumbnail_256_key,thumbnail_1024_key FROM assets WHERE id=$1 AND kind='image' AND status='ready' AND deleted_at IS NULL", [assetId]);
  const asset = result.rows[0];
  if (!asset || asset.thumbnail_256_key && asset.thumbnail_1024_key) return;
  const object = await storage.get(asset.object_key);
  if (!object.Body || Number(object.ContentLength || 0) > maxBytes) throw new Error("缩略图原文件不可用或超过限制");
  const thumbs = await withInput(async path => {
    let bytes = 0;
    const bound = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      done(bytes > maxBytes ? new Error("缩略图原文件超过限制") : null, chunk);
    } });
    await pipeline(object.Body as Readable, bound, createWriteStream(path));
  });
  const small = `${asset.object_key}.thumb-256.webp`, large = `${asset.object_key}.thumb-1024.webp`;
  await storage.put(small, thumbs[256], "image/webp");
  await storage.put(large, thumbs[1024], "image/webp");
  await db.query("UPDATE assets SET thumbnail_256_key=$2,thumbnail_1024_key=$3 WHERE id=$1 AND object_key=$4 AND deleted_at IS NULL",
    [assetId, small, large, asset.object_key]);
}

// Limit decoder pressure. Failures leave the ready original fully usable.
const scheduled = new Set<string>();
const queue: Array<() => Promise<void>> = [];
let running = 0;
function drain() {
  while (running < 2 && queue.length) {
    const job = queue.shift()!; running++;
    void job().finally(() => { running--; drain(); });
  }
}
export function scheduleAssetThumbnails(db: Database, storage: ObjectStorage, assetId: string): void {
  if (scheduled.has(assetId)) return;
  scheduled.add(assetId);
  queue.push(async () => {
    try { await generateAssetThumbnails(db, storage, assetId); }
    catch (error) { console.warn("Asset thumbnail generation failed", assetId, error instanceof Error ? error.message : "unknown"); }
    finally { scheduled.delete(assetId); }
  });
  drain();
}
