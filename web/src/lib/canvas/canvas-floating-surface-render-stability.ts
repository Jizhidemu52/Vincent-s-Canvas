import type { CanvasBackgroundMode } from "@/lib/canvas-theme";

export type MinimapRenderState = {
    nodes: readonly unknown[];
    viewport: { x: number; y: number; k: number };
    viewportSize: { width: number; height: number };
    onViewportPreview: (viewport: { x: number; y: number; k: number }) => void;
    onViewportChange: (viewport: { x: number; y: number; k: number }) => void;
};

export function minimapPropsEqual(previous: MinimapRenderState, next: MinimapRenderState) {
    return (
        previous.nodes === next.nodes &&
        previous.viewport === next.viewport &&
        previous.viewportSize === next.viewportSize &&
        previous.onViewportPreview === next.onViewportPreview &&
        previous.onViewportChange === next.onViewportChange
    );
}

export type CanvasInspectorPanelRenderState = {
    selectedNode: object | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    onBackgroundModeChange: (mode: CanvasBackgroundMode) => void;
    onShowImageInfoChange: (value: boolean) => void;
};

export function canvasInspectorPanelPropsEqual(previous: CanvasInspectorPanelRenderState, next: CanvasInspectorPanelRenderState) {
    return (
        previous.selectedNode === next.selectedNode &&
        previous.backgroundMode === next.backgroundMode &&
        previous.showImageInfo === next.showImageInfo &&
        previous.onBackgroundModeChange === next.onBackgroundModeChange &&
        previous.onShowImageInfoChange === next.onShowImageInfoChange
    );
}
