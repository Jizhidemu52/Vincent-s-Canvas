import { expect, test } from "bun:test";

import { buildCanvasRelatedHighlight } from "@/lib/canvas/canvas-related-highlight";
import { createConnectionAdjacency } from "@/lib/canvas/canvas-connection-geometry";
import type { CanvasConnection } from "@/types/canvas";

const connections: CanvasConnection[] = [
    { id: "ab", fromNodeId: "a", toNodeId: "b" },
    { id: "ac", fromNodeId: "a", toNodeId: "c" },
    { id: "de", fromNodeId: "d", toNodeId: "e" },
];

test("builds a node highlight from only adjacent connections", () => {
    const highlight = buildCanvasRelatedHighlight("a", createConnectionAdjacency(connections), new Map(connections.map((connection) => [connection.id, connection])));

    expect([...highlight.connectionIds]).toEqual(["ab", "ac"]);
    expect([...highlight.nodeIds]).toEqual(["a", "b", "c"]);
});

test("returns no related highlight when no node is active", () => {
    const highlight = buildCanvasRelatedHighlight(null, createConnectionAdjacency(connections), new Map(connections.map((connection) => [connection.id, connection])));

    expect([...highlight.connectionIds]).toEqual([]);
    expect([...highlight.nodeIds]).toEqual([]);
});
