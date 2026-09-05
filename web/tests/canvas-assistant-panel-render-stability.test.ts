import { describe, expect, test } from "bun:test";

import { canvasAssistantPanelPropsEqual, type CanvasAssistantPanelRenderState } from "@/lib/canvas/canvas-assistant-panel-render-stability";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasAssistantSession, CanvasNodeData } from "@/types/canvas";

const noop = () => undefined;
const selectedNodeIds = new Set<string>();
const snapshot = {} as CanvasAgentSnapshot;
const snapshotRef = { current: snapshot };
const selectedNodes: CanvasNodeData[] = [];
const sessions: CanvasAssistantSession[] = [];
const returnSnapshot = () => snapshot;
const returnNoSnapshot = () => null;

function state(overrides: Partial<CanvasAssistantPanelRenderState> = {}): CanvasAssistantPanelRenderState {
    return {
        selectedNodeIds,
        selectedNodes,
        snapshotRef,
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

    test("keeps the Agent panel stable while unselected canvas results update", () => {
        snapshotRef.current = { revision: 2 } as CanvasAgentSnapshot;
        expect(canvasAssistantPanelPropsEqual(state(), state())).toBe(true);
    });

    test("refreshes the Agent panel when the snapshot reference is replaced", () => {
        expect(canvasAssistantPanelPropsEqual(state(), state({ snapshotRef: { current: { revision: 2 } as CanvasAgentSnapshot } }))).toBe(false);
    });

    test("refreshes the Agent panel when a selected reference changes", () => {
        expect(canvasAssistantPanelPropsEqual(state(), state({ selectedNodes: [{ id: "selected" } as CanvasNodeData] }))).toBe(false);
    });

    test("refreshes the Agent panel when the conversation changes", () => {
        expect(canvasAssistantPanelPropsEqual(state(), state({ sessions: [{ id: "chat-1" }] as CanvasAssistantSession[] }))).toBe(false);
    });
});
