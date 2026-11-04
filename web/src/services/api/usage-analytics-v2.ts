import {
    USAGE_V2_API,
    type UsageRollupJob,
    type UsageRollupRequest,
    type UsageV2Boards,
    type UsageV2Flows,
    type UsageV2Models,
    type UsageV2Options,
    type UsageV2Overview,
    type UsageV2People,
    type UsageV2Profile,
    type UsageV2Quality,
    type UsageV2Query,
} from "../../../../shared/usage-analytics-v2";
import { UsageAnalyticsError } from "./usage-analytics";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { USAGE_API } from "../../../../shared/usage-analytics";
import {
    USAGE_V2_ANALYSIS_PREVIEW_API,
    usageV2AnalysisHashInput,
    usageV2ReportPeriodError,
    usageV2ReportAnonymousScope,
    usageV2ReportComparisonScope,
    type UsageV2ReportRequest,
    type UsageV2ReportResult,
    type UsageV2ReportFilters,
    type UsageV2ReportScope,
    type UsageV2AnalysisPreview,
    type UsageV2AnalyzeRequest,
    type UsageV2AnalysisResult,
} from "../../../../shared/usage-report-v2";
export * from "../../../../shared/usage-analytics-v2";
export * from "../../../../shared/usage-report-v2";

export function usageV2QueryString(query: UsageV2Query) {
    const params = new URLSearchParams();
    for (const key of [
        "from",
        "to",
        "compare",
        "departmentBasis",
        "departmentIds",
        "userIds",
        "boardKeys",
        "modelConfigIds",
        "operationTypes",
        "search",
        "page",
        "pageSize",
        "sort",
        "order",
    ] as const) {
        const value = query[key];
        if (value !== undefined && value !== "" && (!Array.isArray(value) || value.length))
            params.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    return params.size ? `?${params}` : "";
}
async function request<T>(
    path: string,
    query: UsageV2Query,
    signal?: AbortSignal,
    body?: UsageRollupRequest | UsageV2ReportRequest | UsageV2AnalyzeRequest,
): Promise<T> {
    try {
        const response = await fetch(`${path}${usageV2QueryString(query)}`, {
            credentials: "include",
            cache: "no-store",
            signal,
            ...(body
                ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
                : {}),
        });
        if (!response.ok) {
            const error = (await response.json().catch(() => null)) as { code?: unknown } | null;
            const code =
                typeof error?.code === "string" &&
                [
                    "USAGE_ROLLUP_REFRESH_REQUIRED",
                    "USAGE_ROLLUP_KEY_CONFLICT",
                    "USAGE_INVALID",
                    "USAGE_REPORT_PERIOD_MISMATCH",
                    "USAGE_PREVIEW_TOO_LARGE",
                    "USAGE_PREVIEW_USED_OR_EXPIRED",
                    "USAGE_PREVIEW_CONTENT_MISMATCH",
                    "USAGE_ANALYSIS_FAILED",
                    "USAGE_ANALYSIS_INVALID",
                ].includes(error.code)
                    ? error.code
                    : "V2_REQUEST_FAILED";
            throw new UsageAnalyticsError(
                code === "USAGE_ROLLUP_REFRESH_REQUIRED"
                    ? "本期或对比期的日事实待回填 / 变更后待补算。请明确刷新相应日期并等待任务完成，再刷新读取；当前未返回过期统计。"
                    : code === "USAGE_ROLLUP_KEY_CONFLICT"
                      ? "本次刷新标识已对应其他日期，未重新启动任务。请核查已有回执后明确发起新刷新。"
                      : code === "USAGE_REPORT_PERIOD_MISMATCH"
                        ? "周报需完整北京时间自然周，月报需完整自然月。请调整日期，或选择区间报告；未改动当前筛选。"
                        : code === "USAGE_PREVIEW_TOO_LARGE"
                          ? "报告超过 32,000 字符安全上限，请缩短日期或增加筛选；未保存截断报告。"
                          : code === "USAGE_PREVIEW_USED_OR_EXPIRED" || code === "USAGE_PREVIEW_CONTENT_MISMATCH"
                            ? "冻结预览已使用、过期或校验不一致，未重复发送。请先核查原调用，再明确创建新预览。"
                            : code === "USAGE_ANALYSIS_FAILED" || code === "USAGE_ANALYSIS_INVALID"
                              ? "模型调用未获得可用结果，可能已产生费用；不会自动重发。请先核查原调用。"
                              : response.status === 403
                                ? "仅超级管理员可查看使用分析。"
                                : response.status === 401
                                  ? "登录已过期，请重新登录。"
                                  : response.status === 400
                                    ? "筛选条件无效，请检查日期范围与选项。"
                                    : response.status === 422
                                      ? "当前分析范围超过安全读取上限，请缩短日期或增加人员 / 部门 / 板块筛选。"
                                      : response.status === 404
                                        ? "当前正式服务尚未启用新版使用分析。"
                                        : "使用分析暂不可用，请手动重试。",
                code,
                response.status,
            );
        }
        const envelope = await response.json();
        if (envelope.code !== 0 || !envelope.data)
            throw new UsageAnalyticsError("使用分析响应不完整，请手动重试。", "INVALID_RESPONSE");
        signal?.throwIfAborted();
        return envelope.data as T;
    } catch (error) {
        if (error instanceof UsageAnalyticsError || (error instanceof Error && error.name === "AbortError"))
            throw error;
        throw new UsageAnalyticsError("网络连接或响应格式异常，请手动重试。", "NETWORK_OR_RESPONSE_ERROR");
    }
}
const read = <T>(path: string, query: UsageV2Query, signal?: AbortSignal) => request<T>(path, query, signal);
/** A malformed or partially complete receipt must not be presented as a finished recompute. */
export function validUsageRollupJob(value: unknown): value is UsageRollupJob {
    if (!value || typeof value !== "object") return false;
    const job = value as UsageRollupJob;
    const day = (text: unknown): text is string =>
        typeof text === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(text) &&
        Number.isFinite(Date.parse(`${text}T00:00:00Z`)) &&
        new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
    if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.jobId || "") ||
        !["queued", "running", "completed", "failed"].includes(job.status) ||
        !day(job.fromDay) ||
        !day(job.toDay)
    )
        return false;
    const days = (Date.parse(job.toDay) - Date.parse(job.fromDay)) / 86400000 + 1;
    if (
        days < 1 ||
        days > 31 ||
        !Array.isArray(job.completedDays) ||
        new Set(job.completedDays).size !== job.completedDays.length ||
        job.completedDays.some((item) => !day(item) || item < job.fromDay || item > job.toDay)
    )
        return false;
    if (
        ![job.createdAt, job.updatedAt].every(
            (item) => typeof item === "string" && Number.isFinite(Date.parse(item)),
        ) ||
        (job.completedAt !== null &&
            (typeof job.completedAt !== "string" || !Number.isFinite(Date.parse(job.completedAt))))
    )
        return false;
    if (job.failureCode !== null && (typeof job.failureCode !== "string" || !/^[A-Z_0-9]{1,80}$/.test(job.failureCode)))
        return false;
    return job.status !== "completed" || (job.completedDays.length === days && job.completedAt !== null);
}
async function rollupRequest(path: string, signal?: AbortSignal, body?: UsageRollupRequest) {
    const job = await request<UsageRollupJob>(path, {}, signal, body);
    if (!validUsageRollupJob(job) || (body && (job.fromDay !== body.fromDay || job.toDay !== body.toDay)))
        throw new UsageAnalyticsError(
            "刷新回执不完整或日期不匹配，不能确认完成。请找回同一次刷新回执。",
            "INVALID_RESPONSE",
        );
    return job;
}
export const recomputeUsageRollups = (body: UsageRollupRequest, signal?: AbortSignal) =>
    rollupRequest(USAGE_V2_API.recompute, signal, body);
