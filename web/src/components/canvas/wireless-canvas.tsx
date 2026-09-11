import React, { forwardRef, memo, startTransition, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { canvasGridPreviewUpdate } from "@/lib/canvas/canvas-grid-preview-update";
import { clampCanvasZoom } from "@/lib/canvas/canvas-zoom";
import { canvasViewportTransform, zoomViewportAtPoint } from "@/lib/canvas/canvas-viewport-interaction";
import { canvasViewportContentStyle } from "@/lib/canvas/canvas-viewport-rendering";
import { shouldRefreshCanvasVirtualization } from "@/lib/canvas/canvas-viewport-virtualization";
import { bindCanvasPointerInteractionEnd } from "@/lib/canvas/canvas-pointer-interaction";
import { bindCanvasSpaceKey } from "@/lib/canvas/canvas-keyboard";
import { canvasWheelZoomFactor } from "@/lib/canvas/canvas-wheel-zoom";
import { shouldCanvasCaptureWheel } from "@/lib/canvas/canvas-wheel-target";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "@/types/canvas";

type WirelessCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    backgroundMode?: CanvasBackgroundMode;
    interactionMode?: "select" | "hand";
    onViewportChange: (viewport: ViewportTransform) => void;
    onViewportPreview?: (viewport: ViewportTransform) => void;
    onInteractionChange?: (isInteracting: boolean) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onOverviewNodePointerDown?: (event: React.PointerEvent<HTMLDivElement>) => boolean;
    onConnectionPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => boolean;
    onCanvasDeselect?: () => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    underlay?: React.ReactNode;
    children: React.ReactNode;
};

export type WirelessCanvasHandle = {
    previewViewport: (viewport: ViewportTransform) => void;
};

