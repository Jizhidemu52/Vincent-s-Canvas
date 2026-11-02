import { expect, test } from "bun:test";
import { snapCanvasDrag, transferCanvasGroupMembers } from "../src/lib/canvas/canvas-selection-geometry";
import { arrangeCanvasNodes } from "../src/lib/canvas/canvas-node-arrange";
import { resolveCanvasNodeResize } from "../src/lib/canvas/canvas-node-resize";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
const node = (id: string, x: number, y: number, width = 100, height = 100): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x, y }, width, height });
test("snap threshold is measured in screen pixels and Alt disables it", () => {
    const moving = [node("a", 0, 0)], stationary = [node("b", 300, 0)];
    expect(snapCanvasDrag(moving, stationary, { x: 195, y: 2 }, 1)).toMatchObject({ x: 200, y: 0 });
    expect(snapCanvasDrag(moving, stationary, { x: 190, y: 0 }, 1).x).toBe(190);
    expect(snapCanvasDrag(moving, stationary, { x: 190, y: 0 }, 0.5).x).toBe(200);
    expect(snapCanvasDrag(moving, stationary, { x: 195, y: 2 }, 1, { disabled: true })).toMatchObject({ x: 195, y: 2, guides: [] });
    expect(snapCanvasDrag(moving, [], { x: 20, y: 100 }, 1, { axis: true })).toMatchObject({ x: 0, y: 100 });
});
test("leaving a frame removes only the moved member and dissolves a singleton", () => {
    const before = [node("a", 0, 0), node("b", 150, 0), node("c", 500, 0), node("d", 650, 0)];
    const groups = [{ id: "one", title: "One", nodeIds: ["a", "b"], collapsed: false }, { id: "two", title: "Two", nodeIds: ["c", "d"], collapsed: false }];
    const after = before.map(item => item.id === "a" ? { ...item, position: { x: 520, y: 10 } } : item);
    expect(transferCanvasGroupMembers(groups, before, after, new Set(["a"]))).toEqual([{ ...groups[1], nodeIds: ["c", "d", "a"] }]);
    expect(transferCanvasGroupMembers(groups, before, after, new Set(["a", "b"]))).toBe(groups);
});
test("alignment avoids overlapping vertically stacked nodes and respects locks", () => {
    const nodes = [node("a", 0, 0), node("b", 0, 200), { ...node("locked", 10, 20), metadata: { locked: true } }];
    const aligned = arrangeCanvasNodes(nodes, [], new Set(), "horizontal");
    expect(aligned[1].position).toEqual({ x: 180, y: 0 });
    expect(aligned[2]).toBe(nodes[2]);
    const right = arrangeCanvasNodes([node("a", 0, 0), node("b", 300, 200, 200)], [], new Set(), "right");
    expect(right[0].position.x + right[0].width).toBe(right[1].position.x + right[1].width);
});
test("tiny wide images resize with proportional 48px short edge and stable diagonal projection", () => {
    const resized = resolveCanvasNodeResize({ position: { x: 20, y: 30 }, width: 200, height: 40, delta: { x: -10, y: -2 }, handle: "bottom-right", keepRatio: true });
    expect(resized.width).toBe(240); expect(resized.height).toBe(48);
    const centered = resolveCanvasNodeResize({ position: { x: 20, y: 30 }, width: 200, height: 100, delta: { x: 25, y: 12.5 }, handle: "bottom-right", keepRatio: true, centered: true });
    expect(centered.position).toEqual({ x: -5, y: 17.5 }); expect(centered.width).toBe(250);
});
