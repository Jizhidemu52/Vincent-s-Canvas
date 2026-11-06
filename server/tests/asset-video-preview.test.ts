import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssetVideoPreviewService, prepareVideoPlayback, VideoPreviewError } from "../src/asset-video-preview";
import { deferred, playbackBytes, playbackFixture, playbackMetadata, until } from "./helpers/video-playback";

const fakePrepare: typeof prepareVideoPlayback = async (_input, output) => {
  await writeFile(output, playbackBytes); return { kind: "derived", metadata: playbackMetadata, byteSize: playbackBytes.length };
};
const states = (fixture: ReturnType<typeof playbackFixture>) => [...fixture.entries.entries()].filter(([key]) => key !== fixture.lockKey).map(([, entry]) => JSON.parse(entry.value));

test("one on-demand job publishes a versioned source-bound preview; cache reads never replace original", async () => {
  const f = playbackFixture(), gate = deferred(); let runs = 0, inputPath = "";
  const service = createAssetVideoPreviewService(f.db, f.cache, f.storage, { log: f.log, prepare: async (input, output, signal) => {
    runs++; inputPath = input; await gate.promise; return fakePrepare(input, output, signal);
  } });
  try {
    expect(await service.read(f.asset, undefined, false)).toEqual({ status: "pending" });
    expect(runs).toBe(0); expect(f.entries.size).toBe(0);
    expect(await service.read(f.asset)).toEqual({ status: "pending" });
    await until(() => runs === 1);
    expect(await Promise.all(Array.from({ length: 15 }, () => service.read(f.asset)))).toEqual(Array(15).fill({ status: "pending" }));
    gate.resolve(); await until(() => !f.entries.has(f.lockKey));
    const ready = await service.read(f.asset);
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") throw new Error("not ready");
    expect(ready.kind).toBe("derived"); expect(ready.metadata).toEqual(playbackMetadata);
    expect(ready.objectKey).toMatch(/^derived\/video-playback\/v1\/.*\/[0-9a-f]{64}-[0-9a-f-]{36}\.mp4$/);
    expect(f.objects.get(f.asset.object_key)?.bytes).toEqual(playbackBytes); expect(f.current).toMatchObject(f.asset);
    expect(await readFile(inputPath).catch(() => null)).toBeNull();
    expect(await service.read(f.asset)).toEqual(ready); expect(runs).toBe(1); expect(f.calls.puts).toHaveLength(1);
    expect(f.calls.sql.every(sql => sql.startsWith("SELECT "))).toBe(true);
    await service.verify(f.asset, ready.source);
    f.objects.get(f.asset.object_key)!.etag = '"repaired"';
    await expect(service.verify(f.asset, ready.source)).rejects.toMatchObject({ status: 503, code: "VIDEO_PREVIEW_SOURCE_CHANGED" });
  } finally { gate.resolve(); await service.stop(); }
});

test("already compatible video uses original bytes without uploading a duplicate", async () => {
  const f = playbackFixture();
  const service = createAssetVideoPreviewService(f.db, f.cache, f.storage, { log: f.log, prepare: async () => ({ kind: "original", metadata: playbackMetadata }) });
  try {
    await service.read(f.asset); await until(() => !f.entries.has(f.lockKey));
    const ready = await service.read(f.asset);
    expect(ready).toMatchObject({ status: "ready", kind: "original", objectKey: f.asset.object_key, etag: '"original"' });
    expect(f.calls.puts).toEqual([]); expect(f.calls.removes).toEqual([]);
  } finally { await service.stop(); }
});

