import React, { forwardRef, useImperativeHandle, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { canvasConnectionRenderStateEqual } from "@/lib/canvas/canvas-connection-render-stability";
import { connectionGeometryArrow, createConnectionGeometry, createConnectionGeometryCache } from "@/lib/canvas/canvas-connection-geometry";
import { canvasConnectionPalette, canvasConnectionStyle } from "@/lib/canvas/canvas-connection-layer";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "@/types/canvas";

export const ConnectionPath = React.memo(function ConnectionPath({
    connection,
    from,
    to,
    active,
    renderVisual = true,
    onSelect,
    onContextMenu,
}: {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    active: boolean;
    renderVisual?: boolean;
    onSelect: () => void;
    onContextMenu?: (event: ReactMouseEvent<SVGPathElement>) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const geometryCacheRef = useRef(createConnectionGeometryCache());
    const geometry = geometryCacheRef.current.get(connection, from, to);
    const pathD = geometry.d;
    const style = canvasConnectionStyle(connection.kind, active, canvasConnectionPalette(theme));
    const arrow = connectionGeometryArrow(geometry);

    return (
        <g>
            <path
                data-connection-id={connection.id}
                d={pathD}
                stroke="transparent"
                strokeWidth="16"
                vectorEffect="non-scaling-stroke"
                fill="none"
                style={{ cursor: "pointer", pointerEvents: "stroke" }}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelect();
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onContextMenu?.(event);
                }}
            />
            {renderVisual ? (
                <>
                <path
                    data-connection-visual={connection.kind || "reference"}
                    d={pathD}
                    stroke={style.stroke}
                    strokeDasharray={style.dash.join(",") || undefined}
                    strokeLinecap="round"
                    strokeWidth={active ? 3 : 2}
                    vectorEffect="non-scaling-stroke"
                    strokeOpacity={active ? 1 : 0.82}
                    fill="none"
                    style={{ filter: active ? `drop-shadow(0 0 8px ${theme.node.activeStroke}66)` : undefined, pointerEvents: "none" }}
                />
                <g transform={`translate(${arrow.tip.x} ${arrow.tip.y}) rotate(${arrow.angle * 180 / Math.PI})`} style={{ pointerEvents: "none" }}>
                    <path data-connection-arrow={connection.id} d={active ? "M 0 0 L -9 -4.5 L -9 4.5 Z" : "M 0 0 L -8 -4 L -8 4 Z"} fill={style.stroke} fillOpacity={active ? 1 : 0.82} style={{ transform: "scale(var(--canvas-node-ui-scale, 1))", transformOrigin: "0 0" }} />
                </g>
                </>
            ) : null}
        </g>
    );
}, (previous, next) => canvasConnectionRenderStateEqual(previous, next));

export function canvasActiveConnectionPathD(node: CanvasNodeData, handle: ConnectionHandle, mouseWorld: Position, target?: CanvasNodeData) {
    const pointer = target || { ...node, position: mouseWorld, width: 0, height: 0 };
    return (handle.handleType === "source" ? createConnectionGeometry(node, pointer) : createConnectionGeometry(pointer, node)).d;
}

export type ActiveConnectionPathHandle = {
    draw: (node: CanvasNodeData | undefined, handle: ConnectionHandle, mouseWorld: Position, target?: CanvasNodeData) => void;
    clear: () => void;
};

export const ActiveConnectionPath = forwardRef<ActiveConnectionPathHandle>(function ActiveConnectionPath(_props, ref) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const pathRef = useRef<SVGPathElement>(null);

    useImperativeHandle(
        ref,
        () => ({
            draw: (node, handle, mouseWorld, target) => {
                const path = pathRef.current;
                if (!path || !node) return;
                path.setAttribute("d", canvasActiveConnectionPathD(node, handle, mouseWorld, target));
                path.setAttribute("stroke-dasharray", target ? "none" : "5,5");
                path.style.display = "";
            },
            clear: () => {
                if (pathRef.current) pathRef.current.style.display = "none";
            },
        }),
        [],
    );

    return <path ref={pathRef} stroke={theme.node.activeStroke} strokeWidth="2" vectorEffect="non-scaling-stroke" fill="none" strokeDasharray="5,5" style={{ display: "none", pointerEvents: "none" }} />;
});
