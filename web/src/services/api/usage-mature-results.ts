import type { UsageV2Scope } from "../../../../shared/usage-analytics-v2";
import {
    USAGE_MATURE_RESULTS_API,
    USAGE_MATURE_RESULTS_VERSION,
    type UsageMatureResults,
    type UsageMatureSummary,
} from "../../../../shared/usage-mature-results";
import { usageV2ReportAnonymousScope, usageV2ReportComparisonScope } from "../../../../shared/usage-report-v2";
import { UsageAnalyticsError } from "./usage-analytics";
import { usageV2QueryString } from "./usage-analytics-v2";
export * from "../../../../shared/usage-mature-results";

function fields(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
): value is Record<string, any> {
    return (
        !!value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        required.every((key) => Object.hasOwn(value, key)) &&
        Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
    );
}
const count = (value: unknown, maximum = 100_000): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const date = (value: unknown): value is string =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
const sameDate = (actual: unknown, expected: string) => date(actual) && Date.parse(actual) === Date.parse(expected);
const scopeArrays = ["departmentIds", "userIds", "boardKeys", "modelConfigIds", "operationTypes"] as const;
function validScope(value: unknown): value is UsageV2Scope {
    return (
        fields(value, ["from", "to", "timezone", "compare", "departmentBasis"], [...scopeArrays, "search"]) &&
        date(value.from) &&
        date(value.to) &&
        Date.parse(value.to) > Date.parse(value.from) &&
        value.timezone === "Asia/Shanghai" &&
        ["none", "previous_period", "previous_year"].includes(value.compare) &&
        ["at_event", "current"].includes(value.departmentBasis) &&
        (value.search === undefined ||
            (typeof value.search === "string" && value.search.length <= 100 && value.search === value.search.trim())) &&
        scopeArrays.every(
            (key) =>
                value[key] === undefined ||
                (Array.isArray(value[key]) &&
                    value[key].length <= 500 &&
                    new Set(value[key]).size === value[key].length &&
                    value[key].every(
                        (item: unknown) =>
                            typeof item === "string" &&
                            (["departmentIds", "userIds", "modelConfigIds"].includes(key)
                                ? /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item)
                                : /^[a-z][a-z0-9_-]{0,99}$/.test(item)),
                    )),
        )
    );
}
function sameScope(actual: unknown, expected: UsageV2Scope): boolean {
    return (
        validScope(actual) &&
        sameDate(actual.from, expected.from) &&
        sameDate(actual.to, expected.to) &&
        actual.timezone === expected.timezone &&
        actual.compare === expected.compare &&
        actual.departmentBasis === expected.departmentBasis &&
        (actual.search ?? "") === (expected.search ?? "") &&
        scopeArrays.every(
            (key) =>
                (actual[key]?.length ?? 0) === (expected[key]?.length ?? 0) &&
                (actual[key] ?? []).every((item) => expected[key]?.includes(item)),
        )
    );
}
const summaryCounts = [
    "tasks",
    "outputKnownTasks",
    "missingOutputTasks",
    "generatedResults",
    "linkedResults",
    "unknownBindingResults",
    "usedResults",
    "formallyAdoptedResults",
    "linkedNoEvidenceResults",
    "clientReportedUsedResults",
    "serverConfirmedUsedResults",
    "beforeCompletionEvents",
    "windowEvents",
    "reversedWindowEvents",
] as const;
const money = (value: unknown): value is string =>
    typeof value === "string" && /^(?:0|[1-9]\d{0,29})\.\d{6}$/.test(value);
