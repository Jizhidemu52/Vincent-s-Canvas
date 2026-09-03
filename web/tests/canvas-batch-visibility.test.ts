import { expect, test } from "bun:test";

import { createCanvasBatchRootIndex, isCanvasBatchChildHidden, isCanvasBatchConnectionEndpointHidden } from "@/lib/canvas/canvas-batch-visibility";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, metadata?: CanvasNodeData["metadata"]): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Image,
    title: id,
    position: { x: 0, y: 0 },
    width: 100,
    height: 100,
    metadata,
});

test("keeps collapsed batch children hidden unless their batch is animating closed", () => {
    const root = node("root", { isBatchRoot: true, imageBatchExpanded: false });
    const child = node("child", { batchRootId: "root" });
    const roots = createCanvasBatchRootIndex([root, child]);

    expect(isCanvasBatchChildHidden(child, roots)).toBe(true);
    expect(isCanvasBatchChildHidden(child, roots, new Set(["root"]))).toBe(false);
});

test("only hides connection endpoints for an existing collapsed batch root", () => {
    const root = node("root", { isBatchRoot: true, imageBatchExpanded: true });
    const expandedChild = node("expanded-child", { batchRootId: "root" });
    const orphan = node("orphan", { batchRootId: "missing" });
    const roots = createCanvasBatchRootIndex([root, expandedChild, orphan]);

    expect(isCanvasBatchConnectionEndpointHidden(expandedChild, roots)).toBe(false);
    expect(isCanvasBatchConnectionEndpointHidden(orphan, roots)).toBe(false);
});
