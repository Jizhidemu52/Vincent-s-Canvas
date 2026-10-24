import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { canvasNodeResizePointerDelta } from "@/lib/canvas/canvas-node-resize";
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
        resizeRef, resizePreviewFrameRef, pendingResizePreviewRef, CanvasNodeType, canvasNodeResizePointerDelta,
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
    listeners.get("mousemove")!({ clientX: 110, clientY: 100 });
    const second = render(2, 0.5);
    expect(second.handleResizeMove).toBe(first.handleResizeMove);
    expect(second.handleResizeUp).toBe(first.handleResizeUp);
    expect(listeners.size).toBe(2);
    listeners.get("mousemove")!({ clientX: 130, clientY: 100 });
    expect(moves.at(-1)!.slice(0, 4)).toEqual([2, "node", 380, 213.75]);
    listeners.get("mouseup")!();
    expect(finishes[0]!.slice(0, 4)).toEqual([2, "node", 380, 213.75]);
    expect(listeners.size).toBe(0);
    expect(frames.size).toBe(0);
    second.handleResizeMouseDown(down(), "bottom-right");
    listeners.get("mousemove")!({ clientX: 140, clientY: 100 });
    cleanup?.();
    expect(listeners.size).toBe(0);
    expect(frames.size).toBe(0);
    expect(resizeRef.current.isResizing).toBe(false);
    expect(pendingResizePreviewRef.current).toBeNull();
    expect(finishes).toHaveLength(1);
});
