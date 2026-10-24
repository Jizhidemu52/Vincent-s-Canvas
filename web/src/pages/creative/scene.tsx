import { ArrowLeft, ArrowRight, ChevronDown, Download, History, ImageIcon, LoaderCircle, Plus, RotateCcw, Sparkles } from "lucide-react";
import { Image } from "antd";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ModuleGate } from "@/components/auth/module-gate";
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
import { scenePromptInput, getSceneSlots, sceneSummaries } from "./scene-form-model";
import { useSceneWorkspace, type SceneImage } from "./use-scene-workspace";
import { RegionSelectionDialog } from "./region-selection-dialog";
import { RecolorDialog } from "./recolor-dialog";
import { VectorTraceDialog } from "./vector-trace-dialog";
import { canRetrySceneResult } from "./scene-retry";
import { canQuerySceneResult } from "./scene-recovery";
import "./scene.css";
import type { ModuleKey } from "@/services/api/modules";
import type { ToolKey } from "../../../../shared/feature-catalog";

export default function CreativeScenePage() {
    const { presetId } = useParams<{ presetId: string }>();
    const preset = getCreativePreset(presetId ?? null);
    const ownerId = useUserStore(state => state.user?.id);
    if (!preset) return <main className="wb-page wb-empty h-full">
        <h1 className="wb-title">设计场景不存在</h1>
        <p>请返回创意设计选择其他场景。</p>
        <Link to="/creative" className="wb-primary-link">返回创意设计</Link>
    </main>;
    return <ModuleGate moduleKey={`creative-${preset.id}` as ModuleKey}>
        <CreativeSceneWorkspace key={`${ownerId}:${preset.id}`} preset={preset} />
    </ModuleGate>;
}

