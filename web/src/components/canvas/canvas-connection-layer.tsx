import React, { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef } from "react";

import { createConnectionGeometryCache, type CanvasConnectionGeometry } from "@/lib/canvas/canvas-connection-geometry";
import { createCanvasConnectionDrawCache, drawCanvasConnectionBatches, type CanvasConnectionDrawBatches } from "@/lib/canvas/canvas-connection-layer";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasConnectionLayerHandle = {
    draw: (viewport: ViewportTransform) => void;
    refresh: (viewport: ViewportTransform, affectedConnectionIds: ReadonlySet<string>) => void;
};

type CanvasConnectionLayerProps = {
    connections: CanvasConnection[];
    resolveNode: (nodeId: string) => CanvasNodeData | undefined;
    viewport: ViewportTransform;
    activeConnectionIds: Set<string>;
    affectedConnectionIds: ReadonlySet<string>;
    isDraggingNodes: boolean;
    onDrawFailure: () => void;
};

export const CanvasConnectionLayer = forwardRef<CanvasConnectionLayerHandle, CanvasConnectionLayerProps>(function CanvasConnectionLayer(
    { connections, resolveNode, viewport, activeConnectionIds, affectedConnectionIds, isDraggingNodes, onDrawFailure },
    ref,
) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const geometryCacheRef = useRef(createConnectionGeometryCache());
    const resolveGeometryRef = useRef<(connection: CanvasConnection) => CanvasConnectionGeometry | undefined>(() => undefined);
    const drawCacheRef = useRef(createCanvasConnectionDrawCache((connection) => resolveGeometryRef.current(connection)));
    const batchesRef = useRef<CanvasConnectionDrawBatches>({ regular: [], active: [] });
    const wasDraggingNodesRef = useRef(false);
    const failedRef = useRef(false);
    resolveGeometryRef.current = (connection) => {
        const from = resolveNode(connection.fromNodeId);
        const to = resolveNode(connection.toNodeId);
        return from && to ? geometryCacheRef.current.get(connection, from, to) : undefined;
    };
    const refreshAllGeometry = !isDraggingNodes && wasDraggingNodesRef.current;
    batchesRef.current = drawCacheRef.current.sync(connections, activeConnectionIds, affectedConnectionIds, refreshAllGeometry);

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
                if (drawCanvasConnectionBatches(context, batchesRef.current, { stroke: theme.node.muted, activeStroke: theme.node.activeStroke })) return;
            } catch {
                // Fall through to the SVG renderer below.
            }
            {
                failedRef.current = true;
                onDrawFailure();
            }
        },
        [onDrawFailure, theme.node.activeStroke, theme.node.muted],
    );

    const refresh = useCallback(
        (nextViewport: ViewportTransform, nextAffectedConnectionIds: ReadonlySet<string>) => {
            batchesRef.current = drawCacheRef.current.sync(connections, activeConnectionIds, nextAffectedConnectionIds, false);
            draw(nextViewport);
        },
        [activeConnectionIds, connections, draw],
    );

    useImperativeHandle(ref, () => ({ draw, refresh }), [draw, refresh]);

    useLayoutEffect(() => {
        draw(viewport);
    }, [draw, viewport]);

    useLayoutEffect(() => {
        wasDraggingNodesRef.current = isDraggingNodes;
    }, [isDraggingNodes]);

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
