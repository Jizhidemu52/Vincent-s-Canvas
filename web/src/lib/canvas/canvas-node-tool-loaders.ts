export function loadCanvasNodeAngleDialog() {
    return import("@/components/canvas/canvas-node-angle-dialog").then(({ CanvasNodeAngleDialog }) => ({ default: CanvasNodeAngleDialog }));
}

export function loadCanvasNodeCropDialog() {
    return import("@/components/canvas/canvas-node-crop-dialog").then(({ CanvasNodeCropDialog }) => ({ default: CanvasNodeCropDialog }));
}

export function loadCanvasNodeMaskEditDialog() {
    return import("@/components/canvas/canvas-node-mask-edit-dialog").then(({ CanvasNodeMaskEditDialog }) => ({ default: CanvasNodeMaskEditDialog }));
}

export function loadCanvasNodeSplitDialog() {
    return import("@/components/canvas/canvas-node-split-dialog").then(({ CanvasNodeSplitDialog }) => ({ default: CanvasNodeSplitDialog }));
}

export function loadCanvasNodeUpscaleDialog() {
    return import("@/components/canvas/canvas-node-upscale-dialog").then(({ CanvasNodeUpscaleDialog }) => ({ default: CanvasNodeUpscaleDialog }));
}

export function loadAssetPickerModal() {
    return import("@/components/canvas/asset-picker-modal").then(({ AssetPickerModal }) => ({ default: AssetPickerModal }));
}
