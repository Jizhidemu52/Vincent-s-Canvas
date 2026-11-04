import type { UsageV2People, UsageV2Query } from "../../../shared/usage-analytics-v2";
import type { UsagePeopleComparison } from "../../../shared/usage-people-comparison";
import { usageV2QueryString } from "../../src/services/api/usage-analytics-v2";
import { fixture } from "./fixture";

export function peopleComparisonFixture(query: UsageV2Query, ids: string[], names?: string[]): UsagePeopleComparison {
    const data = fixture(new URL(`http://127.0.0.1/api/admin/usage/people-v2${usageV2QueryString(query)}`)) as UsageV2People;
    const metrics = structuredClone(data.metrics);
    metrics.activePeople.value = 4;
    metrics.activeDays.value = 15;
    metrics.generationRequests.value = 100;
    metrics.generatedImages.value = 140;
    metrics.successRate = { ...metrics.successRate, numerator: 90, denominator: 100 };
    metrics.resultUseRate = { ...metrics.resultUseRate, numerator: 56, denominator: 140 };
    metrics.formalAdoptionRate = { ...metrics.formalAdoptionRate, numerator: 14, denominator: 140 };
    metrics.generationBookedCny = { ...metrics.generationBookedCny, value: 63, amount: "63.000000" };
    const average = (count: number) => ({ ...metrics.generationBookedCny, value: 63 / count, amount: (63 / count).toFixed(6), numerator: 63, denominator: count, definition: "隔离合成：团队已记账金额 / 明确人数，不是供应商实付。", definitionId: `synthetic-average-${count}` });
    return {
        meta: { ...data.meta, scope: { ...data.meta.scope, search: query.search } }, selectedUserIds: [...ids],
        people: ids.map((userId, index) => ({ ...structuredClone(data.people[0]), userId, displayName: names?.[index] ?? `比较员工${index + 1}` })),
        team: { metrics, rosterPeople: 6, perActivePersonBookedCny: average(4), perRosterPersonBookedCny: average(6), populationDefinition: "隔离合成：原共享筛选团队，范围名册含没有本期记录者；活跃人数只数有业务记录者。率按合并分子/分母，时延按原样本；计数与金额是合计，不是个人均值或能力评价。" },
    };
}
