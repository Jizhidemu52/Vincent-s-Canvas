import { USAGE_COMPILATION_ANALYSIS_VERSION, type UsageCompilationAnalysis, type UsageCompilationSummary } from "../../shared/usage-compilation-analysis";
import type { UsageV2Scope } from "../../shared/usage-analytics-v2";

export const compilationPerson = "00000000-0000-4000-8000-000000000001";
export const compilationDepartment = "00000000-0000-4000-8000-000000000002";
export const compilationScope: UsageV2Scope = {
    from: "2026-10-01T16:00:00.000Z", to: "2026-10-08T16:00:00.000Z", timezone: "Asia/Shanghai",
    compare: "previous_period", departmentBasis: "current",
};
export const emptyCompilationSummary = (): UsageCompilationSummary => ({
    requests: 0, linkedRequests: 0, unlinkedRequests: 0, linkedTasks: 0, sourceCalls: 0, cacheHits: 0,
    cacheSourceOutsideScope: 0, cacheSourceMissing: 0,
    statuses: { success: 0, failed: 0, uncertain: 0, optimizing: 0 },
    sourceStatuses: { success: 0, failed: 0, uncertain: 0, optimizing: 0 },
    adminTests: { yes: 0, no: 0, unknown: 0 },
    inputTokens: { value: null, state: "unavailable", availableCount: 0, missingCount: 0 },
    outputTokens: { value: null, state: "unavailable", availableCount: 0, missingCount: 0 },
    completeTokenCalls: 0,
    latency: { sourceCalls: 0, availableCount: 0, missingCount: 0, meanMs: null, p50Ms: null, p90Ms: null },
    costs: [],
});
export function compilationFixture(scope: UsageV2Scope = compilationScope): UsageCompilationAnalysis {
    const linked: UsageCompilationSummary = {
        requests: 5, linkedRequests: 5, unlinkedRequests: 0, linkedTasks: 7, sourceCalls: 3, cacheHits: 2,
        cacheSourceOutsideScope: 1, cacheSourceMissing: 0,
        statuses: { success: 3, failed: 1, uncertain: 1, optimizing: 0 },
        sourceStatuses: { success: 1, failed: 1, uncertain: 1, optimizing: 0 },
        adminTests: { yes: 1, no: 3, unknown: 1 },
        inputTokens: { value: 1000, state: "partial", availableCount: 2, missingCount: 1 },
        outputTokens: { value: 0, state: "partial", availableCount: 1, missingCount: 2 },
        completeTokenCalls: 1,
        latency: { sourceCalls: 3, availableCount: 2, missingCount: 1, meanMs: 150, p50Ms: 150, p90Ms: 230 },
        costs: [
            { currency: "CNY", sourceCalls: 2, actualAmount: "0.000000", estimatedAmount: "0.120000", actualCount: 1, estimatedCount: 1, unknownCount: 0 },
            { currency: "USD", sourceCalls: 1, actualAmount: null, estimatedAmount: null, actualCount: 0, estimatedCount: 0, unknownCount: 1 },
        ],
    };
    const unlinked: UsageCompilationSummary = {
        requests: 4, linkedRequests: 0, unlinkedRequests: 4, linkedTasks: 0, sourceCalls: 2, cacheHits: 2,
        cacheSourceOutsideScope: 1, cacheSourceMissing: 1,
        statuses: { success: 1, failed: 0, uncertain: 2, optimizing: 1 },
        sourceStatuses: { success: 0, failed: 0, uncertain: 1, optimizing: 1 },
        adminTests: { yes: 1, no: 1, unknown: 2 },
        inputTokens: { value: null, state: "unavailable", availableCount: 0, missingCount: 2 },
        outputTokens: { value: 42, state: "partial", availableCount: 1, missingCount: 1 },
        completeTokenCalls: 0,
        latency: { sourceCalls: 2, availableCount: 0, missingCount: 2, meanMs: null, p50Ms: null, p90Ms: null },
        costs: [
            { currency: "USD", sourceCalls: 1, actualAmount: "0.500000", estimatedAmount: null, actualCount: 1, estimatedCount: 0, unknownCount: 0 },
            { currency: "unknown", sourceCalls: 1, actualAmount: null, estimatedAmount: null, actualCount: 0, estimatedCount: 0, unknownCount: 1 },
        ],
    };
    const all: UsageCompilationSummary = {
        requests: 9, linkedRequests: 5, unlinkedRequests: 4, linkedTasks: 7, sourceCalls: 5, cacheHits: 4,
        cacheSourceOutsideScope: 2, cacheSourceMissing: 1,
        statuses: { success: 4, failed: 1, uncertain: 3, optimizing: 1 },
        sourceStatuses: { success: 1, failed: 1, uncertain: 2, optimizing: 1 },
        adminTests: { yes: 2, no: 4, unknown: 3 },
        inputTokens: { value: 1000, state: "partial", availableCount: 2, missingCount: 3 },
        outputTokens: { value: 42, state: "partial", availableCount: 2, missingCount: 3 },
        completeTokenCalls: 1,
        latency: { sourceCalls: 5, availableCount: 2, missingCount: 3, meanMs: 150, p50Ms: 150, p90Ms: 230 },
        costs: [
            { currency: "CNY", sourceCalls: 2, actualAmount: "0.000000", estimatedAmount: "0.120000", actualCount: 1, estimatedCount: 1, unknownCount: 0 },
            { currency: "USD", sourceCalls: 2, actualAmount: "0.500000", estimatedAmount: null, actualCount: 1, estimatedCount: 0, unknownCount: 1 },
            { currency: "unknown", sourceCalls: 1, actualAmount: null, estimatedAmount: null, actualCount: 0, estimatedCount: 0, unknownCount: 1 },
        ],
    };
    const prior: UsageCompilationSummary = {
        ...emptyCompilationSummary(), requests: 1, unlinkedRequests: 1, sourceCalls: 1,
        statuses: { success: 1, failed: 0, uncertain: 0, optimizing: 0 },
        sourceStatuses: { success: 1, failed: 0, uncertain: 0, optimizing: 0 }, adminTests: { yes: 0, no: 1, unknown: 0 },
        inputTokens: { value: 20, state: "available", availableCount: 1, missingCount: 0 },
        outputTokens: { value: 5, state: "available", availableCount: 1, missingCount: 0 }, completeTokenCalls: 1,
        latency: { sourceCalls: 1, availableCount: 1, missingCount: 0, meanMs: 200, p50Ms: 200, p90Ms: 200 },
        costs: [{ currency: "USD", sourceCalls: 1, actualAmount: null, estimatedAmount: "0.010000", actualCount: 0, estimatedCount: 1, unknownCount: 0 }],
    };
    const comparisonScope: UsageV2Scope | null = scope.compare === "none" ? null : {
        ...scope, compare: "none", from: new Date(2 * Date.parse(scope.from) - Date.parse(scope.to)).toISOString(), to: scope.from,
    };
    return {
        meta: { metricVersion: USAGE_COMPILATION_ANALYSIS_VERSION, scope: structuredClone(scope), comparisonScope, asOf: "2026-11-05T01:00:00.000Z", dataMode: "live_existing_compilations", notes: ["隔离合成数据；未读取提示词、规则、供应商原始错误或员工明细。"] },
        current: { from: scope.from, to: scope.to, all, linked, unlinked },
        comparison: comparisonScope ? { from: comparisonScope.from, to: comparisonScope.to, all: prior, linked: emptyCompilationSummary(), unlinked: structuredClone(prior) } : null,
    };
}
