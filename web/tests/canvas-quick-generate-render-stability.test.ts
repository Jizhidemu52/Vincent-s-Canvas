import { describe, expect, test } from "bun:test";

import { canvasQuickGeneratePanelPropsEqual, type CanvasQuickGeneratePanelRenderState } from "@/lib/canvas/canvas-quick-generate-render-stability";

const noop = () => undefined;
const references: unknown[] = [];
const config = { id: "canvas-config" };

function state(overrides: Partial<CanvasQuickGeneratePanelRenderState> = {}): CanvasQuickGeneratePanelRenderState {
    return {
        embedded: true,
        open: true,
        prompt: "红色针织连衣裙",
        model: "open-gpt2",
        size: "1:1",
        quality: "auto",
        count: 2,
        references,
        running: false,
        estimateCredits: 4,
        estimateRmb: 0.24,
        remainingCredits: 96,
        config,
        onClose: noop,
        onPromptChange: noop,
        onModelChange: noop,
        onSizeChange: noop,
        onQualityChange: noop,
        onCountChange: noop,
        onPickReferences: noop,
        onRemoveReference: noop,
        onClearReferences: noop,
        onMoveReference: noop,
        onMissingConfig: noop,
        onGenerate: noop,
        ...overrides,
    };
}

describe("canvas quick-generate panel render stability", () => {
    test("keeps the generation panel stable while unrelated canvas previews move", () => {
        expect(canvasQuickGeneratePanelPropsEqual(state(), state())).toBe(true);
    });

    test("refreshes the panel when a generation setting changes", () => {
        expect(canvasQuickGeneratePanelPropsEqual(state(), state({ count: 3 }))).toBe(false);
        expect(canvasQuickGeneratePanelPropsEqual(state(), state({ quality: "high" }))).toBe(false);
    });

    test("refreshes the panel when a reference collection changes", () => {
        expect(canvasQuickGeneratePanelPropsEqual(state(), state({ references: [{ id: "ref-1" }] }))).toBe(false);
    });

    test("refreshes the panel when an action callback changes", () => {
        expect(canvasQuickGeneratePanelPropsEqual(state(), state({ onGenerate: () => undefined }))).toBe(false);
    });
});
