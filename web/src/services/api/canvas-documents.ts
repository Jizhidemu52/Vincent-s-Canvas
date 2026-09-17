import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CloudCanvasDocument = { id: string; revision: number; deleted: boolean; document: CanvasProject | null; updatedAt: string };
export class CanvasRevisionConflict extends Error {
    constructor(public current: CloudCanvasDocument) { super("画布已在另一处更新"); }
}
async function request<T>(owner: string, path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/canvas-documents${path}`, {
        ...init, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(20000),
        headers: { "content-type": "application/json", "X-Canvas-Owner-Id": owner },
    });
    const body = await response.json();
    if (response.status === 409 && body.error === "CANVAS_REVISION_CONFLICT") throw new CanvasRevisionConflict(body.document);
    if (!response.ok) throw new Error(body.message || body.msg || "画布云端同步失败");
    return body as T;
}
export const listCloudCanvases = (owner: string) => request<{ documents: CloudCanvasDocument[] }>(owner, "");
export const putCloudCanvas = (owner: string, id: string, baseRevision: number, document: CanvasProject | null) =>
    request<{ document: CloudCanvasDocument }>(owner, `/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ baseRevision, document }) }).then(result => result.document);
