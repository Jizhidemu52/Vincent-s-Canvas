import { describe, expect, test } from "bun:test";

import { canvasInspectorPanelPropsEqual, minimapPropsEqual, type CanvasInspectorPanelRenderState, type MinimapRenderState } from "@/lib/canvas/canvas-floating-surface-render-stability";

const noop = () => undefined;
const node = { id: "node-1" };
const nodes = [node];
const viewport = { x: 20, y: 30, k: 1 };
const viewportSize = { width: 1440, height: 900 };

function minimapState(overrides: Partial<MinimapRenderState> = {}): MinimapRenderState {
    return { nodes, viewport, viewportSize, onViewportChange: noop, ...overrides };
}

function inspectorState(overrides: Partial<CanvasInspectorPanelRenderState> = {}): CanvasInspectorPanelRenderState {
    return { selectedNode: node, backgroundMode: "dots", showImageInfo: false, onBackgroundModeChange: noop, onShowImageInfoChange: noop, ...overrides };
}

describe("canvas floating surface render stability", () => {
    test("keeps the minimap stable while a separate node is previewed", () => {
        expect(minimapPropsEqual(minimapState(), minimapState())).toBe(true);
    });

    test("refreshes the minimap when its viewport changes", () => {
        expect(minimapPropsEqual(minimapState(), minimapState({ viewport: { x: 21, y: 30, k: 1 } }))).toBe(false);
    });

    test("keeps the inspector stable while a separate node is previewed", () => {
        expect(canvasInspectorPanelPropsEqual(inspectorState(), inspectorState())).toBe(true);
    });

    test("refreshes the inspector when its selected node changes", () => {
        expect(canvasInspectorPanelPropsEqual(inspectorState(), inspectorState({ selectedNode: { id: "node-2" } }))).toBe(false);
    });
});
