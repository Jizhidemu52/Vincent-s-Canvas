import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export type MinimapNodeRect = {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
};

export function createMinimapNodeRects(nodes: CanvasNodeData[], scale: number, offset: { x: number; y: number }, mutedColor: string): MinimapNodeRect[] {
    return nodes.map((node) => ({
        id: node.id,
        x: node.position.x * scale + offset.x,
        y: node.position.y * scale + offset.y,
        width: Math.max(node.width * scale, 2),
        height: Math.max(node.height * scale, 2),
        color: node.type === CanvasNodeType.Image ? "#10b981" : node.type === CanvasNodeType.Video ? "#f97316" : node.type === CanvasNodeType.Audio ? "#a855f7" : node.type === CanvasNodeType.Config ? "#60a5fa" : mutedColor,
    }));
}
