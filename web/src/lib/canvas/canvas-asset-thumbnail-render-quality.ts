import { canvasImageRenderProps } from "@/lib/canvas/canvas-image-render-quality";

/** Keeps scrolling the asset rail from competing with thumbnail decoding. */
export function canvasAssetThumbnailRenderProps() {
    return canvasImageRenderProps();
}
