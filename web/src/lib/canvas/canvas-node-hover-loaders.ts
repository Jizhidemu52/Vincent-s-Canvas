import { loadCanvasToolWhenOnline } from "./canvas-online-loader";

export function loadCanvasNodeHoverToolbar() {
    return loadCanvasToolWhenOnline(() => import("@/components/canvas/canvas-node-hover-toolbar")).then(({ CanvasNodeHoverToolbar }) => ({ default: CanvasNodeHoverToolbar }));
}

export function loadCanvasNodeInfoModal() {
    return loadCanvasToolWhenOnline(() => import("@/components/canvas/canvas-node-hover-toolbar")).then(({ CanvasNodeInfoModal }) => ({ default: CanvasNodeInfoModal }));
}
