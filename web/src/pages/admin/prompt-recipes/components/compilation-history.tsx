import { useDisplayUiValue, useDisplayConfig, useDisplayValue } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { useState } from "react";
import { Alert, Empty, Select, Statistic, Table, Tag } from "antd";
import type { PromptRecipeDetail } from "@/services/api/admin-prompt-recipes";
import type { AdminPromptCompilation } from "../../../../../../shared/prompt-contracts";
import { formatNonFinancialJson, formatNonFinancialPreview, omitFinancialFields } from "@/lib/financial-presentation";

export const compilationStatus = { optimizing: "优化中", success: "成功", failed: "失败", uncertain: "状态待核查" };
export function CompilationResult({ compilation }: { compilation: AdminPromptCompilation }) {
    const displayUi = useDisplayUiValue();
    const displayJson = useDisplayValue();
    const [snapshotOpen, setSnapshotOpen] = useState(false);
    useUiLocale();
    const snapshot = { requestId: compilation.requestId, versionId: compilation.recipeVersionId, input: compilation.inputSnapshot, inputHash: compilation.inputHash, reusedFromId: compilation.reusedFromId };
    const requestPreview = formatNonFinancialJson(snapshotOpen ? displayJson(omitFinancialFields(snapshot)) : snapshot);
    let responsePreview = formatNonFinancialPreview(compilation.rawResponse || staticUiText("没有原始响应"));
    if (snapshotOpen && compilation.rawResponse) {
        try { responsePreview = formatNonFinancialJson(displayJson(omitFinancialFields(JSON.parse(compilation.rawResponse)))); }
        catch { /* Non-JSON responses may contain code or credentials; keep the original, never send a raw blob for translation. */ }
    }
    return (
        <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap gap-1">
                <Tag color={compilation.status === "success" ? "green" : compilation.status === "failed" ? "red" : "orange"}>{staticUiText(compilationStatus[compilation.status])}</Tag>
                <Tag>{compilation.method === "template" ? staticUiText("固定模板 · 无改写调用") : compilation.method === "minimal" ? staticUiText("精简改写") : compilation.optimized ? staticUiText("已优化") : staticUiText("未优化 / 回退")}</Tag>
                {compilation.cacheHit && <Tag color="blue">{staticUiText("缓存命中")}</Tag>}
            </div>
            {compilation.message && <Alert type={compilation.status === "failed" ? "error" : "warning"} title={displayUi(compilation.message)} />}
            {Boolean(compilation.questions?.length) && <Alert type="warning" title={staticUiText("需补充后才能出图")} description={displayUi(compilation.questions!.join("；"))} />}
            {compilation.promptMetrics && <p className="text-xs text-muted-foreground">{compilation.promptMetrics.characters}{staticUiText(" 字符 · ")}{compilation.promptMetrics.words}{staticUiText(" 英文词 · ")}{compilation.promptMetrics.avoidPhrases}{staticUiText(" 项排除词")}{compilation.promptMetrics.overRecommended ? staticUiText(" · 超出简洁目标（未截断要求）") : ""}</p>}
            <div>
                <h4 className="mb-1 text-xs text-muted-foreground">{compilation.inputSnapshot.promptInput.scene === "video-motion" ? staticUiText("动效方案摘要") : staticUiText("中文说明")}</h4>
                <pre className="whitespace-pre-wrap break-words text-sm">{displayUi(compilation.summaryZh || "—")}</pre>
            </div>
            <div>
                <h4 className="mb-1 text-xs text-muted-foreground">{staticUiText("实际提示词")}</h4>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-3 text-xs">{displayUi(compilation.prompt || "—")}</pre>
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                {compilation.upstreamStatus !== undefined && <><dt>{staticUiText("上游 HTTP 状态")}</dt><dd>{compilation.upstreamStatus}</dd></>}
                {compilation.upstreamReason && <><dt>{staticUiText("上游安全分类")}</dt><dd className="break-all">{compilation.upstreamReason}</dd></>}
                <dt>{staticUiText("延迟")}</dt>
                <dd>{compilation.latencyMs == null ? staticUiText("未知") : `${compilation.latencyMs} ms`}</dd>
                <dt>{staticUiText("输入 / 输出 Token")}</dt>
                <dd>
                    {compilation.inputTokens ?? staticUiText("未知")} / {compilation.outputTokens ?? staticUiText("未知")}
                </dd>
                <dt>{staticUiText("优化模型 / 目标模型")}</dt>
                <dd className="break-all">
                    {compilation.modelConfigId} / {compilation.targetModelConfigId}
                </dd>
            </dl>
            <details onToggle={event => setSnapshotOpen(event.currentTarget.open)}>
                <summary className="cursor-pointer text-xs text-muted-foreground">{staticUiText("请求快照与原始响应（仅管理员）")}</summary>
                <pre data-testid="compilation-request-snapshot" className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border p-3 text-xs">
                    {requestPreview}
                </pre>
                <pre data-testid="compilation-raw-response" className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border p-3 text-xs">{responsePreview}</pre>
            </details>
        </div>
    );
}

