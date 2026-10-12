import { useEffect, useMemo, useRef, useState, type PointerEvent, type SyntheticEvent } from "react";
import { canvasThemes } from "@/lib/canvas-theme";
import { clampInlineComparePercent, inlineComparePercentFromClientX, inlineCompareSources } from "@/lib/canvas/canvas-inline-compare";
import { resolveImageUrl } from "@/services/image-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

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
export function CanvasInlineImageCompare({ node, scale, showImageInfo, onAdvanced }: { node: CanvasNodeData; scale: number; showImageInfo: boolean; onAdvanced: () => void }) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const { sources, automatic } = useMemo(() => inlineCompareSources(node), [node]);
    const [chosen, setChosen] = useState({ key: "", value: "" });
    const [percent, setPercent] = useState(100);
    const [loaded, setLoaded] = useState<LoadedPair | null>(null);
    const [failedKey, setFailedKey] = useState("");
    const box = useRef<HTMLDivElement>(null);
    const dragging = useRef<number | null>(null);
    const sourceSetKey = JSON.stringify([node.id, sources]);
    const selection = automatic ? "0" : chosen.key === sourceSetKey ? chosen.value : "";
    const source = selection === "" ? undefined : sources[Number(selection)];
    const pairKey = JSON.stringify([node.id, source?.storageKey, source?.content, node.metadata?.storageKey, node.metadata?.content]);
    const ready = loaded?.key === pairKey ? loaded : null;
    const unit = 1 / Math.max(0.05, scale);

    useEffect(() => {
        let cancelled = false;
        setPercent(100);
        setFailedKey("");
        if (!source) return;
        Promise.all([loadImage(source.storageKey, source.content), loadImage(node.metadata?.storageKey, node.metadata?.content || "")])
            .then(([before, after]) => { if (!cancelled) setLoaded({ key: pairKey, before, after }); })
            .catch(() => { if (!cancelled) setFailedKey(pairKey); });
        return () => { cancelled = true; };
    }, [pairKey]);

    if (node.type !== CanvasNodeType.Image || node.metadata?.status === "loading" || node.metadata?.status === "error" || !(node.metadata?.content || node.metadata?.storageKey) || !sources.length) return null;
    const changeFromPointer = (event: PointerEvent) => {
        if (box.current) setPercent(inlineComparePercentFromClientX(event.clientX, box.current.getBoundingClientRect()));
    };
    const differentSize = ready && (ready.before.naturalWidth !== ready.after.naturalWidth || ready.before.naturalHeight !== ready.after.naturalHeight);
    const notice = failedKey === pairKey ? "原图无法加载，请重新选择参考图" : source && !ready ? "正在加载原图…" : differentSize ? "尺寸不同 · 等比查看，非像素对齐" : "";
    return <div className="pointer-events-none absolute" data-inline-image-compare={node.id} style={{ left: node.position.x, top: node.position.y, width: node.width, height: node.height, zIndex: 60 }}>
        <div ref={box} className="absolute inset-0">
            {ready && percent < 100 ? <>
                <div className="absolute inset-0" style={{ background: theme.canvas.background }}><img className="h-full w-full object-contain" src={ready.before.src} alt="对比原图" draggable={false} /></div>
                <div className="absolute inset-0" style={{ background: theme.canvas.background, clipPath: `inset(0 ${100 - percent}% 0 0)` }}><img className={`h-full w-full ${node.metadata?.freeResize ? "object-fill" : "object-contain"}`} src={ready.after.src} alt="修改后" draggable={false} /></div>
            </> : null}
            {ready && percent > 0 && percent < 100 ? <div data-canvas-no-zoom className="pointer-events-auto absolute top-0 bottom-0 cursor-ew-resize touch-none" role="slider" tabIndex={0} aria-label="图片内对比分割线" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-valuetext={`${Math.round(percent)}% 修改后`} style={{ left: `${percent}%`, width: 20 * unit, transform: "translateX(-50%)" }}
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
            {!automatic ? <select aria-label="选择对比原图" value={selection} onChange={event => setChosen({ key: sourceSetKey, value: event.target.value })} style={{ width: "100%", padding: 3 * unit, background: theme.node.panel, color: theme.node.text, fontSize: "inherit" }}>
                <option value="">{sources.length > 1 ? "选择一张参考图进行对比" : "确认使用这张参考图对比"}</option>
                {sources.map((item, index) => <option key={index} value={String(index)}>{item.label || `参考图 ${index + 1}`}</option>)}
            </select> : null}
            <div className="flex items-center" style={{ gap: 8 * unit }}>
                <span className="shrink-0">原图</span>
                <input type="range" aria-label="原图与修改后对比" min={0} max={100} step={1} value={percent} disabled={!ready} onChange={event => setPercent(Number(event.target.value))} className="min-w-0 flex-1 cursor-ew-resize touch-none" style={{ height: 24 * unit, accentColor: theme.canvas.selectionStroke }} />
                <span className="shrink-0">修改后</span>
                <button type="button" onClick={onAdvanced} className="shrink-0 hover:underline" title="打开差异图、并排和导出工具" style={{ fontSize: "inherit", color: theme.node.muted }}>更多</button>
            </div>
            {notice ? <span role="status" className="text-center" style={{ fontSize: 10 * unit }}>{notice}</span> : null}
        </div>
    </div>;
}
