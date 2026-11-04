import { Alert, Button, Input, Modal, Select, Spin, Tabs, Tag, theme } from "antd";
import { Download, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
    getUsageV2Boards,
    getUsageV2Flows,
    getUsageV2Models,
    getUsageV2Options,
    getUsageV2Overview,
    getUsageV2People,
    getUsageV2Profile,
    getUsageV2Quality,
    type UsageV2Boards,
    type UsageV2Flows,
    type UsageV2Models,
    type UsageV2Options,
    type UsageV2Overview,
    type UsageV2People,
    type UsageV2PeopleSort,
    type UsageV2Profile,
    type UsageV2Quality,
    type UsageV2Scope,
} from "@/services/api/usage-analytics-v2";
import { getUsagePerson, UsageAnalyticsError, type UsagePersonResult } from "@/services/api/usage-analytics";
import { useUserStore } from "@/stores/use-user-store";
import { beijingDay, datePreset, legacyUsageScope, readUsageLocation, usageQuery, usageTabs, writeUsageLocation, type UsageFilterForm, type UsageTab } from "./filters";
import { Coverage } from "./components";
import { metricLabels, metricText, snapshotText } from "./format";
import { exportDashboard, exportExcel, type ExportRow } from "./exports";
import { LegacyActions } from "./legacy-actions";
import Overview from "./overview";
import People from "./people";
import PersonProfile from "./person-profile";
import Boards from "./boards";
import Models from "./models";
import Quality from "./quality";
import Flows from "./flows";
import RollupActions from "./rollup-actions";
import ReportActions from "./report-actions";
const LegacyPanel = lazy(() => import("../components/usage-analytics-panel").then((module) => ({ default: module.UsageAnalyticsPanel })));

