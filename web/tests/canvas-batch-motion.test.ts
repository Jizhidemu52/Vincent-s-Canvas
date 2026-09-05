import { expect, test } from "bun:test";

import { createCanvasBatchIndexes, createCanvasBatchMotionById, createCanvasBatchRenderIndex } from "@/lib/canvas/canvas-batch-motion";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, x: number, y: number, metadata?: CanvasNodeData["metadata"]): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Image,
    title: id,
    position: { x, y },
    width: 100,
    height: 100,
    metadata,
});

test("indexes batch child motion from the parent's declared child order", () => {
    const root = node("root", 100, 100, { isBatchRoot: true, batchChildIds: ["first", "second"] });
    const first = node("first", 50, 60, { batchRootId: "root" });
    const second = node("second", 70, 80, { batchRootId: "root" });

    const motion = createCanvasBatchMotionById([root, first, second], new Map([[root.id, root], [first.id, first], [second.id, second]]));

    expect(motion.get("first")).toEqual({ x: 84, y: 54, index: 0 });
    expect(motion.get("second")).toEqual({ x: 78, y: 42, index: 1 });
});

test("keeps an orphan batch child at its own position", () => {
    const child = node("child", 50, 60, { batchRootId: "missing" });

    expect(createCanvasBatchMotionById([child], new Map([[child.id, child]])).get("child")).toEqual({ x: 0, y: 0, index: 0 });
});

test("builds root visibility and child motion indexes in the same traversal", () => {
    const root = node("root", 100, 100, { isBatchRoot: true, batchChildIds: ["child"] });
    const child = node("child", 50, 60, { batchRootId: "root" });
    const indexes = createCanvasBatchIndexes([root, child], new Map([[root.id, root], [child.id, child]]));

    expect(indexes.rootsById.get("root")).toBe(root);
    expect(indexes.childCountByRootId.get("root")).toBe(1);
    expect(indexes.motionById.get("child")).toEqual({ x: 84, y: 54, index: 0 });
});

test("calculates and reuses child stack motion only when a rendered child needs it", () => {
    const root = node("root", 100, 100, { isBatchRoot: true, batchChildIds: ["child"] });
    const child = node("child", 50, 60, { batchRootId: "root" });
    const index = createCanvasBatchRenderIndex([root, child]);

    expect(index.childCountByRootId.get("root")).toBe(1);
    expect(index.getMotion(root)).toBeUndefined();
    const first = index.getMotion(child);
    expect(first).toEqual({ x: 84, y: 54, index: 0 });
    expect(index.getMotion(child)).toBe(first);
});
