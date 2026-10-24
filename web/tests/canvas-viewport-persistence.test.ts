import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createCanvasProjectSaveQueue } from "@/lib/canvas/canvas-project-save-queue";
import type { ViewportTransform } from "@/types/canvas";

const code = ts.transpileModule(readFileSync(new URL("../src/pages/canvas/use-canvas-persistence.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
}).outputText;

function editor() {
    const refs: { current: unknown }[] = [];
    const effects: { dependencies: unknown[]; cleanup?: () => void }[] = [];
    const pending: (() => void)[] = [];
    const timers = new Map<number, () => void>();
    const listeners = new Map<string, (event?: unknown) => void>();
    const writes: { id: string; viewport: ViewportTransform }[] = [];
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
    };
    const module = { exports: {} as { useCanvasPersistence: (options: unknown) => void } };
    new Function("require", "module", "exports", "window", "document", code)((name: string) => dependencies[name], module, module.exports, surface, surface);
    const options = {
        projectId: "first", projectLoaded: true, usePerformanceScenario: false,
        projectSaveQueueRef: { current: { schedule() {}, flush() {}, hasPending: () => false } },
        history: { historyRef: { current: {} }, lastHistoryRef: { current: {} }, historyPausedRef: { current: false }, applyingHistoryRef: { current: false }, historyState: {} },
        current: { nodes: [], connections: [], groups: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false },
        updateProject: (id: string, patch: { viewport: ViewportTransform }) => writes.push({ id, viewport: patch.viewport }),
        batchEditRunning: false, runningNodeId: null,
        viewport: { x: 0, y: 0, k: 1 },
    };
    const render = (patch: Partial<typeof options> = {}) => {
        Object.assign(options, patch);
        cursor = 0; effectCursor = 0;
        module.exports.useCanvasPersistence(options);
        while (pending.length) pending.shift()!();
    };
    return { render, writes, listeners, surface, timers, unmount: () => effects.forEach(effect => effect.cleanup?.()) };
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
