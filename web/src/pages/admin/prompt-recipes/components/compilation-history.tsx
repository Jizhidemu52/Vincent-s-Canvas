import { useState } from "react";
import { Alert, Empty, Select, Statistic, Table, Tag } from "antd";
import type { PromptRecipeDetail } from "@/services/api/admin-prompt-recipes";
import type { AdminPromptCompilation } from "../../../../../../shared/prompt-contracts";

export const compilationStatus = { optimizing: "优化中", success: "成功", failed: "失败", uncertain: "状态待核查" };
export function CompilationResult({ compilation }: { compilation: AdminPromptCompilation }) {
    return (
        <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap gap-1">
                <Tag color={compilation.status === "success" ? "green" : compilation.status === "failed" ? "red" : "orange"}>{compilationStatus[compilation.status]}</Tag>
                <Tag>{compilation.optimized ? "已优化" : "未优化 / 回退"}</Tag>
                {compilation.cacheHit && <Tag color="blue">缓存命中</Tag>}
            </div>
            {compilation.message && <Alert type={compilation.status === "failed" ? "error" : "warning"} title={compilation.message} />}
            <div>
                <h4 className="mb-1 text-xs text-muted-foreground">中文说明</h4>
                <pre className="whitespace-pre-wrap break-words text-sm">{compilation.summaryZh || "—"}</pre>
            </div>
            <div>
                <h4 className="mb-1 text-xs text-muted-foreground">实际提示词</h4>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-3 text-xs">{compilation.prompt || "—"}</pre>
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                <dt>延迟</dt>
                <dd>{compilation.latencyMs == null ? "未知" : `${compilation.latencyMs} ms`}</dd>
                <dt>输入 / 输出 Token</dt>
                <dd>
                    {compilation.inputTokens ?? "未知"} / {compilation.outputTokens ?? "未知"}
                </dd>
                <dt>实记成本</dt>
                <dd>{compilation.actualCost == null ? "未知" : `${compilation.actualCost} ${compilation.currency}`}</dd>
                <dt>估算成本</dt>
                <dd>{compilation.estimatedCost == null ? "未知" : `${compilation.estimatedCost} ${compilation.currency}`}</dd>
                <dt>优化模型 / 目标模型</dt>
                <dd className="break-all">
                    {compilation.modelConfigId} / {compilation.targetModelConfigId}
                </dd>
            </dl>
            <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">请求快照与原始响应（仅管理员）</summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border p-3 text-xs">
                    {JSON.stringify({ requestId: compilation.requestId, versionId: compilation.recipeVersionId, input: compilation.inputSnapshot, inputHash: compilation.inputHash, reusedFromId: compilation.reusedFromId }, null, 2)}
                </pre>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border p-3 text-xs">{compilation.rawResponse || "没有原始响应"}</pre>
            </details>
        </div>
    );
}

export function CompilationHistory({ detail }: { detail: PromptRecipeDetail }) {
    const [selection, setSelection] = useState<string[]>([]);
    const { stats } = detail;
    return (
        <div className="flex min-w-0 flex-col gap-5">
            <section className="wb-surface p-4 sm:p-5">
                <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
                    <Statistic title="优化请求" value={stats.total} />
                    <Statistic title="成功率" value={stats.total ? (stats.success / stats.total) * 100 : 0} precision={1} suffix="%" />
                    <Statistic title="缓存命中" value={stats.cacheHits} />
                    <Statistic title="平均延迟" value={stats.averageLatencyMs == null ? "—" : Math.round(stats.averageLatencyMs)} suffix={stats.averageLatencyMs == null ? undefined : "ms"} />
                </div>
                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-lg bg-muted/30 p-3 text-sm">
                        失败 {stats.failed} 次<br />
                        已报告输入 / 输出 Token：{stats.inputTokens} / {stats.outputTokens}
                    </div>
                    {stats.costs?.map((cost) => (
                        <div className="rounded-lg bg-muted/30 p-3 text-sm" key={cost.currency}>
                            <strong>{cost.currency}</strong>
                            <br />
                            实记：{cost.actual}
                            <br />
                            估算：{cost.estimated}
                            <br />
                            成本未知：{cost.unknownCount} 次
                        </div>
                    ))}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">实记与估算不是同一指标，不相加；不同币种不合并。缺少金额并不表示免费。总成本未知 {stats.unknownCostCount} 次。</p>
            </section>
            <section className="wb-surface min-w-0 p-4 sm:p-5">
                <h3 className="mb-3 font-semibold">最近优化记录（最多 20 条）</h3>
                <Table<AdminPromptCompilation>
                    size="small"
                    rowKey="id"
                    pagination={false}
                    scroll={{ x: 820 }}
                    dataSource={detail.compilations}
                    columns={[
                        { title: "时间", dataIndex: "createdAt", render: (value) => new Date(value).toLocaleString() },
                        { title: "版本", render: (_, record) => `v${detail.versions.find((version) => version.id === record.recipeVersionId)?.version ?? "?"}` },
                        { title: "状态", render: (_, record) => <Tag color={record.status === "success" ? "green" : "orange"}>{compilationStatus[record.status]}</Tag> },
                        { title: "缓存", render: (_, record) => (record.cacheHit ? "命中" : "未命中") },
                        { title: "延迟", render: (_, record) => (record.latencyMs == null ? "未知" : `${record.latencyMs} ms`) },
                        { title: "实记 / 估算", render: (_, record) => `${record.actualCost ?? "未知"} / ${record.estimatedCost ?? "未知"} ${record.currency}` },
                    ]}
                />
                <div className="mt-4">
                    <label className="mb-2 block text-sm">选择最多两条记录并排对比</label>
                    <Select
                        aria-label="对比优化记录"
                        mode="multiple"
                        value={selection}
                        onChange={(values) => setSelection(values.slice(-2))}
                        className="w-full"
                        placeholder="可跨版本比较提示词、Token 与成本"
                        options={detail.compilations.map((record) => ({
                            value: record.id,
                            label: `${new Date(record.createdAt).toLocaleString()} · v${detail.versions.find((version) => version.id === record.recipeVersionId)?.version ?? "?"} · ${compilationStatus[record.status]}`,
                        }))}
                    />
                </div>
            </section>
            {selection.length ? (
                <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                    {selection.map((id) => {
                        const record = detail.compilations.find((item) => item.id === id);
                        return record ? (
                            <section key={id} className="wb-surface min-w-0 p-4">
                                <h3 className="mb-3 text-sm font-semibold">
                                    v{detail.versions.find((version) => version.id === record.recipeVersionId)?.version} · {new Date(record.createdAt).toLocaleString()}
                                </h3>
                                <CompilationResult compilation={record} />
                            </section>
                        ) : null;
                    })}
                </div>
            ) : (
                !detail.compilations.length && <Empty description="尚无优化测试或创作记录" />
            )}
        </div>
    );
}
