import { describe, expect, test } from "bun:test";

import { createResizePreview, createResizePreviewNodeResolver } from "@/lib/canvas/canvas-resize-preview";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const source: CanvasNodeData = {
    id: "resizing",
    type: CanvasNodeType.Text,
    title: "resizing",
    position: { x: 40, y: 60 },
    width: 320,
    height: 240,
};

describe("canvas resize preview", () => {
    test("keeps persisted bounds unchanged while exposing the resize preview", () => {
        const preview = createResizePreview("resizing", {
            position: { x: 10, y: 30 },
            width: 480,
            height: 360,
        });
        const resolveNode = createResizePreviewNodeResolver(new Map([[source.id, source]]), preview);

        expect(resolveNode(source.id)).toEqual({
            ...source,
            position: { x: 10, y: 30 },
            width: 480,
            height: 360,
        });
        expect(source).toEqual({
            ...source,
            position: { x: 40, y: 60 },
            width: 320,
            height: 240,
        });
    });

    test("reuses persisted objects for nodes outside the active resize", () => {
        const stable: CanvasNodeData = { ...source, id: "stable" };
        const resolveNode = createResizePreviewNodeResolver(
            new Map([
                [source.id, source],
                [stable.id, stable],
            ]),
            createResizePreview(source.id, { position: { x: 40, y: 60 }, width: 360, height: 260 }),
        );

        expect(resolveNode(stable.id)).toBe(stable);
        expect(resolveNode(source.id)).not.toBe(source);
    });
});
