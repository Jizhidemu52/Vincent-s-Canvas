import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useCanvasGraphSetter } from "@/stores/canvas/canvas-graph-store";
import { createCanvasTextStreamBuffer } from "@/lib/canvas/canvas-text-stream-buffer";
import { applyCanvasStreamedTextUpdates, clearCanvasStreamedText } from "@/lib/canvas/canvas-streamed-text-state";
import { useCanvasImageTasks } from "./use-canvas-image-tasks";
import { stopCanvasObservation } from "@/lib/canvas/canvas-project-async-lifecycle";
import type { CanvasNodeData } from "@/types/canvas";

type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

export function useCanvasGenerationRuntime({ projectId, nodesRef, setNodes, projectSaveQueueRef, textStreamPublishingEnabledRef }: {
    projectId: string; nodesRef: RefObject<CanvasNodeData[]>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    projectSaveQueueRef: RefObject<{ flush(): void } | null>;
    textStreamPublishingEnabledRef: RefObject<boolean>;
}) {
    const NODE_STATUS_LOADING = "loading", NODE_STATUS_IDLE = "idle";
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const setStreamedTextById = useCanvasGraphSetter("streamedTextById");
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    const generationDispatchLocksRef = useRef(new Set<string>());
    const textStreamBufferRef = useRef<ReturnType<typeof createCanvasTextStreamBuffer> | null>(null);
    const clearStreamedText = useCallback((nodeIds: Iterable<string>) => {
        setStreamedTextById((current) => clearCanvasStreamedText(current, nodeIds));
    }, []);

    if (!textStreamBufferRef.current) {
        textStreamBufferRef.current = createCanvasTextStreamBuffer((updates) => {
            if (!textStreamPublishingEnabledRef.current) return;
            setStreamedTextById((current) => applyCanvasStreamedTextUpdates(current, updates));
        });
    }
    const { createOptions, recoverPending } = useCanvasImageTasks({ projectId, nodes: nodesRef, setNodes, saveQueue: projectSaveQueueRef, generating: generationRequestsRef });
    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController()) => {
        const previous = generationRequestsRef.current.get(targetNodeId);
        if (previous?.controller !== controller) previous?.controller.abort();
        clearStreamedText([targetNodeId]);
        generationRequestsRef.current.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId: runningId, controller });
        return controller;
    }, [clearStreamedText]);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller === controller) {
            generationRequestsRef.current.delete(targetNodeId);
            textStreamBufferRef.current?.clear(targetNodeId);
            clearStreamedText([targetNodeId]);
        }
    }, [clearStreamedText]);

    const stopGenerationByRunningId = useCallback((runningId: string, observationOnly = false) => {
        const affectedNodeIds = new Set<string>();
        generationRequestsRef.current.forEach((request) => {
            if (request.runningNodeId !== runningId) return;
            if (observationOnly) stopCanvasObservation(request.controller);
            else request.controller.abort();
            generationRequestsRef.current.delete(request.targetNodeId);
            affectedNodeIds.add(request.targetNodeId);
            affectedNodeIds.add(request.originNodeId);
        });
        affectedNodeIds.forEach((nodeId) => textStreamBufferRef.current?.clear(nodeId));
        clearStreamedText(affectedNodeIds);
        setRunningNodeId((current) => (current === runningId ? null : current));
        if (!affectedNodeIds.size) return;
        setNodes((prev) => prev.map((node) => (affectedNodeIds.has(node.id) && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node)));
    }, [clearStreamedText]);
    return { createOptions, recoverPending, runningNodeId, setRunningNodeId, generationRequestsRef, generationDispatchLocksRef,
        textStreamBufferRef, clearStreamedText, startGenerationRequest, finishGenerationRequest, stopGenerationByRunningId };
}
