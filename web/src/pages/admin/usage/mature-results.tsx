import { Alert, Button, Select, Table } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
    getUsageMatureResults,
    type UsageMaturePeriod,
    type UsageMatureResults,
    type UsageMatureSummary,
} from "@/services/api/usage-mature-results";
import type { UsageV2Scope } from "@/services/api/usage-analytics-v2";
import { useUserStore } from "@/stores/use-user-store";

const groups = { all: "全部成熟任务", explicit_link: "有明确编译关联", no_explicit_marker: "无明确关联标记" } as const;
type Group = keyof typeof groups;
type Row = { key: string; label: string; current: ReactNode; comparison: ReactNode };
const countText = (value: number) => value.toLocaleString("zh-CN");
const dateText = (value: string) =>
    new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const moneyText = (value: string | null, state: string) =>
    value === null ? "不可用" : `¥${value}${state === "partial" ? " · 部分覆盖" : ""}`;
const rateText = (summary: UsageMatureSummary, adoption = false) => {
    const rate = adoption ? summary.adoptionRate : summary.useRate,
        numerator = adoption ? summary.formallyAdoptedResults : summary.usedResults;
    return rate.value === null
        ? `不可用 · 已记录 ${countText(numerator)} / 已保存 ${countText(summary.generatedResults)}`
        : `${(rate.value * 100).toFixed(1)}% · ${countText(numerator)} / ${countText(summary.generatedResults)}${rate.state === "partial" ? " · 部分覆盖" : ""}`;
};
const summaryFor = (period: UsageMaturePeriod, group: Group) =>
    group === "all" ? period.all : period.optimizationGroups.find((item) => item.key === group)!.summary;

