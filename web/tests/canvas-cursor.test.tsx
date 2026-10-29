import { i18nHarness } from "./helpers/i18n-harness";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type DependencyList, type EffectCallback, type ReactElement } from "react";
import ts from "typescript";

const componentUrl = new URL("../src/components/canvas/wireless-canvas.tsx", import.meta.url);
const requireModule = createRequire(componentUrl);
const code = ts.transpileModule(readFileSync(componentUrl, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

class Surface extends EventTarget {
    clientWidth = 800;
    clientHeight = 600;
    captures: number[] = [];
    constructor(private match = "") { super(); }
    closest(selector: string) { return this.match && selector.includes(this.match) ? this : null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
    setPointerCapture(id: number) { this.captures.push(id); }
}

/** Same isolated hook approach as the toolbar tests; event and viewport helpers stay real. */
function canvasHarness(mode: "select" | "hand" = "select", theme: "light" | "dark" = "light") {
    const values: any[] = [];
    const effects: Array<{ dependencies?: DependencyList; cleanup?: ReturnType<EffectCallback> }> = [];
    const pendingEffects: Array<() => void> = [];
    const timers = new Map<number, () => void>();
    const frames = new Map<number, FrameRequestCallback>();
    let cursor = 0;
    let timerId = 0;
    let mounted = true;
    const equal = (left?: DependencyList, right?: DependencyList) => Boolean(left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index])));
    const memo = (factory: () => unknown, dependencies?: DependencyList) => {
        const index = cursor++;
        if (!values[index] || !equal(values[index].dependencies, dependencies)) values[index] = { dependencies, value: factory() };
        return values[index].value;
    };
    const canvasWindow = Object.assign(new EventTarget(), {
        setTimeout(callback: () => void) { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeout(id: number) { timers.delete(id); },
    });
    const canvasDocument = { body: { style: { cursor: "col-resize" } } };
    const surface = new Surface();
    const interactions: boolean[] = [];
    const viewports: Array<{ x: number; y: number; k: number }> = [];
    let selections = 0;
    let deselections = 0;
    const props = {
        containerRef: { current: surface }, viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "blank",
        interactionMode: mode, children: null,
        onViewportChange: (viewport: { x: number; y: number; k: number }) => viewports.push(viewport),
        onInteractionChange: (value: boolean) => interactions.push(value),
        onCanvasMouseDown: () => selections++, onCanvasDeselect: () => deselections++,
    };
    const dependencies: Record<string, unknown> = {
        react: {
            ...React,
            forwardRef: (component: Function) => (next: object) => component(next, null),
            useImperativeHandle: () => undefined,
            useMemo: memo,
            useCallback: (callback: unknown, deps?: DependencyList) => memo(() => callback, deps),
            useRef: (initial: unknown) => { const index = cursor++; return values[index] ||= { current: initial }; },
            useState: (initial: unknown) => {
                const index = cursor++;
                if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
                return [values[index], (next: any) => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
            },
            useEffect: (effect: EffectCallback, deps?: DependencyList) => {
                const index = cursor++;
                if (!effects[index] || !equal(effects[index].dependencies, deps)) pendingEffects.push(() => {
                    effects[index]?.cleanup?.();
                    effects[index] = { dependencies: deps, cleanup: effect() };
                });
            },
        },
        "@/stores/use-theme-store": { useThemeStore: (select: (state: { theme: string }) => unknown) => select({ theme }) },
    };
    const module = { exports: {} as { WirelessCanvas: (next: object) => ReactElement<any> } };
    new Function("require", "module", "exports", "window", "document", "Element", "requestAnimationFrame", "cancelAnimationFrame", code)(
        (id: string) => id === "@/lib/i18n" ? i18nHarness : ((name: string) => name.endsWith(".css") ? {} : Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name))(id),
        module, module.exports, canvasWindow, canvasDocument, Surface,
        (callback: FrameRequestCallback) => { const id = ++timerId; frames.set(id, callback); return id; },
        (id: number) => frames.delete(id),
    );
    const render = () => {
        cursor = 0;
        const root = module.exports.WirelessCanvas(props);
        for (const effect of pendingEffects.splice(0)) effect();
        return root.props;
    };
    const unmount = () => {
        if (!mounted) return;
        mounted = false;
        effects.forEach(effect => effect.cleanup?.());
    };
    disposers.push(unmount);
    const dispatch = (type: string, extras: object = {}, target?: Surface) => {
        const event = Object.assign(new Event(type, { cancelable: true }), extras);
        if (target) Object.defineProperty(event, "target", { value: target });
        canvasWindow.dispatchEvent(event);
        return event;
    };
    return {
        render, unmount, dispatch, interactions, viewports, surface, document: canvasDocument,
        setMode(next: "select" | "hand") { props.interactionMode = next; },
        get selections() { return selections; }, get deselections() { return deselections; },
        down(button = 0, target = surface) {
            const root = render();
            let stopped = false;
            const event = { button, target, currentTarget: surface, pointerId: 1, clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() { stopped = true; } };
            root.onPointerDownCapture(event);
            if (!stopped) root.onPointerDown(event);
        },
        wheel() { render().onWheel({ target: surface, deltaY: -100, deltaMode: 0, clientX: 100, clientY: 100 }); },
        flushTimers() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
        get scheduledWork() { return timers.size + frames.size; },
    };
}

describe("canvas cursor interactions", () => {
    test("selection and hand modes follow the active tool and theme without changing selection", () => {
        const canvas = canvasHarness("select", "dark");
        expect(canvas.render()).toMatchObject({ "data-cursor-theme": "dark", "data-cursor-mode": "select", "data-cursor-panning": false });
        canvas.down();
        expect(canvas.selections).toBe(1);
        expect(canvas.render()["data-cursor-panning"]).toBe(false);
        canvas.setMode("hand");
        expect(canvas.render()["data-cursor-mode"]).toBe("grab");
        canvas.setMode("select");
        expect(canvas.render()["data-cursor-mode"]).toBe("select");
    });

    test("space is temporary, resets on blur, and does not hijack text input", () => {
        const canvas = canvasHarness();
        canvas.render();
        const space = { code: "Space", isComposing: false, keyCode: 0 };
        expect(canvas.dispatch("keydown", space).defaultPrevented).toBe(true);
        expect(canvas.render()["data-cursor-mode"]).toBe("grab");
        canvas.down();
        expect(canvas.render()["data-cursor-panning"]).toBe(true);
        canvas.dispatch("keyup", space);
        expect(canvas.render()).toMatchObject({ "data-cursor-mode": "select", "data-cursor-panning": true });
        canvas.dispatch("pointerup");
        expect(canvas.render()["data-cursor-panning"]).toBe(false);
        canvas.dispatch("keydown", space);
        canvas.dispatch("blur");
        expect(canvas.render()["data-cursor-mode"]).toBe("select");
        expect(canvas.dispatch("keydown", space, new Surface("textarea")).defaultPrevented).toBe(false);
        expect(canvas.render()["data-cursor-mode"]).toBe("select");
    });

    for (const end of ["pointerup", "pointercancel", "blur"]) {
        test(`a hand pan enters grabbing and returns to grab on ${end}`, () => {
            const canvas = canvasHarness("hand");
            canvas.down();
            expect(canvas.render()["data-cursor-panning"]).toBe(true);
            expect(canvas.surface.captures).toEqual([1]);
            canvas.dispatch("pointermove", { clientX: 130, clientY: 125 });
            canvas.dispatch(end);
            expect(canvas.render()).toMatchObject({ "data-cursor-mode": "grab", "data-cursor-panning": false });
            expect(canvas.interactions).toEqual([true, false]);
            expect(canvas.viewports).toEqual([{ x: 30, y: 25, k: 1 }]);
            expect(canvas.document.body.style.cursor).toBe("col-resize");
        });
    }

    test("middle-button panning returns to select while protected controls do not start a pan", () => {
        const canvas = canvasHarness();
        canvas.down(1);
        expect(canvas.render()["data-cursor-panning"]).toBe(true);
        canvas.dispatch("pointerup");
        expect(canvas.render()).toMatchObject({ "data-cursor-mode": "select", "data-cursor-panning": false });
        canvas.setMode("hand");
        canvas.down(0, new Surface("[data-canvas-no-zoom]"));
        expect(canvas.render()["data-cursor-panning"]).toBe(false);
        expect(canvas.interactions).toEqual([true, false]);
    });

    test("wheel zoom reports interaction without showing a grabbing cursor", () => {
        const canvas = canvasHarness();
        canvas.wheel();
        expect(canvas.interactions).toEqual([true]);
        expect(canvas.render()).toMatchObject({ "data-cursor-mode": "select", "data-cursor-panning": false });
        canvas.flushTimers();
        expect(canvas.interactions).toEqual([true, false]);
        expect(canvas.viewports[0].k).toBeGreaterThan(1);
        expect(canvas.render()["data-cursor-panning"]).toBe(false);
    });

    test("unmount during panning releases listeners and scheduled work without touching global cursor", () => {
        const canvas = canvasHarness("hand");
        canvas.down();
        canvas.dispatch("pointermove", { clientX: 130, clientY: 125 });
        expect(canvas.scheduledWork).toBeGreaterThan(0);
        canvas.unmount();
        expect(canvas.scheduledWork).toBe(0);
        canvas.dispatch("pointerup");
        canvas.dispatch("blur");
        canvas.dispatch("pointermove", { clientX: 150, clientY: 150 });
        expect(canvas.interactions).toEqual([true]);
        expect(canvas.viewports).toEqual([]);
        expect(canvas.scheduledWork).toBe(0);
        expect(canvas.document.body.style.cursor).toBe("col-resize");
    });
});
