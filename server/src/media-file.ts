import { createWriteStream } from "node:fs";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type MediaStream = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
export type TemporaryMediaFile = { path: string; byteSize: number; dispose: () => Promise<void> };
export type MediaFileOptions = { maxBytes?: number; expectedBytes?: number; signal?: AbortSignal; prefix?: string };

function readWebStream(source: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = source.getReader();
  let completed = false;
  let cancellation: Promise<void> | undefined;
  const cancel = () => cancellation ??= reader.cancel().catch(() => undefined);
  const onAbort = () => { void cancel(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const chunks = (async function* () {
    while (true) {
      const result = await reader.read();
      if (result.done) { completed = true; return; }
      yield result.value;
    }
  })();
  return { chunks, dispose: async () => {
    signal?.removeEventListener("abort", onAbort);
    if (!completed) await cancel();
    reader.releaseLock();
  } };
}

/** A bounded-memory copy; the returned file has one explicit owner until dispose. */
export async function createTemporaryMediaFile(source: MediaStream, options: MediaFileOptions = {}): Promise<TemporaryMediaFile> {
  const directory = await mkdtemp(join(tmpdir(), options.prefix || "canvas-media-probe-"));
  const path = join(directory, "source");
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= (async () => {
    await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  })();
  let byteSize = 0;
  let webInput: ReturnType<typeof readWebStream> | null = null;
  const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    byteSize += chunk.byteLength;
    if (options.maxBytes !== undefined && byteSize > options.maxBytes) callback(new Error("参考素材必须非空且不超过 200MB"));
    else if (options.expectedBytes !== undefined && byteSize > options.expectedBytes) callback(new Error("参考素材实际大小与存储记录不一致，请重新上传"));
    else callback(null, chunk);
  } });
  try {
    // Explicit reads also propagate errored WebStreams correctly in Bun's Node adapter.
    webInput = source instanceof ReadableStream ? readWebStream(source, options.signal) : null;
    const input = Readable.from(webInput?.chunks ?? source as AsyncIterable<Uint8Array>);
    await pipeline(input, counter, createWriteStream(path, { flags: "wx" }), { signal: options.signal });
    if (!byteSize) throw new Error("媒体文件内容为空");
    if (options.expectedBytes !== undefined && byteSize !== options.expectedBytes) throw new Error("参考素材实际大小与存储记录不一致，请重新上传");
    return { path, byteSize, dispose };
  } catch (error) {
    await dispose().catch(cleanup => { throw new AggregateError([error, cleanup], "媒体读取失败，且临时文件清理失败"); });
    throw error;
  } finally {
    await webInput?.dispose();
  }
}

export async function withTemporaryMediaFile<T>(source: MediaStream, options: MediaFileOptions, use: (file: TemporaryMediaFile) => Promise<T>): Promise<T> {
  const file = await createTemporaryMediaFile(source, options);
  try { return await use(file); }
  finally { await file.dispose(); }
}
