import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { CanvasNodeType, type CanvasCompareSource, type CanvasNodeData } from "@/types/canvas";
import { getImageBlob } from "@/services/image-storage";
import { inlineCompareSources } from "./canvas-inline-compare";

export type CanvasCompareMode = "slider" | "side" | "overlay" | "difference";
export type CanvasCompareZoom = "fit" | 1 | 2 | 4;
export const CANVAS_DIFFERENCE_MAX_PIXELS = 4_000_000;
export const CANVAS_DIFFERENCE_MAX_EDGE = 4096;
type CompareImageSize = Pick<HTMLImageElement, "naturalWidth" | "naturalHeight">;

export function canvasDifferenceLayout(before: CompareImageSize, after: CompareImageSize) {
    if ([before.naturalWidth, before.naturalHeight, after.naturalWidth, after.naturalHeight].some(size => !Number.isSafeInteger(size) || size <= 0)) throw new Error("图片尺寸无效，请重新选择图片");
    const sourceWidth = Math.max(before.naturalWidth, after.naturalWidth), sourceHeight = Math.max(before.naturalHeight, after.naturalHeight);
    const scale = Math.min(1, CANVAS_DIFFERENCE_MAX_EDGE / sourceWidth, CANVAS_DIFFERENCE_MAX_EDGE / sourceHeight, Math.sqrt(CANVAS_DIFFERENCE_MAX_PIXELS / (sourceWidth * sourceHeight)));
    const sameSize = before.naturalWidth === after.naturalWidth && before.naturalHeight === after.naturalHeight;
    return { width: Math.max(1, Math.floor(sourceWidth * scale)), height: Math.max(1, Math.floor(sourceHeight * scale)), sameSize, downsampled: scale < 1, pixelExact: sameSize && scale === 1 };
}

export function canvasDifferenceNotice(layout: ReturnType<typeof canvasDifferenceLayout>) {
    if (layout.pixelExact) return "同尺寸原像素差异：按浏览器解码后的像素逐点比较，不是文件字节一致性校验，也不判断设计是否正确。";
    return `${!layout.sameSize ? "原图尺寸不同，各图按比例居中映射到公共框。" : "原图尺寸相同。"}${layout.downsampled ? "超过 400 万像素或单边 4096 限制，已降采样。" : "可能经过缩放。"}仅作展示差异，非原像素一致性检验。`;
}

/** Visible difference is the maximum absolute premultiplied RGB/alpha distance; hidden RGB at alpha=0 is ignored. */
export function canvasDifferencePixels(before: Uint8ClampedArray, after: Uint8ClampedArray) {
    if (before.length !== after.length || before.length % 4 !== 0) throw new Error("差异图像素数据尺寸不一致");
    if (before.length / 4 > CANVAS_DIFFERENCE_MAX_PIXELS) throw new Error("差异图超过本地处理上限");
    const result = new Uint8ClampedArray(before.length);
    for (let index = 0; index < before.length; index += 4) {
        const beforeAlpha = before[index + 3] / 255, afterAlpha = after[index + 3] / 255;
        const difference = Math.round(Math.max(
            Math.abs(before[index] * beforeAlpha - after[index] * afterAlpha),
            Math.abs(before[index + 1] * beforeAlpha - after[index + 1] * afterAlpha),
            Math.abs(before[index + 2] * beforeAlpha - after[index + 2] * afterAlpha),
            Math.abs(before[index + 3] - after[index + 3]),
        ));
        result[index] = result[index + 1] = result[index + 2] = difference;
        result[index + 3] = 255;
    }
    return result;
}

export function canvasComparePreviewScale(width: number, height: number, viewportWidth: number, viewportHeight: number, zoom: CanvasCompareZoom) {
    return zoom === "fit" ? Math.min(1, Math.max(1, viewportWidth) / width, Math.max(1, viewportHeight) / height) : zoom;
}
export function canvasCompareImages(nodes: CanvasNodeData[]) { return nodes.filter(node => node.type === CanvasNodeType.Image && Boolean(node.metadata?.content || node.metadata?.storageKey)); }

type CompareMedia = { content?: string; storageKey?: string };
function sameCompareMedia(a: CompareMedia | undefined, b: CompareMedia | undefined) {
    if (a?.storageKey && b?.storageKey) return a.storageKey === b.storageKey;
    return Boolean(a?.content && b?.content && a.content === b.content);
}

/** Names, versions and mutable node IDs are not media identity. */
export function canvasCompareSameImage(a: CanvasNodeData, b: CanvasNodeData) {
    return sameCompareMedia(a.metadata, b.metadata);
}

function snapshotCompareImage(source: CanvasCompareSource): CanvasNodeData {
    const identity = source.storageKey ? `storageKey:${source.storageKey}` : `content:${source.content}`;
    return {
        id: `canvas-compare-source:${bytesToHex(sha256(identity))}`,
        type: CanvasNodeType.Image,
        title: source.label || "来源图片",
        // Read-only candidates are never inserted into the canvas. Their original dimensions are unknown.
        position: { x: 0, y: 0 }, width: 0, height: 0,
        metadata: { content: source.content, ...(source.storageKey ? { storageKey: source.storageKey } : {}) },
    };
}

