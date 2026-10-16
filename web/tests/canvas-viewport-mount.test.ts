import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

type Size = { width: number; height: number };
type Viewport = { x: number; y: number; k: number };
type Container = { getBoundingClientRect: () => Size };
type Effect = () => void | (() => void);

// Evaluate the page's real effect, including its dependencies, without mounting
// unrelated editor services. A callback-only test would miss the original [] bug.
const source = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("project.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects: ts.CallExpression[] = [];
function containsResizeObserver(node: ts.Node): boolean {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "ResizeObserver") return true;
    return ts.forEachChild(node, containsResizeObserver) || false;
}
function collect(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect" && containsResizeObserver(node)) effects.push(node);
    ts.forEachChild(node, collect);
}
collect(ast);
if (effects.length !== 1) throw new Error(`Expected one canvas ResizeObserver effect, found ${effects.length}`);
const code = ts.transpileModule(`${effects[0].getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
}).outputText;
const evaluateEffect = new Function("useEffect", "projectLoaded", "containerRef", "setSize", "ResizeObserver", "viewportRef", "setViewport", "didInitialCenterRef", code);

function harness() {
    let bounds: Size = { width: 1920, height: 1200 };
    let size: Size = { width: 1200, height: 720 };
    let reads = 0;
    const container: Container = {
        getBoundingClientRect: () => { reads += 1; return bounds; },
    };
    const containerRef = { current: null as Container | null };
    const savedViewport: Viewport = { x: -860, y: 145, k: 0.72 };
    const viewportRef = { current: savedViewport };
    const viewportUpdates: Viewport[] = [];
    const sizeUpdates: Size[] = [];
    // Keep the old centering guard false so reintroducing centering cannot pass
    // merely because a mock says the saved viewport was already centered.
    const didInitialCenterRef = { current: false };
    let rendered = false;
    let previousDependencies: readonly unknown[] | undefined;
    let cleanup: void | (() => void);
    const observers: FakeResizeObserver[] = [];
    class FakeResizeObserver {
        observed: Container[] = [];
        disconnects = 0;
        constructor(readonly callback: () => void) { observers.push(this); }
        observe(element: Container) { this.observed.push(element); }
        disconnect() { this.disconnects += 1; }
        notify() { if (!this.disconnects) this.callback(); }
    }
    function useEffect(effect: Effect, dependencies?: readonly unknown[]) {
        const unchanged = rendered && dependencies !== undefined && previousDependencies !== undefined
            && dependencies.length === previousDependencies.length
            && dependencies.every((value, index) => Object.is(value, previousDependencies![index]));
        if (unchanged) return;
        cleanup?.();
        cleanup = effect();
        previousDependencies = dependencies?.slice();
        rendered = true;
    }
    function render(projectLoaded: boolean, mounted = projectLoaded) {
        containerRef.current = mounted ? container : null;
        evaluateEffect(
            useEffect,
            projectLoaded,
            containerRef,
            (next: Size) => { size = next; sizeUpdates.push(next); },
            FakeResizeObserver,
            viewportRef,
            (next: Viewport) => { viewportRef.current = next; viewportUpdates.push(next); },
            didInitialCenterRef,
        );
    }
    return {
        render,
        container,
        observers,
        sizeUpdates,
        viewportRef,
        savedViewport,
        viewportUpdates,
        size: () => size,
        reads: () => reads,
        resize: (next: Size) => { bounds = next; observers.forEach(observer => observer.notify()); },
        unmount: () => { cleanup?.(); cleanup = undefined; },
    };
}

describe("canvas viewport measurement after project loading", () => {
    test("subscribes after the loading screen yields to the canvas and reads its full dimensions", () => {
        const canvas = harness();
        canvas.render(false);
        expect(canvas.observers).toHaveLength(0);
        expect(canvas.reads()).toBe(0);
        expect(canvas.size()).toEqual({ width: 1200, height: 720 });

        canvas.render(true);
        expect(canvas.size()).toEqual({ width: 1920, height: 1200 });
        expect(canvas.reads()).toBe(1);
        expect(canvas.observers).toHaveLength(1);
        expect(canvas.observers[0].observed).toEqual([canvas.container]);

        canvas.render(true);
        expect(canvas.observers).toHaveLength(1);
        expect(canvas.reads()).toBe(1);
        canvas.unmount();
    });

    test("does not measure or subscribe before loading even if a container ref exists", () => {
        const canvas = harness();
        canvas.render(false, true);
        expect(canvas.observers).toHaveLength(0);
        expect(canvas.sizeUpdates).toEqual([]);
        expect(canvas.reads()).toBe(0);
        canvas.unmount();
    });

    test("remeasures on resize and disconnects the observer on unmount", () => {
        const canvas = harness();
        canvas.render(false);
        canvas.render(true);
        canvas.resize({ width: 1365, height: 768 });
        expect(canvas.size()).toEqual({ width: 1365, height: 768 });
        expect(canvas.sizeUpdates).toEqual([{ width: 1920, height: 1200 }, { width: 1365, height: 768 }]);
        expect(canvas.reads()).toBe(2);

        canvas.unmount();
        expect(canvas.observers[0].disconnects).toBe(1);
        canvas.resize({ width: 900, height: 600 });
        expect(canvas.size()).toEqual({ width: 1365, height: 768 });
        expect(canvas.reads()).toBe(2);
    });

    test("loading and resizing preserve the saved pan and zoom without recentering", () => {
        const canvas = harness();
        canvas.render(false);
        canvas.render(true);
        canvas.resize({ width: 1365, height: 768 });
        expect(canvas.viewportUpdates).toEqual([]);
        expect(canvas.viewportRef.current).toBe(canvas.savedViewport);
        expect(canvas.viewportRef.current).toEqual({ x: -860, y: 145, k: 0.72 });
        canvas.unmount();
    });
});