test("Redis lease serializes service instances and a lost owner cannot publish or release its successor", async () => {
  const f = playbackFixture(), gate = deferred(); let runs = 0;
  const first = createAssetVideoPreviewService(f.db, f.cache, f.storage, { log: f.log, prepare: async (input, output, signal) => { runs++; await gate.promise; return fakePrepare(input, output, signal); } });
  const second = createAssetVideoPreviewService(f.db, f.cache, f.storage, { log: f.log, prepare: fakePrepare });
  try {
    await first.read(f.asset); await until(() => runs === 1);
    expect(await second.read(f.asset)).toEqual({ status: "pending" });
    expect(f.calls.gets).toHaveLength(1);
    f.entries.set(f.lockKey, { value: "successor", expires: Date.now() + 60_000 });
    gate.resolve(); await until(() => f.calls.logs.length > 0);
    await first.stop();
    expect(f.entries.get(f.lockKey)?.value).toBe("successor"); expect(states(f)).toEqual([]); expect(f.calls.puts).toEqual([]);
  } finally { gate.resolve(); await Promise.all([first.stop(), second.stop()]); }
});

test.each(["changed", "deleted", "lost-after-upload"])("%s during conversion cannot publish stale bytes and cleans only its staged preview", async phase => {
  const f = playbackFixture(), gate = deferred(); let started = false;
  f.hooks.put = async () => { if (phase === "lost-after-upload") f.entries.set(f.lockKey, { value: "successor", expires: Date.now() + 60_000 }); };
  const service = createAssetVideoPreviewService(f.db, f.cache, f.storage, { log: f.log, prepare: async (input, output, signal) => { started = true; await gate.promise; return fakePrepare(input, output, signal); } });
  try {
    await service.read(f.asset); await until(() => started);
    if (phase === "changed") f.objects.get(f.asset.object_key)!.etag = '"new-source"';
    if (phase === "deleted") f.current.deleted_at = new Date().toISOString();
    gate.resolve(); await until(() => f.calls.logs.length > 0); await service.stop();
    expect(states(f).some(state => state.status === "ready")).toBe(false);
    expect([...f.objects.keys()]).toEqual([f.asset.object_key]);
    if (phase === "lost-after-upload") { expect(f.calls.puts).toHaveLength(1); expect(f.calls.removes).toEqual(f.calls.puts); }
    else expect(f.calls.puts).toEqual([]);
  } finally { gate.resolve(); await service.stop(); }
});

test.each(["deleted", "repaired"] as const)("%s invalidates only this asset's precisely-owned v1 derivatives", async reason => {
  const f = playbackFixture();
  const service = createAssetVideoPreviewService(f.db, f.cache, f.storage, { log: f.log, prepare: fakePrepare });
  try {
    await service.read(f.asset); await until(() => !f.entries.has(f.lockKey));
    const key = f.calls.puts[0]!;
    const unrelated = [key.replace(f.asset.id, "10000000-0000-4000-8000-000000000002"), key.replace("/v1/", "/v2/"), key.replace(/[^/]+$/, "unrelated.mp4")];
    for (const name of unrelated) f.objects.set(name, { bytes: playbackBytes, etag: '"keep"' });
    if (reason === "deleted") f.current.deleted_at = new Date().toISOString();
    else f.objects.get(f.asset.object_key)!.etag = '"restored-source"';
    service.invalidate(f.asset, reason); await until(() => f.calls.removes.includes(key)); await service.stop();
    expect(f.calls.removes).toEqual([key]);
    expect([...f.objects.keys()].sort()).toEqual([f.asset.object_key, ...unrelated].sort());
    expect(f.calls.lists.every(prefix => prefix === `derived/video-playback/v1/${f.asset.id}/`)).toBe(true);
  } finally { await service.stop(); }
});

