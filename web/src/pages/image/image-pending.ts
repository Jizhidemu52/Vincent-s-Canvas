import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { generationDraftInput } from "@/services/api/generation-history";
import type { TaskRecoveryKind } from "@/services/api/task-result-reconciliation";
import { matchesWorkbenchTask, DEFAULT_WORKBENCH_TASK } from "@/lib/workbench-task-state";

export type ImageRequestSnapshot = { text: string; promptInput?: import("../../../../shared/prompt-contracts").PromptInputData; config: AiConfig; references: ReferenceImage[] };
export type PendingImage = {
    id: string;
    ownerId: string;
    tool: string;
    workspaceId?: string;
    createdAt: number;
    requestId: string;
    taskId?: string;
    diagnostic?: string;
    recovery?: Exclude<TaskRecoveryKind, "terminal">;
    stopped?: boolean;
    snapshot: ImageRequestSnapshot;
};

export function snapshotImageRequest(snapshot: ImageRequestSnapshot): ImageRequestSnapshot {
    // Only image parameters are durable; legacy browser provider credentials
    // and unrelated channel settings must never enter task history.
    return structuredClone({ text: snapshot.text, promptInput: snapshot.promptInput, config: { ...defaultConfig, ...generationDraftInput(snapshot.config, snapshot.text).config }, references: snapshot.references });
}

export function pendingImagesForWorkspace(records: PendingImage[], ownerId: string, tool: string, workspaceId = DEFAULT_WORKBENCH_TASK) {
    return records.filter(record => record.ownerId === ownerId && record.tool === tool && matchesWorkbenchTask(record, workspaceId)).sort((a, b) => a.createdAt - b.createdAt);
}

/** Every recovery is a lookup. A missing response must never become a new POST. */
export async function findPendingImageTask<T extends { id: string; requestId: string }>(record: PendingImage, readers: { byId: (id: string) => Promise<T | null>; byRequest: (id: string) => Promise<T | null> }) {
    const task = record.taskId ? await readers.byId(record.taskId) : await readers.byRequest(`${record.requestId}:0`);
    if (!task) throw new Error("原任务尚未查到或无权访问；保留记录，请稍后查询，不会重新提交或扣费。");
    if ((record.taskId && task.id !== record.taskId) || task.requestId !== `${record.requestId}:0`) throw new Error("原任务标识不匹配，提交结果待核查，请勿重复提交。");
    return task;
}

/** Late results may update their own card, never a newer slot at the same index. */
export function updateImageResultForRecord<T extends { id: string; recovery?: { id: string } }>(results: T[], record: Pick<PendingImage, "id">, next: Partial<T>) {
    return results.map(result => result.id === record.id || result.recovery?.id === record.id ? { ...result, ...next } : result);
}
