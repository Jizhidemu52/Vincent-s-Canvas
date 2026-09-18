import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { getImageBlob } from "@/services/image-storage";

export type CanvasCompareMode = "slider" | "side" | "overlay";
export function canvasCompareImages(nodes: CanvasNodeData[]) { return nodes.filter(node => node.type === CanvasNodeType.Image && Boolean(node.metadata?.content || node.metadata?.storageKey)); }
export function chooseCanvasComparePair(nodes: CanvasNodeData[], selected: readonly string[]) {
    const images = canvasCompareImages(nodes);
    const chosen = selected.map(id => images.find(node => node.id === id)).filter((node): node is CanvasNodeData => Boolean(node));
    const first = chosen[0] || images[0];
    const sameSource = first?.metadata?.imageName ? images.filter(node => node.id !== first.id && node.metadata?.imageName === first.metadata?.imageName && node.metadata?.imageVersion !== first.metadata?.imageVersion).sort((a, b) => Math.abs((a.metadata?.imageVersion || 1) - (first.metadata?.imageVersion || 1)) - Math.abs((b.metadata?.imageVersion || 1) - (first.metadata?.imageVersion || 1))) : [];
    return [first?.id || "", chosen[1]?.id || sameSource[0]?.id || ""] as const;
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
