import { uiText, useUiText } from "@/lib/i18n";
import { formatBeijingDateTime } from "@/lib/beijing-time";
import { ArrowLeft, ArrowRight, ChevronDown, Download, History, LoaderCircle, Plus, RotateCcw, Sparkles } from "lucide-react";
import { App, Button, Checkbox, Image } from "antd";
import { handleSubmitShortcut } from "@/lib/submit-shortcut";
import { GenerationInputList } from "@/components/generation-input-list";
import { WorkbenchTasks, useWorkbenchTask } from "@/components/workbench-tasks";
import { DEFAULT_WORKBENCH_TASK } from "@/lib/workbench-task-state";
import { GenerationDiagnostic } from "@/components/generation-diagnostic";
import { GenerationTaskCancel } from "@/components/generation-task-cancel";
import { GenerationQueueProgress } from "@/components/generation-queue-progress";
import { DesignResultReview } from "@/components/design-result-review";
import { designHandoffToken } from "@/lib/design-handoff";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ModuleGate } from "@/components/auth/module-gate";
import { PracticeExampleRecord } from "@/components/design-examples";
import { designExamplesForScene } from "@/lib/design-examples";
import { GenerationElapsed } from "@/components/generation-elapsed";
import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { creativePresets, getCreativePreset, type CreativePreset } from "@/lib/creative-presets";
import { isModuleAvailable, useModuleEnabled, useModuleStore } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { SceneFields, SceneUploads } from "./scene-form";
import { scenePromptInput, getSceneSlots, sceneSummaries, supportsSceneProductTarget } from "./scene-form-model";
import { SceneProductPicker } from "./scene-product-picker";
import { useSceneWorkspace, type SceneImage } from "./use-scene-workspace";
import { RegionSelectionDialog } from "./region-selection-dialog";
import { RecolorDialog } from "./recolor-dialog";
import { VectorTraceDialog } from "./vector-trace-dialog";
import { canRetrySceneResult } from "./scene-retry";
import { canQuerySceneResult } from "./scene-recovery";
import type { SceneLogSummary } from "./scene-history";
import "./scene.css";
import type { ModuleKey } from "@/services/api/modules";
import type { ToolKey } from "../../../../shared/feature-catalog";

export default function CreativeScenePage() {
    useUiText();
    const { presetId } = useParams<{ presetId: string }>();
    const preset = getCreativePreset(presetId ?? null);
    const [searchParams] = useSearchParams();
    const handoffToken = designHandoffToken(searchParams, `creative-${preset?.id || ""}`);
    const ownerId = useUserStore(state => state.user?.id);
    if (!preset) return <main className="wb-page wb-empty h-full">
        <h1 className="wb-title">{uiText("设计场景不存在")}</h1>
        <p>{uiText("请返回创意设计选择其他场景。")}</p>
        <Link to="/creative" className="wb-primary-link">{uiText("返回创意设计")}</Link>
    </main>;
    return <ModuleGate moduleKey={`creative-${preset.id}` as ModuleKey}>
        <WorkbenchTasks key={`${ownerId}:${preset.id}:${handoffToken || "default"}`} ownerId={ownerId} boardKey={`creative:${preset.id}:${handoffToken || "default"}`}><CreativeSceneWorkspace preset={preset} handoffToken={handoffToken} /></WorkbenchTasks>
    </ModuleGate>;
}

