import { Tooltip } from "antd";
import { useEffect, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import { createConnectionGeometry, connectionGeometryPointAt } from "@/lib/canvas/canvas-connection-geometry";
import { findCanvasConnectionHit } from "@/lib/canvas/canvas-connection-hit-test";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUiText } from "@/lib/i18n";
import type { CanvasConnection, CanvasNodeData, Position } from "@/types/canvas";

export function CanvasConnectionHover(props: {
    containerRef: RefObject<HTMLDivElement | null>; connections: CanvasConnection[];
    nodeById: ReadonlyMap<string, CanvasNodeData>; scale: number;
    screenToCanvas: (x: number, y: number) => Position; disabled: boolean;
    onChange: (id: string | null) => void; onDelete: (id: string) => void;
}) {
    const latest = useRef(props); latest.current = props;
    const [hovered, setHovered] = useState<string | null>(null);
    const hoveredIdRef = useRef<string | null>(null);
    const t = useUiText(), theme = canvasThemes[useThemeStore(state => state.theme)];
    useEffect(() => {
        const host = props.containerRef.current;
        if (!host) return;
        let frame = 0, pointer: PointerEvent | null = null;
        const select = (id: string | null) => {
            if (id === hoveredIdRef.current) return;
            hoveredIdRef.current = id; setHovered(id); latest.current.onChange(id);
            host.dataset.connectionHovered = id ? "true" : "false";
        };
        const move = (event: PointerEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-connection-hover]")) return;
            if (latest.current.disabled || event.buttons || target?.closest("[data-node-id],[data-canvas-group-id],[data-canvas-no-zoom],button,input,textarea")) { select(null); return; }
            pointer = event;
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                if (!pointer || latest.current.disabled) return;
                const current = latest.current;
                select(findCanvasConnectionHit({ connections: current.connections, nodeById: current.nodeById, world: current.screenToCanvas(pointer.clientX, pointer.clientY), tolerance: 8 / Math.max(0.05, current.scale) })?.id || null);
            });
        };
        const leave = () => { pointer = null; select(null); };
        host.addEventListener("pointermove", move); host.addEventListener("pointerleave", leave);
        return () => { host.removeEventListener("pointermove", move); host.removeEventListener("pointerleave", leave); if (frame) cancelAnimationFrame(frame); delete host.dataset.connectionHovered; };
    }, [props.containerRef]);
    useEffect(() => { if (props.disabled || (hovered && !props.connections.some(edge => edge.id === hovered))) { hoveredIdRef.current = null; setHovered(null); props.onChange(null); if (props.containerRef.current) props.containerRef.current.dataset.connectionHovered = "false"; } }, [props.disabled, props.connections, hovered, props.onChange]);
    const connection = props.connections.find(edge => edge.id === hovered);
    const from = connection && props.nodeById.get(connection.fromNodeId), to = connection && props.nodeById.get(connection.toNodeId);
    if (!connection || !from || !to || props.disabled) return null;
    const point = connectionGeometryPointAt(createConnectionGeometry(from, to), 0.5);
    return <Tooltip title={t("删除连线，保留两端节点")}><button type="button" data-connection-hover={connection.id} data-canvas-no-zoom aria-label={t("删除连线")} className="absolute z-30 grid size-7 place-items-center rounded-full border"
        style={{ left: point.x, top: point.y, transform: `translate(-50%, -50%) scale(${1 / props.scale})`, background: theme.node.panel, borderColor: theme.canvas.selectionStroke, color: theme.node.text }}
        onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.stopPropagation(); props.onDelete(connection.id); hoveredIdRef.current = null; setHovered(null); props.onChange(null); }}><X size={14} /></button></Tooltip>;
}
