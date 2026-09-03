import { describe, expect, test } from "bun:test";

import { canvasTopBarPropsEqual, type CanvasTopBarRenderState } from "@/lib/canvas/canvas-top-bar-render-stability";

const noop = () => undefined;
const compactAgentStatus = { connected: true, enabled: true, activity: "就绪" };

function state(overrides: Partial<CanvasTopBarRenderState> = {}): CanvasTopBarRenderState {
    return {
        title: "商品改款",
        titleDraft: "商品改款",
        isTitleEditing: false,
        canUndo: true,
        canRedo: false,
        onTitleDraftChange: noop,
        onStartTitleEditing: noop,
        onFinishTitleEditing: noop,
        onCancelTitleEditing: noop,
        onHome: noop,
        onProjects: noop,
        onCreateProject: noop,
        onDeleteProject: noop,
        onImportImage: noop,
        onUndo: noop,
        onRedo: noop,
        onExport: noop,
        onShare: noop,
        agentOpen: false,
        compactAgentStatus,
        onToggleAgent: noop,
        ...overrides,
    };
}

describe("canvas top bar render stability", () => {
    test("keeps the top bar mounted while an unrelated node preview changes", () => {
        expect(canvasTopBarPropsEqual(state(), state())).toBe(true);
    });

    test("refreshes the compact agent indicator when its activity changes", () => {
        expect(canvasTopBarPropsEqual(state(), state({ compactAgentStatus: { connected: true, enabled: true, activity: "生成中" } }))).toBe(false);
    });

    test("refreshes when an action closes over different canvas state", () => {
        expect(canvasTopBarPropsEqual(state(), state({ onExport: () => undefined }))).toBe(false);
    });
});
