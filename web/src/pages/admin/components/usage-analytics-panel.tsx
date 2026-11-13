import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { Alert, Button, Checkbox, Drawer, Empty, Input, Modal, Pagination, Select, Spin, Table, Tag, Typography } from "antd";
import { Download, FileSearch, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { saveAs } from "file-saver";
import type { UsageAnalysisModelsResult, UsageBreakdowns, UsageBucket, UsageCoverage, UsagePerson, UsageRecord, UsageSummary, UsagePeopleSort, UsagePeopleOrder } from "../../../../../shared/usage-analytics";
import { moduleDefinitions } from "../../../../../shared/feature-catalog";
import { analyzeUsage, getUsagePerson, listUsageAnalysisModels, listUsagePeople, previewUsageAnalysis, type UsageAnalysisPreview, type UsageAnalysisResult, type UsageFilters, type UsagePeopleResult, type UsagePersonResult } from "@/services/api/usage-analytics";
import { useUserStore } from "@/stores/use-user-store";
import { formatBeijingDateTime } from "@/lib/beijing-time";
import { formatNonFinancialJson, omitFinancialFields, usageDisplayExplanation } from "@/lib/financial-presentation";
import { exportNonFinancialUsageRecords } from "@/lib/non-financial-usage-export";
import { DisplayText, DisplayTranslationScope, SensitiveDisplayValue, useDisplayConfig, useDisplayText } from "@/hooks/use-display-text";

type DateFilter = { from: string; to: string; search: string; boardKey?: string; modelConfigId?: string };
type DatePreset = "today" | "7days" | "30days" | "month" | "lastMonth";
type PeopleSorting = { sort: Exclude<UsagePeopleSort, "cost">; order: UsagePeopleOrder };
type Operation = "list" | "detail" | "export" | "preview" | "analyze" | "models";
type ExportSelection = { userIds?: string[]; label: string };
type WritableExport = { write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> };
type SavePicker = (options: { suggestedName: string; startIn: "desktop"; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{ createWritable(): Promise<WritableExport> }>;
const emptySummary: UsageSummary = { visits: 0, interactions: 0, generationRequests: 0, chatRequests: 0, succeeded: 0, failed: 0, pending: 0, totalRmbCost: 0, generatedImages: 0 };
const dateText = (value: string | null) => value ? formatBeijingDateTime(value) : "未记录";
const beijingDay = (date: Date) => formatBeijingDateTime(date).slice(0, 10);
const dayMilliseconds = 24 * 60 * 60 * 1000;
const datePresets: Array<{ key: DatePreset; label: string }> = [{ key: "today", label: "今天" }, { key: "7days", label: "近 7 天" }, { key: "30days", label: "近 30 天" }, { key: "month", label: "本月" }, { key: "lastMonth", label: "上月" }];
const sortLabels: Record<PeopleSorting["sort"], string> = { lastActivity: "最后记录", images: "成功出图", requests: "模型调用", failed: "失败次数" };
const defaultSorting: PeopleSorting = { sort: "lastActivity", order: "desc" };

export { usageDisplayExplanation };

export function usagePreviewDisplay(content: string): string {
    try {
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.coverage?.notes)) {
            parsed.coverage.notes = parsed.coverage.notes.map((note: unknown) => typeof note === "string" ? usageDisplayExplanation(note) : note).filter(Boolean);
        }
        return formatNonFinancialJson(parsed);
    } catch { return content; }
}
export function usageDatePreset(preset: DatePreset, now = new Date()): Pick<DateFilter, "from" | "to"> {
    const today = beijingDay(now), midnight = new Date(`${today}T00:00:00+08:00`).getTime();
    if (preset === "lastMonth") {
        const previousEnd = beijingDay(new Date(new Date(`${today.slice(0, 7)}-01T00:00:00+08:00`).getTime() - dayMilliseconds));
        return { from: `${previousEnd.slice(0, 7)}-01`, to: previousEnd };
    }
    return { from: preset === "month" ? `${today.slice(0, 7)}-01` : beijingDay(new Date(midnight - (preset === "30days" ? 29 : preset === "7days" ? 6 : 0) * dayMilliseconds)), to: today };
}
export const defaultUsageDateFilter = (now = new Date()): DateFilter => ({ ...usageDatePreset("30days", now), search: "" });
export function isUsageFilterBucket(kind: "board" | "model", key: string) {
    return kind === "model" ? /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(key)
        : key === "home" || key === "dashboard" || moduleDefinitions.some(item => item.moduleKey === key);
}

/** Inclusive Beijing calendar dates become UTC instants with an exclusive next-day end. */
export function usageRangeFilters(value: DateFilter): UsageFilters {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.from) || !/^\d{4}-\d{2}-\d{2}$/.test(value.to)) throw new Error("请选择完整的开始和结束日期。");
    const start = new Date(`${value.from}T00:00:00+08:00`), end = new Date(`${value.to}T00:00:00+08:00`);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || beijingDay(start) !== value.from || beijingDay(end) !== value.to || start > end) throw new Error("日期无效，或开始日期晚于结束日期。");
    if (value.boardKey && !isUsageFilterBucket("board", value.boardKey)) throw new Error("请选择有效的板块；未记录板块不能下钻。");
    if (value.modelConfigId && !isUsageFilterBucket("model", value.modelConfigId)) throw new Error("请选择有效的模型；未关联模型不能下钻。");
    return { from: start.toISOString(), to: new Date(end.getTime() + dayMilliseconds).toISOString(), ...(value.search.trim() ? { search: value.search.trim() } : {}), ...(value.boardKey ? { boardKey: value.boardKey } : {}), ...(value.modelConfigId ? { modelConfigId: value.modelConfigId } : {}) };
}

export function usageSelectionFilters(value: DateFilter, userIds?: string[]): UsageFilters {
    if (userIds && !userIds.length) throw new Error("请先选择至少一位用户。");
    return { ...usageRangeFilters(value), ...(userIds ? { userIds: [...new Set(userIds)] } : {}) };
}

