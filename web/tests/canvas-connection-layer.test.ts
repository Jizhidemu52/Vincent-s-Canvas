import { expect, test } from "bun:test";

import { createCanvasConnectionDrawBatches, drawCanvasConnections } from "@/lib/canvas/canvas-connection-layer";
import type { CanvasConnectionGeometry } from "@/lib/canvas/canvas-connection-geometry";

const geometry: CanvasConnectionGeometry = {
    d: "M 10 20 C 40 20, 70 80, 100 80",
    points: {
        start: { x: 10, y: 20 },
        controlOne: { x: 40, y: 20 },
        controlTwo: { x: 70, y: 80 },
        end: { x: 100, y: 80 },
    },
    bounds: { minX: 10, minY: 20, maxX: 100, maxY: 80 },
};

test("draws visible connections with separate normal and active styles", () => {
    const calls: string[] = [];
    const context = {
        beginPath: () => calls.push("begin"),
        moveTo: (x: number, y: number) => calls.push(`move:${x},${y}`),
        bezierCurveTo: (...points: number[]) => calls.push(`curve:${points.join(",")}`),
        stroke: () => calls.push("stroke"),
        strokeStyle: "",
        lineWidth: 0,
        globalAlpha: 1,
        shadowBlur: 0,
        shadowColor: "",
    } as unknown as CanvasRenderingContext2D;

    expect(
        drawCanvasConnections(
            context,
            [
                { geometry, active: false },
                { geometry, active: true },
            ],
            { stroke: "#94a3b8", activeStroke: "#2dd4bf" },
        ),
    ).toBe(true);
    expect(calls).toEqual([
        "begin",
        "move:10,20",
        "curve:40,20,70,80,100,80",
        "stroke",
        "begin",
        "move:10,20",
        "curve:40,20,70,80,100,80",
        "stroke",
    ]);
    expect(context.strokeStyle).toBe("#2dd4bf");
    expect(context.lineWidth).toBe(3);
});

test("signals a draw failure so the SVG fallback can be enabled", () => {
    const context = {
        beginPath: () => {
            throw new Error("2d context lost");
        },
    } as unknown as CanvasRenderingContext2D;

    expect(drawCanvasConnections(context, [{ geometry, active: false }], { stroke: "#94a3b8", activeStroke: "#2dd4bf" })).toBe(false);
});

test("batches regular connections into one canvas stroke", () => {
    const calls: string[] = [];
    const context = {
        beginPath: () => calls.push("begin"),
        moveTo: () => calls.push("move"),
        bezierCurveTo: () => calls.push("curve"),
        stroke: () => calls.push("stroke"),
        strokeStyle: "",
        lineWidth: 0,
        globalAlpha: 1,
        shadowBlur: 0,
        shadowColor: "",
    } as unknown as CanvasRenderingContext2D;

    expect(drawCanvasConnections(context, [{ geometry, active: false }, { geometry, active: false }, { geometry, active: true }], { stroke: "#94a3b8", activeStroke: "#2dd4bf" })).toBe(true);
    expect(calls).toEqual(["begin", "move", "curve", "move", "curve", "stroke", "begin", "move", "curve", "stroke"]);
});

test("precomputes normal and active batches before a viewport redraw", () => {
    const regular = { geometry, active: false };
    const active = { geometry, active: true };

    const batches = createCanvasConnectionDrawBatches([regular, active, regular]);

    expect(batches.regular).toEqual([regular, regular]);
    expect(batches.active).toEqual([active]);
});
