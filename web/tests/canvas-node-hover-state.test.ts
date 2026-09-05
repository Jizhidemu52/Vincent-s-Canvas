import { expect, test } from "bun:test";

import { canvasNodeEffectiveHover } from "@/lib/canvas/canvas-node-hover-state";

test("keeps a normal hover when the canvas is settled", () => {
    expect(canvasNodeEffectiveHover(true, "full")).toBe(true);
    expect(canvasNodeEffectiveHover(true, "overview")).toBe(true);
});

test("drops hover affordances while the canvas is moving", () => {
    expect(canvasNodeEffectiveHover(true, "moving")).toBe(false);
    expect(canvasNodeEffectiveHover(false, "moving")).toBe(false);
});
