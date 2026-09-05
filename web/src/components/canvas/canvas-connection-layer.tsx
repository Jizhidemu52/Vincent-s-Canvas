import React, { forwardRef, memo, useCallback, useImperativeHandle, useLayoutEffect, useRef } from "react";

import { createConnectionGeometryCache, type CanvasConnectionGeometry } from "@/lib/canvas/canvas-connection-geometry";
import { getFastCanvas2DContext } from "@/lib/canvas/canvas-2d-context";
import { canvasConnectionViewportBounds, createCanvasConnectionDrawCache, drawCanvasConnectionBatches, filterCanvasConnectionDrawBatches, type CanvasConnectionDrawBatches } from "@/lib/canvas/canvas-connection-layer";
import { canvasConnectionCanvasSize, type CanvasConnectionCanvasSize } from "@/lib/canvas/canvas-connection-canvas-size";
import { shouldDrawCanvasConnectionLayer, shouldRedrawCanvasConnectionLayer, type CanvasConnectionLayerPaintState } from "@/lib/canvas/canvas-dynamic-connection-layer";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

const EMPTY_CONNECTION_DRAW_BATCHES: CanvasConnectionDrawBatches = { regular: [], active: [] };

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

export const CanvasConnectionLayer = memo(forwardRef<CanvasConnectionLayerHandle, CanvasConnectionLayerProps>(function CanvasConnectionLayer(
    { connections, resolveNode, viewport, activeConnectionIds, affectedConnectionIds, isDraggingNodes, onDrawFailure },
    ref,
) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const staticCanvasRef = useRef<HTMLCanvasElement>(null);
    const dynamicCanvasRef = useRef<HTMLCanvasElement>(null);
    const staticCanvasSizeRef = useRef<CanvasConnectionCanvasSize | null>(null);
    const dynamicCanvasSizeRef = useRef<CanvasConnectionCanvasSize | null>(null);
    const latestViewportRef = useRef(viewport);
    const geometryCacheRef = useRef(createConnectionGeometryCache());
    const resolveGeometryRef = useRef<(connection: CanvasConnection) => CanvasConnectionGeometry | undefined>(() => undefined);
    const drawCacheRef = useRef(createCanvasConnectionDrawCache((connection) => resolveGeometryRef.current(connection)));
    const batchesRef = useRef<CanvasConnectionDrawBatches>({ regular: [], active: [] });
    const dynamicConnectionIdsRef = useRef<ReadonlySet<string>>(new Set());
    const staticCanvasHasContentRef = useRef(false);
    const dynamicCanvasHasContentRef = useRef(false);
    const staticPaintStateRef = useRef<CanvasConnectionLayerPaintState | null>(null);
    const splitBatchesRef = useRef<{ source: CanvasConnectionDrawBatches | null; ids: ReadonlySet<string>; static: CanvasConnectionDrawBatches; dynamic: CanvasConnectionDrawBatches }>({
        source: null,
        ids: new Set(),
        static: { regular: [], active: [] },
        dynamic: { regular: [], active: [] },
    });
    const wasDraggingNodesRef = useRef(false);
    const failedRef = useRef(false);
    const staticPaintKey = `${theme.node.muted}:${theme.node.activeStroke}`;
    latestViewportRef.current = viewport;
    resolveGeometryRef.current = (connection) => {
        const from = resolveNode(connection.fromNodeId);
        const to = resolveNode(connection.toNodeId);
        return from && to ? geometryCacheRef.current.get(connection, from, to) : undefined;
    };
    const refreshAllGeometry = !isDraggingNodes && wasDraggingNodesRef.current;
    batchesRef.current = drawCacheRef.current.sync(connections, activeConnectionIds, affectedConnectionIds, refreshAllGeometry);

    const syncCanvasSize = useCallback((cssWidth: number, cssHeight: number) => {
        const pixelRatio = window.devicePixelRatio || 1;
        const nextStatic = canvasConnectionCanvasSize(cssWidth, cssHeight, pixelRatio);
        const nextDynamic = canvasConnectionCanvasSize(cssWidth, cssHeight, pixelRatio, 1);
        if (!sameCanvasSize(staticCanvasSizeRef.current, nextStatic)) {
            staticCanvasSizeRef.current = nextStatic;
            staticPaintStateRef.current = null;
        }
        if (!sameCanvasSize(dynamicCanvasSizeRef.current, nextDynamic)) dynamicCanvasSizeRef.current = nextDynamic;
    }, []);

    const drawBatches = useCallback(
        (canvas: HTMLCanvasElement | null, nextViewport: ViewportTransform, batches: CanvasConnectionDrawBatches, sizeRef: React.MutableRefObject<CanvasConnectionCanvasSize | null>) => {
            if (!canvas) return false;
            let size = sizeRef.current;
            if (!size) {
                const host = canvas.parentElement;
                if (!host) return false;
                const rect = host.getBoundingClientRect();
                syncCanvasSize(rect.width, rect.height);
                size = sizeRef.current;
                if (!size) return true;
            }

            if (canvas.width !== size.width || canvas.height !== size.height) {
                canvas.width = size.width;
                canvas.height = size.height;
            }

            try {
                const context = getFastCanvas2DContext(canvas);
                if (!context) throw new Error("Canvas 2D context is unavailable");
                context.setTransform(size.pixelRatio, 0, 0, size.pixelRatio, 0, 0);
                context.clearRect(0, 0, size.cssWidth, size.cssHeight);
                context.translate(nextViewport.x, nextViewport.y);
                context.scale(nextViewport.k, nextViewport.k);
                return drawCanvasConnectionBatches(
                    context,
                    batches,
                    { stroke: theme.node.muted, activeStroke: theme.node.activeStroke },
                    canvasConnectionViewportBounds(nextViewport, { width: size.cssWidth, height: size.cssHeight }),
                );
            } catch {
                return false;
            }
        },
        [syncCanvasSize, theme.node.activeStroke, theme.node.muted],
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
                const hasStaticContent = hasCanvasConnectionDrawContent(batches.static);
                const hasDynamicContent = hasCanvasConnectionDrawContent(batches.dynamic);
                const needsStaticDraw = shouldRedrawCanvasConnectionLayer(staticPaintStateRef.current, { hasContent: hasStaticContent, batches: batches.static, paintKey: staticPaintKey, viewport: nextViewport });
                const needsDynamicDraw = shouldDrawCanvasConnectionLayer(dynamicCanvasHasContentRef.current, hasDynamicContent);
                if (
                    (!needsStaticDraw || drawBatches(staticCanvasRef.current, nextViewport, batches.static, staticCanvasSizeRef)) &&
                    (!needsDynamicDraw || drawBatches(dynamicCanvasRef.current, nextViewport, batches.dynamic, dynamicCanvasSizeRef))
                ) {
                    staticCanvasHasContentRef.current = hasStaticContent;
                    dynamicCanvasHasContentRef.current = hasDynamicContent;
                    if (needsStaticDraw) staticPaintStateRef.current = { hasContent: hasStaticContent, batches: batches.static, paintKey: staticPaintKey, viewport: nextViewport };
                    return;
                }
            } else {
                dynamicConnectionIdsRef.current = new Set();
                splitBatchesRef.current.source = null;
                const hasStaticContent = hasCanvasConnectionDrawContent(batchesRef.current);
                const needsStaticDraw = shouldRedrawCanvasConnectionLayer(staticPaintStateRef.current, { hasContent: hasStaticContent, batches: batchesRef.current, paintKey: staticPaintKey, viewport: nextViewport });
                const needsDynamicDraw = shouldDrawCanvasConnectionLayer(dynamicCanvasHasContentRef.current, false);
                if (
                    (!needsStaticDraw || drawBatches(staticCanvasRef.current, nextViewport, batchesRef.current, staticCanvasSizeRef)) &&
                    (!needsDynamicDraw || drawBatches(dynamicCanvasRef.current, nextViewport, EMPTY_CONNECTION_DRAW_BATCHES, dynamicCanvasSizeRef))
                ) {
                    staticCanvasHasContentRef.current = hasStaticContent;
                    dynamicCanvasHasContentRef.current = false;
                    if (needsStaticDraw) staticPaintStateRef.current = { hasContent: hasStaticContent, batches: batchesRef.current, paintKey: staticPaintKey, viewport: nextViewport };
                    return;
                }
            }
            failDrawing();
        },
        [drawBatches, failDrawing, isDraggingNodes, splitBatches, staticPaintKey],
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
            const hasStaticContent = hasCanvasConnectionDrawContent(batches.static);
            const hasDynamicContent = hasCanvasConnectionDrawContent(batches.dynamic);
            const needsStaticDraw = changed && shouldRedrawCanvasConnectionLayer(staticPaintStateRef.current, { hasContent: hasStaticContent, batches: batches.static, paintKey: staticPaintKey, viewport: nextViewport });
            const needsDynamicDraw = shouldDrawCanvasConnectionLayer(dynamicCanvasHasContentRef.current, hasDynamicContent);
            if (
                (!needsStaticDraw || drawBatches(staticCanvasRef.current, nextViewport, batches.static, staticCanvasSizeRef)) &&
                (!needsDynamicDraw || drawBatches(dynamicCanvasRef.current, nextViewport, batches.dynamic, dynamicCanvasSizeRef))
            ) {
                if (changed) staticCanvasHasContentRef.current = hasStaticContent;
                dynamicCanvasHasContentRef.current = hasDynamicContent;
                if (needsStaticDraw) staticPaintStateRef.current = { hasContent: hasStaticContent, batches: batches.static, paintKey: staticPaintKey, viewport: nextViewport };
                return;
            }
            failDrawing();
        },
        [activeConnectionIds, connections, draw, drawBatches, failDrawing, splitBatches, staticPaintKey],
    );

    useImperativeHandle(ref, () => ({ draw, refresh }), [draw, refresh]);

    useLayoutEffect(() => {
        wasDraggingNodesRef.current = isDraggingNodes;
    }, [isDraggingNodes]);

    useLayoutEffect(() => {
        const canvas = staticCanvasRef.current;
        const host = canvas?.parentElement;
        if (!host) return;
        const initialRect = host.getBoundingClientRect();
        syncCanvasSize(initialRect.width, initialRect.height);
        const observer = new ResizeObserver((entries) => {
            const rect = entries[0]?.contentRect;
            if (!rect) return;
            syncCanvasSize(rect.width, rect.height);
            draw(latestViewportRef.current);
        });
        observer.observe(host);
        return () => observer.disconnect();
    }, [draw, syncCanvasSize]);

    useLayoutEffect(() => {
        draw(viewport);
    }, [draw, viewport]);

    return (
        <>
            <canvas ref={staticCanvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 z-0" />
            <canvas ref={dynamicCanvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 z-0" />
        </>
    );
}));

function sameConnectionIds(previous: ReadonlySet<string>, next: ReadonlySet<string>) {
    return previous.size === next.size && Array.from(previous).every((id) => next.has(id));
}

function hasCanvasConnectionDrawContent(batches: CanvasConnectionDrawBatches) {
    return batches.regular.length > 0 || batches.active.length > 0;
}

function sameCanvasSize(previous: CanvasConnectionCanvasSize | null, next: CanvasConnectionCanvasSize | null) {
    return (previous === null && next === null) || Boolean(previous && next && previous.cssWidth === next.cssWidth && previous.cssHeight === next.cssHeight && previous.pixelRatio === next.pixelRatio);
}
