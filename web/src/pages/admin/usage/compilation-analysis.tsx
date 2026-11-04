import { Alert, Button, Select, Table } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
    getUsageCompilationAnalysis, unsupportedCompilationFilters, USAGE_COMPILATION_STATUSES,
    type UsageCompilationAnalysis, type UsageCompilationNumber, type UsageCompilationSummary,
} from "@/services/api/usage-compilation-analysis";
import type { UsageV2Scope } from "@/services/api/usage-analytics-v2";
import { useUserStore } from "@/stores/use-user-store";

const groups = { all: "全部编译", linked: "当前已关联任务", unlinked: "当前未关联任务" } as const;
type Group = keyof typeof groups;
const statuses = { success: "成功", failed: "失败", uncertain: "待核查", optimizing: "编译中" } as const;
const numberText = (value: number | null) => value === null ? "不可用" : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const dateText = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const tokenText = (value: UsageCompilationNumber) => `${numberText(value.value)} · ${value.state === "partial" ? "部分覆盖；" : ""}可用 ${value.availableCount} / 缺失 ${value.missingCount}`;
const latencyText = (value: UsageCompilationSummary, key: "meanMs" | "p50Ms" | "p90Ms") => `${numberText(value.latency[key])}${value.latency[key] === null ? "" : " ms"} · 可用 ${value.latency.availableCount} / 缺失 ${value.latency.missingCount}`;
type ComparisonRow = { key: string; label: string; current: ReactNode; comparison: ReactNode };

