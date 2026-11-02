import { memo, useEffect, useRef, type PointerEvent } from "react";
import type { CanvasNodeData, Position } from "@/types/canvas";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasResizePreview } from "@/lib/canvas/canvas-resize-preview";
import { resolveCanvasNodeResize, type CanvasResizeHandle } from "@/lib/canvas/canvas-node-resize";
import { canvasSelectionBounds } from "@/lib/canvas/canvas-selection-geometry";
import { canvasArrangeOptions, type CanvasArrangeMode } from "@/lib/canvas/canvas-node-arrange-options";
import { useUiText } from "@/lib/i18n";

export const CanvasMultiSelection = memo(function CanvasMultiSelection({ nodes, scale, theme, hidden, screenToCanvas, onBegin, onPreview, onEnd, onArrange }: {
    nodes: CanvasNodeData[]; scale: number; theme: CanvasTheme; hidden: boolean;
    screenToCanvas: (x: number, y: number) => Position; onBegin: () => void;
    onPreview: (preview: CanvasResizePreview) => void; onEnd: (preview: CanvasResizePreview | null) => void;
    onArrange: (mode: CanvasArrangeMode) => void;
}) {
    const t = useUiText();
    const frame = useRef<HTMLDivElement>(null);
    const cleanup = useRef<(() => void) | null>(null);
    useEffect(() => () => cleanup.current?.(), []);
    const bounds = canvasSelectionBounds(nodes);
    if (!bounds || nodes.length < 2) return null;
    const start = (event: PointerEvent<HTMLButtonElement>, handle: CanvasResizeHandle) => {
        if (event.button !== 0 || nodes.some(node => node.metadata?.locked)) return;
        event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
        const origin = screenToCanvas(event.clientX, event.clientY);
        const original = new Map(nodes.map(node => [node.id, { width: node.width, height: node.height, position: node.position }]));
        let latest: CanvasResizePreview = original, raf = 0;
        onBegin();
        const paint = () => { raf = 0; onPreview(latest); };
        const move = (pointer: globalThis.PointerEvent) => {
            if (pointer.pointerId !== event.pointerId) return;
            if (!pointer.buttons) { finish(true); return; }
            const point = screenToCanvas(pointer.clientX, pointer.clientY);
            const minimumScale = Math.max(...nodes.map(node => Math.max(48 / node.width, 48 / node.height)));
            const resized = resolveCanvasNodeResize({ position: { x: bounds.x, y: bounds.y }, width: bounds.width, height: bounds.height, delta: { x: point.x - origin.x, y: point.y - origin.y }, handle, keepRatio: true, centered: pointer.altKey, minWidth: bounds.width * minimumScale, minHeight: bounds.height * minimumScale });
            const factor = resized.width / bounds.width;
            latest = new Map(nodes.map(node => [node.id, { width: node.width * factor, height: node.height * factor, position: { x: resized.position.x + (node.position.x - bounds.x) * factor, y: resized.position.y + (node.position.y - bounds.y) * factor } }]));
            if (frame.current) Object.assign(frame.current.style, { left: `${resized.position.x}px`, top: `${resized.position.y}px`, width: `${resized.width}px`, height: `${resized.height}px` });
            if (!raf) raf = requestAnimationFrame(paint);
        };
        const finish = (cancelled: boolean) => {
            if (raf) cancelAnimationFrame(raf);
            cleanup.current?.(); cleanup.current = null;
            if (frame.current) Object.assign(frame.current.style, { left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
            onEnd(cancelled ? null : latest);
        };
        const up = (pointer: globalThis.PointerEvent) => { if (pointer.pointerId === event.pointerId) finish(false); };
        const cancel = () => finish(true);
        const key = (keyboard: KeyboardEvent) => { if (keyboard.key === "Escape") { keyboard.preventDefault(); keyboard.stopImmediatePropagation(); cancel(); } };
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", cancel); window.addEventListener("blur", cancel); window.addEventListener("keydown", key, true);
        cleanup.current = () => { if (raf) cancelAnimationFrame(raf); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel); window.removeEventListener("keydown", key, true); };
    };
    return <div ref={frame} data-testid="canvas-multi-selection" className="pointer-events-none absolute z-[70]" style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, border: `${1 / scale}px solid ${theme.canvas.selectionStroke}`, visibility: hidden ? "hidden" : undefined }}>
        <div data-canvas-no-zoom className="pointer-events-auto absolute left-0 bottom-full mb-2 flex origin-bottom-left items-center gap-2 whitespace-nowrap rounded px-2 py-1 text-xs shadow" style={{ transform: `scale(${1 / scale})`, background: theme.toolbar.panel, color: theme.node.text }} onPointerDown={event => event.stopPropagation()}>
            <span>{t("已选 {count} 项", { count: nodes.length })}</span>
            <select aria-label={t("对齐与排列所选节点")} value="" style={{ background: theme.node.panel, color: theme.node.text }} onChange={event => onArrange(event.target.value as CanvasArrangeMode)}>
                <option value="" disabled>{t("对齐 / 排列")}</option>
                {canvasArrangeOptions.map(option => <option key={option.key} value={option.key}>{t(option.label)}</option>)}
            </select>
        </div>
        {!nodes.some(node => node.metadata?.locked) ? (["top-left", "top-right", "bottom-left", "bottom-right"] as const).map(handle => <button key={handle} type="button" aria-label={t("缩放选区 {handle}", { handle })} onPointerDown={event => start(event, handle)} className="pointer-events-auto absolute" style={{ width: 12 / scale, height: 12 / scale, background: theme.node.panel, border: `${1 / scale}px solid ${theme.canvas.selectionStroke}`, left: handle.includes("left") ? -6 / scale : undefined, right: handle.includes("right") ? -6 / scale : undefined, top: handle.includes("top") ? -6 / scale : undefined, bottom: handle.includes("bottom") ? -6 / scale : undefined, cursor: handle === "top-left" || handle === "bottom-right" ? "nwse-resize" : "nesw-resize" }} />) : null}
    </div>;
});
