import { Alert, Button, Checkbox, Segmented, Slider, Upload } from "antd";
import { ArrowLeft, Download, FileImage, Save, UploadCloud } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useLocation } from "react-router-dom";
import { ModuleGate } from "@/components/auth/module-gate";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { formatBytes, readImageMeta } from "@/lib/image-utils";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import type { ModuleKey } from "@/services/api/modules";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { canvasPixels, loadProcessingImage } from "./image-processing-browser";
import type { PixelImage } from "./image-processing";
import { defaultVectorOptions, validateVectorOptions, VECTOR_MAX_FILE_BYTES, VECTOR_MAX_SIDE, type VectorMode, type VectorOptions, type VectorTraceResult, type VectorTraceTask } from "./pattern-trace";

type VectorSource = { blob: Blob; name: string; url: string; width: number; height: number };
type VectorDraft = { version: 1; mode: VectorMode; blob: Blob; name: string; options: VectorOptions };
type VectorOutput = VectorTraceResult & { svgUrl: string; pngUrl: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重试";
const identity = () => { const { status, user } = useUserStore.getState(); return `${status}:${user?.role || ""}:${user?.id || "trial"}`; };

export function processVectorInWorker(task: VectorTraceTask, signal?: AbortSignal): Promise<VectorTraceResult> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException("矢量描摹已取消", "AbortError")); return; }
        let worker: Worker | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => { clearTimeout(timer); worker?.terminate(); signal?.removeEventListener("abort", abort); };
        const fail = (error: unknown) => { cleanup(); reject(error); };
        const abort = () => fail(new DOMException("矢量描摹已取消", "AbortError"));
        try {
            worker = new Worker(new URL("./pattern-trace.worker.ts", import.meta.url), { type: "module" });
            worker.onmessage = (event: MessageEvent<{ result?: VectorTraceResult; error?: string }>) => {
                cleanup();
                if (event.data.error || !event.data.result) reject(new Error(event.data.error || "矢量描摹没有返回结果"));
                else resolve(event.data.result);
            };
            worker.onerror = () => fail(new Error("矢量描摹进程失败，请减小图片后重试"));
            worker.onmessageerror = () => fail(new Error("无法读取矢量描摹结果"));
            signal?.addEventListener("abort", abort, { once: true });
            timer = setTimeout(() => fail(new Error("矢量描摹超时，请减少颜色或减小图片")), 60_000);
            worker.postMessage(task);
        } catch (error) { fail(error); }
    });
}

/** Decode the exported SVG itself. PNG is a real rasterization, never the input bitmap. */
export async function rasterizeVector(result: VectorTraceResult, signal: AbortSignal): Promise<VectorOutput> {
    const svgUrl = URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml" }));
    let pngUrl = "";
    try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image();
            const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); image.onload = null; image.onerror = null; };
            const abort = () => { finish(); image.src = ""; reject(new DOMException("矢量预览已取消", "AbortError")); };
            const timer = setTimeout(() => { finish(); image.src = ""; reject(new Error("SVG 预览读取超时")); }, 20_000);
            image.onload = () => { finish(); resolve(image); };
            image.onerror = () => { finish(); reject(new Error("无法渲染 SVG，请调整参数后重试")); };
            if (signal.aborted) { abort(); return; }
            signal.addEventListener("abort", abort, { once: true });
            image.src = svgUrl;
        });
        if (signal.aborted) throw new DOMException("矢量预览已取消", "AbortError");
        const canvas = document.createElement("canvas"); canvas.width = result.width; canvas.height = result.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法创建矢量预览画布");
        context.drawImage(image, 0, 0, result.width, result.height);
        const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG 预览导出失败")), "image/png"));
        canvas.width = 1; canvas.height = 1;
        if (signal.aborted) throw new DOMException("矢量预览已取消", "AbortError");
        pngUrl = URL.createObjectURL(png);
        return { ...result, svgUrl, pngUrl };
    } catch (error) {
        URL.revokeObjectURL(svgUrl); if (pngUrl) URL.revokeObjectURL(pngUrl);
        throw error;
    }
}