function CreativeSceneWorkspace({ preset, handoffToken }: { preset: CreativePreset; handoffToken: string | null }) {
    useUiText();
    const { modal } = App.useApp();
    const task = useWorkbenchTask();
    const ws = useSceneWorkspace(preset.id, task.id === DEFAULT_WORKBENCH_TASK ? handoffToken : null);
    const selectionEnabled = useModuleEnabled("creative-selection");
    const recolorEnabled = useModuleEnabled("pattern-recolor");
    const traceEnabled = useModuleEnabled("svg-trace");
    const canvasEnabled = useModuleEnabled("canvas");
    const imageEditEnabled = useModuleEnabled("image-edit");
    const navigate = useNavigate();
    const flags = useModuleStore(state => state.flags);
    const tools = useBusinessConfigStore(state => state.tools);
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [view, setView] = useState<"results" | "history">("history");
    const [tool, setTool] = useState<"selection" | "recolor" | null>(null);
    const [traceImage, setTraceImage] = useState<SceneImage | null>(null);
    const [promptOpen, setPromptOpen] = useState(false);
    const [historySelection, setHistorySelection] = useState(false);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    useEffect(() => { if (ws.recoveredRequestId) setView("results"); }, [ws.recoveredRequestId]);
    const summary = sceneSummaries[preset.id]!;
    const examples = designExamplesForScene(preset.id);
    const slots = getSceneSlots(preset.id, ws.form);
    const available = creativePresets.filter(item => isModuleAvailable(flags, tools, `creative-${item.id}` as ModuleKey));
    const submit = () => { setView("results"); void ws.generate(); };
    const historyBusy = ws.running || ws.loading || ws.historyLoading;
    const selectableLogs = ws.logs.filter(log => !log.unresolvedCount);
    const selectedLogs = selectableLogs.filter(log => selectedLogIds.includes(log.id));
    const allSelected = Boolean(selectableLogs.length) && selectedLogs.length === selectableLogs.length;
    const confirmDeleteLogs = (requested: SceneLogSummary[]) => {
        if (historyBusy || !requested.length) return;
        const snapshot = [...requested];
        modal.confirm({
            title: uiText("删除选中的 {count} 条历史记录？", { count: snapshot.length }),
            content: uiText("仅从本机历史列表移除已结束的记录；原图与服务端任务仍保留，不会取消任务。"),
            okText: uiText("确认删除"), okButtonProps: { danger: true }, cancelText: uiText("保留记录"),
            onOk: async () => {
                const deleted = await ws.deleteLogs(snapshot);
                if (!deleted) return;
                setSelectedLogIds(current => [...new Set([...current.filter(id => !deleted.deletedIds.includes(id)), ...deleted.failedIds])]);
                if (deleted.failedIds.length) setHistorySelection(true);
            },
        });
    };

    return <main className="wb-page cs-page">
        <header className="cs-header">
            <Link to="/creative" className="cs-back"><ArrowLeft size={16} /><span>{uiText("创意设计")}</span></Link>
            <span className="cs-header-divider" />
            <div className="cs-scene-picker">
                <select aria-label={uiText("切换设计场景")} value={preset.id} onChange={event => navigate(`/creative/${event.target.value}`)}>
                    {available.map(item => <option key={item.id} value={item.id}>{uiText(item.title || "")}</option>)}
                </select><ChevronDown size={14} />
            </div>
            <button className="cs-new" type="button" disabled={ws.running || ws.loading} onClick={() => { ws.reset(); setView("history"); }}><Plus size={15} />{uiText("清空当前草稿")}</button>
        </header>
        <div className="cs-layout">
            <aside className="cs-form-panel" aria-label={uiText("{title}设计参数", { title: uiText(preset.title) })} onKeyDown={event => {
                if ((event.target as HTMLElement).closest?.("button, a, summary, [role='button']")) return;
                handleSubmitShortcut(event, !ws.loading && !ws.running && !ws.validation && !ws.quotaBlocked && !ws.uploading, submit);
            }}>
                <div className="cs-form-heading"><span className="cs-eyebrow">{uiText("设计工作台")}</span><h1>{uiText(preset.title || "")}</h1><p>{uiText(preset.description || "")}</p></div>
                {ws.loading ? <div className="cs-loading"><LoaderCircle size={18} className="animate-spin" />{uiText("正在恢复场景草稿…")}</div> : <fieldset disabled={ws.running} className="cs-form-body">
                    {!!slots.length && <section className="cs-upload-section"><h2 className="cs-section-label"><span>01</span>{preset.id === "accessory-design" ? uiText("上传辅料与图案") : preset.id === "virtual-try-on" ? uiText("上传产品与可选模特图") : preset.id === "sketch-to-photo" ? uiText("上传线稿与可选参考图") : preset.id === "item-extract" ? uiText("上传产品来源图") : preset.id.startsWith("pattern-") ? uiText("上传图案素材") : uiText("上传款式图")}</h2><SceneUploads slots={slots} images={ws.images} onImage={(id, file) => ws.setImage(id, file)} onAsset={ws.setAsset} disabled={ws.running || ws.uploading || ws.loading} scopeKey={`creative:${preset.id}`} />
                        {preset.id === "local-restyle" && (selectionEnabled || ws.selection) && <div className="cs-local-tool">{selectionEnabled && <button type="button" className="cs-tool-entry" disabled={!ws.images.primary || ws.uploading} onClick={() => setTool("selection")}>{ws.selection ? uiText("编辑修改选区") : uiText("涂选修改区域")}<ArrowRight size={14} /></button>}
                            <p className="cs-help">{ws.selection ? uiText("已开启选区合成：选区外保留原图。修改处的结构和衔接仍需检查。") : uiText("未涂选时由 AI 修改整张图，不能保证其他部位不变。")}</p>
                            {ws.selection && <button type="button" className="cs-help" onClick={ws.clearSelection}>{uiText("清除选区，使用整图 AI 修改")}</button>}</div>}
                        {recolorEnabled && preset.id === "pattern-colorway" && <div className="cs-local-tool"><button type="button" className="cs-tool-entry" disabled={!ws.images.primary || ws.uploading} onClick={() => setTool("recolor")}>{uiText("精确换色")}<small>{uiText("本地 · 不调用 AI")}</small><ArrowRight size={14} /></button><p className="cs-help">{uiText("平面花型可按原色→目标色直接替换；下方保留 AI 配色拓展。")}</p></div>}
                        {traceEnabled && preset.id === "style-to-sketch" && <div className="cs-local-tool"><button type="button" className="cs-tool-entry" disabled={!ws.images.primary || ws.uploading} onClick={() => setTraceImage(ws.images.primary!)}>{uiText("已有线稿转 SVG")}<ArrowRight size={14} /></button><p className="cs-help">{uiText("也可先生成线稿，再从结果卡导出矢量路径。")}</p></div>}
                    </section>}
                    <section className="cs-business-section"><h2 className="cs-section-label"><span>{slots.length ? "02" : "01"}</span>{preset.id.includes("colorway") ? uiText("选择配色方式") : preset.id === "pattern-craft" ? uiText("选择工艺效果") : preset.id === "text-to-style" ? uiText("描述你的设计") : preset.id === "style-to-sketch" ? uiText("线稿要求") : preset.id === "virtual-try-on" ? uiText("试穿要求") : preset.id === "sketch-to-photo" ? uiText("材质与配色要求") : preset.id === "local-restyle" ? uiText("指定修改部位") : preset.id === "back-design" ? uiText("构思背面结构") : preset.id === "accessory-design" ? uiText("定义辅料外观") : uiText("提取要求")}</h2><SceneFields sceneId={preset.id} form={ws.form} onChange={ws.setForm} disabled={ws.running} sourceImage={ws.images.primary?.dataUrl} hasSecondaryImage={Boolean(ws.images.secondary)}
                        productPicker={supportsSceneProductTarget(preset.id) ? <SceneProductPicker key={ws.images.primary?.id || "empty"} sceneId={preset.id} source={ws.images.primary} disabled={ws.running || ws.uploading || ws.loading} onConfirm={targetProduct => ws.setForm(current => ({ ...current, targetProduct }))} /> : undefined} /></section>
                    <details className="cs-output-settings"><summary><span>{uiText("出图设置")}</span><span>{uiText(imageSizeLabel(ws.config.size))} · {uiText(imageQualityLabel(ws.config.quality))} · {ws.count} {uiText(" 张")}<ChevronDown size={13} /></span></summary>
                        <label className="cs-label">{uiText("生成模型")}</label><ModelPicker toolKey={`creative-${preset.id}` as ToolKey} config={ws.config} value={ws.model} onChange={value => ws.updateConfig("imageModel", value)} capability="image" fullWidth disabled={ws.running} />
                        <ImageSettingsPanel config={ws.config} referenceCount={Object.values(ws.images).filter(Boolean).length} onConfigChange={ws.updateConfig} theme={theme} showTitle={false} />
                    </details>
                    <details className="cs-prompt-preview" open={promptOpen} onToggle={event => setPromptOpen(event.currentTarget.open)}><summary>{ws.selectedPrompt !== null ? uiText("所选结果的原始提示词") : uiText("查看本次设计输入")}<ChevronDown size={12} /></summary>{ws.selectedPrompt !== null ? <pre aria-label={uiText("设计提示词")}>{ws.selectedPrompt}</pre> : <GenerationInputList fields={scenePromptInput(preset.id, ws.form).fields} />}{ws.selectedPrompt !== null && <p className="cs-help">{uiText("仅显示原提示词，未改变当前设计要求、模型或参考图。")}</p>}</details>
                </fieldset>}
                <div className="cs-submit-panel">
                    {ws.error && <GenerationDiagnostic error={ws.error} />}
                    {ws.notice && <p className="cs-help" role="status">{uiText(ws.notice || "")}</p>}
                    {!ws.error && ws.validation && <p className="cs-validation">{uiText(ws.validation || "")}</p>}
                    {ws.quotaBlocked ? <p role="status" className="cs-validation">{uiText("额度不足，请联系管理员")}</p> : null}
                    <p className="cs-help">{uiText("Ctrl / ⌘ + Enter 提交")}</p>
                    <button type="button" className="cs-generate" disabled={ws.loading || ws.running || Boolean(ws.validation) || ws.quotaBlocked} onClick={submit}>{ws.running ? <><LoaderCircle size={16} className="animate-spin" />{ws.optimizing ? uiText("正在优化提示词…") : uiText("正在生成")}<GenerationElapsed startedAt={ws.startedAt} /></> : <><Sparkles size={16} />{uiText("生成{kind}", { kind: preset.title === "以文生款" ? uiText("款式") : preset.title === "款生线稿" ? uiText("线稿") : preset.title === "花型提取" ? uiText("图案") : preset.id === "item-extract" ? uiText("完整单品") : preset.id === "virtual-try-on" ? uiText("试穿效果") : preset.id === "sketch-to-photo" ? uiText("实拍效果") : uiText("设计") })}<span>{ws.count} {uiText(" 张")}</span></>}</button>
                    <p className="cs-submit-note">{deploymentFeatures.creditsEnabled ? uiText("预计 {estimatedCredits} 积分 · ", { estimatedCredits: ws.estimatedCredits }) : ""}{uiText("点击后先优化提示词，再提交图片任务")}</p>
                    {(ws.running || ws.autoObserving) && <button type="button" className="cs-tool-entry" onClick={ws.stopObserving}>{uiText("暂停获取进度")}</button>}
                </div>
            </aside>
            <section className="cs-stage" aria-label={uiText("设计预览与结果")}>
                <nav className="cs-stage-tabs" aria-label={uiText("预览内容")}>
                    <button type="button" aria-pressed={view === "results"} onClick={() => setView("results")}>{uiText("当前结果")}{ws.results.length ? <span>{ws.results.length}</span> : null}</button>
                    <button type="button" className="cs-history-tab" aria-pressed={view === "history"} onClick={() => setView("history")}><History size={15} />{uiText("最近任务")}{ws.historyTotal ? <span>{ws.historyTotal}</span> : null}</button>
                </nav>
                {view === "history" ? <div className="cs-history">
                    {examples.map(example => <PracticeExampleRecord key={example.id} example={example} />)}
                    <div className="flex flex-wrap items-center justify-between gap-2"><h2>{uiText("最近任务")}</h2><Button size="small" disabled={historyBusy || !ws.logs.length} onClick={() => { setHistorySelection(current => !current); setSelectedLogIds([]); }}>{historySelection ? uiText("退出批量管理") : uiText("批量管理")}</Button></div>
                    <p className="cs-help">{uiText("显示当前账号在「")}{uiText(preset.title || "")}{uiText("」中的任务与待查询原请求，保存在本机浏览器。")}</p>
                    {historySelection && <div className="mb-3 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <Checkbox aria-label={uiText("全选已加载的已结束任务")} disabled={historyBusy || !selectableLogs.length} checked={allSelected} indeterminate={selectedLogs.length > 0 && !allSelected} onChange={() => setSelectedLogIds(allSelected ? [] : selectableLogs.map(log => log.id))}>{uiText("全选已加载记录")}</Checkbox>
                            <span className="text-xs text-muted-foreground">{uiText("已选 {count} 条", { count: selectedLogs.length })}</span>
                            <Button size="small" danger disabled={historyBusy || !selectedLogs.length} onClick={() => confirmDeleteLogs(selectedLogs)}>{uiText("批量删除")}</Button>
                        </div>
                        <p className="cs-help">{uiText("只选择当前已加载且已结束的任务；待查询的原请求不会被删除。")}</p>
                    </div>}
                    {ws.logs.length ? ws.logs.map(log => <div key={log.id} className="flex items-center gap-3">{historySelection && <Checkbox aria-label={uiText("选择任务：{time}", { time: formatBeijingDateTime(log.createdAt) })} disabled={historyBusy || Boolean(log.unresolvedCount)} checked={selectedLogIds.includes(log.id)} onChange={event => setSelectedLogIds(current => event.target.checked ? [...new Set([...current, log.id])] : current.filter(id => id !== log.id))} />}<button type="button" className="cs-history-item" disabled={historyBusy} onClick={() => { void ws.previewLog(log); setPromptOpen(true); setView("results"); }}>
                        <span className="cs-history-icon"><History size={18} /></span><span><strong>{formatBeijingDateTime(log.createdAt)} {uiText("北京时间")}</strong><small>{log.operation === "recolor" ? uiText("本地精确换色 · ") : log.hasSelection ? uiText("选区合成 · ") : ""}{log.successCount} {uiText(" 张成功")}{log.failCount ? uiText(" · {failCount} 张失败", { failCount: log.failCount }) : ""}{log.unresolvedCount ? uiText(" · {unresolvedCount} 张待查询", { unresolvedCount: log.unresolvedCount }) : ""} {uiText(" · 查看结果与提示词")}</small></span><ArrowRight size={15} />
                    </button>{!historySelection && <button type="button" className="shrink-0 text-xs text-muted-foreground" disabled={historyBusy || Boolean(log.unresolvedCount)} onClick={() => confirmDeleteLogs([log])}>{uiText("删除")}</button>}</div>) : <p className="cs-help">{uiText("还没有生成记录。完成一次设计后，会在这里保存参数和结果。")}</p>}
                    {ws.historyHasMore && <button type="button" className="cs-tool-entry" disabled={ws.historyLoading} onClick={() => void ws.loadMoreHistory()}>{ws.historyLoading ? uiText("正在加载…") : uiText("加载更多（已显示 {length} / {historyTotal}）", { length: ws.logs.length, historyTotal: ws.historyTotal })}</button>}
                </div> : <div className="cs-results">
                    <div className="cs-results-heading"><h2>{ws.optimizing ? uiText("正在优化提示词…") : ws.running ? uiText("正在创作") : uiText("设计结果")}</h2>{ws.activeLog && <><span>{formatBeijingDateTime(ws.activeLog.createdAt)} {uiText("北京时间")}</span><button type="button" className="cs-tool-entry" disabled={ws.running || ws.loading || ws.previewing} onClick={() => modal.confirm({ title: uiText("恢复为草稿？"), content: uiText("将替换当前设计要求、模型与参考素材，不会提交生成任务。"), okText: uiText("确认恢复"), cancelText: uiText("保留草稿"), onOk: async () => { await ws.restoreLog(ws.activeLog!); setPromptOpen(true); } })}>{uiText("恢复为草稿继续改")}</button></>}</div>
                    {ws.previewing && <p className="cs-help" role="status">{uiText("正在读取所选结果…")}</p>}
                    {ws.activeLog?.operation === "recolor" && <p className="cs-help cs-operation-note">{ws.activeLog.prompt}</p>}
                    {!ws.results.length ? <div className="cs-empty"><Sparkles size={28} /><h3>{uiText("让设计从这里开始")}</h3><p>{uiText("在左侧完成")}{slots.length ? uiText("素材和") : ""}{uiText("设计要求，点击生成。")}</p><button type="button" onClick={() => setView("history")}><RotateCcw size={14} />{uiText("看看实操案例")}</button></div> : <div className="cs-result-grid">{ws.results.map((result, index) => <article key={result.id} className="cs-result-card">
                        {result.status === "success" && result.image ? <><Image src={result.image.dataUrl} alt={uiText("{title}结果 {value2}", { title: uiText(preset.title), value2: index + 1 })} onClick={() => { ws.selectResultPrompt(result); setPromptOpen(true); }} /><div className="cs-result-meta"><span>{uiText("方案 ")}{String(index + 1).padStart(2, "0")}</span><button type="button" onClick={() => { void ws.download(result.image!, index); }}><Download size={14} />{uiText("下载原图")}</button>{traceEnabled && preset.id === "style-to-sketch" && <button type="button" onClick={() => setTraceImage(result.image!)}>{uiText("导出 SVG")}</button>}</div>
                            <div className="cs-result-actions">
                                <button type="button" disabled={ws.running || ws.resultActionBusy || !ws.activeLog} onClick={() => void ws.resultAction("saveAsset", result.image!)}>{uiText("保存到素材库")}</button>
                                {canvasEnabled && <button type="button" disabled={ws.running || ws.resultActionBusy || !ws.activeLog} onClick={() => void ws.resultAction("canvas", result.image!).then(url => { if (url) navigate(url); })}>{uiText("放入画布")}</button>}
                                {imageEditEnabled && <button type="button" disabled={ws.running || ws.resultActionBusy || !ws.activeLog} onClick={() => void ws.resultAction("reference", result.image!).then(url => { if (url) navigate(url); })}>{uiText("作为参考继续改")}</button>}
                            </div>{ws.activeLog && <DesignResultReview sceneId={ws.activeLog.sceneId} fields={ws.activeLog.userInput?.fields || scenePromptInput(ws.activeLog.sceneId, ws.activeLog.form).fields || {}} image={result.image} disabled={ws.running || ws.resultActionBusy} />}</> : result.status === "failed" ? <div className="cs-result-message"><span>{uiText("方案 ")}{index + 1} {result.uncompositedImage ? uiText("合成未完成") : result.compilationId ? uiText("等待继续生成") : result.recovery === "resume" ? uiText("获取结果已暂停") : result.recovery === "investigate" ? uiText("需要管理员协助") : result.failureKind === "uncertain" ? uiText("暂时无法获取进度") : uiText("生成失败")}</span><GenerationDiagnostic error={result.error || "生成失败"} details={[result.taskId, result.requestId].filter(Boolean).join("\n")} />{result.uncompositedImage && <button type="button" className="cs-tool-entry" onClick={() => void ws.download(result.uncompositedImage!, index)}><Download size={14} />{uiText("下载未合成图")}</button>}
                            {canRetrySceneResult(result) && <><button type="button" className="cs-tool-entry" disabled={ws.running || ws.loading || !ws.activeLog} onClick={() => void ws.retryResult(result)}>{uiText("按原参数重试")}</button><small>{uiText("会提交 1 个新任务，按当前计费规则收费。")}</small></>}
                            {result.retryLogId && <small>{uiText("此失败项已发起过重试，请查看对应的新记录。")}</small>}
                            {canQuerySceneResult(result) && <button type="button" className="cs-tool-entry" disabled={ws.running || ws.loading || !ws.activeLog} onClick={() => void ws.queryResult(result)}>{uiText("刷新进度")}</button>}
                            {result.recovery === "resume" && <button type="button" className="cs-tool-entry" disabled={ws.running || ws.loading || !ws.activeLog} onClick={() => void ws.queryResult(result, true)}>{uiText("继续获取结果")}</button>}
                            {result.compilationId && result.failureKind === "uncertain" && <><button type="button" className="cs-tool-entry" disabled={ws.running || ws.loading || !ws.activeLog} onClick={() => void ws.queryResult(result, true)}>{uiText("继续生成")}</button><small>{uiText("沿用已保存的设置，不重复优化；生成图片按当前规则收费。")}</small></>}
                        </div> : <div className="cs-result-message"><LoaderCircle className={ws.running || ws.autoObserving ? "animate-spin" : undefined} size={25} /><span>{ws.running || (ws.autoObserving && result.taskId) ? uiText("正在生成") : ws.autoObserving ? uiText("正在获取进度") : uiText("获取进度已暂停")}{uiText(" · 方案 ")}{index + 1}</span>{ws.running && <GenerationElapsed startedAt={ws.startedAt} />}<GenerationQueueProgress taskId={result.taskId} active={ws.running || ws.autoObserving} /><small>{result.error || uiText("任务已保存，完成后会自动显示。")}</small>{canQuerySceneResult(result) && !ws.running && <button type="button" className="cs-tool-entry" disabled={ws.loading || !ws.activeLog} onClick={() => void ws.queryResult(result)}>{uiText("刷新进度")}</button>}</div>}
                        {canQuerySceneResult(result) && result.taskId && <div className="p-3"><GenerationTaskCancel taskId={result.taskId} /></div>}
                    </article>)}</div>}
                    {!!ws.results.length && <p className="cs-result-limit">{uiText(summary.limit || "")}</p>}
                </div>}
            </section>
        </div>
        {selectionEnabled && tool === "selection" && ws.images.primary && <RegionSelectionDialog source={ws.images.primary} initialMask={ws.selection?.mask.dataUrl} onClose={() => setTool(null)} onSave={blob => ws.saveSelection(ws.images.primary!.id, blob)} />}
        {recolorEnabled && tool === "recolor" && ws.images.primary && <RecolorDialog source={ws.images.primary} onClose={() => setTool(null)} onSave={async (blob, description) => { await ws.saveLocalResult(ws.images.primary!.id, blob, description); setView("results"); }} />}
        {traceEnabled && traceImage && <VectorTraceDialog source={traceImage} onClose={() => setTraceImage(null)} />}
    </main>;
}
