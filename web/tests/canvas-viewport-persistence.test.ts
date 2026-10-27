import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createCanvasProjectSaveQueue } from "@/lib/canvas/canvas-project-save-queue";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeGroup, type ViewportTransform } from "@/types/canvas";
import { normalizeCanvasSelectedNodeIds } from "@/lib/canvas/canvas-view-state";

const code = ts.transpileModule(readFileSync(new URL("../src/pages/canvas/use-canvas-persistence.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
}).outputText;

function editor() {
    const refs: { current: unknown }[] = [];
    const effects: { dependencies: unknown[]; cleanup?: () => void }[] = [];
    const pending: (() => void)[] = [];
    const timers = new Map<number, () => void>();
    const listeners = new Map<string, (event?: unknown) => void>();
    const writes: { id: string; viewport: ViewportTransform; selectedNodeIds?: string[] }[] = [];
    let cursor = 0, effectCursor = 0, timerId = 0;
    const surface = {
        visibilityState: "visible",
        addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
        removeEventListener: (name: string) => listeners.delete(name),
    };
    const dependencies: Record<string, unknown> = {
        react: {
            useRef: (value: unknown) => refs[cursor++] ||= { current: value },
            useEffect: (effect: () => void | (() => void), values: unknown[]) => {
                const index = effectCursor++, previous = effects[index];
                if (previous && values.length === previous.dependencies.length && values.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
                pending.push(() => {
                    previous?.cleanup?.();
                    effects[index] = { dependencies: values, cleanup: effect() || undefined };
                });
            },
        },
        "@/lib/canvas/canvas-project-save-queue": {
            createCanvasProjectSaveQueue: (delay: number, flush: (value: unknown) => void) => createCanvasProjectSaveQueue(delay, flush, {
                set: (callback) => { timers.set(++timerId, callback); return timerId; },
                clear: id => { timers.delete(id as number); },
            }),
        },
        "@/stores/canvas/use-canvas-store": { flushCanvasPersistence: () => Promise.resolve(), hasPendingCanvasPersistence: () => false },
        "./use-canvas-history": { canvasHistoryForSave: () => ({ past: [], future: [] }) },
        "@/lib/canvas/canvas-view-state": { normalizeCanvasSelectedNodeIds },
    };
    const module = { exports: {} as { useCanvasPersistence: (options: unknown) => void } };
    new Function("require", "module", "exports", "window", "document", code)((name: string) => dependencies[name], module, module.exports, surface, surface);
    const options = {
        projectId: "first", projectLoaded: true, usePerformanceScenario: false,
        projectSaveQueueRef: { current: { schedule() {}, flush() {}, hasPending: () => false } },
        history: { historyRef: { current: {} }, lastHistoryRef: { current: {} }, historyPausedRef: { current: false }, applyingHistoryRef: { current: false }, historyState: {} },
        current: { nodes: [] as CanvasNodeData[], connections: [], groups: [] as CanvasNodeGroup[], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false },
        updateProject: (id: string, patch: { viewport: ViewportTransform; selectedNodeIds?: string[] }) => writes.push({ id, ...patch }),
        batchEditRunning: false, runningNodeId: null,
        viewport: { x: 0, y: 0, k: 1 },
        selectedNodeIds: undefined as ReadonlySet<string> | undefined,
    };
    const render = (patch: Partial<typeof options> = {}) => {
        Object.assign(options, patch);
        cursor = 0; effectCursor = 0;
        module.exports.useCanvasPersistence(options);
        while (pending.length) pending.shift()!();
    };
    return { render, writes, listeners, surface, timers, options, unmount: () => effects.forEach(effect => effect.cleanup?.()) };
}

test("rapid viewport changes remain debounced and unmount saves the last committed viewport", () => {
    const app = editor();
    app.render();
    app.render({ viewport: { x: 12, y: -7, k: 1.5 } });
    app.render({ viewport: { x: 24, y: -17, k: 2 } });
    expect(app.writes).toEqual([]);
    expect(app.timers.size).toBe(1);
    app.unmount();
    expect(app.writes).toEqual([{ id: "first", viewport: { x: 24, y: -17, k: 2 } }]);
    expect(app.timers.size).toBe(0);
    expect(app.listeners.size).toBe(0);
});

test("page hide and visibility hide flush once without a delayed duplicate", () => {
    const app = editor();
    app.render({ viewport: { x: 80, y: 90, k: 0.5 } });
    app.listeners.get("pagehide")!();
    expect(app.writes).toHaveLength(1);
    expect(app.timers.size).toBe(0);
    app.surface.visibilityState = "hidden";
    app.listeners.get("visibilitychange")!();
    app.unmount();
    expect(app.writes).toHaveLength(1);
});

test("project switching flushes the previous owner's viewport before scheduling the next", () => {
    const app = editor();
    app.render({ viewport: { x: 111, y: 222, k: 2 } });
    app.render({ projectId: "second", viewport: { x: 9, y: 8, k: 1 } });
    expect(app.writes).toEqual([{ id: "first", viewport: { x: 111, y: 222, k: 2 } }]);
    app.unmount();
    expect(app.writes[1]).toEqual({ id: "second", viewport: { x: 9, y: 8, k: 1 } });
});

test("unloaded and performance scenario canvases do not create viewport saves", () => {
    const app = editor();
    app.render({ projectLoaded: false });
    app.render({ projectLoaded: true, usePerformanceScenario: true });
    app.unmount();
    expect(app.writes).toEqual([]);
    expect(app.timers.size).toBe(0);
});

test("selection-only changes and clearing survive page hide together with the last viewport", () => {
    const app = editor();
    const nodes: CanvasNodeData[] = ["one", "two"].map(id => ({ id, type: CanvasNodeType.Text, title: id, position: { x: 0, y: 0 }, width: 100, height: 100 }));
    app.render({ current: { ...app.options.current, nodes }, selectedNodeIds: new Set(["one"]), viewport: { x: 80, y: -30, k: 1.25 } });
    app.render({ selectedNodeIds: new Set(["one", "two", "deleted"]) });
    app.listeners.get("pagehide")!();
    expect(app.writes).toEqual([{ id: "first", viewport: { x: 80, y: -30, k: 1.25 }, selectedNodeIds: ["one", "two"] }]);
    app.render({ selectedNodeIds: new Set() });
    app.unmount();
    expect(app.writes[1].selectedNodeIds).toEqual([]);
});

test("switching project flushes its own selection; collapsing or deleting nodes never persists invisible selections", () => {
    const app = editor();
    const nodes: CanvasNodeData[] = ["one", "two"].map(id => ({ id, type: CanvasNodeType.Text, title: id, position: { x: 0, y: 0 }, width: 100, height: 100 }));
    app.render({ current: { ...app.options.current, nodes }, selectedNodeIds: new Set(["one", "two"]) });
    app.render({ projectId: "second", selectedNodeIds: new Set(["two"]) });
    expect(app.writes[0].selectedNodeIds).toEqual(["one", "two"]);
    app.render({ current: { ...app.options.current, groups: [{ id: "g", title: "折叠组", nodeIds: ["two"], collapsed: true }] } });
    app.unmount();
    expect(app.writes[1]).toEqual({ id: "second", viewport: { x: 0, y: 0, k: 1 }, selectedNodeIds: [] });
});
