import { expect, test } from "bun:test";

import { canvasConnectionSvgSurfaceKind } from "@/lib/canvas/canvas-connection-svg-visibility";

test("keeps the SVG surface out of the normal Canvas-rendered idle state", () => {
    expect(canvasConnectionSvgSurfaceKind(false, false)).toBeNull();
});

test("uses a world-sized fallback surface only when Canvas drawing is unavailable", () => {
    expect(canvasConnectionSvgSurfaceKind(true, false)).toBe("fallback");
    expect(canvasConnectionSvgSurfaceKind(true, true)).toBe("fallback");
});

test("uses a lightweight preview surface while a connection is being drawn", () => {
    expect(canvasConnectionSvgSurfaceKind(false, true)).toBe("preview");
});
