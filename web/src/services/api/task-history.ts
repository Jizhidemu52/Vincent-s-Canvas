export type ServerTask = {
    id: string;
    requestId: string;
    batchId: string | null;
    userId: string;
    userName: string;
    projectId: string;
    operationType: string;
    prompt: string;
    parameters: Record<string, unknown>;
    sourceUrls: string[];
    resultUrls: string[];
    priority: string;
    status: string;
    credits: number;
    rmbCost: number;
    failureReason: string | null;
    attempts: number;
    queuedAt: string;
};
export type ServerBatch = {
    id: string;
    requestId: string;
    userId: string;
    userName: string;
    projectId: string;
    operationType: string;
    modelName: string | null;
    priority: string;
    status: string;
    totalItems: number;
    completedItems: number;
    failedItems: number;
    waitingItems: number;
    processingItems: number;
    pausedItems: number;
    cancelledItems: number;
    plannedCredits: number;
    consumedCredits: number;
    consumedRmbCost: number;
    createdAt: string;
    updatedAt: string;
};
export type ServerHistory = {
    id: string;
    taskId: string;
    userId: string;
    userName: string;
    departmentName: string | null;
    projectId: string;
    operationType: string;
    modelName: string | null;
    prompt: string;
    parameters: Record<string, unknown>;
    sourceUrls: string[];
    resultUrls: string[];
    credits: number;
    rmbCost: number;
    status: string;
    failureReason: string | null;
    createdAt: string;
};

export type AdminHistoryFilters = {
    userId?: string;
    projectId?: string;
    modelId?: string;
    operationType?: string;
    from?: string;
    to?: string;
};

export type AdminHistoryPage = {
    history: ServerHistory[];
    total: number;
    totalCredits: number;
    totalRmbCost: number;
    page: number;
    pageSize: number;
};

export type AdminHistoryOptions = {
    users: Array<{ value: string; label: string }>;
    models: Array<{ value: string; label: string }>;
    operations: Array<{ value: string; label: string }>;
};

async function get<T>(path: string): Promise<T> {
    const response = await fetch(path, { credentials: "include" });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message || "数据加载失败");
    }
    return response.json() as Promise<T>;
}
async function post<T>(path: string): Promise<T> {
    const response = await fetch(path, { method: "POST", credentials: "include" });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message || "任务操作失败");
    }
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export type TaskControlAction = "pause" | "resume" | "cancel";
export const listAdminTasks = () => get<{ tasks: ServerTask[] }>("/api/admin/tasks");
export const listAdminBatches = () => get<{ batches: ServerBatch[] }>("/api/admin/tasks/batches");
export const listAdminHistory = (filters: AdminHistoryFilters & { page?: number; pageSize?: number } = {}) => get<AdminHistoryPage>(`/api/admin/history?${serializeApiParams(filters)}`);
export const listAdminHistoryOptions = () => get<AdminHistoryOptions>("/api/admin/history/options");
export const controlAdminTask = (id: string, action: TaskControlAction) => post<void>(`/api/admin/tasks/${id}/${action}`);
export const controlAdminBatch = (id: string, action: TaskControlAction) => post<{ changed: number }>(`/api/admin/tasks/batches/${id}/${action}`);

export async function exportAdminHistory(filters: AdminHistoryFilters) {
    const response = await fetch(`/api/admin/history/export?${serializeApiParams(filters)}`, { credentials: "include" });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message || "历史导出失败");
    }
    return response.blob();
}

export function availableTaskActions(status: string): TaskControlAction[] {
    if (status === "waiting") return ["pause", "cancel"];
    if (status === "paused") return ["resume", "cancel"];
    return [];
}

export function availableBatchActions(batch: Pick<ServerBatch, "waitingItems" | "pausedItems">): TaskControlAction[] {
    const actions: TaskControlAction[] = [];
    if (batch.waitingItems > 0) actions.push("pause");
    if (batch.pausedItems > 0) actions.push("resume");
    if (batch.waitingItems + batch.pausedItems > 0) actions.push("cancel");
    return actions;
}
import { serializeApiParams } from "@/services/api/request";
