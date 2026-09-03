import { describe, expect, test } from "bun:test";

import { createDragPreview, createPreviewNodeResolver, resolvePreviewPosition } from "@/lib/canvas/canvas-drag-preview";
import { createResizePreview } from "@/lib/canvas/canvas-resize-preview";
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

    test("only creates preview node objects for nodes currently being dragged", () => {
        const stable: CanvasNodeData = { ...source, id: "stable", position: { x: 200, y: 20 } };
        const resolveNode = createPreviewNodeResolver(
            new Map([[source.id, source], [stable.id, stable]]),
            new Map([[source.id, { x: 42, y: 64 }]]),
        );

        expect(resolveNode(source.id)).toEqual({ ...source, position: { x: 42, y: 64 } });
        expect(resolveNode(source.id)).not.toBe(source);
        expect(resolveNode(stable.id)).toBe(stable);
    });

    test("combines resize bounds with drag positions for connection rendering", () => {
        const resolveNode = createPreviewNodeResolver(
            new Map([[source.id, source]]),
            new Map([[source.id, { x: 42, y: 64 }]]),
            createResizePreview(source.id, { position: { x: 20, y: 30 }, width: 360, height: 220 }),
        );

        expect(resolveNode(source.id)).toEqual({
            ...source,
            position: { x: 42, y: 64 },
            width: 360,
            height: 220,
        });
    });
});
