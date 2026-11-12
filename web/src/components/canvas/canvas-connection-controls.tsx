import { Tooltip } from "antd";
import type { PointerEvent } from "react";
import { useUiText } from "@/lib/i18n";
import type { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

/** Screen-sized controls; the persisted graph is unchanged until a valid drop. */
export function CanvasConnectionControls({ edge, nodes, nodeById, scale, theme, connecting, targetId, targetHint, canConnect, onReconnect }: {
    edge?: CanvasConnection; nodes: CanvasNodeData[]; nodeById: ReadonlyMap<string, CanvasNodeData>;
    scale: number; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; connecting: boolean;
    targetId: string | null; targetHint: string | null; canConnect: (id: string) => boolean;
    onReconnect: (event: PointerEvent, edge: CanvasConnection, endpoint: "source" | "target") => void;
}) {
    const t = useUiText();
    const from = edge && nodeById.get(edge.fromNodeId), to = edge && nodeById.get(edge.toNodeId);
    const target = targetId && nodeById.get(targetId);
    return <>
        {connecting ? nodes.filter(node => canConnect(node.id)).map(node => <div key={node.id} data-connection-eligible={node.id}
            className="pointer-events-none absolute rounded-xl" style={{ left: node.position.x, top: node.position.y,
                width: node.width, height: node.height, outline: `${1 / scale}px solid ${theme.canvas.selectionStroke}`, opacity: .45 }} />) : null}
        {target && targetHint ? <div data-connection-kind className="pointer-events-none absolute z-[80] whitespace-nowrap rounded px-2 py-1 text-xs"
            style={{ left: target.position.x, top: target.position.y, transform: `translateY(-120%) scale(${1 / scale})`, transformOrigin: "left bottom", background: theme.node.panel, color: theme.node.text }}>{targetHint}</div> : null}
        {!connecting && edge && from && to ? ([
            { endpoint: "source" as const, x: from.position.x + from.width, y: from.position.y + from.height / 2, label: "拖动改接起点" },
            { endpoint: "target" as const, x: to.position.x, y: to.position.y + to.height / 2, label: "拖动改接终点" },
        ]).map(item => <Tooltip title={t(item.label)} key={item.endpoint}><button type="button" data-canvas-no-zoom data-connection-endpoint={item.endpoint}
            aria-label={t(item.label)} className="absolute z-[85] grid size-8 touch-none place-items-center rounded-full cursor-crosshair"
            style={{ left: item.x, top: item.y, transform: `translate(-50%, -50%) scale(${1 / scale})` }}
            onPointerDown={event => onReconnect(event, edge, item.endpoint)}>
            <span className="size-3 rounded-full border-2" style={{ borderColor: theme.canvas.selectionStroke, background: theme.node.panel }} />
        </button></Tooltip>) : null}
    </>;
}
