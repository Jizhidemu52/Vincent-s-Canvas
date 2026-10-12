export type CanvasProjectGridLayout = {
    rowCount: number;
    offsets: number[];
    heights: number[];
    totalHeight: number;
};

/** Measured row sizes retain natural card height, including an active rename. */
export function createCanvasProjectGridLayout(count: number, columns: number, estimatedHeight: number, gap: number, measured: ReadonlyMap<number, number> = new Map()): CanvasProjectGridLayout {
    const rowCount = Math.ceil(Math.max(0, count) / Math.max(1, columns));
    const heights = Array.from({ length: rowCount }, (_, row) => Math.max(1, measured.get(row) || estimatedHeight));
    const offsets: number[] = [];
    let totalHeight = 0;
    for (const height of heights) {
        offsets.push(totalHeight);
        totalHeight += height + gap;
    }
    return { rowCount, offsets, heights, totalHeight: Math.max(0, totalHeight - (rowCount ? gap : 0)) };
}

export function canvasProjectGridWindow(layout: CanvasProjectGridLayout, scrollOffset: number, viewportHeight: number, overscan = 2, pinnedRow = -1) {
    if (!layout.rowCount) return { rows: [] as number[], firstVisibleRow: 0, firstRow: 0, lastRow: -1 };
    // A delete or responsive-column change can leave the old scroll position
    // beyond the new end until the browser applies its next layout. Clamp now.
    const top = Math.max(0, Math.min(scrollOffset, Math.max(0, layout.totalHeight - Math.max(1, viewportHeight))));
    const bottom = top + Math.max(1, viewportHeight);
    let low = 0, high = layout.rowCount - 1;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (layout.offsets[middle] + layout.heights[middle] <= top) low = middle + 1;
        else high = middle;
    }
    const firstVisibleRow = low;
    low = firstVisibleRow;
    high = layout.rowCount - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (layout.offsets[middle] < bottom) low = middle;
        else high = middle - 1;
    }
    const firstRow = Math.max(0, firstVisibleRow - overscan);
    const lastRow = Math.min(layout.rowCount - 1, low + overscan);
    const rows = Array.from({ length: lastRow - firstRow + 1 }, (_, index) => firstRow + index);
    if (pinnedRow >= 0 && pinnedRow < layout.rowCount && (pinnedRow < firstRow || pinnedRow > lastRow)) rows.push(pinnedRow);
    rows.sort((a, b) => a - b);
    return { rows, firstVisibleRow, firstRow, lastRow };
}
