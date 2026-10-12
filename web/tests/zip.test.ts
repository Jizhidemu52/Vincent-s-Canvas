import { afterEach, describe, expect, test } from "bun:test";
import { unzipSync, zipSync } from "fflate";
import { createZip, readZip, type ZipProgress, type ZipTask, type ZipWorkerMessage } from "@/lib/zip";

const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

const raw = new Uint8Array([0, 255, 128, 127, 1, 0, 32]);
async function roundTrip() {
    const source = new Uint8Array(raw);
    const progress: ZipProgress[] = [];
    const archive = await createZip([
        { name: "projects.json", data: "中文与 emoji 🧵" },
        { name: "原图/花型🧵.png", data: source },
        { name: "subarray.bin", data: source.subarray(1, 5) },
        { name: "空文件", data: new Blob([]) },
        { name: "duplicate", data: "old" },
        { name: "duplicate", data: "new" },
    ], { onProgress: value => progress.push(value) });
    expect(source).toEqual(raw);
    expect(source.byteLength).toBe(raw.length);
    expect(archive.type).toBe("application/zip");
    const archiveBytes = new Uint8Array(await archive.arrayBuffer());
    const methods: number[] = [];
    const decoded = unzipSync(archiveBytes, { filter: entry => { methods.push(entry.compression); return true; } });
    expect(methods).toEqual([0, 0, 0, 0, 0]);
    expect(decoded["原图/花型🧵.png"]).toEqual(raw);
    expect(progress[0]).toMatchObject({ phase: "preparing", completed: 0, total: 6 });
    expect(progress.find(item => item.phase === "packing")).toMatchObject({ completed: 0, total: 0 });
    expect(progress.at(-1)).toMatchObject({ phase: "complete", completed: 6, total: 6 });
    const readProgress: ZipProgress[] = [];
    const entries = await readZip(archive, { onProgress: value => readProgress.push(value) });
    expect([...entries.keys()]).toEqual(["projects.json", "原图/花型🧵.png", "subarray.bin", "空文件", "duplicate"]);
    expect(await entries.get("projects.json")!.text()).toBe("中文与 emoji 🧵");
    expect(new Uint8Array(await entries.get("原图/花型🧵.png")!.arrayBuffer())).toEqual(raw);
    expect(new Uint8Array(await entries.get("subarray.bin")!.arrayBuffer())).toEqual(raw.subarray(1, 5));
    expect(entries.get("空文件")!.size).toBe(0);
    expect(await entries.get("duplicate")!.text()).toBe("new");
    expect(readProgress.at(-1)).toMatchObject({ phase: "complete", completed: 5, total: 5 });
}

describe("background ZIP byte contracts", () => {
    test("real Worker preserves original bytes, UTF-8 names, entry order and STORE method", roundTrip);
    test("explicit no-Worker CLI path preserves the same byte contracts", async () => {
        Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined });
        Reflect.deleteProperty(globalThis, "window");
        await roundTrip();
    });
    test("reads deflated archives as well as STORE without changing source data", async () => {
        const data = new Uint8Array(900_000).fill(42);
        const original = zipSync({ "中文-large.bin": data, "after.txt": new Uint8Array([1, 2]) }, { level: 6 });
        for (const noWorker of [false, true]) {
            if (noWorker) Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined });
            const result = await readZip(new Blob([original]));
            expect([...result.keys()]).toEqual(["中文-large.bin", "after.txt"]);
            expect(new Uint8Array(await result.get("中文-large.bin")!.arrayBuffer())).toEqual(data);
        }
        expect(original.byteLength).toBeGreaterThan(0);
    });
    test("empty archives work and malformed archives reject without fake completion", async () => {
        expect((await readZip(await createZip([]))).size).toBe(0);
        const progress: ZipProgress[] = [];
        await expect(readZip(new Blob(["not zip"]), { onProgress: value => progress.push(value) })).rejects.toBeInstanceOf(Error);
        expect(progress.some(item => item.phase === "complete")).toBe(false);
    });
});