/** Deterministic description of the supplied scope, never a model inference or employee assessment. */
export function usageSummaryText(summary: UsageSummary, breakdowns: UsageBreakdowns, coverage: UsageCoverage, scope = "当前筛选范围") {
    const mostUsed = (values: UsageBucket[]) => values.reduce<UsageBucket | undefined>((top, value) => value.count > (top?.count || 0) ? value : top, undefined);
    const model = mostUsed(breakdowns.models), board = mostUsed(breakdowns.boards), control = mostUsed(breakdowns.controls);
    return `${scope}已记录 ${summary.generationRequests + summary.chatRequests} 次模型请求（生成 ${summary.generationRequests} 次、文字 ${summary.chatRequests} 次），成功 ${summary.succeeded} 次、失败 ${summary.failed} 次、未完成 ${summary.pending} 次。成功实际出图 ${summary.generatedImages} 张（不是请求次数）。${model ? `常用模型为“${model.label}”（${model.count} 次调用）` : "暂无可用模型调用分布"}；${board ? `常用板块为“${board.label}”（${board.count} 条记录）` : "暂无可用板块记录"}；${control ? `常用操作控件为“${control.label}”（${control.count} 条记录）` : "暂无可用操作控件记录"}。${(coverage.droppedEventCount || 0) > 0 ? `另有 ${coverage.droppedEventCount} 条已知采集缺口，统计可能偏低。` : ""}历史点击与聊天不能回补，记录不足不能解释为未工作或未使用。`;
}

