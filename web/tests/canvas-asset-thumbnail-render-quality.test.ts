import { expect, test } from "bun:test";

import { canvasAssetThumbnailRenderProps } from "@/lib/canvas/canvas-asset-thumbnail-render-quality";

test("defers sidebar asset thumbnail image decoding", () => {
    expect(canvasAssetThumbnailRenderProps()).toEqual({ decoding: "async", loading: "lazy" });
});
