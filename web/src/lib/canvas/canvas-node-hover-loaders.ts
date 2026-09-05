export function loadCanvasNodeHoverToolbar() {
    return import("@/components/canvas/canvas-node-hover-toolbar").then(({ CanvasNodeHoverToolbar }) => ({ default: CanvasNodeHoverToolbar }));
}

export function loadCanvasNodeInfoModal() {
    return import("@/components/canvas/canvas-node-hover-toolbar").then(({ CanvasNodeInfoModal }) => ({ default: CanvasNodeInfoModal }));
}
