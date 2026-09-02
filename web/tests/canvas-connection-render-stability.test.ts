import { describe, expect, test } from "bun:test";

import { canvasConnectionRenderStateEqual } from "@/lib/canvas/canvas-connection-render-stability";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const connection: CanvasConnection = { id: "connection-1", fromNodeId: "source", toNodeId: "target" };
const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Text, title: "源", position: { x: 0, y: 0 }, width: 200, height: 100 };
const target: CanvasNodeData = { id: "target", type: CanvasNodeType.Text, title: "目标", position: { x: 400, y: 0 }, width: 200, height: 100 };

describe("canvas connection render stability", () => {
    test("keeps an untouched connection stable during another node drag", () => {
        expect(canvasConnectionRenderStateEqual({ connection, from: source, to: target, active: false }, { connection, from: source, to: target, active: false })).toBe(true);
    });

    test("refreshes a connection when an endpoint or active state changes", () => {
        expect(canvasConnectionRenderStateEqual({ connection, from: source, to: target, active: false }, { connection, from: { ...source, position: { x: 20, y: 0 } }, to: target, active: false })).toBe(false);
        expect(canvasConnectionRenderStateEqual({ connection, from: source, to: target, active: false }, { connection, from: source, to: target, active: true })).toBe(false);
    });

    test("refreshes a connection when the canvas layer falls back to SVG visuals", () => {
        expect(
            canvasConnectionRenderStateEqual(
                { connection, from: source, to: target, active: false, renderVisual: false },
                { connection, from: source, to: target, active: false, renderVisual: true },
            ),
        ).toBe(false);
    });
});
