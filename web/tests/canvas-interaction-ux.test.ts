import { expect, test } from "bun:test";
import { ignoreCanvasPromptKey, fitCanvasNodes, canvasImportGridPosition } from "@/lib/canvas/canvas-interaction-ux";
import { canvasZoomFromSlider, canvasZoomSliderValue, MAX_CANVAS_ZOOM } from "@/lib/canvas/canvas-zoom";
import { matchCanvasActionShortcut } from "@/lib/canvas/canvas-actions";

test("IME composition, legacy composition key code and repeated keys never submit or pick a mention", () => {
    expect(ignoreCanvasPromptKey({ isComposing: true })).toBe(true);
    expect(ignoreCanvasPromptKey({ keyCode: 229 })).toBe(true);
    expect(ignoreCanvasPromptKey({ repeat: true })).toBe(true);
    expect(ignoreCanvasPromptKey({ keyCode: 13 })).toBe(false);
});

test("fit all includes distant content inside the unoccluded area and preserves node geometry", () => {
    const nodes = [{ position: { x: -4000, y: 1200 }, width: 640, height: 320 }, { position: { x: -3000, y: 1800 }, width: 160, height: 640 }];
    const before = JSON.stringify(nodes);
    const area = { left: 500, top: 80, width: 900, height: 700 };
    const view = fitCanvasNodes(nodes, area);
    for (const node of nodes) {
        expect(node.position.x * view.k + view.x).toBeGreaterThanOrEqual(area.left);
        expect((node.position.x + node.width) * view.k + view.x).toBeLessThanOrEqual(area.left + area.width);
        expect(node.position.y * view.k + view.y).toBeGreaterThanOrEqual(area.top);
        expect((node.position.y + node.height) * view.k + view.y).toBeLessThanOrEqual(area.top + area.height);
    }
    expect(JSON.stringify(nodes)).toBe(before);
    expect(fitCanvasNodes([], area)).toEqual({ x: 950, y: 430, k: 1 });
});

test("zoom uses a bounded logarithmic scale with a usable 100 percent position", () => {
    expect(MAX_CANVAS_ZOOM).toBe(16);
    for (const scale of [.05, .25, .5, 1, 2, 8, 16]) expect(canvasZoomFromSlider(canvasZoomSliderValue(scale))).toBeCloseTo(scale, 8);
    expect(canvasZoomSliderValue(1)).toBeGreaterThan(400);
    expect(canvasZoomSliderValue(1)).toBeLessThan(600);
});

test("native zoom and fit shortcuts target canvas actions on common keyboard layouts", () => {
    for (const key of ["+", "="]) expect(matchCanvasActionShortcut({ key, ctrlKey: true, shiftKey: true })).toBe("zoomIn");
    expect(matchCanvasActionShortcut({ key: "-", metaKey: true })).toBe("zoomOut");
    expect(matchCanvasActionShortcut({ key: "0", ctrlKey: true })).toBe("zoomActual");
    for (const key of ["1", "!"]) expect(matchCanvasActionShortcut({ key, shiftKey: true })).toBe("resetView");
    for (const key of ["2", "@"]) expect(matchCanvasActionShortcut({ key, shiftKey: true })).toBe("fitSelection");
});

test("batch placement creates nonoverlapping 640px cells without stretching images", () => {
    const positions = Array.from({ length: 10 }, (_, index) => canvasImportGridPosition({ x: 0, y: 0 }, index, 10));
    expect(new Set(positions.map(point => `${point.x},${point.y}`)).size).toBe(10);
    for (const [index, point] of positions.entries()) for (const other of positions.slice(index + 1)) expect(Math.abs(point.x - other.x) >= 640 || Math.abs(point.y - other.y) >= 640).toBe(true);
});
