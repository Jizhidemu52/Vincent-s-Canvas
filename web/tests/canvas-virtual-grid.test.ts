import { expect, test } from "bun:test";

import { createCanvasVirtualGridWindow } from "@/lib/canvas/canvas-virtual-grid";

test("renders only nearby asset rows while keeping the full scroll height", () => {
    const window = createCanvasVirtualGridWindow({
        itemCount: 1_000,
        columns: 2,
        rowHeight: 126,
        rowGap: 6,
        scrollTop: 1_320,
        viewportHeight: 396,
        overscanRows: 2,
    });

    expect(window).toEqual({ startIndex: 16, endIndex: 30, totalHeight: 65_994 });
});

test("clamps a virtual grid window at both ends", () => {
    const start = createCanvasVirtualGridWindow({ itemCount: 5, columns: 2, rowHeight: 100, rowGap: 10, scrollTop: 0, viewportHeight: 0, overscanRows: 2 });
    const end = createCanvasVirtualGridWindow({ itemCount: 5, columns: 2, rowHeight: 100, rowGap: 10, scrollTop: 100, viewportHeight: 220, overscanRows: 2 });

    expect(start).toEqual({ startIndex: 0, endIndex: 5, totalHeight: 320 });
    expect(end).toEqual({ startIndex: 0, endIndex: 5, totalHeight: 320 });
});
