import { ArrowLeft, ArrowRight, ChevronDown, Download, History, ImageIcon, LoaderCircle, Plus, RotateCcw, Sparkles } from "lucide-react";
import { Image } from "antd";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ModuleGate } from "@/components/auth/module-gate";
import { GenerationElapsed } from "@/components/generation-elapsed";
import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { creativePresets, getCreativePreset, type CreativePreset } from "@/lib/creative-presets";
import { useModuleStore } from "@/stores/use-module-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { SceneFields, SceneUploads } from "./scene-form";
import { buildScenePrompt, getSceneSlots, sceneSummaries } from "./scene-form-model";
import { useSceneWorkspace, type SceneImage } from "./use-scene-workspace";
import { RegionSelectionDialog } from "./region-selection-dialog";
import { RecolorDialog } from "./recolor-dialog";
import { VectorTraceDialog } from "./vector-trace-dialog";
import { selectionPrompt } from "./image-processing";
import "./scene.css";

export default function CreativeScenePage() {
    const { presetId } = useParams<{ presetId: string }>();
    const preset = getCreativePreset(presetId ?? null);
    const ownerId = useUserStore(state => state.user?.id);
    if (!preset) return <main className="wb-page wb-empty h-full">
        <h1 className="wb-title">设计场景不存在</h1>
        <p>请返回创意设计选择其他场景。</p>
        <Link to="/creative" className="wb-primary-link">返回创意设计</Link>
    </main>;
    return <ModuleGate moduleKey={preset.tool === "image-generation" ? "image" : "image-edit"}>
        <CreativeSceneWorkspace key={`${ownerId}:${preset.id}`} preset={preset} />
    </ModuleGate>;
}

