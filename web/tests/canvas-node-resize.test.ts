import { expect, test } from "bun:test";

import { canvasNodeResizePointerDelta, canvasNodeResizeStartPosition } from "@/lib/canvas/canvas-node-resize";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

test("converts a screen resize movement with the live canvas scale", () => {
    expect(canvasNodeResizePointerDelta({ startX: 100, startY: 80, clientX: 160, clientY: 120, scale: 0.5 })).toEqual({ x: 120, y: 80 });
});

test("keeps resize movement finite at an invalidly small scale", () => {
    expect(canvasNodeResizePointerDelta({ startX: 100, startY: 80, clientX: 160, clientY: 120, scale: 0 })).toEqual({ x: 600000, y: 400000 });
});

test("resolves resize positions from the live node index before using a safe fallback", () => {
    const node: CanvasNodeData = {
        id: "resize-node",
        type: CanvasNodeType.Image,
        title: "resize-node",
        position: { x: 120, y: 80 },
        width: 320,
        height: 240,
    };
    const nodeById = new Map([[node.id, node]]);

    expect(canvasNodeResizeStartPosition(nodeById, node.id)).toEqual({ x: 120, y: 80 });
    expect(canvasNodeResizeStartPosition(nodeById, node.id, { x: 40, y: 20 })).toEqual({ x: 40, y: 20 });
    expect(canvasNodeResizeStartPosition(nodeById, "missing")).toEqual({ x: 0, y: 0 });
});
