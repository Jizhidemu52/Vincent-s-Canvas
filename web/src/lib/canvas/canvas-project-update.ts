import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CanvasProjectPatch = Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>;

/** Keep large graph arrays by reference; never serialize them just to detect a no-op. */
export function applyCanvasProjectPatch(project: CanvasProject, patch: CanvasProjectPatch): CanvasProject {
    const changed = (Object.keys(patch) as Array<keyof CanvasProjectPatch>).some((key) => {
        if (key === "viewport" && patch.viewport) {
            const { x, y, k } = patch.viewport;
            return project.viewport.x !== x || project.viewport.y !== y || project.viewport.k !== k;
        }
        return !Object.is(project[key], patch[key]);
    });
    return changed ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project;
}
