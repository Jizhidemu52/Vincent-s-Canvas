import { expect, test } from "bun:test";

import { selectCanvasOverviewConnections } from "@/lib/canvas/canvas-overview-connections";
import type { CanvasConnection } from "@/types/canvas";

const connections: CanvasConnection[] = [
    { id: "a", fromNodeId: "first", toNodeId: "second" },
    { id: "b", fromNodeId: "second", toNodeId: "third" },
];

test("preserves ordinary graph relationships in the far canvas overview", () => {
    expect(selectCanvasOverviewConnections(connections, new Set())).toBe(connections);
});

test("keeps selected connection context visible in the far canvas overview", () => {
    expect(selectCanvasOverviewConnections(connections, new Set(["b"]))).toBe(connections);
});

test("only exceptionally dense graphs fall back to selected paths", () => {
    const dense = Array.from({ length: 2001 }, (_, index) => ({ id: String(index), fromNodeId: "a", toNodeId: "b" }));
    expect(selectCanvasOverviewConnections(dense, new Set(["10"]))).toEqual([dense[10]]);
    expect(selectCanvasOverviewConnections(dense, new Set())).toEqual([]);
});