export const getUsageRollupJob = (id: string, signal?: AbortSignal) =>
    rollupRequest(USAGE_V2_API.rollupJob(id), signal);
export const getUsageV2Options = (query: UsageV2Query, signal?: AbortSignal) =>
    read<UsageV2Options>(USAGE_V2_API.options, query, signal);
export const getUsageV2Overview = (query: UsageV2Query, signal?: AbortSignal) =>
    read<UsageV2Overview>(USAGE_V2_API.overview, query, signal);
export const getUsageV2People = (query: UsageV2Query, signal?: AbortSignal) =>
    read<UsageV2People>(USAGE_V2_API.people, query, signal);
/** Compare one response, never cached rows collected at different paging times. */
export async function getUsageV2PeopleComparison(query: UsageV2Query, ids: string[], signal?: AbortSignal) {
    const userIds = [...new Set(ids)];
    if (
        userIds.length < 2 ||
        userIds.length > 5 ||
        (query.userIds?.length && userIds.some((id) => !query.userIds!.includes(id)))
    )
        throw new UsageAnalyticsError("请选择当前筛选范围内的 2–5 人。", "INVALID_COMPARISON");
    const result = await getUsageV2People({ ...query, userIds, page: 1, pageSize: 5 }, signal);
    const actualIds = result.people?.map((person) => person.userId) || [];
    const sameSet = (left: string[] = [], right: string[] = []) =>
        left.length === right.length &&
        new Set(left).size === left.length &&
        left.every((value) => right.includes(value));
    const scope = result.meta?.scope;
    const sameScope =
        scope &&
        ["from", "to", "compare", "departmentBasis", "search"].every(
            (key) =>
                query[key as keyof UsageV2Query] === undefined ||
                scope[key as keyof typeof scope] === query[key as keyof UsageV2Query],
        ) &&
        (["departmentIds", "boardKeys", "modelConfigIds", "operationTypes"] as const).every((key) =>
            sameSet(query[key], scope[key]),
        );
    if (
        !sameScope ||
        !sameSet(scope.userIds, userIds) ||
        !sameSet(actualIds, userIds) ||
        result.pagination?.page !== 1 ||
        result.pagination.total !== userIds.length
    )
        throw new UsageAnalyticsError(
            "本次响应未完整返回同一筛选下的全部所选人员，未显示不完整对比。请刷新列表并重新选择；不会拼接旧分页记录或补零。",
            "INCOMPLETE_COMPARISON",
        );
    return { ...result, people: userIds.map((id) => result.people.find((person) => person.userId === id)!) };
}
export const getUsageV2Profile = (id: string, query: UsageV2Query, signal?: AbortSignal) =>
    read<UsageV2Profile>(USAGE_V2_API.profile(id), query, signal);
