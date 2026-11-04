import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createCanvasTextStreamBuffer } from "@/lib/canvas/canvas-text-stream-buffer";
import { applyCanvasStreamedTextUpdates, clearCanvasStreamedText } from "@/lib/canvas/canvas-streamed-text-state";
import { abortPendingCanvasRequests, shouldCancelCanvasGeneration, stopCanvasObservation } from "@/lib/canvas/canvas-project-async-lifecycle";
import type { useCanvasGenerationRuntime } from "@/pages/canvas/use-canvas-generation-runtime";

const code = ts.transpileModule(readFileSync(new URL("../src/pages/canvas/use-canvas-generation-runtime.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
}).outputText;

function harness() {
    let writable = true;
    let renewal: Promise<boolean> = Promise.resolve(true);
    let streamed = new Map<string, string>();
    const effects: Array<() => void | (() => void)> = [];
    const dependencies: Record<string, unknown> = {
        react: {
            useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef: (current: unknown) => ({ current }),
            useState: (value: unknown) => [value, () => {}], useLayoutEffect: (fn: () => void) => { effects.push(fn); },
        },
        "@/stores/canvas/canvas-graph-store": { useCanvasGraphSetter: () => (update: (previous: Map<string, string>) => Map<string, string>) => { streamed = update(streamed); } },
        "@/lib/canvas/canvas-text-stream-buffer": { createCanvasTextStreamBuffer: (flush: Parameters<typeof createCanvasTextStreamBuffer>[0]) => createCanvasTextStreamBuffer(flush, { request: () => 1, cancel: () => {} }) },
        "@/lib/canvas/canvas-streamed-text-state": { applyCanvasStreamedTextUpdates, clearCanvasStreamedText },
        "@/lib/canvas/canvas-project-async-lifecycle": { abortPendingCanvasRequests, stopCanvasObservation },
        "./use-canvas-image-tasks": { useCanvasImageTasks: () => ({ createOptions: () => {}, recoverPending: () => {} }) },
    };
    const module = { exports: {} as { useCanvasGenerationRuntime: typeof useCanvasGenerationRuntime } };
    new Function("require", "module", "exports", code)((name: string) => {
        if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`);
        return dependencies[name];
    }, module, module.exports);
    const runtime = module.exports.useCanvasGenerationRuntime({ projectId: "project", nodesRef: { current: [] }, setNodes: () => {}, projectSaveQueueRef: { current: null }, textStreamPublishingEnabledRef: { current: true },
        editLeaseRef: { get current() { return writable; }, ensureWritable: () => renewal } });
    const cleanups = effects.map(effect => effect());
    return { runtime, streamed: () => streamed, recovering: (pending: Promise<boolean>) => { writable = false; renewal = pending; },
        unmount: () => cleanups.forEach(cleanup => cleanup?.()) };
}

test("same-tab lease renewal keeps the running controller and every latest text chunk", async () => {
    const h = harness(), renewal = Promise.withResolvers<boolean>();
    const controller = h.runtime.startGenerationRequest("text", "source");
    h.runtime.textStreamBufferRef.current!.push({ nodeId: "text", content: "第一段" });
    h.recovering(renewal.promise);
    const ready = h.runtime.waitForWriteAccess();
    h.runtime.textStreamBufferRef.current!.push({ nodeId: "text", content: "第一段，继续输出" });
    h.runtime.textStreamBufferRef.current!.flush();
    expect(controller.signal.aborted).toBe(false);
    expect(h.runtime.isObservationCurrent()).toBe(true);
    expect(h.streamed().get("text")).toBe("第一段，继续输出");
    renewal.resolve(true);
    expect(await ready).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(h.runtime.generationRequestsRef.current.size).toBe(1);
    expect(h.runtime.textStreamBufferRef.current!.read("text")).toBe("第一段，继续输出");
    h.unmount();
});

test("confirmed takeover stops only local observation and permanently fences that editor epoch", async () => {
    const h = harness();
    const controller = h.runtime.startGenerationRequest("image", "source");
    h.recovering(Promise.resolve(false));
    expect(await h.runtime.waitForWriteAccess()).toBe(false);
    expect(controller.signal.aborted).toBe(true);
    expect(shouldCancelCanvasGeneration(controller.signal)).toBe(false);
    expect(h.runtime.isObservationCurrent()).toBe(false);
    expect(h.runtime.generationRequestsRef.current.size).toBe(0);
    h.recovering(Promise.resolve(true));
    expect(await h.runtime.waitForWriteAccess()).toBe(false);
    h.unmount();
});
