import { useUiText } from "@/lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Modal, Popover, Progress, Segmented, Slider, Spin } from "antd";
import { saveAs } from "file-saver";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasCompareCandidates, canvasCompareImages, canvasCompareSameImage, canvasCompareSources, canvasComparePreviewScale, canvasDifferenceLayout, canvasDifferenceNotice, chooseCanvasComparePair, drawCanvasCompare, drawCanvasDifference, loadCanvasCompareImage, type CanvasCompareMode, type CanvasCompareZoom } from "@/lib/canvas/canvas-image-compare";
import { encodeCanvasComparePng } from "@/lib/canvas/canvas-image-encoding";
import type { CanvasImageProgress } from "@/lib/canvas/canvas-image-worker";
import type { CanvasNodeData } from "@/types/canvas";
import { CanvasCompareThumbnail, CanvasImageComparePicker, canvasCompareImageLabel } from "./canvas-image-compare-picker";

type LoadedPair = { before: HTMLImageElement; after: HTMLImageElement };

export function CanvasImageCompareDialog({ nodes, initialIds, onClose, comparisonBasis = "direct" }: { nodes: CanvasNodeData[]; initialIds: string[]; onClose: () => void; comparisonBasis?: "direct" | "original" }) {
    const t = useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const { message } = App.useApp();
    const [pair, setPair] = useState<readonly [CanvasNodeData | undefined, CanvasNodeData | undefined]>(() => {
        const ids = chooseCanvasComparePair(nodes, initialIds), images = canvasCompareCandidates(nodes);
        return [images.find(image => image.id === ids[0]), images.find(image => image.id === ids[1])];
    });
    const [picker, setPicker] = useState<0 | 1 | null>(null);
    const [mode, setMode] = useState<CanvasCompareMode>("slider");
    const [value, setValue] = useState(50);
    const [zoom, setZoom] = useState<CanvasCompareZoom>("fit");
    const [loaded, setLoaded] = useState<LoadedPair | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [renderError, setRenderError] = useState("");
    const [reload, setReload] = useState(0);
    const [exporting, setExporting] = useState(false);
    const [progress, setProgress] = useState<CanvasImageProgress | null>(null);
    const renderJob = useRef<AbortController | null>(null);
    const exportJob = useRef<AbortController | null>(null);
    const [rendered, setRendered] = useState<{ source: LoadedPair; mode: CanvasCompareMode; value: number; background: string; foreground: string; width: number; height: number; notice: string } | null>(null);
    const [stageSize, setStageSize] = useState({ width: 900, height: 480 });
    const canvas = useRef<HTMLCanvasElement>(null);
    const stage = useRef<HTMLDivElement>(null);
    const pickerTriggers = useRef<Array<HTMLButtonElement | null>>([]);
    const images = useMemo(() => canvasCompareCandidates(nodes), [nodes]);
    const resolveSelection = (selected: CanvasNodeData | undefined) => selected ? images.find(node => node.id === selected.id && canvasCompareSameImage(node, selected)) || images.find(node => canvasCompareSameImage(node, selected)) || selected : undefined;
    const before = resolveSelection(pair[0]), after = resolveSelection(pair[1]);
    const lineage = useMemo(() => after ? canvasCompareSources(nodes, after) : { images: [], automatic: false }, [nodes, after]);
    const previousId = lineage.automatic ? lineage.images[0]?.id : undefined;
    const closePicker = () => { if (picker !== null) pickerTriggers.current[picker]?.focus(); setPicker(null); };
    const chooseImage = (index: 0 | 1, image: CanvasNodeData) => {
        if (pair[index] && canvasCompareSameImage(image, pair[index])) { closePicker(); return; }
        const snapshot = { ...image, metadata: { ...image.metadata } };
        if (index === 0) setPair(current => [snapshot, current[1]]);
        else { const previous = canvasCompareSources(nodes, snapshot); setPair([previous.automatic ? previous.images[0] : undefined, snapshot]); }
        closePicker();
    };
    useEffect(() => {
        const controller = new AbortController();
        setLoaded(null); setLoadError(""); setRenderError(""); setLoading(false); setZoom("fit");
        if (stage.current) { stage.current.scrollLeft = 0; stage.current.scrollTop = 0; }
        if (!before || !after || before.id === after.id || canvasCompareSameImage(before, after)) return;
        setLoading(true);
        Promise.all([loadCanvasCompareImage(before, controller.signal), loadCanvasCompareImage(after, controller.signal)]).then(([beforeImage, afterImage]) => { if (!controller.signal.aborted) setLoaded({ before: beforeImage, after: afterImage }); }).catch(error => { if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "图片加载失败"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => { controller.abort(); renderJob.current?.abort(); exportJob.current?.abort(); };
    }, [before, after, reload]);
    useEffect(() => {
        const controller = new AbortController();
        renderJob.current = controller;
        exportJob.current?.abort(); exportJob.current = null; setExporting(false);
        setRendered(null); setRenderError(""); setProgress(null);
        if (!loaded || !canvas.current) return;
        const frame = requestAnimationFrame(async () => {
            const target = canvas.current;
            if (!target) return;
            try {
                if (mode === "difference") await drawCanvasDifference(target, loaded.before, loaded.after, { signal: controller.signal, onProgress: update => { if (!controller.signal.aborted) setProgress(update); } });
                else drawCanvasCompare(target, loaded.before, loaded.after, mode, value, theme.node.fill, theme.node.text);
                if (controller.signal.aborted) return;
                setRendered({ source: loaded, mode, value, background: theme.node.fill, foreground: theme.node.text, width: target.width, height: target.height, notice: mode === "difference" ? canvasDifferenceNotice(canvasDifferenceLayout(loaded.before, loaded.after)) : "展示对比：按原比例居中，不做配准；当前输出经过缩放，非原像素一致性检验。" });
            } catch (error) { if (!controller.signal.aborted) setRenderError(error instanceof Error && error.name === "SecurityError" ? "该图片来源不允许读取像素，请下载原图并重新上传后再试" : error instanceof Error ? error.message : "合成失败，请重试"); }
            finally { if (!controller.signal.aborted) { setProgress(current => current?.fallback ? { ...current, percent: 100, label: "已使用分段兼容模式完成（最多 100 万像素）" } : null); renderJob.current = null; } }
        });
        return () => { cancelAnimationFrame(frame); controller.abort(); exportJob.current?.abort(); };
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
    const close = () => { renderJob.current?.abort(); exportJob.current?.abort(); onClose(); };
    const cancel = () => {
        if (exporting) { exportJob.current?.abort(); exportJob.current = null; setExporting(false); }
        else { renderJob.current?.abort(); renderJob.current = null; setRenderError("差异计算已取消，可重新加载或换图"); }
        setProgress(null);
    };
    const exportImage = async () => {
        if (!canvas.current || !ready || exporting) return;
        const controller = new AbortController(); exportJob.current = controller;
        setExporting(true);
        try {
            const blob = await encodeCanvasComparePng(canvas.current, { signal: controller.signal, onProgress: update => { if (!controller.signal.aborted) setProgress(update); } });
            if (!controller.signal.aborted) saveAs(blob, `改款前后对比-${mode}.png`);
        } catch (error) { if (!controller.signal.aborted) message.error(error instanceof Error ? error.message : t("导出失败，请重试")); }
        finally { if (exportJob.current === controller) { exportJob.current = null; setExporting(false); setProgress(null); } }
    };
    return <Modal open title={t("改款前后对比")} width={1000} onCancel={close} footer={<Button onClick={() => void exportImage()} disabled={!ready} loading={exporting}>{t("导出当前对比 PNG")}</Button>}>
        <p className="mb-3 text-sm opacity-70">{t(comparisonBasis === "original" ? "与该图片已记录的原图比较；有多张原图时请手动选择。不改原图、不调用 AI，也不是自动质检。" : "默认与本次修改前的直接上版比较，点击图片卡可换选其他图。不改原图、不调用 AI；不做配准，也不是自动质检。")}</p>
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {([0, 1] as const).map(index => {
                const selected = index === 0 ? before : after, opposite = index === 0 ? after : before;
                const candidates = [...(index === 0 ? lineage.images : []), ...(selected ? [selected] : []), ...canvasCompareImages(nodes)].filter((node, position, all) => (!opposite || node.id !== opposite.id && !canvasCompareSameImage(node, opposite)) && !all.slice(0, position).some(previous => canvasCompareSameImage(previous, node)));
                const label = t(index === 0 ? "选择改款前图片" : "选择改款后图片");
                return <Popover key={index} trigger="click" placement="bottom" open={picker === index} onOpenChange={open => setPicker(open ? index : null)} destroyOnHidden getPopupContainer={() => document.body}
                    styles={{ container: { padding: 16, background: theme.node.panel, maxHeight: "calc(100dvh - 24px)", overflowY: "auto" }, root: { maxWidth: "calc(100vw - 24px)" } }}
                    content={<div style={{ width: "min(600px, calc(100vw - 56px))" }}><CanvasImageComparePicker images={candidates} selectedId={selected?.id} sourceIds={index === 0 ? lineage.images.map(node => node.id) : []} preferredId={index === 0 ? previousId : undefined} title={label} onChoose={node => chooseImage(index, node)} onClose={closePicker} /></div>}>
                    <button ref={element => { pickerTriggers.current[index] = element; }} type="button" aria-label={label} aria-expanded={picker === index} aria-haspopup="dialog" className="flex min-w-0 items-center gap-3 rounded-lg border p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2" style={{ borderColor: theme.node.stroke, background: theme.node.panel, color: theme.node.text, outlineColor: theme.canvas.selectionStroke }}>
                        <span className="block h-24 w-32 shrink-0 overflow-hidden rounded-md" style={{ background: theme.node.fill }}>{selected ? <CanvasCompareThumbnail node={selected} /> : <span className="flex h-full items-center justify-center text-xs" style={{ color: theme.node.muted }}>{t("点击选图")}</span>}</span>
                        <span className="min-w-0 flex-1"><span className="mb-1 block text-xs" style={{ color: theme.node.muted }}>{index === 0 ? t("改款前") : t("改款后")}{index === 0 && previousId === selected?.id ? t(" · 直接上版") : ""}</span><span className="line-clamp-2 block break-all text-sm leading-5" title={selected ? canvasCompareImageLabel(selected) : undefined}>{selected ? canvasCompareImageLabel(selected) : t("尚未选择图片")}</span><span className="mt-2 block text-xs" style={{ color: theme.node.muted }}>{selected?.metadata?.imageVersion ? `V${selected.metadata.imageVersion} · ` : ""}{t("查看大缩略图并换选 ▾")}</span></span>
                    </button>
                </Popover>;
            })}
        </div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: theme.node.muted }}>
            <span>{comparisonBasis === "original" ? t(before ? "正在与所选原图比较。" : "存在多张原图，请选择需要比较的一张。") : !after ? t("先选择改款后图片，再选择需要比较的原图。") : previousId ? before?.id === previousId ? t("已默认选中本次修改前的直接上版。") : t("已选择其他图片；可恢复本次修改前的直接上版。") : lineage.images.length ? t("存在多个或未确认的输入来源，请手动确认原图。") : t("未记录修改前图片，不会按同名或版本号猜选，请手动选择。")}</span>
            <span className="flex items-center gap-2">{previousId && before?.id !== previousId ? <Button size="small" onClick={() => setPair(current => [lineage.images[0], current[1]])}>{t("恢复直接上版")}</Button> : null}<Button size="small" onClick={() => setPair(([a, b]) => [b, a])}>{t("交换前后")}</Button></span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented aria-label={t("对比模式")} value={mode} onChange={value => setMode(value as CanvasCompareMode)} options={[{ label: t("滑块"), value: "slider" }, { label: t("并排"), value: "side" }, { label: t("叠加"), value: "overlay" }, { label: t("差异图"), value: "difference" }]} />
            <Segmented aria-label={t("预览倍率")} value={String(zoom)} onChange={value => setZoom(value === "fit" ? "fit" : Number(value) as CanvasCompareZoom)} options={[{ label: t("适应"), value: "fit" }, { label: "1×", value: "1" }, { label: "2×", value: "2" }, { label: "4×", value: "4" }]} />
        </div>
        {mode === "slider" || mode === "overlay" ? <div className="mt-2 flex items-center gap-3"><span className="shrink-0 text-xs">{mode === "slider" ? t("分割位置") : t("改款后透明度")}</span><Slider className="min-w-0 flex-1" value={value} onChange={setValue} tooltip={{ formatter: value => `${value}%` }} aria-label={mode === "slider" ? t("分割位置") : t("改款后透明度")} /></div> : null}
        {ready ? <p className="mt-3 text-xs leading-relaxed" role="status" style={{ color: theme.node.muted }}>{rendered?.notice}</p> : null}
        {progress ? <div aria-live="polite" className="mt-2"><Progress percent={progress.percent} size="small" /><span className="text-xs">{progress.label}</span>{progress.percent < 100 ? <Button type="text" size="small" onClick={cancel}>{t("取消处理")}</Button> : null}</div> : null}
        <div ref={stage} tabIndex={0} role="region" aria-label={t("对比预览，可用方向键或触摸滚动")} className="mt-3 h-[min(52dvh,560px)] min-h-48 overflow-auto overscroll-contain rounded-lg" style={{ background: theme.node.fill, color: theme.node.text }}>
            <div className="flex min-h-full w-max min-w-full items-center justify-center">
                {loading || (loaded && !error && !ready) ? <Spin /> : error ? <div className="max-w-72 p-5 text-center"><p role="alert" className="mb-3 break-words text-sm">{error}</p><Button onClick={() => setReload(value => value + 1)}>{t("重新加载")}</Button></div> : !loaded ? <p className="max-w-72 p-6 text-sm opacity-70">{t("请选择两张不同的图片；没有可靠的修改前记录时，请通过上方缩略图面板手动选图。")}</p> : null}
                <canvas ref={canvas} aria-label={t("改款前后对比预览")} style={{ display: ready ? "block" : "none", width: (rendered?.width || 1) * scale, height: (rendered?.height || 1) * scale, maxWidth: "none", flex: "none", imageRendering: zoom === "fit" ? "auto" : "pixelated" }} />
            </div>
        </div>
        {ready && loaded ? <p className="mt-2 text-xs" style={{ color: theme.node.muted }}>{t("原图")}{loaded.before.naturalWidth}×{loaded.before.naturalHeight} / {loaded.after.naturalWidth}×{loaded.after.naturalHeight} {t(" · 输出")}{rendered?.width}×{rendered?.height} PNG{mode === "difference" ? t("（无标题栏）") : t(" 展示图")} · {zoom === "fit" ? t("适应 {value1}%", { value1: Math.round(scale * 100) }) : `${zoom}×`}</p> : null}
        {mode === "difference" ? <p className="mt-2 text-xs leading-relaxed" style={{ color: theme.node.muted }}>{t("黑色为无可见差异，越亮差异越大。取预乘 RGB 与透明度差的最大值，忽略完全透明像素内隐藏颜色。差异处理限制 400 万像素 / 单边 4096；浏览器仍需解码原图。")}</p> : null}
        <p className="mt-2 text-xs leading-relaxed" style={{ color: theme.node.muted }}>{t("1× 为输出图 1 像素占 1 CSS 像素；2× / 4× 不增加原图细节。放大后滚动检查局部；倍率不改变导出尺寸。")}</p>
    </Modal>;
}