export default function VectorWorkspace({ mode: explicitMode }: { mode?: VectorMode }) {
    const { pathname } = useLocation();
    const mode = explicitMode || (pathname.endsWith("pattern-vectorization") ? "pattern" : "sketch");
    const ownerId = useUserStore(state => state.user?.id || "trial");
    const status = useUserStore(state => state.status);
    const role = useUserStore(state => state.user?.role);
    const ready = !deploymentFeatures.authenticationEnabled || (status === "authenticated" && role === "designer");
    const moduleKey = `creative-${mode === "pattern" ? "pattern" : "sketch"}-vectorization` as ModuleKey;
    return <ModuleGate moduleKey={moduleKey}>{ready ? <VectorWorkspaceBody key={`${status}:${role}:${ownerId}:${mode}`} mode={mode} /> : <Alert type="info" title="请完成员工身份验证后使用矢量化工作区。" />}</ModuleGate>;
}

function VectorWorkspaceBody({ mode }: { mode: VectorMode }) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [storage] = useState(() => createWorkspaceStorage("creative_vector_workspaces"));
    const [owner] = useState(identity);
    const [source, setSource] = useState<VectorSource | null>(null);
    const [pixels, setPixels] = useState<PixelImage | null>(null);
    const [options, setOptions] = useState(() => defaultVectorOptions(mode));
    const [output, setOutput] = useState<VectorOutput | null>(null);
    const [preview, setPreview] = useState<"svg" | "png">("svg");
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(false);
    const [restoring, setRestoring] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [statusText, setStatusText] = useState("");
    const [saved, setSaved] = useState("");
    const active = useRef(true);
    const sequence = useRef(0);
    const draftRevision = useRef(0);
    const controller = useRef<AbortController | null>(null);
    const draftKey = `draft:${owner}:${mode}`;
    const current = () => active.current && identity() === owner && storage.isCurrent();
    const stop = () => { controller.current?.abort(); controller.current = null; setBusy(false); };
    const invalidate = () => { stop(); setOutput(null); setStatusText(""); setSaved(""); draftRevision.current++; };

    useEffect(() => {
        active.current = true;
        return () => { active.current = false; sequence.current++; controller.current?.abort(); };
    }, []);
    useEffect(() => () => { if (source) URL.revokeObjectURL(source.url); }, [source]);
    useEffect(() => () => { if (output) { URL.revokeObjectURL(output.svgUrl); URL.revokeObjectURL(output.pngUrl); } }, [output]);

    const loadSource = async (blob: Blob, name: string, restoredOptions?: VectorOptions) => {
        const operation = ++sequence.current;
        invalidate(); setSource(null); setPixels(null); setLoading(true); setError("");
        let url = "", retained = false;
        try {
            if (!["image/png", "image/jpeg", "image/webp"].includes(blob.type) || !blob.size) throw new Error("请选择有效的 PNG、JPG 或 WebP 图片");
            if (blob.size > VECTOR_MAX_FILE_BYTES) throw new Error("图片超过 15 MB，请缩小后重试");
            if (restoredOptions) validateVectorOptions(restoredOptions);
            url = URL.createObjectURL(blob);
            const meta = await readImageMeta(url);
            if (meta.width > 8192 || meta.height > 8192 || meta.width * meta.height > 32_000_000) throw new Error("原图每边不能超过 8192 像素，总量不能超过 3200 万像素");
            const canvas = await loadProcessingImage(url, VECTOR_MAX_SIDE);
            if (!current() || operation !== sequence.current) return;
            setSource({ blob, name: name.slice(0, 200), url, width: meta.width, height: meta.height }); retained = true;
            setPixels(canvasPixels(canvas));
            if (restoredOptions) { setOptions(restoredOptions); setSaved("已恢复当前账号保存的原图和参数"); }
        } catch (caught) { if (current() && operation === sequence.current) setError(errorText(caught)); }
        finally { if (!retained && url) URL.revokeObjectURL(url); if (current() && operation === sequence.current) setLoading(false); }
    };

    useEffect(() => {
        let cancelled = false;
        void storage.getItem<VectorDraft>(draftKey).then(async draft => {
            if (cancelled || !current() || !draft) return;
            if (draft.version !== 1 || draft.mode !== mode || !(draft.blob instanceof Blob) || typeof draft.name !== "string") throw new Error("保存的工作区无法读取，请重新上传图片");
            await loadSource(draft.blob, draft.name, draft.options);
        }).catch(caught => { if (!cancelled && current()) setError(errorText(caught)); })
            .finally(() => { if (!cancelled && current()) setRestoring(false); });
        return () => { cancelled = true; };
    }, [storage, draftKey, mode]);

    const updateOptions = (patch: Partial<VectorOptions>) => { invalidate(); setError(""); setOptions(value => ({ ...value, ...patch })); };
    const trace = async () => {
        if (!pixels || busy || !current()) return;
        const taskController = new AbortController(); controller.current = taskController;
        setBusy(true); setError(""); setOutput(null); setStatusText("正在描摹轮廓…");
        try {
            const result = await processVectorInWorker({ mode, image: pixels, options }, taskController.signal);
            if (!current() || taskController.signal.aborted) return;
            setStatusText("正在从 SVG 渲染 PNG 预览…");
            const rendered = await rasterizeVector(result, taskController.signal);
            if (!current() || taskController.signal.aborted) { URL.revokeObjectURL(rendered.svgUrl); URL.revokeObjectURL(rendered.pngUrl); return; }
            setOutput(rendered); setStatusText("矢量和 PNG 预览已完成");
        } catch (caught) { if (current() && !taskController.signal.aborted) { setError(errorText(caught)); setStatusText(""); } }
        finally { if (controller.current === taskController) { controller.current = null; if (current()) setBusy(false); } }
    };
    const save = async () => {
        if (!source || !current() || saving) return;
        const revision = draftRevision.current;
        setSaving(true); setError("");
        try {
            const draft: VectorDraft = { version: 1, mode, blob: source.blob, name: source.name, options: { ...options } };
            await storage.setItem(draftKey, draft);
            if (current() && revision === draftRevision.current) setSaved("原图和参数已保存，重新打开时自动恢复");
        } catch (caught) { if (current()) setError(`本地保存失败：${errorText(caught)}`); }
        finally { if (current()) setSaving(false); }
    };

    const checker: CSSProperties = useMemo(() => ({ backgroundColor: theme.node.panel, backgroundImage: `linear-gradient(45deg, ${theme.node.stroke} 25%, transparent 25%), linear-gradient(-45deg, ${theme.node.stroke} 25%, transparent 25%), linear-gradient(45deg, transparent 75%, ${theme.node.stroke} 75%), linear-gradient(-45deg, transparent 75%, ${theme.node.stroke} 75%)`, backgroundSize: "20px 20px", backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px" }), [theme]);
    const title = mode === "sketch" ? "线稿矢量化" : "图案矢量化";
    const fileName = `${(source?.name || "图案").replace(/\.[^.]+$/, "")}-${mode === "sketch" ? "线稿" : "彩色"}矢量`;
    const reduced = Boolean(source && pixels && (source.width !== pixels.width || source.height !== pixels.height));

    return <main className="h-full overflow-auto px-5 py-6 sm:px-8" style={{ background: theme.canvas.background, color: theme.node.text }} data-usage-board={`creative-${mode}-vectorization`}>
        <div className="mx-auto max-w-[1440px]">
            <header className="mb-7">
                <Link to="/creative" className="mb-5 inline-flex items-center gap-2 text-sm" style={{ color: theme.node.muted }}><ArrowLeft size={16} />创意设计</Link>
                <div className="flex items-center justify-between gap-4"><h1 className="text-2xl font-semibold tracking-tight">{title}</h1><span className="text-xs" style={{ color: theme.node.muted }}>本地处理 · 无模型调用</span></div>
                <p className="mt-2 text-sm leading-6" style={{ color: theme.node.muted }}>{mode === "sketch" ? "把清晰线稿转为可编辑的黑白轮廓路径，保留小缝线时请将小路径过滤设为 0。" : "把平面图案归并为有限色板并描摹轮廓，保留透明背景。渐变和半透明边缘会被简化。"}</p>
            </header>
            <div className="grid items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
                <aside className="rounded-xl p-5" style={{ background: theme.node.panel, border: `1px solid ${theme.node.stroke}` }}>
                    <h2 className="mb-3 text-sm font-semibold">原始图像</h2>
                    <Upload.Dragger accept="image/png,image/jpeg,image/webp" multiple={false} maxCount={1} showUploadList={false} disabled={loading || restoring} beforeUpload={file => { void loadSource(file, file.name); return false; }} style={{ background: theme.node.fill, borderColor: theme.node.stroke }}>
                        <UploadCloud size={24} className="mx-auto mb-3" style={{ color: theme.toolbar.primary }} />
                        <p className="text-sm">{loading || restoring ? "正在读取图片…" : source ? "点击或拖入图片替换" : "点击或拖入图片"}</p>
                        <p className="mt-2 text-xs" style={{ color: theme.node.muted }}>PNG / JPG / WebP，最多 15 MB</p>
                    </Upload.Dragger>
                    {source && <p className="mt-3 break-all text-xs leading-5" style={{ color: theme.node.muted }}>{source.name}<br />原图 {source.width} × {source.height} · {formatBytes(source.blob.size)}</p>}
                    {reduced && pixels && <Alert className="mt-3" type="warning" showIcon title={`已降采样为 ${pixels.width} × ${pixels.height}`} description="最长边按 2048 像素处理；SVG 与 PNG 使用此尺寸，原始文件保留不变。" />}
                    <div className="mt-6 space-y-5">
                        {mode === "sketch" ? <label className="block text-sm">黑白阈值 <span className="float-right">{options.threshold}</span><Slider ariaLabelForHandle="黑白阈值" min={1} max={254} value={options.threshold} onChange={threshold => updateOptions({ threshold })} /></label>
                            : <label className="block text-sm">调色板颜色上限 <span className="float-right">{options.colors}</span><Slider ariaLabelForHandle="调色板颜色上限" min={2} max={32} value={options.colors} onChange={colors => updateOptions({ colors })} /></label>}
                        <label className="block text-sm">小路径过滤 <span className="float-right">{options.noise}</span><Slider ariaLabelForHandle="小路径过滤" min={0} max={64} value={options.noise} onChange={noise => updateOptions({ noise })} /></label>
                        <label className="block text-sm">路径平滑 <span className="float-right">{options.smoothness}</span><Slider ariaLabelForHandle="路径平滑" min={.1} max={5} step={.1} value={options.smoothness} onChange={smoothness => updateOptions({ smoothness })} /></label>
                        {mode === "sketch" && <Checkbox checked={options.transparentBackground} onChange={event => updateOptions({ transparentBackground: event.target.checked })}>白底转为透明背景</Checkbox>}
                    </div>
                    <p className="mt-3 text-xs leading-5" style={{ color: theme.node.muted }}>较高过滤和平滑会减少路径，也可能删除细线和小色块。</p>
                    <div className="mt-5 flex gap-2"><Button type="primary" block disabled={!pixels || loading || restoring} loading={busy} onClick={() => void trace()}>开始矢量化</Button>{busy && <Button onClick={() => { stop(); setStatusText("已取消，可调整参数后重新开始"); }}>取消</Button>}</div>
                    <Button className="mt-3" block icon={<Save size={14} />} loading={saving} disabled={!source || loading || restoring} onClick={() => void save()}>保存工作区</Button>
                    <p className="mt-3 text-xs leading-5" style={{ color: theme.node.muted }}>{saved || "原图和参数按当前账号保存在本机浏览器，保存时保留原始图片文件。"}</p>
                </aside>
                <section className="min-w-0" aria-label="矢量化预览与导出">
                    {error && <Alert className="mb-4" type="error" showIcon title={error} />}
                    {statusText && <p className="mb-3 text-sm" style={{ color: theme.node.muted }} role="status">{statusText}</p>}
                    <div className="grid gap-4 xl:grid-cols-2">
                        <figure className="min-w-0 overflow-hidden rounded-xl" style={{ border: `1px solid ${theme.node.stroke}`, background: theme.node.panel }}>
                            <figcaption className="flex h-14 items-center gap-2 px-4 text-sm font-medium"><FileImage size={16} />原始图像</figcaption>
                            <div className="flex min-h-[350px] items-center justify-center p-4" style={checker}>{source ? <img src={source.url} alt="矢量化原图" className="max-h-[560px] w-full object-contain" /> : <span className="text-sm" style={{ color: theme.node.muted }}>上传图像后在这里查看</span>}</div>
                        </figure>
                        <figure className="min-w-0 overflow-hidden rounded-xl" style={{ border: `1px solid ${theme.node.stroke}`, background: theme.node.panel }}>
                            <figcaption className="flex h-14 items-center justify-between gap-2 px-4 text-sm font-medium"><span>描摹结果</span><Segmented size="small" value={preview} onChange={value => setPreview(value as "svg" | "png")} options={[{ label: "SVG", value: "svg" }, { label: "PNG 回读", value: "png" }]} /></figcaption>
                            <div className="flex min-h-[350px] items-center justify-center p-4" style={checker}>{output ? <img src={preview === "svg" ? output.svgUrl : output.pngUrl} alt={preview === "svg" ? "SVG 矢量路径预览" : "从 SVG 实际渲染的 PNG 预览"} className="max-h-[560px] w-full object-contain" /> : <span className="px-4 text-center text-sm leading-6" style={{ color: theme.node.muted }}>{busy ? statusText : "点击开始矢量化，查看实际轮廓结果"}</span>}</div>
                        </figure>
                    </div>
                    {output && <div className="mt-5 rounded-xl p-5" style={{ background: theme.node.panel, border: `1px solid ${theme.node.stroke}` }}>
                        <div className="flex flex-wrap items-center justify-between gap-4"><p className="text-sm">{output.width} × {output.height} · {output.pathCount.toLocaleString()} 条可见路径 · {formatBytes(new Blob([output.svg]).size)}</p><div className="flex flex-wrap gap-2"><Button type="primary" icon={<Download size={14} />} href={output.svgUrl} download={`${fileName}.svg`}>下载 SVG</Button><Button icon={<Download size={14} />} href={output.pngUrl} download={`${fileName}-预览.png`}>下载 PNG 预览</Button></div></div>
                        {mode === "pattern" && <div className="mt-4 flex flex-wrap items-center gap-2"><span className="mr-1 text-xs" style={{ color: theme.node.muted }}>实际色板 {output.palette.length} 色</span>{output.palette.map((color, at) => <span key={at} className="inline-block size-5 rounded-sm" style={{ background: `rgba(${color.r},${color.g},${color.b},${color.a / 255})`, border: `1px solid ${theme.node.stroke}` }} title={`RGBA ${color.r}, ${color.g}, ${color.b}, ${color.a}`} />)}</div>}
                        <p className="mt-3 text-xs leading-5" style={{ color: theme.node.muted }}>PNG 由上方导出的 SVG 实际渲染，透明格表示背景未填色。{mode === "sketch" ? "导出的是线条外轮廓，不是单线中心线或服装纸样。" : "适合色块清晰的平面图案；请放大检查细节与原图颜色的差异。"}</p>
                    </div>}
                </section>
            </div>
        </div>
    </main>;
}
