import React, { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef } from "react";

import { createConnectionGeometryCache, type CanvasConnectionGeometry } from "@/lib/canvas/canvas-connection-geometry";
import { createCanvasConnectionDrawCache, drawCanvasConnectionBatches, filterCanvasConnectionDrawBatches, type CanvasConnectionDrawBatches } from "@/lib/canvas/canvas-connection-layer";
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
    const staticCanvasRef = useRef<HTMLCanvasElement>(null);
    const dynamicCanvasRef = useRef<HTMLCanvasElement>(null);
    const geometryCacheRef = useRef(createConnectionGeometryCache());
    const resolveGeometryRef = useRef<(connection: CanvasConnection) => CanvasConnectionGeometry | undefined>(() => undefined);
    const drawCacheRef = useRef(createCanvasConnectionDrawCache((connection) => resolveGeometryRef.current(connection)));
    const batchesRef = useRef<CanvasConnectionDrawBatches>({ regular: [], active: [] });
    const dynamicConnectionIdsRef = useRef<ReadonlySet<string>>(new Set());
    const splitBatchesRef = useRef<{ source: CanvasConnectionDrawBatches | null; ids: ReadonlySet<string>; static: CanvasConnectionDrawBatches; dynamic: CanvasConnectionDrawBatches }>({
        source: null,
        ids: new Set(),
        static: { regular: [], active: [] },
        dynamic: { regular: [], active: [] },
    });
    const wasDraggingNodesRef = useRef(false);
    const failedRef = useRef(false);
    resolveGeometryRef.current = (connection) => {
        const from = resolveNode(connection.fromNodeId);
        const to = resolveNode(connection.toNodeId);
        return from && to ? geometryCacheRef.current.get(connection, from, to) : undefined;
    };
    const refreshAllGeometry = !isDraggingNodes && wasDraggingNodesRef.current;
    batchesRef.current = drawCacheRef.current.sync(connections, activeConnectionIds, affectedConnectionIds, refreshAllGeometry);

    const drawBatches = useCallback(
        (canvas: HTMLCanvasElement | null, nextViewport: ViewportTransform, batches: CanvasConnectionDrawBatches) => {
            const host = canvas?.parentElement;
            if (!canvas || !host) return false;

            const rect = host.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return true;
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
                return drawCanvasConnectionBatches(context, batches, { stroke: theme.node.muted, activeStroke: theme.node.activeStroke });
            } catch {
                return false;
            }
        },
        [theme.node.activeStroke, theme.node.muted],
    );

    const splitBatches = useCallback((connectionIds: ReadonlySet<string>) => {
        const current = splitBatchesRef.current;
        if (current.source === batchesRef.current && sameConnectionIds(current.ids, connectionIds)) return { batches: current, changed: false };

        const next = {
            source: batchesRef.current,
            ids: new Set(connectionIds),
            static: filterCanvasConnectionDrawBatches(batchesRef.current, connectionIds, false),
            dynamic: filterCanvasConnectionDrawBatches(batchesRef.current, connectionIds, true),
        };
        splitBatchesRef.current = next;
        return { batches: next, changed: true };
    }, []);

    const failDrawing = useCallback(() => {
        if (failedRef.current) return;
        failedRef.current = true;
        onDrawFailure();
    }, [onDrawFailure]);

    const draw = useCallback(
        (nextViewport: ViewportTransform) => {
            if (failedRef.current) return;
            const dynamicIds = dynamicConnectionIdsRef.current;
            if (isDraggingNodes && dynamicIds.size) {
                const { batches } = splitBatches(dynamicIds);
                if (drawBatches(staticCanvasRef.current, nextViewport, batches.static) && drawBatches(dynamicCanvasRef.current, nextViewport, batches.dynamic)) return;
            } else {
                dynamicConnectionIdsRef.current = new Set();
                splitBatchesRef.current.source = null;
                if (drawBatches(staticCanvasRef.current, nextViewport, batchesRef.current) && drawBatches(dynamicCanvasRef.current, nextViewport, { regular: [], active: [] })) return;
            }
            failDrawing();
        },
        [drawBatches, failDrawing, isDraggingNodes, splitBatches],
    );

    const refresh = useCallback(
        (nextViewport: ViewportTransform, nextAffectedConnectionIds: ReadonlySet<string>) => {
            if (failedRef.current) return;
            batchesRef.current = drawCacheRef.current.sync(connections, activeConnectionIds, nextAffectedConnectionIds, false);
            dynamicConnectionIdsRef.current = new Set(nextAffectedConnectionIds);
            if (!nextAffectedConnectionIds.size) {
                draw(nextViewport);
                return;
            }

            const { batches, changed } = splitBatches(nextAffectedConnectionIds);
            if ((!changed || drawBatches(staticCanvasRef.current, nextViewport, batches.static)) && drawBatches(dynamicCanvasRef.current, nextViewport, batches.dynamic)) return;
            failDrawing();
        },
        [activeConnectionIds, connections, draw, drawBatches, failDrawing, splitBatches],
    );

    useImperativeHandle(ref, () => ({ draw, refresh }), [draw, refresh]);

    useLayoutEffect(() => {
        draw(viewport);
    }, [draw, viewport]);

    useLayoutEffect(() => {
        wasDraggingNodesRef.current = isDraggingNodes;
    }, [isDraggingNodes]);

    useLayoutEffect(() => {
        const canvas = staticCanvasRef.current;
        const host = canvas?.parentElement;
        if (!host) return;
        const observer = new ResizeObserver(() => draw(viewport));
        observer.observe(host);
        return () => observer.disconnect();
    }, [draw, viewport]);

    return (
        <>
            <canvas ref={staticCanvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 z-0" />
            <canvas ref={dynamicCanvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 z-0" />
        </>
    );
});

function sameConnectionIds(previous: ReadonlySet<string>, next: ReadonlySet<string>) {
    return previous.size === next.size && Array.from(previous).every((id) => next.has(id));
}
