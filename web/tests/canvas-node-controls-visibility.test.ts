import { expect, test } from "bun:test";

import { shouldRenderCanvasNodeControls } from "@/lib/canvas/canvas-node-controls-visibility";

test("omits inactive node controls from the canvas DOM", () => {
    expect(shouldRenderCanvasNodeControls({ renderQuality: "full", hovered: false, selected: false, connecting: false })).toBe(false);
});

test("keeps node controls available while hovering, selecting, or connecting", () => {
    expect(shouldRenderCanvasNodeControls({ renderQuality: "full", hovered: true, selected: false, connecting: false })).toBe(true);
    expect(shouldRenderCanvasNodeControls({ renderQuality: "full", hovered: false, selected: true, connecting: false })).toBe(true);
    expect(shouldRenderCanvasNodeControls({ renderQuality: "full", hovered: false, selected: false, connecting: true })).toBe(true);
});

test("removes node controls during canvas movement even for a selected or hovered node", () => {
    expect(shouldRenderCanvasNodeControls({ renderQuality: "moving", hovered: true, selected: false, connecting: false })).toBe(false);
    expect(shouldRenderCanvasNodeControls({ renderQuality: "moving", hovered: false, selected: true, connecting: false })).toBe(false);
});

test("omits controls only for passive far-canvas overview nodes", () => {
    expect(shouldRenderCanvasNodeControls({ renderQuality: "overview", hovered: false, selected: false, connecting: false })).toBe(false);
    expect(shouldRenderCanvasNodeControls({ renderQuality: "overview", hovered: false, selected: true, connecting: false })).toBe(true);
});