test.each(["timeout", "stop"])("%s cancels processing, removes temporary input and releases owned lease", async mode => {
  const f = playbackFixture(); let path = "", aborted = false;
  const service = createAssetVideoPreviewService(f.db, f.cache, f.storage, { log: f.log, timeoutMs: mode === "timeout" ? 30 : 1000,
    prepare: async (input, _output, signal) => {
      path = input;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true }));
    },
  });
  await service.read(f.asset); await until(() => Boolean(path));
  if (mode === "stop") await service.stop();
  else await until(() => !f.entries.has(f.lockKey));
  expect(aborted).toBe(true); expect(await readFile(path).catch(() => null)).toBeNull();
  expect(f.entries.has(f.lockKey)).toBe(false); expect(f.calls.puts).toEqual([]);
  if (mode === "timeout") { expect(states(f)).toMatchObject([{ status: "failed", httpStatus: 503 }]); await expect(service.read(f.asset)).rejects.toMatchObject({ status: 503 }); }
  else expect(states(f)).toEqual([]);
  await service.stop();
});

test("failure cache is bounded; missing source, unavailable storage and invalid media stay distinct", async () => {
  const f = playbackFixture(); let runs = 0;
  const service = createAssetVideoPreviewService(f.db, f.cache, f.storage, { log: f.log, prepare: async () => { runs++; throw new VideoPreviewError(422, "VIDEO_PREVIEW_UNSUPPORTED", "synthetic invalid"); } });
  try {
    await service.read(f.asset); await until(() => !f.entries.has(f.lockKey));
    await expect(service.read(f.asset)).rejects.toMatchObject({ status: 422 }); expect(runs).toBe(1);
    const failure = [...f.entries.values()][0]!; expect(failure.expires - Date.now()).toBeLessThanOrEqual(60_000);
    f.objects.delete(f.asset.object_key); await expect(service.read(f.asset)).rejects.toMatchObject({ status: 404 });
    f.hooks.head = async () => { throw new Error("private backend details"); };
    await expect(service.read(f.asset)).rejects.toMatchObject({ status: 503, message: expect.not.stringContaining("private") });
  } finally { await service.stop(); }
});

test("source byte caps and recorded-size mismatch reject before any input download", async () => {
  const f = playbackFixture(), originalHead = f.storage.head.bind(f.storage);
  const service = createAssetVideoPreviewService(f.db, f.cache, f.storage, { log: f.log, prepare: fakePrepare });
  try {
    f.storage.head = async () => ({ $metadata: {}, ETag: '"huge"', ContentLength: 200 * 1024 * 1024 + 1 });
    await expect(service.read(f.asset)).rejects.toMatchObject({ status: 422 });
    f.storage.head = originalHead;
    await expect(service.read({ ...f.asset, byte_size: 1 })).rejects.toMatchObject({ status: 503, code: "VIDEO_PREVIEW_SOURCE_CHANGED" });
    expect(f.calls.gets).toEqual([]); expect(f.entries.size).toBe(0);
  } finally { await service.stop(); }
});

test("a delayed old publish response cannot delete the successor's ready cache or preview", async () => {
  const f = playbackFixture(), gate = deferred(); let publishedKey = "";
  const evaluate = f.cache.eval.bind(f.cache);
  f.cache.eval = (async (script: string, options: { keys: string[]; arguments: string[] }) => {
    const result = await evaluate(script, options);
    if (script.includes("video-preview-publish") && JSON.parse(options.arguments[1]!).status === "ready") { publishedKey = options.keys[1]!; await gate.promise; }
    return result;
  }) as typeof f.cache.eval;
  const service = createAssetVideoPreviewService(f.db, f.cache, f.storage, { log: f.log, timeoutMs: 50, prepare: fakePrepare });
  try {
    await service.read(f.asset); await until(() => Boolean(publishedKey));
    const successorKey = f.calls.puts[0]!.replace(/[^/]+$/, `${"a".repeat(64)}-30000000-0000-4000-8000-000000000003.mp4`);
    const successor = JSON.stringify({ ...JSON.parse(f.entries.get(publishedKey)!.value), objectKey: successorKey, owner: "successor" });
    f.objects.set(successorKey, { bytes: playbackBytes, etag: '"new"' });
    f.entries.set(publishedKey, { value: successor, expires: Date.now() + 60_000 });
    f.entries.set(f.lockKey, { value: "successor", expires: Date.now() + 60_000 });
    const stopping = service.stop(); gate.resolve(); await stopping;
    expect(f.entries.get(publishedKey)?.value).toBe(successor);
    expect(f.objects.has(successorKey)).toBe(true); expect(f.calls.removes).toEqual(f.calls.puts);
  } finally { gate.resolve(); await service.stop(); }
});

