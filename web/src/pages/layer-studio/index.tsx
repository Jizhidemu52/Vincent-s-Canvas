import { useEffect, useRef, useState, type ReactNode } from "react";
import { Select, Tooltip } from "antd";
import { ChevronDown, ChevronUp, ImagePlus, Layers3, LoaderCircle, RefreshCw, Sparkles, X } from "lucide-react";
import { WorkbenchTasks, useWorkbenchTask, useWorkbenchTaskStatus } from "@/components/workbench-tasks";
import { useUserStore } from "@/stores/use-user-store";
import { useModuleEnabled } from "@/stores/use-module-store";
import { workspaceOwnerHeaders } from "@/services/api/workspace-owner";
import { estimateLayerStudio, LayerStudioApiError, type LayerStudioEstimate } from "@/services/api/layer-studio";
import { LAYER_STUDIO_LABEL } from "../../../../shared/layer-studio";
import { LAYER_STUDIO_RATIOS, LAYER_STUDIO_TIERS } from "../../../../shared/layer-studio-options";
import { layerStudioParameters, validateLayerStudioForm, unresolvedLayerStudioJob, type LayerStudioForm, type LayerStudioJob, type LayerStudioReference } from "./page-state";
import { useLayerStudioWorkspace } from "./page-workspace";
import { LAYER_STUDIO_REFERENCE_ACCEPT, saveLayerStudioReference } from "./page-reference";
import { LayerStudioEditor } from "./layer-editor";
import { GenerationAccountHistory } from "@/components/generation-account-history";
import { useUiLocale, useUiText } from "@/lib/i18n";
import { layerStudioUiMessage } from "./page-copy";
import { DisplayText, DisplayTranslationPreview } from "@/hooks/use-display-text";

const control = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50";
const smallButton = "min-h-8 rounded-md px-2 py-1 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40";
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="grid min-w-0 gap-2 text-sm font-medium">{label}{children}</label>; }
const jobLabel = (job: LayerStudioJob) => job.phase === "complete" ? "已完成" : job.phase === "failed" ? "未完成" : job.phase === "uncertain" ? "待核查" : job.document ? "正在保存原件" : "处理中";

function ReferencePreview({ reference, assertCurrent }: { reference: LayerStudioReference; assertCurrent: () => void }) {
    const t = useUiText();
    const [url, setUrl] = useState("");
    useEffect(() => {
        if (!reference.previewable) return;
        const controller = new AbortController();
        let objectUrl = "";
        void (async () => {
            assertCurrent();
            const response = await fetch(`/api/assets/${encodeURIComponent(reference.id)}/thumb?w=256`, { credentials: "include", headers: workspaceOwnerHeaders(), signal: controller.signal });
            if (!response.ok || response.status === 202) return;
            const blob = await response.blob();
            assertCurrent(); controller.signal.throwIfAborted();
            objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
        })().catch(() => {});
        return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }, [reference.id, reference.previewable, assertCurrent]);
    return url ? <img src={url} alt={t("参考图预览")} className="size-12 shrink-0 rounded object-contain bg-muted" onError={() => setUrl("")} />
        : <span className="flex size-12 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground"><ImagePlus size={18} /></span>;
}

