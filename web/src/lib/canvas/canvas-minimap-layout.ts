import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export type MinimapNodeGeometry = Pick<CanvasNodeData, "id" | "type" | "position" | "width" | "height">;

export type MinimapLayout = {
    nodes: MinimapNodeGeometry[];
    worldBounds: { x: number; y: number; w: number; h: number };
    scale: number;
    offset: { x: number; y: number };
    width: number;
    height: number;
};

export type MinimapNodeRect = {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
};

function copyMinimapNodeGeometry(nodes: readonly MinimapNodeGeometry[]): MinimapNodeGeometry[] {
    return nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: { x: node.position.x, y: node.position.y },
        width: node.width,
        height: node.height,
    }));
}

function hasSameMinimapGeometry(previous: readonly MinimapNodeGeometry[], next: readonly MinimapNodeGeometry[]) {
    return previous.length === next.length && previous.every((node, index) => {
        const nextNode = next[index];
        return Boolean(nextNode) && node.id === nextNode.id && node.type === nextNode.type && node.position.x === nextNode.position.x && node.position.y === nextNode.position.y && node.width === nextNode.width && node.height === nextNode.height;
    });
}

export function createMinimapLayout(nodes: readonly MinimapNodeGeometry[], width: number, height: number): MinimapLayout {
    const geometry = copyMinimapNodeGeometry(nodes);
    if (!geometry.length) {
        return { nodes: geometry, worldBounds: { x: -500, y: -500, w: 1000, h: 1000 }, scale: 0.16, offset: { x: 40, y: 0 }, width, height };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    geometry.forEach((node) => {
        minX = Math.min(minX, node.position.x);
        minY = Math.min(minY, node.position.y);
        maxX = Math.max(maxX, node.position.x + node.width);
        maxY = Math.max(maxY, node.position.y + node.height);
    });

    minX -= 500;
    minY -= 500;
    maxX += 500;
    maxY += 500;

    const boundsWidth = maxX - minX;
    const boundsHeight = maxY - minY;
    const scale = Math.min(width / boundsWidth, height / boundsHeight);
    const mapContentW = boundsWidth * scale;
    const mapContentH = boundsHeight * scale;

    return {
        nodes: geometry,
        worldBounds: { x: minX, y: minY, w: boundsWidth, h: boundsHeight },
        scale,
        offset: { x: (width - mapContentW) / 2, y: (height - mapContentH) / 2 },
        width,
        height,
    };
}

export function refreshMinimapLayout(previous: MinimapLayout, nodes: readonly MinimapNodeGeometry[], width: number, height: number): MinimapLayout {
    if (previous.width === width && previous.height === height && hasSameMinimapGeometry(previous.nodes, nodes)) return previous;
    return createMinimapLayout(nodes, width, height);
}

export function createMinimapNodeRects(nodes: readonly MinimapNodeGeometry[], scale: number, offset: { x: number; y: number }, mutedColor: string): MinimapNodeRect[] {
    return nodes.map((node) => ({
        id: node.id,
        x: node.position.x * scale + offset.x,
        y: node.position.y * scale + offset.y,
        width: Math.max(node.width * scale, 2),
        height: Math.max(node.height * scale, 2),
        color: node.type === CanvasNodeType.Image ? "#10b981" : node.type === CanvasNodeType.Video ? "#f97316" : node.type === CanvasNodeType.Audio ? "#a855f7" : node.type === CanvasNodeType.Config ? "#60a5fa" : mutedColor,
    }));
}
