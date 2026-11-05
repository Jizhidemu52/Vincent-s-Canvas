import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, rmdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileTypeFromBuffer } from "file-type";
import type { Cache, Database } from "./db";
import type { ObjectStorage } from "./object-storage";
import { isMissingAssetObject } from "./asset-object-error";
import { createTemporaryMediaFile } from "./media-file";

const version = "v1";
const lockKey = `asset-video-playback:${version}:lock`;
const maxBytes = 200 * 1024 * 1024;
const jobTimeoutMs = 120_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const formats = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm";
const processLimits = ["-v", "error", "-max_alloc", "134217728", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", formats];

export class VideoPreviewError extends Error {
  constructor(readonly status: 404 | 422 | 503, readonly code: string, message: string) { super(message); }
}
const unavailable = () => new VideoPreviewError(503, "VIDEO_PREVIEW_UNAVAILABLE", "兼容预览暂时不可用，原视频仍可下载；请稍后重新读取。");
const changed = () => new VideoPreviewError(503, "VIDEO_PREVIEW_SOURCE_CHANGED", "原视频或访问权限已变化，请重新读取当前记录。");
const invalid = (message: string) => new VideoPreviewError(422, "VIDEO_PREVIEW_UNSUPPORTED", `${message}；请下载原视频播放。`);

export type VideoPlaybackAsset = { id: string; owner_user_id: string; object_key: string; filename: string; byte_size: number | string };
export type VideoPlaybackMetadata = { width: number; height: number; durationMs: number; frames: number; frameRate: string };
type Source = { key: string; etag: string; length: number; fingerprint: string };
type Ready = { status: "ready"; kind: "original" | "derived"; objectKey: string; etag: string; length: number; metadata: VideoPlaybackMetadata };
type Failure = { status: "failed"; code: string; message: string; httpStatus: 422 | 503 };
export type VideoPlaybackResult = { status: "pending" } | (Ready & { source: Source });
export interface AssetVideoPreviewService {
  read(asset: VideoPlaybackAsset, signal?: AbortSignal, start?: boolean): Promise<VideoPlaybackResult>;
  verify(asset: VideoPlaybackAsset, source: Source, signal?: AbortSignal): Promise<void>;
  invalidate(asset: { id: string; owner_user_id: string; object_key: string }, reason: "deleted" | "repaired"): void;
  stop(): Promise<void>;
}

function prefix(id: string) {
  if (!uuid.test(id)) throw invalid("视频素材标识无效");
  return `derived/video-playback/${version}/${id.toLowerCase()}/`;
}
function derivedKey(id: string, fingerprint: string, token: string) { return `${prefix(id)}${fingerprint}-${token}.mp4`; }
function ownedKey(id: string, key: string) {
  return key.startsWith(prefix(id)) && /^[0-9a-f]{64}-[0-9a-f-]{36}\.mp4$/.test(key.slice(prefix(id).length));
}
function stateKey(id: string, source: Source) { return `asset-video-playback:${version}:${id}:${source.fingerprint}`; }
function sourceFrom(asset: VideoPlaybackAsset, info: { ETag?: string; ContentLength?: number }): Source {
  const length = info.ContentLength;
  if (!info.ETag || !Number.isSafeInteger(length) || !length || length < 0) throw unavailable();
  if (length > maxBytes) throw invalid("原视频超过 200MB 的兼容预览限制");
  if (length !== Number(asset.byte_size)) throw changed();
  const key = asset.object_key, etag = info.ETag;
  return { key, etag, length, fingerprint: createHash("sha256").update(JSON.stringify([version, key, etag, length])).digest("hex") };
}
function boundedSignal(signal?: AbortSignal, timeout = 10_000) {
  const deadline = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
function metadataValid(value: unknown): value is VideoPlaybackMetadata {
  const data = value as VideoPlaybackMetadata | undefined;
  return Boolean(data && Number.isInteger(data.width) && data.width > 0 && data.width <= 4096
    && Number.isInteger(data.height) && data.height > 0 && data.height <= 4096
    && data.width * data.height <= 8_294_400 && Number.isFinite(data.durationMs) && data.durationMs > 0 && data.durationMs <= 90_000
    && Number.isInteger(data.frames) && data.frames > 0 && data.frames <= 5400 && typeof data.frameRate === "string");
}

function run(tool: "ffmpeg" | "ffprobe", args: string[], signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(process.env[tool === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"] || tool, args,
      { encoding: "buffer", windowsHide: true, timeout: jobTimeoutMs, killSignal: "SIGKILL", maxBuffer: 128 * 1024, signal },
      (error, stdout) => {
        if (!error) { resolve(stdout); return; }
        reject(typeof error.code === "number" && !error.killed && !signal.aborted
          ? invalid(tool === "ffprobe" ? "视频内容无法解析" : "视频无法转换为兼容预览") : unavailable());
      });
  });
}
type Probe = { metadata: VideoPlaybackMetadata; compatible: boolean; copyAudio: boolean; videoDurationMs: number };
function fraction(value: unknown) {
  if (typeof value !== "string" || !/^\d+\/\d+$/.test(value)) return NaN;
  const [a, b] = value.split("/").map(Number);
  return b ? a! / b : NaN;
}
async function probe(file: string, signal: AbortSignal): Promise<Probe> {
  // Check declared dimensions/duration before decoding the entire frame sequence.
  const info = JSON.parse((await run("ffprobe", [...processLimits, "-show_entries",
    "stream=codec_type,codec_name,profile,pix_fmt,width,height,duration,avg_frame_rate:stream_tags=rotate:stream_side_data=rotation:format=format_name,duration", "-of", "json", file], signal)).toString());
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const videos = streams.filter((stream: any) => stream.codec_type === "video"), audios = streams.filter((stream: any) => stream.codec_type === "audio");
  if (videos.length !== 1 || audios.length > 1 || streams.some((stream: any) => !["video", "audio"].includes(stream.codec_type))) throw invalid("此视频的多轨道结构暂不支持兼容预览");
  const video = videos[0], audio = audios[0], frameRate = video.avg_frame_rate;
  const durationMs = Math.round(Number(info.format?.duration) * 1000);
  const metadata = { width: Number(video.width), height: Number(video.height), durationMs, frames: 1, frameRate };
  const fps = fraction(frameRate);
  if (!metadataValid(metadata) || metadata.width % 2 || metadata.height % 2 || !Number.isFinite(fps) || fps <= 0 || fps > 60) throw invalid("视频尺寸、帧率或时长超过兼容预览限制（4096px、829万像素、60fps、90秒）");
  if (Number(video.tags?.rotate || 0) % 360 || video.side_data_list?.some((item: any) => Number(item.rotation || 0) % 360)) throw invalid("带旋转标记的视频暂不转换，避免改变原画面");
  const counted = JSON.parse((await run("ffprobe", [...processLimits, "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "json", file], signal)).toString());
  metadata.frames = Number(counted.streams?.[0]?.nb_read_frames);
  if (!metadataValid(metadata)) throw invalid("视频帧数无效或超过兼容预览限制");
  const copyAudio = !audio || audio.codec_name === "aac" && audio.profile === "LC";
  const compatible = String(info.format?.format_name).split(",").includes("mp4") && video.codec_name === "h264"
    && video.pix_fmt === "yuv420p" && ["Constrained Baseline", "Baseline", "Main", "High"].includes(video.profile) && copyAudio;
  return { metadata, compatible, copyAudio, videoDurationMs: Math.round(Number(video.duration || info.format?.duration) * 1000) };
}

/** Only local, bounded input paths are passed to ffmpeg. Never changes the input. */
export async function prepareVideoPlayback(input: string, output: string, signal: AbortSignal) {
  const inputSize = (await stat(input)).size;
  if (!inputSize || inputSize > maxBytes) throw invalid("原视频超过 200MB 的兼容预览限制");
  const handle = await open(input, "r");
  let mime: string | undefined;
  try { const head = Buffer.alloc(8192); const { bytesRead } = await handle.read(head, 0, head.length, 0); mime = (await fileTypeFromBuffer(head.subarray(0, bytesRead)))?.mime; }
  finally { await handle.close(); }
  if (!["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"].includes(mime || "")) throw invalid("视频容器格式不支持兼容预览");
  const source = await probe(input, signal);
  if (mime === "video/mp4" && source.compatible) return { kind: "original" as const, metadata: source.metadata };
  await run("ffmpeg", ["-nostdin", ...processLimits, "-noautorotate", "-i", input, "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20",
    "-threads", "1", "-filter_threads", "1", "-fps_mode", "passthrough", "-c:a", source.copyAudio ? "copy" : "aac",
    ...(!source.copyAudio ? ["-profile:a", "aac_low", "-b:a", "192k"] : []), "-movflags", "+faststart", "-fs", String(maxBytes + 1), "-f", "mp4", output], signal);
  const size = (await stat(output)).size;
  if (!size || size > maxBytes) throw invalid("兼容视频超过 200MB 输出限制");
  const result = await probe(output, signal);
  if (!result.compatible || result.metadata.width !== source.metadata.width || result.metadata.height !== source.metadata.height
    || result.metadata.frames !== source.metadata.frames || Math.abs(fraction(result.metadata.frameRate) - fraction(source.metadata.frameRate)) > 0.001
    || Math.abs(result.videoDurationMs - source.videoDurationMs) > Math.max(50, 1000 / fraction(source.metadata.frameRate))
    || Math.abs(result.metadata.durationMs - source.metadata.durationMs) > 100) throw invalid("兼容视频未通过完整性检查，未替换原视频");
  return { kind: "derived" as const, metadata: result.metadata, byteSize: size };
}

const acquire = `-- video-preview-acquire
if redis.call('SET',KEYS[1],ARGV[1],'NX','PX',ARGV[2]) then return 1 end
return 0`;
const owned = `-- video-preview-owned
if redis.call('GET',KEYS[1])==ARGV[1] and redis.call('PTTL',KEYS[1])>1000 then return 1 end
return 0`;
const publish = `-- video-preview-publish
if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('PTTL',KEYS[1])<=1000 then return 0 end
redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[3])
return 1`;
const release = `-- video-preview-release
if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end
return 0`;
const unpublish = `-- video-preview-unpublish
if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end
return 0`;

/** On-demand cache only: no database writes, persisted queue, scans or model calls. */
export function createAssetVideoPreviewService(db: Database, cache: Cache, storage: ObjectStorage, options: {
  prepare?: typeof prepareVideoPlayback; timeoutMs?: number; log?: (event: string, detail: Record<string, unknown>) => void;
} = {}): AssetVideoPreviewService {
  const prepare = options.prepare || prepareVideoPlayback;
  const timeout = Math.min(jobTimeoutMs, Math.max(10, options.timeoutMs ?? jobTimeoutMs));
  const leaseMs = timeout + 60_000;
  const log = options.log || ((event, detail) => console.warn(JSON.stringify({ event, ...detail })));
  const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const cleanups = new Set<Promise<void>>();
  const cleanupController = new AbortController();
  let stopping = false;
  let stopPromise: Promise<void> | undefined;

  const source = async (asset: VideoPlaybackAsset, signal?: AbortSignal) => {
    try { return sourceFrom(asset, await storage.head(asset.object_key, { abortSignal: boundedSignal(signal) })); }
    catch (error) {
      if (error instanceof VideoPreviewError || signal?.aborted) throw error;
      throw isMissingAssetObject(error) ? new VideoPreviewError(404, "VIDEO_ORIGINAL_MISSING", "原视频文件暂时不可用，未重新生成或替换原件。") : unavailable();
    }
  };
  const currentAsset = async (asset: VideoPlaybackAsset) => {
    const result = await db.query<VideoPlaybackAsset>("SELECT id,owner_user_id,object_key,filename,byte_size FROM assets WHERE id=$1 AND owner_user_id=$2 AND kind='video' AND status='ready' AND deleted_at IS NULL", [asset.id, asset.owner_user_id]);
    return result.rows[0];
  };
  const verify = async (asset: VideoPlaybackAsset, expected: Source, signal?: AbortSignal) => {
    if (asset.object_key !== expected.key || (await source(asset, signal)).fingerprint !== expected.fingerprint) throw changed();
  };
  const stillCurrent = async (asset: VideoPlaybackAsset, expected: Source, signal: AbortSignal) => {
    signal.throwIfAborted();
    const current = await currentAsset(asset);
    if (!current) throw changed();
    await verify(current, expected, signal);
  };
  const assertOwned = async (token: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (Number(await cache.eval(owned, { keys: [lockKey], arguments: [token] })) !== 1) throw changed();
    signal.throwIfAborted();
  };
  const cleanup = async (id: string, guard: () => Promise<void>, retain?: string) => {
    const signal = boundedSignal(cleanupController.signal);
    let cursor: string | undefined;
    let pages = 0;
    do {
      await guard();
      const page = await storage.listKeys(prefix(id), { abortSignal: signal, continuationToken: cursor, maxKeys: 100 });
      await guard();
      for (const key of page.keys) if (!(retain && key.startsWith(retain)) && ownedKey(id, key)) { await guard(); await storage.remove(key, { abortSignal: signal }); }
      cursor = page.nextToken;
      if (++pages > 10 && cursor) throw new Error("视频预览精确清理达到单次上限，需稍后重试");
    } while (cursor);
  };
  const trackedCleanup = (id: string, work: () => Promise<void>) => {
    const promise = work().catch(() => log("video_preview.cleanup_failed", { assetId: id, recoverable: true }))
      .finally(() => cleanups.delete(promise));
    cleanups.add(promise);
  };

  async function build(asset: VideoPlaybackAsset, snapshot: Source, token: string, controller: AbortController) {
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(new Error("兼容预览处理超时")), timeout); timer.unref();
    let input: Awaited<ReturnType<typeof createTemporaryMediaFile>> | undefined;
    let directory: string | undefined;
    let output: string | undefined;
    let stagedKey: string | undefined;
    let publishedState: string | undefined;
    try {
      await assertOwned(token, signal);
      await stillCurrent(asset, snapshot, signal);
      const object = await storage.get(snapshot.key, { ifMatch: snapshot.etag, abortSignal: signal });
      if (!object.Body || object.ContentLength !== snapshot.length || object.ETag !== snapshot.etag) { (object.Body as Readable | undefined)?.destroy(); throw changed(); }
      input = await createTemporaryMediaFile(object.Body as Readable, { expectedBytes: snapshot.length, maxBytes, signal, prefix: "canvas-video-original-" });
      directory = await mkdtemp(join(tmpdir(), "canvas-video-preview-"));
      output = join(directory, "playback.mp4");
      const prepared = await prepare(input.path, output, signal);
      signal.throwIfAborted();
      await assertOwned(token, signal);
      await stillCurrent(asset, snapshot, signal);
      let ready: Ready;
      if (prepared.kind === "original") ready = { status: "ready", kind: "original", objectKey: snapshot.key, etag: snapshot.etag, length: snapshot.length, metadata: prepared.metadata };
      else {
        stagedKey = derivedKey(asset.id, snapshot.fingerprint, token);
        await storage.putFile(stagedKey, output, prepared.byteSize, "video/mp4", { abortSignal: signal });
        await assertOwned(token, signal);
        await stillCurrent(asset, snapshot, signal);
        const result = await storage.head(stagedKey, { abortSignal: signal });
        if (!result.ETag || result.ContentLength !== prepared.byteSize) throw unavailable();
        ready = { status: "ready", kind: "derived", objectKey: stagedKey, etag: result.ETag, length: prepared.byteSize, metadata: prepared.metadata };
      }
      // Unique owner keys are not discoverable playback URLs. Only this atomic,
      // owner-fenced cache publication makes a staged object eligible for reads.
      signal.throwIfAborted();
      publishedState = JSON.stringify({ ...ready, owner: token });
      if (Number(await cache.eval(publish, { keys: [lockKey, stateKey(asset.id, snapshot)], arguments: [token, publishedState, "86400"] })) !== 1) throw changed();
      await stillCurrent(asset, snapshot, signal);
      // Keep the global lease while clearing older copies. Cleanup cannot race
      // a newer owner producing another rendition after this lease is released.
      await cleanup(asset.id, () => assertOwned(token, signal), stagedKey).catch(() => log("video_preview.cleanup_failed", { assetId: asset.id, recoverable: true }));
    } catch (error) {
      // Compare the exact owner-tagged value, even if a Redis response arrived
      // after this lease expired. Never remove a newer publisher's ready state.
      if (publishedState) await cache.eval(unpublish, { keys: [stateKey(asset.id, snapshot)], arguments: [publishedState] }).catch(() => undefined);
      if (stagedKey) await storage.remove(stagedKey, { abortSignal: AbortSignal.timeout(10_000) }).catch(() => log("video_preview.cleanup_failed", { assetId: asset.id, recoverable: true }));
      const failure = error instanceof VideoPreviewError && error.status === 422 ? error : unavailable();
      if (!stopping) await cache.eval(publish, { keys: [lockKey, stateKey(asset.id, snapshot)], arguments: [token,
        JSON.stringify({ status: "failed", code: failure.code, message: failure.message, httpStatus: failure.status === 422 ? 422 : 503 } satisfies Failure), "60"] }).catch(() => undefined);
      log("video_preview.failed", { assetId: asset.id, code: failure.code, cancelled: signal.aborted });
    } finally {
      clearTimeout(timer);
      if (output) await unlink(output).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") log("video_preview.temp_cleanup_failed", { assetId: asset.id }); });
      if (directory) await rmdir(directory).catch(() => log("video_preview.temp_cleanup_failed", { assetId: asset.id }));
      await input?.dispose().catch(() => log("video_preview.temp_cleanup_failed", { assetId: asset.id }));
      await cache.eval(release, { keys: [lockKey], arguments: [token] }).catch(() => undefined);
    }
  }

  const service: AssetVideoPreviewService = {
    async read(asset, signal, start = true) {
      if (stopping || !storage.configured) throw unavailable();
      prefix(asset.id);
      const snapshot = await source(asset, signal);
      let cached: Ready | Failure | undefined;
      let cachedValue: string | undefined;
      try { const raw = await cache.get(stateKey(asset.id, snapshot)); if (raw) { cachedValue = raw; cached = JSON.parse(raw); } }
      catch { throw unavailable(); }
      if (cached?.status === "failed") throw new VideoPreviewError(cached.httpStatus === 422 ? 422 : 503, cached.code, cached.message);
      if (cached?.status === "ready" && metadataValid(cached.metadata) && Number.isSafeInteger(cached.length) && cached.length > 0 && cached.length <= maxBytes
        && typeof cached.etag === "string" && (cached.kind === "original" ? cached.objectKey === snapshot.key && cached.etag === snapshot.etag && cached.length === snapshot.length
          : cached.kind === "derived" && ownedKey(asset.id, cached.objectKey) && cached.objectKey.startsWith(`${prefix(asset.id)}${snapshot.fingerprint}-`))) {
        if (cached.kind === "original") return { ...cached, source: snapshot };
        try {
          const info = await storage.head(cached.objectKey, { abortSignal: boundedSignal(signal) });
          if (info.ETag === cached.etag && info.ContentLength === cached.length) return { ...cached, source: snapshot };
        } catch (error) { if (signal?.aborted) throw error; if (!isMissingAssetObject(error)) throw unavailable(); }
        if (cachedValue) await cache.eval(unpublish, { keys: [stateKey(asset.id, snapshot)], arguments: [cachedValue] });
      }
      if (!start || active.size) return { status: "pending" };
      const token = randomUUID();
      let acquired: unknown;
      try { acquired = await cache.eval(acquire, { keys: [lockKey], arguments: [token, String(leaseMs)] }); }
      catch { throw unavailable(); }
      if (Number(acquired) !== 1) return { status: "pending" };
      if (stopping || signal?.aborted) { await cache.eval(release, { keys: [lockKey], arguments: [token] }).catch(() => undefined); throw unavailable(); }
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => build(asset, snapshot, token, controller))
        .catch(() => log("video_preview.failed", { assetId: asset.id, code: "VIDEO_PREVIEW_UNAVAILABLE" }))
        .finally(() => active.delete(asset.id));
      active.set(asset.id, { controller, promise });
      return { status: "pending" };
    },
    verify,
    invalidate(asset, reason) {
      if (stopping || !uuid.test(asset.id)) return;
      active.get(asset.id)?.controller.abort(new Error("原视频状态已变化"));
      trackedCleanup(asset.id, async () => {
        await active.get(asset.id)?.promise;
        // Wait boundedly for another video's conversion, without replaying the
        // business deletion. Shutdown aborts this preview-only housekeeping.
        const token = randomUUID();
        const deadline = Date.now() + leaseMs + 10_000;
        while (Number(await cache.eval(acquire, { keys: [lockKey], arguments: [token, "60000"] })) !== 1) {
          if (Date.now() >= deadline) throw new Error("视频预览精确清理等待超时");
          await delay(250, undefined, { signal: cleanupController.signal });
        }
        try {
          cleanupController.signal.throwIfAborted();
          const result = await db.query<VideoPlaybackAsset & { deleted_at: string | null }>("SELECT id,object_key,owner_user_id,filename,byte_size,deleted_at FROM assets WHERE id=$1", [asset.id]);
          const current = result.rows[0];
          if (!current || current.object_key !== asset.object_key || current.owner_user_id !== asset.owner_user_id
            || reason === "deleted" && !current.deleted_at || reason === "repaired" && current.deleted_at) return;
          // A newer instance may already have converted the repaired source
          // while this cleanup was waiting. Keep that current fingerprint.
          const retain = reason === "repaired" ? `${prefix(asset.id)}${(await source(current, cleanupController.signal)).fingerprint}-` : undefined;
          await cleanup(asset.id, () => assertOwned(token, cleanupController.signal), retain);
        } finally { await cache.eval(release, { keys: [lockKey], arguments: [token] }).catch(() => undefined); }
      });
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      cleanupController.abort(new Error("服务关闭，预览清理已停止"));
      for (const job of active.values()) job.controller.abort(new Error("服务关闭，兼容预览已停止"));
      stopPromise = (async () => { await Promise.all([...active.values()].map(job => job.promise)); await Promise.all([...cleanups]); })();
      return stopPromise;
    },
  };
  return service;
}