function LayerStudioPane({ ownerId }: { ownerId: string }) {
    const t = useUiText();
    const locale = useUiLocale();
    const taskPane = useWorkbenchTask();
    const workspace = useLayerStudioWorkspace(ownerId, taskPane.draftScope("layer-studio"));
    const { state, ready, busy, error, update, assertCurrent } = workspace;
    const form = state.form;
    const enabled = useModuleEnabled("layer-studio");
    const unresolved = state.jobs.some(unresolvedLayerStudioJob);
    const selected = state.jobs.find(job => job.requestId === state.selectedRequestId) || state.jobs[0];
    const [uploading, setUploading] = useState(false);
    const uploadingRef = useRef(false);
    const [inputError, setInputError] = useState("");
    const [accountHistoryOpen, setAccountHistoryOpen] = useState(false);
    const [estimate, setEstimate] = useState<{ key: string; value: LayerStudioEstimate } | null>(null);
    const [estimateError, setEstimateError] = useState("");
    const [estimateAttempt, setEstimateAttempt] = useState(0);
    const parameters = layerStudioParameters(form);
    const estimateKey = JSON.stringify([parameters, state.references.length]);
    let validation = "";
    try { validateLayerStudioForm(form, state.references.length); }
    catch (caught) { validation = caught instanceof Error && !caught.message.startsWith("[") ? caught.message : "请检查尺寸、图层数量和参数组合。"; }
    const locked = !ready || busy || uploading || unresolved;
    const quote = estimate?.key === estimateKey ? estimate.value : null;
    useWorkbenchTaskStatus({ ready, busy: busy || uploading || (!workspace.paused && state.jobs.some(job => job.phase === "pending" || job.phase === "submitting")), pending: unresolved, label: selected?.phase === "complete" ? t("已完成") : "" });

    useEffect(() => {
        setEstimateError("");
        if (!ready || !enabled || validation) return;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            void estimateLayerStudio(JSON.parse(estimateKey)[0], JSON.parse(estimateKey)[1], controller.signal)
                .then(value => { assertCurrent(); if (!controller.signal.aborted) setEstimate({ key: estimateKey, value }); })
                .catch(caught => { if (!controller.signal.aborted) setEstimateError(caught instanceof LayerStudioApiError ? caught.message : "任务配置暂时无法核验，请稍后重试。"); });
        }, 250);
        return () => { clearTimeout(timer); controller.abort(); };
    }, [ready, enabled, validation, estimateKey, estimateAttempt, assertCurrent]);

    const modify = (change: Partial<LayerStudioForm>) => { setInputError(""); void update(previous => ({ ...previous, form: { ...previous.form, ...change } })).catch(() => {}); };
    const addFiles = async (files: File[]) => {
        if (locked || uploadingRef.current || !files.length) return;
        const maximum = form.mode === "decompose" ? 1 : 10;
        if (state.references.length + files.length > maximum) { setInputError(`当前模式最多添加 ${maximum} 张参考图，未上传本批文件。`); return; }
        uploadingRef.current = true; setUploading(true); setInputError("");
        try {
            for (const file of files) {
                const reference = await saveLayerStudioReference(file, ownerId, assertCurrent);
                await update(previous => ({ ...previous, references: [...previous.references, reference] }));
            }
        } catch (caught) { setInputError(caught instanceof Error && !/https?:|apimart|seedream/i.test(caught.message) ? caught.message : "原图上传或校验失败；尚未创建生成任务，已成功保存的图片保留。"); }
        finally { uploadingRef.current = false; setUploading(false); }
    };
    const moveReference = (index: number, offset: number) => void update(previous => {
        const references = [...previous.references];
        [references[index], references[index + offset]] = [references[index + offset], references[index]];
        return { ...previous, references };
    }).catch(() => {});

    if (!ready) return <div className="p-5 text-sm" role={error ? "alert" : "status"}>{error ? layerStudioUiMessage(error) : t("正在读取独立工作区…")}{error && <button type="button" className={smallButton} onClick={workspace.retryRead}>{t("重试读取")}</button>}</div>;
    return <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-4">
            <Layers3 className="size-6 text-primary" /><div><h1 className="text-[28px] font-semibold leading-tight">{t(LAYER_STUDIO_LABEL)}</h1><p className="mt-1 text-[13px] text-muted-foreground">{t("拆分图层、生成画面，再自由组合。")}</p></div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(360px,440px)_minmax(0,1fr)] lg:overflow-hidden">
            <aside className="flex min-h-0 flex-col border-b border-border lg:border-r lg:border-b-0" aria-label={t("输入与生成设置")}>
              <div className="min-h-0 flex-1 space-y-4 p-4 lg:overflow-y-auto">
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="group" aria-label={t("工作模式")}>
                    {([['decompose', t("图层拆分")], ['generate', t("图片生成 / 编辑")]] as const).map(([mode, title]) => <button type="button" key={mode} disabled={locked} aria-pressed={form.mode === mode}
                        className={`min-h-9 rounded-md px-2 py-2 text-sm font-medium disabled:opacity-40 ${form.mode === mode ? "bg-background text-foreground" : "text-muted-foreground"}`}
                        onClick={() => modify({ mode, tier: mode === "decompose" ? "auto" : "2K" })}>{title}</button>)}
                </div>
                <section className="space-y-2" aria-label={t("参考图片")} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void addFiles(Array.from(event.dataTransfer.files)); }}>
                    <div className="flex items-center justify-between text-sm font-medium"><span>{form.mode === "decompose" ? t("原图 · 恰好 1 张") : t("参考图 · 0–10 张")}</span><span className="text-muted-foreground">{state.references.length} / {form.mode === "decompose" ? 1 : 10}</span></div>
                    {state.references.map((reference, index) => <div key={`${reference.id}:${index}`} className="flex items-center gap-2 rounded-lg border border-border p-2">
                        <ReferencePreview reference={reference} assertCurrent={assertCurrent} /><div className="min-w-0 flex-1 text-sm"><Tooltip title={<DisplayText text={reference.name} />}><p className="truncate">{index + 1}. <DisplayText text={reference.name} /></p></Tooltip><p className="mt-1 text-muted-foreground">{(reference.bytes / 1024 / 1024).toFixed(2)} MiB{reference.width ? ` · ${reference.width}×${reference.height}` : t(" · 尺寸待服务端核验")}</p>{!reference.previewable && <p className="mt-1 text-muted-foreground">{t("浏览器不能预览；原件未转换")}</p>}</div>
                        <div className="flex flex-col"><button type="button" aria-label={t("上移参考图 {index}", { index: index + 1 })} className={smallButton} disabled={locked || index === 0} onClick={() => moveReference(index, -1)}><ChevronUp size={12} /></button><button type="button" aria-label={t("下移参考图 {index}", { index: index + 1 })} className={smallButton} disabled={locked || index === state.references.length - 1} onClick={() => moveReference(index, 1)}><ChevronDown size={12} /></button></div>
                        <button type="button" aria-label={t("移除参考图 {index}", { index: index + 1 })} className={smallButton} disabled={locked} onClick={() => void update(previous => ({ ...previous, references: previous.references.filter((_, position) => position !== index) })).catch(() => {})}><X size={14} /></button>
                    </div>)}
                    <label className={`relative flex min-h-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border px-3 text-center text-sm text-muted-foreground ${locked ? "opacity-50" : "hover:bg-muted/50"}`}>
                        <ImagePlus size={20} /><span>{uploading ? t("正在保存原图…") : t("选择或拖入原图")}</span><input aria-label={t("上传参考图片")} type="file" multiple={form.mode === "generate"} accept={LAYER_STUDIO_REFERENCE_ACCEPT} disabled={locked} className="absolute inset-0 cursor-pointer opacity-0" onChange={event => { void addFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
                    </label><p className="text-[13px] leading-relaxed text-muted-foreground">{t("JPEG / PNG / WebP / BMP / TIFF / GIF / HEIC / HEIF；每张 ≤30 MiB、≤3600 万像素。原始字节不转换，按排列顺序引用。")}</p>
                </section>
                <Field label={form.mode === "decompose" ? t("拆分说明（可选）") : t("图片描述（必填）")}><textarea aria-label={form.mode === "decompose" ? t("拆分说明") : t("图片描述")} className={`${control} min-h-28 resize-y`} maxLength={20_000} disabled={locked} value={form.prompt} placeholder={form.mode === "decompose" ? t("可留空自动识别主体、文字与背景") : t("描述画面，或说明参考图的修改与融合方式")} onChange={event => modify({ prompt: event.target.value })} /></Field>
                <DisplayTranslationPreview text={form.prompt} />
                {form.mode === "generate" && <Field label={t("尺寸方式")}><Select aria-label={t("尺寸方式")} disabled={locked} value={form.sizeMode} onChange={sizeMode => modify({ sizeMode })} options={[{ value: "tier", label: t("自动比例 · 选择档位") }, { value: "ratio", label: t("指定宽高比") }, { value: "exact", label: t("精确像素") }]} /></Field>}
                {form.mode === "decompose" || form.sizeMode !== "exact" ? <div className="grid grid-cols-2 gap-3"><Field label={t("输出尺寸")}><Select aria-label={t("输出尺寸")} value={form.tier} disabled={locked} onChange={tier => modify({ tier })} options={[...(form.mode === "decompose" ? [{ value: "auto", label: t("适配原图") }] : []), ...LAYER_STUDIO_TIERS.map(value => ({ value, label: value }))]} /></Field>{form.mode === "generate" && form.sizeMode === "ratio" && <Field label={t("宽高比")}><Select aria-label={t("宽高比")} value={form.ratio} disabled={locked} onChange={ratio => modify({ ratio })} options={LAYER_STUDIO_RATIOS.map(value => ({ value, label: value }))} /></Field>}</div>
                    : <><div className="grid grid-cols-2 gap-3"><Field label={t("宽度（像素）")}><input type="number" min={1} className={control} disabled={locked} value={form.width} onChange={event => modify({ width: Number(event.target.value) })} /></Field><Field label={t("高度（像素）")}><input type="number" min={1} className={control} disabled={locked} value={form.height} onChange={event => modify({ height: Number(event.target.value) })} /></Field></div><p className="text-[13px] text-muted-foreground">{t("总像素 921600–4624220，宽高比 1/16–16。")}</p></>}
                <div className="grid grid-cols-2 gap-3">{form.mode === "generate" && <Field label={t("背景")}><Select aria-label={t("背景")} value={form.background} disabled={locked} onChange={background => modify({ background, ...(background === "transparent" ? { format: "png" } : {}) })} options={[{ value: "auto", label: t("自动") }, { value: "opaque", label: t("不透明") }, { value: "transparent", label: t("透明") }]} /></Field>}<Field label={form.mode === "decompose" ? t("底图格式") : t("输出格式")}><Tooltip title={form.mode === "generate" && form.background === "transparent" ? t("透明背景使用 PNG 格式") : undefined}><Select aria-label={form.mode === "decompose" ? t("底图格式") : t("输出格式")} className="w-full" value={form.mode === "generate" && form.background === "transparent" ? "png" : form.format} disabled={locked || (form.mode === "generate" && form.background === "transparent")} onChange={format => modify({ format })} options={[{ value: "png", label: "PNG" }, { value: "jpeg", label: "JPEG" }]} /></Tooltip></Field></div>
                {form.mode === "decompose" && <><Field label={t("输出总数上限（含底图）")}><input type="number" min={2} max={100} step={1} className={control} disabled={locked} value={form.maxImages} onChange={event => modify({ maxImages: Number(event.target.value) })} /></Field><p className="text-[13px] text-muted-foreground">{t("2–100，默认 30；不是保证生成张数。透明图层始终为 PNG。")}</p><label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={locked} checked={form.ocr} onChange={event => modify({ ocr: event.target.checked })} />{t("请求文字 OCR")}</label>{form.ocr && <p className="text-[13px] leading-relaxed text-muted-foreground">{t("OCR 可能缺失或不准确；填写拆分说明可能影响返回。需要文字时可留空说明，但仍不保证识别。")}</p>}</>}
                <div className="flex flex-wrap gap-4 text-sm"><label className="flex items-center gap-2"><input type="checkbox" disabled={locked} checked={form.watermark} onChange={event => modify({ watermark: event.target.checked })} />{t("添加水印")}</label><label className="flex items-center gap-2"><input type="checkbox" disabled={locked} checked={form.contentCheck} onChange={event => modify({ contentCheck: event.target.checked })} />{t("提交前内容检查")}</label></div>
                <p className="text-[13px] leading-relaxed text-muted-foreground">{t("标准提示词优化始终启用，无法关闭。内容检查选项不改变服务的安全规则。")}</p>
                {inputError && <div role="alert" className="text-sm text-destructive">{layerStudioUiMessage(inputError)}</div>}
              </div>
                <div className="sticky bottom-0 z-10 shrink-0 space-y-2 border-t border-border bg-background p-4" data-testid="layer-studio-submit-bar">
                    {!enabled ? <p className="text-sm text-muted-foreground">{t("功能暂未开放；已有结果仍可编辑和下载。")}</p> : validation ? <p className="text-sm text-muted-foreground">{layerStudioUiMessage(validation)}</p> : estimateError ? <div role="alert" className="text-sm text-destructive">{layerStudioUiMessage(estimateError)}<button type="button" className={smallButton} onClick={() => { setEstimate(null); setEstimateAttempt(value => value + 1); }}>{t("重新检查")}</button></div>
                        : !quote && <p className="text-sm text-muted-foreground">{t("正在检查任务配置…")}</p>}
                    <button type="button" aria-label={form.mode === "decompose" ? t("开始拆分") : t("生成图片")} aria-busy={busy} disabled={locked || !enabled || Boolean(validation || error || estimateError) || !quote} onClick={() => void workspace.submit()} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-40">{busy ? <LoaderCircle size={16} className="animate-spin" /> : <Sparkles size={16} />}{busy ? t("处理中…") : form.mode === "decompose" ? t("开始拆分") : t("生成图片")}</button>
                    {unresolved && <p className="text-[13px] text-muted-foreground">{t("此页签保留原任务；可新建独立任务，不要重复提交。")}</p>}
                </div>
            </aside>
            <main className="min-h-[440px] min-w-0 space-y-4 p-4 lg:overflow-y-auto" aria-label={t("结果与图层编辑")}>
                <details className="rounded-lg border border-border p-3" onToggle={event => setAccountHistoryOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm font-medium">{t("账号历史记录")}</summary><div className="mt-4"><GenerationAccountHistory board="layer-studio" active={accountHistoryOpen} /></div></details>
                {error && <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{layerStudioUiMessage(error)}<button type="button" className={smallButton} onClick={() => void workspace.retrySave().catch(() => {})}>{t("重试保存")}</button></div>}
                {state.jobs.length > 0 && <Field label={t("任务记录")}><Select aria-label={t("任务记录")} value={selected?.requestId || undefined} onChange={selectedRequestId => void update(previous => ({ ...previous, selectedRequestId })).catch(() => {})} options={state.jobs.map(job => ({ value: job.requestId, label: `${new Date(job.createdAt).toLocaleString(locale === "en-US" ? "en-US" : undefined)} · ${t(jobLabel(job))} · ${job.submission.parameters.layer_decomposition ? t("图层拆分") : t("图片生成")}` }))} /></Field>}
                {selected && <section className="space-y-2 rounded-lg border border-border p-3 text-sm" aria-label={t("原任务状态")}><div className="flex flex-wrap items-center justify-between gap-2"><strong>{t(jobLabel(selected))}</strong><span className="break-all text-[13px] text-muted-foreground">{t("请求编号：")}{selected.requestId}</span></div>{selected.notice && <p>{layerStudioUiMessage(selected.notice)}</p>}{selected.document && <p>{t("已保存 {saved} / {total} 份原件", { saved: selected.document.items.filter(item => item.state === "saved").length, total: selected.document.expectedOutputCount })}</p>}{unresolvedLayerStudioJob(selected) && <div className="flex flex-wrap gap-1"><button type="button" className={smallButton} disabled={busy} onClick={() => void workspace.refresh()}><RefreshCw size={12} className="mr-1 inline" />{t("查询原任务")}</button><button type="button" className={smallButton} disabled={busy || workspace.paused} onClick={workspace.pause}>{t("暂停自动查询")}</button>{selected.taskStatus === "paused" && selected.upstreamAccepted && <button type="button" className={smallButton} disabled={busy} onClick={() => void workspace.resume(selected)}>{t("恢复原任务查询 / 保存")}</button>}</div>}</section>}
                {workspace.queryNotice && <p role="status" className="text-sm text-muted-foreground">{layerStudioUiMessage(workspace.queryNotice)}</p>}
                {selected?.document ? <LayerStudioEditor key={selected.requestId} document={selected.document} value={selected.edit} recovering={busy} onRefresh={unresolvedLayerStudioJob(selected) ? workspace.refresh : undefined} onResume={unresolvedLayerStudioJob(selected) && selected.taskStatus === "paused" && selected.upstreamAccepted ? () => workspace.resume(selected) : undefined} onChange={edit => { void update(previous => ({ ...previous, jobs: previous.jobs.map(job => job.requestId === selected.requestId ? { ...job, edit } : job) })).catch(() => {}); }} />
                    : <div className="flex min-h-72 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground"><Layers3 size={36} strokeWidth={1} /><h2 className="text-sm font-medium text-foreground">{unresolved ? t("原任务处理中，结果会逐项保存") : t("从一张图片开始，也可以创造新画面")}</h2><p className="max-w-sm text-sm leading-relaxed">{t("结果保留为原始文件。拆分后可选择、移动、缩放、显隐与调整叠放顺序，再导出新的 PNG，不覆盖原件。")}</p></div>}
                <p className="text-[13px] leading-relaxed text-muted-foreground">{t("已提交任务的提示词、参数与原件可在账号历史跨浏览器查看。未提交输入与编辑位置保存在此浏览器；刷新只查询既有任务，不会重新生成。")}</p>
            </main>
        </div>
    </div>;
}

export default function LayerStudioPage() {
    const ownerId = useUserStore(state => state.user?.id) || "local";
    return <WorkbenchTasks key={ownerId} boardKey="layer-studio" ownerId={ownerId}><LayerStudioPane ownerId={ownerId} /></WorkbenchTasks>;
}
