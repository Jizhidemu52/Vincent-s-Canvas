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
});
