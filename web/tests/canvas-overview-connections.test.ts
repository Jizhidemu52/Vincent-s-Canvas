import { expect, test } from "bun:test";

import { selectCanvasOverviewConnections } from "@/lib/canvas/canvas-overview-connections";
import type { CanvasConnection } from "@/types/canvas";

const connections: CanvasConnection[] = [
    { id: "a", fromNodeId: "first", toNodeId: "second" },
    { id: "b", fromNodeId: "second", toNodeId: "third" },
];

test("hides non-selected connection clutter in the far canvas overview", () => {
    expect(selectCanvasOverviewConnections(connections, new Set())).toEqual([]);
});

test("keeps selected connection context visible in the far canvas overview", () => {
    expect(selectCanvasOverviewConnections(connections, new Set(["b"]))).toEqual([connections[1]]);
});