test("delete cleanup waits for the current global lease instead of permanently abandoning the owned derivative", async () => {
  const f = playbackFixture();
  const service = createAssetVideoPreviewService(f.db, f.cache, f.storage, { log: f.log, prepare: fakePrepare });
  try {
    await service.read(f.asset); await until(() => !f.entries.has(f.lockKey));
    const key = f.calls.puts[0]!;
    f.entries.set(f.lockKey, { value: "other-video", expires: Date.now() + 60_000 });
    f.current.deleted_at = new Date().toISOString(); service.invalidate(f.asset, "deleted");
    await new Promise(resolve => setTimeout(resolve, 25)); f.entries.delete(f.lockKey);
    await until(() => f.calls.removes.includes(key));
    expect(f.objects.has(f.asset.object_key)).toBe(true);
  } finally { await service.stop(); }
});

test("a stale preview HEAD cannot delete a newer owner's cache entry", async () => {
  const f = playbackFixture();
  const service = createAssetVideoPreviewService(f.db, f.cache, f.storage, { log: f.log, prepare: fakePrepare });
  try {
    await service.read(f.asset); await until(() => !f.entries.has(f.lockKey));
    const [key, old] = [...f.entries.entries()][0]!, original = JSON.parse(old.value);
    const successor = JSON.stringify({ ...original, owner: "successor", objectKey: original.objectKey.replace(/[^/]+$/, `${original.objectKey.split("/").at(-1)!.slice(0, 64)}-30000000-0000-4000-8000-000000000003.mp4`) });
    f.hooks.head = async requested => {
      if (requested !== original.objectKey) return;
      f.entries.set(key, { value: successor, expires: Date.now() + 60_000 });
      f.objects.get(requested)!.etag = '"old-object-changed"';
    };
    expect(await service.read(f.asset, undefined, false)).toEqual({ status: "pending" });
    expect(f.entries.get(key)?.value).toBe(successor);
  } finally { await service.stop(); }
});

test("repair cleanup preserves a current-source preview completed by another instance while waiting", async () => {
  const f = playbackFixture(), gate = deferred(); let started = false;
  const first = createAssetVideoPreviewService(f.db, f.cache, f.storage, { log: f.log, prepare: fakePrepare });
  const second = createAssetVideoPreviewService(f.db, f.cache, f.storage, { log: f.log, prepare: async (input, output, signal) => { started = true; await gate.promise; return fakePrepare(input, output, signal); } });
  try {
    await first.read(f.asset); await until(() => !f.entries.has(f.lockKey));
    const oldKey = f.calls.puts[0]!;
    f.objects.get(f.asset.object_key)!.etag = '"restored-source"';
    await second.read(f.asset); await until(() => started);
    first.invalidate(f.asset, "repaired"); gate.resolve();
    await until(() => f.calls.lists.length >= 3 && !f.entries.has(f.lockKey));
    expect(f.objects.has(oldKey)).toBe(false);
    const newKey = f.calls.puts[1]!; expect(f.objects.has(newKey)).toBe(true);
    expect(await first.read(f.asset, undefined, false)).toMatchObject({ status: "ready", objectKey: newKey });
  } finally { gate.resolve(); await Promise.all([first.stop(), second.stop()]); }
});