function findCompareSource(images: CanvasNodeData[], current: CanvasNodeData, source: CanvasCompareSource) {
    const matches = images.filter(image => image.id !== current.id && !canvasCompareSameImage(image, current) && sameCompareMedia(image.metadata, source));
    return matches.find(image => source.storageKey && image.metadata?.storageKey === source.storageKey) || matches[0];
}

/** Include saved originals even after the canvas node that held them is overwritten or deleted. */
export function canvasCompareCandidates(nodes: CanvasNodeData[]) {
    const images = canvasCompareImages(nodes);
    const candidates = [...images];
    // Prefer a durable snapshot over another snapshot containing only the same display URL.
    const snapshots = images.flatMap(current => inlineCompareSources(current).sources.map(source => ({ current, source })))
        .sort((a, b) => Number(Boolean(b.source.storageKey)) - Number(Boolean(a.source.storageKey)));
    for (const { current, source } of snapshots) {
        if (!sameCompareMedia(current.metadata, source) && !findCompareSource(candidates, current, source)) candidates.push(snapshotCompareImage(source));
    }
    return candidates;
}

export function canvasCompareSources(nodes: CanvasNodeData[], current: CanvasNodeData): { images: CanvasNodeData[]; automatic: boolean } {
    const { sources, automatic } = inlineCompareSources(current);
    const candidates = canvasCompareCandidates(nodes);
    const images: CanvasNodeData[] = [];
    for (const source of sources) {
        if (sameCompareMedia(current.metadata, source)) continue;
        const image = findCompareSource(candidates, current, source) || snapshotCompareImage(source);
        if (!images.some(candidate => canvasCompareSameImage(candidate, image))) images.push(image);
    }
    return { images, automatic: automatic && images.length === 1 };
}

export function chooseCanvasComparePair(nodes: CanvasNodeData[], selected: readonly string[]) {
    const images = canvasCompareCandidates(nodes);
    const chosen: CanvasNodeData[] = [];
    for (const id of selected) {
        const image = images.find(node => node.id === id);
        if (image && !chosen.some(node => node.id === image.id || canvasCompareSameImage(node, image))) chosen.push(image);
        if (chosen.length === 2) return [chosen[0].id, chosen[1].id] as const;
    }
    if (!chosen[0]) return ["", ""] as const;
    const sources = canvasCompareSources(nodes, chosen[0]);
    return [sources.automatic ? sources.images[0].id : "", chosen[0].id] as const;
}
export function compareContainRect(width: number, height: number, boxWidth: number, boxHeight: number) {
    const scale = Math.min(boxWidth / Math.max(1, width), boxHeight / Math.max(1, height));
    return { x: (boxWidth - width * scale) / 2, y: (boxHeight - height * scale) / 2, width: width * scale, height: height * scale };
}
export async function loadCanvasCompareImage(node: CanvasNodeData) {
    const blob = node.metadata?.storageKey ? await getImageBlob(node.metadata.storageKey) : null;
    const source = blob ? URL.createObjectURL(blob) : node.metadata?.content;
    if (!source) throw new Error("原图不可用，请重新上传图片");
    try {
        return await new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.crossOrigin = "anonymous"; image.onload = () => resolve(image); image.onerror = () => reject(new Error("图片加载失败，请检查原图是否可访问")); image.src = source; });
    } finally { if (blob) URL.revokeObjectURL(source); }
}
export function drawCanvasCompare(canvas: HTMLCanvasElement, before: HTMLImageElement, after: HTMLImageElement, mode: CanvasCompareMode, value: number, background: string, foreground: string) {
    if (mode === "difference") {
        const layout = canvasDifferenceLayout(before, after);
        canvas.width = layout.width; canvas.height = layout.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("浏览器不支持图片合成");
        const read = (image: HTMLImageElement) => {
            const rect = compareContainRect(image.naturalWidth, image.naturalHeight, layout.width, layout.height);
            context.clearRect(0, 0, layout.width, layout.height);
            context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
            return context.getImageData(0, 0, layout.width, layout.height);
        };
        const beforePixels = read(before), afterPixels = read(after);
        beforePixels.data.set(canvasDifferencePixels(beforePixels.data, afterPixels.data));
        context.putImageData(beforePixels, 0, 0);
        return;
    }
    const width = mode === "side" ? 1600 : 1000, height = 1000, header = 48;
    canvas.width = width; canvas.height = height + header;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持图片合成");
    context.fillStyle = background; context.fillRect(0, 0, width, height + header);
    const draw = (image: HTMLImageElement, x = 0, boxWidth = width) => { const rect = compareContainRect(image.naturalWidth, image.naturalHeight, boxWidth, height); context.drawImage(image, x + rect.x, header + rect.y, rect.width, rect.height); };
    const ratio = Math.min(1, Math.max(0, value / 100));
    if (mode === "side") { draw(before, 0, width / 2); draw(after, width / 2, width / 2); }
    else { draw(before); context.save(); if (mode === "slider") { context.beginPath(); context.rect(width * ratio, header, width * (1 - ratio), height); context.clip(); } else context.globalAlpha = ratio; draw(after); context.restore(); if (mode === "slider") { context.strokeStyle = foreground; context.beginPath(); context.moveTo(width * ratio, header); context.lineTo(width * ratio, height + header); context.stroke(); } }
    context.fillStyle = foreground; context.font = "20px sans-serif"; context.textAlign = "left"; context.fillText("改款前", 20, 31); context.textAlign = "right"; context.fillText("改款后", width - 20, 31);
}
