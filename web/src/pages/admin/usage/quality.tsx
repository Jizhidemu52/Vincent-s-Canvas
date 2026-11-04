import { Table, Alert, Button } from "antd";
import { useState } from "react";
import type { UsageV2Quality, UsageV2Metrics } from "@/services/api/usage-analytics-v2";
import { barOption, ChartPanel, Insights, MetricCards, NotAvailable, type Drilldown } from "./components";
import { metricText, metricCoverageText, pairOptimizationGroups } from "./format";
import MatureResults from "./mature-results";
export function OptimizationMetrics({ metrics }: { metrics?: UsageV2Metrics }) {
    if (!metrics) return <span>当前范围无该组记录（不补零）</span>;
    return (
        <div className="space-y-1 text-xs leading-5">
            <p>
                任务样本 {metricText(metrics.generationRequests)}；成功/明确失败分母 {metrics.successRate.denominator ?? "未提供"}
            </p>
            <p>成功率：{metricCoverageText(metrics.successRate)}</p>
            <p>结果使用率：{metricCoverageText(metrics.resultUseRate)}</p>
            <p>正式采纳率：{metricCoverageText(metrics.formalAdoptionRate)}</p>
        </div>
    );
}
export default function Quality({ data, onDrilldown }: { data: UsageV2Quality; onDrilldown: Drilldown }) {
    const [reason, setReason] = useState<string>();
    const reasons = [...new Set(data.failures.map((row) => row.label))].map((label) => ({ label, value: data.failures.filter((row) => row.label === label).reduce((count, row) => count + row.count, 0) }));
    return (
        <div className="space-y-4">
            <Insights items={data.insights} onDrilldown={onDrilldown} fallback="这里只描述生成状态与结果使用证据，不把失败归责于员工，也不把下载行为等同于作品质量。" />
            <MetricCards metrics={data.metrics} keys={["successRate", "failed", "resultUseRate", "formalAdoptionRate", "cancelled", "paused", "uncertain", "interrupted"]} />
            <MatureResults key={`${JSON.stringify(data.meta.scope)}:${data.meta.asOf}`} scope={data.meta.scope} />
            <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                <ChartPanel
                    title="失败原因分布"
                    description={`规则 ${data.failureRuleVersion}；点击类别筛选下方明细。未知原因保留，取消、暂停、待核查与确定失败分开。`}
                    option={barOption(reasons, "失败任务")}
                    onSelect={(index) => setReason(reasons[index]?.label)}
                >
                    <div className="mt-2 flex flex-wrap gap-2">
                        {reasons.map((item) => (
                            <Button key={item.label} size="small" onClick={() => setReason(item.label)}>
                                {item.label} · {item.value}
                            </Button>
                        ))}
                    </div>
                </ChartPanel>
                <ChartPanel
                    title="Worker 尝试次数分布"
                    description="任务的 Worker 尝试次数，不是设计师改稿轮次，也不是供应商付费请求次数。"
                    option={barOption(
                        data.retries.map((row) => ({ label: `${row.attempts} 次尝试`, value: row.tasks })),
                        "任务数",
                    )}
                />
            </div>
            <section className="wb-surface min-w-0 p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-semibold">失败明细{reason ? ` · ${reason}` : ""}</h3>
                    {reason ? (
                        <Button size="small" onClick={() => setReason(undefined)}>
                            显示全部类别
                        </Button>
                    ) : null}
                </div>
                <Table
                    size="small"
                    rowKey={(row) => JSON.stringify([row.category, row.modelConfigId, row.boardKey, row.operationType])}
                    dataSource={reason ? data.failures.filter((row) => row.label === reason) : data.failures}
                    scroll={{ x: 700 }}
                    pagination={{ pageSize: 12, hideOnSinglePage: true }}
                    columns={[
                        { title: "分类", dataIndex: "label" },
                        { title: "模型", dataIndex: "modelConfigId", render: (value) => value || "未关联" },
                        { title: "板块", dataIndex: "boardKey" },
                        { title: "操作类型", dataIndex: "operationType" },
                        { title: "任务数", dataIndex: "count", sorter: (a, b) => a.count - b.count },
                        {
                            title: "下钻",
                            render: (_, row) => (
                                <Button
                                    size="small"
                                    disabled={!row.modelConfigId && !row.boardKey}
                                    onClick={() => onDrilldown({ operationTypes: [row.operationType], ...(row.modelConfigId ? { modelConfigIds: [row.modelConfigId] } : {}), ...(row.boardKey ? { boardKeys: [row.boardKey] } : {}) })}
                                >
                                    模型 / 板块
                                </Button>
                            ),
                        },
                    ]}
                />
            </section>
            <NotAvailable title="完整改稿轮次" reason={data.lineage.definition} />
            <section className="wb-surface min-w-0 p-4">
                <h3 className="mb-3 font-semibold">提示词优化的关联对比</h3>
                <Alert
                    className="mb-3"
                    type="info"
                    title="只作关联观察，不代表优化产生了因果效果"
                    description="同一模型、板块和操作类型的两组并列展示。无优化标记可能含历史未标记任务；样本大小、自选使用、观察时间与结果关联缺口均会影响结果。结果使用与正式采纳始终分列。"
                />
                <Table
                    size="small"
                    pagination={{ pageSize: 10, hideOnSinglePage: true }}
                    scroll={{ x: 800 }}
                    rowKey="key"
                    dataSource={pairOptimizationGroups(data.optimizationComparison)}
                    columns={[
                        { title: "模型", dataIndex: "modelConfigId" },
                        { title: "板块", dataIndex: "boardKey" },
                        { title: "操作", dataIndex: "operationType" },
                        { title: "有优化关联组", render: (_, row) => <OptimizationMetrics metrics={row.optimized} /> },
                        { title: "无优化标记组", render: (_, row) => <OptimizationMetrics metrics={row.unmarked} /> },
                    ]}
                />
            </section>
        </div>
    );
}
