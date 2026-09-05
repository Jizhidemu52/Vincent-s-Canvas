import { describe, expect, test } from "bun:test";

import { createCanvasSelectedNodeCache } from "@/lib/canvas/canvas-selected-node-cache";
import type { CanvasNodeData } from "@/types/canvas";

const node = (id: string) => ({ id }) as CanvasNodeData;

describe("canvas selected node cache", () => {
    test("keeps selected references stable when only unselected nodes change", () => {
        const cache = createCanvasSelectedNodeCache();
        const selected = node("selected");
        const first = cache.select([selected, node("other")], new Set(["selected"]));
        const second = cache.select([selected, node("other-updated")], new Set(["selected"]));

        expect(second).toBe(first);
    });

    test("refreshes references when a selected node changes or selection changes", () => {
        const cache = createCanvasSelectedNodeCache();
        const selected = node("selected");
        const first = cache.select([selected], new Set(["selected"]));
        const changed = cache.select([node("selected")], new Set(["selected"]));
        const deselected = cache.select([node("selected")], new Set());

        expect(changed).not.toBe(first);
        expect(deselected).toEqual([]);
    });

    test("uses the live node map for selected updates while preserving canvas order", () => {
        const cache = createCanvasSelectedNodeCache();
        const first = node("first");
        const middle = node("middle");
        const last = node("last");
        const liveNodesById = new Map([
            [first.id, first],
            [middle.id, middle],
            [last.id, last],
        ]);
        const nodeOrderById = new Map([
            [first.id, 0],
            [middle.id, 1],
            [last.id, 2],
        ]);
        const selectedIds = new Set([last.id, first.id]);
        const initial = cache.select([first, middle, last], selectedIds, liveNodesById, nodeOrderById);
        const streamedLast = { ...last, title: "streamed" };
        liveNodesById.set(last.id, streamedLast);

        const refreshed = cache.select([first, middle, last], selectedIds, liveNodesById, nodeOrderById);

        expect(initial).toEqual([first, last]);
        expect(refreshed).toEqual([first, streamedLast]);
        expect(refreshed).not.toBe(initial);
        liveNodesById.set(middle.id, { ...middle, title: "unselected update" });
        expect(cache.select([first, middle, last], selectedIds, liveNodesById, nodeOrderById)).toBe(refreshed);
    });
});
