import { expect, test } from "bun:test";

import { shouldUseCanvasNodeMovingPlaceholder } from "@/lib/canvas/canvas-node-moving-content";
import { CanvasNodeType } from "@/types/canvas";

test("simplifies only inactive config nodes while the canvas is moving", () => {
    expect(shouldUseCanvasNodeMovingPlaceholder({ type: CanvasNodeType.Config, renderQuality: "moving", active: false, hovered: false, showPanel: false })).toBe(true);
});

test("keeps interactive and media nodes fully usable while the canvas is moving", () => {
    expect(shouldUseCanvasNodeMovingPlaceholder({ type: CanvasNodeType.Config, renderQuality: "moving", active: true, hovered: false, showPanel: false })).toBe(false);
    expect(shouldUseCanvasNodeMovingPlaceholder({ type: CanvasNodeType.Config, renderQuality: "moving", active: false, hovered: true, showPanel: false })).toBe(false);
    expect(shouldUseCanvasNodeMovingPlaceholder({ type: CanvasNodeType.Config, renderQuality: "moving", active: false, hovered: false, showPanel: true })).toBe(false);
    expect(shouldUseCanvasNodeMovingPlaceholder({ type: CanvasNodeType.Image, renderQuality: "moving", active: false, hovered: false, showPanel: false })).toBe(false);
});

test("does not simplify config nodes once movement settles", () => {
    expect(shouldUseCanvasNodeMovingPlaceholder({ type: CanvasNodeType.Config, renderQuality: "full", active: false, hovered: false, showPanel: false })).toBe(false);
});
