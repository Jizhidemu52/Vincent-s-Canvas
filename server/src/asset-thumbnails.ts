import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
function run(tool: "ffmpeg" | "ffprobe", args: string[], maxBuffer = 8 * 1024 * 1024, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(process.env[tool === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"] || tool, args,
      { encoding: "buffer", windowsHide: true, timeout: 30_000, maxBuffer, signal },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
const limits = ["-v", "error", "-max_alloc", "134217728", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", formats];
async function thumbnailsFromFile(file: string, signal?: AbortSignal) {
  const info = JSON.parse((await run("ffprobe", [...limits, "-show_entries", "stream=width,height", "-of", "json", file], 64 * 1024, signal)).toString());
  const { width, height } = info.streams?.[0] || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 67_108_864) {
    throw new Error("缩略图原图尺寸无效或超出安全限制");
  }
  const result = {} as Record<256 | 1024, Buffer>;
  for (const size of [256, 1024] as const) {
    result[size] = await run("ffmpeg", ["-nostdin", ...limits, "-i", file, "-map", "0:v:0", "-frames:v", "1",
      "-vf", `scale=w='min(${size},iw)':h='min(${size},ih)':force_original_aspect_ratio=decrease`,
      "-threads", "1", "-c:v", "libwebp", "-quality", "82", "-f", "image2pipe", "pipe:1"], undefined, signal);
    if ((await fileTypeFromBuffer(result[size]))?.mime !== "image/webp") throw new Error("缩略图编码器未返回 WebP");
  }
  return result;
}
async function withInput(write: (path: string) => Promise<void>, signal?: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), "canvas-asset-thumb-"));
  const input = join(directory, "original");
  try { signal?.throwIfAborted(); await write(input); return await thumbnailsFromFile(input, signal); }
  finally { await unlink(input).catch(() => undefined); await rmdir(directory).catch(() => undefined); }
}

/** Also used by the local demo. Does not alter the input bytes. */
export async function createAssetThumbnailBytes(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > maxBytes) throw new Error("缩略图原文件超过限制");
  return withInput(path => writeFile(path, bytes));
}

export async function generateAssetThumbnails(db: Database, storage: ObjectStorage, assetId: string, options: { signal?: AbortSignal; leaseToken?: string } = {}) {
  const { signal, leaseToken } = options;
  signal?.throwIfAborted();
  const result = await db.query<{ object_key: string; thumbnail_256_key: string | null; thumbnail_1024_key: string | null }>(
    "SELECT object_key,thumbnail_256_key,thumbnail_1024_key FROM assets WHERE id=$1 AND kind='image' AND status='ready' AND deleted_at IS NULL AND ($2::uuid IS NULL OR thumbnail_lease_token=$2)", [assetId, leaseToken ?? null]);
  const asset = result.rows[0];
  if (!asset || asset.thumbnail_256_key && asset.thumbnail_1024_key) return;
  const object = await storage.get(asset.object_key, { abortSignal: signal });
  if (!object.Body || Number(object.ContentLength || 0) > maxBytes) throw new Error("缩略图原文件不可用或超过限制");
  const thumbs = await withInput(async path => {
    let bytes = 0;
    const bound = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      done(bytes > maxBytes ? new Error("缩略图原文件超过限制") : null, chunk);
    } });
    await pipeline(object.Body as Readable, bound, createWriteStream(path), { signal });
  }, signal);
  const small = `${asset.object_key}.thumb-256.webp`, large = `${asset.object_key}.thumb-1024.webp`;
  await storage.put(small, thumbs[256], "image/webp", { abortSignal: signal });
  await storage.put(large, thumbs[1024], "image/webp", { abortSignal: signal });
  signal?.throwIfAborted();
  await db.query("UPDATE assets SET thumbnail_256_key=$2,thumbnail_1024_key=$3 WHERE id=$1 AND object_key=$4 AND status='ready' AND deleted_at IS NULL AND ($5::uuid IS NULL OR thumbnail_lease_token=$5)",
    [assetId, small, large, asset.object_key, leaseToken ?? null]);
}

interface ThumbnailMaintenance { wake(): void; stop(): Promise<void> }
const maintenance = new WeakMap<Database, ThumbnailMaintenance>();

