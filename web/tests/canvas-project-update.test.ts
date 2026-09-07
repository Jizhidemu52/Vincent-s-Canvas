import { expect, test } from "bun:test";
import { applyCanvasProjectPatch } from "@/lib/canvas/canvas-project-update";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

const project = { id: "canvas", title: "Test", createdAt: "original", updatedAt: "original", nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false, viewport: { x: 10, y: 20, k: 1 } } as CanvasProject;
test("unchanged graph and equivalent viewports retain identity and do not schedule another save", () => {
    expect(applyCanvasProjectPatch(project, {})).toBe(project);
    expect(applyCanvasProjectPatch(project, { nodes: project.nodes, connections: project.connections, viewport: { ...project.viewport }, showImageInfo: false })).toBe(project);
    expect(project.updatedAt).toBe("original");
});
test("real changes preserve untouched graph references and the original snapshot", () => {
    const next = applyCanvasProjectPatch(project, { viewport: { ...project.viewport, k: 2 } });
    expect(next).not.toBe(project);
    expect(next.nodes).toBe(project.nodes);
    expect(next.viewport.k).toBe(2);
    expect(next.updatedAt).not.toBe("original");
    expect(project.viewport.k).toBe(1);
    const newNodes = [...project.nodes];
    expect(applyCanvasProjectPatch(project, { nodes: newNodes }).nodes).toBe(newNodes);
});
