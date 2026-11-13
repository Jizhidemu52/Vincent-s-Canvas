import type { LayerStudioBoundingBox, LayerStudioItem, LayerStudioResultDocument } from "../../../../shared/layer-studio";

export type LayerStudioLayerEdit = {
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
    visible: boolean;
    /** Bottom to top, within the item's original result group. */
    order: number;
};
export type LayerStudioEditDocument = {
    version: 1;
    taskId: string;
    layers: LayerStudioLayerEdit[];
    selectedIndex: number | null;
};
export type LayerStudioSize = { width: number; height: number };
export type LayerStudioDimensions = ReadonlyMap<number, LayerStudioSize>;
export type LayerStudioGroup = { index: number; items: LayerStudioItem[]; size: LayerStudioSize | null };
export type LayerStudioImage = LayerStudioSize & { image: CanvasImageSource; dispose: () => void };
export type LayerStudioImageReader = (item: LayerStudioItem, signal?: AbortSignal) => Promise<LayerStudioImage>;

const MAX_CANVAS_PIXELS = 36_000_000;
const MAX_COORDINATE = 1_000_000;
export function validLayerStudioSize(size?: Partial<LayerStudioSize> | null): size is LayerStudioSize {
    return Boolean(size && Number.isInteger(size.width) && Number.isInteger(size.height) && size.width! > 0 && size.height! > 0
        && size.width! <= 32_768 && size.height! <= 32_768 && size.width! * size.height! <= MAX_CANVAS_PIXELS);
}

export function layerStudioGroups(document: LayerStudioResultDocument, dimensions: LayerStudioDimensions = new Map()): LayerStudioGroup[] {
    const groups = new Map<number, LayerStudioItem[]>();
    for (const item of document.items) groups.set(item.groupIndex, [...(groups.get(item.groupIndex) || []), item]);
    return [...groups].sort(([a], [b]) => a - b).map(([index, items]) => {
        const base = items.find(item => item.role === "base") || items.find(item => item.urlIndex === 0);
        const size = base && (dimensions.get(base.index) || base);
        return { index, items, size: validLayerStudioSize(size) ? { width: size.width, height: size.height } : null };
    });
}

function validBox(box: unknown, width: number, height: number): box is [number, number, number, number] {
    return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite)
        && box[0] >= 0 && box[1] >= 0 && box[2] > box[0] && box[3] > box[1] && box[2] <= width && box[3] <= height;
}

/** Provider placement uses the base coordinate grid, never the layer file's pixels. */
export function layerStudioBoxRect(box: LayerStudioBoundingBox | undefined, size: LayerStudioSize) {
    if (validBox(box?.absolute, size.width, size.height)) {
        const [left, top, right, bottom] = box.absolute;
        return { x: left, y: top, width: right - left, height: bottom - top };
    }
    if (validBox(box?.normalized, 1000, 1000)) {
        const [left, top, right, bottom] = box.normalized;
        return { x: left / 1000 * size.width, y: top / 1000 * size.height,
            width: (right - left) / 1000 * size.width, height: (bottom - top) / 1000 * size.height };
    }
    return null;
}

export function initialLayerStudioRect(item: LayerStudioItem, size: LayerStudioSize, dimensions: LayerStudioDimensions = new Map()) {
    if (item.role === "base" || item.role === "image" || item.urlIndex === 0) return { x: 0, y: 0, ...size };
    const placement = layerStudioBoxRect(item.boundingBox, size);
    if (placement) return placement;
    const natural = dimensions.get(item.index) || item;
    // A centered original is a visible manual starting point, not invented provider metadata.
    if (!validLayerStudioSize(natural)) return null;
    return { x: (size.width - natural.width) / 2, y: (size.height - natural.height) / 2,
        width: natural.width, height: natural.height };
}

function validEdit(value: unknown): value is LayerStudioLayerEdit {
    if (!value || typeof value !== "object") return false;
    const item = value as LayerStudioLayerEdit;
    return Number.isInteger(item.index) && [item.x, item.y, item.width, item.height].every(value => Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE)
        && item.width >= 1 && item.height >= 1 && typeof item.visible === "boolean" && Number.isFinite(item.order);
}

/** Add newly saved items without resetting already edited layers or accepting another task's draft. */
export function createLayerStudioEditDocument(document: LayerStudioResultDocument, previous?: LayerStudioEditDocument, dimensions: LayerStudioDimensions = new Map()): LayerStudioEditDocument {
    const saved = previous?.version === 1 && previous.taskId === document.taskId && Array.isArray(previous.layers)
        ? new Map(previous.layers.filter(validEdit).map(layer => [layer.index, layer])) : new Map<number, LayerStudioLayerEdit>();
    const layers: LayerStudioLayerEdit[] = [];
    for (const group of layerStudioGroups(document, dimensions)) {
        const sorted = [...group.items].sort((a, b) => (Number.isFinite(a.zIndex) ? a.zIndex! : a.urlIndex) - (Number.isFinite(b.zIndex) ? b.zIndex! : b.urlIndex) || a.urlIndex - b.urlIndex);
        for (const [order, item] of sorted.entries()) {
            const known = saved.get(item.index);
            if (known) {
                // Explicit fields only: never persist URLs, raw OCR or provider identities in transforms.
                const { index, x, y, width, height, visible, order: savedOrder } = known;
                layers.push({ index, x, y, width, height, visible, order: savedOrder });
            } else if (group.size) {
                const rect = initialLayerStudioRect(item, group.size, dimensions);
                if (rect) layers.push({ index: item.index, ...rect, visible: true, order });
            }
        }
    }
    const oldSelection = previous?.taskId === document.taskId ? previous.selectedIndex : null;
    const selectedIndex = document.items.some(item => item.index === oldSelection) ? oldSelection!
        : document.items.find(item => item.role === "layer" && item.state === "saved")?.index ?? document.items[0]?.index ?? null;
    return { version: 1, taskId: document.taskId, layers, selectedIndex };
}

