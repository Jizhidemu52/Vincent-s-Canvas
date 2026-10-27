import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createCanvasTaskFeedbackTracker, canvasTaskProgressTitle, type CanvasTaskProgress } from "@/lib/canvas/canvas-task-feedback";
import { recordCanvasTaskTiming } from "@/lib/canvas/canvas-experience-metrics";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

const emptyProgress: CanvasTaskProgress = { total: 0, completed: 0, active: 0, successful: 0, failed: 0, stopped: 0 };
const noIds: string[] = [];
type FeedbackState = { scope: string; progress: CanvasTaskProgress; latestResultIds: string[]; highlightedNodeIds: string[] };

export function useCanvasTaskFeedback({ projectId, enabled, nodes, connections, onLocate }: {
    projectId: string; enabled: boolean; nodes: CanvasNodeData[]; connections: CanvasConnection[]; onLocate: (ids: string[]) => void;
}) {
    const ownerId = useUserStore(state => state.user?.id);
    const scope = `${ownerId || "trial"}:${projectId}`;
    const tracker = useMemo(createCanvasTaskFeedbackTracker, [scope]);
    const [state, setState] = useState<FeedbackState>({ scope, progress: emptyProgress, latestResultIds: [], highlightedNodeIds: [] });
    const locate = useRef(onLocate);
    locate.current = onLocate;
    const lastGraph = useRef<{ nodes: CanvasNodeData[]; connections: CanvasConnection[] } | null>(null);
    const title = useRef<{ original: string; written?: string } | null>(null);
    const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const pendingHighlights = useRef<string[]>([]);

    useEffect(() => {
        lastGraph.current = null;
        setState({ scope, progress: emptyProgress, latestResultIds: [], highlightedNodeIds: [] });
        title.current = { original: document.title };
        return () => {
            clearTimeout(highlightTimer.current);
            pendingHighlights.current = [];
            if (title.current?.written === document.title) document.title = title.current.original;
            title.current = null;
        };
    }, [scope, ownerId]);

    const showHighlights = useCallback((ids: string[]) => {
        clearTimeout(highlightTimer.current);
        setState(previous => previous.scope === scope ? { ...previous, highlightedNodeIds: ids } : previous);
        highlightTimer.current = setTimeout(() => {
            setState(previous => previous.scope === scope ? { ...previous, highlightedNodeIds: [] } : previous);
        }, 3500);
    }, [scope]);

    useEffect(() => {
        const visible = () => {
            if (document.hidden) return;
            if (pendingHighlights.current.length) {
                showHighlights(pendingHighlights.current);
                pendingHighlights.current = [];
            }
        };
        document.addEventListener("visibilitychange", visible);
        return () => document.removeEventListener("visibilitychange", visible);
    }, [showHighlights]);

    useEffect(() => {
        if (!enabled || useUserStore.getState().user?.id !== ownerId) return;
        const previous = lastGraph.current;
        // Dragging changes positions, not generation metadata. Avoid rebuilding
        // progress/maps or setting React state for every drag frame.
        if (previous && previous.connections === connections && previous.nodes.length === nodes.length
            && nodes.every((node, index) => node.id === previous.nodes[index]?.id && node.metadata === previous.nodes[index]?.metadata)) return;
        lastGraph.current = { nodes, connections };
        const currentNodes = nodes.filter(node => (!node.metadata?.imageTask || node.metadata.imageTask.ownerId === ownerId)
            && (!node.metadata?.mediaTask || node.metadata.mediaTask.ownerId === ownerId));
        const result = tracker.update(currentNodes, connections);
        const original = title.current?.original;
        if (original !== undefined) {
            const next = canvasTaskProgressTitle(original, result.progress);
            document.title = next;
            title.current!.written = next;
        }
        setState(previousState => ({ scope, progress: result.progress,
            latestResultIds: result.completedIds.length ? result.completedIds : previousState.scope === scope ? previousState.latestResultIds.filter(id => currentNodes.some(node => node.id === id)) : [],
            highlightedNodeIds: previousState.scope === scope ? previousState.highlightedNodeIds : [],
        }));
        result.timings.forEach(recordCanvasTaskTiming);
        if (!result.completedIds.length) return;
        if (document.hidden) pendingHighlights.current = result.completedIds;
        else showHighlights(result.completedIds);
    }, [connections, enabled, nodes, ownerId, scope, showHighlights, tracker]);
    const scopedState = state.scope === scope ? state : { progress: emptyProgress, latestResultIds: noIds, highlightedNodeIds: noIds };
    const locateLatest = useCallback(() => {
        const ids = state.scope === scope ? state.latestResultIds : [];
        if (!ids.length) return;
        locate.current(ids);
        showHighlights(ids);
    }, [scope, showHighlights, state.latestResultIds, state.scope]);
    return { ...scopedState, locateLatest };
}

export type CanvasTaskFeedbackValue = ReturnType<typeof useCanvasTaskFeedback>;
