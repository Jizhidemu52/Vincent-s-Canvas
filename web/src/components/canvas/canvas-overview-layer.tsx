import { forwardRef, memo, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";

import { canvasConnectionCanvasSize, type CanvasConnectionCanvasSize } from "@/lib/canvas/canvas-connection-canvas-size";
import { getFastCanvas2DContext } from "@/lib/canvas/canvas-2d-context";
import { filterCanvasOverviewRenderNodes } from "@/lib/canvas/canvas-overview-rendering";
import { canvasOverviewViewportBounds } from "@/lib/canvas/canvas-overview-visibility";
import { createCanvasSpatialIndex, refreshCanvasSpatialGeometryIndex, selectCanvasSpatialIndexNodes } from "@/lib/canvas/canvas-spatial-index";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasOverviewLayerHandle = { draw: (viewport: ViewportTransform) => void };

export const CanvasOverviewLayer = memo(forwardRef<CanvasOverviewLayerHandle, {
    nodesById: Map<string, CanvasNodeData>;
    excludedNodeIds: ReadonlySet<string>;
    viewport: ViewportTransform;
    onDrawFailure: () => void;
}>(function CanvasOverviewLayer({ nodesById, excludedNodeIds, viewport, onDrawFailure }, ref) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const canvasSizeRef = useRef<CanvasConnectionCanvasSize | null>(null);
    const spatialIndexRef = useRef<ReturnType<typeof createCanvasSpatialIndex> | null>(null);
    const latestViewportRef = useRef(viewport);
    const excludedNodeIdsRef = useRef(excludedNodeIds);
    const didDrawExcludedNodesRef = useRef(false);
    const failedRef = useRef(false);
    const spatialIndex = useMemo(() => {
        const nodes = Array.from(nodesById.values());
        const nextIndex = spatialIndexRef.current ? refreshCanvasSpatialGeometryIndex(spatialIndexRef.current, nodes, nodesById) : createCanvasSpatialIndex(nodes, undefined, nodesById);
        spatialIndexRef.current = nextIndex;
        return nextIndex;
    }, [nodesById]);
    const spatialIndexCells = spatialIndex.cells;
    excludedNodeIdsRef.current = excludedNodeIds;

    const syncCanvasSize = useCallback((cssWidth: number, cssHeight: number) => {
        // Overview rectangles are visible only while the detailed node DOM is
        // suppressed. A 1x transient buffer avoids high-DPI full-screen fills
        // while keeping the coarse navigation representation crisp enough.
        const next = canvasConnectionCanvasSize(cssWidth, cssHeight, window.devicePixelRatio || 1, 1);
        const previous = canvasSizeRef.current;
        if ((previous === null && next === null) || (previous !== null && next !== null && previous.cssWidth === next.cssWidth && previous.cssHeight === next.cssHeight && previous.pixelRatio === next.pixelRatio)) return;
        canvasSizeRef.current = next;
    }, []);

    const draw = useCallback((nextViewport: ViewportTransform) => {
        const canvas = canvasRef.current;
        if (!canvas || failedRef.current) return;
        latestViewportRef.current = nextViewport;
        let size = canvasSizeRef.current;
        if (!size) {
            const host = canvas.parentElement;
            if (!host) return;
            const rect = host.getBoundingClientRect();
            syncCanvasSize(rect.width, rect.height);
            size = canvasSizeRef.current;
        }
        if (!size) return;

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
            context.lineWidth = Math.max(1 / nextViewport.k, 1.5);
            context.strokeStyle = theme.node.stroke;
            context.fillStyle = theme.node.fill;
            context.beginPath();
            const viewportCanvasSize = {
                width: size.cssWidth,
                height: size.cssHeight,
            };
            const currentIndex = spatialIndexRef.current;
            if (!currentIndex) return;
            filterCanvasOverviewRenderNodes(selectCanvasSpatialIndexNodes(currentIndex, canvasOverviewViewportBounds(nextViewport, viewportCanvasSize)), excludedNodeIdsRef.current).forEach((node) => {
                context.rect(node.position.x, node.position.y, node.width, node.height);
            });
            context.fill();
            context.stroke();
        } catch {
            failedRef.current = true;
            onDrawFailure();
        }
    }, [onDrawFailure, spatialIndexCells, syncCanvasSize, theme.node.fill, theme.node.stroke]);

    useImperativeHandle(ref, () => ({ draw }), [draw]);

    useLayoutEffect(() => {
        const canvas = canvasRef.current;
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
        const handleWindowResize = () => {
            const rect = host.getBoundingClientRect();
            syncCanvasSize(rect.width, rect.height);
            draw(latestViewportRef.current);
        };
        window.addEventListener("resize", handleWindowResize);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", handleWindowResize);
        };
    }, [draw, syncCanvasSize]);

    useLayoutEffect(() => draw(viewport), [draw, viewport]);

    useLayoutEffect(() => {
        if (!didDrawExcludedNodesRef.current) {
            didDrawExcludedNodesRef.current = true;
            return;
        }
        draw(latestViewportRef.current);
    }, [draw, excludedNodeIds]);

    return <canvas aria-hidden="true" data-testid="canvas-overview-layer" ref={canvasRef} className="pointer-events-none absolute inset-0 z-0" />;
}));
