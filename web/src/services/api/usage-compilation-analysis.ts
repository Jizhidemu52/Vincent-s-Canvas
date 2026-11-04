import {
    USAGE_COMPILATION_ANALYSIS_API,
    USAGE_COMPILATION_ANALYSIS_VERSION,
    USAGE_COMPILATION_STATUSES,
    unsupportedCompilationFilters,
    type UsageCompilationAnalysis,
    type UsageCompilationSummary,
} from "../../../../shared/usage-compilation-analysis";
import type { UsageV2Scope } from "../../../../shared/usage-analytics-v2";
import { usageV2ReportAnonymousScope, usageV2ReportComparisonScope } from "../../../../shared/usage-report-v2";
import { UsageAnalyticsError } from "./usage-analytics";
import { usageV2QueryString } from "./usage-analytics-v2";
export * from "../../../../shared/usage-compilation-analysis";

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const sameDate = (left: unknown, right: string) => date(left) && Date.parse(left) === Date.parse(right);
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, any> {
    return !!value && typeof value === "object" && !Array.isArray(value)
        && required.every(key => Object.hasOwn(value, key))
        && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
const scopeArrays = ["departmentIds", "userIds", "boardKeys", "modelConfigIds", "operationTypes"] as const;
function validScope(value: unknown): value is UsageV2Scope {
    return fields(value, ["from", "to", "timezone", "compare", "departmentBasis"], [...scopeArrays, "search"])
        && date(value.from) && date(value.to) && Date.parse(value.from) < Date.parse(value.to)
        && value.timezone === "Asia/Shanghai" && ["none", "previous_period", "previous_year"].includes(value.compare)
        && ["at_event", "current"].includes(value.departmentBasis)
        && (value.search === undefined || typeof value.search === "string" && value.search.length <= 100)
        && scopeArrays.every(key => value[key] === undefined || Array.isArray(value[key]) && value[key].length <= 500
            && new Set(value[key]).size === value[key].length
            && value[key].every((item: unknown) => ["departmentIds", "userIds", "modelConfigIds"].includes(key)
                ? uuid(item) : typeof item === "string" && item.length > 0 && item.length <= 100));
}
function sameScope(actual: unknown, expected: UsageV2Scope): boolean {
    return validScope(actual) && sameDate(actual.from, expected.from) && sameDate(actual.to, expected.to)
        && actual.timezone === expected.timezone && actual.compare === expected.compare && actual.departmentBasis === expected.departmentBasis
        && (actual.search ?? "") === (expected.search ?? "")
        && scopeArrays.every(key => (actual[key]?.length ?? 0) === (expected[key]?.length ?? 0) && (actual[key] ?? []).every(item => expected[key]?.includes(item)));
}
function statuses(value: unknown, total: number) {
    return fields(value, USAGE_COMPILATION_STATUSES) && USAGE_COMPILATION_STATUSES.every(key => count(value[key]))
        && USAGE_COMPILATION_STATUSES.reduce((sum, key) => sum + value[key], 0) === total;
}
function tokens(value: unknown, sourceCalls: number) {
    return fields(value, ["value", "state", "availableCount", "missingCount"])
        && count(value.availableCount) && count(value.missingCount) && value.availableCount + value.missingCount === sourceCalls
        && (value.availableCount === 0 ? value.value === null && value.state === "unavailable"
            : count(value.value) && value.state === (value.missingCount ? "partial" : "available"));
}
const summaryCounts = ["requests", "linkedRequests", "unlinkedRequests", "linkedTasks", "sourceCalls", "cacheHits", "cacheSourceOutsideScope", "cacheSourceMissing", "completeTokenCalls"] as const;
function summary(value: unknown): value is UsageCompilationSummary {
    if (!fields(value, [...summaryCounts, "statuses", "sourceStatuses", "adminTests", "inputTokens", "outputTokens", "latency", "costs"])
        || !summaryCounts.every(key => count(value[key]))
        || value.linkedRequests + value.unlinkedRequests !== value.requests || value.linkedTasks < value.linkedRequests
        || value.sourceCalls + value.cacheHits !== value.requests || value.cacheSourceOutsideScope + value.cacheSourceMissing > value.cacheHits
        || !statuses(value.statuses, value.requests) || !statuses(value.sourceStatuses, value.sourceCalls)
        || !fields(value.adminTests, ["yes", "no", "unknown"]) || !["yes", "no", "unknown"].every(key => count(value.adminTests[key]))
        || value.adminTests.yes + value.adminTests.no + value.adminTests.unknown !== value.requests
        || !tokens(value.inputTokens, value.sourceCalls) || !tokens(value.outputTokens, value.sourceCalls)
        || value.completeTokenCalls > Math.min(value.inputTokens.availableCount, value.outputTokens.availableCount)
        || value.completeTokenCalls < Math.max(0, value.inputTokens.availableCount + value.outputTokens.availableCount - value.sourceCalls)) return false;
    const latency = value.latency;
    if (!fields(latency, ["sourceCalls", "availableCount", "missingCount", "meanMs", "p50Ms", "p90Ms"])
        || latency.sourceCalls !== value.sourceCalls || !count(latency.availableCount) || !count(latency.missingCount)
        || latency.availableCount + latency.missingCount !== value.sourceCalls
        || !["meanMs", "p50Ms", "p90Ms"].every(key => latency.availableCount === 0 ? latency[key] === null : nonnegative(latency[key]))
        || latency.availableCount > 0 && latency.p50Ms > latency.p90Ms) return false;
    if (!Array.isArray(value.costs) || value.costs.length > value.sourceCalls || new Set(value.costs.map(cost => cost?.currency)).size !== value.costs.length) return false;
    const amount = (item: unknown, knownCount: number) => knownCount === 0 ? item === null : typeof item === "string" && /^\d{1,30}\.\d{6}$/.test(item);
    return value.costs.every(cost => fields(cost, ["currency", "sourceCalls", "actualAmount", "estimatedAmount", "actualCount", "estimatedCount", "unknownCount"])
        && typeof cost.currency === "string" && /^(?:[A-Z]{3}|unknown)$/.test(cost.currency)
        && ["sourceCalls", "actualCount", "estimatedCount", "unknownCount"].every(key => count(cost[key])) && cost.sourceCalls > 0
        && cost.actualCount + cost.estimatedCount + cost.unknownCount === cost.sourceCalls
        && amount(cost.actualAmount, cost.actualCount) && amount(cost.estimatedAmount, cost.estimatedCount)
        && (cost.currency !== "unknown" || cost.actualCount === 0 && cost.estimatedCount === 0))
        && value.costs.reduce((sum, cost) => sum + cost.sourceCalls, 0) === value.sourceCalls;
}
function period(value: unknown, scope: UsageV2Scope) {
    return fields(value, ["from", "to", "all", "linked", "unlinked"]) && sameDate(value.from, scope.from) && sameDate(value.to, scope.to)
        && summary(value.all) && summary(value.linked) && summary(value.unlinked)
        && value.linked.unlinkedRequests === 0 && value.unlinked.linkedRequests === 0 && value.unlinked.linkedTasks === 0
        && summaryCounts.every(key => value.all[key] === value.linked[key] + value.unlinked[key])
        && USAGE_COMPILATION_STATUSES.every(key => value.all.statuses[key] === value.linked.statuses[key] + value.unlinked.statuses[key]
            && value.all.sourceStatuses[key] === value.linked.sourceStatuses[key] + value.unlinked.sourceStatuses[key])
        && ["yes", "no", "unknown"].every(key => value.all.adminTests[key] === value.linked.adminTests[key] + value.unlinked.adminTests[key]);
}
function validAnalysis(value: unknown, scope: UsageV2Scope): value is UsageCompilationAnalysis {
    const dates = usageV2ReportComparisonScope(usageV2ReportAnonymousScope(scope));
    const comparisonScope: UsageV2Scope | null = dates ? { ...scope, from: dates.from, to: dates.to, compare: "none" } : null;
    return fields(value, ["meta", "current", "comparison"])
        && fields(value.meta, ["metricVersion", "scope", "comparisonScope", "asOf", "dataMode", "notes"])
        && value.meta.metricVersion === USAGE_COMPILATION_ANALYSIS_VERSION && value.meta.dataMode === "live_existing_compilations"
        && sameScope(value.meta.scope, scope) && date(value.meta.asOf)
        && Array.isArray(value.meta.notes) && value.meta.notes.length <= 20 && value.meta.notes.every((note: unknown) => typeof note === "string" && note.length <= 2000)
        && period(value.current, scope)
        && (comparisonScope ? sameScope(value.meta.comparisonScope, comparisonScope) && period(value.comparison, comparisonScope)
            : value.meta.comparisonScope === null && value.comparison === null);
}

/** Explicit read only. Never remove unsupported filters or accept raw compilation records. */
export async function getUsageCompilationAnalysis(scope: UsageV2Scope, signal?: AbortSignal): Promise<UsageCompilationAnalysis> {
    if (!validScope(scope)) throw new UsageAnalyticsError("编译分析筛选范围无效，未发出请求。", "INVALID_COMPILATION_SCOPE");
    const unsupported = unsupportedCompilationFilters(scope);
    if (unsupported.length) throw new UsageAnalyticsError(`独立编译分析不支持当前筛选：${unsupported.join("、")}；未清空或扩大共享范围。`, "USAGE_COMPILATION_FILTER_UNSUPPORTED");
    try {
        signal?.throwIfAborted();
        const response = await fetch(`${USAGE_COMPILATION_ANALYSIS_API}${usageV2QueryString(scope)}`, { credentials: "include", cache: "no-store", redirect: "error", signal });
        if (!response.ok) throw new UsageAnalyticsError(
            response.status === 401 || response.status === 403 ? "仅当前已登录的超级管理员可读取独立编译分析。"
                : response.status === 400 ? "当前筛选不适用于独立编译分析；未自动清空筛选。"
                : response.status === 422 ? "当前编译范围超过安全读取或精确计数上限，请缩小日期或人员范围；未截断或补零。"
                : response.status === 404 ? "当前服务尚未提供独立编译分析。"
                : "独立编译分析读取未完成，请手动重试；未调用模型或新增采集。",
            "USAGE_COMPILATION_REQUEST_FAILED", response.status,
        );
        const envelope = await response.json();
        signal?.throwIfAborted();
        if (envelope?.code !== 0 || !validAnalysis(envelope.data, scope)) throw new UsageAnalyticsError("编译分析响应不完整或与本次范围、分组口径不一致，未显示。", "INVALID_COMPILATION_RESPONSE");
        return envelope.data;
    } catch (error) {
        if (error instanceof UsageAnalyticsError || (error instanceof Error && error.name === "AbortError")) throw error;
        throw new UsageAnalyticsError("编译分析连接或响应格式异常；未自动重试。", "USAGE_COMPILATION_RESPONSE_FAILED");
    }
}
