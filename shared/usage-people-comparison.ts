import type { UsageV2Meta, UsageV2Metric, UsageV2Metrics, UsageV2Person, UsageV2Query } from "./usage-analytics-v2";

/** Read-only comparison; selection never replaces or expands the original team scope. */
export const USAGE_PEOPLE_COMPARISON_API = "/api/admin/usage/people-compare";
export const USAGE_PEOPLE_COMPARISON_KEYS = ["activeDays", "generationRequests", "generatedImages", "generationBookedCny", "successRate", "resultUseRate", "formalAdoptionRate", "costPerUsedImage", "totalMsP50", "totalMsP90", "waitMsP50"] as const;
export type UsagePeopleComparisonRequest = {
    filters: UsageV2Query & { from: string; to: string };
    selectedUserIds: string[];
};
export type UsagePeopleTeamBaseline = {
    metrics: UsageV2Metrics;
    rosterPeople: number;
    perActivePersonBookedCny: UsageV2Metric;
    perRosterPersonBookedCny: UsageV2Metric;
    populationDefinition: string;
};
export type UsagePeopleComparison = {
    meta: UsageV2Meta;
    selectedUserIds: string[];
    people: UsageV2Person[];
    team: UsagePeopleTeamBaseline;
};
