import type { CanvasConnectionGeometry } from "@/lib/canvas/canvas-connection-geometry";
import type { CanvasConnection } from "@/types/canvas";

export type CanvasConnectionDrawItem = {
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

    const rebuild = (connections: CanvasConnection[], nextActiveIds: ReadonlySet<string>) => {
        items = [];
        itemById = new Map<string, CanvasConnectionDrawItem>();
        connectionById = new Map(connections.map((connection) => [connection.id, connection]));
        connections.forEach((connection) => {
            const geometry = resolveGeometry(connection);
            if (!geometry) return;
            const item = { geometry, active: nextActiveIds.has(connection.id) };
            items.push(item);
            itemById.set(connection.id, item);
        });
        activeIds = new Set(nextActiveIds);
        batches = createCanvasConnectionDrawBatches(items);
    };

    return {
        sync(connections: CanvasConnection[], nextActiveIds: ReadonlySet<string>, affectedConnectionIds: ReadonlySet<string>, refreshAll: boolean): CanvasConnectionDrawBatches {
            if (previousConnections !== connections) {
                previousConnections = connections;
                rebuild(connections, nextActiveIds);
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

export function drawCanvasConnectionBatches(context: CanvasRenderingContext2D, batches: CanvasConnectionDrawBatches, palette: CanvasConnectionPalette): boolean {
    try {
        const drawBatch = (batch: CanvasConnectionDrawItem[], active: boolean) => {
            if (!batch.length) return;
            context.beginPath();
            batch.forEach(({ geometry }) => {
                const { start, controlOne, controlTwo, end } = geometry.points;
                context.moveTo(start.x, start.y);
                context.bezierCurveTo(controlOne.x, controlOne.y, controlTwo.x, controlTwo.y, end.x, end.y);
            });
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

export function drawCanvasConnections(context: CanvasRenderingContext2D, items: CanvasConnectionDrawItem[], palette: CanvasConnectionPalette): boolean {
    return drawCanvasConnectionBatches(context, createCanvasConnectionDrawBatches(items), palette);
}
