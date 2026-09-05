import { expect, test } from "bun:test";

import { canvasConnectionViewportBounds, createCanvasConnectionDrawBatches, createCanvasConnectionDrawCache, drawCanvasConnectionBatches, drawCanvasConnections, filterCanvasConnectionDrawBatches } from "@/lib/canvas/canvas-connection-layer";
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

test("skips offscreen connection paths while preserving curves that cross the viewport", () => {
    const calls: string[] = [];
    const context = {
        beginPath: () => calls.push("begin"),
        moveTo: (x: number) => calls.push(`move:${x}`),
        bezierCurveTo: () => calls.push("curve"),
        stroke: () => calls.push("stroke"),
        strokeStyle: "",
        lineWidth: 0,
        globalAlpha: 1,
        shadowBlur: 0,
        shadowColor: "",
    } as unknown as CanvasRenderingContext2D;
    const offscreen = { ...geometry, bounds: { minX: 800, minY: 20, maxX: 900, maxY: 80 } };
    const crossing = { ...geometry, bounds: { minX: -20, minY: 20, maxX: 20, maxY: 80 } };

    expect(
        drawCanvasConnectionBatches(
            context,
            createCanvasConnectionDrawBatches([
                { geometry: offscreen, active: false },
                { geometry: crossing, active: false },
            ]),
            { stroke: "#94a3b8", activeStroke: "#2dd4bf" },
            canvasConnectionViewportBounds({ x: 0, y: 0, k: 1 }, { width: 400, height: 300 }),
        ),
    ).toBe(true);
    expect(calls).toEqual(["begin", "move:10", "curve", "stroke"]);
});

test("precomputes normal and active batches before a viewport redraw", () => {
    const regular = { geometry, active: false };
    const active = { geometry, active: true };

    const batches = createCanvasConnectionDrawBatches([regular, active, regular]);

    expect(batches.regular).toEqual([regular, regular]);
    expect(batches.active).toEqual([active]);
});

test("separates moved-node links from the static connection layer", () => {
    const still = { id: "still", geometry, active: false };
    const moving = { id: "moving", geometry, active: false };
    const activeMoving = { id: "active-moving", geometry, active: true };
    const batches = createCanvasConnectionDrawBatches([still, moving, activeMoving]);

    expect(filterCanvasConnectionDrawBatches(batches, new Set(["moving", "active-moving"]), false)).toEqual({ regular: [still], active: [] });
    expect(filterCanvasConnectionDrawBatches(batches, new Set(["moving", "active-moving"]), true)).toEqual({ regular: [moving], active: [activeMoving] });
});

test("refreshes only affected connection geometry while a drag is active", () => {
    const connections = [
        { id: "a", fromNodeId: "one", toNodeId: "two" },
        { id: "b", fromNodeId: "three", toNodeId: "four" },
    ];
    const resolved: string[] = [];
    const cache = createCanvasConnectionDrawCache((connection) => {
        resolved.push(connection.id);
        return { ...geometry, d: `${geometry.d} ${connection.id}` };
    });

    const initial = cache.sync(connections, new Set(), new Set(), true);
    resolved.length = 0;
    const updated = cache.sync(connections, new Set(), new Set(["a"]), false);

    expect(resolved).toEqual(["a"]);
    expect(updated).toBe(initial);
    expect(updated.regular.map((item) => item.geometry.d)).toEqual([`${geometry.d} a`, `${geometry.d} b`]);
});

test("keeps cached geometry when a connection is appended", () => {
    const connections = [
        { id: "a", fromNodeId: "one", toNodeId: "two" },
        { id: "b", fromNodeId: "three", toNodeId: "four" },
    ];
    const resolved: string[] = [];
    const cache = createCanvasConnectionDrawCache((connection) => {
        resolved.push(connection.id);
        return { ...geometry, d: `${geometry.d} ${connection.id}` };
    });

    cache.sync(connections, new Set(), new Set(), true);
    resolved.length = 0;
    const updated = cache.sync([...connections, { id: "c", fromNodeId: "five", toNodeId: "six" }], new Set(), new Set(), false);

    expect(resolved).toEqual(["c"]);
    expect(updated.regular.map((item) => item.id)).toEqual(["a", "b", "c"]);
});

test("keeps the correct connection active when an unresolved connection is skipped", () => {
    const connections = [
        { id: "missing", fromNodeId: "one", toNodeId: "two" },
        { id: "visible", fromNodeId: "three", toNodeId: "four" },
    ];
    const cache = createCanvasConnectionDrawCache((connection) => (connection.id === "missing" ? undefined : geometry));

    cache.sync(connections, new Set(), new Set(), true);
    const updated = cache.sync(connections, new Set(["visible"]), new Set(), false);

    expect(updated.regular).toEqual([]);
    expect(updated.active.map((item) => item.geometry)).toEqual([geometry]);
});
