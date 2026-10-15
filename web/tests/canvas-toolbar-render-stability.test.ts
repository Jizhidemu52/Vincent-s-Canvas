import { describe, expect, test } from "bun:test";

import { canvasToolbarPropsEqual, type CanvasToolbarRenderState } from "@/lib/canvas/canvas-toolbar-render-stability";

const noop = () => undefined;

function state(overrides: Partial<CanvasToolbarRenderState> = {}): CanvasToolbarRenderState {
    return {
        selectedCount: 1,
        canUndo: true,
        canRedo: false,
        backgroundMode: "dots",
        showImageInfo: false,
        onAddImage: noop,
        onAddVideo: noop,
        onAddAudio: noop,
        onAddText: noop,
        onAddConfig: noop,
        onOpenQuickGenerate: noop,
        onOpenBatchEdit: noop,
        onUndo: noop,
        onRedo: noop,
        onUpload: noop,
        onDelete: noop,
        onClear: noop,
        onDeselect: noop,
        onBackgroundModeChange: noop,
        onShowImageInfoChange: noop,
        onOpenMyAssets: noop,
        ...overrides,
    };
}

describe("canvas toolbar render stability", () => {
    test("keeps the toolbar stable while a node preview changes outside the toolbar", () => {
        expect(canvasToolbarPropsEqual(state(), state())).toBe(true);
    });

    test("refreshes the toolbar when an action may close over different canvas state", () => {
        expect(canvasToolbarPropsEqual(state(), state({ onDelete: () => undefined }))).toBe(false);
    });

    test("refreshes the toolbar when its visible selection state changes", () => {
        expect(canvasToolbarPropsEqual(state(), state({ selectedCount: 2 }))).toBe(false);
    });

    test("refreshes relocated view controls and the workspace directory action", () => {
        expect(canvasToolbarPropsEqual(state({ viewControls: "100%" }), state({ viewControls: "150%" }))).toBe(false);
        expect(canvasToolbarPropsEqual(state({ onOpenTools: noop }), state({ onOpenTools: () => undefined }))).toBe(false);
        expect(canvasToolbarPropsEqual(state({ onOpenTools: noop, viewControls: "100%" }), state({ onOpenTools: noop, viewControls: "100%" }))).toBe(true);
    });
});
