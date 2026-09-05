import type { CanvasNodeData } from "@/types/canvas";

/**
 * Preserves the reference-image subset used by the Agent panel. A change to
 * an unrelated canvas node must not make the panel re-render its chat and
 * media history.
 */
export function createCanvasSelectedNodeCache() {
    let previous: CanvasNodeData[] = [];

    return {
        select(nodes: readonly CanvasNodeData[], selectedNodeIds: ReadonlySet<string>, liveNodesById?: ReadonlyMap<string, CanvasNodeData>, nodeOrderById?: ReadonlyMap<string, number>) {
            // The selected subset is usually tiny compared with a production
            // canvas. Use the live node map when available so a streamed
            // update does not filter every node just to refresh Agent input.
            const next = liveNodesById
                ? Array.from(selectedNodeIds)
                      .map((nodeId) => liveNodesById.get(nodeId))
                      .filter((node): node is CanvasNodeData => Boolean(node))
                      .sort((first, second) => (nodeOrderById?.get(first.id) ?? 0) - (nodeOrderById?.get(second.id) ?? 0))
                : nodes.filter((node) => selectedNodeIds.has(node.id));
            if (next.length === previous.length && next.every((node, index) => node === previous[index])) return previous;
            previous = next;
            return previous;
        },
    };
}
