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
