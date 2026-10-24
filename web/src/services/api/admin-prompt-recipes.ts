import { useUserStore } from "@/stores/use-user-store";
import type { AdminPromptCompilation, AdminPromptRecipe, AdminPromptRecipeVersion, PromptCompilationRequest, PromptRecipeSettings, PromptRecipeStats, PromptRecipeVersionContent, PublicPromptCompilation } from "../../../../shared/prompt-contracts";
import { promptRecipeSettingsSchema, promptRecipeVersionSchema } from "../../../../shared/prompt-contracts";
import { taskSubmissionSchema, type TaskSubmission } from "../../../../shared/task-contracts";
import type { QueuedTask } from "./generation-tasks";

export type PromptAdminModel = { id: string; name: string; modelId: string; capabilities: string[]; enabled?: boolean };
export type PromptRecipeDetail = { recipe: AdminPromptRecipe; versions: AdminPromptRecipeVersion[]; stats: PromptRecipeStats; compilations: AdminPromptCompilation[] };
export type PromptAdminOptions = { expectedOwnerId: string; signal?: AbortSignal };
export type AdminPromptTestInput = PromptCompilationRequest & { versionId: string; optimizerModelConfigId?: string };

export class PromptAdminRequestError extends Error {
    constructor(
        message: string,
        public readonly status: number | null,
    ) {
        super(message);
        this.name = "PromptAdminRequestError";
    }
}

export function requirePromptAdmin(expectedOwnerId?: string) {
    const { user, status } = useUserStore.getState();
    if (status !== "authenticated" || user?.status !== "active" || user.role !== "super_admin" || !user.id || (expectedOwnerId && user.id !== expectedOwnerId)) {
        throw new Error("超级管理员会话已变化，请重新进入管理中心");
    }
    return user.id;
}

/** Never persist recipe authoring content or provider diagnostics in browser storage. */
async function request<T>(path: string, options: PromptAdminOptions, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
    const owner = requirePromptAdmin(options.expectedOwnerId);
    const identity = new AbortController();
    const unsubscribe = useUserStore.subscribe(() => {
        try {
            requirePromptAdmin(owner);
        } catch {
            identity.abort(new Error("管理员会话已变化"));
        }
    });
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([identity.signal, timeout, ...(options.signal ? [options.signal] : [])]);
    try {
        const response = await fetch(path, { ...init, credentials: "include", cache: "no-store", signal, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers, "X-Canvas-Owner-Id": owner } });
        signal.throwIfAborted();
        requirePromptAdmin(owner);
        const body: unknown = await response.json().catch(() => null);
        signal.throwIfAborted();
        requirePromptAdmin(owner);
        if (!response.ok) {
            const error = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
            const message = [error.msg, error.message, error.error].find((value) => typeof value === "string") as string | undefined;
            throw new PromptAdminRequestError(message || `请求失败（${response.status}）`, response.status);
        }
        if (!body || typeof body !== "object") throw new PromptAdminRequestError("服务器返回了无效响应，请查询原请求状态", null);
        return body as T;
    } catch (error) {
        requirePromptAdmin(owner);
        if (identity.signal.aborted) throw identity.signal.reason;
        if (options.signal?.aborted) throw options.signal.reason;
        if (timeout.aborted) throw new PromptAdminRequestError("请求超时；如已提交测试，请查询原请求，不要重复提交", null);
        if (error instanceof TypeError) throw new PromptAdminRequestError("网络连接中断；如已提交测试，请查询原请求，不要重复提交", null);
        throw error;
    } finally {
        unsubscribe();
    }
}

const root = "/api/admin/prompt-recipes";
const path = (key: string) => `${root}/${encodeURIComponent(key)}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
export const listAdminPromptRecipes = (options: PromptAdminOptions) => request<{ recipes: AdminPromptRecipe[]; models: PromptAdminModel[] }>(root, options);
export const getAdminPromptRecipe = (key: string, options: PromptAdminOptions) => request<PromptRecipeDetail>(path(key), options);
export const updateAdminPromptRecipe = (key: string, input: PromptRecipeSettings, options: PromptAdminOptions) =>
    request<{ recipe: AdminPromptRecipe }>(path(key), options, { method: "PATCH", body: JSON.stringify(promptRecipeSettingsSchema.parse(input)) });
export const createAdminPromptVersion = (key: string, input: PromptRecipeVersionContent, options: PromptAdminOptions) => request<{ version: AdminPromptRecipeVersion }>(`${path(key)}/versions`, options, post(promptRecipeVersionSchema.parse(input)));
export const activateAdminPromptVersion = (key: string, versionId: string, options: PromptAdminOptions) => request<{ recipe: AdminPromptRecipe }>(`${path(key)}/activate`, options, post({ versionId }));
export const testAdminPromptRecipe = (key: string, input: AdminPromptTestInput, options: PromptAdminOptions) => request<{ compilation: PublicPromptCompilation }>(`${path(key)}/test`, options, post(input), 120_000);
export const getAdminPromptCompilation = (key: string, id: string, options: PromptAdminOptions) => request<{ compilation: AdminPromptCompilation }>(`${path(key)}/compilations/${encodeURIComponent(id)}`, options);
export async function findAdminPromptCompilation(requestId: string, options: PromptAdminOptions) {
    try {
        return (await request<{ compilation: PublicPromptCompilation }>(`/api/prompt-compilations/by-request/${encodeURIComponent(requestId)}`, options)).compilation;
    } catch (error) {
        if (error instanceof PromptAdminRequestError && error.status === 404) return null;
        throw error;
    }
}

/** Normal task endpoint, with the tested compilation and its immutable input snapshot. */
export const submitAdminPromptImage = (input: TaskSubmission, options: PromptAdminOptions) => request<{ task: QueuedTask }>("/api/tasks", options, post(taskSubmissionSchema.parse(input)), 120_000);
export async function findAdminPromptImage(requestId: string, options: PromptAdminOptions) {
    try {
        return (await request<{ task: QueuedTask }>(`/api/tasks/by-request/${encodeURIComponent(requestId)}`, options)).task;
    } catch (error) {
        if (error instanceof PromptAdminRequestError && error.status === 404) return null;
        throw error;
    }
}
