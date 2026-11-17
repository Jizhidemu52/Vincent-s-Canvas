import { createHash } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { request as expressRequest, type Request as ExpressRequest } from "express";
import { assetRange, assetResponseHeaders, matchesAssetEtag } from "./asset-delivery";
import { prepareVideoPlayback, VideoPreviewError, type VideoPlaybackMetadata } from "./asset-video-preview";
import { demoAssetByteLength } from "./demo-state-store";
import { createTemporaryMediaFile } from "./media-file";

type Asset = { id: string; ownerUserId: string; deletedAt?: string | null; mimeType: string; filename: string; bytes: Uint8Array };
type ReadAllowed = () => Asset | undefined;
type Source = { key: string; bytes: Uint8Array; filename: string };
type Ready = { kind: "ready"; bytes?: Buffer; etag: string; metadata: VideoPlaybackMetadata };
type Entry = { source: string; expiresAt: number } & (Ready | { kind: "failed"; error: VideoPreviewError });
const maxBytes = 200 * 1024 * 1024;
const unavailable = () => new VideoPreviewError(503, "VIDEO_PREVIEW_UNAVAILABLE", "兼容预览暂时不可用，原视频仍可下载；请稍后重新读取。");
const changed = () => new VideoPreviewError(503, "VIDEO_PREVIEW_SOURCE_CHANGED", "原视频或访问权限已变化，请重新读取当前记录。");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function source(readAllowed: ReadAllowed): Source {
  const asset = readAllowed();
  if (!asset || asset.deletedAt || !asset.mimeType.startsWith("video/")) throw new VideoPreviewError(404, "NOT_FOUND", "视频素材不存在或无权访问");
  const size = demoAssetByteLength(asset);
  if (!size) throw new VideoPreviewError(404, "VIDEO_ORIGINAL_MISSING", "原视频文件暂时不可用，未重新生成或替换原件。");
  if (size > maxBytes) throw new VideoPreviewError(422, "VIDEO_PREVIEW_UNSUPPORTED", "原视频超过 200MB 的兼容预览限制；请下载原视频播放。");
  const bytes = asset.bytes;
  if (bytes.byteLength !== size) throw changed();
  return { key: JSON.stringify([asset.id, asset.ownerUserId, asset.mimeType, size, digest(bytes)]), bytes, filename: asset.filename };
}

function rangeRequest(request: Request): ExpressRequest {
  return Object.assign(Object.create(expressRequest), { method: request.method, headers: Object.fromEntries(request.headers) });
}

