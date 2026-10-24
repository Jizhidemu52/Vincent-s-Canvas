import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { createTemporaryMediaFile, withTemporaryMediaFile } from "../src/media-file";

test("streaming temporary media preserves ordered byte views and disposes idempotently", async () => {
  const bytes = new Uint8Array([99, 1, 2, 3, 88]);
  const file = await createTemporaryMediaFile((async function* () { yield bytes.subarray(1, 3); yield bytes.subarray(3, 4); })(), { expectedBytes: 3 });
  expect(file.byteSize).toBe(3); expect(await readFile(file.path)).toEqual(Buffer.from([1, 2, 3]));
  await Promise.all([file.dispose(), file.dispose()]);
  expect(await Bun.file(file.path).exists()).toBe(false);
  await expect(readdir(dirname(file.path))).rejects.toMatchObject({ code: "ENOENT" });
});

test("stream failure, oversize, empty data and byte-count mismatch remove their partial files", async () => {
  for (const failure of ['stream', 'oversize', 'empty', 'mismatch'] as const) {
    const prefix = `canvas-media-test-${crypto.randomUUID()}-`;
    let finished = false;
    const source = (async function* () {
      try { if (failure !== 'empty') yield new Uint8Array([1, 2, 3]); if (failure === 'stream') throw new Error('source interrupted'); }
      finally { finished = true; }
    })();
    await expect(createTemporaryMediaFile(source, { prefix, ...(failure === 'oversize' ? { maxBytes: 2 } : failure === 'mismatch' ? { expectedBytes: 4 } : {}) })).rejects.toThrow();
    expect(finished).toBe(true); expect((await readdir(tmpdir())).filter(path => path.startsWith(prefix))).toEqual([]);
  }
});

test("probe/consumer errors still clean up the fully written temporary file", async () => {
  let path = '';
  await expect(withTemporaryMediaFile((async function* () { yield new Uint8Array([1, 2]); })(), {}, async file => {
    path = file.path; throw new Error('probe failed');
  })).rejects.toThrow('probe failed');
  expect(await Bun.file(path).exists()).toBe(false);
});

test("abort cancels a stalled WebStream and cleans its partial temporary file", async () => {
  const abort = new AbortController();
  const prefix = `canvas-abort-test-${crypto.randomUUID()}-`;
  let cancelled = false;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const source = new ReadableStream<Uint8Array>({ pull(controller) { ready(); controller.enqueue(new Uint8Array([1])); return new Promise<void>(() => {}); }, cancel() { cancelled = true; } });
  const pending = createTemporaryMediaFile(source, { signal: abort.signal, prefix });
  const observed = pending.catch(error => error);
  await started; abort.abort();
  const result = await observed;
  expect(result).toBeInstanceOf(Error); expect(result.name).toBe("AbortError"); expect(cancelled).toBe(true);
  expect((await readdir(tmpdir())).filter(path => path.startsWith(prefix))).toEqual([]);
}, 3000);
