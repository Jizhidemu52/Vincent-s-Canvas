import { useEffect, useRef, useState, type PointerEvent } from "react";
import { canvasPanelWidths, clampCanvasPanelWidth, type CanvasPanelKind } from "@/lib/canvas/canvas-panel-width";
import { keyboardCanvasPanelWidth } from "@/lib/canvas/canvas-panel-resize-keyboard";
import { useCanvasPanelStore } from "@/stores/canvas/use-canvas-panel-store";

export function CanvasPanelResizeHandle({ kind }: { kind: CanvasPanelKind }) {
    const storedWidth = useCanvasPanelStore((state) => kind === "create" ? state.createWidth : state.chatWidth);
    const width = clampCanvasPanelWidth(kind, storedWidth);
    const setWidth = useCanvasPanelStore((state) => state.setWidth);
    const [preview, setPreview] = useState<number | null>(null);
    const drag = useRef<{ x: number; width: number; next: number; root: HTMLElement } | null>(null);
    const limits = canvasPanelWidths[kind];

    useEffect(() => () => {
        const active = drag.current;
        if (active) active.root.style.setProperty(limits.cssVar, `${active.width}px`);
        drag.current = null;
    }, [limits.cssVar]);

    const finish = (event: PointerEvent<HTMLButtonElement>, commit: boolean) => {
        const active = drag.current;
        if (!active) return;
        event.stopPropagation();
        drag.current = null;
        const next = commit ? active.next : active.width;
        active.root.style.setProperty(limits.cssVar, `${next}px`);
        if (commit) setWidth(kind, next);
        setPreview(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };

    return <button type="button" role="separator" aria-orientation="vertical" tabIndex={0}
        aria-label={`调整${kind === "create" ? "创建" : "对话"}面板宽度`}
        aria-valuemin={limits.min} aria-valuemax={limits.max} aria-valuenow={preview ?? width}
        aria-valuetext={`${preview ?? width} 像素`}
        title="拖动调整宽度，双击恢复默认；方向键微调，Home 恢复默认"
        className={`cw-panel-resize-handle ${preview !== null ? "is-resizing" : ""}`}
        data-canvas-no-zoom
        onPointerDown={(event) => {
            if (event.button !== 0) return;
            const root = event.currentTarget.closest<HTMLElement>(".cw-workspace");
            if (!root) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, width, next: width, root };
            setPreview(width);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => {
            const active = drag.current;
            if (!active) return;
            event.stopPropagation();
            active.next = clampCanvasPanelWidth(kind, active.width + event.clientX - active.x);
            active.root.style.setProperty(limits.cssVar, `${active.next}px`);
            setPreview(active.next);
        }}
        onPointerUp={(event) => finish(event, true)}
        onPointerCancel={(event) => finish(event, false)}
        onLostPointerCapture={(event) => finish(event, false)}
        onDoubleClick={(event) => { event.stopPropagation(); setWidth(kind, limits.default); }}
        onKeyDown={(event) => {
            event.stopPropagation();
            const next = keyboardCanvasPanelWidth(kind, width, event.key, event.shiftKey);
            if (next === null) return;
            event.preventDefault();
            setWidth(kind, next);
        }} />;
}