function command(tool: string, args: string[]) {
  return new Promise<Buffer>((resolve, reject) => execFile(tool, args, { encoding: "buffer", windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "canvas-playback-test-"));
  try { await run(directory); }
  finally { for (const file of await readdir(directory)) await unlink(join(directory, file)); await rmdir(directory); }
}

test("real HEVC Main10 becomes H264 yuv420p with identical dimensions/frame count; source remains byte-identical", async () => {
  await temporary(async directory => {
    const input = join(directory, "source.mp4"), output = join(directory, "playback.mp4");
    await command(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x224:r=24", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000", "-t", "1", "-c:v", "libx265", "-x265-params", "pools=1:frame-threads=1:log-level=error", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-c:a", "aac", input]);
    const hash = createHash("sha256").update(await readFile(input)).digest("hex");
    const result = await prepareVideoPlayback(input, output, AbortSignal.timeout(30_000));
    expect(result).toMatchObject({ kind: "derived", metadata: playbackMetadata });
    expect(createHash("sha256").update(await readFile(input)).digest("hex")).toBe(hash);
    const probe = JSON.parse((await command(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt", "-of", "json", output])).toString());
    expect(probe.streams).toEqual([{ codec_name: "h264", codec_type: "video", pix_fmt: "yuv420p" }, { codec_name: "aac", codec_type: "audio" }]);
    const compatible = await prepareVideoPlayback(output, join(directory, "must-not-exist.mp4"), AbortSignal.timeout(30_000));
    expect(compatible.kind).toBe("original"); expect(await Bun.file(join(directory, "must-not-exist.mp4")).exists()).toBe(false);
  });
}, 40_000);

test("malformed MP4 yields 422, while a missing ffprobe dependency yields 503", async () => {
  await temporary(async directory => {
    const input = join(directory, "broken.mp4"), output = join(directory, "unused.mp4");
    await writeFile(input, playbackBytes);
    await expect(prepareVideoPlayback(input, output, AbortSignal.timeout(5000))).rejects.toMatchObject({ status: 422 });
    const previous = process.env.FFPROBE_PATH;
    try {
      process.env.FFPROBE_PATH = "canvas-nonexistent-ffprobe-test";
      await expect(prepareVideoPlayback(input, output, AbortSignal.timeout(5000))).rejects.toMatchObject({ status: 503 });
    } finally { if (previous === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previous; }
  });
});

test("QuickTime H264 is converted to an actual MP4, not returned as video/quicktime", async () => {
  await temporary(async directory => {
    const input = join(directory, "source.mov"), output = join(directory, "playback.mp4");
    await command(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x224:r=24", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mov", input]);
    const originalHash = createHash("sha256").update(await readFile(input)).digest("hex");
    expect(await prepareVideoPlayback(input, output, AbortSignal.timeout(5000))).toMatchObject({ kind: "derived", metadata: playbackMetadata });
    const { fileTypeFromFile } = await import("file-type");
    expect((await fileTypeFromFile(output))?.mime).toBe("video/mp4");
    expect((await fileTypeFromFile(input))?.mime).toBe("video/quicktime");
    expect(createHash("sha256").update(await readFile(input)).digest("hex")).toBe(originalHash);
  });
});

test.each([
  { name: "duration", source: "color=c=blue:s=16x16:r=1", seconds: "91" },
  { name: "width", source: "color=c=blue:s=4100x2:r=1", seconds: "1" },
  { name: "frame rate", source: "color=c=blue:s=16x16:r=61", seconds: "1" },
])("declared $name bounds reject before compatible-video passthrough", async ({ source, seconds }) => {
  await temporary(async directory => {
    const input = join(directory, "source.mp4"), output = join(directory, "must-not-exist.mp4");
    await command(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", source, "-t", seconds, "-c:v", "libx264", "-pix_fmt", "yuv420p", input]);
    await expect(prepareVideoPlayback(input, output, AbortSignal.timeout(5000))).rejects.toMatchObject({ status: 422 });
    expect(await Bun.file(output).exists()).toBe(false);
  });
});
