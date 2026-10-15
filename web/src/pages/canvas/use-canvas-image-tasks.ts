import { useLayoutEffect, useMemo, type Dispatch, type RefObject, type SetStateAction } from "react";
import { nanoid } from "nanoid";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasImageTaskScope } from "./canvas-image-task-runtime";
import type { ToolKey } from "../../../../shared/feature-catalog";

type Input = {
    projectId: string;
    nodes: RefObject<CanvasNodeData[]>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    saveQueue: RefObject<{ flush(): void } | null>;
    generating: RefObject<{ has(nodeId: string): boolean }>;
};

/** Capture the originating identity before loading any task implementation. */
export function useCanvasImageTasks({ projectId, nodes, setNodes, saveQueue, generating }: Input) {
    const activeScope = useMemo<CanvasImageTaskScope>(() => ({ projectId, mounted: true, recoveries: new Map() }), [projectId]);
    useLayoutEffect(() => {
        activeScope.mounted = true;
        return () => {
            activeScope.mounted = false;
            for (const controller of activeScope.recoveries.values()) controller.abort();
            activeScope.recoveries.clear();
        };
    }, [activeScope]);

    return useMemo(() => {
        const loadRuntime = async () => {
            const ownerId = useUserStore.getState().user?.id;
            const { default: createRuntime } = await import("./canvas-image-task-runtime");
            return createRuntime({ nodes, setNodes, saveQueue, scope: activeScope, ownerId, generating });
        };
        return {
            async createOptions(nodeId: string, controller: AbortController, onSubmitted?: () => void, toolKey?: ToolKey) {
                const requestId = nanoid();
                return (await loadRuntime()).createOptions(nodeId, controller, requestId, onSubmitted, toolKey);
            },
            async recoverPending(nodeId?: string) {
                try {
                    return await (await loadRuntime()).recoverPending(nodeId);
                } catch (error) {
                    // Keep the restored node and binding untouched and block a fresh POST.
                    return nodeId ? [{ nodeId, status: "failed" as const, error: String(error) }] : [];
                }
            },
        };
    }, [activeScope, generating, nodes, saveQueue, setNodes]);
}
