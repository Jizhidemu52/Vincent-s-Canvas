import { describe, expect, test } from "bun:test";

import { canvasAssistantPanelPropsEqual, type CanvasAssistantPanelRenderState } from "@/lib/canvas/canvas-assistant-panel-render-stability";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasAssistantSession, CanvasNodeData } from "@/types/canvas";

const noop = () => undefined;
const nodes: CanvasNodeData[] = [];
const selectedNodeIds = new Set<string>();
const snapshot = {} as CanvasAgentSnapshot;
const sessions: CanvasAssistantSession[] = [];
const returnSnapshot = () => snapshot;
const returnNoSnapshot = () => null;

function state(overrides: Partial<CanvasAssistantPanelRenderState> = {}): CanvasAssistantPanelRenderState {
    return {
        nodes,
        selectedNodeIds,
        snapshot,
        sessions,
        activeSessionId: null,
        onSelectNodeIds: noop,
        onSessionsChange: noop,
        onApplyOps: returnSnapshot,
        canUndoOps: false,
        onUndoOps: returnNoSnapshot,
        onPasteImage: noop,
        agentMode: "online",
        onAgentModeChange: noop,
        onMediaWorkflowAction: noop,
        autoConnectLocal: true,
        closing: false,
        onCollapse: noop,
        ...overrides,
    };
}

describe("canvas assistant panel render stability", () => {
    test("keeps the open Agent panel mounted while a node preview changes outside its state", () => {
        expect(canvasAssistantPanelPropsEqual(state(), state())).toBe(true);
    });

    test("refreshes the Agent panel when the canvas snapshot changes", () => {
        expect(canvasAssistantPanelPropsEqual(state(), state({ snapshot: { revision: 2 } as CanvasAgentSnapshot }))).toBe(false);
    });

    test("refreshes the Agent panel when the conversation changes", () => {
        expect(canvasAssistantPanelPropsEqual(state(), state({ sessions: [{ id: "chat-1" }] as CanvasAssistantSession[] }))).toBe(false);
    });
});
