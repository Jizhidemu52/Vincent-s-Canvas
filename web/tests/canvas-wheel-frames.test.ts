import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { canvasWheelZoomFactor } from "@/lib/canvas/canvas-wheel-zoom";
import { clampCanvasZoom } from "@/lib/canvas/canvas-zoom";
import { zoomViewportAtPoint } from "@/lib/canvas/canvas-viewport-interaction";
import type { ViewportTransform } from "@/types/canvas";

// Exercise the real handlers and RAF callback, not a second implementation of
// their scheduling. No DOM, browser services or paid providers are involved.
const source = readFileSync(new URL("../src/components/canvas/wireless-canvas.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("wireless-canvas.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers = new Map<string, string>();
function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ["queueLiveViewport", "commitLiveViewport", "previewViewport", "handleWheel"].includes(node.name.text)) {
        handlers.set(node.name.text, `const ${node.getText(ast)};`);
    }
    ts.forEachChild(node, collect);
}
collect(ast);
if (handlers.size !== 4) throw new Error("The canvas wheel scheduling handlers could not be located");
const code = ts.transpileModule(`${Array.from(handlers.values()).join("\n")}\nreturn { handleWheel, commitLiveViewport, previewViewport };`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
}).outputText;

type Bounds = { left: number; top: number; width: number; height: number };
function harness(initial: ViewportTransform = { x: 120, y: -30, k: 0.5 }) {
    const frames = new Map<number, () => void>();
    const timers = new Map<number, () => void>();
    const previews: ViewportTransform[] = [];
    const commits: ViewportTransform[] = [];
    const interactions: boolean[] = [];
    let id = 0;
    let reads = 0;
    let bounds: Bounds = { left: 40, top: 20, width: 1200, height: 800 };
    const liveViewportRef = { current: initial };
    const bindings = {
        useCallback: (callback: unknown) => callback,
        containerRef: { current: { getBoundingClientRect: () => { reads++; return bounds; } } },
        wheelBoundsRef: { current: null },
        panState: { current: { isPanning: false } },
        pendingViewportRef: { current: null },
        liveViewportRef,
        lastVirtualizationViewportRef: { current: initial },
        virtualizationRefreshDistanceRef: { current: 240 },
        frameRef: { current: null },
        wheelCommitTimerRef: { current: null },
        reportCanvasInteraction: (active: boolean) => interactions.push(active),
        applyLiveViewport: (next: ViewportTransform) => { liveViewportRef.current = next; previews.push(next); },
        publishVirtualizedViewport: () => {},
        onViewportChange: (next: ViewportTransform) => commits.push(next),
        requestAnimationFrame: (callback: () => void) => { frames.set(++id, callback); return id; },
        cancelAnimationFrame: (frameId: number) => frames.delete(frameId),
        window: {
            setTimeout: (callback: () => void) => { timers.set(++id, callback); return id; },
            clearTimeout: (timerId: number) => timers.delete(timerId),
        },
        Element: class {},
        shouldCanvasCaptureWheel: () => true,
        canvasWheelZoomFactor,
        clampCanvasZoom,
        zoomViewportAtPoint,
    };
    const callbacks = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
    const flush = (callbacks: Map<number, () => void>) => {
        const pending = Array.from(callbacks.values());
        callbacks.clear();
        pending.forEach(callback => callback());
    };
    return {
        wheel: (deltaY: number, clientX = 820, clientY = 440, deltaMode = 0) => callbacks.handleWheel({ target: null, deltaY, deltaX: 0, ctrlKey: true, clientX, clientY, deltaMode }),
        pan: (deltaX: number, deltaY: number, deltaMode = 0) => callbacks.handleWheel({ target: null, deltaX, deltaY, clientX: 820, clientY: 440, deltaMode }),
        flushFrame: () => flush(frames),
        finish: () => flush(timers),
        preview: (next: ViewportTransform) => callbacks.previewViewport(next),
        resize: (next: Bounds) => { bounds = next; },
        reads: () => reads,
        frames,
        timers,
        previews,
        commits,
        interactions,
    };
}

describe("canvas wheel frame scheduling", () => {
    test("plain two-axis scrolling pans without changing scale, including horizontal-only input", () => {
        const canvas = harness();
        canvas.pan(40, 10);
        canvas.pan(20, 0);
        canvas.flushFrame(); canvas.finish();
        expect(canvas.commits.at(-1)).toEqual({ x: 60, y: -40, k: 0.5 });
    });
    test("reads layout and paints once per input frame while preserving changing anchors and reversals", () => {
        const canvas = harness();
        const events = [
            { delta: -12, x: 820, y: 440 },
            { delta: -24, x: 640, y: 300 },
            { delta: 12, x: 720, y: 360 },
        ];
        let expected = { x: 120, y: -30, k: 0.5 };
        for (const event of events) {
            canvas.wheel(event.delta, event.x, event.y);
            expected = zoomViewportAtPoint(expected, { x: event.x - 40, y: event.y - 20 }, clampCanvasZoom(expected.k * canvasWheelZoomFactor(event.delta)));
        }
        expect(canvas.reads()).toBe(1);
        expect(canvas.frames.size).toBe(1);
        expect(canvas.previews).toHaveLength(0);
        canvas.flushFrame();
        expect(canvas.previews).toEqual([expected]);
        expect(canvas.commits).toHaveLength(0);

        canvas.resize({ left: 80, top: 30, width: 1000, height: 700 });
        canvas.wheel(-12);
        expect(canvas.reads()).toBe(2);
        expected = zoomViewportAtPoint(expected, { x: 820 - 80, y: 440 - 30 }, clampCanvasZoom(expected.k * canvasWheelZoomFactor(-12)));
        canvas.flushFrame();
        expect(canvas.previews[1]).toEqual(expected);
        canvas.finish();
        expect(canvas.commits).toEqual([expected]);
    });

    test("commits pending input immediately at gesture end without leaving an animation tail", () => {
        const canvas = harness();
        canvas.wheel(-48);
        canvas.finish();
        expect(canvas.frames.size).toBe(0);
        expect(canvas.previews).toHaveLength(1);
        expect(canvas.commits).toEqual(canvas.previews);
        canvas.flushFrame();
        expect(canvas.previews).toHaveLength(1);
    });

    test("external previews discard queued wheel work and invalidate cached bounds", () => {
        const canvas = harness();
        canvas.wheel(-12);
        const reset = { x: 0, y: 0, k: 1 };
        canvas.preview(reset);
        expect(canvas.frames.size).toBe(0);
        expect(canvas.timers.size).toBe(0);
        expect(canvas.previews).toEqual([reset]);
        canvas.wheel(-12);
        expect(canvas.reads()).toBe(2);
    });

    test("does not start interaction, paint or persist a wheel event clamped at the zoom limit", () => {
        const canvas = harness({ x: 0, y: 0, k: clampCanvasZoom(Infinity) });
        canvas.wheel(-100);
        expect(canvas.frames.size).toBe(0);
        expect(canvas.timers.size).toBe(0);
        expect(canvas.interactions).toHaveLength(0);
        expect(canvas.previews).toHaveLength(0);
        expect(canvas.commits).toHaveLength(0);
    });
});
