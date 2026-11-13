import { fixture } from "../usage-v2-browser/fixture";
import { peopleComparisonFixture } from "../usage-v2-browser/people-comparison-fixture";
import type { UsageV2Dimension, UsageV2Overview, UsageV2Insight } from "../../src/services/api/usage-analytics-v2";

export const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];
export const overview = fixture(new URL("http://127.0.0.1/api/admin/usage/overview")) as UsageV2Overview;
export const comparison = peopleComparisonFixture({ from: overview.meta.scope.from, to: overview.meta.scope.to, compare: "none" }, ids, ["隔离比较员工甲", "隔离比较员工乙"]);
comparison.people[0].metrics.successRate.numerator = undefined;
comparison.people[0].metrics.successRate.denominator = 20;
comparison.people[0].metrics.activeSeconds = { ...comparison.people[0].metrics.activeSeconds, value: 180, state: "available", availableCount: 20, missingCount: 0 };
overview.meta.notes = ["隐藏页面覆盖说明"];
overview.meta.coverage[0].notes = ["隐藏指标覆盖说明"];
export const departments: UsageV2Dimension[] = [
    { key: "raw-department-a", label: "测试甲部门", metrics: structuredClone(overview.metrics) },
    { key: "raw-department-b", label: "测试乙部门", metrics: structuredClone(overview.metrics) },
];
departments[0].metrics.successRate.value = 0.9;
departments[1].metrics.successRate.value = 0.7;
export const insights: UsageV2Insight[] = [{ ruleId: "raw-rule-id", severity: "warning", text: "合成观察说明", sampleCount: 2, evidence: { explanation: "隐藏依据原文", count: 2 }, drilldownFilter: { departmentIds: ["raw-department-a"] } }];
export const original = JSON.stringify({ overview, comparison, departments, insights });
