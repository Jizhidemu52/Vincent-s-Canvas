import { useUiText } from "@/lib/i18n";
import { useEffect, useMemo, useRef, useState, type PointerEvent, type SyntheticEvent } from "react";
import { Popover } from "antd";
import { canvasThemes } from "@/lib/canvas-theme";
import { clampInlineComparePercent, inlineComparePercentFromClientX } from "@/lib/canvas/canvas-inline-compare";
import { canvasCompareImages, canvasCompareSameImage, canvasCompareSources } from "@/lib/canvas/canvas-image-compare";
import { resolveImageUrl } from "@/services/image-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { CanvasCompareThumbnail, CanvasImageComparePicker, canvasCompareImageLabel } from "./canvas-image-compare-picker";

const stop = (event: SyntheticEvent) => event.stopPropagation();
type LoadedPair = { key: string; before: HTMLImageElement; after: HTMLImageElement };

async function loadImage(storageKey: string | undefined, content: string) {
    const url = await resolveImageUrl(storageKey, content);
    if (!url) throw new Error("原图不可用");
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片加载失败"));
        image.src = url;
    });
}

/** A preview-only layer in the canvas transform; never writes nodes or image bytes. */
export function CanvasInlineImageCompare({ node, nodes, scale, showImageInfo, onAdvanced }: { node: CanvasNodeData; nodes: CanvasNodeData[]; scale: number; showImageInfo: boolean; onAdvanced: (sourceId?: string) => void }) {
    const t = useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const { images: sources, automatic } = useMemo(() => canvasCompareSources(nodes, node), [nodes, node]);
    const available = useMemo(() => [...sources, ...canvasCompareImages(nodes)].filter((item, index, items) => item.id !== node.id && !canvasCompareSameImage(item, node) && !items.slice(0, index).some(previous => canvasCompareSameImage(previous, item))), [sources, nodes, node]);
    const [chosen, setChosen] = useState<{ key: string; image?: CanvasNodeData }>({ key: "" });
    const [pickerOpen, setPickerOpen] = useState(false);
    const [percent, setPercent] = useState(100);
    const [loaded, setLoaded] = useState<LoadedPair | null>(null);
    const [failedKey, setFailedKey] = useState("");
    const box = useRef<HTMLDivElement>(null);
    const dragging = useRef<number | null>(null);
    const pickerTrigger = useRef<HTMLButtonElement>(null);
    const sourceSetKey = JSON.stringify([node.id, node.metadata?.storageKey, node.metadata?.content, node.metadata?.compareSources ?? node.metadata?.references]);
    const chosenImage = chosen.key === sourceSetKey ? chosen.image : undefined;
    const source = chosenImage ? available.find(item => canvasCompareSameImage(item, chosenImage)) || chosenImage : automatic ? sources[0] : undefined;
    const candidates = source && !available.some(item => canvasCompareSameImage(item, source)) ? [...available, source] : available;
    const pairKey = JSON.stringify([node.id, source?.metadata?.storageKey, source?.metadata?.content, node.metadata?.storageKey, node.metadata?.content]);
    const ready = loaded?.key === pairKey ? loaded : null;
    const unit = 1 / Math.max(0.05, scale);

    useEffect(() => {
        let cancelled = false;
        setPercent(100);
        setFailedKey("");
        if (!source) return;
        Promise.all([loadImage(source.metadata?.storageKey, source.metadata?.content || ""), loadImage(node.metadata?.storageKey, node.metadata?.content || "")])
            .then(([before, after]) => { if (!cancelled) setLoaded({ key: pairKey, before, after }); })
            .catch(() => { if (!cancelled) setFailedKey(pairKey); });
        return () => { cancelled = true; };
    }, [pairKey]);

    if (node.type !== CanvasNodeType.Image || node.metadata?.status === "loading" || node.metadata?.status === "error" || !(node.metadata?.content || node.metadata?.storageKey)) return null;
    const changeFromPointer = (event: PointerEvent) => {
        if (box.current) setPercent(inlineComparePercentFromClientX(event.clientX, box.current.getBoundingClientRect()));
    };
    const differentSize = ready && (ready.before.naturalWidth !== ready.after.naturalWidth || ready.before.naturalHeight !== ready.after.naturalHeight);
    const notice = failedKey === pairKey ? "原图无法加载，请重新选择参考图" : source && !ready ? "正在加载原图…" : differentSize ? "尺寸不同 · 等比查看，非像素对齐" : "";
    const closePicker = () => { setPickerOpen(false); pickerTrigger.current?.focus(); };
    return <div className="pointer-events-none absolute" data-inline-image-compare={node.id} style={{ left: node.position.x, top: node.position.y, width: node.width, height: node.height, zIndex: 60 }}>
        <div ref={box} className="absolute inset-0">
            {ready && percent < 100 ? <>
                <div className="absolute inset-0" style={{ background: theme.canvas.background }}><img className="h-full w-full object-contain" src={ready.before.src} alt={t("对比原图")} draggable={false} /></div>
                <div className="absolute inset-0" style={{ background: theme.canvas.background, clipPath: `inset(0 ${100 - percent}% 0 0)` }}><img className={`h-full w-full ${node.metadata?.freeResize ? "object-fill" : "object-contain"}`} src={ready.after.src} alt={t("修改后")} draggable={false} /></div>
            </> : null}
            {ready && percent > 0 && percent < 100 ? <div data-canvas-no-zoom className="pointer-events-auto absolute top-0 bottom-0 cursor-ew-resize touch-none" role="slider" tabIndex={0} aria-label={t("图片内对比分割线")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-valuetext={t("{value1}% 修改后", { value1: Math.round(percent) })} style={{ left: `${percent}%`, width: 20 * unit, transform: "translateX(-50%)" }}
                onPointerDown={event => { stop(event); if (event.button !== 0) return; event.preventDefault(); dragging.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); changeFromPointer(event); }}
                onPointerMove={event => { stop(event); if (dragging.current === event.pointerId) changeFromPointer(event); }}
                onPointerUp={event => { stop(event); dragging.current = null; }} onPointerCancel={() => { dragging.current = null; }} onLostPointerCapture={() => { dragging.current = null; }}
                onMouseDown={stop} onClick={stop} onDoubleClick={stop} onContextMenu={stop}
                onKeyDown={event => { stop(event); const values: Record<string, number> = { ArrowLeft: percent - 1, ArrowDown: percent - 1, ArrowRight: percent + 1, ArrowUp: percent + 1, Home: 0, End: 100 }; if (event.key in values) { event.preventDefault(); setPercent(clampInlineComparePercent(values[event.key])); } }}>
                <span className="absolute top-0 bottom-0 left-1/2" style={{ width: unit, background: theme.canvas.selectionStroke }} />
                <span className="absolute left-1/2 top-1/2 flex items-center justify-center rounded-full" style={{ transform: "translate(-50%, -50%)", width: 24 * unit, height: 24 * unit, fontSize: 14 * unit, background: theme.node.panel, color: theme.node.text, border: `${unit}px solid ${theme.canvas.selectionStroke}` }}>↔</span>
            </div> : null}
        </div>
        <div data-canvas-no-zoom className="pointer-events-auto absolute flex flex-col" style={{ top: "100%", left: "50%", transform: "translateX(-50%)", width: Math.max(node.width, 248 * unit), marginTop: (showImageInfo ? 30 : 10) * unit, padding: `${5 * unit}px ${8 * unit}px`, gap: 4 * unit, fontSize: 11 * unit, color: theme.node.label, background: theme.canvas.background }} onPointerDown={stop} onMouseDown={stop} onKeyDown={stop} onClick={stop} onDoubleClick={stop} onContextMenu={stop}>
            <Popover trigger="click" placement="bottom" open={pickerOpen} onOpenChange={setPickerOpen} destroyOnHidden getPopupContainer={() => document.body}
                styles={{ container: { padding: 16, background: theme.node.panel, maxHeight: "calc(100dvh - 24px)", overflowY: "auto" }, root: { maxWidth: "calc(100vw - 24px)" } }}
                content={<div style={{ width: "min(600px, calc(100vw - 56px))" }}><CanvasImageComparePicker images={candidates} sourceIds={sources.map(item => item.id)} preferredId={automatic ? sources[0]?.id : undefined} selectedId={source?.id} onChoose={item => { setChosen({ key: sourceSetKey, image: { ...item, metadata: { ...item.metadata } } }); closePicker(); }} onClose={closePicker} /></div>}>
                <button ref={pickerTrigger} type="button" aria-label={t("选择对比原图")} aria-expanded={pickerOpen} aria-haspopup="dialog" className="flex w-full items-center text-left focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ gap: 8 * unit, padding: 6 * unit, borderRadius: 6 * unit, background: theme.node.panel, color: theme.node.text, outlineColor: theme.canvas.selectionStroke }}>
                    {source ? <span className="block shrink-0" style={{ width: 64 * unit, height: 48 * unit }}><CanvasCompareThumbnail node={source} /></span> : null}
                    <span className="min-w-0 flex-1"><span className="block" style={{ fontSize: 12 * unit }}>{automatic && source?.id === sources[0]?.id ? t("修改前 · 直接上版") : source ? t("当前对比原图") : t("选择对比原图")}</span><span className="mt-0.5 block truncate" title={source ? canvasCompareImageLabel(source) : undefined} style={{ color: theme.node.muted }}>{source ? canvasCompareImageLabel(source) : sources.length ? t("多个或未确认来源，请先选择") : t("未记录修改前图片，可手动选择")}</span></span>
                    <span className="shrink-0" style={{ color: theme.node.muted }}>{t("换图 ▾")}</span>
                </button>
            </Popover>
            <div className="flex items-center" style={{ gap: 8 * unit }}>
                <span className="shrink-0">{t("原图")}</span>
                <input type="range" aria-label={t("原图与修改后对比")} min={0} max={100} step={1} value={percent} disabled={!ready} onChange={event => setPercent(Number(event.target.value))} className="min-w-0 flex-1 cursor-ew-resize touch-none" style={{ height: 24 * unit, accentColor: theme.canvas.selectionStroke }} />
                <span className="shrink-0">{t("修改后")}</span>
                <button type="button" onClick={() => onAdvanced(source?.id)} className="shrink-0 hover:underline" title={t("打开差异图、并排和导出工具")} style={{ fontSize: "inherit", color: theme.node.muted }}>{t("更多")}</button>
            </div>
            {notice ? <span role="status" className="text-center" style={{ fontSize: 10 * unit }}>{t(notice)}</span> : null}
        </div>
    </div>;
}
