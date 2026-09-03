import type { CanvasSidebarAsset } from "@/components/canvas/canvas-assets-sidebar";

export type CanvasAssetsSidebarRenderState = {
    onInsert: (asset: CanvasSidebarAsset) => void;
    testId?: string;
};

/**
 * The asset rail can contain many image thumbnails. Canvas node previews do
 * not change those assets, so avoid rebuilding the rail unless its callback
 * or DOM identity changes.
 */
export function canvasAssetsSidebarPropsEqual(previous: CanvasAssetsSidebarRenderState, next: CanvasAssetsSidebarRenderState) {
    return previous.onInsert === next.onInsert && previous.testId === next.testId;
}
