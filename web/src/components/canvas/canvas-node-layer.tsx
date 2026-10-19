import { memo, useMemo, type ComponentProps } from "react";
import { CanvasNode } from "./canvas-node";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { useCanvasGraphStore } from "@/stores/canvas/canvas-graph-store";
import { useCanvasGraphHighlight, type CanvasGraphHighlightInput } from "./use-canvas-graph-highlight";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

type NodeProps = ComponentProps<typeof CanvasNode>;
export type CanvasNodeLayerProps = {
    nodes: CanvasNodeData[];
    highlight: CanvasGraphHighlightInput;
    nodeProps: (node: CanvasNodeData) => Omit<NodeProps, "data" | "isSelected" | "isMultiSelected" | "isRelated" | "isFocusRelated" | "resourceLabel">;
    resourceReferences: (activeNodeId: string | null) => Map<string, CanvasResourceReference>;
    globalReferences: { get: (id: string) => CanvasResourceReference | undefined };
};

/** Streaming tokens subscribe at the individual node, not the editor or node list. */
const GraphNode = memo(function GraphNode({ nodeId, ...props }: Omit<NodeProps, "data" | "isSelected" | "isMultiSelected"> & { nodeId: string }) {
    const node = useCanvasGraphStore(state => state.nodeById.get(nodeId));
    const streamedContent = useCanvasGraphStore(state => state.streamedTextById.get(nodeId));
    const isSelected = useCanvasGraphStore(state => state.selectedNodeIds.has(nodeId));
    const isMultiSelected = useCanvasGraphStore(state => state.selectedNodeIds.size > 1 && state.selectedNodeIds.has(nodeId));
    const data = useMemo<CanvasNodeData | undefined>(() => node && streamedContent !== undefined
        ? { ...node, type: CanvasNodeType.Text, metadata: { ...node.metadata, content: streamedContent, status: "loading" } }
        : node, [node, streamedContent]);
    return data ? <CanvasNode {...props} data={data} isSelected={isSelected} isMultiSelected={isMultiSelected} /> : null;
});

export const CanvasNodeLayer = memo(function CanvasNodeLayer({ nodes, highlight, nodeProps, resourceReferences, globalReferences }: CanvasNodeLayerProps) {
    const { activeNodeId, related } = useCanvasGraphHighlight(highlight);
    const references = useMemo(() => resourceReferences(activeNodeId), [resourceReferences, activeNodeId]);
    return nodes.map(node => <GraphNode key={node.id} nodeId={node.id} {...nodeProps(node)}
        isRelated={related.nodeIds.has(node.id)} isFocusRelated={activeNodeId === node.id}
        resourceLabel={references.get(node.id) || globalReferences.get(node.id)} />);
});
