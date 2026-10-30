import { Alert, Button, Checkbox, Drawer, Empty, Input, Modal, Pagination, Select, Spin, Table, Tag, Typography } from "antd";
import { Download, FileSearch, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { saveAs } from "file-saver";
import type { UsageAnalysisModelsResult, UsageBreakdowns, UsageBucket, UsageCoverage, UsagePerson, UsageRecord, UsageSummary } from "../../../../../shared/usage-analytics";
import { analyzeUsage, exportUsageRecords, getUsagePerson, listUsageAnalysisModels, listUsagePeople, previewUsageAnalysis, type UsageAnalysisPreview, type UsageAnalysisResult, type UsageFilters, type UsagePeopleResult, type UsagePersonResult } from "@/services/api/usage-analytics";
import { useUserStore } from "@/stores/use-user-store";
import { formatBeijingDateTime } from "@/lib/beijing-time";

type DateFilter = { from: string; to: string; search: string };
type Operation = "list" | "detail" | "export" | "preview" | "analyze" | "models";
type ExportSelection = { userIds?: string[]; label: string };
type WritableExport = { write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> };
type SavePicker = (options: { suggestedName: string; startIn: "desktop"; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{ createWritable(): Promise<WritableExport> }>;
const emptySummary: UsageSummary = { visits: 0, interactions: 0, generationRequests: 0, chatRequests: 0, succeeded: 0, failed: 0, pending: 0, totalRmbCost: 0, generatedImages: 0 };
const dateText = (value: string | null) => value ? formatBeijingDateTime(value) : "未记录";
const beijingDay = (date: Date) => formatBeijingDateTime(date).slice(0, 10);
const dayMilliseconds = 24 * 60 * 60 * 1000;
const formatRmbCost = (value: number) => `￥${value.toFixed(6)}`;
export const defaultUsageDateFilter = (now = new Date()): DateFilter => ({ from: beijingDay(new Date(now.getTime() - 29 * dayMilliseconds)), to: beijingDay(now), search: "" });

/** Inclusive Beijing calendar dates become UTC instants with an exclusive next-day end. */
export function usageRangeFilters(value: DateFilter): UsageFilters {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.from) || !/^\d{4}-\d{2}-\d{2}$/.test(value.to)) throw new Error("请选择完整的开始和结束日期。");
    const start = new Date(`${value.from}T00:00:00+08:00`), end = new Date(`${value.to}T00:00:00+08:00`);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || beijingDay(start) !== value.from || beijingDay(end) !== value.to || start > end) throw new Error("日期无效，或开始日期晚于结束日期。");
    return { from: start.toISOString(), to: new Date(end.getTime() + dayMilliseconds).toISOString(), ...(value.search.trim() ? { search: value.search.trim() } : {}) };
}

export function usageSelectionFilters(value: DateFilter, userIds?: string[]): UsageFilters {
    if (userIds && !userIds.length) throw new Error("请先选择至少一位用户。");
    return { ...usageRangeFilters(value), ...(userIds ? { userIds: [...new Set(userIds)] } : {}) };
}

/** Deterministic description of the supplied scope, never a model inference or employee assessment. */
export function usageSummaryText(summary: UsageSummary, breakdowns: UsageBreakdowns, coverage: UsageCoverage, scope = "当前筛选范围") {
    const mostUsed = (values: UsageBucket[]) => values.reduce<UsageBucket | undefined>((top, value) => value.count > (top?.count || 0) ? value : top, undefined);
    const model = mostUsed(breakdowns.models), board = mostUsed(breakdowns.boards), control = mostUsed(breakdowns.controls);
    return `${scope}已记录 ${summary.generationRequests + summary.chatRequests} 次模型请求（生成 ${summary.generationRequests} 次、文字 ${summary.chatRequests} 次），成功 ${summary.succeeded} 次、失败 ${summary.failed} 次、未完成 ${summary.pending} 次。已记账生成消费 ${formatRmbCost(summary.totalRmbCost)}，成功实际出图 ${summary.generatedImages} 张（不是请求次数）。${model ? `常用模型为“${model.label}”（${model.count} 次调用）` : "暂无可用模型调用分布"}；${board ? `常用板块为“${board.label}”（${board.count} 条记录）` : "暂无可用板块记录"}；${control ? `常用操作控件为“${control.label}”（${control.count} 条记录）` : "暂无可用操作控件记录"}。${(coverage.droppedEventCount || 0) > 0 ? `另有 ${coverage.droppedEventCount} 条已知采集缺口，统计可能偏低。` : ""}历史点击与聊天不能回补，记录不足不能解释为未工作或未使用。`;
}

