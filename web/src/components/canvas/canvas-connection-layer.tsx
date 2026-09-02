import React, { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";

import { createConnectionGeometryCache } from "@/lib/canvas/canvas-connection-geometry";
import { drawCanvasConnections } from "@/lib/canvas/canvas-connection-layer";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasConnectionLayerHandle = {
    draw: (viewport: ViewportTransform) => void;
};

type CanvasConnectionLayerProps = {
    connections: CanvasConnection[];
    nodeById: Map<string, CanvasNodeData>;
    viewport: ViewportTransform;
    activeConnectionIds: Set<string>;
    onDrawFailure: () => void;
};

export const CanvasConnectionLayer = forwardRef<CanvasConnectionLayerHandle, CanvasConnectionLayerProps>(function CanvasConnectionLayer(
    { connections, nodeById, viewport, activeConnectionIds, onDrawFailure },
    ref,
) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const geometryCacheRef = useRef(createConnectionGeometryCache());
    const failedRef = useRef(false);
    const items = useMemo(
        () =>
            connections.flatMap((connection) => {
                const from = nodeById.get(connection.fromNodeId);
                const to = nodeById.get(connection.toNodeId);
                if (!from || !to) return [];
                return [{ geometry: geometryCacheRef.current.get(connection, from, to), active: activeConnectionIds.has(connection.id) }];
            }),
        [activeConnectionIds, connections, nodeById],
    );

    const draw = useCallback(
        (nextViewport: ViewportTransform) => {
            if (failedRef.current) return;
            const canvas = canvasRef.current;
            const host = canvas?.parentElement;
            if (!canvas || !host) return;

            const rect = host.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            const pixelRatio = window.devicePixelRatio || 1;
            const width = Math.round(rect.width * pixelRatio);
            const height = Math.round(rect.height * pixelRatio);
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
            }

            try {
                const context = canvas.getContext("2d");
                if (!context) throw new Error("Canvas 2D context is unavailable");
                context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
                context.clearRect(0, 0, rect.width, rect.height);
                context.translate(nextViewport.x, nextViewport.y);
                context.scale(nextViewport.k, nextViewport.k);
                if (drawCanvasConnections(context, items, { stroke: theme.node.muted, activeStroke: theme.node.activeStroke })) return;
            } catch {
                // Fall through to the SVG renderer below.
            }
            {
                failedRef.current = true;
                onDrawFailure();
            }
        },
        [items, onDrawFailure, theme.node.activeStroke, theme.node.muted],
    );

    useImperativeHandle(ref, () => ({ draw }), [draw]);

    useLayoutEffect(() => {
        draw(viewport);
    }, [draw, viewport]);

    useLayoutEffect(() => {
        const canvas = canvasRef.current;
        const host = canvas?.parentElement;
        if (!host) return;
        const observer = new ResizeObserver(() => draw(viewport));
        observer.observe(host);
        return () => observer.disconnect();
    }, [draw, viewport]);

    return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 z-0" />;
});
