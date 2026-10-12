import { useEffect, useRef, useState } from "react";
import { App, Button, Modal, Segmented, Select, Slider, Spin } from "antd";
import { saveAs } from "file-saver";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasCompareImages, canvasComparePreviewScale, canvasDifferenceLayout, canvasDifferenceNotice, chooseCanvasComparePair, drawCanvasCompare, loadCanvasCompareImage, type CanvasCompareMode, type CanvasCompareZoom } from "@/lib/canvas/canvas-image-compare";
import type { CanvasNodeData } from "@/types/canvas";

type LoadedPair = { before: HTMLImageElement; after: HTMLImageElement };

export function CanvasImageCompareDialog({ nodes, initialIds, onClose }: { nodes: CanvasNodeData[]; initialIds: string[]; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const { message } = App.useApp();
    const [pair, setPair] = useState<readonly [string, string]>(() => chooseCanvasComparePair(nodes, initialIds));
    const [mode, setMode] = useState<CanvasCompareMode>("slider");
    const [value, setValue] = useState(50);
    const [zoom, setZoom] = useState<CanvasCompareZoom>("fit");
    const [loaded, setLoaded] = useState<LoadedPair | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [renderError, setRenderError] = useState("");
    const [reload, setReload] = useState(0);
    const [exporting, setExporting] = useState(false);
    const [rendered, setRendered] = useState<{ source: LoadedPair; mode: CanvasCompareMode; value: number; background: string; foreground: string; width: number; height: number; notice: string } | null>(null);
    const [stageSize, setStageSize] = useState({ width: 900, height: 480 });
    const canvas = useRef<HTMLCanvasElement>(null);
    const stage = useRef<HTMLDivElement>(null);
    const images = canvasCompareImages(nodes);
    const before = images.find(node => node.id === pair[0]), after = images.find(node => node.id === pair[1]);
    useEffect(() => {
        let cancelled = false;
        setLoaded(null); setLoadError(""); setRenderError(""); setLoading(false); setZoom("fit");
        if (stage.current) { stage.current.scrollLeft = 0; stage.current.scrollTop = 0; }
        if (!before || !after || before.id === after.id) return;
        setLoading(true);
        Promise.all([loadCanvasCompareImage(before), loadCanvasCompareImage(after)]).then(([beforeImage, afterImage]) => { if (!cancelled) setLoaded({ before: beforeImage, after: afterImage }); }).catch(error => { if (!cancelled) setLoadError(error instanceof Error ? error.message : "图片加载失败"); }).finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [before, after, reload]);
    useEffect(() => {
        setRendered(null); setRenderError("");
        if (!loaded || !canvas.current) return;
        const frame = requestAnimationFrame(() => {
            const target = canvas.current;
            if (!target) return;
            try {
                drawCanvasCompare(target, loaded.before, loaded.after, mode, value, theme.node.fill, theme.node.text);
                setRendered({ source: loaded, mode, value, background: theme.node.fill, foreground: theme.node.text, width: target.width, height: target.height, notice: mode === "difference" ? canvasDifferenceNotice(canvasDifferenceLayout(loaded.before, loaded.after)) : "展示对比：按原比例居中，不做配准；当前输出经过缩放，非原像素一致性检验。" });
            } catch (error) { setRenderError(error instanceof Error && error.name === "SecurityError" ? "该图片来源不允许读取像素，请下载原图并重新上传后再试" : error instanceof Error ? error.message : "合成失败，请重试"); }
        });
        return () => cancelAnimationFrame(frame);
    }, [loaded, mode, value, theme]);
    useEffect(() => {
        const target = stage.current;
        if (!target) return;
        const observer = new ResizeObserver(() => setStageSize({ width: target.clientWidth, height: target.clientHeight }));
        observer.observe(target);
        return () => observer.disconnect();
    }, [loaded]);
    const error = loadError || renderError;
    const ready = Boolean(loaded && rendered?.source === loaded && rendered.mode === mode && rendered.value === value && rendered.background === theme.node.fill && rendered.foreground === theme.node.text && !loading && !error);
    const scale = canvasComparePreviewScale(rendered?.width || 1, rendered?.height || 1, stageSize.width - 2, stageSize.height - 2, zoom);
    const exportImage = () => {
        if (!canvas.current || !ready || exporting) return;
        setExporting(true);
        try { canvas.current.toBlob(blob => {
            try { if (blob) saveAs(blob, `改款前后对比-${mode}.png`); else message.error("导出失败，请重试"); }
            catch { message.error("导出失败，请重试"); }
            finally { setExporting(false); }
        }, "image/png"); } catch { setExporting(false); message.error("该图片来源不允许本地合成，请下载原图并重新上传后再试"); }
    };
    return <Modal open title="改款前后对比" width={1000} onCancel={onClose} footer={<Button onClick={exportImage} disabled={!ready} loading={exporting}>导出当前对比 PNG</Button>}>
        <p className="mb-3 text-sm opacity-70">滑块、并排、叠加或差异图对比，可放大检查并导出 PNG。不改原图、不调用 AI，也不是自动质检；不做配准。同名不同版本仅作默认候选，请确认前后图。</p>
        <div className="mb-3 flex flex-wrap items-center gap-3">
            {([0, 1] as const).map(index => <label key={index} className="flex min-w-0 flex-[1_1_260px] items-center gap-2"><span className="shrink-0">{index === 0 ? "改款前" : "改款后"}</span><Select aria-label={index === 0 ? "选择改款前图片" : "选择改款后图片"} className="min-w-0 flex-1" showSearch optionFilterProp="label" placeholder="从当前画布选择图片" value={pair[index] || undefined} options={images.filter(node => node.id !== pair[1 - index]).map(node => ({ value: node.id, label: `${node.metadata?.imageName || node.title} · V${node.metadata?.imageVersion || 1} · ${node.id.slice(-4)}` }))} onChange={id => setPair(current => index === 0 ? [id, current[1]] : [current[0], id])} /></label>)}
            <Button onClick={() => setPair(([a, b]) => [b, a])}>交换前后</Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented aria-label="对比模式" value={mode} onChange={value => setMode(value as CanvasCompareMode)} options={[{ label: "滑块", value: "slider" }, { label: "并排", value: "side" }, { label: "叠加", value: "overlay" }, { label: "差异图", value: "difference" }]} />
            <Segmented aria-label="预览倍率" value={String(zoom)} onChange={value => setZoom(value === "fit" ? "fit" : Number(value) as CanvasCompareZoom)} options={[{ label: "适应", value: "fit" }, { label: "1×", value: "1" }, { label: "2×", value: "2" }, { label: "4×", value: "4" }]} />
        </div>
        {mode === "slider" || mode === "overlay" ? <div className="mt-2 flex items-center gap-3"><span className="shrink-0 text-xs">{mode === "slider" ? "分割位置" : "改款后透明度"}</span><Slider className="min-w-0 flex-1" value={value} onChange={setValue} tooltip={{ formatter: value => `${value}%` }} aria-label={mode === "slider" ? "分割位置" : "改款后透明度"} /></div> : null}
        {ready ? <p className="mt-3 text-xs leading-relaxed" role="status" style={{ color: theme.node.muted }}>{rendered?.notice}</p> : null}
        <div ref={stage} tabIndex={0} role="region" aria-label="对比预览，可用方向键或触摸滚动" className="mt-3 h-[min(52dvh,560px)] min-h-48 overflow-auto overscroll-contain rounded-lg" style={{ background: theme.node.fill, color: theme.node.text }}>
            <div className="flex min-h-full w-max min-w-full items-center justify-center">
                {loading || (loaded && !error && !ready) ? <Spin /> : error ? <div className="max-w-72 p-5 text-center"><p role="alert" className="mb-3 break-words text-sm">{error}</p><Button onClick={() => setReload(value => value + 1)}>重新加载</Button></div> : !loaded ? <p className="max-w-72 p-6 text-sm opacity-70">请选择两张不同的图片；没有同源版本时，可从画布手动选择第二张。</p> : null}
                <canvas ref={canvas} aria-label="改款前后对比预览" style={{ display: ready ? "block" : "none", width: (rendered?.width || 1) * scale, height: (rendered?.height || 1) * scale, maxWidth: "none", flex: "none", imageRendering: zoom === "fit" ? "auto" : "pixelated" }} />
            </div>
        </div>
        {ready && loaded ? <p className="mt-2 text-xs" style={{ color: theme.node.muted }}>原图 {loaded.before.naturalWidth}×{loaded.before.naturalHeight} / {loaded.after.naturalWidth}×{loaded.after.naturalHeight} · 输出 {rendered?.width}×{rendered?.height} PNG{mode === "difference" ? "（无标题栏）" : " 展示图"} · {zoom === "fit" ? `适应 ${Math.round(scale * 100)}%` : `${zoom}×`}</p> : null}
        {mode === "difference" ? <p className="mt-2 text-xs leading-relaxed" style={{ color: theme.node.muted }}>黑色为无可见差异，越亮差异越大。取预乘 RGB 与透明度差的最大值，忽略完全透明像素内隐藏颜色。差异处理限制 400 万像素 / 单边 4096；浏览器仍需解码原图。</p> : null}
        <p className="mt-2 text-xs leading-relaxed" style={{ color: theme.node.muted }}>1× 为输出图 1 像素占 1 CSS 像素；2× / 4× 不增加原图细节。放大后滚动检查局部；倍率不改变导出尺寸。</p>
    </Modal>;
}
