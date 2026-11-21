import type { CanvasNodeData } from "@/types/canvas";
import type { TryoutBoardCell, TryoutBoardOptions } from "../../../../shared/tryout";

export type ProposalBoardSpec = {
    version: 1;
    page: "a4-landscape" | "a4-portrait" | "wide-16-9";
    layout: "single" | "compare" | "feature" | "grid" | "colorway";
    title: string;
    fields: { styleNo: string; fabric: string; craft: string; note: string };
    footer: { designer: string; date: string };
    items: Array<{ nodeId: string; storageKey?: string; serverAssetId?: string; content?: string; caption: string; dominantHex?: string }>;
    palette: Array<{ hex: string; label?: string }>;
    showPalette: boolean;
};

export type BoardRect = { x: number; y: number; width: number; height: number };
export type PairedProposalBoard = Omit<ProposalBoardSpec, "version"> & TryoutBoardOptions & { version: 2; cells: TryoutBoardCell[] };
export type AnyProposalBoard = ProposalBoardSpec | PairedProposalBoard;
export type BoardLayout = {
    size: { width: number; height: number };
    title: BoardRect;
    images: BoardRect[];
    captions: BoardRect[];
    palette: BoardRect | null;
    fields: BoardRect | null;
    footer: BoardRect;
};

export function pageSize(page: ProposalBoardSpec["page"]) {
    switch (page) {
        case "a4-landscape": return { width: 1754, height: 1240 };
        case "a4-portrait": return { width: 1240, height: 1754 };
        case "wide-16-9": return { width: 1920, height: 1080 };
    }
}

export function defaultLayout(count: number, sameStyle: boolean): ProposalBoardSpec["layout"] {
    if (count <= 1) return "single";
    if (sameStyle) return "colorway";
    return count === 2 ? "compare" : count <= 4 ? "feature" : "grid";
}

function gridCells(box: BoardRect, count: number, columns: number, gap: number): BoardRect[] {
    const rows = Math.ceil(count / columns);
    const width = (box.width - gap * (columns - 1)) / columns;
    const height = (box.height - gap * (rows - 1)) / rows;
    return Array.from({ length: count }, (_, i) => ({
        x: box.x + (i % columns) * (width + gap), y: box.y + Math.floor(i / columns) * (height + gap), width, height,
    }));
}

function imageCells(layout: ProposalBoardSpec["layout"], box: BoardRect, count: number, gap: number): BoardRect[] {
    if (layout === "feature" && count > 1) {
        const width = (box.width - gap) * 0.6;
        return [{ ...box, width }, ...gridCells({ ...box, x: box.x + width + gap, width: box.width - width - gap }, count - 1, 1, gap)];
    }
    const columns = layout === "colorway" ? count : layout === "compare" ? Math.min(count, 2)
        : layout === "grid" ? Math.min(count, count <= 6 ? 3 : 4) : Math.ceil(Math.sqrt(count));
    return gridCells(box, count, columns, gap);
}

export function computeBoardLayout(spec: AnyProposalBoard): BoardLayout {
    const count = spec.version === 2 ? spec.cells.length : spec.items.length;
    if (count < 1 || count > 8) throw new RangeError("提案板需要 1 到 8 张图片");
    const size = pageSize(spec.version === 2 ? (spec.orientation === "portrait" ? "a4-portrait" : "a4-landscape") : spec.page);
    const shortSide = Math.min(size.width, size.height);
    const margin = shortSide * 0.04, gap = shortSide * 0.015;
    const width = size.width - margin * 2;
    const title = { x: margin, y: margin, width, height: size.height * 0.09 };
    const footerHeight = size.height * 0.04;
    const footer = { x: margin, y: size.height - margin - footerHeight, width, height: footerHeight };
    const paletteHeight = size.height * 0.07;
    const palette = spec.showPalette && spec.palette.length ? { x: margin, y: footer.y - gap - paletteHeight, width, height: paletteHeight } : null;
    const y = title.y + title.height + gap;
    const body = { x: margin, y, width, height: (palette ?? footer).y - gap - y };
    const hasFields = Object.values(spec.fields).some(value => value.trim());
    const fieldWidth = (width - gap) * (spec.layout === "single" ? 0.3 : 0.22);
    const fields = hasFields ? { ...body, x: margin + width - fieldWidth, width: fieldWidth } : null;
    const available = { ...body, width: fields ? width - fieldWidth - gap : width };
    const cells = spec.version === 2 ? gridCells(available, count, Math.min(count,spec.columns), gap) : imageCells(spec.layout, available, count, gap);
    const captionHeights = cells.map(cell => Math.min(shortSide * 0.035, cell.height * 0.22));
    const images = cells.map((cell, i) => ({ ...cell, height: cell.height - captionHeights[i] }));
    const captions = cells.map((cell, i) => ({ ...cell, y: cell.y + images[i].height, height: captionHeights[i] }));
    return { size, title, images, captions, fields, palette, footer };
}

export function boardStaleItems(spec: AnyProposalBoard, nodesById: ReadonlyMap<string, CanvasNodeData>): number[] {
    return spec.items.flatMap((item, i) => {
        const node = nodesById.get(item.nodeId);
        if (!node) return [];
        if (item.storageKey || node.metadata?.storageKey) return item.storageKey !== node.metadata?.storageKey ? [i] : [];
        if (item.serverAssetId || node.metadata?.serverAssetId) return item.serverAssetId !== node.metadata?.serverAssetId ? [i] : [];
        return item.content !== node.metadata?.content ? [i] : [];
    });
}
