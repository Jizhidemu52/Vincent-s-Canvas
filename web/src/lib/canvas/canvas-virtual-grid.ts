type CanvasVirtualGridOptions = {
    itemCount: number;
    columns: number;
    rowHeight: number;
    rowGap: number;
    scrollTop: number;
    viewportHeight: number;
    overscanRows: number;
};

export function createCanvasVirtualGridWindow({ itemCount, columns, rowHeight, rowGap, scrollTop, viewportHeight, overscanRows }: CanvasVirtualGridOptions) {
    const safeColumns = Math.max(1, columns);
    const totalRows = Math.ceil(Math.max(0, itemCount) / safeColumns);
    if (!totalRows) return { startIndex: 0, endIndex: 0, totalHeight: 0 };

    const rowStride = rowHeight + rowGap;
    const startRow = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowStride) - Math.max(0, overscanRows));
    const endRow = Math.min(
        totalRows,
        Math.ceil((Math.max(0, scrollTop) + Math.max(rowHeight, viewportHeight)) / rowStride) + Math.max(0, overscanRows),
    );
    return {
        startIndex: startRow * safeColumns,
        endIndex: Math.min(itemCount, endRow * safeColumns),
        totalHeight: totalRows * rowStride - rowGap,
    };
}
