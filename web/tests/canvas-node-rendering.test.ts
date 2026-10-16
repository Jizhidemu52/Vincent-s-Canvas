import { expect, test } from "bun:test";

import { canvasNodeHasImagePreview, canvasNodeRenderingStyle, shouldUseCanvasNodeOverview } from "@/lib/canvas/canvas-node-rendering";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

test("keeps overscan nodes out of the browser paint pipeline until they approach the viewport", () => {
    expect(canvasNodeRenderingStyle).toEqual({ contain: "layout style", contentVisibility: "auto" });
});

const overview = { renderQuality: "overview" as const, selected: true, multiSelected: true, focused: false, connectionTarget: false, showPanel: false, editing: false, hovered: false };
const imageNode: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "图片", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: {} };

test("identifies image previews from source URLs or a persisted storage key", () => {
    for (const content of ["blob:local-image", "https://example.invalid/image.png", "data:image/png;base64,AA=="]) {
        expect(canvasNodeHasImagePreview({ ...imageNode, metadata: { content } })).toBe(true);
    }
    expect(canvasNodeHasImagePreview({ ...imageNode, metadata: { storageKey: "image:persisted" } })).toBe(true);
    expect(canvasNodeHasImagePreview({ ...imageNode, metadata: { content: "", storageKey: "image:persisted" } })).toBe(true);
});

test("empty image placeholders and non-image content keep overview behavior", () => {
    expect(canvasNodeHasImagePreview(imageNode)).toBe(false);
    expect(canvasNodeHasImagePreview({ ...imageNode, metadata: undefined })).toBe(false);
    expect(canvasNodeHasImagePreview({ ...imageNode, metadata: { content: "", storageKey: "" } })).toBe(false);
    for (const type of [CanvasNodeType.Text, CanvasNodeType.Config, CanvasNodeType.Video, CanvasNodeType.Audio]) {
        expect(canvasNodeHasImagePreview({ ...imageNode, type, metadata: { content: "blob:content", storageKey: "image:persisted" } })).toBe(false);
    }
    expect(shouldUseCanvasNodeOverview({ ...overview, selected: false, hasImagePreview: canvasNodeHasImagePreview(imageNode) })).toBe(true);
});

test("keeps a bulk low-zoom selection lightweight, including its hovered node", () => {
    expect(shouldUseCanvasNodeOverview(overview)).toBe(true);
    expect(shouldUseCanvasNodeOverview({ ...overview, hovered: true })).toBe(true);
});

test("preserves the full single-selection editor and media view", () => {
    expect(shouldUseCanvasNodeOverview({ ...overview, multiSelected: false })).toBe(false);
    expect(shouldUseCanvasNodeOverview({ ...overview, renderQuality: "full" })).toBe(false);
    expect(shouldUseCanvasNodeOverview({ ...overview, renderQuality: "moving" })).toBe(false);
});

test("a focused node, active editor, opened panel or connection target can leave the bulk overview", () => {
    for (const key of ["focused", "editing", "showPanel", "connectionTarget"] as const) {
        expect(shouldUseCanvasNodeOverview({ ...overview, [key]: true })).toBe(false);
    }
});

test("retains passive and hovered unselected overview behavior", () => {
    expect(shouldUseCanvasNodeOverview({ ...overview, selected: false })).toBe(true);
    expect(shouldUseCanvasNodeOverview({ ...overview, selected: false, hovered: true })).toBe(false);
});

test("keeps an unselected low-zoom image preview instead of an empty summary", () => {
    expect(shouldUseCanvasNodeOverview({ ...overview, selected: false, hasImagePreview: true })).toBe(false);
});

test("keeps image previews visible in a bulk low-zoom selection", () => {
    expect(shouldUseCanvasNodeOverview({ ...overview, hasImagePreview: true })).toBe(false);
    expect(shouldUseCanvasNodeOverview({ ...overview, hovered: true, hasImagePreview: true })).toBe(false);
});