export const getUsageV2Boards = (query: UsageV2Query, signal?: AbortSignal) =>
    read<UsageV2Boards>(USAGE_V2_API.boards, query, signal);
export const getUsageV2Models = (query: UsageV2Query, signal?: AbortSignal) =>
    read<UsageV2Models>(USAGE_V2_API.models, query, signal);
export const getUsageV2Quality = (query: UsageV2Query, signal?: AbortSignal) =>
    read<UsageV2Quality>(USAGE_V2_API.quality, query, signal);
export const getUsageV2Flows = (query: UsageV2Query, signal?: AbortSignal) =>
    read<UsageV2Flows>(USAGE_V2_API.flows, query, signal);

function normalizedReportRequest(input: UsageV2ReportRequest): UsageV2ReportRequest {
    const periodError = usageV2ReportPeriodError(input.period, input.filters.from, input.filters.to);
    if (periodError) throw new UsageAnalyticsError(periodError, "USAGE_REPORT_PERIOD_MISMATCH", 422);
    const filters: UsageV2ReportFilters = { from: input.filters.from, to: input.filters.to };
    for (const key of ["compare", "departmentBasis"] as const)
        if (input.filters[key] !== undefined) Object.assign(filters, { [key]: input.filters[key] });
    if (input.filters.search?.trim()) filters.search = input.filters.search.trim();
    for (const key of ["departmentIds", "userIds", "boardKeys", "modelConfigIds", "operationTypes"] as const)
        if (input.filters[key]?.length) filters[key] = [...new Set(input.filters[key])];
    return { page: input.page, period: input.period, filters };
}
function validateReportResponse<T extends UsageV2ReportResult>(report: T, input: UsageV2ReportRequest): T {
    const { filters } = input;
    let decoded: Record<string, unknown> | null = null;
    if (typeof report?.content === "string" && report.content.length > 0 && report.content.length <= 32_000) {
        try {
            decoded = JSON.parse(report.content);
        } catch {
            /* A partial body is not a downloadable report. */
        }
    }
    const expectedScope = usageV2ReportAnonymousScope({
        ...filters,
        timezone: "Asia/Shanghai",
        compare: filters.compare ?? "previous_period",
        departmentBasis: filters.departmentBasis ?? "at_event",
    });
    const sameScope = (actual: unknown, expected: UsageV2ReportScope | null): boolean => {
        if (expected === null) return actual === null;
        if (!actual || typeof actual !== "object") return false;
        const value = actual as UsageV2ReportScope;
        return (
            (["from", "to", "timezone", "compare", "departmentBasis"] as const).every(
                (key) => value[key] === expected[key],
            ) &&
            value.filters != null &&
            (["selectedPeopleCount", "selectedDepartmentCount", "selectedModelCount", "searchApplied"] as const).every(
                (key) => value.filters[key] === expected.filters[key],
            ) &&
            (["boards", "operations"] as const).every(
                (key) =>
                    Array.isArray(value.filters[key]) &&
                    value.filters[key].length === expected.filters[key].length &&
                    value.filters[key].every((item, index) => item === expected.filters[key][index]),
            )
        );
    };
    const expectedComparison = usageV2ReportComparisonScope(expectedScope);
    const valid =
        decoded &&
        decoded.schemaVersion === 2 &&
        decoded.page === input.page &&
        decoded.period === input.period &&
        decoded.reportVersion === "usage-report-v2.1" &&
        decoded.metrics !== null &&
        typeof decoded.metrics === "object" &&
        !Array.isArray(decoded.metrics) &&
        ["coverage", "tables", "truncation", "excluded", "warnings"].every((key) => Array.isArray(decoded[key])) &&
        report.page === input.page &&
        report.period === input.period &&
        report.estimatedCharacters === report.content.length &&
        typeof report.markdown === "string" &&
        report.markdown.length > 0 &&
        report.markdown.length <= 32_000 &&
        Array.isArray(report.warnings) &&
        report.warnings.length <= 20 &&
        report.warnings.every((item) => typeof item === "string") &&
        sameScope(report.scope, expectedScope) &&
        sameScope(decoded.scope, expectedScope) &&
        sameScope(report.comparisonScope, expectedComparison) &&
        sameScope(decoded.comparisonScope, expectedComparison) &&
        (["metricVersion", "asOf", "computedThrough", "dataMode", "liveFrom"] as const).every(
            (key) => report[key] === decoded[key],
        );
    if (!valid)
        throw new UsageAnalyticsError(
            "报告响应不完整或与本次范围不一致，未显示或保存报告。请手动重新生成。",
            "INVALID_REPORT_RESPONSE",
        );
    return report;
}

