import { describe, expect, test } from "bun:test";

import { canvasQuickGeneratePanelPropsEqual, type CanvasQuickGeneratePanelRenderState } from "@/lib/canvas/canvas-quick-generate-render-stability";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const noop = () => undefined;
const references: unknown[] = [];
const config = { id: "canvas-config" };
const promptRef = { current: "红色针织连衣裙" };

function state(overrides: Partial<CanvasQuickGeneratePanelRenderState> = {}): CanvasQuickGeneratePanelRenderState {
    return {
        embedded: true,
        open: true,
        promptRef,
        promptRevision: 0,
        model: "open-gpt2",
        size: "1:1",
        quality: "auto",
        count: 2,
        imageOptions: "",
        references,
        running: false,
        estimateCredits: 4,
        estimateRmb: 0.24,
        remainingCredits: 96,
        config,
        onClose: noop,
        onModelChange: noop,
        onSizeChange: noop,
        onQualityChange: noop,
        onCountChange: noop,
        onImageOptionsChange: noop,
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
        expect(canvasQuickGeneratePanelPropsEqual(state(), state({ promptRevision: 1 }))).toBe(false);
        expect(canvasQuickGeneratePanelPropsEqual(state(), state({ count: 3 }))).toBe(false);
        expect(canvasQuickGeneratePanelPropsEqual(state(), state({ quality: "high" }))).toBe(false);
        expect(canvasQuickGeneratePanelPropsEqual(state(), state({ imageOptions: '{"output_format":"webp"}' }))).toBe(false);
    });

    test("refreshes the panel when a reference collection changes", () => {
        expect(canvasQuickGeneratePanelPropsEqual(state(), state({ references: [{ id: "ref-1" }] }))).toBe(false);
    });

    test("refreshes the panel when an action callback changes", () => {
        expect(canvasQuickGeneratePanelPropsEqual(state(), state({ onGenerate: () => undefined }))).toBe(false);
        expect(canvasQuickGeneratePanelPropsEqual(state(), state({ onImageOptionsChange: () => undefined }))).toBe(false);
        expect(canvasQuickGeneratePanelPropsEqual(state(), state({ onSettingsNormalize: () => undefined }))).toBe(false);
        expect(canvasQuickGeneratePanelPropsEqual(state(), state({ onAddReferenceFiles: () => undefined }))).toBe(false);
        expect(canvasQuickGeneratePanelPropsEqual(state(), state({ referencesLoading: true }))).toBe(false);
        expect(canvasQuickGeneratePanelPropsEqual(state(), state({ referenceScopeKey: "another-project" }))).toBe(false);
    });

    test("source and derivative movement does not rerender the form, but their records and captions do", () => {
        const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Image, title: "source", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { prompt: "original" } };
        const child = { ...source, id: "child", title: "child" };
        const a = state({ sourceNode: source, derivatives: [child], visibleReferences: [] });
        const moved = state({ sourceNode: { ...source, position: { x: 100, y: 90 } }, derivatives: [{ ...child, position: { x: 200, y: 80 } }], visibleReferences: [] });
        expect(canvasQuickGeneratePanelPropsEqual(a, moved)).toBe(true);
        expect(canvasQuickGeneratePanelPropsEqual(a, { ...moved, derivatives: [{ ...child, title: "renamed" }] })).toBe(false);
        expect(canvasQuickGeneratePanelPropsEqual(a, { ...moved, sourceNode: { ...source, metadata: { prompt: "new" } } })).toBe(false);
        expect(canvasQuickGeneratePanelPropsEqual(a, { ...moved, onRestoreGeneration: noop })).toBe(false);
    });
});