export function createDemoVideoPlayback(options: { prepare?: typeof prepareVideoPlayback; maxCacheBytes?: number; maxEntries?: number; timeoutMs?: number } = {}) {
  const prepare = options.prepare ?? prepareVideoPlayback;
  const cache = new Map<string, Entry>();
  const cacheLimit = Math.max(1, Math.min(256 * 1024 * 1024, options.maxCacheBytes ?? 256 * 1024 * 1024));
  const entryLimit = Math.max(1, Math.min(8, options.maxEntries ?? 8));
  let active: { promise: Promise<void>; controller: AbortController } | undefined;
  let stopping = false;
  const pending = () => new Response(null, { status: 202, headers: { "Cache-Control": "no-store", "Retry-After": "3", Vary: "Cookie" } });
  const publish = (id: string, entry: Entry) => {
    cache.delete(id);
    cache.set(id, entry);
    const size = () => [...cache.values()].reduce((total, item) => total + (item.kind === "ready" ? item.bytes?.byteLength ?? 0 : 0), 0);
    while (cache.size > entryLimit || size() > cacheLimit) cache.delete(cache.keys().next().value!);
  };
  const verify = (readAllowed: ReadAllowed, expected: Source) => {
    const current = source(readAllowed);
    if (current.key !== expected.key) throw changed();
    return current;
  };
  async function build(id: string, snapshot: Source, readAllowed: ReadAllowed, signal: AbortSignal) {
    let input: Awaited<ReturnType<typeof createTemporaryMediaFile>> | undefined;
    let output: string | undefined;
    try {
      signal.throwIfAborted();
      verify(readAllowed, snapshot);
      input = await createTemporaryMediaFile((async function* () { yield snapshot.bytes; })(), { expectedBytes: snapshot.bytes.byteLength, maxBytes, signal, prefix: "canvas-demo-playback-" });
      output = join(dirname(input.path), "playback.mp4");
      const prepared = await prepare(input.path, output, signal);
      signal.throwIfAborted();
      verify(readAllowed, snapshot);
      let bytes: Buffer | undefined;
      if (prepared.kind === "derived") {
        const length = (await stat(output)).size;
        if (!length || length > maxBytes || length > cacheLimit || length !== prepared.byteSize) throw unavailable();
        bytes = await readFile(output);
        if (bytes.byteLength !== length) throw unavailable();
      }
      signal.throwIfAborted();
      verify(readAllowed, snapshot);
      publish(id, { kind: "ready", source: snapshot.key, bytes, etag: `"${digest(bytes ?? snapshot.bytes)}"`, metadata: prepared.metadata, expiresAt: Date.now() + 60 * 60_000 });
    } catch (error) {
      if (!stopping) {
        try {
          verify(readAllowed, snapshot);
          publish(id, { kind: "failed", source: snapshot.key, expiresAt: Date.now() + 60_000, error: error instanceof VideoPreviewError ? error : unavailable() });
        } catch { cache.delete(id); }
      }
    } finally {
      if (output) await unlink(output).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") console.warn("Demo playback cleanup failed"); });
      await input?.dispose().catch(() => console.warn("Demo playback cleanup failed"));
    }
  }
  return {
    async respond(id: string, request: Request, readAllowed: ReadAllowed) {
      try {
        request.signal.throwIfAborted();
        const current = source(readAllowed);
        if (stopping) throw unavailable();
        let cached = cache.get(id);
        if (cached && (cached.source !== current.key || cached.expiresAt <= Date.now())) { cache.delete(id); cached = undefined; }
        if (!cached) {
          if (request.method === "GET" && !active) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), Math.min(120_000, Math.max(10, options.timeoutMs ?? 120_000))); timer.unref();
            const promise = build(id, current, readAllowed, controller.signal).finally(() => { clearTimeout(timer); active = undefined; });
            active = { promise, controller };
          }
          return pending();
        }
        cache.delete(id); cache.set(id, cached);
        if (cached.kind === "failed") throw cached.error;
        const latest = verify(readAllowed, current);
        request.signal.throwIfAborted();
        const bytes = cached.bytes ?? latest.bytes;
        const headers = new Headers({ ...assetResponseHeaders("video/mp4", `${latest.filename}.playback.mp4`, false), "cache-control": "no-store", Vary: "Cookie", ETag: cached.etag,
          "Accept-Ranges": "bytes", "X-Canvas-Media-Width": String(cached.metadata.width), "X-Canvas-Media-Height": String(cached.metadata.height), "X-Canvas-Media-Duration-Ms": String(cached.metadata.durationMs) });
        if (matchesAssetEtag(request.headers.get("if-none-match") ?? undefined, cached.etag)) return new Response(null, { status: 304, headers });
        const range = assetRange(rangeRequest(request), bytes.byteLength, cached.etag);
        if (range === -1) { headers.set("Content-Range", `bytes */${bytes.byteLength}`); return new Response(null, { status: 416, headers }); }
        const body = range ? bytes.subarray(range.start, range.end + 1) : bytes;
        headers.set("Content-Length", String(body.byteLength));
        if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${bytes.byteLength}`);
        return new Response(request.method === "HEAD" ? null : new Uint8Array(body), { status: range ? 206 : 200, headers });
      } catch (error) {
        const failure = error instanceof VideoPreviewError ? error : unavailable();
        return Response.json({ error: failure.code, message: failure.message }, { status: failure.status, headers: { "Cache-Control": "no-store", Vary: "Cookie" } });
      }
    },
    async stop() { stopping = true; active?.controller.abort(); await active?.promise; cache.clear(); },
  };
}
