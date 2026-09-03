import React, { forwardRef, useImperativeHandle, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { canvasConnectionRenderStateEqual } from "@/lib/canvas/canvas-connection-render-stability";
import { createConnectionGeometryCache } from "@/lib/canvas/canvas-connection-geometry";
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
    const pathD = geometryCacheRef.current.get(connection, from, to).d;

    return (
        <g>
            <path
                data-connection-id={connection.id}
                d={pathD}
                stroke="transparent"
                strokeWidth="16"
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
                <path
                    d={pathD}
                    stroke={active ? theme.node.activeStroke : theme.node.muted}
                    strokeWidth={active ? 3 : 2}
                    strokeOpacity={active ? 1 : 0.82}
                    fill="none"
                    style={{ filter: active ? `drop-shadow(0 0 8px ${theme.node.activeStroke}66)` : undefined, pointerEvents: "none" }}
                />
            ) : null}
        </g>
    );
}, (previous, next) => canvasConnectionRenderStateEqual(previous, next));

export function canvasActiveConnectionPathD(node: CanvasNodeData, handle: ConnectionHandle, mouseWorld: Position, target?: CanvasNodeData) {
    const startX = handle.handleType === "source" ? node.position.x + node.width : mouseWorld.x;
    const startY = handle.handleType === "source" ? node.position.y + node.height / 2 : mouseWorld.y;
    const endX = handle.handleType === "source" ? mouseWorld.x : node.position.x;
    const endY = handle.handleType === "source" ? mouseWorld.y : node.position.y + node.height / 2;
    const snappedStartX = handle.handleType === "target" && target ? target.position.x + target.width : startX;
    const snappedStartY = handle.handleType === "target" && target ? target.position.y + target.height / 2 : startY;
    const snappedEndX = handle.handleType === "source" && target ? target.position.x : endX;
    const snappedEndY = handle.handleType === "source" && target ? target.position.y + target.height / 2 : endY;
    const distance = Math.abs(snappedEndX - snappedStartX);
    return `M ${snappedStartX} ${snappedStartY} C ${snappedStartX + distance * 0.5} ${snappedStartY}, ${snappedEndX - distance * 0.5} ${snappedEndY}, ${snappedEndX} ${snappedEndY}`;
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
                path.style.display = "";
            },
            clear: () => {
                if (pathRef.current) pathRef.current.style.display = "none";
            },
        }),
        [],
    );

    return <path ref={pathRef} stroke={theme.node.activeStroke} strokeWidth="2" fill="none" strokeDasharray="5,5" style={{ display: "none", pointerEvents: "none" }} />;
});
