import { expect, test } from "bun:test";

import { canvasNodeRenderingStyle, shouldUseCanvasNodeOverview } from "@/lib/canvas/canvas-node-rendering";

test("keeps overscan nodes out of the browser paint pipeline until they approach the viewport", () => {
    expect(canvasNodeRenderingStyle).toEqual({ contain: "layout style", contentVisibility: "auto" });
});

const overview = { renderQuality: "overview" as const, selected: true, multiSelected: true, focused: false, connectionTarget: false, showPanel: false, editing: false, hovered: false };

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