function CreativeSceneWorkspace({ preset }: { preset: CreativePreset }) {
    const ws = useSceneWorkspace(preset.id);
    const selectionEnabled = useModuleEnabled("creative-selection");
    const recolorEnabled = useModuleEnabled("pattern-recolor");
    const traceEnabled = useModuleEnabled("svg-trace");
    const canvasEnabled = useModuleEnabled("canvas");
    const imageEditEnabled = useModuleEnabled("image-edit");
    const navigate = useNavigate();
    const flags = useModuleStore(state => state.flags);
    const tools = useBusinessConfigStore(state => state.tools);
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [view, setView] = useState<"example" | "results" | "history">("example");
    const [tool, setTool] = useState<"selection" | "recolor" | null>(null);
    const [traceImage, setTraceImage] = useState<SceneImage | null>(null);
    const [promptOpen, setPromptOpen] = useState(false);
    useEffect(() => { if (ws.recoveredRequestId) setView("results"); }, [ws.recoveredRequestId]);
    const summary = sceneSummaries[preset.id]!;
    const slots = getSceneSlots(preset.id, ws.form);
    const available = creativePresets.filter(item => isModuleAvailable(flags, tools, `creative-${item.id}` as ModuleKey));
    const submit = () => { setView("results"); void ws.generate(); };

    return <main className="wb-page cs-page">
        <header className="cs-header">
            <Link to="/creative" className="cs-back"><ArrowLeft size={16} /><span>创意设计</span></Link>
            <span className="cs-header-divider" />
            <div className="cs-scene-picker">
                <select aria-label="切换设计场景" value={preset.id} onChange={event => navigate(`/creative/${event.target.value}`)}>
                    {available.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
                </select><ChevronDown size={14} />
            </div>
            <button className="cs-new" type="button" disabled={ws.running || ws.loading} onClick={() => { ws.reset(); setView("example"); }}><Plus size={15} />新建任务</button>
        </header>
        <div className="cs-layout">
            <aside className="cs-form-panel" aria-label={`${preset.title}设计参数`}>
                <div className="cs-form-heading"><span className="cs-eyebrow">DESIGN WORKSPACE</span><h1>{preset.title}</h1><p>{preset.description}</p></div>
                {ws.loading ? <div className="cs-loading"><LoaderCircle size={18} className="animate-spin" />正在恢复场景草稿…</div> : <fieldset disabled={ws.running} className="cs-form-body">
                    {!!slots.length && <section className="cs-upload-section"><h2 className="cs-section-label"><span>01</span>{preset.id === "accessory-design" ? "上传辅料与图案" : preset.id.startsWith("pattern-") ? "上传图案素材" : "上传款式图"}</h2><SceneUploads slots={slots} images={ws.images} onImage={(id, file) => { void ws.setImage(id, file); }} disabled={ws.running} />
                        {preset.id === "local-restyle" && (selectionEnabled || ws.selection) && <div className="cs-local-tool">{selectionEnabled && <button type="button" className="cs-tool-entry" disabled={!ws.images.primary || ws.uploading} onClick={() => setTool("selection")}>{ws.selection ? "编辑修改选区" : "涂选修改区域"}<ArrowRight size={14} /></button>}
                            <p className="cs-help">{ws.selection ? "已开启选区合成：选区外保留原图。修改处的结构和衔接仍需检查。" : "未涂选时由 AI 修改整张图，不能保证其他部位不变。"}</p>
                            {ws.selection && <button type="button" className="cs-help" onClick={ws.clearSelection}>清除选区，使用整图 AI 修改</button>}</div>}
                        {recolorEnabled && preset.id === "pattern-colorway" && <div className="cs-local-tool"><button type="button" className="cs-tool-entry" disabled={!ws.images.primary || ws.uploading} onClick={() => setTool("recolor")}>精确换色<small>本地 · 不调用 AI</small><ArrowRight size={14} /></button><p className="cs-help">平面花型可按原色→目标色直接替换；下方保留 AI 配色拓展。</p></div>}
                        {traceEnabled && preset.id === "style-to-sketch" && <div className="cs-local-tool"><button type="button" className="cs-tool-entry" disabled={!ws.images.primary || ws.uploading} onClick={() => setTraceImage(ws.images.primary!)}>已有线稿转 SVG<ArrowRight size={14} /></button><p className="cs-help">也可先生成线稿，再从结果卡导出矢量路径。</p></div>}
                    </section>}
                    <section className="cs-business-section"><h2 className="cs-section-label"><span>{slots.length ? "02" : "01"}</span>{preset.id.includes("colorway") ? "选择配色方式" : preset.id === "pattern-craft" ? "选择工艺效果" : preset.id === "text-to-style" ? "描述你的设计" : preset.id === "style-to-sketch" ? "线稿要求" : preset.id === "local-restyle" ? "指定修改部位" : preset.id === "back-design" ? "构思背面结构" : preset.id === "accessory-design" ? "定义辅料外观" : "提取要求"}</h2><SceneFields sceneId={preset.id} form={ws.form} onChange={ws.setForm} disabled={ws.running} sourceImage={ws.images.primary?.dataUrl} /></section>
                    <details className="cs-output-settings"><summary><span>出图设置</span><span>{imageSizeLabel(ws.config.size)} · {imageQualityLabel(ws.config.quality)} · {ws.count} 张<ChevronDown size={13} /></span></summary>
                        <label className="cs-label">生成模型</label><ModelPicker toolKey={`creative-${preset.id}` as ToolKey} config={ws.config} value={ws.model} onChange={value => ws.updateConfig("imageModel", value)} capability="image" fullWidth disabled={ws.running} />
                        <ImageSettingsPanel config={ws.config} referenceCount={Object.values(ws.images).filter(Boolean).length} onConfigChange={ws.updateConfig} theme={theme} showTitle={false} />
                    </details>
                    <details className="cs-prompt-preview" open={promptOpen} onToggle={event => setPromptOpen(event.currentTarget.open)}><summary>{ws.selectedPrompt !== null ? "所选结果的原始提示词" : "查看本次设计输入"}<ChevronDown size={12} /></summary><pre aria-label="设计提示词">{ws.selectedPrompt ?? JSON.stringify(scenePromptInput(preset.id, ws.form).fields, null, 2)}</pre>{ws.selectedPrompt !== null && <p className="cs-help">仅显示原提示词，未改变当前设计要求、模型或参考图。</p>}</details>
                </fieldset>}
                <div className="cs-submit-panel">
                    {ws.error && <p className="cs-error" role="alert">{ws.error}</p>}
                    {ws.notice && <p className="cs-help" role="status">{ws.notice}</p>}
                    {!ws.error && ws.validation && <p className="cs-validation">{ws.validation}</p>}
                    <button type="button" className="cs-generate" disabled={ws.loading || ws.running || Boolean(ws.validation) || ws.quotaBlocked} onClick={submit}>{ws.running ? <><LoaderCircle size={16} className="animate-spin" />{ws.optimizing ? "正在优化提示词…" : "正在生成"}<GenerationElapsed startedAt={ws.startedAt} /></> : <><Sparkles size={16} />生成{preset.title === "以文生款" ? "款式" : preset.title === "款生线稿" ? "线稿" : preset.title === "花型提取" ? "图案" : "设计"}<span>{ws.count} 张</span></>}</button>
                    <p className="cs-submit-note">{deploymentFeatures.creditsEnabled ? `预计 ${ws.estimatedCredits} 积分 · ` : ""}点击后先优化提示词，再提交图片任务</p>
                </div>
            </aside>
            <section className="cs-stage" aria-label="设计预览与结果">
                <nav className="cs-stage-tabs" aria-label="预览内容">
                    <button type="button" aria-pressed={view === "example"} onClick={() => setView("example")}><ImageIcon size={15} />功能示例</button>
                    <button type="button" aria-pressed={view === "results"} onClick={() => setView("results")}>当前结果{ws.results.length ? <span>{ws.results.length}</span> : null}</button>
                    <button type="button" className="cs-history-tab" aria-pressed={view === "history"} onClick={() => setView("history")}><History size={15} />最近任务{ws.historyTotal ? <span>{ws.historyTotal}</span> : null}</button>
                </nav>
                {view === "example" ? <div className="cs-example">
                    <div className="cs-example-heading"><span className="cs-eyebrow">WHAT YOU CAN CREATE</span><h2>{summary.input}<ArrowRight size={21} />{summary.output}</h2><p>{summary.example}</p></div>
                    <figure className="cs-example-image"><img src={`/creative-scenes/v2/${preset.id}.preview.webp`} alt={`${preset.title}：${summary.input}转为${summary.output}的概念示意`} loading="lazy" decoding="async" /><figcaption><span>{summary.input}</span><ArrowRight size={17} /><span>{summary.output}</span></figcaption></figure>
                    <div className="cs-example-foot"><span>AI 功能示意 · 非模型实测</span><p>{summary.limit}</p></div>
                </div> : view === "history" ? <div className="cs-history">
                    <h2>最近任务</h2><p className="cs-help">显示当前账号在「{preset.title}」中的任务与待查询原请求，保存在本机浏览器。</p>
                    {ws.logs.length ? ws.logs.map(log => <button key={log.id} type="button" className="cs-history-item" disabled={ws.running} onClick={() => { void ws.previewLog(log); setPromptOpen(true); setView("results"); }}>
                        <span className="cs-history-icon"><History size={18} /></span><span><strong>{new Date(log.createdAt).toLocaleString("zh-CN", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}</strong><small>{log.operation === "recolor" ? "本地精确换色 · " : log.hasSelection ? "选区合成 · " : ""}{log.successCount} 张成功{log.failCount ? ` · ${log.failCount} 张失败` : ""}{log.unresolvedCount ? ` · ${log.unresolvedCount} 张待查询` : ""} · 查看结果与提示词</small></span><ArrowRight size={15} />
                    </button>) : <div className="cs-empty"><History size={26} /><h3>还没有生成记录</h3><p>完成一次设计后，会在这里保存参数和结果。</p></div>}
                    {ws.historyHasMore && <button type="button" className="cs-tool-entry" disabled={ws.historyLoading} onClick={() => void ws.loadMoreHistory()}>{ws.historyLoading ? "正在加载…" : `加载更多（已显示 ${ws.logs.length} / ${ws.historyTotal}）`}</button>}
                </div> : <div className="cs-results">
                    <div className="cs-results-heading"><h2>{ws.optimizing ? "正在优化提示词…" : ws.running ? "正在创作" : "设计结果"}</h2>{ws.activeLog && <><span>{new Date(ws.activeLog.createdAt).toLocaleString("zh-CN")}</span><button type="button" className="cs-tool-entry" disabled={ws.running || ws.loading || ws.previewing} onClick={() => { void ws.restoreLog(ws.activeLog!); setPromptOpen(true); }}>恢复为草稿继续改</button></>}</div>
                    {ws.previewing && <p className="cs-help" role="status">正在读取所选结果…</p>}
                    {ws.activeLog?.operation === "recolor" && <p className="cs-help cs-operation-note">{ws.activeLog.prompt}</p>}
                    {!ws.results.length ? <div className="cs-empty"><Sparkles size={28} /><h3>让设计从这里开始</h3><p>在左侧完成{slots.length ? "素材和" : ""}设计要求，点击生成。</p><button type="button" onClick={() => setView("example")}><RotateCcw size={14} />看看功能示例</button></div> : <div className="cs-result-grid">{ws.results.map((result, index) => <article key={result.id} className="cs-result-card">
                        {result.status === "success" && result.image ? <><Image src={result.image.dataUrl} alt={`${preset.title}结果 ${index + 1}`} onClick={() => { ws.selectResultPrompt(result); setPromptOpen(true); }} /><div className="cs-result-meta"><span>方案 {String(index + 1).padStart(2, "0")}</span><button type="button" onClick={() => { void ws.download(result.image!, index); }}><Download size={14} />下载原图</button>{traceEnabled && preset.id === "style-to-sketch" && <button type="button" onClick={() => setTraceImage(result.image!)}>导出 SVG</button>}</div>
                            <div className="cs-result-actions">
                                <button type="button" disabled={ws.running || ws.resultActionBusy || !ws.activeLog} onClick={() => void ws.resultAction("saveAsset", result.image!)}>保存到素材库</button>
                                {canvasEnabled && <button type="button" disabled={ws.running || ws.resultActionBusy || !ws.activeLog} onClick={() => void ws.resultAction("canvas", result.image!).then(url => { if (url) navigate(url); })}>加入新画布</button>}
                                {imageEditEnabled && <button type="button" disabled={ws.running || ws.resultActionBusy || !ws.activeLog} onClick={() => void ws.resultAction("reference", result.image!).then(url => { if (url) navigate(url); })}>作为参考继续改</button>}
                            </div></> : result.status === "failed" ? <div className="cs-result-message"><span>方案 {index + 1} {result.uncompositedImage ? "合成未完成" : result.failureKind === "uncertain" ? "状态待核查" : "生成失败"}</span><p>{result.error}</p>{result.uncompositedImage && <button type="button" className="cs-tool-entry" onClick={() => void ws.download(result.uncompositedImage!, index)}><Download size={14} />下载未合成图</button>}
                            {canRetrySceneResult(result) && <><button type="button" className="cs-tool-entry" disabled={ws.running || ws.loading || !ws.activeLog} onClick={() => void ws.retryResult(result)}>按原输入仅重试此张</button><small>会提交 1 个新任务，按当前计费规则收费。</small></>}
                            {result.retryLogId && <small>此失败项已发起过重试，请查看对应的新记录。</small>}
                            {canQuerySceneResult(result) && <button type="button" className="cs-tool-entry" disabled={ws.running || ws.loading || !ws.activeLog} onClick={() => void ws.queryResult(result)}>查询原请求</button>}
                            {result.compilationId && result.failureKind === "uncertain" && <><button type="button" className="cs-tool-entry" disabled={ws.running || ws.loading || !ws.activeLog} onClick={() => void ws.queryResult(result, true)}>沿用已优化提示词继续原任务</button><small>不重复优化；图片任务按原请求编号幂等提交，按图片生成规则收费。</small></>}
                        </div> : <div className="cs-result-message"><LoaderCircle className={ws.running ? "animate-spin" : undefined} size={25} /><span>{ws.running ? "正在生成" : "原请求待查询"}方案 {index + 1}</span><small>{result.error || "请求编号已保存，刷新后可查询原任务，不会自动重新提交。"}</small>{canQuerySceneResult(result) && !ws.running && <button type="button" className="cs-tool-entry" disabled={ws.loading || !ws.activeLog} onClick={() => void ws.queryResult(result)}>查询原请求</button>}</div>}
                    </article>)}</div>}
                    {!!ws.results.length && <p className="cs-result-limit">{summary.limit}</p>}
                </div>}
            </section>
        </div>
        {selectionEnabled && tool === "selection" && ws.images.primary && <RegionSelectionDialog source={ws.images.primary} initialMask={ws.selection?.mask.dataUrl} onClose={() => setTool(null)} onSave={blob => ws.saveSelection(ws.images.primary!.id, blob)} />}
        {recolorEnabled && tool === "recolor" && ws.images.primary && <RecolorDialog source={ws.images.primary} onClose={() => setTool(null)} onSave={async (blob, description) => { await ws.saveLocalResult(ws.images.primary!.id, blob, description); setView("results"); }} />}
        {traceEnabled && traceImage && <VectorTraceDialog source={traceImage} onClose={() => setTraceImage(null)} />}
    </main>;
}
