import { describe, expect, test } from "bun:test";

import { cloneCanvasNodeGraph, copyCanvasNodeGraph } from "@/lib/canvas/canvas-node-copy";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeGroup } from "@/types/canvas";

function node(id: string, x = 0): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, width: 80, height: 60, position: { x, y: 10 }, metadata: { content: `blob:${id}`, storageKey: `image:${id}` } };
}

const nodes: CanvasNodeData[] = [
    { ...node("root"), metadata: { ...node("root").metadata, isBatchRoot: true, batchChildIds: ["child"], primaryImageId: "child" } },
    { ...node("child", 100), metadata: { ...node("child").metadata, batchRootId: "root" } },
    node("outside", 400),
];
const connections: CanvasConnection[] = [
    { id: "internal", fromNodeId: "root", toNodeId: "child" },
    { id: "external", fromNodeId: "child", toNodeId: "outside" },
];
const groups: CanvasNodeGroup[] = [
    { id: "complete", title: "款式一", nodeIds: ["root", "child"], collapsed: false },
    { id: "partial", title: "款式二", nodeIds: ["child", "outside"], collapsed: false },
];

describe("canvas node graph copy", () => {
    test("copies only selected nodes, internal connections and completely selected style groups", () => {
        const copied = copyCanvasNodeGraph(nodes, connections, groups, new Set(["root", "child"]));
        expect(copied.nodes.map(item => item.id)).toEqual(["root", "child"]);
        expect(copied.connections.map(item => item.id)).toEqual(["internal"]);
        expect(copied.groups?.map(item => item.id)).toEqual(["complete"]);
        expect(copied.nodes[0]).not.toBe(nodes[0]);
        expect(copied.nodes[0]!.position).not.toBe(nodes[0]!.position);
        expect(copied.nodes[0]!.metadata).not.toBe(nodes[0]!.metadata);
    });

    test("duplicates a complete selection in one graph with translated positions and remapped batch, edge and group ownership", () => {
        const before = structuredClone({ nodes, connections, groups });
        const copied = copyCanvasNodeGraph(nodes, connections, groups, new Set(["root", "child"]));
        const result = cloneCanvasNodeGraph(copied, { x: 36, y: 36 });
        const [root, child] = result.nodes;
        expect(root!.id).not.toBe("root");
        expect(child!.id).not.toBe("child");
        expect(root!.id).not.toBe(child!.id);
        expect(result.nodes.map(item => item.position)).toEqual([{ x: 36, y: 46 }, { x: 136, y: 46 }]);
        expect(result.nodes.map(item => item.title)).toEqual(["root Copy", "child Copy"]);
        expect(root!.metadata).toMatchObject({ content: "blob:root", storageKey: "image:root", batchChildIds: [child!.id], primaryImageId: child!.id });
        expect(child!.metadata?.batchRootId).toBe(root!.id);
        expect(result.connections).toHaveLength(1);
        expect(result.connections[0]).toMatchObject({ fromNodeId: root!.id, toNodeId: child!.id });
        expect(result.connections[0]!.id).not.toBe("internal");
        expect(result.groups).toHaveLength(1);
        expect(result.groups![0]).toMatchObject({ title: "款式一", nodeIds: [root!.id, child!.id], collapsed: false });
        expect(result.groups![0]!.id).not.toBe("complete");
        expect({ nodes, connections, groups }).toEqual(before);
    });

    test("copying an individual batch member never leaves references to its source family or partial style group", () => {
        const childOnly = cloneCanvasNodeGraph(copyCanvasNodeGraph(nodes, connections, groups, new Set(["child"])), { x: 36, y: 36 });
        expect(childOnly.nodes).toHaveLength(1);
        expect(childOnly.nodes[0]!.metadata?.batchRootId).toBeUndefined();
        expect(childOnly.connections).toEqual([]);
        expect(childOnly.groups).toEqual([]);
        const rootOnly = cloneCanvasNodeGraph(copyCanvasNodeGraph(nodes, connections, groups, new Set(["root"])), { x: 36, y: 36 });
        expect(rootOnly.nodes).toHaveLength(1);
        expect(rootOnly.nodes[0]!.metadata?.batchChildIds).toEqual([]);
        expect(rootOnly.nodes[0]!.metadata?.primaryImageId).toBeUndefined();
    });

    test("an empty or stale selection produces no graph and repeated copies do not append Copy again", () => {
        expect(copyCanvasNodeGraph(nodes, connections, groups, new Set(["missing"]))).toEqual({ nodes: [], connections: [], groups: [] });
        const first = cloneCanvasNodeGraph({ nodes: [node("one")], connections: [] }, { x: 36, y: 36 });
        const second = cloneCanvasNodeGraph(first, { x: 36, y: 36 });
        expect(second.nodes[0]!.title).toBe("one Copy");
        expect(second.nodes[0]!.id).not.toBe(first.nodes[0]!.id);
    });
});
