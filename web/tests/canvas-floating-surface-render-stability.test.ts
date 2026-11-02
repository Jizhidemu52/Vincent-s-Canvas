import { describe, expect, test } from "bun:test";

import { minimapPropsEqual, type MinimapRenderState } from "@/lib/canvas/canvas-floating-surface-render-stability";

const noop = () => undefined;
const node = { id: "node-1" };
const nodes = [node];
const viewport = { x: 20, y: 30, k: 1 };
const viewportSize = { width: 1440, height: 900 };
type MinimapPreviewRenderState = MinimapRenderState & { onViewportPreview: (viewport: { x: number; y: number; k: number }) => void };

function minimapState(overrides: Partial<MinimapPreviewRenderState> = {}): MinimapPreviewRenderState {
    return { nodes, viewport, viewportSize, onViewportPreview: noop, onViewportChange: noop, ...overrides };
}

describe("canvas floating surface render stability", () => {
    test("keeps the minimap stable while a separate node is previewed", () => {
        expect(minimapPropsEqual(minimapState(), minimapState())).toBe(true);
    });

    test("refreshes the minimap when its viewport changes", () => {
        expect(minimapPropsEqual(minimapState(), minimapState({ viewport: { x: 21, y: 30, k: 1 } }))).toBe(false);
    });

    test("refreshes the minimap when its live preview callback changes", () => {
        expect(minimapPropsEqual(minimapState(), minimapState({ onViewportPreview: () => undefined }))).toBe(false);
    });

    test("refreshes the minimap when its close callback changes", () => {
        expect(minimapPropsEqual(minimapState(), minimapState({ onClose: noop }))).toBe(false);
    });
});
