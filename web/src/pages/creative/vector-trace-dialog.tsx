import { uiText, useUiText } from "@/lib/i18n";
import { Alert, Button, Modal, Slider } from "antd";
import { useEffect, useState } from "react";
import { canvasPixels, loadProcessingImage } from "./image-processing-browser";
import type { PixelImage } from "./image-processing";
import type { TraceOptions } from "./line-trace";
import type { SceneImage } from "./use-scene-workspace";

export function VectorTraceDialog({ source, onClose }: { source: SceneImage; onClose: () => void }) {
    useUiText();
    const [pixels, setPixels] = useState<PixelImage | null>(null);
    const [options, setOptions] = useState<TraceOptions>({ threshold: 160, noise: 4, smoothness: 1 });
    const [svg, setSvg] = useState("");
    const [preview, setPreview] = useState("");
    const [busy, setBusy] = useState(true);
    const [error, setError] = useState("");
    useEffect(() => {
        let cancelled = false;
        void loadProcessingImage(source.dataUrl, 2048).then(canvas => { if (!cancelled) setPixels(canvasPixels(canvas)); })
            .catch(caught => { if (!cancelled) { setError(caught instanceof Error ? uiText(caught.message) : uiText("图片读取失败")); setBusy(false); } });
        return () => { cancelled = true; };
    }, [source.dataUrl]);
    useEffect(() => {
        if (!pixels) return;
        setBusy(true); setError(""); setSvg("");
        let worker: Worker | undefined;
        const timer = window.setTimeout(() => {
            try {
                worker = new Worker(new URL("./line-trace.worker.ts", import.meta.url), { type: "module" });
                worker.onmessage = (event: MessageEvent<{ svg?: string; error?: string }>) => {
                    setBusy(false); setError(uiText(event.data.error || "")); setSvg(event.data.svg || ""); worker?.terminate();
                };
                worker.onerror = () => { setBusy(false); setError(uiText("矢量描摹进程失败，请降低原图尺寸后重试")); worker?.terminate(); };
                worker.postMessage({ image: pixels, options });
            } catch (caught) { setBusy(false); setError(caught instanceof Error ? uiText(caught.message) : uiText("无法启动矢量描摹")); }
        }, 220);
        return () => { clearTimeout(timer); worker?.terminate(); };
    }, [pixels, options]);
    useEffect(() => {
        if (!svg) { setPreview(""); return; }
        const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })); setPreview(url);
        return () => URL.revokeObjectURL(url);
    }, [svg]);
    return <Modal open modalRender={modal => <div data-usage-board="svg-trace">{modal}</div>} title={uiText("线稿矢量化 · SVG 路径")} width={900} onCancel={onClose}
        footer={<><Button onClick={onClose}>{uiText("关闭")}</Button><Button type="primary" disabled={!svg || !preview || busy} href={preview || undefined} download={`${(source.originalFileName || source.name || "线稿").replace(/\.[^.]+$/, "")}-矢量.svg`}>{uiText("下载 SVG")}</Button></>}>
        <div className="cs-tool-dialog"><p className="cs-help">{uiText("本地黑白描摹，导出可编辑轮廓路径，不嵌入位图。建议先用 AI 生成干净线稿；照片直接描摹可能包含阴影。最长边按 2048 像素处理，不是服装纸样或单线中心线。")}</p>
            <div className="cs-trace-controls"><label>{uiText("黑白阈值 ")}{options.threshold}<Slider min={1} max={254} value={options.threshold} onChange={threshold => setOptions(current => ({ ...current, threshold }))} /></label>
                <label>{uiText("去除小路径 ")}{options.noise}<Slider min={0} max={64} value={options.noise} onChange={noise => setOptions(current => ({ ...current, noise }))} /></label>
                <label>{uiText("路径平滑 ")}{options.smoothness}<Slider min={.1} max={5} step={.1} value={options.smoothness} onChange={smoothness => setOptions(current => ({ ...current, smoothness }))} /></label></div>
            {error && <Alert type="error" title={uiText(error || "")} showIcon />}
            <div className="cs-tool-preview-grid"><figure><figcaption>{uiText("原始位图")}</figcaption><img src={source.dataUrl} alt={uiText("待描摹线稿")} /></figure><figure><figcaption>{busy ? uiText("正在描摹…") : uiText("矢量预览 · {value1} 条路径", { value1: svg.match(/<path\b/g)?.length || 0 })}</figcaption>{preview ? <img src={preview} alt={uiText("SVG 矢量预览")} /> : <p className="cs-help">{busy ? uiText("在独立进程中处理，不调用模型") : uiText("调整参数后查看路径")}</p>}</figure></div>
        </div>
    </Modal>;
}
