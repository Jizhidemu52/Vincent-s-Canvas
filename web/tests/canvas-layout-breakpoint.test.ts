import { expect, test } from "bun:test";

import { isCanvasDesktopLayout } from "@/lib/canvas/canvas-layout-breakpoint";

test("matches the canvas desktop rail breakpoint", () => {
    expect(isCanvasDesktopLayout(1023)).toBe(false);
    expect(isCanvasDesktopLayout(1024)).toBe(true);
});
