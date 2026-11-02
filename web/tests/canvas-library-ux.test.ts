import { expect, test } from "bun:test";
import { selectCanvasCoverNode } from "../../shared/canvas-cover";
import { canvasDuplicateTitle, compareCanvasProjectVersions, formatCanvasProjectTime, sortCanvasLibraryProjects } from "@/lib/canvas/canvas-library-ux";
import { canvasProjectSummary } from "@/lib/canvas/canvas-project-summary";
import { applyCanvasProjectPatch, hasCanvasContentChange } from "@/lib/canvas/canvas-project-update";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

test("cover chooses explicit image then newest successful generation without changing node order", () => {
    const nodes = [
        { id: "reference", type: "image", metadata: { content: "original" } },
        { id: "new", type: "image", metadata: { content: "new-result", generationRecord: { createdAt: "2026-10-02" } } },
        { id: "old", type: "image", metadata: { content: "old-result", generationRecord: { createdAt: "2026-10-01" } } },
        { id: "pending", type: "image", metadata: { content: "placeholder", sourceTaskId: "latest", status: "loading" } },
    ];
    expect(selectCanvasCoverNode(nodes)?.id).toBe("new");
    expect(selectCanvasCoverNode(nodes, "reference")?.id).toBe("reference");
    expect(selectCanvasCoverNode(nodes, "missing")?.id).toBe("new");
    expect(nodes.map(node => node.id)).toEqual(["reference", "new", "old", "pending"]);
});

test("summary and content dirty check persist an explicit cover without rearranging recent projects", () => {
    const project = { id: "one", title: "作品", nodes: [{ id: "image", type: "image", metadata: { content: "original" } }], connections: [], viewport: { x: 0, y: 0, k: 1 }, updatedAt: "2026-10-01" } as unknown as CanvasProject;
    const changed = applyCanvasProjectPatch(project, { coverNodeId: "image" });
    expect(changed.updatedAt).toBe(project.updatedAt);
    expect(hasCanvasContentChange(project, changed)).toBe(true);
    expect(canvasProjectSummary(changed).cover?.content).toBe("original");
});

test("duplicate names include unloaded canvases and never reuse an existing copy title", () => {
    expect(canvasDuplicateTitle("设计", [])).toBe("设计（副本）");
    expect(canvasDuplicateTitle("设计", [{ title: "设计（副本）" }, { title: "设计（副本 2）" }])).toBe("设计（副本 3）");
});

test("sort is stable and non-mutating; date labels follow locale and include cross-year dates", () => {
    const projects = [
        { id: "a", title: "Canvas 10", createdAt: "2026-01-01", updatedAt: "2026-03-01", nodeCount: 0, connectionCount: 0 },
        { id: "b", title: "Canvas 2", createdAt: "2026-02-01", updatedAt: "2026-02-01", nodeCount: 0, connectionCount: 0 },
    ];
    expect(sortCanvasLibraryProjects(projects, "updated").map(item => item.id)).toEqual(["a", "b"]);
    expect(sortCanvasLibraryProjects(projects, "created").map(item => item.id)).toEqual(["b", "a"]);
    expect(sortCanvasLibraryProjects(projects, "name", "en-US").map(item => item.id)).toEqual(["b", "a"]);
    expect(projects[0].id).toBe("a");
    const now = Date.parse("2026-11-02T10:00:00Z");
    expect(formatCanvasProjectTime("2026-11-02T09:57:00Z", "zh-CN", now)).toContain("3分钟前");
    expect(formatCanvasProjectTime("2026-11-02T09:57:00Z", "en-US", now)).toBe("3 minutes ago");
    expect(formatCanvasProjectTime("2025-12-31T01:00:00Z", "zh-CN", now)).toContain("2025");
});

test("conflict comparison reports missing, new and changed nodes without mutating either version", () => {
    const node = { id: "same", title: "文字", type: "text", metadata: { content: "before" } };
    const original = { nodes: [node, { ...node, id: "removed" }], connections: [], chatSessions: [] } as unknown as CanvasProject;
    const copy = { nodes: [{ ...node, metadata: { content: "after" } }, { ...node, id: "added" }], connections: [], chatSessions: [{ id: "chat" }] } as unknown as CanvasProject;
    const diff = compareCanvasProjectVersions(original, copy);
    expect(diff.added.map(item => item.id)).toEqual(["added"]);
    expect(diff.removed.map(item => item.id)).toEqual(["removed"]);
    expect(diff.changed.map(item => item.id)).toEqual(["same"]);
    expect(diff.chatChanged).toBe(true);
    expect(diff.connectionsChanged).toBe(false);
    expect(node.metadata.content).toBe("before");
});
