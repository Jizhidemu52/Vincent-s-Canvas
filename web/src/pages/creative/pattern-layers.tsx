import { Alert, Button, Checkbox, Image, Input, InputNumber, Slider } from "antd";
import { ArrowDown, ArrowLeft, ArrowUp, Download, Layers, Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { ModelPicker } from "@/components/model-picker";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { useToolConfig, useToolEnabled } from "@/hooks/use-tool-config";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { normalizeImageModelSettings, useImageModelProfile } from "@/lib/image-model-settings";
import { readFileAsDataUrl, readImageMeta } from "@/lib/image-utils";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { workbenchSubmissions } from "@/lib/submission-gate";
import { requestEdit } from "@/services/api/image";
import { getQueuedTaskByRequestId, recoverQueuedMedia } from "@/services/api/generation-tasks";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { modelOptionName, useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { RegionSelectionDialog } from "./region-selection-dialog";
import { preferredSelectionSize, selectionSizeMatches } from "./image-processing";
import { canvasPixels, loadProcessingImage, pixelsCanvas } from "./image-processing-browser";
import { editorPngBlob } from "@/lib/canvas/image-editor-document";
import { sceneParameters, type SceneImage, type SceneParameters } from "./use-scene-workspace";
import { buildLayerMaskPrompt, layerMaskCoverage, MAX_LAYER_PIXELS, MAX_PATTERN_LAYERS, type LayerPixels, type PatternLayer } from "./pattern-layers-model";
import { exportPatternPsd, exportPatternZip, preparePatternLayers, renderPatternLayers } from "./pattern-layers-export";
import "./scene.css";

const toolKey = "creative-pattern-layers";
type PendingLayer = { taskId?: string; requestId?: string; sourceId: string; label: string };
type LayerDraft = { source: SceneImage | null; layers: PatternLayer[]; parameters: SceneParameters; label: string; pending?: PendingLayer | null };
const message = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试";
const writes = new Map<string, Promise<unknown>>();

export default function PatternLayersPage() {
    const ownerId = useUserStore(state => state.user?.id);
    return <PatternLayersWorkspace key={ownerId || "anonymous"} />;
}

function PatternLayersWorkspace() {
    const user = useUserStore(state => state.user);
    const owner = user?.id;
    const storage = useMemo(() => createWorkspaceStorage("creative_pattern_layers"), [owner]);
    const effective = useEffectiveConfig();
    const [parameters, setParameters] = useState(() => sceneParameters(effective));
    const selected = useToolConfig({ ...effective, ...parameters, model: parameters.imageModel || parameters.model }, toolKey);
    const profile = useImageModelProfile(selected.model);
    const config = { ...selected, ...normalizeImageModelSettings(parameters, profile), count: "1" };
    const enabled = useToolEnabled(toolKey);
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const business = useBusinessConfigStore();
    const [source, setSource] = useState<SceneImage | null>(null);
    const [layers, setLayers] = useState<PatternLayer[]>([]);
    const layersRef = useRef(layers); layersRef.current = layers;
    const [label, setLabel] = useState("");
    const [pending, setPending] = useState<PendingLayer | null>(null);
    const [active, setActive] = useState("");
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [status, setStatus] = useState("");
    const [selecting, setSelecting] = useState(false);
    const [initialMask, setInitialMask] = useState<string>();
    const [editingId, setEditingId] = useState<string>();
    const [preview, setPreview] = useState("");
    const [prepared, setPrepared] = useState<{ width: number; height: number; layers: LayerPixels[] }>();
    const epoch = useRef(0);
    const current = () => storage.isCurrent() && useUserStore.getState().user?.id === owner;
    const activeLayer = layers.find(layer => layer.id === active);
    const estimate = business.estimate({ toolKey, modelId: modelOptionName(selected.model), operationType: "inpaint", quantity: 1 });
    const model = business.models.find(item => item.id === selected.model || item.modelId === modelOptionName(selected.model));
    const ratioBlocked = Boolean(source && !selectionSizeMatches(config.size, source));
    const aiBlocked = ratioBlocked || !enabled || !model?.capabilities.includes("edit") || !profile.requiresPrompt || business.status !== "ready" || !user || user.status !== "active"
        || (deploymentFeatures.creditsEnabled && (!estimate.configured || user.creditBalance < estimate.credits));

    useEffect(() => { if (business.status === "idle") void business.refresh().catch(() => undefined); }, [business.status, business.refresh]);
    useEffect(() => {
        const revision = ++epoch.current;
        void (async () => {
            try {
                await writes.get(owner || "");
                const draft = await storage.getItem<LayerDraft>(`draft:${owner}`);
                if (revision !== epoch.current || !current()) return;
                if (draft) { setSource(draft.source); setLayers(draft.layers); setParameters(draft.parameters); setLabel(draft.label); setPending(draft.pending || null); setActive(draft.layers.at(-1)?.id || ""); }
                setReady(true);
            } catch (caught) { if (revision === epoch.current) { setError(`草稿读取失败：${message(caught)}`); setReady(true); } }
        })();
        return () => { epoch.current++; };
    }, [storage, owner]);
    useEffect(() => {
        if (!ready || !current()) return;
        const value = { source, layers, label, pending, parameters: sceneParameters(parameters) };
        const write = (writes.get(owner || "") || Promise.resolve()).then(() => storage.setItem(`draft:${owner}`, value)).catch(caught => { if (current()) setError(`草稿保存失败：${message(caught)}`); });
        writes.set(owner || "", write);
        void write.finally(() => { if (writes.get(owner || "") === write) writes.delete(owner || ""); });
    }, [source, layers, label, pending, parameters, ready, storage, owner]);
    useEffect(() => {
        let cancelled = false, url = "";
        setPrepared(undefined);
        const timer = window.setTimeout(() => {
            if (!source) { setPreview(""); return; }
            void preparePatternLayers(source.dataUrl, layers).then(async value => {
                const blob = await editorPngBlob(renderPatternLayers(value.width, value.height, value.layers));
                if (cancelled) return;
                url = URL.createObjectURL(blob); setPreview(url); setPrepared(value);
            }).catch(caught => { if (!cancelled) setError(message(caught)); });
        }, 180);
        return () => { cancelled = true; window.clearTimeout(timer); if (url) URL.revokeObjectURL(url); };
    }, [source, layers]);

    const loadSource = async (file: File) => {
        const revision = ++epoch.current;
        setBusy(true); setError("");
        try {
            if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("请上传 PNG、JPG 或 WebP 图片");
            const dataUrl = await readFileAsDataUrl(file), meta = await readImageMeta(dataUrl);
            if (meta.width * meta.height > MAX_LAYER_PIXELS) throw new Error("分层最多处理 800 万像素，请先缩小图片");
            if (revision !== epoch.current || !current()) return;
            setSource({ id: nanoid(), name: file.name, originalFileName: file.name, type: file.type, dataUrl, ...meta, bytes: file.size });
            setLayers([]); setActive(""); setStatus(""); setPending(null);
            setParameters(value => ({ ...value, size: preferredSelectionSize(meta, profile.sizes) }));
        } catch (caught) { if (revision === epoch.current) setError(message(caught)); }
        finally { if (revision === epoch.current) setBusy(false); }
    };
    const addLayer = (maskUrl: string, maskMode: PatternLayer["maskMode"], sourceTaskId?: string, name = label) => {
        const layer: PatternLayer = { id: nanoid(), name: name.trim() || `图层 ${layers.length + 1}`, maskUrl, maskMode, sourceTaskId, threshold: 128, visible: true, opacity: 1, x: 0, y: 0 };
        setLayers(value => [...value, layer]); setActive(layer.id);
    };
    const updateLayer = (patch: Partial<PatternLayer>) => setLayers(value => value.map(layer => layer.id === active ? { ...layer, ...patch } : layer));
    const persistPending = async (value: PendingLayer, original: SceneImage) => {
        const write = (writes.get(owner || "") || Promise.resolve()).catch(() => undefined).then(async () => {
            const existing = await storage.getItem<LayerDraft>(`draft:${owner}`);
            // The user may have opened a fresh project while an accepted POST was returning.
            if (existing?.source && existing.source.id !== original.id) return;
            if (value.taskId && existing?.pending?.requestId !== value.requestId) return;
            await storage.setItem(`draft:${owner}`, {
                source: original, layers: existing?.layers || layers, label: value.label, pending: value, parameters: sceneParameters(parameters),
            });
        });
        writes.set(owner || "", write);
        await write;
    };
    const generate = async (recover = false) => {
        if (!source || busy || layers.length >= MAX_PATTERN_LAYERS || !current()) return;
        if (recover ? !pending || pending.sourceId !== source.id || !enabled : aiBlocked || pending) return;
        const release = workbenchSubmissions.acquire(`image:${owner}`);
        if (!release) { setError("其他图片任务正在处理中，请稍后重试"); return; }
        const revision = epoch.current;
        const targetLabel = recover ? pending!.label : label;
        setBusy(true); setError(""); setStatus(recover ? "正在恢复原任务，不会重新生成或重复收费…" : "正在生成该元素的分离蒙版…");
        try {
            const prompt = buildLayerMaskPrompt(targetLabel);
            let results: Array<{ dataUrl: string; sourceTaskId?: string }>;
            if (recover) {
                const taskId = pending!.taskId || (pending!.requestId ? (await getQueuedTaskByRequestId(`${pending!.requestId}:0`))?.id : undefined);
                if (!taskId) throw new Error("尚未查询到原任务，请稍后再查；没有重新生成。确认原任务未提交时可移除此记录。");
                if (revision !== epoch.current || !current()) return;
                results = (await recoverQueuedMedia(taskId)).map(dataUrl => ({ dataUrl, sourceTaskId: taskId }));
            } else {
                const submitted = { requestId: nanoid(), sourceId: source.id, label: targetLabel };
                setPending(submitted);
                await persistPending(submitted, source);
                if (revision !== epoch.current || !current()) return;
                results = await requestEdit(config, prompt, [source], undefined, { tool: toolKey, operationType: "inpaint", requestId: submitted.requestId, onSubmitted: async ids => {
                    if (!ids[0] || !current()) return;
                    const accepted = { ...submitted, taskId: ids[0] };
                    if (revision === epoch.current) setPending(accepted);
                    // A route change must not discard an already accepted paid task.
                    await persistPending(accepted, source);
                } });
            }
            const result = results[0];
            if (!result) throw new Error("模型没有返回蒙版");
            const response = await fetch(result.dataUrl);
            if (!response.ok) throw new Error("蒙版原图读取失败");
            const maskUrl = await readFileAsDataUrl(new File([await response.blob()], "mask.png", { type: response.headers.get("content-type") || "image/png" }));
            const candidate = { id: "check", name: targetLabel, maskUrl, maskMode: "luminance" as const, threshold: 128, visible: true, opacity: 1, x: 0, y: 0 };
            const checked = await preparePatternLayers(source.dataUrl, [candidate]);
            const extracted = checked.layers[1]!;
            if (!extracted.image.data.some((value, index) => index % 4 === 3 && value > 0)) throw new Error("蒙版未选中任何原图像素，请修改元素描述或改用手工涂选");
            if (revision !== epoch.current || !current()) return;
            addLayer(maskUrl, "luminance", result.sourceTaskId, targetLabel); setPending(null); setStatus("已从原图提取图层。请查看蒙版边缘，必要时调整阈值或手工修正。");
        } catch (caught) { if (revision === epoch.current && current()) { setError(message(caught)); setStatus(""); } }
        finally { release(); if (revision === epoch.current && current()) setBusy(false); }
    };
    const openSelection = async (layer?: PatternLayer) => {
        if (!source || busy) return;
        const revision = epoch.current;
        setError(""); setBusy(true);
        try {
            let mask: string | undefined;
            if (layer) {
                const raw = await loadProcessingImage(layer.maskUrl);
                const resized = document.createElement("canvas"); resized.width = source.width; resized.height = source.height;
                resized.getContext("2d")!.drawImage(raw, 0, 0, source.width, source.height);
                const pixels = canvasPixels(resized), coverage = layerMaskCoverage(pixels, layer.maskMode, layer.threshold);
                for (let i = 0; i < coverage.length; i++) pixels.data.set([42, 119, 246, coverage[i] ? 255 : 0], i * 4);
                mask = pixelsCanvas(pixels).toDataURL("image/png");
            }
            if (!current() || revision !== epoch.current || (layer && !layersRef.current.some(item => item.id === layer.id))) return;
            setEditingId(layer?.id); setInitialMask(mask); setSelecting(true);
        } catch (caught) { if (current() && revision === epoch.current) setError(message(caught)); }
        finally { if (current() && revision === epoch.current) setBusy(false); }
    };
    const download = async (kind: "psd" | "zip" | "png") => {
        if (!prepared || busy) return;
        setBusy(true); setError("");
        try {
            const blob = kind === "psd" ? await exportPatternPsd(prepared.width, prepared.height, prepared.layers) : kind === "zip" ? await exportPatternZip(prepared.width, prepared.height, prepared.layers) : await editorPngBlob(renderPatternLayers(prepared.width, prepared.height, prepared.layers));
            saveAs(blob, `图案分层.${kind}`);
        } catch (caught) { setError(message(caught)); }
        finally { if (current()) setBusy(false); }
    };
    const reorder = (direction: number) => {
        const index = layers.findIndex(layer => layer.id === active), destination = index + direction;
        if (index < 0 || destination < 0 || destination >= layers.length) return;
        setLayers(value => { const next = [...value]; [next[index], next[destination]] = [next[destination]!, next[index]!]; return next; });
    };

    return <main className="wb-page cs-page">
        <header className="cs-header"><Link to="/creative" className="cs-back"><ArrowLeft size={16} />创意设计</Link><span className="cs-header-divider" /><strong>图案分层</strong><span className="cs-help">原像素提取 · 多层 PSD / PNG</span></header>
        <div className="cs-layout">
            <aside className="cs-form-panel"><div className="cs-form-heading"><span className="cs-eyebrow">PATTERN LAYERS</span><h1>把元素变成独立图层</h1><p>描述要分离的图案，或直接涂选。导出后可继续移动、改色和排版。</p></div>
                <fieldset disabled={busy || !ready} className="cs-fields">
                    <label className="cs-upload-control"><input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; if (file) void loadSource(file); event.target.value = ""; }} />{source ? <img className="cs-upload-preview" src={source.dataUrl} alt="分层原图，点击更换" /> : <span className="cs-upload-empty"><Plus size={24} /><strong>上传原始图案</strong><span>PNG / JPG / WebP · 最高 800 万像素</span></span>}</label>
                    {source && <p className="cs-help">{source.width} × {source.height} px · 更换原图会新建分层工程</p>}
                    <label className="cs-field"><span className="cs-label">要分离的元素</span><Input.TextArea value={label} maxLength={300} rows={3} onChange={event => setLabel(event.target.value)} placeholder="例如：前景的红色花朵，保留花瓣间的孔洞" /></label>
                    <Button type="primary" icon={<Sparkles size={15} />} onClick={() => void generate()} disabled={!source || !label.trim() || aiBlocked || Boolean(pending) || layers.length >= MAX_PATTERN_LAYERS} loading={busy && /^(正在生成|正在恢复)/.test(status)}>AI 分离一个图层{deploymentFeatures.creditsEnabled ? ` · ${estimate.credits} 积分` : ""}</Button>
                    {pending && <><Button onClick={() => void generate(true)} disabled={!enabled || !source || pending.sourceId !== source.id || layers.length >= MAX_PATTERN_LAYERS}>恢复原图层任务 · 不重新生成</Button><p className="cs-help">原任务 {pending.taskId || pending.requestId} 尚未保存为图层。请先恢复结果；确认不再需要时可移除此记录。</p><Button type="text" onClick={() => { setPending(null); setError(""); }}>移除待恢复记录</Button></>}
                    <Button icon={<Plus size={15} />} onClick={() => void openSelection()} disabled={!source || layers.length >= MAX_PATTERN_LAYERS}>手工涂选新图层 · 免费</Button>
                    {aiBlocked && <p className="cs-help">{ratioBlocked ? "蒙版尺寸须保持原图比例。请在设置中选择自适应或与原图一致的比例。" : "AI 分层需要可用的图像编辑模型与额度；手工涂选和导出可直接使用。"}</p>}
                    <details className="cs-output-settings"><summary>AI 蒙版设置 · 每次 1 张</summary><ModelPicker config={config} toolKey={toolKey} value={selected.model} onChange={value => setParameters(p => ({ ...p, model: value, imageModel: value }))} capability="image" fullWidth disabled={busy} /><ImageSettingsPanel config={config} referenceCount={source ? 1 : 0} onConfigChange={(key, value) => setParameters(p => ({ ...p, [key]: value }))} theme={theme} showTitle={false} /></details>
                    <p className="cs-help">分层保留可见原图像素，不恢复被遮挡的内容。移动图层后原位置会露出透明区域；重叠选区由上层优先取得。每次 AI 分离单独提交与计费。</p>
                </fieldset>
                <div className="py-4 space-y-3">{error && <Alert type="error" title={error} showIcon closable onClose={() => setError("")} />}{status && <p className="cs-help" role="status">{status}</p>}</div>
            </aside>
            <section className="cs-stage overflow-y-auto" aria-label="图层编辑与导出">
                <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] p-4"><Layers size={18} /><strong className="mr-auto text-sm">{layers.length} / {MAX_PATTERN_LAYERS} 个元素图层</strong>{(["psd", "zip", "png"] as const).map(kind => <Button key={kind} icon={<Download size={14} />} disabled={!prepared || busy || !layers.length} onClick={() => void download(kind)}>{kind === "zip" ? "PNG 图层包" : kind.toUpperCase()}</Button>)}</div>
                <div className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_240px]">
                    <div className="min-w-0">{preview ? <div className="rounded-lg border border-[var(--border)] bg-[var(--muted)] p-3"><Image src={preview} alt="分层合成预览" style={{ maxHeight: "65vh", objectFit: "contain" }} /></div> : <div className="cs-empty"><Layers size={32} /><h3>上传一张图案开始分层</h3><p>PSD 包含独立元素和剩余背景，不是整图重复叠放。</p></div>}</div>
                    <div className="space-y-3">
                        <p className="cs-label">图层顺序（上方覆盖下方）</p>
                        {[...layers].reverse().map(layer => <button type="button" key={layer.id} className={`flex w-full items-center gap-2 rounded border p-3 text-left text-xs ${active === layer.id ? "border-[var(--foreground)] bg-[var(--muted)]" : "border-[var(--border)]"}`} onClick={() => setActive(layer.id)}><Layers size={14} /><span className="truncate">{layer.name}</span><span className="ml-auto text-[var(--muted-foreground)]">{layer.visible ? "显示" : "隐藏"}</span></button>)}
                        {source && <p className="rounded border border-[var(--border)] p-3 text-xs text-[var(--muted-foreground)]">原图剩余背景</p>}
                        {activeLayer && <fieldset disabled={busy} className="space-y-3 border-t border-[var(--border)] pt-3">
                            <Input aria-label="图层名称" value={activeLayer.name} onChange={event => updateLayer({ name: event.target.value.slice(0, 80) })} />
                            <div className="flex items-center gap-2"><Checkbox checked={activeLayer.visible} onChange={event => updateLayer({ visible: event.target.checked })}>显示</Checkbox><Button aria-label="图层上移" icon={<ArrowUp size={14} />} onClick={() => reorder(1)} /><Button aria-label="图层下移" icon={<ArrowDown size={14} />} onClick={() => reorder(-1)} /><Button aria-label="删除图层" icon={<Trash2 size={14} />} onClick={() => { setLayers(value => value.filter(layer => layer.id !== active)); setActive(""); }} /></div>
                            <label className="cs-field"><span className="cs-label">不透明度 {Math.round(activeLayer.opacity * 100)}%</span><Slider value={Math.round(activeLayer.opacity * 100)} onChange={value => updateLayer({ opacity: value / 100 })} /></label>
                            <div className="cs-field-row"><label className="cs-field"><span className="cs-label">X 位移 (px)</span><InputNumber value={activeLayer.x} min={-(source?.width || 0)} max={source?.width} onChange={value => updateLayer({ x: value || 0 })} /></label><label className="cs-field"><span className="cs-label">Y 位移 (px)</span><InputNumber value={activeLayer.y} min={-(source?.height || 0)} max={source?.height} onChange={value => updateLayer({ y: value || 0 })} /></label></div>
                            <label className="cs-field"><span className="cs-label">蒙版阈值 {activeLayer.threshold}</span><Slider min={1} max={254} value={activeLayer.threshold} onChange={value => updateLayer({ threshold: value })} /></label>
                            <Button block onClick={() => void openSelection(activeLayer)}>手工修正此图层边缘</Button>
                            <details><summary className="cs-help cursor-pointer">查看原始选择蒙版</summary><Image src={activeLayer.maskUrl} alt={`${activeLayer.name}选择蒙版`} /></details>
                        </fieldset>}
                    </div>
                </div>
            </section>
        </div>
        {selecting && source && <RegionSelectionDialog purpose="layer" source={source} initialMask={initialMask} onClose={() => setSelecting(false)} onSave={async blob => {
            const dataUrl = await readFileAsDataUrl(new File([blob], "selection.png", { type: "image/png" }));
            if (!current()) throw new Error("员工会话已变化，请重新进入");
            if (editingId) setLayers(value => value.map(layer => layer.id === editingId ? { ...layer, maskUrl: dataUrl, maskMode: "alpha", threshold: 128 } : layer));
            else addLayer(dataUrl, "alpha");
        }} />}
    </main>;
}