export function updateLayerStudioEdit(document: LayerStudioEditDocument, index: number, patch: Partial<Omit<LayerStudioLayerEdit, "index" | "order">>) {
    return { ...document, layers: document.layers.map(layer => {
        if (layer.index !== index) return layer;
        const next = { ...layer, ...patch };
        if (!validEdit(next)) throw new Error("图层位置与宽高必须为有效数值，宽高至少为 1 像素");
        return next;
    }) };
}

export function orderedLayerStudioItems(group: LayerStudioGroup, value: LayerStudioEditDocument) {
    const edits = new Map(value.layers.map(layer => [layer.index, layer]));
    return [...group.items].sort((a, b) => (edits.get(a.index)?.order ?? a.zIndex ?? a.urlIndex) - (edits.get(b.index)?.order ?? b.zIndex ?? b.urlIndex) || a.urlIndex - b.urlIndex);
}

export function moveLayerStudioOrder(document: LayerStudioEditDocument, group: LayerStudioGroup, index: number, direction: -1 | 1) {
    const order = orderedLayerStudioItems(group, document).map(item => item.index);
    const from = order.indexOf(index), to = from + direction;
    if (from < 0 || to < 0 || to >= order.length) return document;
    [order[from], order[to]] = [order[to], order[from]];
    return { ...document, layers: document.layers.map(layer => order.includes(layer.index) ? { ...layer, order: order.indexOf(layer.index) } : layer) };
}

export function layerStudioPoint(point: { clientX: number; clientY: number }, bounds: Pick<DOMRect, "left" | "top" | "width" | "height">, size: LayerStudioSize) {
    return { x: (point.clientX - bounds.left) / Math.max(1, bounds.width) * size.width,
        y: (point.clientY - bounds.top) / Math.max(1, bounds.height) * size.height };
}

export function hitLayerStudioItem(group: LayerStudioGroup, value: LayerStudioEditDocument, point: { x: number; y: number }) {
    const edits = new Map(value.layers.map(layer => [layer.index, layer]));
    return orderedLayerStudioItems(group, value).reverse().find(item => {
        const layer = edits.get(item.index);
        return item.state === "saved" && layer?.visible && point.x >= layer.x && point.y >= layer.y
            && point.x <= layer.x + layer.width && point.y <= layer.y + layer.height;
    });
}

export function scaleLayerStudioEdit(layer: LayerStudioLayerEdit, width: number, height: number) {
    return { x: layer.x + (layer.width - width) / 2, y: layer.y + (layer.height - height) / 2, width, height };
}

/** The same draw path serves the preview and original-resolution PNG export. */
export async function renderLayerStudioComposition(canvas: HTMLCanvasElement, document: LayerStudioResultDocument, value: LayerStudioEditDocument,
    group: LayerStudioGroup, readImage: LayerStudioImageReader, options: { signal?: AbortSignal; scale?: number; allowPartial?: boolean } = {}) {
    const { signal, allowPartial = false } = options;
    signal?.throwIfAborted();
    if (document.taskId !== value.taskId || !group.size) throw new Error("底图尺寸尚未就绪，无法合成；当前编辑已保留");
    if (!allowPartial && (document.status !== "ready" || document.items.length !== document.expectedOutputCount || group.items.some(item => item.state !== "saved"))) {
        throw new Error("原件尚未全部保存，暂不能导出完整合成图；当前编辑已保留");
    }
    const scale = options.scale ?? 1;
    if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw new Error("预览比例无效");
    canvas.width = Math.max(1, Math.round(group.size.width * scale));
    canvas.height = Math.max(1, Math.round(group.size.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建图层画布");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(canvas.width / group.size.width, 0, 0, canvas.height / group.size.height, 0, 0);
    context.imageSmoothingQuality = "high";
    const edits = new Map(value.layers.map(layer => [layer.index, layer]));
    const unavailable: Array<{ index: number; message: string }> = [];
    for (const item of orderedLayerStudioItems(group, value)) {
        signal?.throwIfAborted();
        const layer = edits.get(item.index);
        if (layer?.visible === false) continue;
        let source: LayerStudioImage | undefined;
        try {
            if (item.state !== "saved") throw new Error("图层原件尚未保存，请查询或恢复原任务保存");
            if (!layer) throw new Error("图层定位尺寸尚未就绪，请重新读取已保存原件");
            source = await readImage(item, signal);
            signal?.throwIfAborted();
            context.drawImage(source.image, layer.x, layer.y, layer.width, layer.height);
        } catch (error) {
            signal?.throwIfAborted();
            if (!allowPartial) throw error;
            unavailable.push({ index: item.index, message: error instanceof Error ? error.message : "图层读取失败" });
        } finally { source?.dispose(); }
    }
    return { unavailable };
}

export function layerStudioPngBlob(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        let settled = false;
        const finish = (blob: Blob | null, error?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
            if (error) reject(error);
            else if (!blob?.size || blob.type !== "image/png") reject(new Error("PNG 导出失败，当前编辑与原件已保留"));
            else resolve(blob);
        };
        const abort = () => finish(null, signal?.reason || new DOMException("导出已停止", "AbortError"));
        const timeout = setTimeout(() => finish(null, new Error("PNG 编码超时，当前编辑与原件已保留")), 30_000);
        signal?.addEventListener("abort", abort, { once: true });
        try { canvas.toBlob(blob => finish(blob), "image/png"); }
        catch (error) { finish(null, error); }
    });
}
