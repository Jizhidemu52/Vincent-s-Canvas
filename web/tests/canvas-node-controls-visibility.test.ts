import { expect, test } from "bun:test";

import { shouldRenderCanvasNodeControls } from "@/lib/canvas/canvas-node-controls-visibility";

test("omits inactive node controls from the canvas DOM", () => {
    expect(shouldRenderCanvasNodeControls({ renderQuality: "full", hovered: false, selected: false, connecting: false })).toBe(false);
});

test("hovering an image shows neither resize hit targets nor connection dots", () => {
    const state = { renderQuality: "full" as const, hovered: true, selected: false, connecting: false, isImage: true };
    expect(shouldRenderCanvasNodeControls({ ...state, kind: "resize" })).toBe(false);
    expect(shouldRenderCanvasNodeControls({ ...state, kind: "connection" })).toBe(false);
});

test("selected images keep resize controls after the pointer leaves, but hide connection dots", () => {
    const state = { renderQuality: "full" as const, hovered: false, selected: true, connecting: false, isImage: true };
    expect(shouldRenderCanvasNodeControls({ ...state, kind: "resize" })).toBe(true);
    expect(shouldRenderCanvasNodeControls({ ...state, kind: "connection" })).toBe(false);
});

test("selected image hover and active connection gestures preserve connection access", () => {
    expect(shouldRenderCanvasNodeControls({ renderQuality: "full", hovered: true, selected: true, connecting: false, isImage: true, kind: "connection" })).toBe(true);
    expect(shouldRenderCanvasNodeControls({ renderQuality: "full", hovered: false, selected: false, connecting: true, isImage: true, kind: "connection" })).toBe(true);
    expect(shouldRenderCanvasNodeControls({ renderQuality: "full", hovered: true, selected: false, connecting: true, isImage: true, kind: "resize" })).toBe(false);
});

test("non-image workflow nodes retain hover connection access", () => {
    expect(shouldRenderCanvasNodeControls({ renderQuality: "full", hovered: true, selected: false, connecting: false, kind: "connection" })).toBe(true);
});

test("removes node controls during canvas movement even for a selected or hovered node", () => {
    expect(shouldRenderCanvasNodeControls({ renderQuality: "moving", hovered: true, selected: false, connecting: false })).toBe(false);
    expect(shouldRenderCanvasNodeControls({ renderQuality: "moving", hovered: false, selected: true, connecting: false, kind: "resize", isImage: true })).toBe(false);
});

test("omits controls only for passive far-canvas overview nodes", () => {
    expect(shouldRenderCanvasNodeControls({ renderQuality: "overview", hovered: false, selected: false, connecting: false })).toBe(false);
    expect(shouldRenderCanvasNodeControls({ renderQuality: "overview", hovered: false, selected: true, connecting: false })).toBe(true);
});
