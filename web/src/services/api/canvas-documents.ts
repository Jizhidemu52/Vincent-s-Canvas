import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasProjectSummary } from "@/lib/canvas/canvas-project-summary";
import { decodeCanvasProject, encodeCanvasProject, type EncodedCanvasProject } from "@/lib/canvas/canvas-project-codec";

export type CloudCanvasDocument = { id: string; revision: number; deleted: boolean; document: CanvasProject | null; updatedAt: string };
export type CloudCanvasAcknowledgement = Omit<CloudCanvasDocument, "document">;
export type CloudCanvasSummary = Omit<CloudCanvasDocument, "document"> & { summary: CanvasProjectSummary | null };
type EncodedCloudDocument = Omit<CloudCanvasDocument, "document"> & { document: EncodedCanvasProject | null };
const decodeDocument = (value: EncodedCloudDocument): CloudCanvasDocument => ({ ...value, document: value.document ? decodeCanvasProject(value.document) : null });
export class CanvasRevisionConflict extends Error {
    constructor(public current: CloudCanvasDocument) { super("画布已在另一处更新"); }
}
export class CanvasCloudRequestError extends Error {
    constructor(message: string, public status = 0) { super(message); }
    get retryable() { return !this.status || this.status === 408 || this.status === 429 || this.status >= 500; }
}
async function request<T>(owner: string, path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try { response = await fetch(`/api/canvas-documents${path}`, {
        ...init, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(Math.min(120000, 20000 + (typeof init?.body === "string" ? new Blob([init.body]).size / 1024 / 1024 * 5000 : 0))),
        headers: { "content-type": "application/json", "X-Canvas-Owner-Id": owner },
    }); } catch (error) {
        throw new CanvasCloudRequestError(error instanceof Error && error.name === "TimeoutError" ? "画布云端同步超时，已保留改动，请检查网络后重试" : "无法连接画布云端，请检查网络后重试");
    }
    const body = response.headers.get("content-type")?.includes("json") ? await response.json().catch(() => null) : null;
    if (!body) throw new CanvasCloudRequestError(`画布云端返回异常响应（${response.status}），请稍后重试`, response.status >= 400 ? response.status : 502);
    if (response.status === 409 && body.error === "CANVAS_REVISION_CONFLICT") throw new CanvasRevisionConflict(decodeDocument(body.document));
    if (!response.ok) throw new CanvasCloudRequestError(body.message || body.msg || "画布云端同步失败", response.status);
    return body as T;
}
export const listCloudCanvases = (owner: string) => request<{ documents: CloudCanvasSummary[] }>(owner, "");
export const getCloudCanvas = (owner: string, id: string) =>
    request<{ document: EncodedCloudDocument }>(owner, `/${encodeURIComponent(id)}`).then(result => decodeDocument(result.document));
export const putCloudCanvas = (owner: string, id: string, baseRevision: number, document: CanvasProject | null) =>
    request<{ document: CloudCanvasAcknowledgement }>(owner, `/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ baseRevision, document: document ? encodeCanvasProject(document) : null }) }).then(result => result.document);
