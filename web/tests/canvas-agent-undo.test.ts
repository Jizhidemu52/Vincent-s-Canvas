import { describe, expect, test } from "bun:test";
import { applyCanvasAgentOps, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { canvasAgentUndoMessage, createCanvasAgentUndoPatch, undoCanvasAgentPatch } from "@/lib/canvas/canvas-agent-undo";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

function node(id: string, patch: Partial<CanvasNodeData> = {}): CanvasNodeData {
    return { id, type: CanvasNodeType.Text, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: id }, ...patch };
}
function snapshot(nodes: CanvasNodeData[] = [node("one"), node("two")], connections: CanvasConnection[] = []): CanvasAgentSnapshot {
    return { projectId: "project", title: "Canvas", nodes, connections, viewport: { x: 0, y: 0, k: 1 }, selectedNodeIds: [] };
}
const edge = (id: string, fromNodeId: string, toNodeId: string, kind?: CanvasConnection["kind"]): CanvasConnection => ({ id, fromNodeId, toNodeId, ...(kind ? { kind } : {}) });
const config = (id: string) => node(id, { type: CanvasNodeType.Config, metadata: { generationMode: "image" } });

describe("compare-and-revert canvas agent undo", () => {
    test("unrelated later edits and nodes survive the batch inverse", () => {
        const before = snapshot();
        const after = applyCanvasAgentOps(before, [{ type: "update_node", id: "one", patch: { title: "Agent" } }]);
        const userNode = node("user-created");
        const current = { ...after, nodes: [after.nodes[0], { ...after.nodes[1], title: "User" }, userNode] };
        const result = undoCanvasAgentPatch(current, createCanvasAgentUndoPatch(before, after)!);
        expect(result.snapshot.nodes.map(item => item.title)).toEqual(["one", "User", "user-created"]);
        expect(result.snapshot.nodes[2]).toBe(userNode);
        expect(result.report).toEqual({ applied: 1, conflicts: [], retryable: false });
        expect(result.remaining).toBeNull();
    });

    test("different position and metadata fields on the same node are independent", () => {
        const before = snapshot();
        const after = applyCanvasAgentOps(before, [{ type: "update_node", id: "one", patch: { position: { x: 50, y: 0 } }, metadata: { prompt: "Agent" } }]);
        const current = { ...after, nodes: [{ ...after.nodes[0], position: { x: 50, y: 80 }, metadata: { ...after.nodes[0].metadata, content: "User content" } }, after.nodes[1]] };
        const result = undoCanvasAgentPatch(current, createCanvasAgentUndoPatch(before, after)!);
        expect(result.snapshot.nodes[0].position).toEqual({ x: 0, y: 80 });
        expect(result.snapshot.nodes[0].metadata).toEqual({ content: "User content" });
        expect(result.report.conflicts).toEqual([]);
    });

    test("partial conflict retains the later value and retries only unfinished fields", () => {
        const before = snapshot();
        const after = applyCanvasAgentOps(before, [{ type: "update_node", id: "one", patch: { title: "Agent", width: 200 } }]);
        const current = { ...after, nodes: [{ ...after.nodes[0], title: "User" }, after.nodes[1]] };
        const partial = undoCanvasAgentPatch(current, createCanvasAgentUndoPatch(before, after)!);
        expect(partial.snapshot.nodes[0]).toMatchObject({ title: "User", width: 100 });
        expect(partial.report.applied).toBe(1);
        expect(partial.report.conflicts).toHaveLength(1);
        expect(canvasAgentUndoMessage(partial.report)).toContain("部分撤销");
        const resolved = { ...partial.snapshot, nodes: [{ ...partial.snapshot.nodes[0], title: "Agent", width: 250 }, partial.snapshot.nodes[1]] };
        const retried = undoCanvasAgentPatch(resolved, partial.remaining!);
        expect(retried.snapshot.nodes[0]).toMatchObject({ title: "one", width: 250 });
        expect(retried.remaining).toBeNull();
    });

    test("an all-conflict batch is a no-op with explicit feedback", () => {
        const before = snapshot();
        const after = applyCanvasAgentOps(before, [{ type: "update_node", id: "one", metadata: { content: "Agent" } }]);
        const current = { ...after, nodes: [{ ...after.nodes[0], metadata: { content: "Asynchronous generation result" } }, after.nodes[1]] };
        const result = undoCanvasAgentPatch(current, createCanvasAgentUndoPatch(before, after)!);
        expect(result.snapshot).toBe(current);
        expect(result.report.applied).toBe(0);
        expect(result.report.retryable).toBe(true);
        expect(canvasAgentUndoMessage(result.report)).toContain("暂未撤销任何修改");
    });

    test("an agent-created node with a later generation result is not deleted", () => {
        const before = snapshot();
        const after = applyCanvasAgentOps(before, [{ type: "add_node", id: "generated", nodeType: CanvasNodeType.Image }]);
        const current = { ...after, nodes: after.nodes.map(item => item.id === "generated" ? { ...item, metadata: { content: "https://assets.test/result.png", status: "success" } } : item) };
        const result = undoCanvasAgentPatch(current, createCanvasAgentUndoPatch(before, after)!);
        expect(result.snapshot.nodes.find(item => item.id === "generated")?.metadata.content).toBe("https://assets.test/result.png");
        expect(result.report.conflicts.some(item => item.location === "节点 generated")).toBe(true);
    });

    test("a later connection protects a newly added node from removal", () => {
        const before = snapshot();
        const after = applyCanvasAgentOps(before, [{ type: "add_node", id: "new" }]);
        const current = { ...after, connections: [edge("user-edge", "two", "new")] };
        const result = undoCanvasAgentPatch(current, createCanvasAgentUndoPatch(before, after)!);
        expect(result.snapshot.nodes.map(item => item.id)).toEqual(["one", "two", "new"]);
        expect(result.snapshot.connections).toBe(current.connections);
        expect(result.report.conflicts[0].reason).toContain("后续连线");
    });

    test("batch-owned new node and connection can be removed together", () => {
        const before = snapshot();
        const after = applyCanvasAgentOps(before, [{ type: "add_node", id: "new" }, { type: "connect_nodes", id: "agent-edge", fromNodeId: "one", toNodeId: "new" }]);
        const result = undoCanvasAgentPatch(after, createCanvasAgentUndoPatch(before, after)!);
        expect(result.snapshot).toEqual(before);
        expect(result.report.conflicts).toEqual([]);
    });

    test("groups and active generation can protect an otherwise unchanged new node", () => {
        const before = snapshot();
        const after = applyCanvasAgentOps(before, [{ type: "add_node", id: "new" }]);
        for (const reason of ["款式组仍在使用此节点", "生成任务仍在使用此节点"]) {
            const result = undoCanvasAgentPatch(after, createCanvasAgentUndoPatch(before, after)!, new Map([["new", reason]]));
            expect(result.snapshot.nodes).toBe(after.nodes);
            expect(result.report.conflicts[0].reason).toBe(reason);
        }
    });

    test("deleted node and edge restore without reverting another node's edit", () => {
        const before = snapshot(undefined, [edge("old", "one", "two")]);
        const after = applyCanvasAgentOps(before, [{ type: "delete_node", id: "one" }]);
        const current = { ...after, nodes: [{ ...after.nodes[0], title: "User" }, node("third")] };
        const result = undoCanvasAgentPatch(current, createCanvasAgentUndoPatch(before, after)!);
        expect(result.snapshot.nodes.map(item => item.title)).toEqual(["one", "User", "third"]);
        expect(result.snapshot.connections).toEqual(before.connections);
    });

    test("a reused deleted-node ID cannot receive the old restored edge", () => {
        const before = snapshot(undefined, [edge("old", "one", "two")]);
        const after = applyCanvasAgentOps(before, [{ type: "delete_node", id: "one" }]);
        const current = { ...after, nodes: [node("one", { title: "Replacement" }), ...after.nodes] };
        const result = undoCanvasAgentPatch(current, createCanvasAgentUndoPatch(before, after)!);
        expect(result.snapshot).toBe(current);
        expect(result.report.conflicts).toHaveLength(2);
        expect(result.report.conflicts[1].reason).toContain("ID");
    });

    test("missing endpoints and duplicate user edges block restoration", () => {
        const before = snapshot(undefined, [edge("old", "one", "two")]);
        const after = applyCanvasAgentOps(before, [{ type: "delete_connections", all: true }]);
        for (const current of [{ ...after, nodes: [after.nodes[0]] }, { ...after, connections: [edge("user-edge", "one", "two")] }]) {
            const result = undoCanvasAgentPatch(current, createCanvasAgentUndoPatch(before, after)!);
            expect(result.snapshot).toBe(current);
            expect(result.report.conflicts).toHaveLength(1);
        }
    });

    test("later shared-config ownership blocks an old target connection", () => {
        const before = snapshot([config("a"), config("b"), node("target")], [edge("old", "a", "target", "config-target")]);
        const after = applyCanvasAgentOps(before, [{ type: "delete_connections", all: true }]);
        const current = { ...after, connections: [edge("new", "b", "target", "config-target")] };
        const result = undoCanvasAgentPatch(current, createCanvasAgentUndoPatch(before, after)!);
        expect(result.snapshot).toBe(current);
        expect(result.report.conflicts[0].reason).toContain("其他共享配置");
    });

    test("restoring sequence edges cannot introduce a cycle", () => {
        const before = snapshot([config("a"), config("b"), config("c")], [edge("old", "a", "b", "config-sequence")]);
        const after = applyCanvasAgentOps(before, [{ type: "delete_connections", all: true }]);
        const current = { ...after, connections: [edge("later-1", "b", "c", "config-sequence"), edge("later-2", "c", "a", "config-sequence")] };
        const result = undoCanvasAgentPatch(current, createCanvasAgentUndoPatch(before, after)!);
        expect(result.snapshot).toBe(current);
        expect(result.report.conflicts[0].reason).toContain("循环");
    });

    test("connections are atomic and later endpoint changes win", () => {
        const before = snapshot([node("one"), node("two"), node("three")], [edge("old", "one", "two")]);
        const after = { ...before, connections: [edge("old", "one", "three")] };
        const current = { ...after, connections: [edge("old", "two", "three")] };
        expect(undoCanvasAgentPatch(current, createCanvasAgentUndoPatch(before, after)!).snapshot).toBe(current);
    });

    test("node type cannot roll back underneath a valid later configuration edge", () => {
        const before = snapshot();
        const after = applyCanvasAgentOps(before, [{ type: "update_node", id: "one", patch: { type: CanvasNodeType.Config } }]);
        const current = { ...after, connections: [edge("new", "one", "two", "config-target")] };
        const result = undoCanvasAgentPatch(current, createCanvasAgentUndoPatch(before, after)!);
        expect(result.snapshot).toBe(current);
        expect(result.report.conflicts[0].reason).toContain("类型");
    });

    test("arrays and replaced parent objects are conservative conflict boundaries", () => {
        const before = snapshot([node("one", { metadata: { batchChildIds: ["a"] } })]);
        const after = applyCanvasAgentOps(before, [{ type: "update_node", id: "one", metadata: { batchChildIds: ["a", "b"] } }]);
        for (const metadata of [{ batchChildIds: ["a", "b", "user"] }, null]) {
            const current = { ...after, nodes: [{ ...after.nodes[0], metadata } as unknown as CanvasNodeData] };
            expect(undoCanvasAgentPatch(current, createCanvasAgentUndoPatch(before, after)!).snapshot).toBe(current);
        }
    });

    test("restoring absent metadata removes empty introduced parents but preserves user siblings", () => {
        const before = snapshot([node("one", { metadata: undefined as unknown as CanvasNodeData["metadata"] })]);
        const after = applyCanvasAgentOps(before, [{ type: "update_node", id: "one", metadata: { prompt: "Agent" } }]);
        expect(undoCanvasAgentPatch(after, createCanvasAgentUndoPatch(before, after)!).snapshot.nodes[0].metadata).toBeUndefined();
        const current = { ...after, nodes: [{ ...after.nodes[0], metadata: { ...after.nodes[0].metadata, content: "User" } }] };
        expect(undoCanvasAgentPatch(current, createCanvasAgentUndoPatch(before, after)!).snapshot.nodes[0].metadata).toEqual({ content: "User" });
    });

    test("viewport fields are independent and later selection remains unchanged", () => {
        const before = snapshot();
        const after = applyCanvasAgentOps(before, [{ type: "set_viewport", viewport: { x: 100, y: 0, k: 1 } }, { type: "select_nodes", ids: ["one"] }]);
        const current = { ...after, viewport: { x: 100, y: 20, k: 2 }, selectedNodeIds: ["two"] };
        const result = undoCanvasAgentPatch(current, createCanvasAgentUndoPatch(before, after)!);
        expect(result.snapshot.viewport).toEqual({ x: 0, y: 20, k: 2 });
        expect(result.snapshot.selectedNodeIds).toEqual(["two"]);
        expect(result.report.conflicts).toHaveLength(1);
    });

    test("an already-undone batch is a no-op and a different project is blocked", () => {
        const before = snapshot();
        const after = applyCanvasAgentOps(before, [{ type: "update_node", id: "one", patch: { title: "Agent" } }]);
        const patch = createCanvasAgentUndoPatch(before, after)!;
        const undone = undoCanvasAgentPatch(before, patch);
        expect(undone.snapshot).toBe(before);
        expect(undone.report).toEqual({ applied: 0, conflicts: [], retryable: false });
        const other = { ...after, projectId: "other" };
        expect(undoCanvasAgentPatch(other, patch).snapshot).toBe(other);
        expect(undoCanvasAgentPatch(other, patch).report.conflicts[0].reason).toContain("画布已切换");
    });

    test("no-op or generation-only commands do not fabricate a patch", () => {
        const before = snapshot();
        expect(createCanvasAgentUndoPatch(before, before)).toBeNull();
        expect(createCanvasAgentUndoPatch(before, applyCanvasAgentOps(before, [{ type: "run_generation", nodeId: "one" }]))).toBeNull();
    });
});
