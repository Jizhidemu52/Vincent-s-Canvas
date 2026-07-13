import { App, Button, DatePicker, Empty, Progress, Segmented, Select, Spin, Table, Tag, Tooltip } from "antd";
import { Activity, CheckCircle2, Clock3, Coins, Download, Gauge, Image, RefreshCw, Sparkles, Target, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { designDirectionLabels, getPerformanceDashboard, updateAssetDirection, type DesignDirection, type PerformanceDashboard as DashboardData, type PerformanceFilters, type PerformancePreset } from "@/services/api/performance";

const funnelLabels = { generated: "生成", candidate: "候选", reused: "复用", downloaded: "下载", adopted: "采用", delivered: "交付" };
const presetOptions = [{ label: "今日", value: "today" }, { label: "本周", value: "week" }, { label: "本月", value: "month" }, { label: "自定义", value: "custom" }];

export function PerformanceDashboard({ teamOnly = false }: { teamOnly?: boolean }) {
  const { message } = App.useApp();
  const [preset, setPreset] = useState<PerformancePreset>("month");
  const [range, setRange] = useState<[string, string] | null>(null);
  const [selection, setSelection] = useState<Pick<PerformanceFilters, "departmentId" | "groupId" | "userId">>({});
  const [data, setData] = useState<DashboardData>();
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (preset === "custom" && !range) return;
    setLoading(true);
    try {
      setData(await getPerformanceDashboard({ preset, ...(preset === "custom" && range ? { from: range[0], to: range[1] } : {}), ...selection }));
    } catch (error) { message.error(error instanceof Error ? error.message : "设计效能数据加载失败"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [preset, range?.[0], range?.[1], selection.departmentId, selection.groupId, selection.userId]);

  const maxTrend = Math.max(1, ...(data?.trend.map((item) => item.outputs) ?? [1]));
  const filteredGroups = useMemo(() => data?.options.groups.filter((item) => !selection.departmentId || item.departmentId === selection.departmentId) ?? [], [data, selection.departmentId]);
  const filteredUsers = useMemo(() => data?.options.users.filter((item) => (!selection.departmentId || item.departmentId === selection.departmentId) && (!selection.groupId || item.groupId === selection.groupId)) ?? [], [data, selection.departmentId, selection.groupId]);

  const saveDirection = async (assetId: string, direction: DesignDirection) => {
    try { await updateAssetDirection(assetId, { primaryDirection: direction, secondaryDirections: [], adminTags: [designDirectionLabels[direction]] }); message.success("成果方向已更新并记录审计"); await load(); }
    catch (error) { message.error(error instanceof Error ? error.message : "方向更新失败"); }
  };
  const jumpToDetails = () => document.getElementById("performance-details")?.scrollIntoView({ behavior: "smooth", block: "start" });

  return <div className="space-y-4" data-testid="performance-dashboard">
    <header className="flex flex-col gap-3 border-b border-stone-200 pb-4 lg:flex-row lg:items-end lg:justify-between">
      <div><div className="text-xs font-semibold text-orange-600">设计效能</div><h2 className="mt-1 text-xl font-semibold">出图效率、成本与成果转化</h2></div>
      <Button icon={<RefreshCw className="size-4" />} onClick={() => void load()} loading={loading}>刷新</Button>
    </header>

    <div className="flex flex-wrap items-center gap-2 border-b border-stone-200 pb-4">
      <Segmented options={presetOptions} value={preset} onChange={(value) => setPreset(value as PerformancePreset)} />
      {preset === "custom" ? <DatePicker.RangePicker showTime onChange={(values) => setRange(values?.[0] && values[1] ? [values[0].toISOString(), values[1].toISOString()] : null)} /> : null}
      {!teamOnly ? <Select allowClear placeholder="部门" className="min-w-32" options={data?.options.departments} value={selection.departmentId} onChange={(departmentId) => setSelection({ departmentId, groupId: undefined, userId: undefined })} /> : null}
      {!teamOnly ? <Select allowClear placeholder="小组" className="min-w-32" options={filteredGroups} value={selection.groupId} onChange={(groupId) => setSelection((value) => ({ ...value, groupId, userId: undefined }))} /> : null}
      <Select allowClear showSearch optionFilterProp="label" placeholder="设计师" className="min-w-36" options={filteredUsers} value={selection.userId} onChange={(userId) => setSelection((value) => ({ ...value, userId }))} />
    </div>

    <Spin spinning={loading}>
      {data ? <>
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric onClick={jumpToDetails} icon={<Image className="size-4" />} label="有效出图" value={format(data.metrics.validOutputs)} sub={`提交 ${format(data.metrics.requestedOutputs)} 张`} />
          <Metric onClick={jumpToDetails} icon={<Activity className="size-4" />} label="任务成功率" value={rate(data.metrics.successRate)} sub={`成功 ${data.metrics.successCount} / 失败 ${data.metrics.failedCount} / 取消 ${data.metrics.cancelledCount}`} />
          <Metric onClick={jumpToDetails} icon={<Download className="size-4" />} label="成果下载率" value={rate(data.metrics.downloadRate)} sub="按图片首次成功下载去重" />
          <Metric onClick={jumpToDetails} icon={<Gauge className="size-4" />} label="成果可用性均分" value={nullable(data.metrics.averageUsabilityScore, " 分")} sub="单张最高 100 分" />
          <Metric onClick={jumpToDetails} icon={<TrendingUp className="size-4" />} label="自然日均 / 活跃日均" value={`${format(data.metrics.naturalDailyAverage)} / ${nullable(data.metrics.activeDailyAverage)}`} sub="活跃日为至少有一张有效成果" />
          <Metric onClick={jumpToDetails} icon={<Clock3 className="size-4" />} label="平均完成时长" value={duration(data.metrics.averageDurationSeconds)} sub={`批量完成率 ${rate(data.metrics.batchCompletionRate)}`} />
          <Metric onClick={jumpToDetails} icon={<RefreshCw className="size-4" />} label="返工率 / 按时交付率" value={`${rate(data.metrics.reworkRate)} / ${rate(data.metrics.onTimeDeliveryRate)}`} sub="采用后再编辑视为返工" />
          <Metric onClick={jumpToDetails} icon={<Coins className="size-4" />} label="积分 / 人民币成本" value={`${format(data.metrics.totalCredits)} / ¥${format(data.metrics.totalRmbCost)}`} sub={`单张 ¥${nullable(data.metrics.averageCostPerOutput)}`} />
        </section>

        {data.comparisons ? <Panel title="设计师对比" icon={<TrendingUp className="size-4" />}>
          <Table rowKey="label" size="small" pagination={false} dataSource={[
            { label: "当前选择", value: data.designers[0] ?? null }, { label: "本人上月", value: data.comparisons.previousMonth },
            { label: "同组平均", value: data.comparisons.sameGroupAverage }, { label: "部门平均", value: data.comparisons.departmentAverage },
          ]} columns={[
            { title: "对比范围", dataIndex: "label" }, { title: "有效出图", render: (_, row) => row.value ? format(row.value.outputs) : "-" },
            { title: "成功率", render: (_, row) => row.value ? rate(row.value.successRate) : "-" },
            { title: "下载率", render: (_, row) => row.value ? rate(row.value.downloadRate) : "-" },
            { title: "采用率", render: (_, row) => row.value ? rate(row.value.adoptionRate) : "-" },
            { title: "交付率", render: (_, row) => row.value ? rate(row.value.deliveryRate) : "-" },
            { title: "可用性", render: (_, row) => row.value ? nullable(row.value.usabilityScore) : "-" },
            { title: "成本", render: (_, row) => row.value ? `¥${format(row.value.rmbCost)}` : "-" },
          ]} />
        </Panel> : null}

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
          <Panel title="每日有效出图" icon={<TrendingUp className="size-4" />}>
            {data.trend.some((item) => item.outputs) ? <div className="flex h-52 items-end gap-1 overflow-x-auto pt-6">{data.trend.map((item) => <Tooltip key={item.date} title={`${item.date}：${item.outputs} 张，${item.credits} 积分`}><div className="flex min-w-5 flex-1 flex-col items-center justify-end gap-2"><div className="w-full bg-orange-500" style={{ height: `${Math.max(4, item.outputs / maxTrend * 150)}px` }} /><span className="text-[10px] text-stone-400">{item.date.slice(5)}</span></div></Tooltip>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前时间范围暂无有效出图" />}
          </Panel>
          <Panel title="成果转化漏斗" icon={<Target className="size-4" />}>
            <div className="space-y-3">{data.funnel.map((item) => <div key={item.stage}><div className="mb-1 flex justify-between text-sm"><span>{funnelLabels[item.stage]}</span><span className="font-medium">{item.count} · {rate(item.rate)}</span></div><Progress percent={item.rate ?? 0} showInfo={false} strokeColor="#f97316" railColor="#f5f5f4" /></div>)}</div>
          </Panel>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <Panel title="主要出图方向" icon={<Sparkles className="size-4" />}>
            {data.directions.length ? <div className="space-y-3">{data.directions.map((item) => <div key={item.direction}><div className="mb-1 flex justify-between text-sm"><span>{designDirectionLabels[item.direction]}</span><span>{item.count} 张 · {rate(item.rate)}</span></div><Progress percent={item.rate ?? 0} showInfo={false} strokeColor="#fb923c" /></div>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可分类成果" />}
          </Panel>
          <Panel title="失败原因" icon={<Activity className="size-4" />}>
            {data.failureReasons.length ? <div className="divide-y divide-stone-100">{data.failureReasons.map((item) => <div key={item.reason} className="flex justify-between py-3 text-sm"><span>{item.reason}</span><Tag color="red">{item.count}</Tag></div>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前范围无失败任务" />}
          </Panel>
        </section>

        <Panel title="设计师效能" icon={<CheckCircle2 className="size-4" />}>
          <Table rowKey="userId" size="small" scroll={{ x: 1080 }} pagination={{ pageSize: 20 }} dataSource={data.designers} columns={[
            { title: "设计师", dataIndex: "userName", fixed: "left", width: 120 }, { title: "部门 / 小组", width: 180, render: (_, row) => `${row.departmentName || "-"} / ${row.groupName || "-"}` },
            { title: "有效出图", dataIndex: "outputs", sorter: (a, b) => a.outputs - b.outputs }, { title: "成功率", dataIndex: "successRate", render: rate },
            { title: "下载率", dataIndex: "downloadRate", render: rate }, { title: "复用率", dataIndex: "reuseRate", render: rate },
            { title: "采用率", dataIndex: "adoptionRate", render: rate }, { title: "交付率", dataIndex: "deliveryRate", render: rate },
            { title: "可用性", dataIndex: "usabilityScore", render: (value) => nullable(value) }, { title: "积分", dataIndex: "credits" },
            { title: "成本", dataIndex: "rmbCost", render: (value) => `¥${format(value)}` },
            { title: "主要方向", dataIndex: "topDirection", render: (value: DesignDirection | "unclassified" | null) => value && value !== "unclassified" ? designDirectionLabels[value] : "未分类" },
          ]} />
        </Panel>

        <div id="performance-details" className="scroll-mt-4"><Panel title="任务明细" icon={<Activity className="size-4" />}>
          <Table rowKey="id" size="small" scroll={{ x: 1050 }} pagination={{ pageSize: 20 }} dataSource={data.tasks} columns={[
            { title: "提交时间", dataIndex: "queuedAt", width: 170, render: (value: string) => new Date(value).toLocaleString("zh-CN") },
            { title: "设计师", dataIndex: "userName", width: 110 }, { title: "板块", dataIndex: "operationType", width: 130 },
            { title: "模型", dataIndex: "modelName", width: 130, render: (value) => value || "-" },
            { title: "完整提示词", dataIndex: "prompt", width: 320, ellipsis: true }, { title: "状态", dataIndex: "status", width: 90 },
            { title: "积分", dataIndex: "credits", width: 80 }, { title: "成本", dataIndex: "rmbCost", width: 90, render: (value) => `¥${format(value)}` },
            { title: "失败原因", dataIndex: "failureReason", width: 180, render: (value) => value || "-" },
          ]} />
        </Panel></div>

        <Panel title="成果明细与完整提示词" icon={<Image className="size-4" />}>
          <Table rowKey="id" size="small" scroll={{ x: 1280 }} pagination={{ pageSize: 20 }} dataSource={data.assets} columns={[
            { title: "生成时间", dataIndex: "createdAt", width: 170, render: (value: string) => new Date(value).toLocaleString("zh-CN") },
            { title: "设计师", dataIndex: "userName", width: 110 }, { title: "项目", dataIndex: "projectName", width: 130, render: (value) => value || "-" },
            { title: "板块", dataIndex: "operationType", width: 120, render: (value) => value || "-" }, { title: "模型", dataIndex: "modelName", width: 130, render: (value) => value || "-" },
            { title: "完整提示词", dataIndex: "prompt", width: 360, ellipsis: true },
            { title: "方向", dataIndex: "primaryDirection", width: 150, render: (value: DesignDirection | null, row) => <Select size="small" className="w-32" value={value ?? undefined} placeholder="未分类" options={Object.entries(designDirectionLabels).map(([key, label]) => ({ value: key, label }))} onChange={(direction) => void saveDirection(row.id, direction)} /> },
            { title: "可用性", dataIndex: "usabilityScore", width: 90, render: (value) => <Tag color={value >= 40 ? "green" : value > 0 ? "orange" : "default"}>{value} 分</Tag> },
            { title: "状态", dataIndex: "resultStatus", width: 90 },
          ]} />
        </Panel>
      </> : <Empty description="暂无设计效能数据" />}
    </Spin>
  </div>;
}

function Metric({ icon, label, value, sub, onClick }: { icon: ReactNode; label: string; value: string; sub: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="min-h-28 border border-stone-200 bg-white px-4 py-3 text-left transition hover:border-orange-400 hover:bg-orange-50/40"><div className="flex items-center gap-2 text-xs text-stone-500">{icon}{label}</div><div className="mt-2 text-xl font-semibold text-stone-950">{value}</div><div className="mt-1 text-xs text-stone-400">{sub}</div></button>;
}
function Panel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) { return <section className="border border-stone-200 bg-white"><div className="flex items-center gap-2 border-b border-stone-200 px-4 py-3 font-semibold">{icon}{title}</div><div className="p-4">{children}</div></section>; }
function rate(value: number | null) { return value === null ? "-" : `${format(value)}%`; }
function nullable(value: number | null, suffix = "") { return value === null ? "-" : `${format(value)}${suffix}`; }
function format(value: number) { return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 }); }
function duration(value: number | null) { if (value === null) return "-"; if (value < 60) return `${value} 秒`; if (value < 3600) return `${Math.round(value / 60)} 分钟`; return `${format(value / 3600)} 小时`; }
