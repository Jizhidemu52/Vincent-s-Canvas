import { expect, test } from "bun:test";
import { applyCanvasAgentOps, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { CanvasNodeType } from "@/types/canvas";

const snapshot: CanvasAgentSnapshot = { projectId: "project", title: "test", selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 }, connections: [], nodes: [
    { id: "config", type: CanvasNodeType.Config }, { id: "second", type: CanvasNodeType.Config }, { id: "source", type: CanvasNodeType.Image }, { id: "target", type: CanvasNodeType.Image },
].map(node => ({ ...node, title: node.id, width: 100, height: 100, position: { x: 0, y: 0 } })) };

test("agent shared connections follow UI direction and dedupe while refusing config cycles and competing owners", () => {
    const next = applyCanvasAgentOps(snapshot, [
        { type: "connect_nodes", fromNodeId: "source", toNodeId: "config" },
        { type: "connect_nodes", fromNodeId: "config", toNodeId: "target" },
        { type: "connect_nodes", fromNodeId: "config", toNodeId: "target" },
        { type: "connect_nodes", fromNodeId: "second", toNodeId: "target" },
        { type: "connect_nodes", fromNodeId: "config", toNodeId: "second" },
        { type: "connect_nodes", fromNodeId: "second", toNodeId: "config" },
        { type: "connect_nodes", fromNodeId: "target", toNodeId: "target" },
    ]);
    expect(next.connections).toHaveLength(3);
    expect(next.connections[0]).toMatchObject({ fromNodeId: "source", toNodeId: "config" });
    expect(next.connections[0]!.kind).toBeUndefined();
    expect(next.connections[1]).toMatchObject({ fromNodeId: "config", toNodeId: "target", kind: "config-target" });
    expect(next.connections[2]).toMatchObject({ fromNodeId: "config", toNodeId: "second", kind: "config-sequence" });
    expect(snapshot.connections).toEqual([]);
});

test("an explicit agent connection upgrades an existing untyped edge without duplicating it", () => {
    const current = { ...snapshot, connections: [{ id: "old", fromNodeId: "config", toNodeId: "target" }] };
    const next = applyCanvasAgentOps(current, [{ type: "connect_nodes", fromNodeId: "config", toNodeId: "target" }]);
    expect(next.connections).toEqual([{ id: "old", fromNodeId: "config", toNodeId: "target", kind: "config-target" }]);
});

test.each([{ width: 200 }, { height: 100 }, { width: 500, height: 100 }])("agent image resize preserves natural aspect ratio with %j", patch => {
    const before = { ...snapshot, nodes: [{ ...snapshot.nodes[2]!, width: 300, height: 300, metadata: { naturalWidth: 1600, naturalHeight: 900 } }] };
    const after = applyCanvasAgentOps(before, [{ type: "update_node", id: "source", patch }]);
    expect(after.nodes[0]!.width / after.nodes[0]!.height).toBeCloseTo(16 / 9);
    if (patch.width) expect(after.nodes[0]!.width).toBeLessThanOrEqual(patch.width);
    if (patch.height) expect(after.nodes[0]!.height).toBeLessThanOrEqual(patch.height);
    expect(before.nodes[0]!.width).toBe(300);
});

test("explicit free-resize images and text keep independent requested dimensions", () => {
    for (const node of [{ ...snapshot.nodes[2]!, metadata: { freeResize: true } }, { ...snapshot.nodes[2]!, type: CanvasNodeType.Text }]) {
        const after = applyCanvasAgentOps({ ...snapshot, nodes: [node] }, [{ type: "update_node", id: node.id, patch: { width: 200, height: 100 } }]);
        expect(after.nodes[0]).toMatchObject({ width: 200, height: 100 });
    }
});

test.each([0, -1, NaN, Infinity])("invalid protected image width %s cannot create distorted nodes", width => {
    expect(() => applyCanvasAgentOps(snapshot, [{ type: "update_node", id: "source", patch: { width } }])).toThrow("尺寸必须大于 0");
});
