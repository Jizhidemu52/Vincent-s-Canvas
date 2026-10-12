import { expect, test } from "bun:test";
import { canvasProjectGridWindow, createCanvasProjectGridLayout } from "@/pages/canvas/canvas-project-grid-layout";

test("first screen mounts a small overscanned window instead of the whole project library", () => {
    const layout = createCanvasProjectGridLayout(300, 3, 280, 20);
    expect(layout.rowCount).toBe(100);
    expect(layout.totalHeight).toBe(29980);
    expect(canvasProjectGridWindow(layout, 0, 800).rows).toEqual([0, 1, 2, 3, 4]);
    expect(canvasProjectGridWindow(layout, -200, 800).rows).toEqual([0, 1, 2, 3, 4]);
});

test("last screen and a stale scroll position after deleting the last row stay populated", () => {
    const layout = createCanvasProjectGridLayout(300, 3, 280, 20);
    expect(canvasProjectGridWindow(layout, 29980, 800).rows).toEqual([95, 96, 97, 98, 99]);
    const reduced = createCanvasProjectGridLayout(291, 3, 280, 20);
    const visible = canvasProjectGridWindow(reduced, 29980, 800);
    expect(visible.rows).toEqual([92, 93, 94, 95, 96]);
    expect(visible.rows.at(-1)).toBe(reduced.rowCount - 1);
});

test("responsive columns and tiny/empty libraries preserve the last real project", () => {
    for (const columns of [1, 2, 3]) {
        const layout = createCanvasProjectGridLayout(299, columns, 280, 20);
        const visible = canvasProjectGridWindow(layout, 1e6, 800);
        expect(visible.rows.at(-1)).toBe(Math.floor(298 / columns));
        expect(visible.rows.length).toBeLessThanOrEqual(6);
        expect(visible.rows.every(row => row >= 0 && row < layout.rowCount)).toBe(true);
    }
    expect(canvasProjectGridWindow(createCanvasProjectGridLayout(1, 3, 280, 20), 1000, 800).rows).toEqual([0]);
    expect(canvasProjectGridWindow(createCanvasProjectGridLayout(0, 3, 280, 20), 1000, 800).rows).toEqual([]);
});

test("natural measured heights update offsets without imposing a fixed card height", () => {
    const layout = createCanvasProjectGridLayout(12, 3, 280, 20, new Map([[0, 250], [1, 310], [2, 275]]));
    expect(layout.heights).toEqual([250, 310, 275, 280]);
    expect(layout.offsets).toEqual([0, 270, 600, 895]);
    expect(layout.totalHeight).toBe(1175);
    expect(canvasProjectGridWindow(layout, 600, 100, 0).rows).toEqual([2]);
    expect(canvasProjectGridWindow(layout, 250, 20, 0).rows).toEqual([1]);
});

test("an offscreen editing row remains mounted without mounting intervening rows", () => {
    const layout = createCanvasProjectGridLayout(300, 3, 280, 20);
    const visible = canvasProjectGridWindow(layout, 22000, 800, 2, 1);
    expect(visible.rows[0]).toBe(1);
    expect(visible.rows).toHaveLength(8);
    expect(visible.rows).not.toContain(2);
    expect(canvasProjectGridWindow(layout, 0, 800, 2, 1).rows).toEqual([0, 1, 2, 3, 4]);
    expect(canvasProjectGridWindow(layout, 0, 800, 2, 999).rows).toEqual([0, 1, 2, 3, 4]);
});

test("computed visible rows include every viewport intersection across varying measurements", () => {
    const measured = new Map(Array.from({ length: 100 }, (_, row) => [row, 250 + row % 5 * 11]));
    const layout = createCanvasProjectGridLayout(299, 3, 280, 20, measured);
    for (let top = 0; top < layout.totalHeight; top += 137) {
        const visible = canvasProjectGridWindow(layout, top, 733, 1);
        const effectiveTop = Math.max(0, Math.min(top, layout.totalHeight - 733));
        for (let row = 0; row < layout.rowCount; row += 1) {
            if (layout.offsets[row] + layout.heights[row] > effectiveTop && layout.offsets[row] < effectiveTop + 733) expect(visible.rows).toContain(row);
        }
    }
});
