import type { AdminQuickImageConfiguration, QuickImageEligibleModel, QuickImageConfigurationInput, QuickImageConfigurationTest, QuickImageConfigurationUpdate } from "../../../../shared/quick-image-configuration";
import { isQuickImageAction, type QuickImageAction } from "../../../../shared/quick-image-tools";
import { generationSubmissionRejected } from "@/lib/generation-feedback";
import { useUserStore } from "@/stores/use-user-store";
import { requirePromptAdmin, type PromptAdminOptions } from "./admin-prompt-recipes";
import type { QueuedTask } from "./generation-tasks";
import { classifyTaskRecovery } from "./task-result-reconciliation";

export type AdminQuickImageCatalog = { configurations: AdminQuickImageConfiguration[]; models: QuickImageEligibleModel[] };
export type AdminQuickImageTestInput = QuickImageConfigurationTest;
export type { AdminQuickImageConfiguration, QuickImageEligibleModel, QuickImageConfigurationInput, QuickImageAction };

export class AdminQuickImageRequestError extends Error {
    constructor(message: string, readonly status: number | null = null, readonly code?: string) { super(message); this.name = "AdminQuickImageRequestError"; }
    get definitive() { return this.status !== null && generationSubmissionRejected(this.status, this.code); }
}
const root = "/api/admin/model-configuration/quick-images";
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const fail = () => new AdminQuickImageRequestError("快捷图片配置响应无效，请重新加载；已提交测试请查询原请求。");

/** Admin-only, owner-bound transport. Never persist authoring data or retry a write. */
async function request(path: string, options: PromptAdminOptions, init: RequestInit = {}, timeoutMs = 30_000): Promise<unknown> {
    const owner = requirePromptAdmin(options.expectedOwnerId);
    const identity = new AbortController();
    const unsubscribe = useUserStore.subscribe(() => { try { requirePromptAdmin(owner); } catch (error) { identity.abort(error); } });
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([identity.signal, timeout, ...(options.signal ? [options.signal] : [])]);
    try {
        signal.throwIfAborted();
        const response = await fetch(path, { ...init, credentials: "include", cache: "no-store", signal,
            headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers, "X-Canvas-Owner-Id": owner } });
        signal.throwIfAborted(); requirePromptAdmin(owner);
        const body: unknown = await response.json().catch(() => null);
        signal.throwIfAborted(); requirePromptAdmin(owner);
        if (!response.ok) {
            const error = object(body) ? body : {};
            throw new AdminQuickImageRequestError(String(error.message || error.msg || `请求失败（${response.status}）`), response.status, typeof error.error === "string" ? error.error : undefined);
        }
        if (!object(body)) throw fail();
        return body;
    } catch (error) {
        requirePromptAdmin(owner);
        if (identity.signal.aborted) throw identity.signal.reason;
        if (options.signal?.aborted) throw options.signal.reason;
        if (timeout.aborted) throw new AdminQuickImageRequestError("请求超时；已提交测试请查询原请求，不要重复提交。");
        if (error instanceof TypeError) throw new AdminQuickImageRequestError("网络连接中断；已提交测试请查询原请求，不要重复提交。");
        throw error;
    } finally { unsubscribe(); }
}

function configuration(value: unknown): AdminQuickImageConfiguration {
    if (!object(value) || !isQuickImageAction(value.action) || ![value.modelConfigId, value.modelId, value.modelName].every(item => item === null || typeof item === "string")
        || typeof value.prompt !== "string" || !object(value.parameters) || !Number.isInteger(value.configurationVersion) || Number(value.configurationVersion) < 0 || typeof value.isDefault !== "boolean") throw fail();
    return value as AdminQuickImageConfiguration;
}

export async function getAdminQuickImageConfigurations(options: PromptAdminOptions): Promise<AdminQuickImageCatalog> {
    const result = await request(root, options);
    if (!object(result) || !Array.isArray(result.configurations) || !Array.isArray(result.models)) throw fail();
    const configurations = result.configurations.map(configuration);
    if (configurations.length !== 3 || new Set(configurations.map(item => item.action)).size !== 3) throw fail();
    for (const model of result.models) if (!object(model) || ![model.id, model.name, model.modelId, model.providerName, model.protocol].every(item => typeof item === "string")
        || !Array.isArray(model.capabilities) || !model.capabilities.every(item => typeof item === "string")) throw fail();
    return { configurations, models: result.models as QuickImageEligibleModel[] };
}

export async function saveAdminQuickImageConfiguration(action: QuickImageAction, input: QuickImageConfigurationUpdate, options: PromptAdminOptions) {
    const result = await request(`${root}/${encodeURIComponent(action)}`, options, { method: "PUT", body: JSON.stringify(input) });
    const saved = configuration(object(result) ? result.configuration : undefined);
    if (saved.action !== action) throw fail();
    return { configuration: saved };
}

function task(value: unknown, requestId: string): QueuedTask {
    if (!object(value) || typeof value.id !== "string" || value.requestId !== requestId || !["waiting", "processing", "paused", "success", "failed", "cancelled"].includes(String(value.status))
        || (value.resultUrls !== undefined && (!Array.isArray(value.resultUrls) || !value.resultUrls.every(url => typeof url === "string")))) throw fail();
    return { ...value, resultUrls: value.resultUrls ?? [], failureReason: value.failureReason ?? null } as QueuedTask;
}

export async function testAdminQuickImageConfiguration(action: QuickImageAction, input: AdminQuickImageTestInput, options: PromptAdminOptions) {
    const result = await request(`${root}/${encodeURIComponent(action)}/test`, options, { method: "POST", body: JSON.stringify(input) }, 120_000);
    return { task: task(object(result) ? result.task : undefined, input.requestId) };
}

export async function findAdminQuickImageTest(requestId: string, options: PromptAdminOptions): Promise<QueuedTask | null> {
    try {
        const result = await request(`/api/tasks/by-request/${encodeURIComponent(requestId)}`, options);
        return task(object(result) ? result.task : undefined, requestId);
    } catch (error) {
        if (error instanceof AdminQuickImageRequestError && error.status === 404) return null;
        throw error;
    }
}

export async function recoverAdminQuickImageTest(original: QueuedTask, options: PromptAdminOptions): Promise<QueuedTask> {
    if (classifyTaskRecovery(original) !== "resume") throw new Error("当前任务不能恢复上游查询，请只查询原任务状态，勿重新生成。");
    const result = await request(`/api/tasks/${encodeURIComponent(original.id)}/recover`, options, { method: "POST" });
    const recovered = task(object(result) ? result.task : undefined, original.requestId);
    if (recovered.id !== original.id) throw fail();
    return recovered;
}
