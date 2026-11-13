import { DisplayText, useDisplayUiValue, useDisplayConfig } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { Table, Alert, Button } from "antd";
import { useState } from "react";
import type { UsageV2Quality, UsageV2Metrics } from "@/services/api/usage-analytics-v2";
import { barOption, ChartPanel, Insights, MetricCards, NotAvailable, type Drilldown } from "./components";
import { metricText, metricCoverageText, pairOptimizationGroups } from "./format";
import MatureResults from "./mature-results";
export function OptimizationMetrics({ metrics }: { metrics?: UsageV2Metrics }) {
    const englishGap = useUiLocale() === "en-US" ? " " : "";
    if (!metrics) return <span>{staticUiText("当前范围无该组记录（不补零）")}</span>;
    return (
        <div className="space-y-1 text-xs leading-5">
            <p>{staticUiText("任务样本 ")}<DisplayText text={metricText(metrics.generationRequests)} />{staticUiText("；成功/明确失败分母 ")}{metrics.successRate.denominator ?? staticUiText("未提供")}
            </p>
            <p>{staticUiText("成功率：")}{englishGap}<DisplayText text={metricCoverageText(metrics.successRate)} /></p>
            <p>{staticUiText("结果使用率：")}{englishGap}<DisplayText text={metricCoverageText(metrics.resultUseRate)} /></p>
            <p>{staticUiText("正式采纳率：")}{englishGap}<DisplayText text={metricCoverageText(metrics.formalAdoptionRate)} /></p>
        </div>
    );
}
export default function Quality({ data, onDrilldown }: { data: UsageV2Quality; onDrilldown: Drilldown }) {
    const displayUi = useDisplayUiValue();
    const displayConfig = useDisplayConfig();
    useUiLocale();
    const [reason, setReason] = useState<string>();
    const reasons = [...new Set(data.failures.map((row) => row.label))].map((label) => ({ label, value: data.failures.filter((row) => row.label === label).reduce((count, row) => count + row.count, 0) }));
    return (
        <div className="space-y-4">
            <Insights items={data.insights} onDrilldown={onDrilldown} fallback={staticUiText("这里只描述生成状态与结果使用证据，不把失败归责于员工，也不把下载行为等同于作品质量。")} />
            <MetricCards metrics={data.metrics} keys={["successRate", "failed", "resultUseRate", "formalAdoptionRate", "cancelled", "paused", "uncertain", "interrupted"]} />
            <MatureResults key={`${JSON.stringify(data.meta.scope)}:${data.meta.asOf}`} scope={data.meta.scope} />
            <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                <ChartPanel
                    title={staticUiText("失败原因分布")}
                    description={staticUiText("规则 {p0}；点击类别筛选下方明细。未知原因保留，取消、暂停、待核查与确定失败分开。", { p0: `${data.failureRuleVersion}` })}
                    option={barOption(reasons, "失败任务")}
                    onSelect={(index) => setReason(reasons[index]?.label)}
                >
                    <div className="mt-2 flex flex-wrap gap-2">
                        {reasons.map((item) => (
                            <Button key={item.label} size="small" onClick={() => setReason(item.label)}>
                                {displayUi(item.label)} · {item.value}
                            </Button>
                        ))}
                    </div>
                </ChartPanel>
                <ChartPanel
                    title={staticUiText("Worker 尝试次数分布")}
                    description={staticUiText("任务的 Worker 尝试次数，不是设计师改稿轮次，也不是供应商付费请求次数。")}
                    option={barOption(
                        data.retries.map((row) => ({ label: `${row.attempts} 次尝试`, value: row.tasks })),
                        "任务数",
                    )}
                />
            </div>
            <section className="wb-surface min-w-0 p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-semibold">{staticUiText("失败明细")}{displayUi(reason ? ` · ${reason}` : "")}</h3>
                    {reason ? (
                        <Button size="small" onClick={() => setReason(undefined)}>{staticUiText("显示全部类别")}</Button>
                    ) : null}
                </div>
                <Table
                    size="small"
                    rowKey={(row) => JSON.stringify([row.category, row.modelConfigId, row.boardKey, row.operationType])}
                    dataSource={reason ? data.failures.filter((row) => row.label === reason) : data.failures}
                    scroll={{ x: 700 }}
                    pagination={{ pageSize: 12, hideOnSinglePage: true }}
                    columns={displayConfig([
                        { title: staticUiText("分类"), dataIndex: "label" },
                        { title: staticUiText("模型"), dataIndex: "modelConfigId", render: (value) => value || staticUiText("未关联") },
                        { title: staticUiText("板块"), dataIndex: "boardKey" },
                        { title: staticUiText("操作类型"), dataIndex: "operationType" },
                        { title: staticUiText("任务数"), dataIndex: "count", sorter: (a, b) => a.count - b.count },
                        {
                            title: staticUiText("下钻"),
                            render: (_, row) => (
                                <Button
                                    size="small"
                                    disabled={!row.modelConfigId && !row.boardKey}
                                    onClick={() => onDrilldown({ operationTypes: [row.operationType], ...(row.modelConfigId ? { modelConfigIds: [row.modelConfigId] } : {}), ...(row.boardKey ? { boardKeys: [row.boardKey] } : {}) })}
                                >{staticUiText("模型 / 板块")}</Button>
                            ),
                        },
                    ], "columns", reason ? data.failures.filter((row) => row.label === reason) : data.failures)}
                />
            </section>
            <NotAvailable title={staticUiText("完整改稿轮次")} reason={data.lineage.definition} />
            <section className="wb-surface min-w-0 p-4">
                <h3 className="mb-3 font-semibold">{staticUiText("提示词优化的关联对比")}</h3>
                <Alert
                    className="mb-3"
                    type="info"
                    title={staticUiText("只作关联观察，不代表优化产生了因果效果")}
                    description={staticUiText("同一模型、板块和操作类型的两组并列展示。无优化标记可能含历史未标记任务；样本大小、自选使用、观察时间与结果关联缺口均会影响结果。结果使用与正式采纳始终分列。")}
                />
                <Table
                    size="small"
                    pagination={{ pageSize: 10, hideOnSinglePage: true }}
                    scroll={{ x: 800 }}
                    rowKey="key"
                    dataSource={pairOptimizationGroups(data.optimizationComparison)}
                    columns={displayConfig([
                        { title: staticUiText("模型"), dataIndex: "modelConfigId" },
                        { title: staticUiText("板块"), dataIndex: "boardKey" },
                        { title: staticUiText("操作"), dataIndex: "operationType" },
                        { title: staticUiText("有优化关联组"), render: (_, row) => <OptimizationMetrics metrics={row.optimized} /> },
                        { title: staticUiText("无优化标记组"), render: (_, row) => <OptimizationMetrics metrics={row.unmarked} /> },
                    ], "columns", pairOptimizationGroups(data.optimizationComparison))}
                />
            </section>
        </div>
    );
}
