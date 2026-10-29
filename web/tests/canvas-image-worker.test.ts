import { afterEach, expect, test } from "bun:test";
import { requireCanvasImageFallback, runCanvasImageTask, type CanvasImageTask, type CanvasImageWorkerMessage } from "@/lib/canvas/canvas-image-worker";

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((event: { data: CanvasImageWorkerMessage }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminated = false;
    task?: CanvasImageTask;
    constructor() { FakeWorker.instances.push(this); }
    postMessage(task: CanvasImageTask) { this.task = task; }
    terminate() { this.terminated = true; }
    emit(data: CanvasImageWorkerMessage) { this.onmessage?.({ data }); }
}
function setup() { FakeWorker.instances = []; Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FakeWorker }); }
afterEach(() => { if (descriptor) Object.defineProperty(globalThis, "Worker", descriptor); else Reflect.deleteProperty(globalThis, "Worker"); });
const source = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
const task = (): CanvasImageTask => ({ kind: "encode", source, mimeType: "image/jpeg" });

test("Worker returns result, forwards progress, preserves Blob ownership, and is terminated", async () => {
    setup(); const progress: string[] = [];
    const pending = runCanvasImageTask(task(), { onProgress: update => progress.push(update.label) });
    const worker = FakeWorker.instances[0], result = new Blob(["jpeg"], { type: "image/jpeg" });
    worker.emit({ type: "progress", progress: { percent: 45, label: "encoding" } });
    worker.emit({ type: "result", result });
    expect(await pending).toBe(result); expect(progress).toEqual(["encoding"]);
    expect(worker.task?.kind === "encode" && worker.task.source).toBe(source);
    expect(await source.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(worker.terminated).toBe(true); expect(worker.onmessage).toBeNull();
});
test("abort stops work and old completion cannot resolve or affect a replacement", async () => {
    setup(); const controller = new AbortController();
    const pending = runCanvasImageTask(task(), { signal: controller.signal }); const old = FakeWorker.instances[0];
    const failure = pending.catch(error => error); controller.abort();
    expect(await failure).toMatchObject({ name: "AbortError" }); expect(old.terminated).toBe(true);
    const replacement = runCanvasImageTask(task()); const next = FakeWorker.instances[1];
    old.emit({ type: "result", result: source }); next.emit({ type: "result", result: source });
    expect(await replacement).toBe(source); expect(next.terminated).toBe(true);
});
test("pre-abort, constructor failure, timeout, message and runtime failures release resources", async () => {
    setup(); const controller = new AbortController(); controller.abort();
    await expect(runCanvasImageTask(task(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.instances).toHaveLength(0);
    for (const failure of ["error", "message", "domain", "timeout"] as const) {
        const pending = runCanvasImageTask(task(), { timeoutMs: 10 }); const worker = FakeWorker.instances.at(-1)!;
        if (failure === "error") worker.onerror?.();
        else if (failure === "message") worker.onmessageerror?.();
        else if (failure === "domain") worker.emit({ type: "error", name: "SecurityError", message: "blocked" });
        await expect(pending).rejects.toBeInstanceOf(Error); expect(worker.terminated).toBe(true);
    }
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: class { constructor() { throw new Error("blocked Worker"); } } });
    let closed = 0;
    const bitmap = { close() { closed++; } } as ImageBitmap;
    await expect(runCanvasImageTask({ kind: "difference", before: bitmap, after: bitmap })).rejects.toThrow("blocked Worker");
    expect(closed).toBe(2);
});
test("fallback is explicit and bounded, never silently resizes a 4MP image", () => {
    const progress: string[] = [];
    requireCanvasImageFallback(1000, 1000, { onProgress: update => progress.push(update.label) });
    expect(progress[0]).toContain("兼容模式");
    expect(() => requireCanvasImageFallback(2000, 2000, {})).toThrow("100 万像素");
});
