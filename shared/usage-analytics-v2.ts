/** Formal-service read-only analytics. All dates are [from,to), grouped in Beijing time.
 * This contract does not change v1 event collection, exports, or paid AI confirmation. */
import type { UsageControlDaily, UsageReleaseContext } from "./usage-release-context";
export const USAGE_V2_API = {
  options: "/api/admin/usage/options",
  overview: "/api/admin/usage/overview",
  people: "/api/admin/usage/people-v2",
  profile: (id: string) =>
    `/api/admin/usage/people/${encodeURIComponent(id)}/profile`,
  boards: "/api/admin/usage/boards",
  board: (key: string) => `/api/admin/usage/boards/${encodeURIComponent(key)}`,
  models: "/api/admin/usage/models",
  quality: "/api/admin/usage/quality",
  flows: "/api/admin/usage/flows",
  recompute: "/api/admin/usage/rollups/recompute",
  rollupJob: (id: string) => `/api/admin/usage/rollups/jobs/${encodeURIComponent(id)}`,
  report: "/api/admin/usage/report-v2",
} as const;
export const USAGE_V2_PEOPLE_SORTS = [
  "lastActivity",
  "activeDays",
  "generatedImages",
  "generationRequests",
  "generationBookedCny",
  "successRate",
  "resultUseRate",
] as const;
export type UsageV2PeopleSort = (typeof USAGE_V2_PEOPLE_SORTS)[number];
/** Query arrays are comma-separated UUIDs / keys; empty or unknown filters are rejected. */
export type UsageV2Scope = {
  from: string;
  to: string;
  timezone: "Asia/Shanghai";
  compare: "none" | "previous_period" | "previous_year";
  departmentBasis: "at_event" | "current";
  departmentIds?: string[];
  userIds?: string[];
  boardKeys?: string[];
  modelConfigIds?: string[];
  operationTypes?: string[];
  search?: string;
};
export type UsageV2Query = Partial<Omit<UsageV2Scope, "timezone">> & {
  page?: number;
  pageSize?: number;
  sort?: UsageV2PeopleSort;
  order?: "asc" | "desc";
};
export type UsageV2MetricState = "available" | "partial" | "unavailable";
export type UsageV2Metric = {
  value: number | null;
  unit: "count" | "ratio" | "ms" | "seconds" | "CNY";
  state: UsageV2MetricState;
  availableCount: number;
  missingCount: number;
  definitionId: string;
  definition: string;
  source: string;
  numerator?: number;
  denominator?: number;
  /** Decimal string for booked monetary totals; chart value is not a financial reconciliation API. */
  amount?: string;
  currency?: "CNY";
  basis?: "booked";
  comparison?: {
    value: number | null;
    absoluteDelta: number | null;
    relativeDelta: number | null;
    reason?: "zero_baseline" | "insufficient_data";
    unit: "absolute" | "percentage_points";
  };
};
export type UsageV2MetricKey =
  | "activePeople"
  | "activeDays"
  | "generationRequests"
  | "chatRequests"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "paused"
  | "interrupted"
  | "uncertain"
  | "pending"
  | "generatedImages"
  | "visits"
  | "interactions"
  | "successRate"
  | "generationBookedCny"
  | "imageBookedCny"
  | "costPerImage"
  | "resultUseRate"
  | "formalAdoptionRate"
  | "costPerUsedImage"
  | "waitMsP50"
  | "runMsP50"
  | "totalMsP50"
  | "totalMsP90"
  | "activeSeconds"
  | "revisionRounds";
