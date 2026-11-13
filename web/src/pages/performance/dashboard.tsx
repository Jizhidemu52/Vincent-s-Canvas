import { DisplayText, displayNotice, useDisplayUiValue, useDisplayConfig } from "@/hooks/use-display-text";
import { staticUiText, staticUiConfig } from "@/lib/static-ui-copy";
import { getUiLocale, useUiLocale } from "@/lib/i18n";
import { Alert, App, Button, DatePicker, Empty, Progress, Segmented, Select, Spin, Table, Tag, Tooltip } from "antd";
import { Activity, CheckCircle2, Clock3, Image, RefreshCw, Sparkles, Target, TrendingUp, UsersRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { formatBeijingDateTime } from "@/lib/beijing-time";

import { designDirectionLabels, getPerformanceDashboard, updateAssetDirection, type DesignDirection, type PerformanceDashboard as DashboardData, type PerformanceFilters, type PerformancePreset } from "@/services/api/performance";

const funnelLabels = { generated: "生成", candidate: "候选", reused: "复用", downloaded: "下载", adopted: "采用", delivered: "交付" };
const presetOptions = [{ label: "今日", value: "today" }, { label: "本周", value: "week" }, { label: "本月", value: "month" }, { label: "自定义", value: "custom" }];

export function PerformanceDashboard({ teamOnly = false }: { teamOnly?: boolean }) {
    const displayUi = useDisplayUiValue();
    const displayConfig = useDisplayConfig();
    useUiLocale();
  const { message } = App.useApp();
  const [preset, setPreset] = useState<PerformancePreset>("month");
  const [range, setRange] = useState<[string, string] | null>(null);
  const [selection, setSelection] = useState<Pick<PerformanceFilters, "departmentId" | "groupId" | "userId">>({});
  const [data, setData] = useState<DashboardData>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const requestSequence = useRef(0);

  const load = async () => {
    const sequence = ++requestSequence.current;
    if (preset === "custom" && !range) { setLoading(false); return; }
    setLoading(true); setLoadError("");
    try {
      const result = await getPerformanceDashboard({ preset, ...(preset === "custom" && range ? { from: range[0], to: range[1] } : {}), ...selection });
      if (sequence === requestSequence.current) setData(result);
    } catch (error) { if (sequence === requestSequence.current) setLoadError(error instanceof Error ? error.message : "设计效能数据加载失败"); }
    finally { if (sequence === requestSequence.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { requestSequence.current++; }; }, [preset, range?.[0], range?.[1], selection.departmentId, selection.groupId, selection.userId]);

  const maxTrend = Math.max(1, ...(data?.trend.map((item) => item.outputs) ?? [1]));
  const filteredGroups = useMemo(() => data?.options.groups.filter((item) => !selection.departmentId || item.departmentId === selection.departmentId) ?? [], [data, selection.departmentId]);
  const filteredUsers = useMemo(() => data?.options.users.filter((item) => (!selection.departmentId || item.departmentId === selection.departmentId) && (!selection.groupId || item.groupId === selection.groupId)) ?? [], [data, selection.departmentId, selection.groupId]);

  const saveDirection = async (assetId: string, direction: DesignDirection) => {
    try { await updateAssetDirection(assetId, { primaryDirection: direction, secondaryDirections: [], adminTags: [designDirectionLabels[direction]] }); message.success(displayNotice(staticUiText("成果方向已更新并记录审计"))); await load(); }
    catch (error) { message.error(displayNotice(error instanceof Error ? error.message : staticUiText("方向更新失败"))); }
  };
  const jumpToDetails = () => document.getElementById("performance-details")?.scrollIntoView({ behavior: "smooth", block: "start" });

  return <div className="space-y-4" data-testid="performance-dashboard">
    <header className="flex flex-col gap-3 border-b border-stone-200 pb-4 lg:flex-row lg:items-end lg:justify-between">
      <div><div className="text-xs font-semibold text-orange-600">{staticUiText("设计效能")}</div><h2 className="mt-1 text-xl font-semibold">{staticUiText("出图效率与成果转化")}</h2></div>
      <Button icon={<RefreshCw className="size-4" />} onClick={() => void load()} loading={loading}>{staticUiText("刷新")}</Button>
    </header>

    <div className="flex flex-wrap items-center gap-2 border-b border-stone-200 pb-4">
      <Segmented options={displayConfig(staticUiConfig(presetOptions, "options"), "options")} value={preset} onChange={(value) => setPreset(value as PerformancePreset)} />
      {preset === "custom" ? <DatePicker.RangePicker showTime onChange={(values) => setRange(values?.[0] && values[1] ? [values[0].toISOString(), values[1].toISOString()] : null)} /> : null}
      {!teamOnly ? <Select allowClear placeholder={staticUiText("部门")} className="min-w-32" options={displayConfig(data?.options.departments, "options")} value={selection.departmentId} onChange={(departmentId) => setSelection({ departmentId, groupId: undefined, userId: undefined })} /> : null}
      {!teamOnly ? <Select allowClear placeholder={staticUiText("小组")} className="min-w-32" options={displayConfig(filteredGroups, "options")} value={selection.groupId} onChange={(groupId) => setSelection((value) => ({ ...value, groupId, userId: undefined }))} /> : null}
      <Select allowClear showSearch optionFilterProp="label" placeholder={staticUiText("设计师")} className="min-w-36" options={displayConfig(filteredUsers, "options")} value={selection.userId} onChange={(userId) => setSelection((value) => ({ ...value, userId }))} />
    </div>

    {loadError ? <Alert type="error" showIcon title={staticUiText("设计效能数据暂未更新")} description={displayUi(loadError)} action={<Button loading={loading} onClick={() => void load()}>{staticUiText("重试")}</Button>} /> : null}
    <Spin spinning={loading}>
      {data ? <>
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric onClick={jumpToDetails} icon={<Image className="size-4" />} label={staticUiText("有效出图")} value={format(data.metrics.validOutputs)} sub={`提交 ${format(data.metrics.requestedOutputs)} 张`} />
          <Metric onClick={jumpToDetails} icon={<Activity className="size-4" />} label={staticUiText("任务成功率")} value={rate(data.metrics.successRate)} sub={`成功 ${data.metrics.successCount} / 失败 ${data.metrics.failedCount} / 取消 ${data.metrics.cancelledCount}`} />
          <Metric icon={<UsersRound className="size-4" />} label={staticUiText("今日使用人数")} value={data.todayUsage ? format(data.todayUsage.users) : "—"} sub="北京时间今日 · 按账号去重，不随日期筛选变化" />
          <Metric onClick={jumpToDetails} icon={<TrendingUp className="size-4" />} label={staticUiText("自然日均 / 活跃日均")} value={`${format(data.metrics.naturalDailyAverage)} / ${nullable(data.metrics.activeDailyAverage)}`} sub="活跃日为至少有一张有效成果" />
          <Metric onClick={jumpToDetails} icon={<Clock3 className="size-4" />} label={staticUiText("平均完成时长")} value={duration(data.metrics.averageDurationSeconds)} sub={`批量完成率 ${rate(data.metrics.batchCompletionRate)}`} />
        </section>

        {data.comparisons ? <Panel title={staticUiText("设计师对比")} icon={<TrendingUp className="size-4" />}>
          <Table rowKey="label" size="small" pagination={false} dataSource={[
            { label: "当前选择", value: data.designers[0] ?? null }, { label: "本人上月", value: data.comparisons.previousMonth },
            { label: "同组平均", value: data.comparisons.sameGroupAverage }, { label: "部门平均", value: data.comparisons.departmentAverage },
          ]} columns={displayConfig([
            { title: staticUiText("对比范围"), dataIndex: "label" }, { title: staticUiText("有效出图"), render: (_, row) => row.value ? format(row.value.outputs) : "-" },
            { title: staticUiText("成功率"), render: (_, row) => row.value ? rate(row.value.successRate) : "-" },
            { title: staticUiText("下载率"), render: (_, row) => row.value ? rate(row.value.downloadRate) : "-" },
            { title: staticUiText("采用率"), render: (_, row) => row.value ? rate(row.value.adoptionRate) : "-" },
            { title: staticUiText("交付率"), render: (_, row) => row.value ? rate(row.value.deliveryRate) : "-" },
            { title: staticUiText("可用性"), render: (_, row) => row.value ? nullable(row.value.usabilityScore) : "-" },
          ], "columns", [
            { label: "当前选择", value: data.designers[0] ?? null }, { label: "本人上月", value: data.comparisons.previousMonth },
            { label: "同组平均", value: data.comparisons.sameGroupAverage }, { label: "部门平均", value: data.comparisons.departmentAverage },
          ])} />
        </Panel> : null}

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
          <Panel title={staticUiText("每日有效出图")} icon={<TrendingUp className="size-4" />}>
            {data.trend.some((item) => item.outputs) ? <div className="flex h-52 items-end gap-1 overflow-x-auto pt-6">{data.trend.map((item) => <Tooltip key={item.date} title={staticUiText("{p0}：{p1} 张", { p0: `${item.date}`, p1: `${item.outputs}` })}><div className="flex min-w-5 flex-1 flex-col items-center justify-end gap-2"><div className="w-full bg-orange-500" style={{ height: `${Math.max(4, item.outputs / maxTrend * 150)}px` }} /><span className="text-[10px] text-stone-400">{item.date.slice(5)}</span></div></Tooltip>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={staticUiText("当前时间范围暂无有效出图")} />}
          </Panel>
          <Panel title={staticUiText("成果转化漏斗")} icon={<Target className="size-4" />}>
            <div className="space-y-3">{data.funnel.map((item) => <div key={item.stage}><div className="mb-1 flex justify-between text-sm"><span>{staticUiText(funnelLabels[item.stage])}</span><span className="font-medium">{item.count} · {rate(item.rate)}</span></div><Progress percent={item.rate ?? 0} showInfo={false} strokeColor="#f97316" railColor="#f5f5f4" /></div>)}</div>
          </Panel>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <Panel title={staticUiText("主要出图方向")} icon={<Sparkles className="size-4" />}>
            {data.directions.length ? <div className="space-y-3">{data.directions.map((item) => <div key={item.direction}><div className="mb-1 flex justify-between text-sm"><span>{staticUiText(designDirectionLabels[item.direction])}</span><span>{item.count}{staticUiText(" 张 · ")}{rate(item.rate)}</span></div><Progress percent={item.rate ?? 0} showInfo={false} strokeColor="#fb923c" /></div>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={staticUiText("暂无可分类成果")} />}
          </Panel>
          <Panel title={staticUiText("失败原因")} icon={<Activity className="size-4" />}>
            {data.failureReasons.length ? <div className="divide-y divide-stone-100">{data.failureReasons.map((item) => <div key={item.reason} className="flex justify-between py-3 text-sm"><span>{displayUi(item.reason)}</span><Tag color="red">{item.count}</Tag></div>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={staticUiText("当前范围无失败任务")} />}
          </Panel>
        </section>

        <Panel title={staticUiText("设计师效能")} icon={<CheckCircle2 className="size-4" />}>
          <Table rowKey="userId" size="small" scroll={{ x: 1080 }} pagination={{ pageSize: 20 }} dataSource={data.designers} columns={displayConfig([
            { title: staticUiText("设计师"), dataIndex: "userName", fixed: "left", width: 120 }, { title: staticUiText("部门 / 小组"), width: 180, render: (_, row) => <><DisplayText text={row.departmentName || "-"} /> / <DisplayText text={row.groupName || "-"} /></> },
            { title: staticUiText("有效出图"), dataIndex: "outputs", sorter: (a, b) => a.outputs - b.outputs }, { title: staticUiText("成功率"), dataIndex: "successRate", render: rate },
            { title: staticUiText("下载率"), dataIndex: "downloadRate", render: rate }, { title: staticUiText("复用率"), dataIndex: "reuseRate", render: rate },
            { title: staticUiText("采用率"), dataIndex: "adoptionRate", render: rate }, { title: staticUiText("交付率"), dataIndex: "deliveryRate", render: rate },
            { title: staticUiText("可用性"), dataIndex: "usabilityScore", render: (value) => nullable(value) },
            { title: staticUiText("主要方向"), dataIndex: "topDirection", render: (value: DesignDirection | "unclassified" | null) => value && value !== "unclassified" ? staticUiText(designDirectionLabels[value]) : staticUiText("未分类") },
          ], "columns", data.designers)} />
        </Panel>

        <div id="performance-details" className="scroll-mt-4"><Panel title={staticUiText("任务明细")} icon={<Activity className="size-4" />}>
          <Table rowKey="id" size="small" scroll={{ x: 1050 }} pagination={{ pageSize: 20 }} dataSource={data.tasks} columns={displayConfig([
            { title: staticUiText("提交时间（北京时间）"), dataIndex: "queuedAt", width: 200, render: (value: string) => formatBeijingDateTime(value) },
            { title: staticUiText("设计师"), dataIndex: "userName", width: 110 }, { title: staticUiText("板块"), dataIndex: "operationType", width: 130 },
            { title: staticUiText("模型"), dataIndex: "modelName", width: 130, render: (value) => value || "-" },
            { title: staticUiText("完整提示词"), dataIndex: "prompt", width: 320, ellipsis: true }, { title: staticUiText("状态"), dataIndex: "status", width: 90 },
            { title: staticUiText("失败原因"), dataIndex: "failureReason", width: 180, render: (value) => value || "-" },
          ], "columns", data.tasks)} />
        </Panel></div>

        <Panel title={staticUiText("成果明细与完整提示词")} icon={<Image className="size-4" />}>
          <Table rowKey="id" size="small" scroll={{ x: 1280 }} pagination={{ pageSize: 20 }} dataSource={data.assets} columns={displayConfig([
            { title: staticUiText("生成时间（北京时间）"), dataIndex: "createdAt", width: 200, render: (value: string) => formatBeijingDateTime(value) },
            { title: staticUiText("设计师"), dataIndex: "userName", width: 110 }, { title: staticUiText("项目"), dataIndex: "projectName", width: 130, render: (value) => value || "-" },
            { title: staticUiText("板块"), dataIndex: "operationType", width: 120, render: (value) => value || "-" }, { title: staticUiText("模型"), dataIndex: "modelName", width: 130, render: (value) => value || "-" },
            { title: staticUiText("完整提示词"), dataIndex: "prompt", width: 360, ellipsis: true },
            { title: staticUiText("方向"), dataIndex: "primaryDirection", width: 150, render: (value: DesignDirection | null, row) => <Select size="small" className="w-32" value={value ?? undefined} placeholder={staticUiText("未分类")} options={Object.entries(designDirectionLabels).map(([key, label]) => ({ value: key, label: staticUiText(label) }))} onChange={(direction) => void saveDirection(row.id, direction)} /> },
            { title: staticUiText("可用性"), dataIndex: "usabilityScore", width: 90, render: (value) => <Tag color={value >= 40 ? "green" : value > 0 ? "orange" : "default"}>{value}{staticUiText(" 分")}</Tag> },
            { title: staticUiText("状态"), dataIndex: "resultStatus", width: 90 },
          ], "columns", data.assets)} />
        </Panel>
      </> : !loading && !loadError ? <Empty description={staticUiText("暂无设计效能数据")} /> : null}
    </Spin>
  </div>;
}

function Metric({ icon, label, value, sub, onClick }: { icon: ReactNode; label: string; value: string; sub: string; onClick?: () => void }) {
    const displayUi = useDisplayUiValue();
  const Container = onClick ? "button" : "div";
  return <Container {...(onClick ? { type: "button" as const, onClick } : {})} className={`min-h-28 border border-stone-200 bg-white px-4 py-3 text-left${onClick ? " transition hover:border-orange-400 hover:bg-orange-50/40" : ""}`}><div className="flex items-center gap-2 text-xs text-stone-500">{icon}{displayUi(label)}</div><div className="mt-2 text-xl font-semibold text-stone-950">{value}</div><div className="mt-1 text-xs text-stone-400">{displayUi(sub)}</div></Container>;
}
function Panel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
    const displayUi = useDisplayUiValue(); return <section className="border border-stone-200 bg-white"><div className="flex items-center gap-2 border-b border-stone-200 px-4 py-3 font-semibold">{icon}{displayUi(title)}</div><div className="p-4">{children}</div></section>; }
function rate(value: number | null) { return value === null ? "-" : `${format(value)}%`; }
function nullable(value: number | null, suffix = "") { return value === null ? "-" : `${format(value)}${suffix}`; }
function format(value: number) { return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 }); }
function duration(value: number | null) { if (value === null) return "-"; const english = getUiLocale() === "en-US"; if (value < 60) return english ? `${value} s` : `${value} 秒`; if (value < 3600) return english ? `${Math.round(value / 60)} min` : `${Math.round(value / 60)} 分钟`; return english ? `${format(value / 3600)} h` : `${format(value / 3600)} 小时`; }
