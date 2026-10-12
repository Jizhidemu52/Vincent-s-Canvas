import { Unzip, UnzipInflate, unzip, unzipSync, zip, zipSync, type AsyncTerminable, type Unzipped, type Zippable } from "fflate";
import type { ZipProgress, ZipTask, ZipTaskResult } from "./zip";

type CodecOptions = { asynchronous?: boolean; signal?: AbortSignal };

/** Called in the dedicated worker, or explicitly by the non-browser Node path. */
export async function executeZipTask(task: ZipTask, onProgress: (progress: ZipProgress) => void, options: CodecOptions = {}): Promise<ZipTaskResult> {
    const { signal, asynchronous } = options;
    signal?.throwIfAborted();
    if (task.kind === "create") {
        const entries: Array<readonly [string, Uint8Array]> = [];
        const total = task.files.length;
        onProgress({ phase: "preparing", completed: 0, total, label: `正在读取文件 0/${total}` });
        // Read originals in order instead of materializing every Blob concurrently.
        // Strings and typed-array encoding also stay off the browser UI thread.
        for (const file of task.files) {
            signal?.throwIfAborted();
            const bytes = new Uint8Array(await new Blob([file.data]).arrayBuffer());
            signal?.throwIfAborted();
            entries.push([file.name, bytes]);
            onProgress({ phase: "preparing", completed: entries.length, total, label: `正在读取文件 ${entries.length}/${total}` });
        }
        signal?.throwIfAborted();
        onProgress({ phase: "packing", completed: 0, total: 0, label: `正在打包 ${total} 个文件` });
        const input = Object.fromEntries(entries);
        const bytes = asynchronous ? await zipAsync(input, signal) : zipSync(input, { level: 0 });
        signal?.throwIfAborted();
        const result = new Blob([bytes], { type: "application/zip" });
        onProgress({ phase: "complete", completed: total, total, label: "打包完成" });
        return result;
    }
    onProgress({ phase: "preparing", completed: 0, total: 1, label: "正在读取压缩文件" });
    const bytes = new Uint8Array(await task.file.arrayBuffer());
    signal?.throwIfAborted();
    onProgress({ phase: "preparing", completed: 1, total: 1, label: "压缩文件读取完成" });
    onProgress({ phase: "unpacking", completed: 0, total: 0, label: "正在解包文件" });
    const fileOrder: string[] = [];
    const filter = ({ name }: { name: string }) => { fileOrder.push(name); return true; };
    const entries = asynchronous ? await unzipAsync(bytes, filter, signal) : unzipSync(bytes, { filter });
    signal?.throwIfAborted();
    const names = [...new Set(fileOrder)];
    const result = new Map<string, Blob>();
    for (const name of names) {
        signal?.throwIfAborted();
        result.set(name, new Blob([entries[name]!]));
        onProgress({ phase: "unpacking", completed: result.size, total: names.length, label: `正在还原文件 ${result.size}/${names.length}` });
    }
    onProgress({ phase: "complete", completed: names.length, total: names.length, label: "解包完成" });
    return result;
}

function callFflate<T>(start: (done: (error: Error | null, data: T) => void) => AsyncTerminable, signal?: AbortSignal) {
    return new Promise<T>((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        let terminate: AsyncTerminable | undefined;
        const abort = () => { terminate?.(); reject(signal?.reason); };
        signal?.addEventListener("abort", abort, { once: true });
        const done = (error: Error | null, data: T) => {
            signal?.removeEventListener("abort", abort);
            if (signal?.aborted) reject(signal.reason);
            else if (error) reject(error);
            else resolve(data);
        };
        try { terminate = start(done); }
        catch (error) { signal?.removeEventListener("abort", abort); reject(error); }
    });
}

function zipAsync(entries: Zippable, signal?: AbortSignal) {
    return callFflate<Uint8Array<ArrayBuffer>>((done) => zip(entries, { level: 0 }, done), signal);
}

async function unzipAsync(bytes: Uint8Array, filter: (file: { name: string }) => boolean, signal?: AbortSignal) {
    // Validate the central directory and preserve its order, without triggering
    // fflate's eval-worker shim (not supported by every Bun/Node worker runtime).
    await callFflate<Unzipped>((done) => unzip(bytes, { filter: file => { filter(file); return false; } }, done), signal);
    const entries: Unzipped = {};
    let failure: Error | null = null;
    const inflaters: Array<{ terminate?: () => void }> = [];
    const stream = new Unzip(file => {
        const chunks: Uint8Array[] = [];
        let length = 0;
        file.ondata = (error, chunk, final) => {
            if (error) { failure = error; return; }
            chunks.push(chunk);
            length += chunk.length;
            if (final) {
                const output = new Uint8Array(length);
                let offset = 0;
                for (const part of chunks) { output.set(part, offset); offset += part.length; }
                entries[file.name] = output;
            }
        };
        inflaters.push(file);
        file.start();
    });
    stream.register(UnzipInflate);
    try {
        const chunkSize = 256 * 1024;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            signal?.throwIfAborted();
            const end = Math.min(bytes.length, offset + chunkSize);
            stream.push(bytes.subarray(offset, end), end === bytes.length);
            if (failure) throw failure;
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        signal?.throwIfAborted();
        return entries;
    } finally { for (const inflater of inflaters) inflater.terminate?.(); }
}
