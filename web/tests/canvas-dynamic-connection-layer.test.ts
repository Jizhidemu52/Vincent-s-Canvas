import { expect, test } from "bun:test";

import { shouldClearCanvasDynamicConnectionLayer, shouldDrawCanvasConnectionLayer, shouldRedrawCanvasConnectionLayer } from "@/lib/canvas/canvas-dynamic-connection-layer";

test("does not clear an empty dynamic connection canvas every viewport frame", () => {
    expect(shouldClearCanvasDynamicConnectionLayer(false, false)).toBe(false);
});

test("clears the dynamic connection canvas once after a drag finishes", () => {
    expect(shouldClearCanvasDynamicConnectionLayer(true, false)).toBe(true);
});

test("keeps the dynamic canvas while a moved-node connection still needs drawing", () => {
    expect(shouldClearCanvasDynamicConnectionLayer(true, true)).toBe(false);
});

test("skips an already blank connection canvas while the viewport keeps moving", () => {
    expect(shouldDrawCanvasConnectionLayer(false, false)).toBe(false);
});

test("draws a connection canvas when it gains content or needs one final clear", () => {
    expect(shouldDrawCanvasConnectionLayer(false, true)).toBe(true);
    expect(shouldDrawCanvasConnectionLayer(true, false)).toBe(true);
});

test("skips duplicate static connection paints when batch and viewport are unchanged", () => {
    const batches = {};
    const state = { hasContent: true, batches, paintKey: "light", viewport: { x: 20, y: 30, k: 1 } };
    expect(shouldRedrawCanvasConnectionLayer(null, state)).toBe(true);
    expect(shouldRedrawCanvasConnectionLayer(state, state)).toBe(false);
    expect(shouldRedrawCanvasConnectionLayer(state, { ...state, viewport: { ...state.viewport, x: 21 } })).toBe(true);
    expect(shouldRedrawCanvasConnectionLayer(state, { ...state, batches: {} })).toBe(true);
    expect(shouldRedrawCanvasConnectionLayer(state, { ...state, paintKey: "dark" })).toBe(true);
});
