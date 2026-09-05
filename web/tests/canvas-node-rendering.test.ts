import { expect, test } from "bun:test";

import { canvasNodeRenderingStyle } from "@/lib/canvas/canvas-node-rendering";

test("keeps overscan nodes out of the browser paint pipeline until they approach the viewport", () => {
    expect(canvasNodeRenderingStyle).toEqual({ contain: "layout style", contentVisibility: "auto" });
});
