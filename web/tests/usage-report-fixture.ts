import { buildUsageV2Report, type UsageV2ReportInput } from "../../server/src/usage-report-v2";
import type { UsageV2ReportRequest, UsageV2ReportResult } from "../../shared/usage-report-v2";
import { fixture } from "./usage-v2-browser/fixture";

/** Real free adapter over synthetic values; never opens a database or calls a provider. */
export function reportFixture(input: UsageV2ReportRequest): UsageV2ReportResult {
    const url = new URL(`http://127.0.0.1/api/admin/usage/${input.page === "people" ? "people-v2" : input.page}`);
    for (const [key, value] of Object.entries(input.filters))
        if (value !== undefined) url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
    const data = fixture(url) as any;
    data.meta.metricVersion = "existing-facts-v2.1";
    data.meta.scope.search = input.filters.search;
    if (data.meta.comparisonScope) {
        data.meta.comparisonScope.compare = "none";
        data.meta.comparisonScope.search = input.filters.search;
    }
    const report = buildUsageV2Report({ page: input.page, data } as UsageV2ReportInput, { period: input.period });
    const { scope, comparisonScope, metricVersion, asOf, computedThrough, dataMode, liveFrom } = report.aggregates;
    return {
        page: input.page,
        period: input.period,
        scope,
        comparisonScope,
        metricVersion,
        asOf,
        computedThrough,
        dataMode,
        liveFrom,
        content: report.content,
        markdown: report.markdown,
        estimatedCharacters: report.estimatedCharacters,
        warnings: report.warnings,
    };
}
