import type { CanvasAgentMode } from "@/components/canvas/canvas-agent-chat-ui";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasAssistantSession, CanvasNodeData } from "@/types/canvas";

export type CanvasMediaWorkflowAction =
    | { type: "image_model_change"; messageId: string; model: string }
    | { type: "image_count_change"; messageId: string; count: number }
    | { type: "generate_images"; messageId: string }
    | { type: "select_candidate"; messageId: string; nodeId: string }
    | { type: "video_model_change"; messageId: string; model: string }
    | { type: "video_seconds_change"; messageId: string; seconds: string }
    | { type: "aspect_ratio_change"; messageId: string; ratio: string }
    | { type: "generate_video"; messageId: string }
    | { type: "retry"; messageId: string; stage: "image" | "video" }
    | { type: "open_result"; messageId: string };

export type CanvasAssistantPanelRenderState = {
    layout?: "sidebar" | "wide";
    onToggleLayout?: () => void;
    selectedNodeIds: Set<string>;
    selectedNodes: CanvasNodeData[];
    snapshotRef: { current: CanvasAgentSnapshot };
    sessions: CanvasAssistantSession[];
    activeSessionId: string | null;
    onSelectNodeIds: (ids: Set<string>) => void;
    onSessionsChange: (sessions: CanvasAssistantSession[], activeSessionId: string | null) => void;
    onApplyOps: (ops?: CanvasAgentOp[]) => CanvasAgentSnapshot;
    canUndoOps: boolean;
    onUndoOps: () => CanvasAgentSnapshot | null;
    onPasteImage: (file: File) => void;
    agentMode: CanvasAgentMode;
    onAgentModeChange: (mode: CanvasAgentMode) => void;
    onMediaWorkflowAction?: (action: CanvasMediaWorkflowAction) => void;
    autoConnectLocal?: boolean;
    closing: boolean;
    onCollapse: () => void;
};

/**
 * The Agent panel includes chat history and media previews. While a node is
 * changed in the current canvas. The full canvas snapshot is read through a
 * stable reference when the Agent performs an action, so unrelated results
 * from a batch do not re-render the chat history.
 */
export function canvasAssistantPanelPropsEqual(previous: CanvasAssistantPanelRenderState, next: CanvasAssistantPanelRenderState) {
    return (
        previous.layout === next.layout &&
        previous.onToggleLayout === next.onToggleLayout &&
        previous.selectedNodeIds === next.selectedNodeIds &&
        previous.selectedNodes === next.selectedNodes &&
        previous.snapshotRef === next.snapshotRef &&
        previous.sessions === next.sessions &&
        previous.activeSessionId === next.activeSessionId &&
        previous.onSelectNodeIds === next.onSelectNodeIds &&
        previous.onSessionsChange === next.onSessionsChange &&
        previous.onApplyOps === next.onApplyOps &&
        previous.canUndoOps === next.canUndoOps &&
        previous.onUndoOps === next.onUndoOps &&
        previous.onPasteImage === next.onPasteImage &&
        previous.agentMode === next.agentMode &&
        previous.onAgentModeChange === next.onAgentModeChange &&
        previous.onMediaWorkflowAction === next.onMediaWorkflowAction &&
        previous.autoConnectLocal === next.autoConnectLocal &&
        previous.closing === next.closing &&
        previous.onCollapse === next.onCollapse
    );
}
