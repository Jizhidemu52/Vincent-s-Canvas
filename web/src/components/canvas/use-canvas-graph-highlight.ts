import { useMemo } from "react";
import { useCanvasGraphStore } from "@/stores/canvas/canvas-graph-store";
import { buildCanvasRelatedHighlight } from "@/lib/canvas/canvas-related-highlight";
import type { CanvasConnection } from "@/types/canvas";

export type CanvasGraphHighlightInput = {
    selectedNodeId: string | null;
    multipleSelected: boolean;
    connectionAdjacency: ReadonlyMap<string, ReadonlySet<string>>;
    connectionById: ReadonlyMap<string, CanvasConnection>;
};
export function useCanvasGraphHighlight(input: CanvasGraphHighlightInput) {
    const hoveredNodeId = useCanvasGraphStore(state => state.hoveredNodeId);
    const selectedConnectionId = useCanvasGraphStore(state => state.selectedConnectionId);
    const activeNodeId = input.multipleSelected ? null : input.selectedNodeId || hoveredNodeId;
    const related = useMemo(() => buildCanvasRelatedHighlight(activeNodeId, input.connectionAdjacency, input.connectionById),
        [activeNodeId, input.connectionAdjacency, input.connectionById]);
    const activeConnectionIds = useMemo(() => selectedConnectionId ? new Set([...related.connectionIds, selectedConnectionId]) : related.connectionIds,
        [related.connectionIds, selectedConnectionId]);
    return { activeNodeId, related, activeConnectionIds };
}
