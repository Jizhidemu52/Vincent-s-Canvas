import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { drawMinimapNodeRects } from "@/lib/canvas/canvas-minimap-drawing";
import { createMinimapNodeRects, type MinimapNodeRect } from "@/lib/canvas/canvas-minimap-layout";
import { minimapViewportAtWorldPoint } from "@/lib/canvas/canvas-minimap-preview";
import { createRafLatestScheduler } from "@/lib/canvas/canvas-raf-scheduler";
import { minimapPropsEqual } from "@/lib/canvas/canvas-floating-surface-render-stability";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";

const MinimapNodeLayer = memo(function MinimapNodeLayer({ rects }: { rects: MinimapNodeRect[] }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useLayoutEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (!width || !height) return;
        const pixelRatio = window.devicePixelRatio || 1;
        const pixelWidth = Math.round(width * pixelRatio);
        const pixelHeight = Math.round(height * pixelRatio);
        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
            canvas.width = pixelWidth;
            canvas.height = pixelHeight;
        }
        const context = canvas.getContext("2d");
        if (!context) return;
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        context.clearRect(0, 0, width, height);
        drawMinimapNodeRects(context, rects);
    }, [rects]);

    return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />;
});

export const Minimap = memo(function Minimap({
    nodes,
    viewport,
    viewportSize,
    onViewportPreview,
    onViewportChange,
}: {
    nodes: CanvasNodeData[];
    viewport: ViewportTransform;
    viewportSize: { width: number; height: number };
    onViewportPreview: (viewport: ViewportTransform) => void;
    onViewportChange: (viewport: ViewportTransform) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const containerRef = useRef<HTMLDivElement>(null);
    const onViewportPreviewRef = useRef(onViewportPreview);
    const onViewportChangeRef = useRef(onViewportChange);
    const viewportSchedulerRef = useRef<ReturnType<typeof createRafLatestScheduler<ViewportTransform>> | null>(null);
    const liveViewportRef = useRef(viewport);
    const isDraggingRef = useRef(false);
    const [previewViewport, setPreviewViewport] = useState(viewport);
    const width = 240;
    const height = 160;

    useEffect(() => {
        onViewportPreviewRef.current = onViewportPreview;
        onViewportChangeRef.current = onViewportChange;
    }, [onViewportChange, onViewportPreview]);

    useEffect(() => {
        liveViewportRef.current = viewport;
        setPreviewViewport(viewport);
    }, [viewport]);

    if (!viewportSchedulerRef.current) {
        viewportSchedulerRef.current = createRafLatestScheduler(requestAnimationFrame, cancelAnimationFrame, (nextViewport) => {
            liveViewportRef.current = nextViewport;
            setPreviewViewport(nextViewport);
            onViewportPreviewRef.current(nextViewport);
        });
    }

    useEffect(() => () => viewportSchedulerRef.current?.cancel(), []);

    const { worldBounds, scale, offset } = useMemo(() => {
        if (!nodes.length) {
            return { worldBounds: { x: -500, y: -500, w: 1000, h: 1000 }, scale: 0.16, offset: { x: 40, y: 0 } };
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        nodes.forEach((node) => {
            minX = Math.min(minX, node.position.x);
            minY = Math.min(minY, node.position.y);
            maxX = Math.max(maxX, node.position.x + node.width);
            maxY = Math.max(maxY, node.position.y + node.height);
        });

        minX -= 500;
        minY -= 500;
        maxX += 500;
        maxY += 500;

        const boundsWidth = maxX - minX;
        const boundsHeight = maxY - minY;
        const nextScale = Math.min(width / boundsWidth, height / boundsHeight);
        const mapContentW = boundsWidth * nextScale;
        const mapContentH = boundsHeight * nextScale;

        return {
            worldBounds: { x: minX, y: minY, w: boundsWidth, h: boundsHeight },
            scale: nextScale,
            offset: { x: (width - mapContentW) / 2, y: (height - mapContentH) / 2 },
        };
    }, [nodes]);

    const toMinimap = useCallback(
        (worldX: number, worldY: number) => {
            return {
                x: (worldX - worldBounds.x) * scale + offset.x,
                y: (worldY - worldBounds.y) * scale + offset.y,
            };
        },
        [offset.x, offset.y, scale, worldBounds.x, worldBounds.y],
    );

    const toWorld = useCallback(
        (minimapX: number, minimapY: number) => {
            return {
                x: (minimapX - offset.x) / scale + worldBounds.x,
                y: (minimapY - offset.y) / scale + worldBounds.y,
            };
        },
        [offset.x, offset.y, scale, worldBounds.x, worldBounds.y],
    );

    const viewportRect = useMemo(() => {
        const vx = -previewViewport.x / previewViewport.k;
        const vy = -previewViewport.y / previewViewport.k;
        const vw = viewportSize.width / previewViewport.k;
        const vh = viewportSize.height / previewViewport.k;
        const p1 = toMinimap(vx, vy);
        const p2 = toMinimap(vx + vw, vy + vh);

        return {
            x: p1.x,
            y: p1.y,
            w: Math.max(p2.x - p1.x, 4),
            h: Math.max(p2.y - p1.y, 4),
        };
    }, [previewViewport.k, previewViewport.x, previewViewport.y, toMinimap, viewportSize.height, viewportSize.width]);
    const nodeRects = useMemo(() => createMinimapNodeRects(nodes, scale, offset, theme.node.muted), [nodes, offset, scale, theme.node.muted]);

    const updateViewportFromEvent = (event: React.PointerEvent) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const world = toWorld(event.clientX - rect.left, event.clientY - rect.top);
        viewportSchedulerRef.current?.schedule(minimapViewportAtWorldPoint(world, viewportSize, liveViewportRef.current.k));
    };

    const commitPreviewViewport = () => {
        if (!isDraggingRef.current) return;
        viewportSchedulerRef.current?.flush();
        isDraggingRef.current = false;
        onViewportChangeRef.current(liveViewportRef.current);
    };

    return (
        <div className="absolute bottom-16 left-5 z-50 overflow-hidden rounded-lg border shadow-[0_12px_30px_rgba(15,23,42,.10)] backdrop-blur-sm" style={{ width, height, background: theme.toolbar.panel, borderColor: theme.toolbar.border }}>
            <div
                ref={containerRef}
                className="relative h-full w-full cursor-crosshair"
                onPointerDown={(event) => {
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    isDraggingRef.current = true;
                    updateViewportFromEvent(event);
                }}
                onPointerMove={(event) => {
                    if (isDraggingRef.current) updateViewportFromEvent(event);
                }}
                onPointerUp={commitPreviewViewport}
                onPointerLeave={commitPreviewViewport}
            >
                <MinimapNodeLayer rects={nodeRects} />
                <div className="pointer-events-none absolute border" style={{ left: viewportRect.x, top: viewportRect.y, width: viewportRect.w, height: viewportRect.h, borderColor: theme.canvas.selectionStroke, background: `${theme.canvas.selectionStroke}18` }} />
            </div>
        </div>
    );
}, minimapPropsEqual);
