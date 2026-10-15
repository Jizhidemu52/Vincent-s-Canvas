import { USAGE_API, type UsageAnalysisPreview, type UsageAnalysisPreviewRequest, type UsageAnalysisResult, type UsageAnalyzeRequest, type UsageCoverage, type UsageEnvelope, type UsageFilters, type UsagePeopleResult, type UsagePersonResult } from "../../../../shared/usage-analytics";

export type { UsageAnalysisPreview, UsageAnalysisPreviewRequest, UsageAnalysisResult, UsageFilters, UsagePeopleResult, UsagePersonResult } from "../../../../shared/usage-analytics";

export class UsageAnalyticsError extends Error {
    constructor(message: string, readonly code: string, readonly status?: number) { super(message); this.name = "UsageAnalyticsError"; }
}

function safeError(status: number, code = "REQUEST_FAILED") {
    const message = status === 401 ? "登录已过期，请重新登录。"
        : status === 403 ? "仅超级管理员可查看和导出使用分析。"
        : [404, 405, 501].includes(status) ? "当前服务尚未启用使用分析，请使用已升级的正式业务服务。"
        : status === 409 || status === 410 ? "预览已过期、已使用或数据状态已变化，请重新预览后再分析；不会自动重复调用。"
        : status === 429 ? "请求过于频繁，请稍后手动重试。"
        : status === 400 || status === 413 ? "请求未完成，请检查日期范围、选择的用户与模型。"
        : "使用分析服务暂不可用，请稍后手动重试。";
    return new UsageAnalyticsError(message, code, status);
}

async function responseError(response: Response) {
    const body = await response.json().catch(() => null) as { code?: unknown } | null;
    return safeError(response.status, typeof body?.code === "string" && /^[A-Z_0-9]{1,80}$/.test(body.code) ? body.code : "REQUEST_FAILED");
}

function rethrowSafe(error: unknown): never {
    if (error instanceof UsageAnalyticsError || (error instanceof Error && error.name === "AbortError")) throw error;
    throw new UsageAnalyticsError("网络连接或响应格式异常，本次操作未完成，请手动重试。", "NETWORK_OR_RESPONSE_ERROR");
}

async function request<T>(url: string, signal?: AbortSignal, body?: unknown): Promise<T> {
    try {
        const response = await fetch(url, { method: body === undefined ? "GET" : "POST", credentials: "include", cache: "no-store", signal, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
        if (!response.ok) throw await responseError(response);
        const envelope = await response.json() as UsageEnvelope<T>;
        if (envelope.code !== 0 || envelope.data == null) throw new UsageAnalyticsError("使用分析响应格式不完整，请刷新后重试。", "INVALID_RESPONSE");
        signal?.throwIfAborted();
        return envelope.data;
    } catch (error) { rethrowSafe(error); }
}

export type UsageListQuery = Omit<UsageFilters, "userIds"> & { search?: string; page?: number; pageSize?: number };
function queryString(query: UsageListQuery) {
    const params = new URLSearchParams();
    for (const key of ["search", "from", "to", "modelConfigId", "boardKey", "page", "pageSize"] as const) {
        const value = query[key];
        if (value !== undefined && value !== "") params.set(key, String(value));
    }
    return params.size ? `?${params}` : "";
}

export const listUsagePeople = (query: UsageListQuery, signal?: AbortSignal) => request<UsagePeopleResult>(`${USAGE_API.people}${queryString(query)}`, signal);
export const getUsagePerson = (id: string, query: UsageListQuery, signal?: AbortSignal) => request<UsagePersonResult>(`${USAGE_API.person(id)}${queryString(query)}`, signal);
export async function listUsageAnalysisModels(signal?: AbortSignal) {
    const result = await request<import("../../../../shared/usage-analytics").UsageAnalysisModelsResult>(USAGE_API.analysisModels, signal);
    if (!Array.isArray(result.models) || result.models.some(model => !model || typeof model.id !== "string" || !model.id || typeof model.name !== "string" || (model.description !== undefined && typeof model.description !== "string"))) {
        throw new UsageAnalyticsError("文字模型列表响应不完整，请手动重新加载。", "INVALID_RESPONSE");
    }
    return result;
}
export const previewUsageAnalysis = (body: UsageAnalysisPreviewRequest, signal?: AbortSignal) => request<UsageAnalysisPreview>(USAGE_API.analysisPreview, signal, body);
export const analyzeUsage = (body: UsageAnalyzeRequest, signal?: AbortSignal) => request<UsageAnalysisResult>(USAGE_API.analyze, signal, body);

export type UsageExportManifest = { type: "manifest"; filters: UsageFilters; coverage: UsageCoverage; exportedAt: string };
export type UsageExportResult = { blob: Blob | null; recordCount: number; manifest: UsageExportManifest };
/** Never report a partial download as complete. Optional sink writes large exports without buffering the full file. */
export async function exportUsageRecords(filters: UsageFilters, options: { signal?: AbortSignal; onProgress?: (records: number) => void; writeChunk?: (chunk: Uint8Array) => Promise<void> } = {}): Promise<UsageExportResult> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        const response = await fetch(USAGE_API.export, { method: "POST", credentials: "include", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(filters), signal: options.signal });
        if (!response.ok) throw await responseError(response);
        if (!response.headers.get("content-type")?.includes("application/x-ndjson") || !response.body) throw new UsageAnalyticsError("导出响应格式错误，未保存文件。", "INVALID_EXPORT");
        reader = response.body.getReader();
        const decoder = new TextDecoder(), chunks: Uint8Array<ArrayBuffer>[] = [];
        let pending = "", recordCount = 0, complete = false, manifest: UsageExportManifest | undefined;
        const line = (raw: string) => {
            if (!raw.trim()) return;
            if (complete) throw new UsageAnalyticsError("导出结束标记后出现额外数据，未保存文件。", "INVALID_EXPORT");
            const value = JSON.parse(raw) as Record<string, unknown>;
            if (value.type === "manifest" && !manifest && !recordCount) manifest = value as UsageExportManifest;
            else if (value.type === "record" && manifest && value.record && typeof value.record === "object") recordCount++;
            else if (value.type === "complete" && manifest && value.recordCount === recordCount) complete = true;
            else throw new UsageAnalyticsError("导出记录或完成数量不一致，未保存文件。", "INVALID_EXPORT");
        };
        while (true) {
            options.signal?.throwIfAborted();
            const item = await reader.read();
            if (item.done) break;
            pending += decoder.decode(item.value, { stream: true });
            const lines = pending.split("\n"); pending = lines.pop() || "";
            lines.forEach(line);
            options.onProgress?.(recordCount);
            if (options.writeChunk) await options.writeChunk(item.value); else chunks.push(new Uint8Array(item.value));
        }
        pending += decoder.decode(); if (pending.trim()) line(pending);
        options.signal?.throwIfAborted();
        if (!complete || !manifest) throw new UsageAnalyticsError("导出连接中断，未收到完整结束标记；未保存不完整文件。", "INCOMPLETE_EXPORT");
        return { blob: options.writeChunk ? null : new Blob(chunks, { type: "application/x-ndjson;charset=utf-8" }), recordCount, manifest };
    } catch (error) { await reader?.cancel().catch(() => undefined); return rethrowSafe(error); }
    finally { reader?.releaseLock(); }
}