export const WirelessCanvas = forwardRef<WirelessCanvasHandle, WirelessCanvasProps>(function WirelessCanvas(
    { containerRef, viewport, backgroundMode = "lines", interactionMode, onViewportChange, onViewportPreview, onInteractionChange, onCanvasMouseDown, onOverviewNodePointerDown, onConnectionPointerDown, onCanvasDeselect, onContextMenu, onDrop, underlay, children },
    ref,
) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const panState = useRef({
        isPanning: false,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        initialK: 1,
        hasMoved: false,
    });
    const contentRef = useRef<HTMLDivElement>(null);
    const gridRef = useRef<HTMLDivElement>(null);
    const gridSizeRef = useRef<string | null>(null);
    const liveViewportRef = useRef(viewport);
    const lastVirtualizationViewportRef = useRef(viewport);
    const virtualizationRefreshDistanceRef = useRef(240);
    const isCanvasInteractionRef = useRef(false);
    const frameRef = useRef<number | null>(null);
    const pendingViewportRef = useRef<ViewportTransform | null>(null);
    const wheelCommitTimerRef = useRef<number | null>(null);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const [isCanvasInteracting, setIsCanvasInteracting] = useState(false);

    const reportCanvasInteraction = useCallback(
        (isInteracting: boolean) => {
            if (isCanvasInteractionRef.current === isInteracting) return;
            isCanvasInteractionRef.current = isInteracting;
            if (isInteracting) lastVirtualizationViewportRef.current = liveViewportRef.current;
            setIsCanvasInteracting(isInteracting);
            onInteractionChange?.(isInteracting);
        },
        [onInteractionChange],
    );

    useEffect(() => {
        if (!panState.current.isPanning && !isCanvasInteractionRef.current) {
            liveViewportRef.current = viewport;
            lastVirtualizationViewportRef.current = viewport;
        }
    }, [viewport]);

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            if (wheelCommitTimerRef.current) window.clearTimeout(wheelCommitTimerRef.current);
        },
        [],
    );

    useEffect(() => bindCanvasSpaceKey(window, setIsSpacePressed), []);

    const applyLiveViewport = useCallback(
        (next: ViewportTransform) => {
            liveViewportRef.current = next;
            const content = contentRef.current;
            if (content) {
                content.style.transform = canvasViewportTransform(next);
                const nodeUiScale = String(1 / Math.max(next.k, 0.0001));
                // Zoom updates memoized node controls too; panning keeps this inherited value unchanged.
                if (content.style.getPropertyValue("--canvas-node-ui-scale") !== nodeUiScale) {
                    content.style.setProperty("--canvas-node-ui-scale", nodeUiScale);
                }
            }
            const grid = gridRef.current;
            const gridUpdate = canvasGridPreviewUpdate(backgroundMode, next, gridSizeRef.current);
            if (grid && gridUpdate) {
                if (gridUpdate.gridSize) {
                    grid.style.backgroundSize = `${gridUpdate.gridSize} ${gridUpdate.gridSize}`;
                    gridSizeRef.current = gridUpdate.gridSize;
                }
                grid.style.backgroundPosition = gridUpdate.backgroundPosition;
            }
            onViewportPreview?.(next);
        },
        [backgroundMode, onViewportPreview],
    );

    const commitLiveViewport = useCallback(() => {
        if (frameRef.current) {
            cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
        }
        const next = pendingViewportRef.current || liveViewportRef.current;
        pendingViewportRef.current = null;
        applyLiveViewport(next);
        lastVirtualizationViewportRef.current = next;
        onViewportChange(next);
    }, [applyLiveViewport, onViewportChange]);

    const publishVirtualizedViewport = useCallback(
        (next: ViewportTransform) => {
            if (!shouldRefreshCanvasVirtualization(lastVirtualizationViewportRef.current, next, virtualizationRefreshDistanceRef.current)) return;
            liveViewportRef.current = next;
            lastVirtualizationViewportRef.current = next;
            // The compositor already received the live transform. Mounting the
            // next virtualized node window can yield to pointer input instead
            // of competing with an active pan or wheel gesture.
            startTransition(() => onViewportChange(next));
        },
        [onViewportChange],
    );

    const queueLiveViewport = useCallback(
        (next: ViewportTransform) => {
            pendingViewportRef.current = next;
            if (frameRef.current) return;
            frameRef.current = requestAnimationFrame(() => {
                frameRef.current = null;
                const pending = pendingViewportRef.current;
                if (!pending) return;
                pendingViewportRef.current = null;
                // One frame consumes all input, with no animation tail to chase or discard.
                applyLiveViewport(pending);
                publishVirtualizedViewport(pending);
            });
        },
        [applyLiveViewport, publishVirtualizedViewport],
    );

    const previewViewport = useCallback(
        (next: ViewportTransform) => {
            if (frameRef.current) {
                cancelAnimationFrame(frameRef.current);
                frameRef.current = null;
            }
            pendingViewportRef.current = null;
            if (wheelCommitTimerRef.current) {
                window.clearTimeout(wheelCommitTimerRef.current);
                wheelCommitTimerRef.current = null;
                reportCanvasInteraction(false);
            }
            applyLiveViewport(next);
        },
        [applyLiveViewport, reportCanvasInteraction],
    );

    useImperativeHandle(ref, () => ({ previewViewport }), [previewViewport]);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!shouldCanvasCaptureWheel(target)) return;

        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect || event.deltaY === 0 || panState.current.isPanning) return;
        // Include every event received before paint, even after a direction or anchor change.
        const current = pendingViewportRef.current ?? liveViewportRef.current;
        const factor = canvasWheelZoomFactor(event.deltaY, event.deltaMode, rect.height);
        const newScale = clampCanvasZoom(current.k * factor);

        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        virtualizationRefreshDistanceRef.current = Math.max(160, Math.max(rect.width, rect.height) / 2);
        reportCanvasInteraction(true);
        const next = zoomViewportAtPoint(current, { x: mouseX, y: mouseY }, newScale);
        queueLiveViewport(next);
        if (wheelCommitTimerRef.current) window.clearTimeout(wheelCommitTimerRef.current);
        wheelCommitTimerRef.current = window.setTimeout(() => {
            wheelCommitTimerRef.current = null;
            commitLiveViewport();
            reportCanvasInteraction(false);
        }, 120);
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom]")) return;
        if (target?.closest("[data-connection-create-menu]")) return;
        // Flush the last input frame before starting a grab/selection.
        if (wheelCommitTimerRef.current) {
            window.clearTimeout(wheelCommitTimerRef.current);
            wheelCommitTimerRef.current = null;
            commitLiveViewport();
            reportCanvasInteraction(false);
        }
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");

        const handActive = interactionMode === "hand" || (interactionMode !== undefined && isSpacePressed);
        if (!handActive && event.button === 0 && isBackgroundClick && onOverviewNodePointerDown?.(event)) {
            event.preventDefault();
            return;
        }

        if (!handActive && event.button === 0 && isBackgroundClick && onConnectionPointerDown?.(event)) {
            event.preventDefault();
            return;
        }

        if (event.button === 0 && !handActive && (interactionMode === "select" || event.ctrlKey || event.metaKey) && isBackgroundClick) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
            return;
        }

        if (event.button === 1 || (event.button === 0 && (handActive || (!isSpacePressed && isBackgroundClick)))) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            const current = pendingViewportRef.current || liveViewportRef.current;
            panState.current = {
                isPanning: true,
                startX: event.clientX,
                startY: event.clientY,
                initialX: current.x,
                initialY: current.y,
                initialK: current.k,
                hasMoved: false,
            };
            virtualizationRefreshDistanceRef.current = Math.max(160, Math.max(event.currentTarget.clientWidth, event.currentTarget.clientHeight) / 2);
            reportCanvasInteraction(true);
            document.body.style.cursor = "grabbing";
            return;
        }

        if (event.button === 0 && isSpacePressed && isBackgroundClick) {
            event.preventDefault();
        }
    };

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (!panState.current.isPanning) return;

            const dx = event.clientX - panState.current.startX;
            const dy = event.clientY - panState.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                panState.current.hasMoved = true;
            }

            const next = {
                x: panState.current.initialX + dx,
                y: panState.current.initialY + dy,
                k: panState.current.initialK,
            };
            queueLiveViewport(next);
        };

        const handlePointerUp = (event: Event) => {
            if (!panState.current.isPanning) return;

            if (panState.current.hasMoved) {
                commitLiveViewport();
            } else if (event.type === "pointerup") {
                onCanvasDeselect?.();
            }
            panState.current.isPanning = false;
            reportCanvasInteraction(false);
            document.body.style.cursor = "default";
        };

        window.addEventListener("pointermove", handlePointerMove);
        const unbindPointerInteractionEnd = bindCanvasPointerInteractionEnd(window, handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            unbindPointerInteractionEnd();
        };
    }, [commitLiveViewport, onCanvasDeselect, queueLiveViewport, reportCanvasInteraction]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const preventCanvasWheelScroll = (event: WheelEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (shouldCanvasCaptureWheel(target)) event.preventDefault();
        };
        container.addEventListener("wheel", preventCanvasWheelScroll, { passive: false });
        return () => container.removeEventListener("wheel", preventCanvasWheelScroll);
    }, [containerRef]);

    return (
        <div
            ref={containerRef}
            data-canvas-viewport
            className={`relative h-full w-full select-none overflow-hidden ${interactionMode === "select" && !isSpacePressed ? "cursor-default" : "cursor-grab"}`}
            style={{ background: theme.canvas.background }}
            onPointerDown={handlePointerDown}
            onPointerDownCapture={(event) => {
                if (event.button !== 0 && event.button !== 1) return;
                if (interactionMode !== "hand" && !(interactionMode && isSpacePressed) && event.button !== 1) return;
                const target = event.target instanceof Element ? event.target : null;
                if (target?.closest("[data-canvas-no-zoom],[data-connection-create-menu]")) return;
                event.stopPropagation();
                handlePointerDown(event);
            }}
            onWheel={handleWheel}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            <CanvasGrid gridRef={gridRef} viewport={viewport} mode={backgroundMode} />
            {underlay}
            <div
                ref={contentRef}
                className="absolute z-[1] origin-top-left"
                style={canvasViewportContentStyle(isCanvasInteracting ? liveViewportRef.current : viewport, isCanvasInteracting)}
            >
                {children}
            </div>
        </div>
    );
});

const CanvasGrid = memo(function CanvasGrid({ gridRef, viewport, mode }: { gridRef: React.RefObject<HTMLDivElement | null>; viewport: ViewportTransform; mode: CanvasBackgroundMode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (mode === "blank") return null;

    const gridSize = (mode === "dots" ? 16 : 48) * viewport.k;
    const x = viewport.x % gridSize;
    const y = viewport.y % gridSize;
    const dotSize = viewport.k < 0.12 ? 0.72 : 0.9;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    return (
        <div
            ref={gridRef}
            className="pointer-events-none absolute inset-0 opacity-20"
            style={{
                backgroundImage,
                backgroundSize: `${gridSize}px ${gridSize}px`,
                backgroundPosition: `${x}px ${y}px`,
            }}
        />
    );
});