function CreativeSceneWorkspace({ preset }: { preset: CreativePreset }) {
    const ws = useSceneWorkspace(preset.id);
    const navigate = useNavigate();
    const flags = useModuleStore(state => state.flags);
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [view, setView] = useState<"example" | "results" | "history">("example");
    const [tool, setTool] = useState<"selection" | "recolor" | null>(null);
    const [traceImage, setTraceImage] = useState<SceneImage | null>(null);
    const summary = sceneSummaries[preset.id]!;
    const slots = getSceneSlots(preset.id, ws.form);
    const available = creativePresets.filter(item => flags[item.tool === "image-generation" ? "image" : "image-edit"]);
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
                        {preset.id === "local-restyle" && <div className="cs-local-tool"><button type="button" className="cs-tool-entry" disabled={!ws.images.primary || ws.uploading} onClick={() => setTool("selection")}>{ws.selection ? "编辑修改选区" : "涂选修改区域"}<ArrowRight size={14} /></button>
                            <p className="cs-help">{ws.selection ? "已开启选区合成：选区外保留原图。修改处的结构和衔接仍需检查。" : "未涂选时由 AI 修改整张图，不能保证其他部位不变。"}</p>
                            {ws.selection && <button type="button" className="cs-help" onClick={ws.clearSelection}>清除选区，使用整图 AI 修改</button>}</div>}
                        {preset.id === "pattern-colorway" && <div className="cs-local-tool"><button type="button" className="cs-tool-entry" disabled={!ws.images.primary || ws.uploading} onClick={() => setTool("recolor")}>精确换色<small>本地 · 不调用 AI</small><ArrowRight size={14} /></button><p className="cs-help">平面花型可按原色→目标色直接替换；下方保留 AI 配色拓展。</p></div>}
                        {preset.id === "style-to-sketch" && <div className="cs-local-tool"><button type="button" className="cs-tool-entry" disabled={!ws.images.primary || ws.uploading} onClick={() => setTraceImage(ws.images.primary!)}>已有线稿转 SVG<ArrowRight size={14} /></button><p className="cs-help">也可先生成线稿，再从结果卡导出矢量路径。</p></div>}
                    </section>}
                    <section className="cs-business-section"><h2 className="cs-section-label"><span>{slots.length ? "02" : "01"}</span>{preset.id.includes("colorway") ? "选择配色方式" : preset.id === "pattern-craft" ? "选择工艺效果" : preset.id === "text-to-style" ? "描述你的设计" : preset.id === "style-to-sketch" ? "线稿要求" : preset.id === "local-restyle" ? "指定修改部位" : preset.id === "back-design" ? "构思背面结构" : preset.id === "accessory-design" ? "定义辅料外观" : "提取要求"}</h2><SceneFields sceneId={preset.id} form={ws.form} onChange={ws.setForm} disabled={ws.running} /></section>
                    <details className="cs-output-settings"><summary><span>出图设置</span><span>{imageSizeLabel(ws.config.size)} · {imageQualityLabel(ws.config.quality)} · {ws.count} 张<ChevronDown size={13} /></span></summary>
                        <label className="cs-label">生成模型</label><ModelPicker config={ws.config} value={ws.model} onChange={value => ws.updateConfig("imageModel", value)} capability="image" fullWidth disabled={ws.running} />
                        <ImageSettingsPanel config={ws.config} onConfigChange={ws.updateConfig} theme={theme} showTitle={false} />
                    </details>
                    <details className="cs-prompt-preview"><summary>查看本次设计指令<ChevronDown size={12} /></summary><pre>{buildScenePrompt(preset.id, ws.form)}{ws.selection ? `\n\n${selectionPrompt}` : ""}</pre></details>
                </fieldset>}
                <div className="cs-submit-panel">
                    {ws.error && <p className="cs-error" role="alert">{ws.error}</p>}
                    {!ws.error && ws.validation && <p className="cs-validation">{ws.validation}</p>}
                    <button type="button" className="cs-generate" disabled={ws.loading || ws.running || Boolean(ws.validation) || ws.quotaBlocked} onClick={submit}>{ws.running ? <><LoaderCircle size={16} className="animate-spin" />正在生成<GenerationElapsed startedAt={ws.startedAt} /></> : <><Sparkles size={16} />生成{preset.title === "以文生款" ? "款式" : preset.title === "款生线稿" ? "线稿" : preset.title === "花型提取" ? "图案" : "设计"}<span>{ws.count} 张</span></>}</button>
                    <p className="cs-submit-note">{deploymentFeatures.creditsEnabled ? `预计 ${ws.estimatedCredits} 积分 · ` : ""}点击后提交模型任务</p>
                </div>
            </aside>
            <section className="cs-stage" aria-label="设计预览与结果">
                <nav className="cs-stage-tabs" aria-label="预览内容">
                    <button type="button" aria-pressed={view === "example"} onClick={() => setView("example")}><ImageIcon size={15} />功能示例</button>
                    <button type="button" aria-pressed={view === "results"} onClick={() => setView("results")}>当前结果{ws.results.length ? <span>{ws.results.length}</span> : null}</button>
                    <button type="button" className="cs-history-tab" aria-pressed={view === "history"} onClick={() => setView("history")}><History size={15} />最近任务{ws.logs.length ? <span>{ws.logs.length}</span> : null}</button>
                </nav>
                {view === "example" ? <div className="cs-example">
                    <div className="cs-example-heading"><span className="cs-eyebrow">WHAT YOU CAN CREATE</span><h2>{summary.input}<ArrowRight size={21} />{summary.output}</h2><p>{summary.example}</p></div>
                    <figure className="cs-example-image"><img src={`/creative-scenes/v2/${preset.id}.png`} alt={`${preset.title}：${summary.input}转为${summary.output}的概念示意`} /><figcaption><span>{summary.input}</span><ArrowRight size={17} /><span>{summary.output}</span></figcaption></figure>
                    <div className="cs-example-foot"><span>AI 功能示意 · 非模型实测</span><p>{summary.limit}</p></div>
                </div> : view === "history" ? <div className="cs-history">
                    <h2>最近任务</h2><p className="cs-help">仅显示当前账号在「{preset.title}」中已结束的任务，保存在本机浏览器。</p>
                    {ws.logs.length ? ws.logs.map(log => <button key={log.id} type="button" className="cs-history-item" disabled={ws.running} onClick={() => { void ws.restoreLog(log); setView("results"); }}>
                        <span className="cs-history-icon"><History size={18} /></span><span><strong>{new Date(log.createdAt).toLocaleString("zh-CN", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}</strong><small>{log.operation === "recolor" ? "本地精确换色 · " : log.selection ? "选区合成 · " : ""}{log.successCount} 张成功{log.failCount ? ` · ${log.failCount} 张失败` : ""} · 继续此任务</small></span><ArrowRight size={15} />
                    </button>) : <div className="cs-empty"><History size={26} /><h3>还没有生成记录</h3><p>完成一次设计后，会在这里保存参数和结果。</p></div>}
                </div> : <div className="cs-results">
                    <div className="cs-results-heading"><h2>{ws.running ? "正在创作" : "设计结果"}</h2>{ws.activeLog && <span>{new Date(ws.activeLog.createdAt).toLocaleString("zh-CN")}</span>}</div>
                    {ws.activeLog?.operation === "recolor" && <p className="cs-help cs-operation-note">{ws.activeLog.prompt}</p>}
                    {!ws.results.length ? <div className="cs-empty"><Sparkles size={28} /><h3>让设计从这里开始</h3><p>在左侧完成{slots.length ? "素材和" : ""}设计要求，点击生成。</p><button type="button" onClick={() => setView("example")}><RotateCcw size={14} />看看功能示例</button></div> : <div className="cs-result-grid">{ws.results.map((result, index) => <article key={result.id} className="cs-result-card">
                        {result.status === "success" && result.image ? <><Image src={result.image.dataUrl} alt={`${preset.title}结果 ${index + 1}`} /><div className="cs-result-meta"><span>方案 {String(index + 1).padStart(2, "0")}</span><button type="button" onClick={() => { void ws.download(result.image!, index); }}><Download size={14} />下载原图</button>{preset.id === "style-to-sketch" && <button type="button" onClick={() => setTraceImage(result.image!)}>导出 SVG</button>}</div></> : result.status === "failed" ? <div className="cs-result-message"><span>方案 {index + 1} {result.uncompositedImage ? "合成未完成" : "生成失败"}</span><p>{result.error}</p>{result.uncompositedImage && <button type="button" className="cs-tool-entry" onClick={() => void ws.download(result.uncompositedImage!, index)}><Download size={14} />下载未合成图</button>}</div> : <div className="cs-result-message"><LoaderCircle className="animate-spin" size={25} /><span>正在生成方案 {index + 1}</span><small>请保留此页面，避免中断结果保存</small></div>}
                    </article>)}</div>}
                    {!!ws.results.length && <p className="cs-result-limit">{summary.limit}</p>}
                </div>}
            </section>
        </div>
        {tool === "selection" && ws.images.primary && <RegionSelectionDialog source={ws.images.primary} initialMask={ws.selection?.mask.dataUrl} onClose={() => setTool(null)} onSave={blob => ws.saveSelection(ws.images.primary!.id, blob)} />}
        {tool === "recolor" && ws.images.primary && <RecolorDialog source={ws.images.primary} onClose={() => setTool(null)} onSave={async (blob, description) => { await ws.saveLocalResult(ws.images.primary!.id, blob, description); setView("results"); }} />}
        {traceImage && <VectorTraceDialog source={traceImage} onClose={() => setTraceImage(null)} />}
    </main>;
}
