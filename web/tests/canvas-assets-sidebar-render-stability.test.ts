import { describe, expect, test } from "bun:test";

import { canvasAssetsSidebarPropsEqual, type CanvasAssetsSidebarRenderState } from "@/lib/canvas/canvas-assets-sidebar-render-stability";

const onInsert = () => undefined;

function state(overrides: Partial<CanvasAssetsSidebarRenderState> = {}): CanvasAssetsSidebarRenderState {
    return {
        onInsert,
        testId: "canvas-right-asset-rail",
        ...overrides,
    };
}

describe("canvas assets sidebar render stability", () => {
    test("keeps the thumbnail rail mounted while an unrelated node preview changes", () => {
        expect(canvasAssetsSidebarPropsEqual(state(), state())).toBe(true);
    });

    test("refreshes the rail when its insert action may target different canvas state", () => {
        expect(canvasAssetsSidebarPropsEqual(state(), state({ onInsert: () => undefined }))).toBe(false);
    });

    test("refreshes the rail when its test hook changes", () => {
        expect(canvasAssetsSidebarPropsEqual(state(), state({ testId: "another-rail" }))).toBe(false);
    });
});
