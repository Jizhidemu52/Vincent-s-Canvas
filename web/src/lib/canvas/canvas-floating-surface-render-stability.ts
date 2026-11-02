export type MinimapRenderState = {
    nodes: readonly unknown[];
    viewport: { x: number; y: number; k: number };
    viewportSize: { width: number; height: number };
    onViewportPreview: (viewport: { x: number; y: number; k: number }) => void;
    onViewportChange: (viewport: { x: number; y: number; k: number }) => void;
    onClose?: () => void;
};

export function minimapPropsEqual(previous: MinimapRenderState, next: MinimapRenderState) {
    return (
        previous.nodes === next.nodes &&
        previous.viewport === next.viewport &&
        previous.viewportSize === next.viewportSize &&
        previous.onViewportPreview === next.onViewportPreview &&
        previous.onViewportChange === next.onViewportChange && previous.onClose === next.onClose
    );
}
