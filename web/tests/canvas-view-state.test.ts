import { expect, test } from "bun:test";
import { normalizeCanvasSelectedNodeIds } from "@/lib/canvas/canvas-view-state";
import { parseCanvasProject, serializeCanvasProject } from "@/lib/canvas/canvas-project-codec";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata });

test("restored selection drops missing, duplicate, collapsed group and collapsed batch nodes", () => {
    const nodes = [node("visible"), node("grouped"), node("root", { isBatchRoot: true, batchChildIds: ["child"] }), node("child", { batchRootId: "root" })];
    const groups = [{ id: "group", title: "隐藏组", nodeIds: ["grouped"], collapsed: true }];
    const ids = ["visible", "visible", "deleted", "grouped", "child", "root"];
    expect(normalizeCanvasSelectedNodeIds(ids, nodes, groups)).toEqual(["visible", "root"]);
    expect(normalizeCanvasSelectedNodeIds(ids, nodes.map(item => item.id === "root" ? { ...item, metadata: { ...item.metadata, imageBatchExpanded: true } } : item), [])).toEqual(["visible", "grouped", "child", "root"]);
    expect(ids).toEqual(["visible", "visible", "deleted", "grouped", "child", "root"]);
});

test("viewport and selected IDs round trip without becoming an undoable graph field", () => {
    const project: CanvasProject = { id: "p", title: "原稿", createdAt: "old", updatedAt: "now", nodes: [node("visible")], groups: [], connections: [], chatSessions: [], activeChatId: null,
        backgroundMode: "dots", showImageInfo: false, viewport: { x: 72, y: -18, k: 1.7 }, selectedNodeIds: ["visible"] };
    const restored = parseCanvasProject(serializeCanvasProject(project));
    expect(restored.viewport).toEqual({ x: 72, y: -18, k: 1.7 });
    expect(normalizeCanvasSelectedNodeIds(restored.selectedNodeIds, restored.nodes)).toEqual(["visible"]);
    expect(normalizeCanvasSelectedNodeIds(undefined, restored.nodes)).toEqual([]);
    expect(normalizeCanvasSelectedNodeIds("visible", restored.nodes)).toEqual([]);
    expect(normalizeCanvasSelectedNodeIds([null, 1, "visible"], restored.nodes)).toEqual(["visible"]);
    expect(restored.nodes).toEqual(project.nodes);
    expect(restored.history).toBeUndefined();
});
