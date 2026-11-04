import { Alert, Button, Pagination, Table } from "antd";
import { useState } from "react";
import type { UsageV2Profile } from "@/services/api/usage-analytics-v2";
import { barOption, ChartPanel, DimensionTable, Heatmap, MetricCards, Trend, type Drilldown } from "./components";
import { groupActivityPage } from "./profile-timeline";
import ParameterDistribution from "./components/parameter-distribution";
import { metricText } from "./format";
import TaskDetail from "./components/task-detail";
export default function PersonProfile({ data, onBack, onPage, onDrilldown, onPrivateRecords }: { data: UsageV2Profile; onBack: () => void; onPage: (page: number) => void; onDrilldown: Drilldown; onPrivateRecords: () => void }) {
    const activityDays = groupActivityPage(data.activityPage.records);
    const scopeKey = JSON.stringify({ person: data.person.userId, scope: data.meta.scope, page: data.activityPage.pagination.page, asOf: data.meta.asOf });
    const [selectedTask, setSelectedTask] = useState<{ taskId: string; scopeKey: string } | null>(null);
    return (
        <div className="space-y-4">
            <header className="wb-surface flex flex-wrap items-start justify-between gap-3 p-5">
                <div>
                    <Button className="!mb-3 !px-0" type="link" onClick={onBack}>
                        ← 返回人员列表
                    </Button>
                    <h2 className="text-xl font-semibold">{data.person.displayName} · 个人使用画像</h2>
                    <p className="mt-1 text-sm text-[var(--muted-foreground)]">{data.person.departmentName || "未分配部门"} · 同一日期与筛选范围内的可核查记录</p>
                </div>
                <Button onClick={onPrivateRecords}>明确查看提示词与原始记录</Button>
            </header>
            <MetricCards
                metrics={data.metrics}
                keys={["activeDays", "generatedImages", "generationBookedCny", "resultUseRate", "formalAdoptionRate", "costPerUsedImage", "waitMsP50", "runMsP50", "totalMsP50", "totalMsP90", "activeSeconds", "revisionRounds"]}
            />
            <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                <Trend daily={data.daily} from={data.meta.scope.from} to={data.meta.scope.to} onDrilldown={onDrilldown} title="个人每日出图趋势" />
                <Heatmap rows={data.hourlyHeatmap} />
                <ChartPanel
                    title="常用板块记录"
                    description="展示生成任务数量，不是板块停留时间。点击柱条筛选该板块。"
                    option={barOption(
                        data.boards.map((row) => ({ label: row.label, value: row.metrics.generationRequests.value })),
                        "生成任务",
                    )}
                    onSelect={(index) => {
                        if (data.boards[index]) onDrilldown({ boardKeys: [data.boards[index].key] });
                    }}
                />
                <ChartPanel
                    title="模型使用记录"
                    description="按已记录生成任务计数，不代表模型偏好或员工能力。"
                    option={barOption(
                        data.models.map((row) => ({ label: row.label, value: row.metrics.generationRequests.value })),
                        "生成任务",
                    )}
                    onSelect={(index) => {
                        if (data.models[index]) onDrilldown({ modelConfigIds: [data.models[index].key] });
                    }}
                />
            </div>
            <DimensionTable rows={data.boards} label="个人板块" onSelect={(row) => onDrilldown({ boardKeys: [row.key] })} />
            <section className="wb-surface min-w-0 p-4" data-testid="usage-work-habits" aria-label="已记录工作习惯">
                <h3 className="mb-3 font-semibold">已记录工作习惯</h3>
                <div className="grid gap-4 md:grid-cols-3">
                    {data.habits.rates.map((row) => (
                        <div key={row.key} className="min-w-0" data-usage-metric={`${row.label}：${metricText(row.rate)}；符合范围 ${row.eligible}，有效分母 ${row.rate.denominator ?? "未提供"}，缺失 ${row.missing}。${row.rate.definition}`}>
                            <h4 className="text-sm font-medium">{row.label}</h4>
                            <p className="my-2 text-2xl font-semibold tabular-nums">{metricText(row.rate)}</p>
                            <p className="text-xs leading-5 text-[var(--muted-foreground)]">范围任务 {row.eligible}；命中 {row.matched}；有效分母 {row.rate.denominator ?? "未提供"}；缺失 / 不适用 {row.missing}</p>
                            <p className="mt-2 text-xs leading-5 text-[var(--muted-foreground)]">{row.rate.definition}</p>
                        </div>
                    ))}
                </div>
                <div className="mt-4 space-y-1 text-xs leading-5 text-[var(--muted-foreground)]">{data.habits.notes.map((note) => <p key={note}>{note}</p>)}</div>
            </section>
            <section className="wb-surface min-w-0 p-4" data-testid="usage-reference-counts" aria-label="提交的参考项数">
                <h3 className="mb-3 font-semibold">提交的参考项数</h3>
                <p className="mb-3 text-xs leading-5 text-[var(--muted-foreground)]">图片任务 {data.habits.referenceCounts.eligible}；有值任务 {data.habits.referenceCounts.eligible - data.habits.referenceCounts.missing}；缺失 / 非数组 {data.habits.referenceCounts.missing}。按 source_urls 长度计数，重复项不去重，不推断不同图片数；非图像操作排除。</p>
                <Table
                    rowKey="value"
                    dataSource={data.habits.referenceCounts.items}
                    size="small"
                    scroll={{ x: 500 }}
                    pagination={{ pageSize: 8, hideOnSinglePage: true }}
                    locale={{ emptyText: "当前范围没有可用的参考项数量记录" }}
                    columns={[
                        { title: "提交的参考项数", dataIndex: "value" },
                        { title: "任务数", dataIndex: "count" },
                        { title: "占有值图片任务", render: (_, row) => `${metricText(row.rate)}${row.rate.state === "partial" ? "（部分覆盖）" : ""}` },
                    ]}
                />
            </section>
            <ParameterDistribution rows={data.habits.parameters} title="常用参数记录 · 按板块" />
            <section className="wb-surface min-w-0 p-4">
                <h3 className="mb-3 font-semibold">活动时间线 · 按北京时间日期折叠</h3>
                <p className="mb-3 text-xs text-[var(--muted-foreground)]">只对本页已加载的记录分组，同一天可能续在相邻页；不把相邻记录推断为连续工作路径或工时。</p>
                <Alert className="mb-3" type="info" title="本页不自动加载私人提示词或图片" description="点击单条任务详情后才读取参数和结果证据；缩略图与原始提示词仍需分别点击，并校验员工、任务和素材关联。" />
                {!activityDays.length ? <p className="py-4 text-sm text-[var(--muted-foreground)]">当前页没有活动记录</p> : null}
                {activityDays.map((group, index) => (
                    <details key={`${data.person.userId}:${data.activityPage.pagination.page}:${group.day}`} open={index === 0} className="mb-3" data-testid="usage-activity-day">
                        <summary className="cursor-pointer py-2 text-sm font-medium">
                            {group.day} · 本页 {group.records.length} 条记录
                        </summary>
                        <Table
                            size="small"
                            rowKey="id"
                            pagination={false}
                            scroll={{ x: 850 }}
                            dataSource={group.records}
                            columns={[
                                { title: "时间（北京）", dataIndex: "occurredAt", render: (value) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) },
                                { title: "板块", dataIndex: "boardKey", render: (value) => value || "未关联" },
                                { title: "动作", dataIndex: "action" },
                                { title: "状态", dataIndex: "status" },
                                { title: "实际图片", dataIndex: "generatedImages" },
                                { title: "已记账金额", dataIndex: "bookedCny", render: (value) => (value === null ? "不可用" : `¥${value}`) },
                                { title: "提交到完成", dataIndex: "totalMs", render: (value) => (value === null ? "不可用" : `${(value / 1000).toFixed(1)} 秒`) },
                                { title: "单任务详情", render: (_, row) => {
                                    const taskId = row.kind === "task" ? /^task:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(row.id)?.[1] : null;
                                    return taskId ? <Button size="small" onClick={() => setSelectedTask({ taskId, scopeKey })}>查看任务详情</Button> : <span className="text-xs text-[var(--muted-foreground)]">{row.kind === "task" ? "缺少稳定任务标识" : "非生成任务"}</span>;
                                } },
                            ]}
                        />
                    </details>
                ))}
                <Pagination className="mt-4" current={data.activityPage.pagination.page} pageSize={data.activityPage.pagination.pageSize} total={data.activityPage.pagination.total} showSizeChanger={false} onChange={onPage} />
            </section>
            {selectedTask?.scopeKey === scopeKey ? <TaskDetail key={`${scopeKey}:${selectedTask.taskId}`} userId={data.person.userId} taskId={selectedTask.taskId} onClose={() => setSelectedTask(null)} /> : null}
        </div>
    );
}