class FakeWorker {
    static instances: FakeWorker[] = [];
    stopped = false;
    input?: ZipTask;
    onmessage: ((event: { data: ZipWorkerMessage }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    constructor() { FakeWorker.instances.push(this); }
    postMessage(task: ZipTask, transfer?: unknown) { expect(transfer).toBeUndefined(); this.input = task; }
    terminate() { this.stopped = true; }
    emit(message: ZipWorkerMessage) { this.onmessage?.({ data: message }); }
}
function fakeWorkers() {
    FakeWorker.instances = [];
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
}

describe("ZIP operation lifecycle", () => {
    test("already cancelled input creates no worker", async () => {
        fakeWorkers(); const controller = new AbortController(); controller.abort();
        await expect(createZip([], { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(FakeWorker.instances).toHaveLength(0);
    });
    test("cancels active CPU worker and ignores stale progress/completion", async () => {
        fakeWorkers(); const controller = new AbortController(); const progress: ZipProgress[] = [];
        const task = createZip([], { signal: controller.signal, onProgress: value => progress.push(value) });
        const rejected = task.catch(error => error); const worker = FakeWorker.instances[0]!;
        const late = worker.onmessage;
        controller.abort();
        expect(await rejected).toMatchObject({ name: "AbortError" }); expect(worker.stopped).toBe(true);
        late?.({ data: { type: "progress", progress: { phase: "complete", completed: 1, total: 1, label: "late" } } });
        late?.({ data: { type: "result", result: new Blob([]) } });
        expect(progress).toHaveLength(0);
        expect(worker.onmessage).toBeNull();
    });
    test("timeout terminates worker and rejects rather than waiting forever", async () => {
        fakeWorkers();
        await expect(readZip(new Blob([]), { timeoutMs: 5 })).rejects.toMatchObject({ name: "TimeoutError" });
        expect(FakeWorker.instances[0]!.stopped).toBe(true);
    });
    test("success forwards real progress and releases worker once result is received", async () => {
        fakeWorkers(); const progress: ZipProgress[] = [];
        const task = createZip([], { onProgress: value => progress.push(value) }); const worker = FakeWorker.instances[0]!;
        const value = { phase: "packing" as const, completed: 0, total: 0, label: "正在打包" };
        worker.emit({ type: "progress", progress: value }); const blob = new Blob(["zip"]);
        worker.emit({ type: "result", result: blob });
        expect(await task).toBe(blob); expect(progress).toEqual([value]); expect(worker.stopped).toBe(true);
    });
    test("worker runtime, message decoding, domain and invalid result errors all clean up", async () => {
        fakeWorkers();
        for (const mode of ["runtime", "decode", "domain", "result"] as const) {
            const task = createZip([]); const rejected = task.catch(error => error); const worker = FakeWorker.instances.at(-1)!;
            if (mode === "runtime") worker.onerror?.();
            if (mode === "decode") worker.onmessageerror?.();
            if (mode === "domain") worker.emit({ type: "error", message: "文件已损坏", name: "Error" });
            if (mode === "result") worker.emit({ type: "result", result: new Map() });
            expect(await rejected).toBeInstanceOf(Error); expect(worker.stopped).toBe(true);
        }
    });
    test("unsupported browser and worker constructor errors never fall back to UI-thread compression", async () => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
        Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined });
        await expect(createZip([])).rejects.toThrow("不支持后台压缩");
        Object.defineProperty(globalThis, "Worker", { configurable: true, value: class { constructor() { throw new Error("worker blocked"); } } });
        await expect(createZip([])).rejects.toThrow("worker blocked");
    });
    test("progress callback error rejects and cleans up the running worker", async () => {
        fakeWorkers(); const task = createZip([], { onProgress: () => { throw new Error("callback failed"); } });
        const rejected = task.catch(error => error); const worker = FakeWorker.instances[0]!;
        worker.emit({ type: "progress", progress: { phase: "preparing", completed: 0, total: 1, label: "reading" } });
        expect(String(await rejected)).toContain("callback failed"); expect(worker.stopped).toBe(true);
    });
});