/** POST is explicit and free. Only allowed filters go to the server, never chart values or loaded person rows. */
export async function generateUsageV2Report(
    input: UsageV2ReportRequest,
    signal?: AbortSignal,
): Promise<UsageV2ReportResult> {
    const body = normalizedReportRequest(input);
    return validateReportResponse(await request<UsageV2ReportResult>(USAGE_V2_API.report, {}, signal, body), body);
}
const reportUuid = (value: unknown): value is string =>
    typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
/** This creates a frozen one-shot token but never calls a model. A free report has no such token. */
export async function previewUsageV2Analysis(
    input: UsageV2ReportRequest,
    signal?: AbortSignal,
): Promise<UsageV2AnalysisPreview> {
    const body = normalizedReportRequest(input);
    const preview = validateReportResponse(
        await request<UsageV2AnalysisPreview>(USAGE_V2_ANALYSIS_PREVIEW_API, {}, signal, body),
        body,
    );
    const valid =
        preview.source === "v2" &&
        reportUuid(preview.previewId) &&
        typeof preview.previewHash === "string" &&
        /^[a-f0-9]{64}$/.test(preview.previewHash) &&
        typeof preview.expiresAt === "string" &&
        Number.isFinite(Date.parse(preview.expiresAt)) &&
        Date.parse(preview.expiresAt) > Date.now() &&
        preview.includesPromptSamples === false &&
        preview.sampleCount === 0 &&
        typeof preview.systemPromptVersion === "string" &&
        /^usage-ai-v2\.\d+(?:\.\d+)?$/.test(preview.systemPromptVersion) &&
        typeof preview.systemPrompt === "string" &&
        preview.systemPrompt.length > 0 &&
        preview.systemPrompt.length <= 8000;
    if (
        !valid ||
        bytesToHex(
            sha256(usageV2AnalysisHashInput(preview.content, preview.systemPrompt, preview.systemPromptVersion)),
        ) !== preview.previewHash
    )
        throw new UsageAnalyticsError(
            "V2冻结输入或校验码不完整，未启用付费确认。请手动重新预览。",
            "INVALID_V2_ANALYSIS_PREVIEW",
        );
    return preview;
}
/** One explicit confirm, only token/hash/model/source. Server owns atomic claim; never retry here. */
export async function analyzeUsageV2(
    input: UsageV2AnalyzeRequest,
    signal?: AbortSignal,
): Promise<UsageV2AnalysisResult> {
    if (
        input.source !== "v2" ||
        input.confirm !== true ||
        !reportUuid(input.previewId) ||
        !reportUuid(input.modelConfigId) ||
        !/^[a-f0-9]{64}$/.test(input.previewHash)
    )
        throw new UsageAnalyticsError("请先检查V2冻结输入并明确确认模型与费用。", "INVALID_V2_ANALYSIS_CONFIRM");
    const body: UsageV2AnalyzeRequest = {
        source: "v2",
        previewId: input.previewId,
        previewHash: input.previewHash,
        modelConfigId: input.modelConfigId,
        confirm: true,
    };
    const result = await request<UsageV2AnalysisResult>(USAGE_API.analyze, {}, signal, body);
    if (
        result.source !== "v2" ||
        result.analysisId !== input.previewId ||
        result.modelConfigId !== input.modelConfigId ||
        typeof result.content !== "string" ||
        !result.content.trim() ||
        result.content.length > 30_000 ||
        typeof result.createdAt !== "string" ||
        !Number.isFinite(Date.parse(result.createdAt))
    )
        throw new UsageAnalyticsError(
            "分析回执不完整或来源不符，调用可能已发生；不会重新发送，请核查原调用。",
            "INVALID_V2_ANALYSIS_RESULT",
        );
    return result;
}
