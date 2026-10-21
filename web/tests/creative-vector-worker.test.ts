import { afterEach, describe, expect, test } from "bun:test";
import { processVectorInWorker } from "@/pages/creative/vector-workspace";
import { defaultVectorOptions, executeVectorTrace, type VectorTraceTask } from "@/pages/creative/pattern-trace";

const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
const task = (): VectorTraceTask => ({ mode: "pattern", image: { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 255, 255, 0, 0, 255]) }, options: defaultVectorOptions("pattern") });
class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    stopped = false;
    task?: VectorTraceTask;
    constructor() { FakeWorker.instances.push(this); }
    postMessage(value: VectorTraceTask) { this.task = structuredClone(value); }
    terminate() { this.stopped = true; }
    complete() { this.onmessage?.({ data: { result: executeVectorTrace(this.task!) } }); }
}
function mockWorker() { FakeWorker.instances = []; Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FakeWorker }); }
afterEach(() => { if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker); else Reflect.deleteProperty(globalThis, "Worker"); });

describe("vector worker cancellation and errors", () => {
    test("returns vector result without detaching source pixels and terminates its worker", async () => {
        mockWorker(); const input = task(), before = new Uint8ClampedArray(input.image.data);
        const pending = processVectorInWorker(input), worker = FakeWorker.instances[0]!;
        worker.complete(); const result = await pending;
        expect(result.svg).toContain("<path"); expect(input.image.data).toEqual(before); expect(worker.stopped).toBe(true);
    });
    test("cancelling an obsolete task prevents its late result from replacing fresh work", async () => {
        mockWorker(); const controller = new AbortController();
        const old = processVectorInWorker(task(), controller.signal), rejection = old.catch(error => error);
        const oldWorker = FakeWorker.instances[0]!; controller.abort();
        expect(await rejection).toMatchObject({ name: "AbortError" });
        const fresh = processVectorInWorker(task()), newWorker = FakeWorker.instances[1]!;
        oldWorker.complete(); newWorker.complete();
        expect((await fresh).pathCount).toBeGreaterThan(0); expect(oldWorker.stopped).toBe(true); expect(newWorker.stopped).toBe(true);
    });
    test("already aborted tasks never start and all worker errors release resources", async () => {
        mockWorker(); const controller = new AbortController(); controller.abort();
        await expect(processVectorInWorker(task(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
        expect(FakeWorker.instances).toHaveLength(0);
        for (const kind of ["domain", "runtime", "message"] as const) {
            const pending = processVectorInWorker(task()), worker = FakeWorker.instances.at(-1)!;
            const rejected = pending.catch(error => error);
            if (kind === "domain") worker.onmessage?.({ data: { error: "图片完全透明" } });
            else if (kind === "runtime") worker.onerror?.();
            else worker.onmessageerror?.();
            expect(await rejected).toBeInstanceOf(Error); expect(worker.stopped).toBe(true);
        }
    });
});
