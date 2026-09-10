import { expect, test } from "bun:test";

import { isCanvasDesktopLayout, shouldOpenCanvasCreationPanel } from "@/lib/canvas/canvas-layout-breakpoint";

test("matches the canvas desktop rail breakpoint", () => {
    expect(isCanvasDesktopLayout(1023)).toBe(false);
    expect(isCanvasDesktopLayout(1024)).toBe(true);
});

test("opens the creation panel on load only for an empty desktop canvas", () => {
    expect(shouldOpenCanvasCreationPanel(0, 1440)).toBe(true);
    expect(shouldOpenCanvasCreationPanel(1, 1440)).toBe(false);
    expect(shouldOpenCanvasCreationPanel(20, 1440)).toBe(false);
    expect(shouldOpenCanvasCreationPanel(0, 390)).toBe(false);
    expect(shouldOpenCanvasCreationPanel(1, 390)).toBe(false);
});
