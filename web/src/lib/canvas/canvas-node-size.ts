import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";
import { clampCanvasZoom } from "./canvas-zoom";

export function fitCanvasNodes(nodes: Pick<CanvasNodeData, "position" | "width" | "height">[], area: { left: number; top: number; width: number; height: number }): ViewportTransform {
    if (!nodes.length) return { x: area.left + area.width / 2, y: area.top + area.height / 2, k: 1 };
    const left = Math.min(...nodes.map(node => node.position.x));
    const top = Math.min(...nodes.map(node => node.position.y));
    const width = Math.max(...nodes.map(node => node.position.x + node.width)) - left;
    const height = Math.max(...nodes.map(node => node.position.y + node.height)) - top;
    const k = clampCanvasZoom(Math.min(1, Math.max(1, area.width - 64) / Math.max(1, width), Math.max(1, area.height - 64) / Math.max(1, height)));
    return { x: area.left + area.width / 2 - (left + width / 2) * k, y: area.top + area.height / 2 - (top + height / 2) * k, k };
}

export function fitNodeSize(width: number, height: number, maxWidth = 640, maxHeight = 640) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const scale = Math.min(1, maxWidth / w, maxHeight / h);
    return { width: w * scale, height: h * scale };
}

export function nodeSizeFromRatio(size: string, baseWidth: number, baseHeight: number) {
    const match = size?.match(/^(\d+)(?:x|:)(\d+)/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    const ratio = width / Math.max(1, height);
    if (ratio < 0.25 || ratio > 4) return { width: baseWidth, height: baseHeight };
    return ratio >= baseWidth / baseHeight ? { width: baseWidth, height: baseWidth / ratio } : { width: baseHeight * ratio, height: baseHeight };
}
