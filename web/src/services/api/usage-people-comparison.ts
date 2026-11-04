import { USAGE_PEOPLE_COMPARISON_API, USAGE_PEOPLE_COMPARISON_KEYS, type UsagePeopleComparison, type UsagePeopleComparisonRequest } from "../../../../shared/usage-people-comparison";
import type { UsageV2Metric, UsageV2Query, UsageV2Scope } from "../../../../shared/usage-analytics-v2";
import { UsageAnalyticsError } from "./usage-analytics";
export * from "../../../../shared/usage-people-comparison";

const sameSet = (a: string[] = [], b: string[] = []) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && new Set(a).size === a.length && a.every(id => b.includes(id));
export function samePeopleTeamScope(actual: UsageV2Scope | undefined, query: UsageV2Query): boolean {
    return Boolean(actual && actual.timezone === "Asia/Shanghai" && Date.parse(actual.from) === Date.parse(query.from || "") && Date.parse(actual.to) === Date.parse(query.to || "") &&
        actual.compare === (query.compare ?? "previous_period") && actual.departmentBasis === (query.departmentBasis ?? "at_event") && (actual.search || "") === (query.search?.trim() || "") &&
        (["departmentIds", "userIds", "boardKeys", "modelConfigIds", "operationTypes"] as const).every(key => sameSet(actual[key], query[key])));
}
function validMetric(value: unknown): value is UsageV2Metric {
    if (!value || typeof value !== "object") return false;
    const metric = value as UsageV2Metric;
    return (metric.value === null || (typeof metric.value === "number" && Number.isFinite(metric.value) && metric.value >= 0)) &&
        ["count", "ratio", "ms", "seconds", "CNY"].includes(metric.unit) && ["available", "partial", "unavailable"].includes(metric.state) &&
        Number.isSafeInteger(metric.availableCount) && metric.availableCount >= 0 && Number.isSafeInteger(metric.missingCount) && metric.missingCount >= 0 &&
        typeof metric.definition === "string" && typeof metric.definitionId === "string" && typeof metric.source === "string" &&
        (metric.state !== "available" || (metric.value !== null && metric.missingCount === 0)) &&
        (metric.amount === undefined || /^\d{1,30}\.\d{6}$/.test(metric.amount));
}
export function validPeopleComparison(value: unknown, query: UsageV2Query, selectedUserIds: string[]): value is UsagePeopleComparison {
    if (!value || typeof value !== "object") return false;
    const result = value as UsagePeopleComparison, team = result.team;
    const metricsValid = (metrics: UsagePeopleComparison["team"]["metrics"]) => metrics && ([...USAGE_PEOPLE_COMPARISON_KEYS, "activePeople"] as const).every(key => validMetric(metrics[key]));
    if (!samePeopleTeamScope(result.meta?.scope, query) || !Number.isFinite(Date.parse(result.meta?.asOf)) || !sameSet(result.selectedUserIds, selectedUserIds) ||
        !Array.isArray(result.people) || !sameSet(result.people.map(person => person.userId), selectedUserIds) ||
        !result.people.every(person => typeof person.displayName === "string" && metricsValid(person.metrics)) ||
        !team || !metricsValid(team.metrics) || !Number.isSafeInteger(team.rosterPeople) || team.rosterPeople < selectedUserIds.length ||
        !Number.isSafeInteger(team.metrics.activePeople.value) || team.metrics.activePeople.value! < 0 || team.metrics.activePeople.value! > team.rosterPeople ||
        typeof team.populationDefinition !== "string" || !team.populationDefinition ||
        !validMetric(team.perActivePersonBookedCny) || !validMetric(team.perRosterPersonBookedCny) ||
        team.perActivePersonBookedCny.denominator !== team.metrics.activePeople.value || team.perRosterPersonBookedCny.denominator !== team.rosterPeople) return false;
    const cost = team.metrics.generationBookedCny;
    return [team.perActivePersonBookedCny, team.perRosterPersonBookedCny].every(metric => metric.unit === "CNY" && metric.basis === "booked" &&
        (cost.state !== "partial" || metric.state !== "available") && (cost.state !== "unavailable" || metric.state === "unavailable") &&
        (metric.denominator !== 0 || (metric.value === null && metric.state === "unavailable")));
}

export async function getPeopleTeamComparison(query: UsageV2Query, selectedUserIds: string[], signal?: AbortSignal): Promise<UsagePeopleComparison> {
    if (!query.from || !query.to || selectedUserIds.length < 2 || selectedUserIds.length > 5 || new Set(selectedUserIds).size !== selectedUserIds.length ||
        selectedUserIds.some(id => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || (query.userIds?.length && !query.userIds.includes(id))))
        throw new UsageAnalyticsError("请选择原共享筛选内 2–5 位不同员工，并指定日期。", "INVALID_COMPARISON");
    const filters: UsagePeopleComparisonRequest["filters"] = { ...query, from: query.from, to: query.to };
    // The dashboard represents cleared dimensions as []; the existing GET
    // serializer omits those fields, and the strict server schema rejects [].
    for (const key of ["departmentIds", "userIds", "boardKeys", "modelConfigIds", "operationTypes"] as const)
        if (filters[key]?.length === 0) delete filters[key];
    if (!filters.search?.trim()) delete filters.search;
    const body: UsagePeopleComparisonRequest = { filters, selectedUserIds: [...selectedUserIds] };
    try {
        const response = await fetch(USAGE_PEOPLE_COMPARISON_API, { method: "POST", credentials: "include", cache: "no-store", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (!response.ok) {
            const error = await response.json().catch(() => null) as { code?: unknown } | null;
            const outOfScope = error?.code === "USAGE_COMPARISON_OUT_OF_SCOPE", refresh = error?.code === "USAGE_ROLLUP_REFRESH_REQUIRED";
            throw new UsageAnalyticsError(outOfScope ? "部分所选员工不在原共享范围名册中；未扩大范围或显示不完整对照。请刷新列表后重新选择。" : refresh ? "团队范围历史待回填或补算；请明确刷新原筛选日期，完成后重新读取对照。" : response.status === 403 ? "仅超级管理员可查看人员对照。" : response.status === 422 ? "原团队范围超过读取预算；请缩小共享筛选，未偷偷缩为所选人员。" : "人员团队对照暂不可用，请手动重试。", outOfScope ? "USAGE_COMPARISON_OUT_OF_SCOPE" : refresh ? "USAGE_ROLLUP_REFRESH_REQUIRED" : "COMPARISON_FAILED", response.status);
        }
        const envelope = await response.json();
        signal?.throwIfAborted();
        if (envelope.code !== 0 || !validPeopleComparison(envelope.data, query, selectedUserIds))
            throw new UsageAnalyticsError("团队范围、所选人员或分母不一致，未显示不完整对照。", "INVALID_COMPARISON_RESPONSE");
        return { ...envelope.data, people: selectedUserIds.map(id => envelope.data.people.find((person: UsagePeopleComparison["people"][number]) => person.userId === id)!) };
    } catch (error) {
        if (error instanceof UsageAnalyticsError || (error instanceof Error && error.name === "AbortError")) throw error;
        throw new UsageAnalyticsError("网络或响应格式异常，未显示人员团队对照，请手动重试。", "COMPARISON_FAILED");
    }
}