export type UsageV2Metrics = Record<UsageV2MetricKey, UsageV2Metric>;
export type UsageV2Coverage = {
  metric: string;
  state: UsageV2MetricState;
  since: string | null;
  eligible: number;
  matched: number;
  unknown: number;
  notes: string[];
};
export type UsageV2Meta = {
  schemaVersion: 2;
  metricVersion: string;
  scope: UsageV2Scope;
  comparisonScope: UsageV2Scope | null;
  asOf: string;
  computedThrough: string;
  provisional: true;
  dataMode: "live_existing_facts" | "persisted_daily_facts" | "daily_history_live_today";
  /** Transaction-derived Beijing midnight; snapshot describes historical days only. */
  liveFrom?: string;
  lagSeconds?: number;
  snapshot?: {
    oldestComputedAt: string;
    newestComputedAt: string;
    dayCount: number;
    mixedSnapshots: boolean;
  };
  coverage: UsageV2Coverage[];
  notes: string[];
};
export type UsageRollupRequest = { fromDay: string; toDay: string; idempotencyKey: string };
export type UsageRollupJob = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  fromDay: string;
  toDay: string;
  completedDays: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  failureCode: string | null;
};
export type UsageV2Dimension = {
  key: string;
  label: string;
  metrics: UsageV2Metrics;
};
export type UsageV2Daily = { day: string; metrics: UsageV2Metrics };
export type UsageV2Heatmap = { weekday: number; hour: number; count: number }; // Monday=0; recorded actions, not duration
export type UsageV2Insight = {
  ruleId: string;
  severity: "info" | "warning";
  text: string;
  sampleCount: number;
  evidence: Record<string, number | string | null>;
  drilldownFilter: Partial<UsageV2Scope>;
};
export type UsageV2Overview = {
  meta: UsageV2Meta;
  metrics: UsageV2Metrics;
  daily: UsageV2Daily[];
  comparisonDaily: UsageV2Daily[];
  hourlyHeatmap: UsageV2Heatmap[];
  departments: UsageV2Dimension[];
  insights: UsageV2Insight[];
  releaseContext?: UsageReleaseContext;
  controlDaily?: UsageControlDaily;
};
export type UsageV2Person = {
  userId: string;
  displayName: string;
  departmentId: string | null;
  departmentName: string | null;
  metrics: UsageV2Metrics;
  lastActivityAt: string | null;
  topBoards: Array<{ key: string; label: string; count: number }>;
  topModels: Array<{ key: string; label: string; count: number }>;
};
export type UsageV2People = {
  meta: UsageV2Meta;
  people: UsageV2Person[];
  pagination: { page: number; pageSize: number; total: number };
  metrics: UsageV2Metrics;
};
export type UsageV2Activity = {
  id: string;
  kind: "event" | "task" | "chat";
  occurredAt: string;
  boardKey: string | null;
  action: string;
  modelConfigId: string | null;
  status: string;
  generatedImages: number;
  bookedCny: string | null;
  totalMs: number | null;
};
/** Metadata-only timeline. Private prompts/media remain behind the existing explicit detail flow. */
export type UsageV2Profile = {
  meta: UsageV2Meta;
  person: UsageV2Person;
  metrics: UsageV2Metrics;
  daily: UsageV2Daily[];
  hourlyHeatmap: UsageV2Heatmap[];
  boards: UsageV2Dimension[];
  models: UsageV2Dimension[];
  habits: {
    rates: Array<{
      key: "batchLinked" | "optimizedMarked" | "inpaint";
      label: string;
      eligible: number;
      matched: number;
      missing: number;
      rate: UsageV2Metric;
    }>;
    referenceCounts: {
      eligible: number;
      missing: number;
      items: Array<{ value: number; count: number; rate: UsageV2Metric }>;
    };
    parameters: UsageV2Parameter[];
    notes: string[];
  };
  activityPage: {
    records: UsageV2Activity[];
    pagination: { page: number; pageSize: number; total: number };
  };
};
export type UsageV2Parameter = {
  boardKey: string;
  boardLabel: string;
  parameter: string;
  value: string | null;
  count: number;
  eligible: number;
  missing: number;
  /** Option share among valid recorded values for this board and parameter. */
  rate: UsageV2Metric;
};
export type UsageV2Boards = {
  meta: UsageV2Meta;
  boards: UsageV2Dimension[];
  parameters: UsageV2Parameter[];
  controlUsage: Array<{
    boardKey: string;
    controlKey: string;
    label: string;
    users: number;
    eligibleUsers: number;
    rate: UsageV2Metric;
  }>;
  conversion: UsageV2Metric;
  abandonment: UsageV2Metric;
  insights: UsageV2Insight[];
};
export type UsageV2Model = UsageV2Dimension & {
  modelConfigId: string | null;
  operationType: string;
  boardKey: string | null;
  latency: UsageV2LatencyDistribution;
  failures: Array<{ category: string; label: string; count: number }>;
};
export type UsageV2LatencyDistribution = {
  eligible: number;
  available: number;
  missing: number;
  unit: "ms";
  method: "full_sample_linear_interpolation";
  min: number | null;
  q1: number | null;
  median: number | null;
  q3: number | null;
  max: number | null;
  notes: string[];
};
export type UsageV2OptimizationCosts = {
  executions: number;
  cacheHits: number;
  uncertain: number;
  inputTokens: UsageV2Metric;
  outputTokens: UsageV2Metric;
  costs: Array<{
    currency: string;
    providerReportedAmount: string;
    estimatedAmount: string;
    knownCount: number;
    estimatedCount: number;
    unknownCount: number;
  }>;
  notes: string[];
};
export type UsageV2Models = {
  meta: UsageV2Meta;
  models: UsageV2Model[];
  costBreakdown: {
    departments: UsageV2Dimension[];
    people: UsageV2Dimension[];
    boards: UsageV2Dimension[];
    operations: UsageV2Dimension[];
    models: UsageV2Dimension[];
  };
  optimizationCosts: UsageV2OptimizationCosts;
  budget: UsageV2Metric;
  insights: UsageV2Insight[];
};
export type UsageV2Failure = {
  category: string;
  label: string;
  count: number;
  modelConfigId: string | null;
  boardKey: string | null;
  operationType: string;
};
export type UsageV2Stage = {
  key: string;
  label: string;
  count: number;
  evidence: "server_confirmed" | "client_reported" | "mixed";
};
export type UsageV2ResultUse = {
  basis: "submitted_cohort_as_of";
  asOf: string;
  ruleVersion: string;
  generatedImages: number;
  linkedImages: number;
  unlinkedImages: number;
  usedImages: number;
  formallyAdoptedImages: number;
  stages: UsageV2Stage[];
  notes: string[];
};
export type UsageV2Quality = {
  meta: UsageV2Meta;
  metrics: UsageV2Metrics;
  failureRuleVersion: string;
  failures: UsageV2Failure[];
  retries: Array<{ attempts: number; tasks: number }>;
  resultUse: UsageV2ResultUse;
  lineage: UsageV2Metric;
  optimizationComparison: Array<{
    modelConfigId: string | null;
    boardKey: string | null;
    operationType: string;
    optimized: boolean;
    metrics: UsageV2Metrics;
  }>;
  insights: UsageV2Insight[];
};
/** Empty linked paths are not inferred from nearby timestamps; stage coverage is not an ordered funnel. */
export type UsageV2Flows = {
  meta: UsageV2Meta;
  nodes: Array<{ key: string; label: string }>;
  links: Array<{ source: string; target: string; count: number }>;
  paths: Array<{ steps: string[]; count: number }>;
  funnels: Array<{
    key: string;
    label: string;
    mode: "stage_coverage";
    stages: UsageV2Stage[];
  }>;
  transfers: Array<{ source: string; target: string; count: number }>;
  pathCoverage: UsageV2Metric;
  resultUse: UsageV2ResultUse;
  insights: UsageV2Insight[];
};
export type UsageV2Options = {
  departments: Array<{ id: string; name: string }>;
  people: Array<{ id: string; name: string; departmentId: string | null }>;
  boards: Array<{ key: string; label: string }>;
  models: Array<{ id: string; name: string }>;
  operationTypes: string[];
  peoplePagination: { page: number; pageSize: number; total: number };
  notes: string[];
};
