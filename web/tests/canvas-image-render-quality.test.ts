import { expect, test } from "bun:test";

import { canvasImageRenderProps } from "@/lib/canvas/canvas-image-render-quality";

test("defers offscreen canvas image decoding without blocking visible rendering", () => {
    expect(canvasImageRenderProps()).toEqual({ decoding: "async", loading: "lazy" });
});
