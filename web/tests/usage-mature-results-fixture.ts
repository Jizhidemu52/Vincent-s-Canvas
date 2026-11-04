import {
    USAGE_MATURE_RESULTS_VERSION,
    type UsageMatureResults,
    type UsageMatureSummary,
} from "../../shared/usage-mature-results";
import type { UsageV2Scope } from "../../shared/usage-analytics-v2";

export const maturePerson = "00000000-0000-4000-8000-000000000001";
export const matureDepartment = "00000000-0000-4000-8000-000000000002";
export const matureModel = "00000000-0000-4000-8000-000000000003";
export const matureScope: UsageV2Scope = {
    from: "2026-10-01T16:00:00.000Z",
    to: "2026-10-08T16:00:00.000Z",
    timezone: "Asia/Shanghai",
    compare: "previous_period",
    departmentBasis: "at_event",
};
export const emptyMatureSummary = (): UsageMatureSummary => ({
    tasks: 0,
    outputKnownTasks: 0,
    missingOutputTasks: 0,
    generatedResults: 0,
    linkedResults: 0,
    unknownBindingResults: 0,
    usedResults: 0,
    formallyAdoptedResults: 0,
    linkedNoEvidenceResults: 0,
    clientReportedUsedResults: 0,
    serverConfirmedUsedResults: 0,
    beforeCompletionEvents: 0,
    windowEvents: 0,
    reversedWindowEvents: 0,
    useRate: { value: null, state: "unavailable" },
    adoptionRate: { value: null, state: "unavailable" },
    cost: {
        bookedAmount: null,
        settledTasks: 0,
        missingSettlementTasks: 0,
        state: "unavailable",
        perRecordedUsedResult: null,
        perUsedState: "unavailable",
    },
});
export function matureFixture(scope: UsageV2Scope = matureScope): UsageMatureResults {
    const explicit: UsageMatureSummary = {
        tasks: 3,
        outputKnownTasks: 3,
        missingOutputTasks: 0,
        generatedResults: 4,
        linkedResults: 4,
        unknownBindingResults: 0,
        usedResults: 3,
        formallyAdoptedResults: 1,
        linkedNoEvidenceResults: 1,
        clientReportedUsedResults: 2,
        serverConfirmedUsedResults: 2,
        beforeCompletionEvents: 1,
        windowEvents: 5,
        reversedWindowEvents: 1,
        useRate: { value: 0.75, state: "available" },
        adoptionRate: { value: 0.25, state: "available" },
        cost: {
            bookedAmount: "2.000001",
            settledTasks: 3,
            missingSettlementTasks: 0,
            state: "available",
            perRecordedUsedResult: "0.666667",
            perUsedState: "available",
        },
    };
    const unmarked: UsageMatureSummary = {
        tasks: 4,
        outputKnownTasks: 3,
        missingOutputTasks: 1,
        generatedResults: 6,
        linkedResults: 2,
        unknownBindingResults: 4,
        usedResults: 1,
        formallyAdoptedResults: 1,
        linkedNoEvidenceResults: 1,
        clientReportedUsedResults: 0,
        serverConfirmedUsedResults: 1,
        beforeCompletionEvents: 2,
        windowEvents: 3,
        reversedWindowEvents: 1,
        useRate: { value: 1 / 6, state: "partial" },
        adoptionRate: { value: 1 / 6, state: "partial" },
        cost: {
            bookedAmount: "1.000000",
            settledTasks: 3,
            missingSettlementTasks: 1,
            state: "partial",
            perRecordedUsedResult: "1.000000",
            perUsedState: "partial",
        },
    };
    const all: UsageMatureSummary = {
        tasks: 7,
        outputKnownTasks: 6,
        missingOutputTasks: 1,
        generatedResults: 10,
        linkedResults: 6,
        unknownBindingResults: 4,
        usedResults: 4,
        formallyAdoptedResults: 2,
        linkedNoEvidenceResults: 2,
        clientReportedUsedResults: 2,
        serverConfirmedUsedResults: 3,
        beforeCompletionEvents: 3,
        windowEvents: 8,
        reversedWindowEvents: 2,
        useRate: { value: 0.4, state: "partial" },
        adoptionRate: { value: 0.2, state: "partial" },
        cost: {
            bookedAmount: "3.000001",
            settledTasks: 6,
            missingSettlementTasks: 1,
            state: "partial",
            perRecordedUsedResult: "0.750000",
            perUsedState: "partial",
        },
    };
    const prior: UsageMatureSummary = {
        ...emptyMatureSummary(),
        tasks: 2,
        outputKnownTasks: 2,
        generatedResults: 2,
        linkedResults: 2,
        linkedNoEvidenceResults: 2,
        useRate: { value: 0, state: "available" },
        adoptionRate: { value: 0, state: "available" },
        cost: {
            bookedAmount: "0.000000",
            settledTasks: 2,
            missingSettlementTasks: 0,
            state: "available",
            perRecordedUsedResult: null,
            perUsedState: "unavailable",
        },
    };
    const comparisonScope: UsageV2Scope | null =
        scope.compare === "none"
            ? null
            : {
                  ...scope,
                  compare: "none",
                  from: new Date(2 * Date.parse(scope.from) - Date.parse(scope.to)).toISOString(),
                  to: scope.from,
              };
    return {
        meta: {
            metricVersion: USAGE_MATURE_RESULTS_VERSION,
            scope: structuredClone(scope),
            comparisonScope,
            asOf: "2026-11-05T01:00:00.000Z",
            observationHours: 168,
            dataMode: "live_existing_result_events",
            notes: ["隔离合成成熟窗：只有既有任务与有效资产事件聚合，不读取提示词或媒体。"],
        },
        current: {
            from: scope.from,
            to: scope.to,
            cohort: {
                successfulImageTasks: 10,
                matureTasks: 7,
                immatureTasks: 1,
                missingCompletedAtTasks: 1,
                invalidTimelineTasks: 1,
            },
            all,
            optimizationGroups: [
                { key: "explicit_link", summary: explicit },
                { key: "no_explicit_marker", summary: unmarked },
            ],
        },
        comparison: comparisonScope
            ? {
                  from: comparisonScope.from,
                  to: comparisonScope.to,
                  cohort: {
                      successfulImageTasks: 2,
                      matureTasks: 2,
                      immatureTasks: 0,
                      missingCompletedAtTasks: 0,
                      invalidTimelineTasks: 0,
                  },
                  all: prior,
                  optimizationGroups: [
                      { key: "explicit_link", summary: emptyMatureSummary() },
                      { key: "no_explicit_marker", summary: structuredClone(prior) },
                  ],
              }
            : null,
    };
}
