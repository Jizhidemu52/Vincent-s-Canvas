import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { canvasNodeResizePointerDelta, resolveCanvasNodeResize } from "@/lib/canvas/canvas-node-resize";
import { CanvasNodeType } from "@/types/canvas";

// Exercise the component's actual refs, callbacks and cleanup with dependency-aware hooks.
const source = readFileSync(new URL("../src/components/canvas/canvas-node.tsx", import.meta.url), "utf8");
const start = source.indexOf("    const resizeCallbacksRef =");
const end = source.indexOf("\n    return (", start);
const code = ts.transpileModule(`${source.slice(start, end)}\nreturn { handleResizeMouseDown, handleResizeMove, handleResizeUp };`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

test("active resize survives callback changes, uses latest callbacks and fully releases listeners on unmount", () => {
    const listeners = new Map<string, (event?: any) => void>(), frames = new Map<number, () => void>();
    const resizeRef = { current: {} as any }, resizePreviewFrameRef = { current: null as number | null }, pendingResizePreviewRef = { current: null as any };
    const callbackRef = { current: {} as any };
    const callbacks: Array<{ deps: unknown[]; callback: unknown }> = [];
    let callbackIndex = 0, frameId = 0;
    let effectDeps: unknown[] | undefined, cleanup: (() => void) | undefined;
    const same = (a: unknown[] | undefined, b: unknown[]) => Boolean(a && a.length === b.length && a.every((value, index) => value === b[index]));
    const moves: unknown[][] = [], finishes: unknown[][] = [], previews: unknown[] = [];
    const base = {
        data: { id: "node", type: CanvasNodeType.Image, width: 320, height: 180, position: { x: 10, y: 20 }, metadata: {} },
        resizeRef, resizePreviewFrameRef, pendingResizePreviewRef, CanvasNodeType, canvasNodeResizePointerDelta, resolveCanvasNodeResize, screenToCanvas: undefined,
        window: { addEventListener: (type: string, listener: (event?: any) => void) => listeners.set(type, listener),
            removeEventListener: (type: string, listener: (event?: any) => void) => { if (listeners.get(type) === listener) listeners.delete(type); } },
        requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: (id: number) => frames.delete(id),
        setLocalResizePreview: (value: unknown) => previews.push(value), useRef: () => callbackRef,
        useCallback: (callback: unknown, deps: unknown[]) => {
            const index = callbackIndex++;
            if (!same(callbacks[index]?.deps, deps)) callbacks[index] = { callback, deps };
            return callbacks[index]!.callback;
        },
        useEffect: (effect: () => () => void, deps: unknown[]) => { if (!same(effectDeps, deps)) { cleanup?.(); effectDeps = deps; cleanup = effect(); } },
    };
    const render = (version: number, scale: number) => {
        callbackIndex = 0;
        const scope = { ...base, getCanvasScale: () => scale, onResize: (...args: unknown[]) => moves.push([version, ...args]), onResizeEnd: (...args: unknown[]) => finishes.push([version, ...args]) };
        return new Function("scope", `const { ${Object.keys(scope).join(",")} } = scope; ${code}`)(scope);
    };
    const down = () => ({ stopPropagation() {}, preventDefault() {}, button: 0, clientX: 100, clientY: 100 });
    const first = render(1, 1);
    first.handleResizeMouseDown(down(), "bottom-right");
    listeners.get("pointermove")!({ clientX: 110, clientY: 100, shiftKey: false });
    const second = render(2, 0.5);
    expect(second.handleResizeMove).toBe(first.handleResizeMove);
    expect(second.handleResizeUp).toBe(first.handleResizeUp);
    expect(listeners.size).toBe(5);
    listeners.get("pointermove")!({ clientX: 130, clientY: 100, shiftKey: false });
    const constrained = resolveCanvasNodeResize({ position: base.data.position, width: 320, height: 180, delta: { x: 60, y: 0 }, handle: "bottom-right", keepRatio: true });
    expect(moves.at(-1)!.slice(0, 4)).toEqual([2, "node", constrained.width, constrained.height]);
    listeners.get("pointerup")!();
    expect(finishes[0]!.slice(0, 4)).toEqual([2, "node", constrained.width, constrained.height]);
    expect(listeners.size).toBe(0);
    expect(frames.size).toBe(0);
    second.handleResizeMouseDown(down(), "bottom-right");
    listeners.get("pointermove")!({ clientX: 140, clientY: 100, shiftKey: false });
    cleanup?.();
    expect(listeners.size).toBe(0);
    expect(frames.size).toBe(0);
    expect(resizeRef.current.isResizing).toBe(false);
    expect(pendingResizePreviewRef.current).toBeNull();
    expect(finishes).toHaveLength(1);
});

function resizeGesture(width: number, height: number) {
    const listeners = new Map<string, (event?: any) => void>(), frames = new Map<number, () => void>();
    const finishes: unknown[][] = [];
    let activePreview = false, frameId = 0;
    const resizeRef = { current: {} as any }, resizePreviewFrameRef = { current: null as number | null }, pendingResizePreviewRef = { current: null as any };
    const scope = {
        data: { id: "text", type: CanvasNodeType.Text, width, height, position: { x: 10, y: 20 }, metadata: {} },
        resizeRef, resizePreviewFrameRef, pendingResizePreviewRef, CanvasNodeType, canvasNodeResizePointerDelta, resolveCanvasNodeResize,
        getCanvasScale: () => 1, screenToCanvas: undefined,
        onResize: () => { activePreview = true; },
        onResizeEnd: (...args: unknown[]) => { activePreview = false; finishes.push(args); },
        window: { addEventListener: (type: string, listener: (event?: any) => void) => listeners.set(type, listener),
            removeEventListener: (type: string, listener: (event?: any) => void) => { if (listeners.get(type) === listener) listeners.delete(type); } },
        requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: (id: number) => frames.delete(id),
        setLocalResizePreview: () => {}, useRef: (value: unknown) => ({ current: value }),
        useCallback: (callback: unknown) => callback, useEffect: () => {},
    };
    const handlers = new Function("scope", `const { ${Object.keys(scope).join(",")} } = scope; ${code}`)(scope);
    handlers.handleResizeMouseDown({ stopPropagation() {}, preventDefault() {}, button: 0, clientX: 100, clientY: 100 }, "bottom-right");
    return {
        finishes, listeners, frames, resizeRef, pendingResizePreviewRef, active: () => activePreview,
        move: (delta: number) => {
            listeners.get("pointermove")!({ clientX: 100 + delta, clientY: 100 + delta, shiftKey: false, altKey: false });
            const pending = [...frames.values()]; frames.clear(); pending.forEach(frame => frame());
        },
        finish: (type = "pointerup") => listeners.get(type)!({ type, key: "Escape", preventDefault() {}, stopPropagation() {} }),
    };
}

test.each([
    { name: "minimum-sized node clamped on further shrink", width: 120, height: 64, moves: [-20] },
    { name: "node dragged away and back to its original size", width: 320, height: 180, moves: [40, 0] },
])("resize preview ends when there is no net size change: $name", ({ width, height, moves }) => {
    const gesture = resizeGesture(width, height);
    moves.forEach(gesture.move);
    expect(gesture.active()).toBe(true);
    gesture.finish();
    expect(gesture.active()).toBe(false);
    expect(gesture.finishes).toEqual([["text", width, height, { x: 10, y: 20 }]]);
    expect(gesture.listeners.size).toBe(0);
    expect(gesture.frames.size).toBe(0);
    expect(gesture.resizeRef.current.isResizing).toBe(false);
    expect(gesture.pendingResizePreviewRef.current).toBeNull();
});

test.each(["pointercancel", "blur", "keydown"])("%s ends a resize exactly once at its original bounds", type => {
    const gesture = resizeGesture(320, 180);
    gesture.move(40);
    gesture.finish(type);
    expect(gesture.active()).toBe(false);
    expect(gesture.finishes).toEqual([["text", 320, 180, { x: 10, y: 20 }]]);
    expect(gesture.listeners.size).toBe(0);
});

test("pressing and releasing a resize handle without movement does not commit a resize", () => {
    const gesture = resizeGesture(320, 180);
    gesture.finish();
    expect(gesture.finishes).toEqual([]);
    expect(gesture.listeners.size).toBe(0);
});
