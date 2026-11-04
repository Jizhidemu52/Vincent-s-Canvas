import { expect, test } from "bun:test";
import { usageInsights } from "../src/usage-insights";
import { compareUsageV2Metrics, usageV2Metrics } from "../src/usage-analytics-v2";

const id = "11111111-1111-4111-8111-111111111111";
const metrics = (success: number, failed: number) => {
    const value = usageV2Metrics([]);
    value.succeeded = { ...value.succeeded, value: success };
    value.failed = { ...value.failed, value: failed };
    value.successRate = {
        ...value.successRate,
        value: success / (success + failed),
        numerator: success,
        denominator: success + failed,
        state: "available",
    };
    return value;
};
const model = (success = 50, failed = 50, previousSuccess = 90, previousFailed = 10) => ({
    key: id,
    label: "模型甲",
    metrics: compareUsageV2Metrics(metrics(success, failed), metrics(previousSuccess, previousFailed)),
});

test("model failure rule uses explicitly selected comparison period and terminal denominators", () => {
    const result = usageInsights(usageV2Metrics([]), { models: [model()] });
    const spike = result.find((row) => row.ruleId === "model-terminal-failure-double-v1")!;
    expect(spike.evidence).toMatchObject({
        currentFailed: 50,
        currentTerminal: 100,
        comparisonFailed: 10,
        comparisonTerminal: 100,
        currentFailureRate: 0.5,
        comparisonFailureRate: 0.1,
    });
    expect(spike.drilldownFilter).toEqual({ modelConfigIds: [id] });
    expect(spike.text).toContain("所选对比期");
    expect(spike.text).not.toMatch(/过去7|7天|效率|能力|绩效/);
});

test("small samples, zero baselines and incomplete states do not produce model spikes", () => {
    for (const row of [model(5, 14, 18, 1), model(50, 50, 100, 0), model(97, 3, 99, 1)]) {
        expect(
            usageInsights(usageV2Metrics([]), { models: [row] }).some(
                (item) => item.ruleId === "model-terminal-failure-double-v1",
            ),
        ).toBe(false);
    }
    const row = model();
    row.metrics.successRate.state = "partial";
    expect(
        usageInsights(usageV2Metrics([]), { models: [row] }).some(
            (item) => item.ruleId === "model-terminal-failure-double-v1",
        ),
    ).toBe(false);
});

test("visit imbalance is a record observation, never a conversion or satisfaction claim", () => {
    const values = usageV2Metrics([]);
    values.visits = { ...values.visits, value: 120 };
    values.generationRequests = { ...values.generationRequests, value: 4 };
    const result = usageInsights(usageV2Metrics([]), { boards: [{ key: "image", label: "图片", metrics: values }] });
    expect(result).toHaveLength(1);
    expect(result[0].evidence).toMatchObject({ visits: 120, generationTasks: 4 });
    expect(result[0].text).toContain("不是访问转化率");
    expect(result[0].drilldownFilter).toEqual({ boardKeys: ["image"] });
    values.visits.state = "unavailable";
    expect(
        usageInsights(usageV2Metrics([]), { boards: [{ key: "image", label: "图片", metrics: values }] }),
    ).toHaveLength(0);
});

test("reported loss comparison and activity peak are bounded reproducible evidence", () => {
    const result = usageInsights(usageV2Metrics([]), {
        collectionGaps: { current: 20, previous: 8 },
        hourly: [
            { weekday: 1, hour: 14, count: 80 },
            { weekday: 1, hour: 15, count: 20 },
        ],
    });
    expect(result.map((item) => item.ruleId)).toEqual(["reported-gap-increase-v1", "recorded-activity-peak-v1"]);
    expect(result[0].evidence).toMatchObject({ currentReported: 20, comparisonReported: 8 });
    expect(result[0].text).toContain("不代表全部缺口");
    expect(result[1].text).toContain("周二 14:00–14:59");
    expect(result[1].evidence).toMatchObject({ totalRecords: 100, peakRecords: 80, recordShare: 0.8 });
    expect(
        usageInsights(usageV2Metrics([]), {
            collectionGaps: { current: 5, previous: 0 },
            hourly: [{ weekday: 8, hour: 30, count: 200 }],
        }),
    ).toEqual([]);
});

test("overview insight additions are bounded and do not mutate shared responses", () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
        ...model(),
        key: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    const before = JSON.stringify(rows);
    expect(usageInsights(usageV2Metrics([]), { models: rows })).toHaveLength(5);
    expect(JSON.stringify(rows)).toBe(before);
});

test("personal spend signal uses exact money and suppresses missing, sparse, or zero-baseline records", () => {
    const cost = usageV2Metrics([]).generationBookedCny;
    const person = {
        userId: id,
        name: "员工甲",
        current: { ...cost, amount: "3.000000", value: 3, state: "available" as const, availableCount: 1 },
        baseline: { ...cost, amount: "30.000000", value: 30, state: "available" as const, availableCount: 10 },
    };
    const scope = { targetDay: "2026-10-31", baselineFrom: "2026-10-01", baselineDays: 30 as const };
    const result = usageInsights(usageV2Metrics([]), { spend: { ...scope, people: [person] } });
    expect(result).toHaveLength(1);
    expect(result[0].evidence).toMatchObject({
        currentBookedCny: "3.000000",
        baselineBookedCny: "30.000000",
        baselineDays: 30,
        baselineKnownTasks: 10,
    });
    expect(result[0].drilldownFilter).toEqual({ userIds: [id] });
    for (const baseline of [
        { ...person.baseline, amount: "30.000001" },
        { ...person.baseline, amount: "0" },
        { ...person.baseline, missingCount: 1 },
        { ...person.baseline, availableCount: 9 },
    ]) {
        expect(usageInsights(usageV2Metrics([]), { spend: { ...scope, people: [{ ...person, baseline }] } })).toEqual(
            [],
        );
    }
});
