import type { CanvasConnectionGeometry } from "@/lib/canvas/canvas-connection-geometry";
import { boundsForViewport, type CanvasBounds } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasConnection, ViewportTransform } from "@/types/canvas";

export type CanvasConnectionDrawItem = {
    id?: string;
    geometry: CanvasConnectionGeometry;
    active: boolean;
};

export type CanvasConnectionPalette = {
    stroke: string;
    activeStroke: string;
};

export type CanvasConnectionDrawBatches = {
    regular: CanvasConnectionDrawItem[];
    active: CanvasConnectionDrawItem[];
};

export function createCanvasConnectionDrawBatches(items: CanvasConnectionDrawItem[]): CanvasConnectionDrawBatches {
    return items.reduce<CanvasConnectionDrawBatches>(
        (batches, item) => {
            batches[item.active ? "active" : "regular"].push(item);
            return batches;
        },
        { regular: [], active: [] },
    );
}

/**
 * During a node drag the static canvas keeps unrelated links painted while a
 * lightweight overlay redraws only links attached to the moving node.
 */
export function filterCanvasConnectionDrawBatches(
    batches: CanvasConnectionDrawBatches,
    connectionIds: ReadonlySet<string>,
    include: boolean,
): CanvasConnectionDrawBatches {
    const filter = (item: CanvasConnectionDrawItem) => (connectionIds.has(item.id || "") ? include : !include);
    return {
        regular: batches.regular.filter(filter),
        active: batches.active.filter(filter),
    };
}

/**
 * Nodes stay mounted with overscan so a pan never exposes a blank region.
 * Connection drawing is more expensive, so it uses only the actual screen
 * bounds (plus a small screen-space safety margin) on each animation frame.
 */
export function canvasConnectionViewportBounds(viewport: ViewportTransform, canvasSize: { width: number; height: number }, screenPadding = 16): CanvasBounds {
    return boundsForViewport(viewport, canvasSize.width, canvasSize.height, screenPadding / Math.max(viewport.k, 0.0001));
}

/**
 * Keeps stable draw batches during a drag. A viewport may contain hundreds of
 * links while only the links attached to the moved node need fresh geometry.
 */
export function createCanvasConnectionDrawCache(resolveGeometry: (connection: CanvasConnection) => CanvasConnectionGeometry | undefined) {
    let previousConnections: CanvasConnection[] | undefined;
    let items: CanvasConnectionDrawItem[] = [];
    let itemById = new Map<string, CanvasConnectionDrawItem>();
    let connectionById = new Map<string, CanvasConnection>();
    let batches: CanvasConnectionDrawBatches = { regular: [], active: [] };
    let activeIds = new Set<string>();

    const reconcile = (connections: CanvasConnection[], nextActiveIds: ReadonlySet<string>) => {
        const nextConnectionById = new Map(connections.map((connection) => [connection.id, connection]));
        const nextItemById = new Map<string, CanvasConnectionDrawItem>();
        const nextItems: CanvasConnectionDrawItem[] = [];

        connections.forEach((connection) => {
            const previousConnection = connectionById.get(connection.id);
            const previousItem = itemById.get(connection.id);
            const canReuseGeometry = previousItem && previousConnection === connection;
            const geometry = canReuseGeometry ? previousItem.geometry : resolveGeometry(connection);
            if (!geometry) return;

            const item = canReuseGeometry ? previousItem : { id: connection.id, geometry, active: false };
            nextItemById.set(connection.id, item);
            nextItems.push(item);
        });

        const activeChanged = !sameConnectionIds(activeIds, nextActiveIds);
        if (activeChanged) {
            nextItems.forEach((item) => {
                item.active = nextActiveIds.has(item.id || "");
            });
            activeIds = new Set(nextActiveIds);
        }

        const itemOrderChanged = nextItems.length !== items.length || nextItems.some((item, index) => item !== items[index]);
        connectionById = nextConnectionById;
        itemById = nextItemById;
        if (itemOrderChanged || activeChanged) {
            items = nextItems;
            batches = createCanvasConnectionDrawBatches(items);
        }
    };

    return {
        sync(connections: CanvasConnection[], nextActiveIds: ReadonlySet<string>, affectedConnectionIds: ReadonlySet<string>, refreshAll: boolean): CanvasConnectionDrawBatches {
            if (previousConnections !== connections) {
                previousConnections = connections;
                reconcile(connections, nextActiveIds);
                return batches;
            }

            const activeChanged = !sameConnectionIds(activeIds, nextActiveIds);
            const idsToRefresh = refreshAll ? connections.map((connection) => connection.id) : affectedConnectionIds;
            for (const id of idsToRefresh) {
                const connection = connectionById.get(id);
                const item = itemById.get(id);
                if (!connection || !item) continue;
                const geometry = resolveGeometry(connection);
                if (geometry) item.geometry = geometry;
            }

            if (activeChanged) {
                itemById.forEach((item, id) => {
                    item.active = nextActiveIds.has(id);
                });
                activeIds = new Set(nextActiveIds);
                batches = createCanvasConnectionDrawBatches(items);
            }
            return batches;
        },
    };
}

function sameConnectionIds(previous: ReadonlySet<string>, next: ReadonlySet<string>) {
    return previous.size === next.size && Array.from(previous).every((id) => next.has(id));
}

export function drawCanvasConnectionBatches(context: CanvasRenderingContext2D, batches: CanvasConnectionDrawBatches, palette: CanvasConnectionPalette, visibleBounds?: CanvasBounds): boolean {
    try {
        const drawBatch = (batch: CanvasConnectionDrawItem[], active: boolean) => {
            if (!batch.length) return;
            context.beginPath();
            let drawn = 0;
            batch.forEach(({ geometry }) => {
                if (visibleBounds && !connectionGeometryIntersectsBounds(geometry, visibleBounds)) return;
                const { start, controlOne, controlTwo, end } = geometry.points;
                context.moveTo(start.x, start.y);
                context.bezierCurveTo(controlOne.x, controlOne.y, controlTwo.x, controlTwo.y, end.x, end.y);
                drawn += 1;
            });
            if (!drawn) return;
            context.strokeStyle = active ? palette.activeStroke : palette.stroke;
            context.lineWidth = active ? 3 : 2;
            context.globalAlpha = active ? 1 : 0.82;
            context.shadowBlur = active ? 8 : 0;
            context.shadowColor = active ? palette.activeStroke : "transparent";
            context.stroke();
        };

        drawBatch(batches.regular, false);
        drawBatch(batches.active, true);
        context.globalAlpha = 1;
        context.shadowBlur = 0;
        context.shadowColor = "transparent";
        return true;
    } catch {
        return false;
    }
}

function connectionGeometryIntersectsBounds(geometry: CanvasConnectionGeometry, bounds: CanvasBounds) {
    const connectionBounds = geometry.bounds;
    return connectionBounds.maxX > bounds.minX && connectionBounds.minX < bounds.maxX && connectionBounds.maxY > bounds.minY && connectionBounds.minY < bounds.maxY;
}

export function drawCanvasConnections(context: CanvasRenderingContext2D, items: CanvasConnectionDrawItem[], palette: CanvasConnectionPalette): boolean {
    return drawCanvasConnectionBatches(context, createCanvasConnectionDrawBatches(items), palette);
}
