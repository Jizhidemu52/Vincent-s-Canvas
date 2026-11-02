import { expect, test } from "bun:test";

import { canvasConnectionPalette, canvasConnectionStyle, canvasConnectionViewportBounds, createCanvasConnectionDrawBatches, createCanvasConnectionDrawCache, drawCanvasConnectionBatches, drawCanvasConnections, filterCanvasConnectionDrawBatches } from "@/lib/canvas/canvas-connection-layer";
import type { CanvasConnectionGeometry } from "@/lib/canvas/canvas-connection-geometry";
import { shouldRedrawCanvasConnectionLayer } from "@/lib/canvas/canvas-dynamic-connection-layer";
import { canvasThemes } from "@/lib/canvas-theme";

const arrowContext = { setLineDash() {}, lineTo() {}, closePath() {}, fill() {} };

const geometry: CanvasConnectionGeometry = {
    d: "M 10 20 C 40 20, 70 80, 100 80",
    segments: [{
        start: { x: 10, y: 20 },
        controlOne: { x: 40, y: 20 },
        controlTwo: { x: 70, y: 80 },
        end: { x: 100, y: 80 },
    }],
    bounds: { minX: 10, minY: 20, maxX: 100, maxY: 80 },
};

test("draws visible connections with separate normal and active styles", () => {
    const calls: string[] = [];
    const context = {
        ...arrowContext,
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
        "move:100,80",
        "begin",
        "move:10,20",
        "curve:40,20,70,80,100,80",
        "stroke",
        "begin",
        "move:100,80",
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

test("stroke widths stay legible in screen pixels at different zoom levels", () => {
    const widths: number[] = [];
    const context = { ...arrowContext, beginPath() {}, moveTo() {}, bezierCurveTo() {}, stroke() { widths.push(this.lineWidth); }, lineWidth: 0 } as unknown as CanvasRenderingContext2D;
    for (const scale of [0.25, 0.5, 2]) {
        drawCanvasConnectionBatches(context, { regular: [{ geometry, active: false }], active: [{ geometry, active: true }] }, { stroke: "gray", activeStroke: "green" }, undefined, scale);
    }
    expect(widths).toEqual([4, 12, 4, 6, 1, 1.5]);
});

test("batches regular connections into one canvas stroke", () => {
    const calls: string[] = [];
    const context = {
        ...arrowContext,
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
    expect(calls).toEqual(["begin", "move", "curve", "move", "curve", "stroke", "begin", "move", "move", "begin", "move", "curve", "stroke", "begin", "move"]);
});

test("skips offscreen connection paths while preserving curves that cross the viewport", () => {
    const calls: string[] = [];
    const context = {
        ...arrowContext,
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
    expect(calls).toEqual(["begin", "move:10", "curve", "stroke", "begin", "move:100"]);
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

test("committed node moves invalidate static paint even if connections and camera are unchanged", () => {
    const connections = [{ id: "a", fromNodeId: "one", toNodeId: "two" }];
    let currentGeometry = geometry;
    const cache = createCanvasConnectionDrawCache(() => currentGeometry);
    const initial = cache.sync(connections, new Set(), new Set(), true);
    const previousPaint = { hasContent: true, batches: initial, paintKey: "light", viewport: { x: 0, y: 0, k: 1 } };
    currentGeometry = { ...geometry, d: "moved" };
    const moved = cache.sync(connections, new Set(), new Set(), true);
    expect(moved.regular[0].geometry).toBe(currentGeometry);
    expect(shouldRedrawCanvasConnectionLayer(previousPaint, { ...previousPaint, batches: moved })).toBe(true);
    expect(cache.sync(connections, new Set(), new Set(), true)).toBe(moved);
});

test("refreshes retained endpoints when visible connections change in the same update", () => {
    const a = { id: "a", fromNodeId: "one", toNodeId: "two" };
    const b = { id: "b", fromNodeId: "one", toNodeId: "three" };
    let currentGeometry = geometry;
    const cache = createCanvasConnectionDrawCache(() => currentGeometry);
    cache.sync([a], new Set(), new Set(), true);
    currentGeometry = { ...geometry, d: "after undo" };
    const updated = cache.sync([a, b], new Set(), new Set(), true);
    expect(updated.regular.map(item => item.geometry.d)).toEqual(["after undo", "after undo"]);
});

test("full refresh recovers missing endpoints and removes stale endpoint paths", () => {
    const connections = [{ id: "a", fromNodeId: "one", toNodeId: "two" }];
    let currentGeometry: CanvasConnectionGeometry | undefined;
    const cache = createCanvasConnectionDrawCache(() => currentGeometry);
    expect(cache.sync(connections, new Set(["a"]), new Set(), true).active).toEqual([]);
    currentGeometry = geometry;
    expect(cache.sync(connections, new Set(["a"]), new Set(), true).active[0].id).toBe("a");
    currentGeometry = undefined;
    expect(cache.sync(connections, new Set(["a"]), new Set(), true).active).toEqual([]);
});

test("all connection kinds share themed styles across Canvas and SVG, including active dash patterns", () => {
    for (const theme of Object.values(canvasThemes)) {
        const palette = canvasConnectionPalette(theme);
        const kinds = [undefined, "config-target", "generation-output", "config-sequence", "sequence-input"] as const;
        const styles = kinds.map(kind => canvasConnectionStyle(kind, false, palette));
        expect(new Set(styles.map(style => `${style.stroke}:${style.dash.join(",")}`)).size).toBe(kinds.length);
        for (const kind of kinds) {
            expect(canvasConnectionStyle(kind, true, palette).stroke).toBe(theme.node.activeStroke);
            expect(canvasConnectionStyle(kind, true, palette).dash).toEqual(canvasConnectionStyle(kind, false, palette).dash);
        }
    }
});

test("draws one themed stroke and solid arrow batch per connection kind at fixed screen dimensions", () => {
    const strokes: Array<{ color: string; dash: number[] }> = [];
    const fills: string[] = [];
    const arrowPoints: number[][] = [];
    let dash: number[] = [];
    const context = { ...arrowContext, beginPath() {}, moveTo() {}, bezierCurveTo() {},
        setLineDash(value: number[]) { dash = value; }, lineTo(x: number, y: number) { arrowPoints.push([x, y]); },
        stroke() { strokes.push({ color: this.strokeStyle, dash }); }, fill() { fills.push(this.fillStyle); }, strokeStyle: "", fillStyle: "",
    } as unknown as CanvasRenderingContext2D;
    const items = ["config-target", "config-target", "generation-output"] as const;
    expect(drawCanvasConnectionBatches(context, createCanvasConnectionDrawBatches(items.map(kind => ({ kind, geometry, active: false }))), canvasConnectionPalette(canvasThemes.light), undefined, 0.5)).toBe(true);
    expect(strokes).toEqual([{ color: canvasThemes.light.toolbar.highResolution, dash: [16, 10] }, { color: canvasThemes.light.canvas.selectionStroke, dash: [] }]);
    expect(fills).toEqual(strokes.map(stroke => stroke.color));
    expect(arrowPoints[0]).toEqual([84, 72]);
    expect(arrowPoints[1]).toEqual([84, 88]);
    expect(dash).toEqual([]);
});

test("kind changes invalidate cached batches even when the path geometry is unchanged", () => {
    const edge = { id: "edge", fromNodeId: "from", toNodeId: "to", kind: "config-target" as const };
    const cache = createCanvasConnectionDrawCache(() => geometry);
    const initial = cache.sync([edge], new Set(), new Set(), false);
    const updated = cache.sync([{ ...edge, kind: "generation-output" }], new Set(), new Set(), false);
    expect(updated).not.toBe(initial);
    expect(updated.regular[0].kind).toBe("generation-output");
});
