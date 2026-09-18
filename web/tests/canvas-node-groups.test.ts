import { describe, expect, test } from "bun:test";
import { assignCanvasNodeGroup, canvasGroupBounds, canvasGroupMemberIds, createCanvasGroupIndex, removeCanvasGroupMembers } from "../src/lib/canvas/canvas-node-groups";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeGroup } from "../src/types/canvas";

const node = (id: string, x: number, y = 100): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x, y }, width: 100, height: 80 });
const group = (id: string, nodeIds: string[], collapsed = false): CanvasNodeGroup => ({ id, nodeIds, title: id, collapsed });

describe("canvas style groups", () => {
    test("includes a complete image batch when any batch member is grouped, without missing nodes", () => {
        const nodes = [
            { ...node("cover", 100), metadata: { isBatchRoot: true, batchChildIds: ["a", "b", "missing"] } },
            { ...node("a", 250), metadata: { batchRootId: "cover" } },
            { ...node("b", 400), metadata: { batchRootId: "cover" } },
        ];
        expect([...canvasGroupMemberIds(["a", "missing"], new Map(nodes.map(n => [n.id, n])))].sort()).toEqual(["a", "b", "cover"]);
    });

    test("collapse hides only live members and does not mutate nodes or group membership", () => {
        const nodes = [node("a", 100), node("b", 300), node("c", 500)];
        const groups = [group("coat", ["a", "b", "deleted"], true), group("shirt", ["c"])];
        const before = JSON.stringify({ nodes, groups });
        const index = createCanvasGroupIndex(groups, new Map(nodes.map(n => [n.id, n])));
        expect([...index.hiddenNodeIds].sort()).toEqual(["a", "b"]);
        expect(index.groups[0].nodes.map(n => n.id)).toEqual(["a", "b"]);
        expect(JSON.stringify({ nodes, groups })).toBe(before);
    });

    test("collapsed group keeps the same anchor while its members retain their original layout", () => {
        const nodes = [node("a", 100), node("b", 400, 250)];
        const map = new Map(nodes.map(n => [n.id, n]));
        const expanded = createCanvasGroupIndex([group("coat", ["a", "b"])], map).groups[0];
        const collapsed = createCanvasGroupIndex([group("coat", ["a", "b"], true)], map).groups[0];
        expect(canvasGroupBounds(expanded)).toEqual({ x: 80, y: 52, width: 440, height: 298 });
        expect(canvasGroupBounds(collapsed)).toEqual({ x: 80, y: 52, width: 300, height: 44 });
        expect(nodes[1].position).toEqual({ x: 400, y: 250 });
    });

    test("live group bounds follow a drag without rewriting stored positions", () => {
        const original = node("a", 100);
        const resolved = createCanvasGroupIndex([group("coat", ["a"])], new Map([["a", original]])).groups[0];
        const bounds = canvasGroupBounds(resolved, () => ({ ...original, position: { x: 135, y: 125 } }));
        expect(bounds?.x).toBe(115);
        expect(bounds?.y).toBe(77);
        expect(original.position).toEqual({ x: 100, y: 100 });
    });

    test("regrouping moves ownership, keeps unselected members, and never changes the source array", () => {
        const nodes = new Map([node("a", 100), node("b", 300), node("c", 500)].map(n => [n.id, n]));
        const previous = [group("old", ["a", "b"])];
        const next = assignCanvasNodeGroup(previous, group("new", ["b", "c"]), nodes);
        expect(next.map(g => [g.id, g.nodeIds])).toEqual([["old", ["a"]], ["new", ["b", "c"]]]);
        expect(previous[0].nodeIds).toEqual(["a", "b"]);
    });

    test("deleting members removes empty groups, preserves untouched group identity, and leaves other nodes alone", () => {
        const untouched = group("shirt", ["c"]);
        const next = removeCanvasGroupMembers([group("coat", ["a", "b"]), untouched], new Set(["a", "b"]));
        expect(next).toEqual([untouched]);
        expect(next[0]).toBe(untouched);
    });

    test("a collapsed batch does not inflate its enclosing frame with hidden child coordinates", () => {
        const cover = { ...node("cover", 100), metadata: { isBatchRoot: true, batchChildIds: ["a"], imageBatchExpanded: false } };
        const child = { ...node("a", 2000), metadata: { batchRootId: "cover" } };
        const resolved = createCanvasGroupIndex([group("coat", ["cover"])], new Map([[cover.id, cover], [child.id, child]])).groups[0];
        expect(canvasGroupBounds(resolved)?.width).toBe(300);
        expect(resolved.nodeIds.has("a")).toBe(true);
    });
});
