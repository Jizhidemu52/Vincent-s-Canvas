import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import type { Cache, Database } from "../../src/db";
import type { ObjectStorage, ObjectReadOptions } from "../../src/object-storage";
import type { VideoPlaybackAsset } from "../../src/asset-video-preview";

export const playbackMetadata = { width: 160, height: 224, durationMs: 1000, frames: 24, frameRate: "24/1" };
export const playbackBytes = Buffer.alloc(16_384, 0x61);
Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex").copy(playbackBytes);
export function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
export async function until(condition: () => boolean, message = "playback job completion") {
  const end = Date.now() + 2500;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Timed out: ${message}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
export function playbackFixture() {
  const asset: VideoPlaybackAsset = { id: "10000000-0000-4000-8000-000000000001", owner_user_id: "20000000-0000-4000-8000-000000000001", object_key: "private/original.mp4", filename: "original.mp4", byte_size: playbackBytes.length };
  const current = { ...asset, deleted_at: null as string | null };
  const objects = new Map<string, { bytes: Buffer; etag: string }>([[asset.object_key, { bytes: Buffer.from(playbackBytes), etag: '"original"' }]]);
  const entries = new Map<string, { value: string; expires: number }>();
  const calls = { heads: [] as string[], gets: [] as { key: string; options: ObjectReadOptions }[], puts: [] as string[], removes: [] as string[], lists: [] as string[], sql: [] as string[], logs: [] as unknown[] };
  const hooks = { head: undefined as ((key: string) => Promise<void>) | undefined, get: undefined as ((key: string) => Promise<void>) | undefined, put: undefined as ((key: string) => Promise<void>) | undefined };
  const get = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.expires <= Date.now()) { entries.delete(key); return undefined; }
    return entry;
  };
  const cache = {
    get: async (key: string) => get(key)?.value ?? null,
    del: async (key: string) => Number(entries.delete(key)),
    eval: async (script: string, options: { keys: string[]; arguments: string[] }) => {
      const [lock, state] = options.keys, [token, value, ttl] = options.arguments;
      if (script.includes("video-preview-acquire")) {
        if (get(lock!)) return 0;
        entries.set(lock!, { value: token!, expires: Date.now() + Number(value) }); return 1;
      }
      const entry = get(lock!);
      if (script.includes("video-preview-release") || script.includes("video-preview-unpublish")) return entry?.value === token ? Number(entries.delete(lock!)) : 0;
      if (entry?.value !== token || entry.expires - Date.now() <= 1000) return 0;
      if (script.includes("video-preview-owned")) return 1;
      if (script.includes("video-preview-publish")) { entries.set(state!, { value: value!, expires: Date.now() + Number(ttl) * 1000 }); return 1; }
      throw new Error("Unexpected cache script");
    },
  } as unknown as Cache;
  const missing = () => Object.assign(new Error("fixture missing"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
  const storage = {
    configured: true,
    head: async (key: string, options: ObjectReadOptions = {}) => {
      options.abortSignal?.throwIfAborted(); calls.heads.push(key); await hooks.head?.(key);
      const object = objects.get(key); if (!object) throw missing();
      return { ETag: object.etag, ContentLength: object.bytes.length, LastModified: new Date("2026-11-01T00:00:00Z") };
    },
    get: async (key: string, options: ObjectReadOptions = {}) => {
      options.abortSignal?.throwIfAborted(); calls.gets.push({ key, options }); await hooks.get?.(key);
      const object = objects.get(key); if (!object) throw missing();
      if (options.ifMatch && options.ifMatch !== object.etag) throw Object.assign(new Error("fixture changed"), { $metadata: { httpStatusCode: 412 } });
      const match = options.range?.match(/^bytes=(\d+)-(\d+)$/), start = match ? Number(match[1]) : 0, end = match ? Number(match[2]) : object.bytes.length - 1;
      return { ETag: object.etag, ContentLength: end - start + 1, ContentRange: match ? `bytes ${start}-${end}/${object.bytes.length}` : undefined, Body: Readable.from([object.bytes.subarray(start, end + 1)]) };
    },
    putFile: async (key: string, path: string, _length: number, _mime: string, options: ObjectReadOptions = {}) => {
      options.abortSignal?.throwIfAborted(); calls.puts.push(key);
      objects.set(key, { bytes: await readFile(path), etag: '"derived"' }); await hooks.put?.(key);
    },
    remove: async (key: string) => { calls.removes.push(key); objects.delete(key); },
    listKeys: async (prefix: string) => { calls.lists.push(prefix); return { keys: [...objects.keys()].filter(key => key.startsWith(prefix)), nextToken: undefined }; },
  } as unknown as ObjectStorage;
  const db = { query: async (sql: string) => {
    calls.sql.push(sql);
    return { rows: sql.includes("deleted_at IS NULL") && current.deleted_at ? [] : [{ ...current }] };
  } } as unknown as Database;
  return { asset, current, objects, entries, calls, hooks, cache, storage, db, lockKey: "asset-video-playback:v1:lock", log: (_event: string, detail: unknown) => { calls.logs.push(detail); } };
}
