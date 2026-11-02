import { useEffect, useRef, useState } from "react";
import { Button, Modal, Spin } from "antd";
import { ChevronLeft, ChevronRight, Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { formatBytes } from "@/lib/image-utils";
import { useUiText } from "@/lib/i18n";
import { resolveImageUrl } from "@/services/image-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function CanvasImageViewerDialog({ node, nodes, onSelect, onClose }: { node: CanvasNodeData; nodes: CanvasNodeData[]; onSelect: (id: string) => void; onClose: () => void }) {
    const t = useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [source, setSource] = useState("");
    const [size, setSize] = useState<{ width: number; height: number } | null>(null);
    const [error, setError] = useState("");
    const [zoom, setZoom] = useState<number | "fit">("fit");
    const [viewport, setViewport] = useState({ width: 1000, height: 600 });
    const stage = useRef<HTMLDivElement>(null);
    const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
    const images = nodes.filter(item => item.type === CanvasNodeType.Image && (item.metadata?.content || item.metadata?.storageKey));
    const index = images.findIndex(item => item.id === node.id);
    const scale = zoom === "fit" ? size ? Math.min(1, (viewport.width - 32) / size.width, (viewport.height - 32) / size.height) : 1 : zoom;
    const changeZoom = useRef<(value: number, x?: number, y?: number) => void>(() => {});
    changeZoom.current = (value, x = viewport.width / 2, y = viewport.height / 2) => {
        const next = Math.max(.05, Math.min(16, value));
        const box = stage.current;
        const left = box?.scrollLeft || 0, top = box?.scrollTop || 0;
        setZoom(next);
        requestAnimationFrame(() => { if (box) { box.scrollLeft = (left + x) * next / scale - x; box.scrollTop = (top + y) * next / scale - y; } });
    };
    const move = (delta: number) => { const next = images[index + delta]; if (next) onSelect(next.id); };
    useEffect(() => {
        let active = true;
        setSource(""); setSize(null); setError(""); setZoom("fit");
        void resolveImageUrl(node.metadata?.storageKey, node.metadata?.content || "").then(url => { if (active) { if (url) setSource(url); else setError("原图不存在"); } }).catch(error => { if (active) setError(error instanceof Error ? error.message : "原图加载失败"); });
        return () => { active = false; };
    }, [node.id, node.metadata?.storageKey, node.metadata?.content]);
    useEffect(() => {
        const box = stage.current;
        if (!box) return;
        const observer = new ResizeObserver(() => setViewport({ width: box.clientWidth, height: box.clientHeight }));
        observer.observe(box);
        const wheel = (event: WheelEvent) => {
            event.preventDefault(); event.stopPropagation();
            const bounds = box.getBoundingClientRect();
            changeZoom.current((Number(box.dataset.scale) || 1) * Math.exp(-event.deltaY * .002), event.clientX - bounds.left, event.clientY - bounds.top);
        };
        box.addEventListener("wheel", wheel, { passive: false });
        return () => { observer.disconnect(); box.removeEventListener("wheel", wheel); };
    }, [source]);
    return <Modal open centered title={node.title || t("图片详情")} width={1200} footer={null} onCancel={onClose} styles={{ body: { padding: 0 } }}>
        <div data-canvas-shortcuts="ignore" onKeyDown={event => {
            if ((event.target as Element).closest("input,textarea,[contenteditable=true]")) return;
            if (["ArrowLeft", "ArrowRight", "+", "=", "-", "0", "1"].includes(event.key)) {
                event.preventDefault(); event.stopPropagation();
                if (event.key === "ArrowLeft") move(-1); else if (event.key === "ArrowRight") move(1); else if (event.key === "0") setZoom("fit"); else if (event.key === "1") setZoom(1); else changeZoom.current(scale * (event.key === "-" ? .8 : 1.25));
            }
        }}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span style={{ color: theme.node.muted }}>{size ? `${size.width} × ${size.height}px` : t("读取原图中")}{node.metadata?.bytes ? ` · ${formatBytes(node.metadata.bytes)}` : t(" · 文件大小未记录")} · {index + 1}/{images.length}</span>
                <div className="flex items-center gap-1"><Button aria-label={t("上一张图片")} disabled={index <= 0} icon={<ChevronLeft className="size-4" />} onClick={() => move(-1)} /><Button aria-label={t("下一张图片")} disabled={index < 0 || index >= images.length - 1} icon={<ChevronRight className="size-4" />} onClick={() => move(1)} /><Button aria-label={t("缩小大图")} icon={<ZoomOut className="size-4" />} onClick={() => changeZoom.current(scale / 1.25)} /><span className="w-12 text-center tabular-nums">{Math.round(scale * 100)}%</span><Button aria-label={t("放大大图")} icon={<ZoomIn className="size-4" />} onClick={() => changeZoom.current(scale * 1.25)} /><Button onClick={() => setZoom(1)}>100%</Button><Button icon={<Maximize className="size-4" />} onClick={() => setZoom("fit")}>{t("适应")}</Button></div>
            </div>
            <div ref={stage} data-scale={scale} tabIndex={0} aria-label={t("原图查看，可滚轮缩放、拖动和左右键换图")} className="h-[min(70dvh,800px)] min-h-52 overflow-auto overscroll-contain rounded-lg outline-none" style={{ background: theme.canvas.background, touchAction: "none", cursor: "grab" }} onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }; }} onPointerMove={event => { const current = drag.current; if (current?.pointerId === event.pointerId) { event.currentTarget.scrollLeft = current.left + current.x - event.clientX; event.currentTarget.scrollTop = current.top + current.y - event.clientY; } }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
                <div className="grid place-items-center" style={{ width: size ? Math.max(viewport.width, size.width * scale + 32) : "100%", height: size ? Math.max(viewport.height, size.height * scale + 32) : "100%" }}>
                    {error ? <p role="alert" style={{ color: theme.node.text }}>{error}</p> : source ? <img src={source} alt={node.title || t("原图")} draggable={false} className="max-w-none" style={{ width: size ? size.width * scale : undefined, height: size ? size.height * scale : undefined, visibility: size ? "visible" : "hidden" }} onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setError("原图加载失败，请重新添加原图")} /> : <Spin />}
                </div>
            </div>
            <p className="mb-0 mt-2 text-xs" style={{ color: theme.node.muted }}>{t("滚轮缩放 · 拖动查看局部 · 100% 为 1 图像像素对应 1 屏幕像素 · 左右键换图")}</p>
        </div>
    </Modal>;
}