type PageData = UsageV2Overview | UsageV2People | UsageV2Profile | UsageV2Boards | UsageV2Models | UsageV2Quality | UsageV2Flows;
const arrayFields = ["departmentIds", "userIds", "boardKeys", "modelConfigIds", "operationTypes"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function exportRows(data: PageData, tab: UsageTab, profile = false): ExportRow[] {
    const metrics = (value: import("@/services/api/usage-analytics-v2").UsageV2Metrics): ExportRow => Object.fromEntries(Object.entries(value).map(([key, metric]) => [metricLabels[key as keyof typeof metricLabels] || key, metricText(metric)]));
    if (profile)
        return (data as UsageV2Profile).activityPage.records.map((row) => ({
            时间: row.occurredAt,
            板块: row.boardKey,
            类型: row.kind,
            动作: row.action,
            状态: row.status,
            成功图片: row.generatedImages,
            已记账人民币: row.bookedCny,
            提交到完成毫秒: row.totalMs,
        }));
    if (tab === "people") return (data as UsageV2People).people.map((row) => ({ 姓名: row.displayName, 当前部门: row.departmentName, 最后记录: row.lastActivityAt, ...metrics(row.metrics) }));
    if (tab === "boards") return (data as UsageV2Boards).boards.map((row) => ({ 板块: row.label, ...metrics(row.metrics) }));
    if (tab === "models") return (data as UsageV2Models).models.map((row) => ({ 模型: row.label, 操作类型: row.operationType, 板块: row.boardKey, ...metrics(row.metrics) }));
    if (tab === "quality") return (data as UsageV2Quality).failures.map((row) => ({ 失败分类: row.label, 模型: row.modelConfigId, 板块: row.boardKey, 操作类型: row.operationType, 任务数: row.count }));
    if (tab === "flows") return (data as UsageV2Flows).resultUse.stages.map((row) => ({ 结果阶段: row.label, 去重结果: row.count, 证据: row.evidence }));
    return (data as UsageV2Overview).daily.map((row) => ({ 日期: row.day, ...metrics(row.metrics) }));
}
export default function UsageAnalyticsDashboard() {
    const [params, setParams] = useSearchParams(),
        locationKey = params.toString();
    const location = useMemo(() => readUsageLocation(new URLSearchParams(locationKey)), [locationKey]);
    const { filters, tab, personId } = location;
    const showLegacy = params.get("uLegacy") === "1";
    const user = useUserStore((state) => state.user),
        isAdmin = user?.role === "super_admin";
    const [draft, setDraft] = useState<UsageFilterForm>(filters),
        [page, setPage] = useState(1),
        [sort, setSort] = useState<UsageV2PeopleSort>("lastActivity"),
        [order, setOrder] = useState<"asc" | "desc">("desc");
    const [view, setView] = useState<{ key: string; data: PageData } | null>(null),
        [loading, setLoading] = useState(false),
        [error, setError] = useState(""),
        [errorCode, setErrorCode] = useState(""),
        [notice, setNotice] = useState("");
    const [selectedPeopleIds, setSelectedPeopleIds] = useState<string[]>([]);
    const [refresh, setRefresh] = useState(0),
        [options, setOptions] = useState<UsageV2Options | null>(null),
        [optionError, setOptionError] = useState(""),
        [peopleSearch, setPeopleSearch] = useState("");
    const [actionBusy, setActionBusy] = useState(false),
        [exportKind, setExportKind] = useState<"xlsx" | "png" | "pdf" | null>(null),
        [exporting, setExporting] = useState(false),
        [fullScreen, setFullScreen] = useState(false);
    const [privateOpen, setPrivateOpen] = useState(false),
        [privateData, setPrivateData] = useState<UsagePersonResult | null>(null),
        [privateError, setPrivateError] = useState(""),
        [privateBusy, setPrivateBusy] = useState(false);
    const privateController = useRef<AbortController | null>(null),
        root = useRef<HTMLDivElement>(null),
        content = useRef<HTMLDivElement>(null);
    const { token } = theme.useToken();
    const dirty = JSON.stringify(filters) !== JSON.stringify(draft),
        locked = actionBusy || exporting;
    const queryState = useMemo(() => {
        try {
            return { query: usageQuery(filters), error: "" };
        } catch (failure) {
            return { query: null, error: failure instanceof Error ? failure.message : "日期格式错误" };
        }
    }, [JSON.stringify(filters)]);
    const requestKey = JSON.stringify({ query: queryState.query, tab, personId, page, sort, order, refresh, identity: user?.id, showLegacy });
    const data = view?.key === requestKey ? view.data : null;
    const legacy = queryState.query ? legacyUsageScope({ ...queryState.query, ...(personId ? { userIds: [personId] } : {}) }) : { filters: null, reason: queryState.error };
    const tabLabel = personId && tab === "people" ? "个人画像" : usageTabs.find((item) => item.key === tab)!.label;
    const scopeText = `${filters.from} 至 ${filters.to}（北京时间，含起止日） · ${filters.departmentBasis === "at_event" ? "事件时部门" : "当前部门"} · ${filters.compare === "previous_period" ? "对比上一周期" : filters.compare === "previous_year" ? "对比去年同期" : "不比较"} · 部门 ${filters.departmentIds.length || "全部"} / 人员 ${personId ? 1 : filters.userIds.length || "全部"} / 板块 ${filters.boardKeys.length || "全部"} / 模型 ${filters.modelConfigIds.length || "全部"} / 操作 ${filters.operationTypes.join("、") || "全部"}`;
    useEffect(() => {
        setPage(1);
        setDraft(filters);
        setPrivateOpen(false);
        setPrivateData(null);
        privateController.current?.abort();
    }, [JSON.stringify(filters), personId, tab, user?.id]);
    useEffect(() => {
        setSelectedPeopleIds([]);
    }, [JSON.stringify(filters), JSON.stringify(draft), personId, tab, user?.id]);
    useEffect(() => {
        if (!isAdmin || showLegacy || !queryState.query) return;
        const controller = new AbortController();
        setLoading(true);
        setError("");
        setErrorCode("");
        const query = { ...queryState.query, page, pageSize: 20, sort, order };
        const request =
            tab === "overview"
                ? getUsageV2Overview(query, controller.signal)
                : tab === "people"
                  ? personId
                      ? getUsageV2Profile(personId, query, controller.signal)
                      : getUsageV2People(query, controller.signal)
                  : tab === "boards"
                    ? getUsageV2Boards(query, controller.signal)
                    : tab === "models"
                      ? getUsageV2Models(query, controller.signal)
                      : tab === "quality"
                        ? getUsageV2Quality(query, controller.signal)
                        : getUsageV2Flows(query, controller.signal);
        void request
            .then((result) => {
                if (!controller.signal.aborted) setView({ key: requestKey, data: result });
            })
            .catch((failure) => {
                if (!controller.signal.aborted) {
                    setView(null);
                    setError(failure instanceof Error ? failure.message : "读取失败，请重试。");
                    setErrorCode(failure instanceof UsageAnalyticsError ? failure.code : "");
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [requestKey, isAdmin]);
    useEffect(() => {
        if (!isAdmin || showLegacy) return;
        const controller = new AbortController();
        const timer = setTimeout(
            () => {
                void getUsageV2Options({ search: peopleSearch || undefined, page: 1, pageSize: 50 }, controller.signal)
                    .then((value) => {
                        if (!controller.signal.aborted) {
                            setOptions(value);
                            setOptionError("");
                        }
                    })
                    .catch((failure) => {
                        if (!controller.signal.aborted) setOptionError(failure instanceof Error ? failure.message : "筛选选项读取失败");
                    });
            },
            peopleSearch ? 250 : 0,
        );
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [peopleSearch, isAdmin, user?.id, showLegacy]);
    useEffect(() => {
        const changed = () => setFullScreen(document.fullscreenElement === root.current);
        document.addEventListener("fullscreenchange", changed);
        return () => {
            document.removeEventListener("fullscreenchange", changed);
            privateController.current?.abort();
        };
    }, []);
    const changeLocation = (next: UsageFilterForm, nextTab = tab, nextPerson?: string) => {
        setPage(1);
        setNotice("");
        setParams(writeUsageLocation(params, next, nextTab, nextPerson));
    };
    const apply = () => {
        try {
            usageQuery(draft);
            changeLocation(draft, tab, personId);
        } catch (failure) {
            setNotice(failure instanceof Error ? failure.message : "筛选无效");
        }
    };
    const drilldown = (change: Partial<UsageV2Scope>) => {
        if (locked) return;
        const next = { ...filters };
        for (const key of arrayFields)
            if (change[key]) {
                const values = change[key]!;
                const valid =
                    key === "boardKeys"
                        ? values.every((value) => options?.boards.some((item) => item.key === value))
                        : key === "operationTypes"
                          ? values.every((value) => options?.operationTypes.includes(value))
                          : values.every((value) => uuid.test(value));
                if (!valid) {
                    setNotice("该记录缺少可筛选的稳定身份，不能下钻；未知归属保持单列。");
                    return;
                }
                next[key] = values;
            }
        if (change.from) next.from = beijingDay(new Date(change.from));
        if (change.to) next.to = beijingDay(new Date(new Date(change.to).getTime() - 1));
        changeLocation(next, tab, personId);
    };
    const openPrivate = async (nextPage = 1) => {
        if (!personId || !legacy.filters) {
            setNotice(legacy.reason || "请选择人员");
            return;
        }
        privateController.current?.abort();
        const controller = new AbortController();
        privateController.current = controller;
        setPrivateOpen(true);
        setPrivateBusy(true);
        setPrivateError("");
        setPrivateData(null);
        try {
            const result = await getUsagePerson(personId, { from: legacy.filters.from, to: legacy.filters.to, boardKey: legacy.filters.boardKey, modelConfigId: legacy.filters.modelConfigId, page: nextPage, pageSize: 20 }, controller.signal);
            controller.signal.throwIfAborted();
            setPrivateData(result);
        } catch (failure) {
            if (!controller.signal.aborted) setPrivateError(failure instanceof Error ? failure.message : "读取失败");
        } finally {
            if (!controller.signal.aborted) setPrivateBusy(false);
        }
    };
    const busyChange = useCallback((value: boolean) => setActionBusy(value), []);
    const performExport = async () => {
        if (!data || !exportKind || !content.current || exporting) return;
        setExporting(true);
        setNotice("");
        try {
            const profile = personId && tab === "people" ? (data as UsageV2Profile).person : null;
            const identity = profile ? `${profile.displayName.slice(0, 30)}-${profile.userId.slice(-8)}-` : "";
            const title = `使用分析-${tabLabel}-${identity}${filters.from}-${filters.to}`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
            const reportNotes = [
                ...(profile ? [`个人画像：${profile.displayName}；人员 ID：${profile.userId}`] : []),
                `快照：${data.meta.asOf}；指标版本：${data.meta.metricVersion}`,
                snapshotText(data.meta),
                `完整筛选：${JSON.stringify(data.meta.scope)}`,
                ...data.meta.coverage.map(
                    (item) =>
                        `${metricLabels[item.metric as keyof typeof metricLabels] || item.metric}：${item.state === "available" ? "可用" : item.state === "partial" ? "部分覆盖" : "不可用"}；匹配 ${item.matched}/${item.eligible}，未知 ${item.unknown}；${item.notes.join("；")}`,
                ),
                ...data.meta.notes,
            ];
            if (exportKind === "xlsx")
                await exportExcel(exportRows(data, tab, Boolean(personId && tab === "people")), title, [
                    { 项目: "范围", 说明: scopeText },
                    { 项目: "完整筛选合同", 说明: JSON.stringify(data.meta.scope) },
                    { 项目: "分页边界", 说明: "仅当前已载入页的明细；不是全部原始记录。完整原始记录请用 JSONL。" },
                    { 项目: "快照", 说明: data.meta.asOf },
                    { 项目: "快照范围与滞后", 说明: snapshotText(data.meta) },
                    { 项目: "指标版本", 说明: data.meta.metricVersion },
                    ...(profile ? [{ 项目: "人物身份", 说明: `${profile.displayName}；${profile.userId}` }] : []),
                    ...data.meta.notes.map((note) => ({ 项目: "口径", 说明: note })),
                    ...data.meta.coverage.map((item) => ({ 项目: item.metric, 说明: `${item.state}；匹配${item.matched}/${item.eligible}；${item.notes.join("；")}` })),
                ]);
            else await exportDashboard(content.current, exportKind, title, scopeText, { background: token.colorBgContainer, text: token.colorText, muted: token.colorTextSecondary }, reportNotes);
            setExportKind(null);
            setNotice("导出已交给浏览器保存；文件不自动共享。Excel 仅当前页，图片 / PDF 仅显式指标与图表。");
        } catch (failure) {
            setNotice(failure instanceof Error ? failure.message : "导出失败，请重试。");
        } finally {
            setExporting(false);
        }
    };
    const refreshRead = useCallback(() => setRefresh((value) => value + 1), []);
    const legacyView = (show: boolean) => {
        const next = new URLSearchParams(params);
        if (show) next.set("uLegacy", "1");
        else next.delete("uLegacy");
        setParams(next);
    };
    if (!isAdmin) return <Alert type="warning" showIcon title="仅超级管理员可访问使用分析" description="部门管理员与普通员工不能查看、导出或分析其他用户的记录。" />;
    if (showLegacy)
        return (
            <div className="space-y-4">
                <Alert type="info" showIcon title="旧版实时分析 · 独立筛选范围" description="这里使用旧版独立日期与筛选，不自动继承新版部门 / 多板块 / 多模型等条件。不会补算日事实，也不代表新版范围已经恢复。" />
                <Button onClick={() => legacyView(false)}>返回新版使用分析</Button>
                <Suspense fallback={<Spin />}>
                    <LegacyPanel />
                </Suspense>
            </div>
        );
    return (
        <div ref={root} className={`min-w-0 space-y-4 ${fullScreen ? "overflow-auto p-5" : ""}`} style={{ background: fullScreen ? token.colorBgLayout : undefined }} aria-label="新版使用分析">
            <header className="wb-surface space-y-4 p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="mb-2 flex items-center gap-2">
                            <span className="text-xs font-semibold tracking-widest text-[var(--primary)]">WORKSPACE INSIGHTS</span>
                            <Tag>仅超级管理员</Tag>
                        </div>
                        <h2 className="text-xl font-semibold">使用分析</h2>
                        <p className="mt-1 text-sm text-[var(--muted-foreground)]">从可信记录看使用方式、结果与成本。结论可核对，缺口不隐藏。</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            icon={fullScreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                            onClick={() => {
                                void (fullScreen ? document.exitFullscreen() : root.current?.requestFullscreen())?.catch(() => setNotice("浏览器不支持全屏，请使用浏览器全屏功能。"));
                            }}
                        >
                            {fullScreen ? "退出全屏" : "全屏"}
                        </Button>
                        {(["xlsx", "png", "pdf"] as const).map((kind) => (
                            <Button key={kind} disabled={!data || dirty || locked || loading} icon={<Download size={15} />} onClick={() => setExportKind(kind)}>
                                {kind === "xlsx" ? "Excel 当前页" : kind === "png" ? "图片" : "PDF"}
                            </Button>
                        ))}
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        aria-label="分析操作类型"
                        mode="multiple"
                        maxTagCount="responsive"
                        allowClear
                        disabled={locked}
                        placeholder="全部操作类型"
                        style={{ minWidth: 200, maxWidth: "100%" }}
                        value={draft.operationTypes}
                        options={options?.operationTypes.map((value) => ({ value, label: value }))}
                        onChange={(operationTypes) => setDraft((current) => ({ ...current, operationTypes }))}
                    />
                    <span className="text-xs text-[var(--muted-foreground)]">日期快捷</span>
                    {(
                        [
                            { label: "今天", value: 1 },
                            { label: "近 7 天", value: 7 },
                            { label: "近 30 天", value: 30 },
                            { label: "本月", value: "month" },
                        ] as const
                    ).map((item) => (
                        <Button key={item.label} size="small" disabled={locked} onClick={() => setDraft((current) => ({ ...current, ...datePreset(item.value) }))}>
                            {item.label}
                        </Button>
                    ))}
                </div>
                <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <label className="grid gap-1.5 text-xs">
                        开始日期
                        <Input aria-label="分析开始日期" type="date" value={draft.from} disabled={locked} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} />
                    </label>
                    <label className="grid gap-1.5 text-xs">
                        结束日期
                        <Input aria-label="分析结束日期" type="date" value={draft.to} disabled={locked} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} />
                    </label>
                    <label className="grid gap-1.5 text-xs">
                        对比周期
                        <Select
                            aria-label="分析对比周期"
                            disabled={locked}
                            value={draft.compare}
                            options={[
                                { value: "previous_period", label: "上一周期（相同天数）" },
                                { value: "previous_year", label: "去年同期" },
                                { value: "none", label: "不比较" },
                            ]}
                            onChange={(compare) => setDraft((current) => ({ ...current, compare }))}
                        />
                    </label>
                    <label className="grid gap-1.5 text-xs">
                        部门归属口径
                        <Select
                            aria-label="部门归属口径"
                            disabled={locked}
                            value={draft.departmentBasis}
                            options={[
                                { value: "at_event", label: "事件时部门（缺失单列）" },
                                { value: "current", label: "当前部门" },
                            ]}
                            onChange={(departmentBasis) => setDraft((current) => ({ ...current, departmentBasis }))}
                        />
                    </label>
                    <label className="grid min-w-0 gap-1.5 text-xs">
                        部门
                        <Select
                            aria-label="分析部门筛选"
                            mode="multiple"
                            maxTagCount="responsive"
                            allowClear
                            disabled={locked}
                            placeholder="全部部门"
                            value={draft.departmentIds}
                            options={options?.departments.map((item) => ({ value: item.id, label: item.name }))}
                            onChange={(departmentIds) => setDraft((current) => ({ ...current, departmentIds }))}
                        />
                    </label>
                    <label className="grid min-w-0 gap-1.5 text-xs">
                        人员
                        <Select
                            aria-label="分析人员筛选"
                            mode="multiple"
                            maxTagCount="responsive"
                            allowClear
                            disabled={locked}
                            showSearch={{ filterOption: false, onSearch: setPeopleSearch }}
                            placeholder="输入姓名搜索人员"
                            value={draft.userIds}
                            options={options?.people.map((item) => ({ value: item.id, label: item.name }))}
                            onChange={(userIds) => setDraft((current) => ({ ...current, userIds }))}
                            notFoundContent="没有匹配人员；可输入姓名搜索"
                        />
                    </label>
                    <label className="grid min-w-0 gap-1.5 text-xs">
                        板块
                        <Select
                            aria-label="分析板块筛选"
                            mode="multiple"
                            maxTagCount="responsive"
                            allowClear
                            disabled={locked}
                            placeholder="全部板块"
                            value={draft.boardKeys}
                            options={options?.boards.map((item) => ({ value: item.key, label: item.label }))}
                            onChange={(boardKeys) => setDraft((current) => ({ ...current, boardKeys }))}
                        />
                    </label>
                    <label className="grid min-w-0 gap-1.5 text-xs">
                        模型
                        <Select
                            aria-label="分析模型筛选"
                            mode="multiple"
                            maxTagCount="responsive"
                            allowClear
                            disabled={locked}
                            placeholder="全部模型"
                            value={draft.modelConfigIds}
                            options={options?.models.map((item) => ({ value: item.id, label: item.name }))}
                            onChange={(modelConfigIds) => setDraft((current) => ({ ...current, modelConfigIds }))}
                        />
                    </label>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Button type="primary" disabled={locked} onClick={apply}>
                        应用筛选
                    </Button>
                    <Button
                        disabled={locked}
                        onClick={() => {
                            const cleared = { ...filters, departmentIds: [], userIds: [], boardKeys: [], modelConfigIds: [], operationTypes: [] };
                            changeLocation(cleared);
                        }}
                    >
                        清除维度筛选
                    </Button>
                    <Button disabled={locked || dirty} loading={loading} icon={<RefreshCw size={15} />} onClick={() => setRefresh((value) => value + 1)}>
                        刷新读取
                    </Button>
                    <span className="text-xs text-[var(--muted-foreground)]">只读查询；不触发重算或修改账本</span>
                </div>
                <p className="text-xs leading-5" aria-label="当前分析范围">
                    已应用：{scopeText}
                </p>
                {dirty ? <Alert type="info" title="筛选尚未应用；导出和 AI 确认暂不可用" /> : null}
                {optionError ? <Alert type="warning" title={optionError} /> : null}
            </header>
            <RollupActions
                key={user!.id}
                actorId={user!.id}
                filters={filters}
                disabled={locked || dirty || Boolean(queryState.error)}
                refreshRequired={errorCode === "USAGE_ROLLUP_REFRESH_REQUIRED"}
                onComplete={refreshRead}
                onLegacy={() => legacyView(true)}
            />
            <Tabs
                activeKey={tab}
                onChange={(key) => {
                    if (!locked) changeLocation(filters, key as UsageTab);
                }}
                items={usageTabs.map((item) => ({ ...item, disabled: locked }))}
            />
            <ReportActions
                key={`report:${requestKey}:${JSON.stringify(draft)}`}
                page={tab}
                query={data && !dirty && queryState.query ? { ...queryState.query, ...(personId ? { userIds: [personId] } : {}) } : null}
                disabled={locked || loading || dirty || !data}
                reason={dirty ? "请先应用当前筛选，再生成免费统计报告。" : !data && !loading ? "当前范围尚无可用分析响应，请先恢复读取；报告不会暗中重算。" : undefined}
                scopeText={scopeText}
            />
            {notice ? <Alert type="info" showIcon title={notice} closable onClose={() => setNotice("")} /> : null}
            {queryState.error || error ? <Alert type={errorCode === "USAGE_ROLLUP_REFRESH_REQUIRED" ? "warning" : "error"} showIcon title={queryState.error || error} action={<Button onClick={refreshRead}>重新读取（不重算）</Button>} /> : null}
            {loading ? (
                <div role="status" className="flex items-center justify-center gap-3 py-16">
                    <Spin />
                    正在读取当前范围的分析数据…
                </div>
            ) : null}
            {data ? (
                <>
                    <Coverage meta={data.meta} />
                    <div ref={content} className="min-w-0 space-y-4" data-testid="usage-v2-content">
                        {tab === "overview" ? (
                            <Overview data={data as UsageV2Overview} onDrilldown={drilldown} />
                        ) : tab === "people" ? (
                            personId ? (
                                <PersonProfile data={data as UsageV2Profile} onBack={() => changeLocation(filters, "people")} onPage={setPage} onDrilldown={drilldown} onPrivateRecords={() => void openPrivate()} />
                            ) : (
                                <People
                                    data={data as UsageV2People}
                                    sort={sort}
                                    order={order}
                                    onSort={(next, direction) => {
                                        setPage(1);
                                        setSort(next);
                                        setOrder(direction);
                                    }}
                                    onPage={setPage}
                                    onProfile={(id) => changeLocation(filters, "people", id)}
                                    selectedIds={selectedPeopleIds}
                                    onSelectionChange={setSelectedPeopleIds}
                                    query={queryState.query!}
                                    refreshVersion={refresh}
                                    disabled={dirty || locked}
                                />
                            )
                        ) : tab === "boards" ? (
                            <Boards data={data as UsageV2Boards} onDrilldown={drilldown} />
                        ) : tab === "models" ? (
                            <Models data={data as UsageV2Models} onDrilldown={drilldown} />
                        ) : tab === "quality" ? (
                            <Quality data={data as UsageV2Quality} onDrilldown={drilldown} />
                        ) : (
                            <Flows data={data as UsageV2Flows} onDrilldown={drilldown} />
                        )}
                    </div>
                </>
            ) : null}
            <LegacyActions key={`${requestKey}:${JSON.stringify(draft)}`} filters={data && !dirty ? legacy.filters : null} reason={dirty ? "请先应用当前筛选。" : legacy.reason} onBusy={busyChange} />
            <Modal
                title={`导出${exportKind === "xlsx" ? " Excel 当前页" : exportKind === "png" ? "看板图片" : "看板 PDF"}`}
                open={Boolean(exportKind)}
                onCancel={() => {
                    if (!exporting) setExportKind(null);
                }}
                confirmLoading={exporting}
                onOk={() => void performExport()}
                okText="确认导出"
                cancelText="返回"
                cancelButtonProps={{ disabled: exporting }}
            >
                <Alert
                    type="warning"
                    showIcon
                    title="仅保存在本机浏览器，不自动分享"
                    description={exportKind === "xlsx" ? "Excel 包含当前已载入页的明细和口径；人员页可能含姓名，完整原始记录请使用 JSONL。" : "仅导出当前显式指标与图表，不截入原始提示词、私有图片或隐藏内容。若当前图表按人员拆分，图中名称会保留。"}
                />
                <p className="mt-3 text-xs leading-6">{scopeText}</p>
            </Modal>
            <Modal
                title="明确读取的个人原始记录"
                open={privateOpen}
                width={900}
                footer={null}
                onCancel={() => {
                    privateController.current?.abort();
                    setPrivateOpen(false);
                    setPrivateData(null);
                }}
            >
                <Alert type="warning" title="业务敏感内容，仅供授权管理员核查" description="这里只读取当前已授权人员及筛选范围的记录。不会自动传给 AI，也不加载私有图片。" />
                {privateBusy ? <Spin className="my-5" /> : null}
                {privateError ? <Alert className="mt-3" type="error" title={privateError} /> : null}
                {privateData ? (
                    <div className="mt-4 space-y-3">
                        {privateData.records.map((record) => (
                            <article key={`${record.kind}:${record.id}`} className="rounded border border-[var(--border)] p-3">
                                <p className="text-xs">
                                    {record.occurredAt} · {record.boardLabel} · {record.modelName || "未关联模型"} · {record.status}
                                </p>
                                <details className="mt-2 text-sm">
                                    <summary className="cursor-pointer">展开已保存提示词与参数</summary>
                                    <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">{record.prompt || "未采集 / 不可用"}</pre>
                                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(record.parameters, null, 2)}</pre>
                                </details>
                            </article>
                        ))}
                        <div className="flex items-center gap-3">
                            <Button disabled={privateData.pagination.page <= 1} onClick={() => void openPrivate(privateData.pagination.page - 1)}>
                                上一页
                            </Button>
                            <span>
                                第 {privateData.pagination.page} 页 · 共 {privateData.pagination.total} 条
                            </span>
                            <Button disabled={privateData.pagination.page * privateData.pagination.pageSize >= privateData.pagination.total} onClick={() => void openPrivate(privateData.pagination.page + 1)}>
                                下一页
                            </Button>
                        </div>
                    </div>
                ) : null}
            </Modal>
        </div>
    );
}