/** No read occurs on mount. The parent also remounts this section after an applied-scope refresh. */
export default function CompilationAnalysis({ scope }: { scope: UsageV2Scope }) {
    const user = useUserStore(state => state.user), sessionStatus = useUserStore(state => state.status);
    const allowed = sessionStatus === "authenticated" && user?.role === "super_admin";
    const requestKey = JSON.stringify({ scope, identity: user?.id, role: user?.role, sessionStatus });
    const unsupported = unsupportedCompilationFilters(scope);
    const [view, setView] = useState<{ key: string; data: UsageCompilationAnalysis } | null>(null);
    const [readingKey, setReadingKey] = useState("");
    const [notice, setNotice] = useState<{ key: string; text: string; error: boolean } | null>(null);
    const [group, setGroup] = useState<Group>("all");
    const active = useRef<AbortController | null>(null), latestKey = useRef(requestKey);
    latestKey.current = requestKey;
    const data = allowed && view?.key === requestKey ? view.data : null;
    const reading = allowed && readingKey === requestKey;
    useEffect(() => {
        active.current?.abort(); active.current = null;
        setView(null); setReadingKey(""); setNotice(null); setGroup("all");
        return () => { active.current?.abort(); active.current = null; };
    }, [requestKey]);
    const read = async () => {
        if (!allowed || unsupported.length || active.current) return;
        const controller = new AbortController(); active.current = controller;
        setReadingKey(requestKey); setView(null); setNotice(null);
        try {
            const result = await getUsageCompilationAnalysis(scope, controller.signal);
            if (!controller.signal.aborted && active.current === controller && latestKey.current === requestKey) setView({ key: requestKey, data: result });
        } catch (failure) {
            if (!controller.signal.aborted && active.current === controller && latestKey.current === requestKey)
                setNotice({ key: requestKey, error: true, text: failure instanceof Error ? failure.message : "编译分析读取未完成。" });
        } finally {
            if (active.current === controller) { active.current = null; setReadingKey(""); }
        }
    };
    const cancel = () => {
        active.current?.abort(); active.current = null; setReadingKey("");
        setNotice({ key: requestKey, error: false, text: "已取消本次等待；迟到结果不会显示，也不会自动重试。" });
    };
    const current = data?.current[group], comparison = data?.comparison?.[group];
    const comparisonCell = (render: (value: UsageCompilationSummary) => ReactNode) => comparison ? render(comparison) : "未启用对比";
    const comparisonColumns = [
        { title: "指标", dataIndex: "label", width: 170 },
        { title: "本期", dataIndex: "current", width: 220 },
        { title: "对比期", dataIndex: "comparison", width: 220 },
    ];
    const cacheRows: ComparisonRow[] = current ? [
        ["requests", "编译记录数"], ["linkedTasks", "当前直接关联任务数"], ["sourceCalls", "非缓存源调用记录"],
        ["cacheHits", "缓存复用记录"], ["cacheSourceOutsideScope", "缓存源位于该期范围外"], ["cacheSourceMissing", "缓存源缺失 / 无法核对"],
    ].map(([key, label]) => ({ key, label, current: numberText(current[key as keyof UsageCompilationSummary] as number), comparison: comparisonCell(value => numberText(value[key as keyof UsageCompilationSummary] as number)) })) : [];
    const usageRows: ComparisonRow[] = current ? [
        { key: "input", label: "源调用输入 Token", current: tokenText(current.inputTokens), comparison: comparisonCell(value => tokenText(value.inputTokens)) },
        { key: "output", label: "源调用输出 Token", current: tokenText(current.outputTokens), comparison: comparisonCell(value => tokenText(value.outputTokens)) },
        { key: "complete", label: "输入 / 输出均有值", current: `${current.completeTokenCalls} / ${current.sourceCalls} 次源调用`, comparison: comparisonCell(value => `${value.completeTokenCalls} / ${value.sourceCalls} 次源调用`) },
        ...(["meanMs", "p50Ms", "p90Ms"] as const).map((key, index) => ({ key, label: ["源调用平均耗时", "源调用 P50 耗时", "源调用 P90 耗时"][index], current: latencyText(current, key), comparison: comparisonCell(value => latencyText(value, key)) })),
    ] : [];
    const costs = current ? [
        ...current.costs.map(row => ({ ...row, period: "本期", key: `current:${row.currency}` })),
        ...(comparison?.costs.map(row => ({ ...row, period: "对比期", key: `comparison:${row.currency}` })) ?? []),
    ] : [];

    return <section className="wb-surface min-w-0 space-y-4 p-4" data-testid="usage-compilation-analysis" aria-label="独立提示词编译分析">
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
                <h3 className="font-semibold">独立提示词编译分析</h3>
                <p className="text-xs leading-5 text-[var(--muted-foreground)]">按编译创建时间统计既有记录，包含未关联任务的编译及管理员测试；不等同员工使用量。</p>
            </div>
            <div className="flex flex-wrap gap-2">
                <Button aria-label={data ? "重新读取编译统计" : "读取独立编译统计"} disabled={!allowed || unsupported.length > 0 || reading} loading={reading} onClick={() => void read()}>{data ? "重新读取编译统计" : "读取独立编译统计"}</Button>
                {reading ? <Button onClick={cancel}>取消编译统计读取</Button> : null}
            </div>
        </div>
        {!allowed ? <Alert type="warning" showIcon title="仅当前已登录的超级管理员可读取此统计" />
            : unsupported.length ? <Alert type="warning" showIcon title="当前共享筛选不支持独立编译口径" description={`不支持：${unsupported.join("、")}。未发出请求，也未清空共享筛选。可使用日期、人员、姓名搜索及当前部门；如需读取，请先明确调整并应用共享筛选。`} />
                : <p className="text-xs leading-5 text-[var(--muted-foreground)]">仅点击后读取已应用的共享筛选；日期采用北京时间、左闭右开区间。切换范围或刷新主页面后需重新点击，不自动读取提示词、规则、原始错误或员工明细，不调用模型。</p>}
        {notice?.key === requestKey ? <Alert type={notice.error ? "error" : "info"} showIcon title={notice.text} /> : null}
        {reading ? <p role="status" className="text-sm">正在读取编译统计…可取消等待或切换筛选。</p> : null}
        {!data && !reading && allowed && !unsupported.length && !notice ? <p className="text-sm text-[var(--muted-foreground)]">尚未读取独立编译统计。</p> : null}
        {data && current ? <div className="min-w-0 space-y-4" data-testid="usage-compilation-results">
            <div className="space-y-1 text-xs leading-5 text-[var(--muted-foreground)]">
                <p>观察点：{dateText(data.meta.asOf)}（北京时间）；实时读取既有编译记录，不是日汇总快照。</p>
                <p>本期：{dateText(data.current.from)}（含）至 {dateText(data.current.to)}（不含）。</p>
                <p>{data.comparison ? `对比期：${dateText(data.comparison.from)}（含）至 ${dateText(data.comparison.to)}（不含）。` : "未启用对比；不补造对比期。"}</p>
            </div>
            <div className="grid min-w-0 gap-3 lg:grid-cols-3">
                {(Object.keys(groups) as Group[]).map(key => {
                    const now = data.current[key], prior = data.comparison?.[key];
                    return <article key={key} className="min-w-0 space-y-2 rounded-lg border border-[var(--border)] p-3" data-testid={`usage-compilation-group-${key}`}>
                        <h4 className="text-sm font-medium">{groups[key]}</h4>
                        <p className="text-2xl font-semibold tabular-nums">{numberText(now.requests)} <span className="text-xs font-normal">条本期编译记录</span></p>
                        <p className="text-xs">{prior ? `对比期 ${numberText(prior.requests)} 条` : "对比期未启用"}</p>
                        <p className="text-xs leading-5">本期管理员测试：是 {now.adminTests.yes} · 否 {now.adminTests.no} · 未知 {now.adminTests.unknown}</p>
                        {prior ? <p className="text-xs leading-5">对比期管理员测试：是 {prior.adminTests.yes} · 否 {prior.adminTests.no} · 未知 {prior.adminTests.unknown}</p> : null}
                    </article>;
                })}
            </div>
            <p className="text-xs leading-5 text-[var(--muted-foreground)]">已关联 / 未关联仅按当前观察点、同用户任务的真实编译外键区分；关联任务不限定创建于编译期内。未关联不代表从未提交、放弃或无价值；全部组包含另外两组，三组不能相加。</p>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-medium">{groups[group]} · 分组明细</h4>
                <Select aria-label="编译分组详情" className="w-full sm:w-56" value={group} onChange={setGroup} options={(Object.keys(groups) as Group[]).map(value => ({ value, label: groups[value] }))} />
            </div>
            <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                <section className="min-w-0 space-y-2" aria-label="编译关联与缓存">
                    <h5 className="text-sm font-medium">关联与缓存</h5>
                    <Table<ComparisonRow> data-testid="usage-compilation-cache" rowKey="key" size="small" pagination={false} scroll={{ x: 610 }} columns={comparisonColumns} dataSource={cacheRows} />
                </section>
                <section className="min-w-0 space-y-2" aria-label="编译Token与耗时覆盖">
                    <h5 className="text-sm font-medium">源调用 Token 与耗时覆盖</h5>
                    <Table<ComparisonRow> data-testid="usage-compilation-coverage" rowKey="key" size="small" pagination={false} scroll={{ x: 610 }} columns={comparisonColumns} dataSource={usageRows} />
                </section>
            </div>
            <p className="text-xs leading-5 text-[var(--muted-foreground)]">源调用仅指该期、该分组原筛选内的非缓存编译记录，不证明供应商已接受或扣费。源记录与缓存记录各按自己的直接任务外键分组，因此已关联组可能只有缓存，而源费用位于未关联组。缓存只计复用，不重复计 Token、耗时或费用；跨期缓存源的旧调用费用不挪入本期。耗时为编译器记录，不是员工工时。</p>
            <section className="min-w-0 space-y-2" aria-label="编译状态分布">
                <h5 className="text-sm font-medium">状态分开列示</h5>
                <Table data-testid="usage-compilation-statuses" rowKey="key" size="small" pagination={false} scroll={{ x: 760 }}
                    dataSource={USAGE_COMPILATION_STATUSES.map(key => ({ key, label: statuses[key] }))}
                    columns={[
                        { title: "状态", dataIndex: "label", width: 120 },
                        { title: "本期 · 全部记录（含缓存）", render: (_, row) => numberText(current.statuses[row.key]) },
                        { title: "对比期 · 全部记录（含缓存）", render: (_, row) => comparisonCell(value => numberText(value.statuses[row.key])) },
                        { title: "本期 · 源调用记录", render: (_, row) => numberText(current.sourceStatuses[row.key]) },
                        { title: "对比期 · 源调用记录", render: (_, row) => comparisonCell(value => numberText(value.sourceStatuses[row.key])) },
                    ]} />
                <p className="text-xs leading-5 text-[var(--muted-foreground)]">待核查不并入失败；缓存状态跟随可核对的源记录。成功可能包含基础模板回退，不等同优化成功或图片生成成功。</p>
            </section>
            <section className="min-w-0 space-y-2" aria-label="编译源调用分币种费用">
                <h5 className="text-sm font-medium">源调用费用 · 币种与金额性质分列</h5>
                <Table data-testid="usage-compilation-costs" rowKey="key" size="small" pagination={false} scroll={{ x: 960 }} dataSource={costs}
                    locale={{ emptyText: "当前分组没有源调用费用记录；金额不可用，不补零。" }}
                    columns={[
                        { title: "时段", dataIndex: "period", width: 80 },
                        { title: "币种", dataIndex: "currency", render: value => value === "unknown" ? "未知" : value },
                        { title: "源调用记录", dataIndex: "sourceCalls" },
                        { title: "已记录金额（actual）", dataIndex: "actualAmount", render: value => value === null ? "不可用" : value },
                        { title: "估算金额（estimated）", dataIndex: "estimatedAmount", render: value => value === null ? "不可用" : value },
                        { title: "已记录笔数", dataIndex: "actualCount" }, { title: "估算笔数", dataIndex: "estimatedCount" }, { title: "未知笔数", dataIndex: "unknownCount" },
                    ]} />
                <p className="text-xs leading-5 text-[var(--muted-foreground)]">不同币种不相加、不换汇；actual 与 estimated 不合并，均不冒充最终账单。未记录金额显示不可用，明确记录的零保留原金额字符串；未知币种不补算金额。</p>
            </section>
            <details className="text-xs leading-6">
                <summary className="cursor-pointer font-medium">完整口径与缺失说明 · {data.meta.notes.length} 条</summary>
                <div className="mt-2 space-y-1 text-[var(--muted-foreground)]">{data.meta.notes.map((note, index) => <p key={index}>{note}</p>)}</div>
            </details>
        </div> : null}
    </section>;
}
