import type { UsageV2MetricState, UsageV2Scope } from "./usage-analytics-v2";

export const USAGE_COMPILATION_ANALYSIS_API = "/api/admin/usage/compilations";
export const USAGE_COMPILATION_ANALYSIS_VERSION = "compilation-existing-facts-v1";
export const USAGE_COMPILATION_STATUSES = ["success", "failed", "uncertain", "optimizing"] as const;
export type UsageCompilationStatuses = Record<typeof USAGE_COMPILATION_STATUSES[number], number>;
export type UsageCompilationNumber = {
    value: number | null;
    state: UsageV2MetricState;
    availableCount: number;
    missingCount: number;
};
export type UsageCompilationCosts = {
    currency: string;
    sourceCalls: number;
    actualAmount: string | null;
    estimatedAmount: string | null;
    actualCount: number;
    estimatedCount: number;
    unknownCount: number;
};
export type UsageCompilationSummary = {
    requests: number;
    linkedRequests: number;
    unlinkedRequests: number;
    linkedTasks: number;
    sourceCalls: number;
    cacheHits: number;
    cacheSourceOutsideScope: number;
    cacheSourceMissing: number;
    statuses: UsageCompilationStatuses;
    sourceStatuses: UsageCompilationStatuses;
    adminTests: { yes: number; no: number; unknown: number };
    inputTokens: UsageCompilationNumber;
    outputTokens: UsageCompilationNumber;
    completeTokenCalls: number;
    latency: {
        sourceCalls: number;
        availableCount: number;
        missingCount: number;
        meanMs: number | null;
        p50Ms: number | null;
        p90Ms: number | null;
    };
    costs: UsageCompilationCosts[];
};
export type UsageCompilationPeriod = {
    from: string;
    to: string;
    all: UsageCompilationSummary;
    linked: UsageCompilationSummary;
    unlinked: UsageCompilationSummary;
};
export type UsageCompilationAnalysis = {
    meta: {
        metricVersion: typeof USAGE_COMPILATION_ANALYSIS_VERSION;
        scope: UsageV2Scope;
        comparisonScope: UsageV2Scope | null;
        asOf: string;
        dataMode: "live_existing_compilations";
        notes: string[];
    };
    current: UsageCompilationPeriod;
    comparison: UsageCompilationPeriod | null;
};

/** Never silently drop shared filters: compilation records cannot establish these dimensions. */
export function unsupportedCompilationFilters(scope: Partial<UsageV2Scope>): string[] {
    return [
        ...(scope.departmentIds?.length && scope.departmentBasis !== "current" ? ["事件时部门"] : []),
        ...(scope.boardKeys?.length ? ["板块"] : []),
        ...(scope.modelConfigIds?.length ? ["生成模型"] : []),
        ...(scope.operationTypes?.length ? ["操作类型"] : []),
    ];
}