const micros = (value: string) => BigInt(value.replace(".", ""));
function summary(value: unknown): value is UsageMatureSummary {
    if (
        !fields(value, [...summaryCounts, "useRate", "adoptionRate", "cost"]) ||
        !summaryCounts.every((key) => count(value[key])) ||
        value.tasks > 50_000 ||
        value.outputKnownTasks + value.missingOutputTasks !== value.tasks ||
        value.generatedResults < value.outputKnownTasks ||
        (value.outputKnownTasks === 0 && value.generatedResults !== 0) ||
        value.linkedResults + value.unknownBindingResults !== value.generatedResults ||
        value.usedResults + value.linkedNoEvidenceResults !== value.linkedResults ||
        value.formallyAdoptedResults > value.usedResults ||
        value.formallyAdoptedResults > value.serverConfirmedUsedResults ||
        value.clientReportedUsedResults > value.usedResults ||
        value.serverConfirmedUsedResults > value.usedResults ||
        value.clientReportedUsedResults + value.serverConfirmedUsedResults < value.usedResults ||
        value.reversedWindowEvents > value.windowEvents ||
        value.usedResults > value.windowEvents - value.reversedWindowEvents ||
        (value.tasks === 0 && summaryCounts.some((key) => value[key] !== 0))
    )
        return false;
    const rateState =
        !value.generatedResults || !value.linkedResults
            ? "unavailable"
            : value.missingOutputTasks || value.unknownBindingResults
              ? "partial"
              : "available";
    for (const [key, numerator] of [
        ["useRate", value.usedResults],
        ["adoptionRate", value.formallyAdoptedResults],
    ] as const) {
        const rate = value[key];
        if (
            !fields(rate, ["value", "state"]) ||
            rate.state !== rateState ||
            (rateState === "unavailable"
                ? rate.value !== null
                : typeof rate.value !== "number" ||
                  !Number.isFinite(rate.value) ||
                  Math.abs(rate.value - numerator / value.generatedResults) > 1e-12)
        )
            return false;
    }
    const cost = value.cost;
    if (
        !fields(cost, [
            "bookedAmount",
            "settledTasks",
            "missingSettlementTasks",
            "state",
            "perRecordedUsedResult",
            "perUsedState",
        ]) ||
        !count(cost.settledTasks, 50_000) ||
        !count(cost.missingSettlementTasks, 50_000) ||
        cost.settledTasks + cost.missingSettlementTasks !== value.tasks ||
        cost.state !== (!cost.settledTasks ? "unavailable" : cost.missingSettlementTasks ? "partial" : "available") ||
        (!cost.settledTasks ? cost.bookedAmount !== null : !money(cost.bookedAmount))
    )
        return false;
    if (!value.usedResults || !cost.settledTasks)
        return cost.perRecordedUsedResult === null && cost.perUsedState === "unavailable";
    return (
        money(cost.perRecordedUsedResult) &&
        cost.perUsedState === (cost.state === "partial" || rateState !== "available" ? "partial" : "available") &&
        micros(cost.perRecordedUsedResult) ===
            (micros(cost.bookedAmount) + BigInt(Math.floor(value.usedResults / 2))) / BigInt(value.usedResults)
    );
}
function period(value: unknown, scope: UsageV2Scope): boolean {
    const cohortKeys = [
        "successfulImageTasks",
        "matureTasks",
        "immatureTasks",
        "missingCompletedAtTasks",
        "invalidTimelineTasks",
    ];
    if (
        !fields(value, ["from", "to", "cohort", "all", "optimizationGroups"]) ||
        !sameDate(value.from, scope.from) ||
        !sameDate(value.to, scope.to) ||
        !fields(value.cohort, cohortKeys) ||
        !cohortKeys.every((key) => count(value.cohort[key], 50_000)) ||
        value.cohort.successfulImageTasks !==
            value.cohort.matureTasks +
                value.cohort.immatureTasks +
                value.cohort.missingCompletedAtTasks +
                value.cohort.invalidTimelineTasks ||
        !summary(value.all) ||
        value.all.tasks !== value.cohort.matureTasks ||
        !Array.isArray(value.optimizationGroups) ||
        value.optimizationGroups.length !== 2 ||
        !value.optimizationGroups.every(
            (group) =>
                fields(group, ["key", "summary"]) &&
                ["explicit_link", "no_explicit_marker"].includes(group.key) &&
                summary(group.summary),
        ) ||
        new Set(value.optimizationGroups.map((group) => group.key)).size !== 2
    )
        return false;
    const [left, right] = value.optimizationGroups.map((group) => group.summary as UsageMatureSummary);
    return (
        summaryCounts.every((key) => value.all[key] === left[key] + right[key]) &&
        value.all.cost.settledTasks === left.cost.settledTasks + right.cost.settledTasks &&
        value.all.cost.missingSettlementTasks ===
            left.cost.missingSettlementTasks + right.cost.missingSettlementTasks &&
        (value.all.cost.bookedAmount === null ||
            micros(value.all.cost.bookedAmount) ===
                micros(left.cost.bookedAmount ?? "0.000000") + micros(right.cost.bookedAmount ?? "0.000000"))
    );
}
function validResults(value: unknown, scope: UsageV2Scope): value is UsageMatureResults {
    const dates = usageV2ReportComparisonScope(usageV2ReportAnonymousScope(scope));
    const comparisonScope: UsageV2Scope | null = dates
        ? { ...scope, from: dates.from, to: dates.to, compare: "none" }
        : null;
    return (
        fields(value, ["meta", "current", "comparison"]) &&
        fields(value.meta, [
            "metricVersion",
            "scope",
            "comparisonScope",
            "asOf",
            "observationHours",
            "dataMode",
            "notes",
        ]) &&
        value.meta.metricVersion === USAGE_MATURE_RESULTS_VERSION &&
        value.meta.observationHours === 168 &&
        value.meta.dataMode === "live_existing_result_events" &&
        sameScope(value.meta.scope, scope) &&
        date(value.meta.asOf) &&
        Array.isArray(value.meta.notes) &&
        value.meta.notes.length <= 20 &&
        value.meta.notes.every((note: unknown) => typeof note === "string" && note.length <= 2000) &&
        period(value.current, scope) &&
        (comparisonScope
            ? sameScope(value.meta.comparisonScope, comparisonScope) && period(value.comparison, comparisonScope)
            : value.meta.comparisonScope === null && value.comparison === null)
    );
}