/** Missing thumbnail columns are the durable backlog; no unbounded in-memory queue. */
export function startAssetThumbnailMaintenance(db: Database, storage: ObjectStorage, options: {
  generate?: typeof generateAssetThumbnails;
  pollIntervalMs?: number;
  jobTimeoutMs?: number;
} = {}): ThumbnailMaintenance {
  const existing = maintenance.get(db);
  if (existing) return existing;
  const generate = options.generate ?? generateAssetThumbnails;
  const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  let stopping = false;
  let scanning: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  async function finish(id: string, token: string, error: unknown, attempt: number) {
    const cancelled = stopping;
    const delaySeconds = [15, 60, 300][Math.min(attempt - 1, 2)];
    await db.query(`UPDATE assets SET thumbnail_lease_token=NULL,
      thumbnail_attempts=GREATEST(0,thumbnail_attempts-$3),
      thumbnail_retry_at=CASE WHEN $4::boolean THEN now()+($5::int*interval '1 second') ELSE NULL END,
      thumbnail_last_error=$6 WHERE id=$1 AND thumbnail_lease_token=$2`,
    [id, token, cancelled ? 1 : 0, Boolean(error) && !cancelled, delaySeconds,
      error && !cancelled ? String(error instanceof Error ? error.message : error).slice(0, 500) : null]);
  }

  async function scan() {
    const available = 2 - active.size;
    if (stopping || !storage.configured || available <= 0) return;
    const token = randomUUID();
    const claimed = await db.query<{ id: string; thumbnail_attempts: number }>(`
      WITH candidates AS (SELECT id FROM assets
        WHERE kind='image' AND status='ready' AND deleted_at IS NULL
          AND (thumbnail_256_key IS NULL OR thumbnail_1024_key IS NULL)
          AND thumbnail_attempts < 4 AND (thumbnail_retry_at IS NULL OR thumbnail_retry_at <= now())
        ORDER BY thumbnail_retry_at NULLS FIRST,created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED)
      UPDATE assets a SET thumbnail_attempts=a.thumbnail_attempts+1,
        thumbnail_lease_token=$2,thumbnail_retry_at=now()+interval '3 minutes'
      FROM candidates c WHERE a.id=c.id RETURNING a.id,a.thumbnail_attempts`, [available, token]);
    for (const row of claimed.rows) {
      if (stopping) { await finish(row.id, token, null, row.thumbnail_attempts); continue; }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("缩略图处理超时")), options.jobTimeoutMs ?? 120_000);
      timeout.unref();
      const promise = Promise.resolve().then(async () => {
        let failure: unknown;
        try { await generate(db, storage, row.id, { signal: controller.signal, leaseToken: token }); }
        catch (error) { failure = error; }
        finally { clearTimeout(timeout); }
        await finish(row.id, token, failure, row.thumbnail_attempts);
      }).catch(error => {
        // A failed database update leaves a lease which another process can reclaim.
        console.warn("Asset thumbnail maintenance failed", row.id, error instanceof Error ? error.message : "unknown");
      }).finally(() => { active.delete(row.id); service.wake(); });
      active.set(row.id, { controller, promise });
    }
  }
  const service: ThumbnailMaintenance = {
    wake() {
      if (stopping || scanning) return;
      scanning = scan().catch(error => console.warn("Asset thumbnail scan failed", error instanceof Error ? error.message : "unknown"))
        .finally(() => { scanning = undefined; });
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      clearInterval(timer);
      for (const job of active.values()) job.controller.abort(new Error("服务关闭，缩略图稍后恢复"));
      stopPromise = (async () => {
        await scanning;
        await Promise.all([...active.values()].map(job => job.promise));
        if (maintenance.get(db) === service) maintenance.delete(db);
      })();
      return stopPromise;
    },
  };
  const timer = setInterval(() => service.wake(), options.pollIntervalMs ?? 5000);
  timer.unref();
  maintenance.set(db, service);
  service.wake();
  return service;
}

export function scheduleAssetThumbnails(db: Database, _storage: ObjectStorage, _assetId: string): void {
  // Worker-created assets are also found by the API's periodic durable scan.
  maintenance.get(db)?.wake();
}
