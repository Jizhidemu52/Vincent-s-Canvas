import { memo, type ReactNode } from "react";
import { useCanvasGraphStore } from "@/stores/canvas/canvas-graph-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/** Hovered toolbar changes must not rerun the full editor. */
export const CanvasHoverToolbarHost = memo(function CanvasHoverToolbarHost({ selectedNode, multipleSelected, children }: {
    selectedNode: CanvasNodeData | null;
    multipleSelected: boolean;
    children: (node: CanvasNodeData) => ReactNode;
}) {
    const hovered = useCanvasGraphStore(state => state.toolbarNodeId ? state.nodeById.get(state.toolbarNodeId) : undefined);
    const node = multipleSelected ? null : selectedNode || (hovered?.type === CanvasNodeType.Image ? null : hovered);
    return node ? children(node) : null;
});