export function CompilationHistory({ detail }: { detail: PromptRecipeDetail }) {
    const displayConfig = useDisplayConfig();
    useUiLocale();
    const [selection, setSelection] = useState<string[]>([]);
    const { stats } = detail;
    return (
        <div className="flex min-w-0 flex-col gap-5">
            <section className="wb-surface p-4 sm:p-5">
                <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
                    <Statistic title={staticUiText("优化请求")} value={stats.total} />
                    <Statistic title={staticUiText("成功率")} value={stats.total ? (stats.success / stats.total) * 100 : 0} precision={1} suffix="%" />
                    <Statistic title={staticUiText("缓存命中")} value={stats.cacheHits} />
                    <Statistic title={staticUiText("平均延迟")} value={stats.averageLatencyMs == null ? "—" : Math.round(stats.averageLatencyMs)} suffix={stats.averageLatencyMs == null ? undefined : "ms"} />
                </div>
                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-lg bg-muted/30 p-3 text-sm">{staticUiText("失败 ")}{stats.failed}{staticUiText(" 次")}<br />{staticUiText("已报告输入 / 输出 Token：")}{stats.inputTokens} / {stats.outputTokens}
                    </div>
                </div>
                {stats.promptQuality && <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
                    <Statistic title={staticUiText("简洁目标超标率")} value={stats.promptQuality.measured ? stats.promptQuality.overRecommended / stats.promptQuality.measured * 100 : 0} precision={1} suffix="%" />
                    <Statistic title={staticUiText("平均排除短语数")} value={stats.promptQuality.measured ? stats.promptQuality.avoidPhrases / stats.promptQuality.measured : 0} precision={1} />
                    <Statistic title={staticUiText("固定模板编译")} value={stats.promptQuality.templateCompilations} />
                    <Statistic title={staticUiText("需补充信息")} value={stats.promptQuality.clarifications} />
                    <p className="col-span-full text-xs text-muted-foreground">{staticUiText("仅统计有指标的 ")}{stats.promptQuality.measured}{staticUiText(" 次独立编译，不含缓存重复；超出简洁目标不代表质量失败，不会截断关键要求。")}</p>
                </div>}
            </section>
            <section className="wb-surface min-w-0 p-4 sm:p-5">
                <h3 className="mb-3 font-semibold">{staticUiText("最近优化记录（最多 20 条）")}</h3>
                <Table<AdminPromptCompilation>
                    size="small"
                    rowKey="id"
                    pagination={false}
                    scroll={{ x: 820 }}
                    dataSource={detail.compilations}
                    columns={displayConfig([
                        { title: staticUiText("时间"), dataIndex: "createdAt", render: (value) => new Date(value).toLocaleString() },
                        { title: staticUiText("版本"), render: (_, record) => `v${detail.versions.find((version) => version.id === record.recipeVersionId)?.version ?? "?"}` },
                        { title: staticUiText("状态"), render: (_, record) => <Tag color={record.status === "success" ? "green" : "orange"}>{staticUiText(compilationStatus[record.status])}</Tag> },
                        { title: staticUiText("缓存"), render: (_, record) => (record.cacheHit ? staticUiText("命中") : staticUiText("未命中")) },
                        { title: staticUiText("延迟"), render: (_, record) => (record.latencyMs == null ? staticUiText("未知") : `${record.latencyMs} ms`) },
                    ], "columns", detail.compilations)}
                />
                <div className="mt-4">
                    <label className="mb-2 block text-sm">{staticUiText("选择最多两条记录并排对比")}</label>
                    <Select
                        aria-label={staticUiText("对比优化记录")}
                        mode="multiple"
                        value={selection}
                        onChange={(values) => setSelection(values.slice(-2))}
                        className="w-full"
                        placeholder={staticUiText("可跨版本比较提示词、Token 与响应时间")}
                        options={displayConfig(detail.compilations.map((record) => ({
                            value: record.id,
                            label: `${new Date(record.createdAt).toLocaleString()} · v${detail.versions.find((version) => version.id === record.recipeVersionId)?.version ?? "?"} · ${staticUiText(compilationStatus[record.status])}`,
                        })), "options")}
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
                !detail.compilations.length && <Empty description={staticUiText("尚无优化测试或创作记录")} />
            )}
        </div>
    );
}
