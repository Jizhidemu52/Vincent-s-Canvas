import { Select } from "antd";
import { useState } from "react";
import type { UsageV2Overview, UsageV2MetricKey, UsageV2Dimension } from "@/services/api/usage-analytics-v2";
import { barOption, ChartPanel, DimensionTable, Heatmap, Insights, MetricCards, Trend, type Drilldown } from "./components";
import { metricLabels, perActivePersonCost } from "./format";
import DepartmentComparison from "./department-comparison";
import ReleaseContext from "./release-context";
export default function Overview({ data, onDrilldown }: { data: UsageV2Overview; onDrilldown: Drilldown }) {
    const [trendMetric, setTrendMetric] = useState<UsageV2MetricKey>("generatedImages");
    const [departmentMetric, setDepartmentMetric] = useState<"generatedImages" | "resultUseRate" | "formalAdoptionRate" | "generationBookedCny" | "perActivePerson">("generatedImages");
    const departmentValue = (row: UsageV2Dimension) => (departmentMetric === "perActivePerson" ? perActivePersonCost(row.metrics) : row.metrics[departmentMetric]);
    const departmentLabel = departmentMetric === "perActivePerson" ? "每位有记录活跃员工的已记账金额" : metricLabels[departmentMetric];
    return (
        <div className="space-y-4">
            <Insights items={data.insights} onDrilldown={onDrilldown} fallback="当前样本未触发可核对规则。下面展示同一筛选范围的记录、金额与覆盖；不从费用或使用量推断员工表现。" />
            <MetricCards metrics={data.metrics} keys={["activePeople", "generatedImages", "successRate", "generationBookedCny", "resultUseRate", "formalAdoptionRate", "totalMsP50", "activeSeconds"]} />
            <MetricCards metrics={data.metrics} keys={["waitMsP50", "runMsP50", "totalMsP90", "costPerUsedImage"]} />
            <div className="flex justify-end">
                <Select
                    aria-label="总览趋势指标"
                    value={trendMetric}
                    style={{ minWidth: 180 }}
                    options={[
                        { value: "generatedImages", label: "成功出图" },
                        { value: "activePeople", label: "活跃人数" },
                        { value: "generationBookedCny", label: "已记账生成金额" },
                    ]}
                    onChange={setTrendMetric}
                />
            </div>
            <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                <Trend daily={data.daily} comparisonDaily={data.comparisonDaily} from={data.meta.scope.from} to={data.meta.scope.to} comparisonFrom={data.meta.comparisonScope?.from} onDrilldown={onDrilldown} metric={trendMetric} title="每日趋势与对比" publications={data.releaseContext?.releases} />
                <Heatmap rows={data.hourlyHeatmap} />
            </div>
            <ReleaseContext publications={data.releaseContext} controls={data.controlDaily} from={data.meta.scope.from} to={data.meta.scope.to} />
            <ChartPanel
                title={`部门对比 · ${departmentLabel}`}
                description="同一周期与归属口径；* 表示部分覆盖。人均金额分母是同范围有至少一条已记录业务活动的去重员工，不是部门编制人数。点击柱条筛选部门；未知归属不猜配。"
                option={barOption(
                    data.departments.map((row) => {
                        const value = departmentValue(row);
                        return { label: `${row.label}${value.state === "partial" ? " *" : ""}`, value: value.value === null || value.state === "unavailable" ? null : value.value * (value.unit === "ratio" ? 100 : 1) };
                    }),
                    departmentLabel,
                )}
                onSelect={(index) => {
                    const row = data.departments[index];
                    if (row && !row.key.startsWith("unknown") && row.key !== "unassigned") onDrilldown({ departmentIds: [row.key] });
                }}
            >
                <Select
                    aria-label="部门对比指标"
                    className="mt-3 w-full sm:w-72"
                    value={departmentMetric}
                    onChange={setDepartmentMetric}
                    options={[
                        { value: "generatedImages", label: "成功出图" },
                        { value: "resultUseRate", label: "结果使用率（%）" },
                        { value: "formalAdoptionRate", label: "正式采纳率（%）" },
                        { value: "generationBookedCny", label: "已记账生成金额（¥）" },
                        { value: "perActivePerson", label: "人均已记账金额（活跃人数分母）" },
                    ]}
                />
            </ChartPanel>
            <DimensionTable
                rows={data.departments}
                label="部门"
                additionalMetrics={[{ key: "perActivePerson", label: "人均记账金额（活跃人数分母）", getMetric: (row) => perActivePersonCost(row.metrics) }]}
                onSelect={(row) => {
                    if (!row.key.startsWith("unknown") && row.key !== "unassigned") onDrilldown({ departmentIds: [row.key] });
                }}
            />
            <DepartmentComparison key={JSON.stringify(data.meta.scope)} departments={data.departments} meta={data.meta} />
        </div>
    );
}