/** Explicit same-scope read. Never invoke a model, write rollups or reopen the global comparison deltas. */
export async function getUsageMatureResults(scope: UsageV2Scope, signal?: AbortSignal): Promise<UsageMatureResults> {
    // The request is capped at 366 days. Its exact previous-year comparison can
    // span 367 days across a leap year; sameScope still verifies those derived dates.
    if (!validScope(scope) || Date.parse(scope.to) - Date.parse(scope.from) > 366 * 86_400_000)
        throw new UsageAnalyticsError("成熟窗筛选范围无效，未发出请求或清空筛选。", "INVALID_MATURE_SCOPE");
    const expected = structuredClone(scope);
    try {
        signal?.throwIfAborted();
        const response = await fetch(`${USAGE_MATURE_RESULTS_API}${usageV2QueryString(expected)}`, {
            credentials: "include",
            cache: "no-store",
            redirect: "error",
            signal,
        });
        if (!response.ok)
            throw new UsageAnalyticsError(
                response.status === 401 || response.status === 403
                    ? "仅当前已登录的超级管理员可读取成熟结果窗。"
                    : response.status === 400
                      ? "成熟窗筛选范围无效；请检查已应用的日期与维度，未清空筛选。"
                      : response.status === 422
                        ? "当前成熟窗超过安全读取上限，请缩短日期或增加筛选；未截断或补零。"
                        : response.status === 404
                          ? "当前服务尚未提供 7 日成熟结果窗。"
                          : "成熟结果窗读取未完成，请明确重读；未调用模型、新增采集或触发重算。",
                "USAGE_MATURE_REQUEST_FAILED",
                response.status,
            );
        const envelope = await response.json();
        signal?.throwIfAborted();
        if (envelope?.code !== 0 || !validResults(envelope.data, expected))
            throw new UsageAnalyticsError(
                "成熟窗响应不完整，或与本次范围、分母、分组和费用口径不一致，未显示。",
                "INVALID_MATURE_RESPONSE",
            );
        return envelope.data;
    } catch (error) {
        if (error instanceof UsageAnalyticsError || (error instanceof Error && error.name === "AbortError"))
            throw error;
        throw new UsageAnalyticsError("成熟窗连接或响应格式异常；未自动重试。", "USAGE_MATURE_RESPONSE_FAILED");
    }
}
