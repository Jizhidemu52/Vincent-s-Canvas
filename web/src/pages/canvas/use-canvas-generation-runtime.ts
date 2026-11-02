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
    const [runningNodeIds, setRunningNodeIds] = useState<Set<string>>(new Set());
    const runningNodeId = runningNodeIds.values().next().value || null;
    const setStreamedTextById = useCanvasGraphSetter("streamedTextById");
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    // Compatibility for existing callers; completed runs are removed by finish(), not by a global null.
    const setRunningNodeId = useCallback((value: SetStateAction<string | null>) => {
        const next = typeof value === "function" ? value(null) : value;
        if (next) setRunningNodeIds(current => new Set([...current, next]));
        else setRunningNodeIds(new Set([...generationRequestsRef.current.values()].map(request => request.runningNodeId)));
    }, []);
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
        setRunningNodeIds(current => new Set([...current, runningId]));
        return controller;
    }, [clearStreamedText]);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller === controller) {
            generationRequestsRef.current.delete(targetNodeId);
            setRunningNodeIds(new Set([...generationRequestsRef.current.values()].map(request => request.runningNodeId)));
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
        const partial = new Map([...affectedNodeIds].map(nodeId => [nodeId, textStreamBufferRef.current?.read(nodeId)]));
        affectedNodeIds.forEach((nodeId) => textStreamBufferRef.current?.clear(nodeId));
        clearStreamedText(affectedNodeIds);
        setRunningNodeIds(current => new Set([...current].filter(id => id !== runningId)));
        if (!affectedNodeIds.size) return;
        setNodes((prev) => prev.map((node) => (affectedNodeIds.has(node.id) && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, ...(partial.get(node.id) ? { content: partial.get(node.id) } : {}), status: NODE_STATUS_IDLE, errorDetails: partial.get(node.id) ? "生成已停止，已保留当前文字，可继续编辑或生成。" : undefined } } : node)));
    }, [clearStreamedText]);
    return { createOptions, recoverPending, runningNodeId, runningNodeIds, setRunningNodeId, generationRequestsRef, generationDispatchLocksRef,
        textStreamBufferRef, clearStreamedText, startGenerationRequest, finishGenerationRequest, stopGenerationByRunningId };
}
