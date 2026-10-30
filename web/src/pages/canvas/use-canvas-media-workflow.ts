import { uiText } from "@/lib/i18n";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasMediaWorkflowAction } from "@/lib/canvas/canvas-assistant-panel-render-stability";
import { useCanvasGraphSetter } from "@/stores/canvas/canvas-graph-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasAssistantSession, CanvasNodeData, Position } from "@/types/canvas";
import { App } from "antd";
import { useCallback, useEffect, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { useCanvasGeneration } from "./use-canvas-generation";

export type CanvasMediaWorkflowOptions = {
    projectId: string;
    nodesRef: RefObject<CanvasNodeData[]>;
    chatSessions: CanvasAssistantSession[];
    setChatSessions: Dispatch<SetStateAction<CanvasAssistantSession[]>>;
    applyAgentOps: (ops: CanvasAgentOp[]) => unknown;
    handleGenerateNode: ReturnType<typeof useCanvasGeneration>["handleGenerateNode"];
    focusCanvasArea: (position: Position, width: number, height: number) => void;
};

export function useCanvasMediaWorkflow(options: CanvasMediaWorkflowOptions) {
    const stageScope = useMemo(() => ({ active: true }), [options.projectId]);
    useEffect(() => { stageScope.active = true; return () => { stageScope.active = false; }; }, [stageScope]);
    const { message } = App.useApp();
    const setSelectedNodeIds = useCanvasGraphSetter("selectedNodeIds");
    const latest = useRef(options); latest.current = options;
    const handleMediaWorkflowAction = useCallback(async (action: CanvasMediaWorkflowAction) => {
        const ownerId = useUserStore.getState().user?.id;
        try {
            const { createCanvasMediaWorkflowActions } = await import("./canvas-media-workflow-actions-runtime");
            if (!stageScope.active || useUserStore.getState().user?.id !== ownerId) return;
            createCanvasMediaWorkflowActions({ ...latest.current, stageScope, message, setSelectedNodeIds }).handleMediaWorkflowAction(action);
        } catch {
            if (stageScope.active && useUserStore.getState().user?.id === ownerId) message.error(uiText("加载失败，请重试"));
        }
    }, [message, setSelectedNodeIds, stageScope]);
    return { handleMediaWorkflowAction };
}
