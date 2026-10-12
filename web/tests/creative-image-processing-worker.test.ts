import { afterEach, describe, expect, test } from "bun:test";
import { processImageInWorker } from "@/pages/creative/image-processing-client";
import { executeImageProcessingTask, type ImageProcessingTask } from "@/pages/creative/image-processing-task";
import { recolorPixels, type PixelImage, type RecolorRule } from "@/pages/creative/image-processing";

const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
const image = (): PixelImage => ({ width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 127, 0, 0, 255, 0]) });
const task = (): ImageProcessingTask & { kind: "recolor" } => ({ kind: "recolor", image: image(), rules: [{ from: "#FF0000", to: "#00FF00" }], tolerance: 0 });
class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    stopped = false;
    input?: ImageProcessingTask;
    constructor() { FakeWorker.instances.push(this); }
    postMessage(input: ImageProcessingTask) { this.input = structuredClone(input); }
    terminate() { this.stopped = true; }
    complete() { this.onmessage?.({ data: { result: executeImageProcessingTask(this.input!) } }); }
}
function mockWorker() {
    FakeWorker.instances = [];
    Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FakeWorker });
}
afterEach(() => {
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
});

describe("off-thread image processing lifetime", () => {
    test("returns exact pixels and counts without detaching or mutating original", async () => {
        mockWorker(); const input = task(); const pending = processImageInWorker(input);
        const worker = FakeWorker.instances[0]!; worker.complete();
        const result = await pending;
        expect([...result.data]).toEqual([0, 255, 0, 127, 0, 0, 255, 0]);
        expect(result.changedPixels).toBe(1); expect(result.matchedPixels).toBe(1);
        expect([...input.image.data]).toEqual([...image().data]); expect(worker.stopped).toBe(true);
    });
    test("aborting obsolete preview stops its CPU worker and cannot resolve a stale result", async () => {
        mockWorker(); const controller = new AbortController();
        const old = processImageInWorker(task(), controller.signal); const oldWorker = FakeWorker.instances[0]!;
        const rejected = old.catch(error => error);
        controller.abort(); expect(await rejected).toMatchObject({ name: "AbortError" });
        const fresh = processImageInWorker(task()); const freshWorker = FakeWorker.instances[1]!;
        oldWorker.complete(); freshWorker.complete();
        expect(oldWorker.stopped).toBe(true); expect((await fresh).changedPixels).toBe(1); expect(freshWorker.stopped).toBe(true);
    });
    test("already cancelled work does not create a worker", async () => {
        mockWorker(); const controller = new AbortController(); controller.abort();
        await expect(processImageInWorker(task(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
        expect(FakeWorker.instances.length).toBe(0);
    });
    test("worker decoding/runtime/domain errors reject and terminate", async () => {
        mockWorker();
        for (const mode of ["runtime", "message", "domain"] as const) {
            const pending = processImageInWorker(task()); const worker = FakeWorker.instances.at(-1)!;
            const rejected = pending.catch(error => error);
            if (mode === "runtime") worker.onerror?.();
            else if (mode === "message") worker.onmessageerror?.();
            else worker.onmessage?.({ data: { error: "选区为空" } });
            expect(await rejected).toBeInstanceOf(Error); expect(worker.stopped).toBe(true);
        }
    });
    test("constructor failure rejects instead of falling back to a blocking calculation", async () => {
        Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: class { constructor() { throw new Error("blocked worker"); } } });
        await expect(processImageInWorker(task())).rejects.toThrow("blocked worker");
    });
});

describe("worker pixel contracts", () => {
    test("guide tint preserves dimensions, applies existing alpha rounding and does not alter input", () => {
        const original = image(); const result = executeImageProcessingTask({ kind: "selection-guide", image: original });
        expect([...result.data]).toEqual([42, 119, 246, 70, 42, 119, 246, 0]);
        expect(result.width).toBe(2); expect(result.height).toBe(1); expect([...original.data]).toEqual([...image().data]);
        expect(() => executeImageProcessingTask({ kind: "selection-guide", image: { width: 1, height: 1, data: new Uint8ClampedArray(4) } })).toThrow("选区为空");
    });
    test("composite keeps original pixels outside the selection and validates geometry", () => {
        const original = image(); const generated = { ...image(), data: new Uint8ClampedArray([0, 255, 0, 255, 9, 8, 7, 255]) };
        const selection = { ...image(), data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]) };
        const result = executeImageProcessingTask({ kind: "composite", original, generated, selection });
        expect([...result.data]).toEqual([0, 255, 0, 255, 0, 0, 255, 0]);
        expect([...original.data]).toEqual([...image().data]);
        expect(() => executeImageProcessingTask({ kind: "composite", original, generated, selection: { ...selection, width: 3 } })).toThrow();
    });
    test("optimized nearest-color loop matches an independent scalar reference across tolerances", () => {
        const data = new Uint8ClampedArray(1024 * 4);
        for (let n = 0; n < data.length; n++) data[n] = (n * 73 + (n >> 3) * 17) % 256;
        const source = { width: 1024, height: 1, data };
        const rules: RecolorRule[] = [
            { from: "#FF0000", to: "#00FF00" }, { from: "#0000FF", to: "#FFFF00" },
            { from: "#00FF00", to: "#00FF00" }, { from: "#000000", to: "#ABCDEF" },
            { from: "#FFFFFF", to: "#000000" }, { from: "#804020", to: "#204080" },
        ];
        const rgb = (hex: string) => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));
        for (const tolerance of [0, 8, 50, 100]) {
            const expected = new Uint8ClampedArray(data); let matched = 0, changed = 0;
            for (let offset = 0; offset < data.length; offset += 4) {
                if (!data[offset + 3]) continue;
                const candidates = rules.map((rule, index) => ({ from: rgb(rule.from), to: rgb(rule.to), index })).map(rule => ({ ...rule, distance: rule.from.reduce((sum, value, channel) => sum + (value - data[offset + channel]!) ** 2, 0) })).filter(rule => rule.distance <= 3 * (255 * tolerance / 100) ** 2).sort((a, b) => a.distance - b.distance || a.index - b.index);
                const selected = candidates[0]; if (!selected) continue; matched++;
                if (selected.from.every((value, channel) => value === selected.to[channel])) continue;
                if (selected.to.some((value, channel) => value !== data[offset + channel])) changed++;
                expected.set(selected.to, offset);
            }
            const actual = recolorPixels(source, rules, tolerance);
            expect(actual.data).toEqual(expected); expect(actual.matchedPixels).toBe(matched); expect(actual.changedPixels).toBe(changed);
        }
    });
});
