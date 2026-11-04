import type { UsageV2MetricState, UsageV2Scope } from "./usage-analytics-v2";

export const USAGE_MATURE_RESULTS_API = "/api/admin/usage/mature-results";
export const USAGE_MATURE_RESULTS_VERSION = "submitted-cohort-completed-168h-v1";
export type UsageMatureRate = { value: number | null; state: UsageV2MetricState };
export type UsageMatureSummary = {
    tasks: number;
    outputKnownTasks: number;
    missingOutputTasks: number;
    generatedResults: number;
    linkedResults: number;
    unknownBindingResults: number;
    usedResults: number;
    formallyAdoptedResults: number;
    linkedNoEvidenceResults: number;
    clientReportedUsedResults: number;
    serverConfirmedUsedResults: number;
    beforeCompletionEvents: number;
    windowEvents: number;
    reversedWindowEvents: number;
    useRate: UsageMatureRate;
    adoptionRate: UsageMatureRate;
    cost: {
        bookedAmount: string | null;
        settledTasks: number;
        missingSettlementTasks: number;
        state: UsageV2MetricState;
        perRecordedUsedResult: string | null;
        perUsedState: UsageV2MetricState;
    };
};
export type UsageMaturePeriod = {
    from: string;
    to: string;
    cohort: {
        successfulImageTasks: number;
        matureTasks: number;
        immatureTasks: number;
        missingCompletedAtTasks: number;
        invalidTimelineTasks: number;
    };
    all: UsageMatureSummary;
    optimizationGroups: {
        key: "explicit_link" | "no_explicit_marker";
        summary: UsageMatureSummary;
    }[];
};
export type UsageMatureResults = {
    meta: {
        metricVersion: typeof USAGE_MATURE_RESULTS_VERSION;
        scope: UsageV2Scope;
        comparisonScope: UsageV2Scope | null;
        asOf: string;
        observationHours: 168;
        dataMode: "live_existing_result_events";
        notes: string[];
    };
    current: UsageMaturePeriod;
    comparison: UsageMaturePeriod | null;
};