export function UsageAnalyticsPanel() {
    const user = useUserStore(state => state.user);
    const isAdmin = user?.role === "super_admin";
    const [draft, setDraft] = useState<DateFilter>(defaultUsageDateFilter);
    const [applied, setApplied] = useState<DateFilter>(defaultUsageDateFilter);
    const [data, setData] = useState<UsagePeopleResult | null>(null);
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
    const controllers = useRef(new Map<Operation, AbortController>());
    const mounted = useRef(true);
    const savePicker = typeof window === "undefined" ? undefined : (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    const dirtyFilters = JSON.stringify(draft) !== JSON.stringify(applied);
    const selectedModelAvailable = modelsLoaded && textModels.some(model => model.id === textModelId);
    const summary = data?.summary || emptySummary;
    const mutableLocked = Boolean(busy.export || busy.preview || busy.analyze);

    const invalidatePreview = () => { setPreview(null); setPreviewUsed(false); setAnalysis(null); };
    const cancel = (operation: Operation) => {
        controllers.current.get(operation)?.abort();
        setNotice(operation === "analyze" ? "已取消等待分析结果。若请求已提交给供应商，仍可能产生费用；本页不会自动重发。" : "操作已取消，已有数据和文件不会被替换为不完整结果。");
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

    const load = (filters: DateFilter, page = 1, resetSelection = false) => run("list", async signal => {
        const result = await listUsagePeople({ ...usageRangeFilters(filters), page, pageSize: 20 }, signal);
        signal.throwIfAborted(); setData(result); setApplied({ ...filters });
        if (resetSelection) { setSelectedIds([]); invalidatePreview(); setDetailPerson(null); setDetail(null); controllers.current.get("detail")?.abort(); }
    });
    const loadTextModels = () => run("models", async signal => {
        setModelsLoaded(false); setTextModels([]);
        const result = await listUsageAnalysisModels(signal);
        signal.throwIfAborted(); setTextModels(result.models); setModelsLoaded(true);
        setTextModelId(current => result.models.some(model => model.id === current) ? current : undefined);
    });
    useEffect(() => {
        mounted.current = true;
        setBusy({}); setErrors({}); setNotice(""); setExportSelection(null); setExportProgress(0);
        setData(null); setSelectedIds([]); setDetailPerson(null); setDetail(null); invalidatePreview();
        setTextModels([]); setTextModelId(undefined); setModelsLoaded(false); setAnalysisScope("all"); setIncludeSamples(false);
        const filters = defaultUsageDateFilter(); setDraft(filters); setApplied(filters);
        if (isAdmin) { void load(filters, 1, true); void loadTextModels(); }
        return () => { mounted.current = false; controllers.current.forEach(controller => controller.abort()); controllers.current.clear(); };
    }, [isAdmin, user?.id]);

    const openDetail = (person: UsagePerson, page = 1) => {
        if (controllers.current.has("detail")) return;
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
            const result = await exportUsageRecords(filters, { signal, onProgress: count => { if (!signal.aborted) setExportProgress(count); }, ...(writable ? { writeChunk: (chunk: Uint8Array) => writable!.write(chunk) } : {}) });
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

    if (!isAdmin) return <Alert type="warning" showIcon title="仅超级管理员可访问使用分析" description="部门管理员和普通员工不能查看、导出或分析其他用户的记录。" />;

    return <section aria-label="使用分析" className="min-w-0 space-y-5">
        <header className="wb-surface p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div><Typography.Title level={3} className="!mb-1 !text-lg">使用分析</Typography.Title><p className="text-sm text-[var(--muted-foreground)]">从可核查的记录了解工作流程与工具使用习惯，不做人格推断、绩效评分或人员排名。</p></div>
                <Tag>仅超级管理员</Tag>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-[minmax(180px,1fr)_160px_160px_auto]">
                <label className="grid gap-1.5 text-xs">搜索用户<Input aria-label="搜索使用分析用户" value={draft.search} maxLength={100} placeholder="姓名或账号" disabled={mutableLocked} prefix={<Search className="size-4" />} onChange={event => setDraft(current => ({ ...current, search: event.target.value }))} onPressEnter={() => void load(draft, 1, true)} /></label>
                <label className="grid gap-1.5 text-xs">开始日期<Input type="date" aria-label="使用分析开始日期" value={draft.from} disabled={mutableLocked} onChange={event => setDraft(current => ({ ...current, from: event.target.value }))} /></label>
                <label className="grid gap-1.5 text-xs">结束日期<Input type="date" aria-label="使用分析结束日期" value={draft.to} disabled={mutableLocked} onChange={event => setDraft(current => ({ ...current, to: event.target.value }))} /></label>
                <div className="flex items-end gap-2"><Button type="primary" aria-label="应用筛选" icon={<RefreshCw className="size-4" />} loading={busy.list} disabled={mutableLocked} onClick={() => void load(draft, 1, true)}>应用筛选</Button>{busy.list ? <Button onClick={() => cancel("list")}>取消加载</Button> : null}</div>
            </div>
            <p className="mt-2 text-xs leading-5 text-[var(--muted-foreground)]">日期包含起止两天，固定按北京时间（UTC+8）；生成费用与出图按任务提交时间归入周期。搜索和日期同时作用于汇总、列表、导出及分析，所有时间均显示北京时间。</p>
            <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">生成消费汇总图片、视频、音频的已记账人民币费用，不含未独立结算的聊天。历史成本按原记录汇总，不按当前单价追溯重算；成功出图统计实际图片张数，不是成功请求次数。</p>
            {dirtyFilters ? <p role="status" className="mt-2 text-xs text-amber-700">筛选条件尚未应用，先应用后再导出或分析。</p> : null}
        </header>
        {errors.list ? <Alert type="error" showIcon title={errors.list} /> : null}
        {notice ? <Alert type="info" showIcon title={notice} closable onClose={() => setNotice("")} /> : null}
        {data ? <CoverageNotice coverage={data.coverage} /> : <Alert type="info" title={busy.list ? "正在读取记录与采集覆盖范围…" : "尚未载入记录；没有数据不等于没有使用。"} />}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="使用简要统计">
            <SummaryTile title="生成消费（元）" value={formatRmbCost(summary.totalRmbCost)} detail="当前搜索与日期范围的已记账生成费用" loaded={Boolean(data)} />
            <SummaryTile title="成功出图（张）" value={summary.generatedImages} detail="仅计成功任务实际返回的图片，不是请求次数" loaded={Boolean(data)} />
            <SummaryTile title="模型调用次数" value={summary.generationRequests + summary.chatRequests} detail={`生成 ${summary.generationRequests} · 文字 ${summary.chatRequests}`} loaded={Boolean(data)} />
            <SummaryTile title="已完成 / 失败" value={`${summary.succeeded} / ${summary.failed}`} detail={`未完成 ${summary.pending}；失败不等于用户操作有误`} loaded={Boolean(data)} />
            <SummaryTile title="板块访问记录" value={summary.visits} detail="仅含采集开启后的有效访问事件" loaded={Boolean(data)} />
            <SummaryTile title="交互操作记录" value={summary.interactions} detail="白名单操作事件，不采集键盘输入或页面正文" loaded={Boolean(data)} />
        </div>
        {data ? <p aria-label="统计简述" className="text-sm leading-6 text-[var(--muted-foreground)]">{usageSummaryText(data.summary, data.breakdowns, data.coverage)}</p> : null}
        <div className="grid min-w-0 gap-4 lg:grid-cols-3"><UsageBars title="模型调用分布" values={data?.breakdowns.models || []} /><UsageBars title="板块使用分布" values={data?.breakdowns.boards || []} /><UsageBars title="操作控件分布" values={data?.breakdowns.controls || []} /></div>
        <section className="wb-surface min-w-0 p-4 sm:p-5" aria-label="用户使用列表">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">用户记录</h3><p className="mt-1 text-xs text-[var(--muted-foreground)]">点击姓名查看详细记录。已选 {selectedIds.length} 人；选择可跨页保留。</p></div><div className="flex flex-wrap gap-2"><Button icon={<Download className="size-4" />} disabled={!selectedIds.length || !data || dirtyFilters || mutableLocked} onClick={() => openExport({ userIds: selectedIds, label: `当前筛选内选中的 ${selectedIds.length} 位用户` })}>导出选中（{selectedIds.length}）</Button><Button disabled={!data || dirtyFilters || mutableLocked} onClick={() => openExport({ label: "当前搜索与日期范围内的全部用户" })}>导出筛选范围完整记录</Button></div></div>
            <Table<UsagePerson> size="small" rowKey="userId" loading={busy.list} dataSource={data?.people || []} scroll={{ x: 1120 }}
                rowSelection={{ selectedRowKeys: selectedIds, preserveSelectedRowKeys: true, onChange: keys => { setSelectedIds(keys.map(String)); invalidatePreview(); }, getCheckboxProps: () => ({ disabled: mutableLocked }) }}
                pagination={{ current: data?.pagination.page || 1, pageSize: 20, total: data?.pagination.total || 0, showSizeChanger: false, onChange: page => void load(applied, page) }}
                columns={[
                    { title: "姓名", dataIndex: "displayName", width: 160, render: (name, person) => <Button type="link" className="!h-auto !p-0" disabled={busy.detail} onClick={() => openDetail(person)}>{name}</Button> },
                    { title: "部门", dataIndex: "departmentName", render: value => value || "未分配" },
                    { title: "生成消费（元）", width: 150, align: "right", render: (_, person) => <span className="tabular-nums">{formatRmbCost(person.summary.totalRmbCost)}</span> },
                    { title: "成功出图（张）", width: 120, align: "right", render: (_, person) => person.summary.generatedImages },
                    { title: "模型调用", render: (_, person) => person.summary.generationRequests + person.summary.chatRequests },
                    { title: "成功 / 失败", render: (_, person) => `${person.summary.succeeded} / ${person.summary.failed}` },
                    { title: "访问 / 操作", render: (_, person) => `${person.summary.visits} / ${person.summary.interactions}` },
                    { title: "最后记录", dataIndex: "lastActivityAt", width: 180, render: dateText },
                    { title: "导出", width: 85, render: (_, person) => <Button size="small" disabled={dirtyFilters || mutableLocked} onClick={() => openExport({ userIds: [person.userId], label: person.displayName })}>单人</Button> },
                ]} />
        </section>
        <section className="wb-surface space-y-4 p-4 sm:p-5" aria-label="手动模型分析">
            <div><h3 className="flex items-center gap-2 font-semibold"><Sparkles className="size-4" />手动分析工作流程</h3><p className="mt-1 text-sm text-[var(--muted-foreground)]">先查看将发送的汇总，再选择已配置的文字模型。预览不调用 LLM；点击“发送已预览汇总”才可能产生模型费用。</p></div>
            <div className="grid gap-3 md:grid-cols-2"><label className="grid gap-1.5 text-xs">分析范围<Select aria-label="使用分析范围" value={analysisScope} disabled={mutableLocked} onChange={value => { setAnalysisScope(value); invalidatePreview(); }} options={[{ value: "all", label: "当前筛选范围全部用户" }, { value: "selected", label: `已选 ${selectedIds.length} 人`, disabled: !selectedIds.length }]} /></label><label className="grid gap-1.5 text-xs">已配置文字模型<Select aria-label="使用分析文字模型" value={textModelId} placeholder={busy.models ? "正在读取文字模型…" : "请选择文字模型"} loading={busy.models} disabled={busy.analyze || busy.models || !modelsLoaded} onChange={setTextModelId} options={textModels.map(model => ({ value: model.id, label: model.description ? `${model.name} · ${model.description}` : model.name }))} notFoundContent="没有已启用的文字模型，请先完成 API 配置" /></label></div>
            <div className="flex flex-wrap items-center gap-2"><Button size="small" aria-label="重新加载文字模型" loading={busy.models} disabled={busy.analyze} onClick={() => void loadTextModels()}>重新加载文字模型</Button><span className="text-xs text-[var(--muted-foreground)]">选项由超级管理员专用接口读取，不依赖员工创作页面。</span></div>
            {errors.models ? <Alert type="error" title={`文字模型读取失败：${errors.models}`} description="请手动重新加载；已有汇总可继续预览，但模型未就绪时不能发送分析。" /> : null}
            {modelsLoaded && !textModels.length ? <Alert type="info" title="暂无可用于分析的文字模型" description="请先配置并启用有有效凭据的文字模型，再点击重新加载文字模型。" /> : null}
            <Checkbox checked={includeSamples} disabled={mutableLocked} onChange={event => { setIncludeSamples(event.target.checked); invalidatePreview(); }}>额外包含少量已脱敏提示词摘要（可选，可能仍含业务信息）</Checkbox>
            <Alert type="info" showIcon title="默认不发送姓名、原始提示词或图片" description="仅发送统计汇总及覆盖说明。可选摘要须先在下面预览；用途仅限流程改进，不进行人格推断、绩效评分或人员排名。" />
            <div className="flex flex-wrap gap-2"><Button aria-label="预览将发送的汇总" icon={<FileSearch className="size-4" />} loading={busy.preview} disabled={!data || dirtyFilters || busy.export || busy.analyze || (analysisScope === "selected" && !selectedIds.length)} onClick={() => void createPreview()}>预览将发送的汇总</Button>{busy.preview ? <Button onClick={() => cancel("preview")}>取消预览</Button> : null}<Button type="primary" aria-label="发送已预览汇总 · 手动分析" loading={busy.analyze} disabled={!preview || previewUsed || !selectedModelAvailable || busy.models || Boolean(errors.models) || dirtyFilters || busy.export || busy.preview} onClick={() => void startAnalysis()}>发送已预览汇总 · 手动分析</Button>{busy.analyze ? <Button danger icon={<X className="size-4" />} onClick={() => cancel("analyze")}>取消等待分析</Button> : null}</div>
            {errors.preview ? <Alert type="error" title={errors.preview} /> : null}{errors.analyze ? <Alert type="error" title={errors.analyze} description="本次预览不自动重发；如需再次分析，请先生成新的预览并确认。" /> : null}
            {preview ? <div className="rounded-lg border border-[var(--border)] p-4"><div className="mb-2 flex flex-wrap gap-2 text-xs"><Tag>{preview.estimatedCharacters} 字符</Tag><Tag>{preview.includesPromptSamples ? `含 ${preview.sampleCount} 条脱敏摘要` : "不含提示词摘要"}</Tag><span>有效期至 {dateText(preview.expiresAt)}</span>{previewUsed ? <Tag>已提交过，不重复发送</Tag> : null}</div>{preview.warnings.map((warning, index) => <p key={index} className="mb-2 text-xs text-amber-700">{warning}</p>)}<pre data-testid="usage-analysis-preview" className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">{preview.content}</pre></div> : null}
            {analysis ? <section aria-label="使用分析结果" className="rounded-lg border border-[var(--border)] p-4"><h4 className="mb-2 font-medium">分析结果 · {dateText(analysis.createdAt)}</h4><pre className="whitespace-pre-wrap break-words text-sm leading-7">{analysis.content}</pre><p className="mt-3 text-xs text-[var(--muted-foreground)]">这是基于现有记录的辅助总结；覆盖不足不能解释为未工作或未使用工具。</p></section> : null}
        </section>
        <Drawer open={Boolean(detailPerson)} title={detailPerson ? `${detailPerson.displayName} · 使用记录` : "使用记录"} width="min(960px, 100vw)" onClose={closeDetail} extra={detailPerson ? <Button disabled={mutableLocked || dirtyFilters} onClick={() => openExport({ userIds: [detailPerson.userId], label: detailPerson.displayName })}>导出此人完整记录</Button> : null}>
            <div className="space-y-4">
                <p className="text-xs text-[var(--muted-foreground)]">{applied.from} 至 {applied.to}（北京时间，按提交时间统计生成记录）· 提示词、模型参数与操作事件分开呈现。</p>
                {busy.detail ? <div role="status" className="flex items-center gap-3"><Spin />读取记录中<Button onClick={() => cancel("detail")}>取消读取</Button></div> : null}
                {errors.detail ? <Alert type="error" title={errors.detail} action={<Button onClick={() => detailPerson && openDetail(detailPerson)}>重试读取</Button>} /> : null}
                {detail ? <>
                    <CoverageNotice coverage={detail.coverage} />
                    <div className="grid gap-3 sm:grid-cols-2" aria-label="个人消费与出图统计">
                        <SummaryTile title="生成消费（元）" value={formatRmbCost(detail.summary.totalRmbCost)} detail="所选周期的已记账生成费用；历史成本不追溯重算" loaded />
                        <SummaryTile title="成功出图（张）" value={detail.summary.generatedImages} detail="所选周期成功任务实际返回的图片张数" loaded />
                    </div>
                    <p aria-label="个人统计简述" className="text-sm leading-6">{usageSummaryText(detail.summary, detail.breakdowns, detail.coverage, "所选日期内，该员工")}</p>
                    <div className="grid min-w-0 gap-3 md:grid-cols-3">
                        <UsageBars title="个人模型调用分布" values={detail.breakdowns.models} />
                        <UsageBars title="个人板块使用分布" values={detail.breakdowns.boards} />
                        <UsageBars title="个人操作控件分布" values={detail.breakdowns.controls} />
                    </div>
                    <p className="text-xs">模型调用 {detail.summary.generationRequests + detail.summary.chatRequests} 次 · 成功请求 {detail.summary.succeeded} 次 · 失败请求 {detail.summary.failed} 次 · 操作 {detail.summary.interactions} 次 · 记录共 {detail.pagination.total} 条（分页显示，不代表仅有当前页）</p>
                    <div className="space-y-3">{detail.records.length ? detail.records.map(record => <UsageRecordCard key={`${record.kind}:${record.id}`} record={record} />) : <Empty description="所选日期内没有可用记录，请同时查看采集覆盖说明" />}</div>
                    <Pagination size="small" current={detail.pagination.page} pageSize={20} total={detail.pagination.total} showSizeChanger={false} disabled={busy.detail} onChange={page => detailPerson && openDetail(detailPerson, page)} />
                </> : null}
            </div>
        </Drawer>
        <Modal open={Boolean(exportSelection)} title="导出完整使用记录" onCancel={() => { if (busy.export) cancel("export"); setExportSelection(null); }} footer={<><Button onClick={() => { if (busy.export) cancel("export"); setExportSelection(null); }}>{busy.export ? "取消导出" : "返回"}</Button><Button type="primary" aria-label="开始导出完整记录" loading={busy.export} onClick={() => void startExport()}>开始导出完整记录</Button></>}>
            <div className="space-y-4"><p>范围：{exportSelection?.label}；日期：{applied.from} 至 {applied.to}。</p><Alert type="warning" showIcon title="文件包含业务记录，请妥善保管" description="包含当前可采集的全部请求、已保存提示词、白名单参数、操作事件及覆盖说明；不含密钥、图片字节或未曾采集的历史操作。JSONL 支持逐行读取，不静默截断。" /><label className="grid gap-1.5 text-xs">保存方式<Select aria-label="使用记录保存方式" disabled={busy.export} value={exportMode} onChange={setExportMode} options={[{ value: "download", label: "浏览器下载" }, { value: "location", label: savePicker ? "选择保存位置（可选择桌面，适合大文件）" : "当前浏览器不支持选择位置，请使用下载", disabled: !savePicker }]} /></label><p className="text-xs text-[var(--muted-foreground)]">桌面位置需你在浏览器保存对话框选择；服务器不能直接写入你的桌面。大文件建议选择保存位置以流式写入。</p>{busy.export ? <p role="status">正在导出，已读取 {exportProgress} 条记录；收到完整结束标记后才保存。</p> : null}{errors.export ? <Alert type="error" title={errors.export} /> : null}</div>
        </Modal>
    </section>;
}

function SummaryTile({ title, value, detail, loaded }: { title: string; value: number | string; detail: string; loaded: boolean }) {
    return <section className="wb-surface p-4"><h3 className="text-xs text-[var(--muted-foreground)]">{title}</h3><p className="my-2 text-2xl font-semibold tabular-nums">{loaded ? value : "—"}</p><p className="text-xs leading-5 text-[var(--muted-foreground)]">{detail}</p></section>;
}
function CoverageNotice({ coverage }: { coverage: UsageCoverage }) {
    return <Alert type="warning" showIcon title="采集覆盖有边界，零记录不等于未使用" description={<div className="space-y-1 text-xs leading-5"><p>交互采集起点：{dateText(coverage.collectionStartedAt)}。历史生成任务可统计；历史点击和历史聊天不能回补。</p>{(coverage.droppedEventCount || 0) > 0 ? <p>已知采集缺口：{coverage.droppedEventCount} 条事件未完整保存；统计可能低于实际使用量。</p> : null}{coverage.notes.map((note, index) => <p key={index}>{note}</p>)}</div>} />;
}
function UsageBars({ title, values }: { title: string; values: UsageBucket[] }) {
    const maximum = Math.max(1, ...values.map(value => value.count));
    return <section className="wb-surface min-w-0 p-4 sm:p-5" aria-label={title}><h3 className="mb-4 font-semibold">{title}</h3>{values.length ? <ol className="max-h-72 space-y-3 overflow-y-auto">{values.map(value => <li key={value.key}><div className="mb-1 flex justify-between gap-3 text-xs"><span className="min-w-0 break-words">{value.label}</span><span className="shrink-0 tabular-nums">{value.count} 次</span></div><div className="h-2 rounded bg-[var(--muted)]"><div className="h-full rounded bg-[var(--primary)]" style={{ width: `${Math.max(0, value.count) / maximum * 100}%` }} /></div></li>)}</ol> : <p className="py-8 text-center text-xs text-[var(--muted-foreground)]">暂无可统计记录</p>}</section>;
}
function UsageRecordCard({ record }: { record: UsageRecord }) {
    const isOperation = record.kind === "visit" || record.kind === "interaction" || record.kind === "gap";
    const kind = { visit: "板块访问", interaction: "操作事件", generation: "生成请求", chat: "文字调用", gap: "采集缺口" }[record.kind];
    const status = ({ success: "成功", succeeded: "成功", failed: "失败", processing: "处理中", pending: "等待中", queued: "排队中", cancelled: "已取消", paused: "已暂停", recorded: "已记录" } as Record<string, string>)[record.status] || record.status;
    return <article className="rounded-lg border border-[var(--border)] p-3" aria-label={`${kind} ${record.id}`}><div className="flex flex-wrap items-center gap-2"><Tag>{kind}</Tag><Tag color={record.status === "failed" ? "error" : ["success", "succeeded"].includes(record.status) ? "success" : "default"}>{status}</Tag><span className="text-xs text-[var(--muted-foreground)]">{dateText(record.occurredAt)}（北京时间）</span></div><p className="mt-2 text-sm">{record.boardLabel} · {record.modelName || "未关联模型"}</p>{record.kind === "generation" ? <p className="mt-2 text-xs tabular-nums">已记账生成消费 {formatRmbCost(record.totalRmbCost)} · 成功实际出图 {record.generatedImages} 张</p> : null}{isOperation ? <p className="mt-2 text-xs">操作：{record.action}；控件：{record.controlLabel || record.controlKey || "未记录"}。操作事件不等于一次模型调用。</p> : null}<details className="mt-3"><summary className="cursor-pointer text-xs">{isOperation ? "查看操作参数" : "查看提示词与模型参数"}</summary>{!isOperation ? <div className="mt-3"><h5 className="mb-1 text-xs font-medium">提示词{record.promptRedacted ? "（已脱敏）" : ""}</h5><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--muted)] p-2 text-xs leading-5">{record.prompt ?? "未采集或不可用，不代表用户没有填写"}</pre></div> : null}<h5 className="mb-1 mt-3 text-xs font-medium">{isOperation ? "白名单操作参数" : "已记录模型参数"}</h5><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--muted)] p-2 text-xs leading-5">{JSON.stringify(record.parameters, null, 2)}</pre></details></article>;
}
