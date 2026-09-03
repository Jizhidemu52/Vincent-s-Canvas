import { expect, test } from "bun:test";

import { canvasActiveConnectionPathD } from "@/components/canvas/canvas-connections";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const source: CanvasNodeData = {
    id: "source",
    type: CanvasNodeType.Text,
    title: "source",
    position: { x: 0, y: 0 },
    width: 100,
    height: 50,
};

const target: CanvasNodeData = {
    id: "target",
    type: CanvasNodeType.Text,
    title: "target",
    position: { x: 300, y: 60 },
    width: 100,
    height: 80,
};

test("builds a source connection path directly to the current pointer", () => {
    expect(canvasActiveConnectionPathD(source, { nodeId: source.id, handleType: "source" }, { x: 240, y: 120 })).toBe("M 100 25 C 170 25, 170 120, 240 120");
});

test("snaps a source connection path to a compatible target node", () => {
    expect(canvasActiveConnectionPathD(source, { nodeId: source.id, handleType: "source" }, { x: 240, y: 120 }, target)).toBe("M 100 25 C 200 25, 200 100, 300 100");
});