/** Independent explicit read; identity/scope changes or unmount discard both pending and displayed data. */
export default function MatureResults({ scope }: { scope: UsageV2Scope }) {
    const user = useUserStore((state) => state.user),
        sessionStatus = useUserStore((state) => state.status);
    const allowed = sessionStatus === "authenticated" && user?.role === "super_admin";
    const requestKey = JSON.stringify({ scope, identity: user?.id, role: user?.role, sessionStatus });
    const [view, setView] = useState<{ key: string; data: UsageMatureResults } | null>(null);
    const [readingKey, setReadingKey] = useState("");
    const [notice, setNotice] = useState<{ key: string; text: string; error: boolean } | null>(null);
    const [group, setGroup] = useState<Group>("all");
    const active = useRef<AbortController | null>(null),
        latestKey = useRef(requestKey);
    latestKey.current = requestKey;
    const data = allowed && view?.key === requestKey ? view.data : null,
        reading = allowed && readingKey === requestKey;
    useEffect(() => {
        active.current?.abort();
        active.current = null;
        setView(null);
        setReadingKey("");
        setNotice(null);
        setGroup("all");
        return () => {
            active.current?.abort();
            active.current = null;
        };
    }, [requestKey]);
    const read = async () => {
        if (!allowed || active.current) return;
        const controller = new AbortController();
        active.current = controller;
        setReadingKey(requestKey);
        setView(null);
        setNotice(null);
        try {
            const result = await getUsageMatureResults(scope, controller.signal);
            if (!controller.signal.aborted && active.current === controller && latestKey.current === requestKey)
                setView({ key: requestKey, data: result });
        } catch (failure) {
            if (!controller.signal.aborted && active.current === controller && latestKey.current === requestKey)
                setNotice({
                    key: requestKey,
                    error: true,
                    text: failure instanceof Error ? failure.message : "成熟结果窗读取未完成。",
                });
        } finally {
            if (active.current === controller) {
                active.current = null;
                setReadingKey("");
            }
        }
    };
    const cancel = () => {
        active.current?.abort();
        active.current = null;
        setReadingKey("");
        setNotice({ key: requestKey, error: false, text: "已取消本次等待；迟到结果不会显示，也不会自动重试。" });
    };
    const current = data ? summaryFor(data.current, group) : null,
        comparison = data?.comparison ? summaryFor(data.comparison, group) : null;
    const row = (key: string, label: string, render: (summary: UsageMatureSummary) => ReactNode): Row => ({
        key,
        label,
        current: current ? render(current) : "不可用",
        comparison: comparison ? render(comparison) : "未启用对比",
    });
    const columns = [
        { title: "指标", dataIndex: "label", width: 210 },
        { title: "本期", dataIndex: "current", width: 230 },
        { title: "对比期", dataIndex: "comparison", width: 230 },
    ];
    const cohortRows: Row[] = data
        ? (
              [
                  ["successfulImageTasks", "原筛选内成功图片任务"],
                  ["matureTasks", "已满 168 小时的成熟任务"],
                  ["immatureTasks", "尚未成熟（不入分母）"],
                  ["missingCompletedAtTasks", "缺完成时间（不入分母）"],
                  ["invalidTimelineTasks", "时间异常（不入分母）"],
              ] as const
          ).map(([key, label]) => ({
              key,
              label,
              current: countText(data.current.cohort[key]),
              comparison: data.comparison ? countText(data.comparison.cohort[key]) : "未启用对比",
          }))
        : [];
    const resultRows: Row[] = [
        row("generated", "最终保存去重图片结果", (value) => countText(value.generatedResults)),
        row("linked", "可绑定同员工 / 同任务资产", (value) => countText(value.linkedResults)),
        row("unknown", "无法绑定资产的结果", (value) => countText(value.unknownBindingResults)),
        row(
            "missing",
            "缺最终输出的成熟任务",
            (value) => `${countText(value.missingOutputTasks)} / ${countText(value.tasks)}`,
        ),
        row("used", "已记录使用率", (value) => rateText(value)),
        row("adopted", "正式采纳率", (value) => rateText(value, true)),
        row("none", "已绑定但窗内无使用证据", (value) => countText(value.linkedNoEvidenceResults)),
        row("client", "客户端下载 / 导出回执结果", (value) => countText(value.clientReportedUsedResults)),
        row("server", "服务端使用事件结果", (value) => countText(value.serverConfirmedUsedResults)),
    ];
    const costRows: Row[] = [
        row("booked", "成熟队列已记账金额（CNY）", (value) => moneyText(value.cost.bookedAmount, value.cost.state)),
        row(
            "coverage",
            "有记账 / 缺记账的成熟任务",
            (value) => `${countText(value.cost.settledTasks)} / ${countText(value.cost.missingSettlementTasks)}`,
        ),
        row("perUsed", "每已记录使用结果费用（CNY）", (value) =>
            moneyText(value.cost.perRecordedUsedResult, value.cost.perUsedState),
        ),
    ];
    const diagnostics: Row[] = [
        row("before", "完成前事件（不计使用）", (value) => countText(value.beforeCompletionEvents)),
        row("events", "窗内事件记录（含已撤销）", (value) => countText(value.windowEvents)),
        row("reversed", "截止前已有效撤销事件", (value) => countText(value.reversedWindowEvents)),
    ];

    return (
        <section
            className="wb-surface min-w-0 space-y-4 p-4"
            data-testid="usage-mature-results"
            aria-label="7 日成熟结果窗"
        >
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                    <h3 className="font-semibold">7 日成熟结果窗</h3>
                    <p className="text-xs leading-5 text-[var(--muted-foreground)]">
                        按原提交范围选成功图片任务；每项任务完成后观察固定 168
                        小时，单独查看结果使用、正式采纳与已记账费用。
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button
                        aria-label={data ? "重新读取成熟结果" : "读取 7 日成熟结果"}
                        aria-busy={reading}
                        disabled={!allowed || reading}
                        loading={reading}
                        onClick={() => void read()}
                    >
                        {data ? "重新读取成熟结果" : "读取 7 日成熟结果"}
                    </Button>
                    {reading ? <Button onClick={cancel}>取消成熟窗读取</Button> : null}
                </div>
            </div>
            {!allowed ? (
                <Alert type="warning" showIcon title="仅当前已登录的超级管理员可读取成熟结果窗" />
            ) : (
                <p className="text-xs leading-5 text-[var(--muted-foreground)]">
                    仅点击后读取已应用的全部共享筛选。本区不读取提示词或图片，不调用模型、不触发重算；切换范围或刷新主页面后须重新点击。
                </p>
            )}
            {notice?.key === requestKey ? (
                <Alert type={notice.error ? "error" : "info"} showIcon title={notice.text} />
            ) : null}
            {reading ? (
                <p role="status" className="text-sm">
                    正在读取成熟结果窗…可取消等待或切换筛选。
                </p>
            ) : null}
            {!data && !reading && allowed && !notice ? (
                <p className="text-sm text-[var(--muted-foreground)]">尚未读取 7 日成熟结果。</p>
            ) : null}
            {data && current ? (
                <div className="min-w-0 space-y-4" data-testid="usage-mature-data">
                    <Alert
                        type="info"
                        showIcon
                        title="等长观察不等于完整采集，也不能推断优化因果效果"
                        description="这是独立成熟队列，不替代上方全局指标，不重新开启全局涨跌。未记录不等于未使用；无明确关联标记不等于从未优化，不用于人员绩效评价。"
                    />
                    <div className="space-y-1 text-xs leading-5 text-[var(--muted-foreground)]">
                        <p>
                            独立观察点：{dateText(data.meta.asOf)}
                            （北京时间）；本期和对比期来自同一次只读事务，不是日汇总快照。
                        </p>
                        <p>
                            本期提交范围：{dateText(data.current.from)}（含）至 {dateText(data.current.to)}（不含）。
                        </p>
                        <p>
                            {data.comparison
                                ? `对比期提交范围：${dateText(data.comparison.from)}（含）至 ${dateText(data.comparison.to)}（不含）。`
                                : "未启用对比；不补造对比期。"}
                        </p>
                    </div>
                    <section className="min-w-0 space-y-2" aria-label="成熟任务与排除项">
                        <h4 className="text-sm font-medium">成熟任务与排除项</h4>
                        <p className="text-xs leading-5 text-[var(--muted-foreground)]">
                            窄屏表格可横向滚动，查看完整数值与对比期。
                        </p>
                        <Table<Row>
                            data-testid="usage-mature-cohort"
                            rowKey="key"
                            size="small"
                            pagination={false}
                            scroll={{ x: 670 }}
                            columns={columns}
                            dataSource={cohortRows}
                        />
                        <p className="text-xs leading-5 text-[var(--muted-foreground)]">
                            成熟以任务完成时间为起点。仅计 [完成时刻，完成后 168 小时)
                            内事件；截止前有效撤销才扣除，恰在截止点或第 8 天撤销不抹掉第 7 天证据。完成前事件另列诊断。
                        </p>
                    </section>
                    <div className="grid min-w-0 gap-3 lg:grid-cols-3">
                        {(Object.keys(groups) as Group[]).map((key) => {
                            const now = summaryFor(data.current, key),
                                prior = data.comparison ? summaryFor(data.comparison, key) : null;
                            return (
                                <article
                                    key={key}
                                    className="min-w-0 space-y-1 rounded-lg border border-[var(--border)] p-3"
                                >
                                    <h4 className="text-sm font-medium">{groups[key]}</h4>
                                    <p className="text-lg font-semibold tabular-nums">
                                        本期 {countText(now.tasks)}{" "}
                                        <span className="text-xs font-normal">项成熟任务</span>
                                    </p>
                                    <p className="text-xs">
                                        {prior ? `对比期 ${countText(prior.tasks)} 项成熟任务` : "对比期未启用"}
                                    </p>
                                </article>
                            );
                        })}
                    </div>
                    <p className="text-xs leading-5 text-[var(--muted-foreground)]">
                        “有明确编译关联”须有同用户真实编译外键；另外一组只表示无明确标记。全部组包含另外两组，不能相加。分组可能混合不同模型、板块及操作，不能据此声称优化改善了结果。
                    </p>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="font-medium">{groups[group]} · 结果与费用</h4>
                        <Select
                            aria-label="成熟结果分组"
                            className="w-full sm:w-56"
                            value={group}
                            onChange={setGroup}
                            options={(Object.keys(groups) as Group[]).map((value) => ({ value, label: groups[value] }))}
                        />
                    </div>
                    <section className="min-w-0 space-y-2" aria-label="成熟结果证据与覆盖">
                        <Table<Row>
                            data-testid="usage-mature-evidence"
                            rowKey="key"
                            size="small"
                            pagination={false}
                            scroll={{ x: 670 }}
                            columns={columns}
                            dataSource={resultRows}
                        />
                        <p className="text-xs leading-5 text-[var(--muted-foreground)]">
                            比例分母为成熟任务最终保存的去重图片，包含未知绑定；同任务同用户的原图 /
                            导出副本按结果序号去重。缺最终输出不补造分母；全部无法绑定时使用率 /
                            采纳率不可用，部分缺失明确标注部分覆盖，不把未知当零。
                        </p>
                        <p className="text-xs leading-5 text-[var(--muted-foreground)]">
                            下载 / 导出是客户端回执；加入项目、复用、采纳 /
                            交付是服务端事件。各证据类别可以重叠，不能相加，也不保证实际落盘、完成后续设计或业务交付。窗内无记录只表示没有已记录证据。
                        </p>
                    </section>
                    <section className="min-w-0 space-y-2" aria-label="成熟队列已记账费用">
                        <Table<Row>
                            data-testid="usage-mature-costs"
                            rowKey="key"
                            size="small"
                            pagination={false}
                            scroll={{ x: 670 }}
                            columns={columns}
                            dataSource={costRows}
                        />
                        <p className="text-xs leading-5 text-[var(--muted-foreground)]">
                            每已记录使用结果费用 = 成熟队列全部已记账金额 /
                            已记录使用结果数，不是已用图片自身成本或供应商实付。只取同队列已记账
                            CNY，不按现价补算；缺结算不是零，零分母不可用，已记录的零金额保留。
                        </p>
                    </section>
                    <details className="min-w-0 text-xs leading-6">
                        <summary className="cursor-pointer font-medium">事件诊断与完整口径说明</summary>
                        <div className="mt-2 min-w-0 space-y-3">
                            <Table<Row>
                                rowKey="key"
                                size="small"
                                pagination={false}
                                scroll={{ x: 670 }}
                                columns={columns}
                                dataSource={diagnostics}
                            />
                            <p className="text-[var(--muted-foreground)]">
                                这是现存数据库对历史窗口的重建，不承诺历史不可变；事件条数不是去重结果数。
                            </p>
                            <div className="space-y-1 text-[var(--muted-foreground)]">
                                {data.meta.notes.map((note, index) => (
                                    <p key={index}>{note}</p>
                                ))}
                            </div>
                        </div>
                    </details>
                </div>
            ) : null}
        </section>
    );
}