export function UsageAnalyticsPanel() {
    useUiLocale();
    const display = useDisplayText();
    const displayConfig = useDisplayConfig();
    const user = useUserStore(state => state.user);
    const isAdmin = user?.role === "super_admin";
    const [draft, setDraft] = useState<DateFilter>(defaultUsageDateFilter);
    const [applied, setApplied] = useState<DateFilter>(defaultUsageDateFilter);
    const [data, setData] = useState<UsagePeopleResult | null>(null);
    const [knownModels, setKnownModels] = useState<UsageBucket[]>([]);
    const [sorting, setSorting] = useState<PeopleSorting>(defaultSorting);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [detailPerson, setDetailPerson] = useState<UsagePerson | null>(null);
    const [detail, setDetail] = useState<UsagePersonResult | null>(null);
    const [busy, setBusy] = useState<Partial<Record<Operation, boolean>>>({});
    const [errors, setErrors] = useState<Partial<Record<Operation, string>>>({});
    const [notice, setNotice] = useState("");
    const [exportSelection, setExportSelection] = useState<ExportSelection | null>(null);
    const [exportMode, setExportMode] = useState<"download" | "location">("download");
    const [exportProgress, setExportProgress] = useState(0);
    const [analysisScope, setAnalysisScope] = useState<"all" | "selected">("all");
    const [includeSamples, setIncludeSamples] = useState(false);
    const [textModelId, setTextModelId] = useState<string>();
    const [textModels, setTextModels] = useState<UsageAnalysisModelsResult["models"]>([]);
    const [modelsLoaded, setModelsLoaded] = useState(false);
    const [preview, setPreview] = useState<UsageAnalysisPreview | null>(null);
    const [previewUsed, setPreviewUsed] = useState(false);
    const [analysis, setAnalysis] = useState<UsageAnalysisResult | null>(null);
    const previewValue = useMemo(() => {
        const content = preview ? usagePreviewDisplay(preview.content) : "";
        try { return JSON.parse(content) as unknown; } catch { return content; }
    }, [preview]);
    const controllers = useRef(new Map<Operation, AbortController>());
    const mounted = useRef(true);
    const savePicker = typeof window === "undefined" ? undefined : (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    const dirtyFilters = JSON.stringify(draft) !== JSON.stringify(applied);
    const selectedModelAvailable = modelsLoaded && textModels.some(model => model.id === textModelId);
    const summary = data?.summary || emptySummary;
    const mutableLocked = Boolean(busy.export || busy.preview || busy.analyze);
    const queryLocked = mutableLocked || Boolean(busy.list);
    const boardOptions = [...moduleDefinitions.map(item => ({ value: item.moduleKey, label: item.label })), { value: "home", label: "首页" }, { value: "dashboard", label: "工作台" }];
    const appliedScope = `${applied.from} 至 ${applied.to}（北京时间，包含起止两天） · ${boardOptions.find(item => item.value === applied.boardKey)?.label || "全部板块"} · ${knownModels.find(item => item.key === applied.modelConfigId)?.label || (applied.modelConfigId ? "所选模型" : "全部模型")}`;

    const invalidatePreview = () => { setPreview(null); setPreviewUsed(false); setAnalysis(null); };
    const clearScope = () => { setSelectedIds([]); setAnalysisScope("all"); invalidatePreview(); setDetailPerson(null); setDetail(null); controllers.current.get("detail")?.abort(); };
    const changeDraft = (update: Partial<DateFilter>) => {
        if (queryLocked) return;
        setDraft(current => ({ ...current, ...update })); clearScope();
    };
    const cancel = (operation: Operation) => {
        controllers.current.get(operation)?.abort();
        setNotice(operation === "analyze" ? "已取消等待分析结果。已提交的请求可能继续处理；本页不会自动重发。" : "操作已取消，已有数据和文件不会被替换为不完整结果。");
    };
    const run = async (operation: Operation, work: (signal: AbortSignal) => Promise<void>) => {
        if (!isAdmin || controllers.current.has(operation)) return;
        const controller = new AbortController(); controllers.current.set(operation, controller);
        setBusy(current => ({ ...current, [operation]: true })); setErrors(current => ({ ...current, [operation]: undefined })); setNotice("");
        try { await work(controller.signal); }
        catch (error) {
            if (mounted.current && controllers.current.get(operation) === controller && !controller.signal.aborted && !(error instanceof Error && error.name === "AbortError")) {
                setErrors(current => ({ ...current, [operation]: error instanceof Error ? error.message : "操作未完成，请手动重试。" }));
            }
        } finally {
            if (controllers.current.get(operation) === controller) {
                controllers.current.delete(operation);
                if (mounted.current) setBusy(current => ({ ...current, [operation]: false }));
            }
        }
    };

    const load = (filters: DateFilter, page = 1, resetSelection = false, nextSorting = sorting) => run("list", async signal => {
        const result = await listUsagePeople({ ...usageRangeFilters(filters), page, pageSize: 20, ...(nextSorting.sort === "lastActivity" && nextSorting.order === "desc" ? {} : nextSorting) }, signal);
        signal.throwIfAborted(); setData(result); setApplied({ ...filters }); setSorting(nextSorting);
        setKnownModels(current => [...new Map([...current, ...result.breakdowns.models.filter(item => isUsageFilterBucket("model", item.key))].map(item => [item.key, item])).values()]);
        if (resetSelection) clearScope();
    });
    const drillDown = (kind: "board" | "model", key: string) => {
        if (queryLocked || dirtyFilters || !isUsageFilterBucket(kind, key)) return;
        const next = { ...applied, [kind === "board" ? "boardKey" : "modelConfigId"]: key };
        setDraft(next); clearScope(); void load(next, 1, true);
    };
    const loadTextModels = () => run("models", async signal => {
        setModelsLoaded(false); setTextModels([]);
        const result = await listUsageAnalysisModels(signal);
        signal.throwIfAborted(); setTextModels(result.models); setModelsLoaded(true);
        setTextModelId(current => result.models.some(model => model.id === current) ? current : undefined);
    });
    useEffect(() => {
        mounted.current = true;
        setBusy({}); setErrors({}); setNotice(""); setExportSelection(null); setExportProgress(0);
        setData(null); setKnownModels([]); setSorting(defaultSorting); setSelectedIds([]); setDetailPerson(null); setDetail(null); invalidatePreview();
        setTextModels([]); setTextModelId(undefined); setModelsLoaded(false); setAnalysisScope("all"); setIncludeSamples(false);
        const filters = defaultUsageDateFilter(); setDraft(filters); setApplied(filters);
        if (isAdmin) { void load(filters, 1, true, defaultSorting); void loadTextModels(); }
        return () => { mounted.current = false; controllers.current.forEach(controller => controller.abort()); controllers.current.clear(); };
    }, [isAdmin, user?.id]);

    const openDetail = (person: UsagePerson, page = 1) => {
        if (controllers.current.has("detail") || dirtyFilters || busy.list) return;
        setDetailPerson(person); if (page === 1) setDetail(null);
        void run("detail", async signal => {
            const result = await getUsagePerson(person.userId, { ...usageRangeFilters(applied), page, pageSize: 20 }, signal);
            signal.throwIfAborted(); setDetail(result);
        });
    };
    const closeDetail = () => { if (controllers.current.has("detail")) cancel("detail"); setDetailPerson(null); setDetail(null); };
    const openExport = (selection: ExportSelection) => {
        if (mutableLocked || dirtyFilters || !data) return;
        setExportSelection(selection); setExportProgress(0); setErrors(current => ({ ...current, export: undefined }));
    };
    const startExport = () => run("export", async signal => {
        if (!exportSelection) return;
        const filters = usageSelectionFilters(applied, exportSelection.userIds);
        const filename = `使用记录-${applied.from}-${applied.to}-${exportSelection.userIds ? `${exportSelection.userIds.length}人` : applied.search.trim() ? "筛选用户" : "全员"}.jsonl`;
        let writable: WritableExport | undefined;
        try {
            if (exportMode === "location" && savePicker) {
                const handle = await savePicker.call(window, { suggestedName: filename, startIn: "desktop", types: [{ description: "完整使用记录 JSON Lines", accept: { "application/x-ndjson": [".jsonl"] } }] });
                signal.throwIfAborted(); writable = await handle.createWritable(); signal.throwIfAborted();
            }
            const result = await exportNonFinancialUsageRecords(filters, { signal, onProgress: count => { if (!signal.aborted) setExportProgress(count); }, ...(writable ? { writeChunk: (chunk: Uint8Array) => writable!.write(chunk) } : {}) });
            signal.throwIfAborted();
            if (writable) await writable.close(); else if (result.blob) saveAs(result.blob, filename);
            setNotice(`已完整导出 ${result.recordCount} 条记录。保存位置由你的浏览器决定；服务器未写入本机桌面。`); setExportSelection(null);
        } catch (error) { await writable?.abort().catch(() => undefined); throw error; }
    });
    const createPreview = () => run("preview", async signal => {
        setPreview(null); setPreviewUsed(false); setAnalysis(null);
        const result = await previewUsageAnalysis({ ...usageSelectionFilters(applied, analysisScope === "selected" ? selectedIds : undefined), includePromptSamples: includeSamples }, signal);
        signal.throwIfAborted(); setPreview(result);
    });
    const startAnalysis = () => run("analyze", async signal => {
        if (!preview || previewUsed || !textModelId || !selectedModelAvailable || busy.models || errors.models) return;
        if (new Date(preview.expiresAt).getTime() <= Date.now()) throw new Error("预览已过期，请重新预览后分析。");
        setPreviewUsed(true); setAnalysis(null);
        const result = await analyzeUsage({ previewId: preview.previewId, previewHash: preview.previewHash, modelConfigId: textModelId, confirm: true }, signal);
        signal.throwIfAborted(); setAnalysis(result);
    });

    if (!isAdmin) return <Alert type="warning" showIcon title={staticUiText("仅超级管理员可访问使用分析")} description={staticUiText("部门管理员和普通员工不能查看、导出或分析其他用户的记录。")} />;

    return <section aria-label={staticUiText("使用分析")} className="min-w-0 space-y-5">
        <header className="wb-surface p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div><Typography.Title level={3} className="!mb-1 !text-lg">{staticUiText("使用分析")}</Typography.Title><p className="text-sm text-[var(--muted-foreground)]">{staticUiText("从可核查的记录了解工作流程与工具使用习惯，不做人格推断、绩效评分或人员排名。")}</p></div>
                <Tag>{staticUiText("仅超级管理员")}</Tag>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2" aria-label={staticUiText("使用分析日期快捷选项")}><span className="mr-1 text-xs text-[var(--muted-foreground)]">{staticUiText("日期快捷")}</span>{datePresets.map(preset => { const range = usageDatePreset(preset.key); return <Button key={preset.key} size="small" disabled={queryLocked} type={draft.from === range.from && draft.to === range.to ? "primary" : "default"} onClick={() => changeDraft(range)}>{staticUiText(preset.label)}</Button>; })}<span className="text-xs text-[var(--muted-foreground)]">{staticUiText("默认近 30 天 · 快捷项修改后需应用")}</span></div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <label className="grid min-w-0 gap-1.5 text-xs">{staticUiText("搜索用户")}<Input aria-label={staticUiText("搜索使用分析用户")} value={draft.search} maxLength={100} placeholder={staticUiText("姓名或账号")} disabled={queryLocked} prefix={<Search className="size-4" />} onChange={event => changeDraft({ search: event.target.value })} onPressEnter={() => { if (!queryLocked) void load(draft, 1, true); }} /></label>
                <label className="grid min-w-0 gap-1.5 text-xs">{staticUiText("板块")}<Select aria-label={staticUiText("使用分析板块筛选")} allowClear showSearch={{ optionFilterProp: "label" }} value={draft.boardKey} placeholder={staticUiText("全部板块")} disabled={queryLocked} options={displayConfig(boardOptions, "options")} onChange={value => changeDraft({ boardKey: value })} /></label>
                <label className="grid min-w-0 gap-1.5 text-xs">{staticUiText("模型")}<Select aria-label={staticUiText("使用分析模型筛选")} allowClear showSearch={{ optionFilterProp: "label" }} value={draft.modelConfigId} placeholder={staticUiText("全部模型")} disabled={queryLocked} options={displayConfig(knownModels.map(item => ({ value: item.key, label: item.label })), "options")} notFoundContent={staticUiText("已载入记录中暂无可筛选模型")} onChange={value => changeDraft({ modelConfigId: value })} /></label>
                <label className="grid gap-1.5 text-xs">{staticUiText("开始日期")}<Input type="date" aria-label={staticUiText("使用分析开始日期")} value={draft.from} disabled={queryLocked} onChange={event => changeDraft({ from: event.target.value })} /></label>
                <label className="grid gap-1.5 text-xs">{staticUiText("结束日期")}<Input type="date" aria-label={staticUiText("使用分析结束日期")} value={draft.to} disabled={queryLocked} onChange={event => changeDraft({ to: event.target.value })} /></label>
                <div className="flex flex-wrap items-end gap-2"><Button type="primary" aria-label={staticUiText("应用筛选")} icon={<RefreshCw className="size-4" />} loading={busy.list} disabled={mutableLocked} onClick={() => void load(draft, 1, true)}>{staticUiText("应用筛选")}</Button>{draft.boardKey || draft.modelConfigId ? <Button disabled={queryLocked} onClick={() => changeDraft({ boardKey: undefined, modelConfigId: undefined })}>{staticUiText("清除板块 / 模型")}</Button> : null}{busy.list ? <Button onClick={() => cancel("list")}>{staticUiText("取消加载")}</Button> : null}</div>
            </div>
            <p aria-label={staticUiText("使用分析已应用范围")} className="mt-3 text-xs leading-5">{staticUiText("已应用：")}{display(appliedScope)}</p>
            <details className="mt-2 text-xs leading-5 text-[var(--muted-foreground)]"><summary className="cursor-pointer">{staticUiText("查看筛选与统计口径")}</summary><p className="mt-2">{staticUiText("日期包含起止两天，固定按北京时间（UTC+8）；生成记录与出图按任务提交时间归入周期。搜索、日期、板块和模型同时作用于汇总、列表、详情、导出及分析。模型选项来自本次打开页面后已载入的记录；可先清除板块 / 模型并应用时间范围，以载入更多模型。")}</p><p className="mt-1">{staticUiText("成功出图统计实际图片张数，不是成功请求次数。")}</p></details>
            {dirtyFilters ? <p role="status" className="mt-2 text-xs text-amber-700">{staticUiText("筛选条件尚未应用，先应用后再导出或分析。")}</p> : null}
        </header>
        {errors.list ? <Alert type="error" showIcon title={display(errors.list)} /> : null}
        {notice ? <Alert type="info" showIcon title={display(notice)} closable onClose={() => setNotice("")} /> : null}
        {data ? <CoverageNotice coverage={data.coverage} /> : <Alert type="info" title={busy.list ? staticUiText("正在读取记录与采集覆盖范围…") : staticUiText("尚未载入记录；没有数据不等于没有使用。")} />}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label={staticUiText("使用简要统计")}>
            <SummaryTile title={staticUiText("成功出图（张）")} value={summary.generatedImages} detail={staticUiText("仅计成功任务实际返回的图片，不是请求次数")} loaded={Boolean(data)} />
            <SummaryTile title={staticUiText("模型调用次数")} value={summary.generationRequests + summary.chatRequests} detail={staticUiText("生成 {p0} · 文字 {p1}", { p0: `${summary.generationRequests}`, p1: `${summary.chatRequests}` })} loaded={Boolean(data)} />
            <SummaryTile title={staticUiText("已完成 / 失败")} value={`${summary.succeeded} / ${summary.failed}`} detail={staticUiText("未完成 {p0}；失败不等于用户操作有误", { p0: `${summary.pending}` })} loaded={Boolean(data)} />
            <SummaryTile title={staticUiText("板块访问记录")} value={summary.visits} detail={staticUiText("仅含采集开启后的有效访问事件")} loaded={Boolean(data)} />
            <SummaryTile title={staticUiText("交互操作记录")} value={summary.interactions} detail={staticUiText("白名单操作事件，不采集键盘输入或页面正文")} loaded={Boolean(data)} />
        </div>
        {data ? <p aria-label={staticUiText("统计简述")} className="text-sm leading-6 text-[var(--muted-foreground)]">{display(usageSummaryText(data.summary, data.breakdowns, data.coverage))}</p> : null}
        {data ? <UsageDailyTrend daily={data.breakdowns.daily} from={applied.from} to={applied.to} /> : null}
        <div className="grid min-w-0 gap-4 lg:grid-cols-3"><UsageBars title={staticUiText("模型调用分布")} values={data?.breakdowns.models || []} filterKind="model" selectedKey={applied.modelConfigId} disabled={queryLocked || dirtyFilters} onSelect={key => drillDown("model", key)} /><UsageBars title={staticUiText("板块使用分布")} values={data?.breakdowns.boards || []} filterKind="board" selectedKey={applied.boardKey} disabled={queryLocked || dirtyFilters} onSelect={key => drillDown("board", key)} /><UsageBars title={staticUiText("操作控件分布")} values={data?.breakdowns.controls || []} /></div>
        <section className="wb-surface min-w-0 p-4 sm:p-5" aria-label={staticUiText("用户使用列表")}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">{staticUiText("用户记录")}</h3><p className="mt-1 text-xs text-[var(--muted-foreground)]">{staticUiText("点击姓名查看详细记录。已选 ")}{selectedIds.length}{staticUiText(" 人；翻页与排序保留选择，修改筛选清空选择。")}</p><p className="mt-1 text-xs text-[var(--muted-foreground)]">{staticUiText("保留当前搜索内零记录员工；板块和模型只筛选记录。排序仅用于查看记录、定位问题，不表示人员排名或绩效。")}</p><p aria-label={staticUiText("使用分析人员排序")} className="mt-1 text-xs">{staticUiText("排序：")}{staticUiText(sortLabels[sorting.sort])} · {sorting.order === "asc" ? staticUiText("升序") : staticUiText("降序")}</p></div><div className="flex flex-wrap gap-2"><Button icon={<Download className="size-4" />} disabled={!selectedIds.length || !data || dirtyFilters || queryLocked} onClick={() => openExport({ userIds: selectedIds, label: `当前筛选内选中的 ${selectedIds.length} 位用户` })}>{staticUiText("导出选中（")}{selectedIds.length}）</Button><Button disabled={!data || dirtyFilters || queryLocked} onClick={() => openExport({ label: "当前筛选范围内的全部用户" })}>{staticUiText("导出筛选范围完整记录")}</Button></div></div>
            <Table<UsagePerson> size="small" rowKey="userId" loading={busy.list} dataSource={data?.people || []} scroll={{ x: 970 }}
                rowSelection={{ selectedRowKeys: selectedIds, preserveSelectedRowKeys: true, onChange: keys => { setSelectedIds(keys.map(String)); invalidatePreview(); }, getCheckboxProps: () => ({ disabled: queryLocked || dirtyFilters }) }}
                pagination={{ current: data?.pagination.page || 1, pageSize: 20, total: data?.pagination.total || 0, showSizeChanger: false, disabled: queryLocked || dirtyFilters, onChange: page => void load(applied, page) }}
                sortDirections={["descend", "ascend"]}
                onChange={(_pagination, _filters, sorter, extra) => {
                    if (extra.action !== "sort" || queryLocked || dirtyFilters) return;
                    const selected = Array.isArray(sorter) ? sorter[0] : sorter;
                    const next = selected?.order && typeof selected.columnKey === "string" && Object.hasOwn(sortLabels, selected.columnKey) ? { sort: selected.columnKey as PeopleSorting["sort"], order: selected.order === "ascend" ? "asc" as const : "desc" as const } : defaultSorting;
                    void load(applied, 1, false, next);
                }}
                columns={displayConfig<UsagePerson>([
                    { title: staticUiText("姓名"), dataIndex: "displayName", width: 160, render: (name, person) => <Button type="link" className="!h-auto !p-0" disabled={busy.detail || busy.list || dirtyFilters} onClick={() => openDetail(person)}><DisplayText text={name} /></Button> },
                    { title: staticUiText("部门"), dataIndex: "departmentName", render: value => value || staticUiText("未分配") },
                    { title: staticUiText("成功出图（张）"), key: "images", sorter: !queryLocked && !dirtyFilters, sortOrder: sorting.sort === "images" ? sorting.order === "asc" ? "ascend" : "descend" : null, width: 140, align: "right", render: (_, person) => person.summary.generatedImages },
                    { title: staticUiText("模型调用"), key: "requests", sorter: !queryLocked && !dirtyFilters, sortOrder: sorting.sort === "requests" ? sorting.order === "asc" ? "ascend" : "descend" : null, render: (_, person) => person.summary.generationRequests + person.summary.chatRequests },
                    { title: staticUiText("成功 / 失败"), key: "failed", sorter: !queryLocked && !dirtyFilters, sortOrder: sorting.sort === "failed" ? sorting.order === "asc" ? "ascend" : "descend" : null, showSorterTooltip: { title: staticUiText("按失败次数排序（含取消和中断）") }, render: (_, person) => `${person.summary.succeeded} / ${person.summary.failed}` },
                    { title: staticUiText("访问 / 操作"), render: (_, person) => `${person.summary.visits} / ${person.summary.interactions}` },
                    { title: staticUiText("最后记录"), key: "lastActivity", dataIndex: "lastActivityAt", sorter: !queryLocked && !dirtyFilters, sortOrder: sorting.sort === "lastActivity" ? sorting.order === "asc" ? "ascend" : "descend" : null, width: 180, render: value => staticUiText(dateText(value)) },
                    { title: staticUiText("导出"), width: 85, render: (_, person) => <Button size="small" disabled={dirtyFilters || mutableLocked} onClick={() => openExport({ userIds: [person.userId], label: person.displayName })}>{staticUiText("单人")}</Button> },
                ], "columns", data?.people)} />
        </section>
        <section className="wb-surface space-y-4 p-4 sm:p-5" aria-label={staticUiText("手动模型分析")}>
            <div><h3 className="flex items-center gap-2 font-semibold"><Sparkles className="size-4" />{staticUiText("手动分析工作流程")}</h3><p className="mt-1 text-sm text-[var(--muted-foreground)]">{staticUiText("先查看将发送的汇总，再选择已配置的文字模型。点击“发送已预览汇总”将调用当前配置的分析模型生成新报告。")}</p></div>
            <div className="grid gap-3 md:grid-cols-2"><label className="grid gap-1.5 text-xs">{staticUiText("分析范围")}<Select aria-label={staticUiText("使用分析范围")} value={analysisScope} disabled={mutableLocked} onChange={value => { setAnalysisScope(value); invalidatePreview(); }} options={displayConfig([{ value: "all", label: staticUiText("当前筛选范围全部用户") }, { value: "selected", label: staticUiText("已选 {p0} 人", { p0: `${selectedIds.length}` }), disabled: !selectedIds.length }], "options")} /></label><label className="grid gap-1.5 text-xs">{staticUiText("已配置文字模型")}<Select aria-label={staticUiText("使用分析文字模型")} value={textModelId} placeholder={busy.models ? staticUiText("正在读取文字模型…") : staticUiText("请选择文字模型")} loading={busy.models} disabled={busy.analyze || busy.models || !modelsLoaded} onChange={setTextModelId} options={displayConfig(textModels.map(model => ({ value: model.id, label: model.description ? `${model.name} · ${model.description}` : model.name })), "options")} notFoundContent={staticUiText("没有已启用的文字模型，请先完成 API 配置")} /></label></div>
            <div className="flex flex-wrap items-center gap-2"><Button size="small" aria-label={staticUiText("重新加载文字模型")} loading={busy.models} disabled={busy.analyze} onClick={() => void loadTextModels()}>{staticUiText("重新加载文字模型")}</Button><span className="text-xs text-[var(--muted-foreground)]">{staticUiText("选项由超级管理员专用接口读取，不依赖员工创作页面。")}</span></div>
            {errors.models ? <Alert type="error" title={staticUiText("文字模型读取失败：{p0}", { p0: display(errors.models) })} description={staticUiText("请手动重新加载；已有汇总可继续预览，但模型未就绪时不能发送分析。")} /> : null}
            {modelsLoaded && !textModels.length ? <Alert type="info" title={staticUiText("暂无可用于分析的文字模型")} description={staticUiText("请先配置并启用有有效凭据的文字模型，再点击重新加载文字模型。")} /> : null}
            <Checkbox checked={includeSamples} disabled={mutableLocked} onChange={event => { setIncludeSamples(event.target.checked); invalidatePreview(); }}>{staticUiText("额外包含少量已脱敏提示词摘要（可选，可能仍含业务信息）")}</Checkbox>
            <Alert type="info" showIcon title={staticUiText("默认不发送姓名、原始提示词或图片")} description={staticUiText("仅发送统计汇总及覆盖说明。可选摘要须先在下面预览；用途仅限流程改进，不进行人格推断、绩效评分或人员排名。")} />
            <div className="flex flex-wrap gap-2"><Button aria-label={staticUiText("预览将发送的汇总")} icon={<FileSearch className="size-4" />} loading={busy.preview} disabled={!data || dirtyFilters || busy.export || busy.analyze || (analysisScope === "selected" && !selectedIds.length)} onClick={() => void createPreview()}>{staticUiText("预览将发送的汇总")}</Button>{busy.preview ? <Button onClick={() => cancel("preview")}>{staticUiText("取消预览")}</Button> : null}<Button type="primary" aria-label={staticUiText("发送已预览汇总 · 手动分析")} loading={busy.analyze} disabled={!preview || previewUsed || !selectedModelAvailable || busy.models || Boolean(errors.models) || dirtyFilters || busy.export || busy.preview} onClick={() => void startAnalysis()}>{staticUiText("发送已预览汇总 · 手动分析")}</Button>{busy.analyze ? <Button danger icon={<X className="size-4" />} onClick={() => cancel("analyze")}>{staticUiText("取消等待分析")}</Button> : null}</div>
            {errors.preview ? <Alert type="error" title={display(errors.preview)} /> : null}{errors.analyze ? <Alert type="error" title={display(errors.analyze)} description={staticUiText("本次预览不自动重发；如需再次分析，请先生成新的预览并确认。")} /> : null}
            {preview ? <div className="rounded-lg border border-[var(--border)] p-4"><div className="mb-2 flex flex-wrap gap-2 text-xs"><Tag>{preview.estimatedCharacters}{staticUiText(" 字符")}</Tag><Tag>{preview.includesPromptSamples ? staticUiText("含 {p0} 条脱敏摘要", { p0: `${preview.sampleCount}` }) : staticUiText("不含提示词摘要")}</Tag><span>{staticUiText("有效期至 ")}{dateText(preview.expiresAt)}</span>{previewUsed ? <Tag>{staticUiText("已提交过，不重复发送")}</Tag> : null}</div>{preview.warnings.map(usageDisplayExplanation).filter(Boolean).map((warning, index) => <p key={index} className="mb-2 text-xs text-amber-700"><DisplayText text={warning} /></p>)}<pre data-testid="usage-analysis-preview" className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs leading-6"><SensitiveDisplayValue value={previewValue} /></pre></div> : null}
            {analysis ? <section aria-label={staticUiText("使用分析结果")} className="rounded-lg border border-[var(--border)] p-4"><h4 className="mb-2 font-medium">{staticUiText("分析结果 · ")}{dateText(analysis.createdAt)}</h4><pre className="whitespace-pre-wrap break-words text-sm leading-7">{display(analysis.content)}</pre><p className="mt-3 text-xs text-[var(--muted-foreground)]">{staticUiText("这是基于现有记录的辅助总结；覆盖不足不能解释为未工作或未使用工具。")}</p></section> : null}
        </section>
        <Drawer open={Boolean(detailPerson)} title={detailPerson ? staticUiText("{p0} · 使用记录", { p0: display(detailPerson.displayName) }) : staticUiText("使用记录")} width="min(960px, 100vw)" onClose={closeDetail} extra={detailPerson ? <Button disabled={mutableLocked || dirtyFilters} onClick={() => openExport({ userIds: [detailPerson.userId], label: detailPerson.displayName })}>{staticUiText("导出此人完整记录")}</Button> : null}>
            <DisplayTranslationScope visible={Boolean(detailPerson)}>
            <div className="space-y-4">
                <p className="text-xs text-[var(--muted-foreground)]">{display(appliedScope)}{staticUiText(" · 按提交时间统计生成记录；提示词、模型参数与操作事件分开呈现。")}</p>
                {busy.detail ? <div role="status" className="flex items-center gap-3"><Spin />{staticUiText("读取记录中")}<Button onClick={() => cancel("detail")}>{staticUiText("取消读取")}</Button></div> : null}
                {errors.detail ? <Alert type="error" title={display(errors.detail)} action={<Button onClick={() => detailPerson && openDetail(detailPerson)}>{staticUiText("重试读取")}</Button>} /> : null}
                {detail ? <>
                    <CoverageNotice coverage={detail.coverage} />
                    <div className="max-w-sm" aria-label={staticUiText("个人出图统计")}>
                        <SummaryTile title={staticUiText("成功出图（张）")} value={detail.summary.generatedImages} detail={staticUiText("所选周期成功任务实际返回的图片张数")} loaded />
                    </div>
                    <p aria-label={staticUiText("个人统计简述")} className="text-sm leading-6">{display(usageSummaryText(detail.summary, detail.breakdowns, detail.coverage, "所选日期内，该员工"))}</p>
                    <UsageDailyTrend title={staticUiText("个人每日趋势")} daily={detail.breakdowns.daily} from={applied.from} to={applied.to} />
                    <div className="grid min-w-0 gap-3 md:grid-cols-3">
                        <UsageBars title={staticUiText("个人模型调用分布")} values={detail.breakdowns.models} />
                        <UsageBars title={staticUiText("个人板块使用分布")} values={detail.breakdowns.boards} />
                        <UsageBars title={staticUiText("个人操作控件分布")} values={detail.breakdowns.controls} />
                    </div>
                    <p className="text-xs">{staticUiText("模型调用 ")}{detail.summary.generationRequests + detail.summary.chatRequests}{staticUiText(" 次 · 成功请求 ")}{detail.summary.succeeded}{staticUiText(" 次 · 失败请求 ")}{detail.summary.failed}{staticUiText(" 次 · 操作 ")}{detail.summary.interactions}{staticUiText(" 次 · 记录共 ")}{detail.pagination.total}{staticUiText(" 条（分页显示，不代表仅有当前页）")}</p>
                    <div className="space-y-3">{detail.records.length ? detail.records.map(record => <UsageRecordCard key={`${record.kind}:${record.id}`} record={record} />) : <Empty description={staticUiText("所选日期内没有可用记录，请同时查看采集覆盖说明")} />}</div>
                    <Pagination size="small" current={detail.pagination.page} pageSize={20} total={detail.pagination.total} showSizeChanger={false} disabled={busy.detail} onChange={page => detailPerson && openDetail(detailPerson, page)} />
                </> : null}
            </div>
            </DisplayTranslationScope>
        </Drawer>
        <Modal open={Boolean(exportSelection)} title={staticUiText("导出完整使用记录")} onCancel={() => { if (busy.export) cancel("export"); setExportSelection(null); }} footer={<><Button onClick={() => { if (busy.export) cancel("export"); setExportSelection(null); }}>{busy.export ? staticUiText("取消导出") : staticUiText("返回")}</Button><Button type="primary" aria-label={staticUiText("开始导出完整记录")} loading={busy.export} onClick={() => void startExport()}>{staticUiText("开始导出完整记录")}</Button></>}>
            <div className="space-y-4"><p>{staticUiText("范围：")}{exportSelection ? display(exportSelection.label) : null}；{display(appliedScope)}。</p><Alert type="warning" showIcon title={staticUiText("文件包含业务记录，请妥善保管")} description={staticUiText("包含当前可采集的全部请求、已保存提示词、白名单参数、操作事件及覆盖说明；不含密钥、图片字节或未曾采集的历史操作。JSONL 支持逐行读取，不静默截断。")} /><label className="grid gap-1.5 text-xs">{staticUiText("保存方式")}<Select aria-label={staticUiText("使用记录保存方式")} disabled={busy.export} value={exportMode} onChange={setExportMode} options={displayConfig([{ value: "download", label: staticUiText("浏览器下载") }, { value: "location", label: savePicker ? staticUiText("选择保存位置（可选择桌面，适合大文件）") : staticUiText("当前浏览器不支持选择位置，请使用下载"), disabled: !savePicker }], "options")} /></label><p className="text-xs text-[var(--muted-foreground)]">{staticUiText("桌面位置需你在浏览器保存对话框选择；服务器不能直接写入你的桌面。大文件建议选择保存位置以流式写入。")}</p>{busy.export ? <p role="status">{staticUiText("正在导出，已读取 ")}{exportProgress}{staticUiText(" 条记录；收到完整结束标记后才保存。")}</p> : null}{errors.export ? <Alert type="error" title={display(errors.export)} /> : null}</div>
        </Modal>
    </section>;
}

function SummaryTile({ title, value, detail, loaded }: { title: string; value: number | string; detail: string; loaded: boolean }) {
    return <section className="wb-surface p-4"><h3 className="text-xs text-[var(--muted-foreground)]">{title}</h3><p className="my-2 text-2xl font-semibold tabular-nums">{loaded ? value : "—"}</p><p className="text-xs leading-5 text-[var(--muted-foreground)]">{detail}</p></section>;
}
function CoverageNotice({ coverage }: { coverage: UsageCoverage }) {
    useUiLocale();
    const [open, setOpen] = useState(false);
    return <Alert type="warning" showIcon title={staticUiText("采集覆盖有边界，零记录不等于未使用")} description={<div className="space-y-1 text-xs leading-5"><p>{staticUiText("交互采集起点：")}{staticUiText(dateText(coverage.collectionStartedAt))}{staticUiText("。历史点击和聊天不能回补。")}</p>{(coverage.droppedEventCount || 0) > 0 ? <p>{staticUiText("已知采集缺口：")}{coverage.droppedEventCount}{staticUiText(" 条事件未完整保存；统计可能低于实际使用量。")}</p> : null}<details onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer">{staticUiText("查看完整采集与统计说明")}</summary><DisplayTranslationScope visible={open}><div className="mt-2 space-y-1">{coverage.notes.map(usageDisplayExplanation).filter(Boolean).map((note, index) => <p key={index}><DisplayText text={note} /></p>)}</div></DisplayTranslationScope></details></div>} />;
}
export function UsageBars({ title, values, filterKind, selectedKey, disabled, onSelect }: { title: string; values: UsageBucket[]; filterKind?: "board" | "model"; selectedKey?: string; disabled?: boolean; onSelect?: (key: string) => void }) {
    useUiLocale();
    const display = useDisplayText();
    const maximum = Math.max(1, ...values.map(value => value.count));
    return <section className="wb-surface min-w-0 p-4 sm:p-5" aria-label={title}><h3 className="font-semibold">{title}</h3>{onSelect ? <p className="mt-1 text-xs text-[var(--muted-foreground)]">{staticUiText("点击已记录的")}{filterKind === "model" ? staticUiText("模型") : staticUiText("板块")}{staticUiText("可筛选全部统计")}</p> : null}{values.length ? <ol className="mt-4 max-h-72 space-y-3 overflow-y-auto">{values.map(value => <li key={value.key}><div className="mb-1 flex items-start justify-between gap-3 text-xs">{onSelect && filterKind && isUsageFilterBucket(filterKind, value.key) ? <button type="button" aria-label={staticUiText("筛选{p0}：{p1}", { p0: `${title}`, p1: display(value.label) })} aria-pressed={selectedKey === value.key} disabled={disabled} className="min-w-0 break-words text-left text-[var(--primary)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60" onClick={() => onSelect(value.key)}>{display(value.label)}{selectedKey === value.key ? staticUiText(" · 已筛选") : ""}</button> : <span className="min-w-0 break-words">{display(value.label)}</span>}<span className="shrink-0 tabular-nums">{value.count} {filterKind === "model" ? staticUiText("次调用") : staticUiText("条记录")}</span></div><div className="h-2 rounded bg-[var(--muted)]"><div className="h-full rounded bg-[var(--primary)]" style={{ width: `${Math.max(0, value.count) / maximum * 100}%` }} /></div></li>)}</ol> : <p className="py-8 text-center text-xs text-[var(--muted-foreground)]">{staticUiText("暂无可统计记录")}</p>}</section>;
}
type UsageTrendMetric = "requests" | "images" | "successRate";
const trendMetrics: Array<{ value: UsageTrendMetric; label: string }> = [{ value: "requests", label: "模型请求（次）" }, { value: "images", label: "成功出图（张）" }, { value: "successRate", label: "终态成功率（%）" }];
export function usageTrendValue(summary: UsageSummary, metric: UsageTrendMetric): number | null {
    if (metric === "images") return summary.generatedImages;
    if (metric === "successRate") return summary.succeeded + summary.failed ? summary.succeeded / (summary.succeeded + summary.failed) * 100 : null;
    return summary.generationRequests + summary.chatRequests;
}
const trendValueText = (value: number | null, metric: UsageTrendMetric) => value === null ? "—" : metric === "successRate" ? `${value.toFixed(1)}%` : String(value);
export function UsageDailyTrend({ daily, from, to, title = "每日趋势" }: { daily: UsageBreakdowns["daily"]; from: string; to: string; title?: string }) {
    useUiLocale();
    const displayConfig = useDisplayConfig();
    const displayTitle = staticUiText(title);
    const [metric, setMetric] = useState<UsageTrendMetric>("requests");
    const rows = [...daily].sort((a, b) => a.day.localeCompare(b.day));
    const start = new Date(`${from}T00:00:00+08:00`).getTime();
    const days = Math.max(1, (new Date(`${to}T00:00:00+08:00`).getTime() - start) / dayMilliseconds + 1);
    const maximum = metric === "successRate" ? 100 : rows.reduce((max, row) => Math.max(max, usageTrendValue(row, metric) ?? 0), 1);
    const metricLabel = staticUiText(trendMetrics.find(item => item.value === metric)!.label);
    return <section className="wb-surface min-w-0 p-4 sm:p-5" aria-label={displayTitle}>
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">{displayTitle}</h3><p className="mt-1 text-xs text-[var(--muted-foreground)]">{from}{staticUiText(" 至 ")}{to}{staticUiText(" · 北京时间 · 按提交日期与当前状态统计")}</p></div><Select aria-label={staticUiText("{p0}指标", { p0: `${displayTitle}` })} className="min-w-52" value={metric} options={displayConfig(trendMetrics, "options")} onChange={setMetric} /></div>
        {rows.length ? <>
            <svg role="img" aria-label={staticUiText("{p0}：{p1}，{p2} 至 {p3}", { p0: `${displayTitle}`, p1: `${metricLabel}`, p2: `${from}`, p3: `${to}` })} viewBox="0 0 720 148" className="mt-4 h-44 w-full text-[var(--muted-foreground)]">
                <text x="66" y="15" textAnchor="end" fontSize="10" fill="currentColor">{maximum}</text><text x="66" y="119" textAnchor="end" fontSize="10" fill="currentColor">0</text>
                <line x1="72" y1="116" x2="692" y2="116" stroke="var(--border)" />
                {rows.map(row => { const value = usageTrendValue(row, metric), offset = (new Date(`${row.day}T00:00:00+08:00`).getTime() - start) / dayMilliseconds, width = Math.max(.4, Math.min(18, 620 / days * .7)), height = value === null ? 0 : value / maximum * 100; return <rect key={row.day} x={72 + (offset + .5) / days * 620 - width / 2} y={116 - height} width={width} height={height} rx="1" fill="var(--primary)"><title>{row.day} · {metricLabel}：{trendValueText(value, metric)}</title></rect>; })}
                <text x="72" y="139" fontSize="11" fill="currentColor">{from}</text><text x="692" y="139" textAnchor="end" fontSize="11" fill="currentColor">{to}</text>
            </svg>
            <details className="mt-2"><summary className="cursor-pointer text-xs">{staticUiText("查看每日准确数据（")}{rows.length}{staticUiText(" 个有记录日期）")}</summary><div className="mt-3 max-h-80 overflow-auto"><table className="w-full whitespace-nowrap text-right text-xs tabular-nums" aria-label={staticUiText("{p0}数据表", { p0: `${displayTitle}` })}><thead><tr>{["日期", "生成请求", "文字请求", "成功", "失败 / 取消 / 中断", "未完成", "终态成功率", "实际图片", "访问", "交互"].map(label => <th key={label} scope="col" className="border-b border-[var(--border)] px-3 py-2 font-medium">{staticUiText(label)}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.day}><th scope="row" className="border-b border-[var(--border)] px-3 py-2 font-normal">{row.day}</th>{[row.generationRequests, row.chatRequests, row.succeeded, row.failed, row.pending, trendValueText(usageTrendValue(row, "successRate"), "successRate"), row.generatedImages, row.visits, row.interactions].map((value, index) => <td key={index} className="border-b border-[var(--border)] px-3 py-2">{value}</td>)}</tr>)}</tbody></table></div></details>
        </> : <p className="py-8 text-center text-xs text-[var(--muted-foreground)]">{staticUiText("当前筛选范围没有可展示的每日记录")}</p>}
        <p className="mt-3 text-xs leading-5 text-[var(--muted-foreground)]">{staticUiText("模型请求 = 生成请求 + 文字请求；访问、交互与采集缺口不算调用。终态成功率 = 成功 ÷（成功 + 失败 / 取消 / 中断），未完成不参与，无终态请求显示“—”。空白日期表示无已记录数据，不代表未使用。")}</p>
    </section>;
}
function UsageRecordCard({ record }: { record: UsageRecord }) {
    useUiLocale();
    const display = useDisplayText();
    const [open, setOpen] = useState(false);
    // Consent applies only to the visible projection, never hidden financial
    // metadata. Keep it stable so rerenders do not invalidate explicit consent.
    const visibleParameters = useMemo(() => omitFinancialFields(record.parameters), [record.parameters]);
    const isOperation = record.kind === "visit" || record.kind === "interaction" || record.kind === "gap";
    const kind = staticUiText({ visit: "板块访问", interaction: "操作事件", generation: "生成请求", chat: "文字调用", gap: "采集缺口" }[record.kind]);
    const status = staticUiText(({ success: "成功", succeeded: "成功", failed: "失败", processing: "处理中", pending: "等待中", queued: "排队中", cancelled: "已取消", paused: "已暂停", recorded: "已记录" } as Record<string, string>)[record.status]) || record.status;
    return <article className="rounded-lg border border-[var(--border)] p-3" aria-label={`${kind} ${record.id}`}><div className="flex flex-wrap items-center gap-2"><Tag>{kind}</Tag><Tag color={record.status === "failed" ? "error" : ["success", "succeeded"].includes(record.status) ? "success" : "default"}>{display(status)}</Tag><span className="text-xs text-[var(--muted-foreground)]">{dateText(record.occurredAt)}{staticUiText("（北京时间）")}</span></div><p className="mt-2 text-sm">{display(record.boardLabel)} · {display(record.modelName || staticUiText("未关联模型"))}</p>{record.kind === "generation" ? <p className="mt-2 text-xs tabular-nums">{staticUiText("成功实际出图 ")}{record.generatedImages}{staticUiText(" 张")}</p> : null}{isOperation ? <p className="mt-2 text-xs">{staticUiText("操作：")}{record.action ? display(record.action) : null}{staticUiText("；控件：")}{record.controlLabel ? display(record.controlLabel) : record.controlKey || staticUiText("未记录")}{staticUiText("。操作事件不等于一次模型调用。")}</p> : null}<details className="mt-3" onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-xs">{isOperation ? staticUiText("查看操作参数") : staticUiText("查看提示词与模型参数")}</summary><DisplayTranslationScope visible={open}>{!isOperation ? <div className="mt-3"><h5 className="mb-1 text-xs font-medium">{staticUiText("提示词")}{record.promptRedacted ? staticUiText("（已脱敏）") : ""}</h5><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--muted)] p-2 text-xs leading-5">{record.prompt === null ? staticUiText("未采集或不可用，不代表用户没有填写") : <SensitiveDisplayValue value={record.prompt} />}</pre></div> : null}<h5 className="mb-1 mt-3 text-xs font-medium">{isOperation ? staticUiText("白名单操作参数") : staticUiText("已记录模型参数")}</h5><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--muted)] p-2 text-xs leading-5"><SensitiveDisplayValue value={visibleParameters} format={formatNonFinancialJson} /></pre></DisplayTranslationScope></details></article>;
}
