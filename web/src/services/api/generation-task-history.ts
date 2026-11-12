import { useUserStore } from "@/stores/use-user-store";
import { workspaceOwnerHeaders } from "./workspace-owner";
import type { QueuedTask } from "./generation-tasks";
import { deploymentFeatures } from "@/lib/deployment-features";

export type GenerationHistoryTask = QueuedTask & {
    userId: string; toolKey?: string; modelConfigId?: string; modelId?: string; modelName?: string;
    sourceUrls: string[]; parameters: Record<string, unknown>;
};
export type GenerationHistoryPage = { tasks: GenerationHistoryTask[]; nextCursor: string | null; hasMore: boolean };

export function assertHistoryOwner(ownerId: string) {
    const { user, status } = useUserStore.getState();
    if (!ownerId || user?.id !== ownerId || (deploymentFeatures.authenticationEnabled && status !== "authenticated")) throw new Error("员工会话已变化，已停止读取历史记录");
}

export async function listGenerationHistory(board: string, ownerId: string, cursor?: string, signal?: AbortSignal): Promise<GenerationHistoryPage> {
    signal?.throwIfAborted();
    assertHistoryOwner(ownerId);
    const query = new URLSearchParams({ board, limit: "30", ...(cursor ? { cursor } : {}) });
    const response = await fetch(`/api/tasks/history?${query}`, { credentials: "include", cache: "no-store", redirect: "error", headers: workspaceOwnerHeaders(), signal });
    assertHistoryOwner(ownerId); signal?.throwIfAborted();
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "会话已失效或无权查看，请重新登录" : "账号历史暂时读取失败，原记录未改变，请重试");
    const page = await response.json() as GenerationHistoryPage;
    assertHistoryOwner(ownerId); signal?.throwIfAborted();
    if (!Array.isArray(page.tasks) || page.tasks.some(task => task.userId !== ownerId) || typeof page.hasMore !== "boolean"
        || (page.nextCursor !== null && typeof page.nextCursor !== "string") || page.hasMore !== Boolean(page.nextCursor)) throw new Error("历史记录归属或分页信息异常，未显示任何跨账号数据");
    return page;
}

/** Only saved, same-origin originals may receive the employee identity header. */
export function historyAssetPath(value: string) {
    return /^\/api\/assets\/[a-zA-Z0-9_-]+\/content$/.test(value) ? value : null;
}

export async function readHistoryOriginal(path: string, ownerId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!historyAssetPath(path)) throw new Error("此旧记录未保存本站原件，无法安全预览；原记录仍保留");
    assertHistoryOwner(ownerId);
    const response = await fetch(path, { credentials: "include", cache: "no-store", redirect: "error", headers: workspaceOwnerHeaders(), signal });
    assertHistoryOwner(ownerId); signal?.throwIfAborted();
    if (!response.ok) throw new Error(`原件暂时不可用（${response.status}），历史记录仍保留`);
    const blob = await response.blob();
    assertHistoryOwner(ownerId); signal?.throwIfAborted();
    return blob;
}
