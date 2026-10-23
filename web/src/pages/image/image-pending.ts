import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { generationDraftInput } from "@/services/api/generation-history";

export type ImageRequestSnapshot = { text: string; config: AiConfig; references: ReferenceImage[] };
export type PendingImage = {
    id: string;
    ownerId: string;
    tool: string;
    createdAt: number;
    requestId: string;
    taskId?: string;
    snapshot: ImageRequestSnapshot;
};

export function snapshotImageRequest(snapshot: ImageRequestSnapshot): ImageRequestSnapshot {
    // Only image parameters are durable; legacy browser provider credentials
    // and unrelated channel settings must never enter task history.
    return structuredClone({ text: snapshot.text, config: { ...defaultConfig, ...generationDraftInput(snapshot.config, snapshot.text).config }, references: snapshot.references });
}

export function pendingImagesForWorkspace(records: PendingImage[], ownerId: string, tool: string) {
    return records.filter(record => record.ownerId === ownerId && record.tool === tool).sort((a, b) => a.createdAt - b.createdAt);
}

/** Every recovery is a lookup. A missing response must never become a new POST. */
export async function findPendingImageTask<T>(record: PendingImage, readers: { byId: (id: string) => Promise<T | null>; byRequest: (id: string) => Promise<T | null> }) {
    const task = record.taskId ? await readers.byId(record.taskId) : await readers.byRequest(`${record.requestId}:0`);
    if (!task) throw new Error("原任务尚未查到或无权访问；保留记录，请稍后查询，不会重新提交或扣费。");
    return task;
}
