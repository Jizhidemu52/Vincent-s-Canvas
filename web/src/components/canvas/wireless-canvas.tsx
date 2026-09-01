import React, { useCallback, useEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { clampCanvasZoom } from "@/lib/canvas/canvas-zoom";
import { canvasViewportTransform, zoomViewportAtPoint } from "@/lib/canvas/canvas-viewport-interaction";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "@/types/canvas";

type WirelessCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    backgroundMode?: CanvasBackgroundMode;
    onViewportChange: (viewport: ViewportTransform) => void;
    onViewportPreview?: (viewport: ViewportTransform) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    children: React.ReactNode;
};

export function WirelessCanvas({ containerRef, viewport, backgroundMode = "lines", onViewportChange, onViewportPreview, onCanvasMouseDown, onCanvasDeselect, onContextMenu, onDrop, children }: WirelessCanvasProps) {
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
    const liveViewportRef = useRef(viewport);
    const frameRef = useRef<number | null>(null);
    const pendingViewportRef = useRef<ViewportTransform | null>(null);
    const wheelCommitTimerRef = useRef<number | null>(null);
    const [isSpacePressed, setIsSpacePressed] = useState(false);

    useEffect(() => {
        if (!panState.current.isPanning) liveViewportRef.current = viewport;
    }, [viewport]);

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            if (wheelCommitTimerRef.current) window.clearTimeout(wheelCommitTimerRef.current);
        },
        [],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.code !== "Space") return;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") setIsSpacePressed(false);
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
        };
    }, []);

    const applyLiveViewport = useCallback(
        (next: ViewportTransform) => {
            liveViewportRef.current = next;
            const content = contentRef.current;
            if (content) content.style.transform = canvasViewportTransform(next);
            const grid = gridRef.current;
            if (grid && backgroundMode !== "blank") {
                const gridSize = (backgroundMode === "dots" ? 16 : 48) * next.k;
                grid.style.backgroundSize = `${gridSize}px ${gridSize}px`;
                grid.style.backgroundPosition = `${next.x % gridSize}px ${next.y % gridSize}px`;
            }
            onViewportPreview?.(next);
        },
        [backgroundMode, onViewportPreview],
    );

    const queueLiveViewport = useCallback(
        (next: ViewportTransform) => {
            pendingViewportRef.current = next;
            if (frameRef.current) return;
            frameRef.current = requestAnimationFrame(() => {
                frameRef.current = null;
                const pending = pendingViewportRef.current;
                pendingViewportRef.current = null;
                if (pending) applyLiveViewport(pending);
            });
        },
        [applyLiveViewport],
    );

    const commitLiveViewport = useCallback(() => {
        if (frameRef.current) {
            cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
        }
        const next = pendingViewportRef.current || liveViewportRef.current;
        pendingViewportRef.current = null;
        applyLiveViewport(next);
        onViewportChange(next);
    }, [applyLiveViewport, onViewportChange]);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;

        const delta = -event.deltaY;
        const factor = Math.pow(1.1, delta / 100);
        const current = pendingViewportRef.current || liveViewportRef.current;
        const newScale = clampCanvasZoom(current.k * factor);
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        queueLiveViewport(zoomViewportAtPoint(current, { x: mouseX, y: mouseY }, newScale));
        if (wheelCommitTimerRef.current) window.clearTimeout(wheelCommitTimerRef.current);
        wheelCommitTimerRef.current = window.setTimeout(() => {
            wheelCommitTimerRef.current = null;
            commitLiveViewport();
        }, 120);
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom]")) return;
        if (target?.closest("[data-connection-create-menu]")) return;
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");

        if (event.button === 0 && (event.ctrlKey || event.metaKey) && isBackgroundClick) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
            return;
        }

        if (event.button === 1 || (event.button === 0 && !isSpacePressed && isBackgroundClick)) {
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

            queueLiveViewport({
                x: panState.current.initialX + dx,
                y: panState.current.initialY + dy,
                k: panState.current.initialK,
            });
        };

        const handlePointerUp = () => {
            if (!panState.current.isPanning) return;

            if (!panState.current.hasMoved) {
                onCanvasDeselect?.();
            } else {
                commitLiveViewport();
            }
            panState.current.isPanning = false;
            document.body.style.cursor = "default";
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
        };
    }, [commitLiveViewport, onCanvasDeselect, queueLiveViewport]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const preventWheelScroll = (event: WheelEvent) => event.preventDefault();
        container.addEventListener("wheel", preventWheelScroll, { passive: false });
        return () => container.removeEventListener("wheel", preventWheelScroll);
    }, [containerRef]);

    return (
        <div
            ref={containerRef}
            className="relative h-full w-full cursor-grab select-none overflow-hidden"
            style={{ background: theme.canvas.background }}
            onPointerDown={handlePointerDown}
            onWheel={handleWheel}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            <CanvasGrid gridRef={gridRef} viewport={viewport} mode={backgroundMode} />
            <div
                ref={contentRef}
                className="absolute origin-top-left"
                style={{
                    transform: canvasViewportTransform(viewport),
                }}
            >
                {children}
            </div>
        </div>
    );
}

function CanvasGrid({ gridRef, viewport, mode }: { gridRef: React.RefObject<HTMLDivElement | null>; viewport: ViewportTransform; mode: CanvasBackgroundMode }) {
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
            className="pointer-events-none absolute inset-0 opacity-70"
            style={{
                backgroundImage,
                backgroundSize: `${gridSize}px ${gridSize}px`,
                backgroundPosition: `${x}px ${y}px`,
            }}
        />
    );
}
