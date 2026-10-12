import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CanvasProjectSummary = Pick<CanvasProject, "id" | "title" | "createdAt" | "updatedAt"> & {
    nodeCount: number;
    connectionCount: number;
    cover?: { storageKey?: string; content?: string } | null;
};

const summaries = new WeakMap<CanvasProject, CanvasProjectSummary>();

export function canvasProjectSummary(project: CanvasProject): CanvasProjectSummary {
    const cached = summaries.get(project);
    if (cached) return cached;
    const image = project.nodes.find(node => node.type === "image" && (node.metadata?.storageKey || node.metadata?.content));
    const summary: CanvasProjectSummary = {
        id: project.id, title: project.title, createdAt: project.createdAt, updatedAt: project.updatedAt,
        nodeCount: project.nodes.length, connectionCount: project.connections.length,
        cover: image ? { storageKey: image.metadata?.storageKey, content: image.metadata?.content } : null,
    };
    summaries.set(project, summary);
    return summary;
}

export function canvasLibrarySummaries(projects: CanvasProject[], unloaded: CanvasProjectSummary[]): CanvasProjectSummary[] {
    const local = new Set(projects.map(project => project.id));
    return [...projects.map(canvasProjectSummary), ...unloaded.filter(project => !local.has(project.id))]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
