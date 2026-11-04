import { Select, Table, Alert } from "antd";
import { useState } from "react";
import type { UsageV2Models } from "@/services/api/usage-analytics-v2";
import { barOption, ChartPanel, DimensionTable, Insights, NotAvailable, type Drilldown } from "./components";
import { metricCoverageText, metricLabels } from "./format";
import CompilationAnalysis from "./compilation-analysis";
export default function Models({ data, onDrilldown }: { data: UsageV2Models; onDrilldown: Drilldown }) {
    const [dimension, setDimension] = useState<keyof UsageV2Models["costBreakdown"]>("boards");
    const [xMetric, setXMetric] = useState<"generationBookedCny" | "costPerImage" | "costPerUsedImage">("costPerImage");
    const [yMetric, setYMetric] = useState<"successRate" | "resultUseRate" | "formalAdoptionRate">("successRate");
    const rows = data.costBreakdown[dimension];
    const latencyRows = data.models.filter((row) => row.latency.available > 0);
    const drillModel = (index: number) => {
        const row = data.models[index];
        if (row?.modelConfigId) onDrilldown({ modelConfigIds: [row.modelConfigId], operationTypes: [row.operationType], ...(row.boardKey ? { boardKeys: [row.boardKey] } : {}) });
    };
    return (
        <div className="space-y-4">
            <Insights items={data.insights} onDrilldown={onDrilldown} fallback="模型按操作类型和板块分开比较。低费用不等于更好的结果，已记账金额不等于供应商最终扣款。" />
            <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                <ChartPanel
                    title="模型成本与结果对比"
                    description={`横轴：${metricLabels[xMetric]}；纵轴：${metricLabels[yMetric]}。气泡大小为生成任务量；淡色点表示部分覆盖，悬停显示样本缺口。结果使用不是正式采纳，不作性价比或人员能力结论。`}
                    option={
                        data.models.length
                            ? {
                                  grid: { left: 15, right: 25, top: 30, bottom: 45, containLabel: true },
                                  xAxis: { type: "value", name: "已记账成本 ¥", nameLocation: "middle", nameGap: 24 },
                                  yAxis: { type: "value", name: "比例 %", min: 0, max: 100 },
                                  series: [
                                      {
                                          type: "scatter",
                                          data: data.models.map((row) => ({
                                              name: `${row.label}\n${metricLabels[xMetric]}：${metricCoverageText(row.metrics[xMetric])}\n${metricLabels[yMetric]}：${metricCoverageText(row.metrics[yMetric])}`,
                                              value: [
                                                  row.metrics[xMetric].state === "unavailable" ? null : row.metrics[xMetric].value,
                                                  row.metrics[yMetric].state === "unavailable" || row.metrics[yMetric].value === null ? null : row.metrics[yMetric].value! * 100,
                                                  row.metrics.generationRequests.value,
                                              ],
                                              itemStyle: { opacity: row.metrics[xMetric].state === "partial" || row.metrics[yMetric].state === "partial" ? 0.5 : 1 },
                                          })),
                                          symbolSize: (value) => Math.min(55, Math.max(10, Math.sqrt(Number(value[2] || 0)) * 3)),
                                      },
                                  ],
                              }
                            : undefined
                    }
                    onSelect={drillModel}
                >
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <Select aria-label="模型气泡横轴" value={xMetric} onChange={setXMetric} options={(["costPerImage", "costPerUsedImage", "generationBookedCny"] as const).map((value) => ({ value, label: metricLabels[value] }))} />
                        <Select aria-label="模型气泡纵轴" value={yMetric} onChange={setYMetric} options={(["successRate", "resultUseRate", "formalAdoptionRate"] as const).map((value) => ({ value, label: metricLabels[value] }))} />
                    </div>
                </ChartPanel>
                <ChartPanel
                    title="成本结构"
                    description="按当前维度拆分已记账生成金额；与提示词优化费用分账。"
                    option={barOption(
                        rows.map((row) => ({ label: row.label, value: row.metrics.generationBookedCny.value })),
                        "已记账 ¥",
                    )}
                    onSelect={(index) => {
                        const row = rows[index];
                        if (!row) return;
                        if (dimension === "boards") onDrilldown({ boardKeys: [row.key] });
                        if (dimension === "departments") onDrilldown({ departmentIds: [row.key] });
                        if (dimension === "people") onDrilldown({ userIds: [row.key] });
                        if (dimension === "operations") onDrilldown({ operationTypes: [row.key] });
                        if (dimension === "models" && row.key !== "unknown") onDrilldown({ modelConfigIds: [row.key] });
                    }}
                >
                    <Select
                        aria-label="成本拆分维度"
                        className="mt-3 min-w-40"
                        value={dimension}
                        onChange={setDimension}
                        options={[
                            { value: "boards", label: "按板块" },
                            { value: "departments", label: "按部门" },
                            { value: "people", label: "按人员" },
                            { value: "operations", label: "按操作类型" },
                            { value: "models", label: "按模型" },
                        ]}
                    />
                </ChartPanel>
            </div>
            <DimensionTable rows={rows} label="当前成本维度" keys={["generationRequests", "generatedImages", "generationBookedCny"]} />
            <ChartPanel
                title="模型端到端耗时 · 五数分布"
                description="仅成功生成任务的有效耗时原样本，不平均每日分位数。箱体为 P25/P50/P75，须线为最小/最大值（非 Tukey 异常判定）。单位毫秒；缺失时间单列，不代表供应商纯推理时长。点击分布按模型 / 操作 / 板块下钻。"
                option={
                    latencyRows.length
                        ? {
                              grid: { left: 15, right: 20, top: 25, bottom: 60, containLabel: true },
                              xAxis: { type: "category", data: latencyRows.map((row) => row.label), axisLabel: { width: 140, overflow: "truncate" } },
                              yAxis: { type: "value", name: "提交到完成 ms" },
                              series: [
                                  {
                                      type: "boxplot",
                                      data: latencyRows.map((row) => ({
                                          name: `${row.label} · 可用 ${row.latency.available} / 缺失 ${row.latency.missing}`,
                                          value: [row.latency.min!, row.latency.q1!, row.latency.median!, row.latency.q3!, row.latency.max!],
                                      })),
                                  },
                              ],
                          }
                        : undefined
                }
                onSelect={(index) => {
                    const row = latencyRows[index];
                    if (row?.modelConfigId) onDrilldown({ modelConfigIds: [row.modelConfigId], operationTypes: [row.operationType], ...(row.boardKey ? { boardKeys: [row.boardKey] } : {}) });
                }}
            >
                <Table
                    rowKey="key"
                    size="small"
                    pagination={{ pageSize: 10, hideOnSinglePage: true }}
                    scroll={{ x: 950 }}
                    dataSource={data.models}
                    columns={[
                        { title: "模型 / 操作 / 板块", dataIndex: "label", width: 210 },
                        { title: "成功任务", render: (_, row) => row.latency.eligible },
                        { title: "有效耗时", render: (_, row) => row.latency.available },
                        { title: "缺失耗时", render: (_, row) => row.latency.missing },
                        ...(["min", "q1", "median", "q3", "max"] as const).map((key, index) => ({
                            title: ["最小 ms", "P25 ms", "P50 ms", "P75 ms", "最大 ms"][index],
                            key,
                            render: (_: unknown, row: UsageV2Models["models"][number]) => (row.latency[key] === null ? "不可用" : row.latency[key]!.toLocaleString("zh-CN", { maximumFractionDigits: 2 })),
                        })),
                        { title: "失败原因（归类记录数）", render: (_, row) => (row.failures.length ? row.failures.map((item) => `${item.label} ${item.count}`).join("；") : "无失败记录") },
                    ]}
                />
                <p className="mt-2 text-xs">失败原因仅为已记录 failed 请求的规则分类，不展示原始供应商错误；取消、暂停与待核查不当作成功任务耗时。</p>
            </ChartPanel>
            <DimensionTable
                rows={data.models.map((row) => ({ ...row, label: `${row.label} · ${row.operationType} · ${row.boardKey || "未关联板块"}` }))}
                label="模型 / 操作 / 板块"
                keys={["generationRequests", "successRate", "waitMsP50", "runMsP50", "totalMsP50", "totalMsP90", "generationBookedCny", "costPerImage", "resultUseRate", "formalAdoptionRate", "costPerUsedImage"]}
                onSelect={(row) => {
                    const selected = data.models.find((item) => item.key === row.key);
                    if (selected?.modelConfigId) onDrilldown({ modelConfigIds: [selected.modelConfigId], operationTypes: [selected.operationType], ...(selected.boardKey ? { boardKeys: [selected.boardKey] } : {}) });
                }}
            />
            <CompilationAnalysis key={JSON.stringify({ scope: data.meta.scope, asOf: data.meta.asOf })} scope={data.meta.scope} />
            <section className="wb-surface min-w-0 p-4">
                <h3 className="mb-2 font-semibold">当前筛选任务关联编译 · 独立费用</h3>
                <p className="mb-3 text-xs text-[var(--muted-foreground)]">以下沿用当前生成任务筛选的关联编译口径，不等同上方按编译创建时间统计的全部编译。</p>
                <p className="mb-3 text-sm">
                    执行 {data.optimizationCosts.executions} 次 · 缓存复用 {data.optimizationCosts.cacheHits} 次 · 结果待核查 {data.optimizationCosts.uncertain} 次
                </p>
                <div className="mb-3 grid gap-2 text-sm sm:grid-cols-2">
                    <p data-usage-metric={`优化输入 Token：${metricCoverageText(data.optimizationCosts.inputTokens)}`}>优化输入 Token：{metricCoverageText(data.optimizationCosts.inputTokens)}</p>
                    <p data-usage-metric={`优化输出 Token：${metricCoverageText(data.optimizationCosts.outputTokens)}`}>优化输出 Token：{metricCoverageText(data.optimizationCosts.outputTokens)}</p>
                </div>
                <Table
                    rowKey="currency"
                    size="small"
                    pagination={false}
                    scroll={{ x: 700 }}
                    dataSource={data.optimizationCosts.costs}
                    columns={[
                        { title: "币种", dataIndex: "currency" },
                        { title: "供应商返回金额", dataIndex: "providerReportedAmount" },
                        { title: "估算金额（另列）", dataIndex: "estimatedAmount" },
                        { title: "已知笔数", dataIndex: "knownCount" },
                        { title: "估算笔数", dataIndex: "estimatedCount" },
                        { title: "未知笔数", dataIndex: "unknownCount" },
                    ]}
                />
                <Alert className="mt-3" type="info" title="不同币种不相加，估算不冒充实付" description={data.optimizationCosts.notes.join("；")} />
            </section>
            <NotAvailable title="人民币预算与月底预测" reason={data.budget.definition} />
        </div>
    );
}
