import { describe, expect, test } from "bun:test";

import { createDragPreview, resolvePreviewPosition } from "@/lib/canvas/canvas-drag-preview";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const source: CanvasNodeData = {
    id: "a",
    type: CanvasNodeType.Text,
    title: "a",
    position: { x: 10, y: 20 },
    width: 100,
    height: 50,
};

describe("canvas drag preview", () => {
    test("keeps document positions unchanged while exposing an rAF preview", () => {
        const preview = createDragPreview(
            [
                { id: "a", x: 10, y: 20 },
                { id: "b", x: -5, y: 3 },
            ],
            12,
            -8,
        );

        expect(resolvePreviewPosition(source, preview)).toEqual({ x: 22, y: 12 });
        expect(source.position).toEqual({ x: 10, y: 20 });
        expect(preview.get("b")).toEqual({ x: 7, y: -5 });
    });

    test("falls back to the persisted position when the node is not being dragged", () => {
        expect(resolvePreviewPosition(source, new Map())).toEqual(source.position);
    });
});
