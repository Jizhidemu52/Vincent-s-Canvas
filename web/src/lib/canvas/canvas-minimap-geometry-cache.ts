import type { MinimapNodeGeometry } from "@/lib/canvas/canvas-minimap-layout";
import type { CanvasNodeData } from "@/types/canvas";

type CachedGeometry = { source: CanvasNodeData; geometry: MinimapNodeGeometry };

function sameGeometry(node: CanvasNodeData, geometry: MinimapNodeGeometry) {
    return node.id === geometry.id && node.type === geometry.type && node.position.x === geometry.position.x && node.position.y === geometry.position.y && node.width === geometry.width && node.height === geometry.height;
}

/**
 * Keeps the small map's input stable when a canvas mutation changes only
 * media content, title, status, or prompt. That prevents layout and drawing
 * work for every streamed/batched result.
 */
export function createCanvasMinimapGeometryCache() {
    let byId = new Map<string, CachedGeometry>();
    let previous: MinimapNodeGeometry[] = [];
    let previousLiveNodesById: ReadonlyMap<string, CanvasNodeData> | undefined;

    return {
        select(nodes: readonly CanvasNodeData[], liveNodesById?: ReadonlyMap<string, CanvasNodeData>) {
            // The project replaces this map whenever minimap geometry/order can
            // change. Content streams mutate values in the same map, so the
            // minimap can retain its geometry list without walking every node.
            if (liveNodesById && previousLiveNodesById === liveNodesById) return previous;
            const nextById = new Map<string, CachedGeometry>();
            const next = nodes.map((node) => {
                const cached = byId.get(node.id);
                const geometry = cached && sameGeometry(node, cached.geometry)
                    ? cached.geometry
                    : { id: node.id, type: node.type, position: { x: node.position.x, y: node.position.y }, width: node.width, height: node.height };
                nextById.set(node.id, { source: node, geometry });
                return geometry;
            });
            const unchanged = next.length === previous.length && next.every((geometry, index) => geometry === previous[index]);
            byId = nextById;
            previousLiveNodesById = liveNodesById;
            if (unchanged) return previous;
            previous = next;
            return previous;
        },
    };
}
