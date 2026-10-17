import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ComponentProps } from "react";
import ts from "typescript";
import type { CanvasConnectionLayer, CanvasConnectionLayerHandle } from "@/components/canvas/canvas-connection-layer";
import type { CanvasOverviewLayer, CanvasOverviewLayerHandle } from "@/components/canvas/canvas-overview-layer";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

// Evaluate the real component with isolated hooks/canvas surfaces. No mock.module,
// global DOM replacement, browser, service, or network request is involved.
const compile = (filename: string) => ts.transpileModule(readFileSync(new URL(filename, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const compiledLayers = {
    connection: compile("../src/components/canvas/canvas-connection-layer.tsx"),
    overview: compile("../src/components/canvas/canvas-overview-layer.tsx"),
};
type LayerProps = ComponentProps<typeof CanvasConnectionLayer>;
type OverviewProps = ComponentProps<typeof CanvasOverviewLayer>;
type HookEffect = () => void | (() => void);
type Dependencies = readonly unknown[] | undefined;
type ResizeEntry = { contentRect: { width: number; height: number } };

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const firstPreview: ViewportTransform = { x: 20, y: 30, k: 1.5 };
const secondPreview: ViewportTransform = { x: 60, y: 50, k: 1.8 };

function harness(kind: "connection" | "overview" = "connection") {
    const hookCells: unknown[] = [];
    let hookCursor = 0;
    let effects: Array<() => void> = [];
    const sameDependencies = (previous: Dependencies, next: Dependencies) => Boolean(previous && next && previous.length === next.length && previous.every((value, index) => Object.is(value, next[index])));
    const useRef = <T,>(initial: T): { current: T } => {
        const index = hookCursor++;
        if (!hookCells[index]) hookCells[index] = { current: initial };
        return hookCells[index] as { current: T };
    };
    const useCallback = <T,>(callback: T, dependencies: Dependencies): T => {
        const index = hookCursor++;
        const previous = hookCells[index] as { value: T; dependencies: Dependencies } | undefined;
        if (!previous || !sameDependencies(previous.dependencies, dependencies)) hookCells[index] = { value: callback, dependencies };
        return (hookCells[index] as { value: T }).value;
    };
    const useMemo = <T,>(create: () => T, dependencies: Dependencies): T => {
        const index = hookCursor++;
        const previous = hookCells[index] as { value: T; dependencies: Dependencies } | undefined;
        if (!previous || !sameDependencies(previous.dependencies, dependencies)) hookCells[index] = { value: create(), dependencies };
        return (hookCells[index] as { value: T }).value;
    };
    const useLayoutEffect = (effect: HookEffect, dependencies?: readonly unknown[]) => {
        const index = hookCursor++;
        const previous = hookCells[index] as { dependencies: Dependencies; cleanup?: () => void } | undefined;
        if (!previous || !sameDependencies(previous.dependencies, dependencies)) effects.push(() => {
            previous?.cleanup?.();
            hookCells[index] = { dependencies, cleanup: effect() };
        });
    };
    const fakeReact = {
        memo: (component: unknown) => component,
        forwardRef: (component: unknown) => component,
        useRef, useCallback, useMemo, useLayoutEffect,
        useImperativeHandle: (ref: { current: unknown }, create: () => unknown, dependencies?: readonly unknown[]) => useLayoutEffect(() => { ref.current = create(); }, dependencies),
    };

    const paints: Array<{ surface: number; viewport: ViewportTransform }> = [];
    const clearCalls: number[] = [];
    const bufferAssignments: Array<{ surface: number; dimension: "width" | "height"; value: number }> = [];
    const surfaces: FakeCanvas[] = [];
    const host = { getBoundingClientRect: () => ({ width: 1000, height: 700 }) };
    class FakeCanvas {
        private backingWidth = 300;
        private backingHeight = 150;
        readonly parentElement = host;
        readonly surface = surfaces.length;
        private x = 0;
        private y = 0;
        private k = 1;
        private context = {
            setTransform: () => {},
            clearRect: () => { clearCalls.push(this.surface); },
            translate: (x: number, y: number) => { this.x = x; this.y = y; },
            scale: (k: number) => { this.k = k; },
            beginPath: () => {}, moveTo: () => {}, bezierCurveTo: () => {}, rect: () => {}, fill: () => {},
            stroke: () => { paints.push({ surface: this.surface, viewport: { x: this.x, y: this.y, k: this.k } }); },
        };
        constructor() { surfaces.push(this); }
        get width() { return this.backingWidth; }
        set width(value: number) { this.backingWidth = value; bufferAssignments.push({ surface: this.surface, dimension: "width", value }); }
        get height() { return this.backingHeight; }
        set height(value: number) { this.backingHeight = value; bufferAssignments.push({ surface: this.surface, dimension: "height", value }); }
        getContext() { return this.context; }
    }
    const jsx = (type: unknown, props: { ref?: { current: FakeCanvas | null } }) => {
        if (type === "canvas" && props.ref && !props.ref.current) props.ref.current = new FakeCanvas();
        return null;
    };
    const observers: FakeResizeObserver[] = [];
    class FakeResizeObserver {
        connected = false;
        constructor(readonly callback: (entries: ResizeEntry[]) => void) { observers.push(this); }
        observe() { this.connected = true; }
        disconnect() { this.connected = false; }
    }
    const fakeRequire = (name: string): unknown => {
        if (name === "react") return { ...fakeReact, default: fakeReact };
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
        if (name === "@/stores/use-theme-store") return { useThemeStore: () => "light" };
        return require(name);
    };
    const moduleResult = { exports: {} as Record<string, unknown> };
    const windowListeners = new Map<string, Set<() => void>>();
    const fakeWindow = {
        devicePixelRatio: 2,
        addEventListener: (event: string, listener: () => void) => {
            const listeners = windowListeners.get(event) || new Set<() => void>();
            listeners.add(listener);
            windowListeners.set(event, listeners);
        },
        removeEventListener: (event: string, listener: () => void) => { windowListeners.get(event)?.delete(listener); },
    };
    new Function("require", "module", "exports", "window", "ResizeObserver", compiledLayers[kind])(fakeRequire, moduleResult, moduleResult.exports, fakeWindow, FakeResizeObserver);
    type LayerHandle = CanvasConnectionLayerHandle | CanvasOverviewLayerHandle;
    const Component = moduleResult.exports[kind === "connection" ? "CanvasConnectionLayer" : "CanvasOverviewLayer"] as (props: LayerProps | OverviewProps, ref: { current: LayerHandle | null }) => unknown;
    const ref: { current: LayerHandle | null } = { current: null };
    const from: CanvasNodeData = { id: "from", type: CanvasNodeType.Text, title: "from", position: { x: 10, y: 10 }, width: 100, height: 100 };
    const to: CanvasNodeData = { id: "to", type: CanvasNodeType.Text, title: "to", position: { x: 300, y: 20 }, width: 100, height: 100 };
    let props: LayerProps | OverviewProps = kind === "connection" ? {
        connections: [{ id: "edge", fromNodeId: from.id, toNodeId: to.id }],
        resolveNode: id => id === from.id ? from : id === to.id ? to : undefined,
        viewport: initialViewport,
        activeConnectionIds: new Set(), affectedConnectionIds: new Set(), isDraggingNodes: false,
        onDrawFailure: () => { throw new Error("Unexpected canvas draw failure"); },
    } : {
        nodesById: new Map([[from.id, from], [to.id, to]]),
        excludedNodeIds: new Set(), viewport: initialViewport,
        onDrawFailure: () => { throw new Error("Unexpected overview draw failure"); },
    };
    const render = (patch: Partial<LayerProps & OverviewProps> = {}) => {
        props = { ...props, ...patch };
        hookCursor = 0;
        effects = [];
        Component(props, ref);
        for (const effect of effects) effect();
    };
    render();
    return {
        render, paints, clearCalls, bufferAssignments,
        draw: (viewport: ViewportTransform) => ref.current!.draw(viewport),
        resize: () => { for (const observer of observers) if (observer.connected) observer.callback([{ contentRect: { width: 1000, height: 700 } }]); },
        windowResize: () => { for (const listener of windowListeners.get("resize") || []) listener(); },
        get lastPaint() { return paints.at(-1)!.viewport; },
    };
}

test("same-size ResizeObserver callbacks preserve the latest imperative viewport preview", () => {
    const h = harness();
    h.draw(firstPreview);
    const clears = h.clearCalls.length;
    h.resize();
    expect(h.lastPaint).toEqual(firstPreview);
    expect(h.clearCalls).toHaveLength(clears);
});

test("active-link prop rerenders repaint at the live preview rather than the old committed viewport", () => {
    const h = harness();
    h.draw(firstPreview);
    const paints = h.paints.length;
    h.render({ activeConnectionIds: new Set(["edge"]) });
    expect(h.paints).toHaveLength(paints + 1);
    expect(h.lastPaint).toEqual(firstPreview);
});

test("a delayed first-preview prop cannot roll back a newer imperative preview", () => {
    const h = harness();
    h.draw(firstPreview);
    h.draw(secondPreview);
    const clears = h.clearCalls.length;
    // The virtualization callback publishes the same preview object it received.
    h.render({ viewport: firstPreview });
    expect(h.lastPaint).toEqual(secondPreview);
    expect(h.clearCalls).toHaveLength(clears);
    h.resize();
    expect(h.lastPaint).toEqual(secondPreview);
});

test("a new external viewport still replaces an outstanding preview and survives resize", () => {
    const h = harness();
    h.draw(firstPreview);
    h.draw(secondPreview);
    h.render({ viewport: firstPreview });
    const external: ViewportTransform = { x: 120, y: 80, k: 0.8 };
    h.render({ viewport: external });
    expect(h.lastPaint).toEqual(external);
    h.resize();
    expect(h.lastPaint).toEqual(external);
});

test("repeated identical viewport draws neither repaint nor reallocate canvas buffers", () => {
    const h = harness();
    const assignments = h.bufferAssignments.length;
    h.draw(firstPreview);
    expect(h.lastPaint).toEqual(firstPreview);
    const paints = h.paints.length;
    const clears = h.clearCalls.length;
    h.draw(firstPreview);
    h.draw({ ...firstPreview });
    expect(h.paints).toHaveLength(paints);
    expect(h.clearCalls).toHaveLength(clears);
    expect(h.bufferAssignments).toHaveLength(assignments);
});

test("overview resize callbacks preserve the latest imperative preview without reallocating buffers", () => {
    const h = harness("overview");
    h.draw(firstPreview);
    const assignments = h.bufferAssignments.length;
    h.resize();
    expect(h.lastPaint).toEqual(firstPreview);
    h.windowResize();
    expect(h.lastPaint).toEqual(firstPreview);
    expect(h.bufferAssignments).toHaveLength(assignments);
});

test("overview exclusion changes repaint at the live preview rather than the old prop", () => {
    const h = harness("overview");
    h.draw(firstPreview);
    const paints = h.paints.length;
    h.render({ excludedNodeIds: new Set(["from"]) });
    expect(h.paints).toHaveLength(paints + 1);
    expect(h.lastPaint).toEqual(firstPreview);
});

test("overview ignores a delayed preview acknowledgement but accepts a new external viewport", () => {
    const h = harness("overview");
    h.draw(firstPreview);
    h.draw(secondPreview);
    h.render({ viewport: firstPreview });
    expect(h.lastPaint).toEqual(secondPreview);
    h.resize();
    expect(h.lastPaint).toEqual(secondPreview);
    const external: ViewportTransform = { x: 100, y: 40, k: 0.9 };
    h.render({ viewport: external });
    expect(h.lastPaint).toEqual(external);
    h.resize();
    expect(h.lastPaint).toEqual(external);
});
