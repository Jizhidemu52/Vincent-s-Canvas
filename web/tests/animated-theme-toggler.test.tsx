import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React, { type ReactElement } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { i18nHarness } from "./helpers/i18n-harness";

const code = ts.transpileModule(readFileSync(new URL("../src/components/ui/animated-theme-toggler.tsx", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

function deferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    // Observe the component's returned chains so rejection regressions can be
    // asserted directly instead of leaking errors into unrelated Bun tests.
    const branches: Promise<PromiseSettledResult<unknown>[]>[] = [];
    for (const method of ["then", "catch", "finally"] as const) {
        Object.defineProperty(promise, method, { value: (...args: unknown[]) => {
            const branch = Reflect.apply(Promise.prototype[method], promise, args) as Promise<unknown>;
            branches.push(Promise.allSettled([branch]));
            return branch;
        } });
    }
    return { promise, resolve, reject, branches };
}

type TogglerProps = { onThemeChange?: (theme: "light" | "dark") => void };

function harness(options: { noApi?: boolean; startError?: Error; themeError?: Error; animateError?: Error; invokeBeforeStartError?: boolean } = {}) {
    const ready = deferred();
    const finished = deferred();
    const updateCallbackDone = deferred();
    const styles = new Map<string, string>();
    const classes = new Set<string>();
    const applied: string[] = [];
    const reported: unknown[] = [];
    const animations: unknown[][] = [];
    const root = {
        dataset: {} as Record<string, string>,
        classList: {
            contains: (name: string) => classes.has(name),
            toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
        },
        style: {
            colorScheme: "",
            setProperty: (name: string, value: string) => { styles.set(name, value); },
            removeProperty: (name: string) => { styles.delete(name); },
        },
        animate: (...args: unknown[]) => {
            animations.push(args);
            if (options.animateError) throw options.animateError;
        },
    };
    let update!: () => void;
    const document = {
        documentElement: root,
        startViewTransition: options.noApi ? undefined : (callback: () => void) => {
            update = callback;
            if (options.invokeBeforeStartError) callback();
            if (options.startError) throw options.startError;
            return { ready: ready.promise, finished: finished.promise, updateCallbackDone: updateCallbackDone.promise };
        },
    };
    const dependencies: Record<string, unknown> = {
        "@/lib/i18n": i18nHarness,
        "@/lib/utils": { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") },
        "lucide-react": { Moon: () => null, Sun: () => null },
        "react-dom": { flushSync: (callback: () => void) => callback() },
        react: {
            ...React,
            useState: (value: boolean) => [value, () => undefined],
            useEffect: () => undefined,
            useCallback: (callback: unknown) => callback,
            useRef: () => ({ current: { getBoundingClientRect: () => ({ top: 20, left: 10, width: 40, height: 40 }) } }),
        },
        "react/jsx-runtime": jsxRuntime,
    };
    const module = { exports: {} as { AnimatedThemeToggler: (props: TogglerProps) => ReactElement<{ onClick: () => void }> } };
    new Function("require", "module", "exports", "document", "window", code)(
        (name: string) => {
            if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`);
            return dependencies[name];
        },
        module, module.exports, document,
        { innerWidth: 1000, innerHeight: 800, reportError: (error: unknown) => { reported.push(error); } },
    );
    const button = module.exports.AnimatedThemeToggler({ onThemeChange: theme => {
        applied.push(theme);
        if (options.themeError) throw options.themeError;
    } });
    return {
        ready, finished, updateCallbackDone, root, styles, applied, reported, animations,
        click: () => button.props.onClick(),
        update: () => {
            try {
                update();
                updateCallbackDone.resolve();
            } catch (error) {
                // The browser exposes the callback failure through all three
                // promises; the component must report it only once.
                updateCallbackDone.reject(error);
                ready.reject(error);
                finished.reject(error);
            }
        },
        expectClean: () => {
            expect(root.dataset.magicuiThemeVt).toBeUndefined();
            expect([...styles]).toEqual([]);
        },
        expectHandled: async () => {
            const results = await Promise.all([...ready.branches, ...finished.branches, ...updateCallbackDone.branches]);
            expect(results.flat().filter(result => result.status === "rejected")).toEqual([]);
        },
    };
}

describe("animated theme transition", () => {
    test("applies the theme once, waits for ready to animate and cleans up on finish", async () => {
        const h = harness();
        h.click();
        expect(h.applied).toEqual([]);
        expect(h.root.dataset.magicuiThemeVt).toBe("active");
        h.update();
        expect(h.applied).toEqual(["dark"]);
        expect(h.root.classList.contains("dark")).toBe(true);
        expect(h.root.style.colorScheme).toBe("dark");
        expect(h.animations).toEqual([]);
        h.ready.resolve();
        await Promise.resolve();
        expect(h.animations).toHaveLength(1);
        expect(h.animations[0][1]).toMatchObject({ duration: 400, pseudoElement: "::view-transition-new(root)" });
        h.finished.resolve();
        await h.expectHandled();
        h.expectClean();
        expect(h.reported).toEqual([]);
    });

    test("a rejected ready promise skips animation without repeating the eventual theme update", async () => {
        const h = harness();
        h.click();
        h.ready.reject(new DOMException("DOM update timed out", "TimeoutError"));
        await Promise.resolve();
        h.expectClean();
        expect(h.animations).toEqual([]);
        h.update();
        h.finished.resolve();
        await h.expectHandled();
        expect(h.applied).toEqual(["dark"]);
        expect(h.root.classList.contains("dark")).toBe(true);
        expect(h.reported).toEqual([]);
    });

    test("a rejected finished promise is consumed and cleans up without reverting the theme", async () => {
        const h = harness();
        h.click(); h.update(); h.ready.resolve();
        await Promise.resolve();
        h.finished.reject(new DOMException("Transition aborted", "AbortError"));
        await h.expectHandled();
        h.expectClean();
        expect(h.applied).toEqual(["dark"]);
        expect(h.root.classList.contains("dark")).toBe(true);
        expect(h.reported).toEqual([]);
    });

    test("reports a genuine theme callback failure once instead of treating it as animation cancellation", async () => {
        const error = new Error("Theme persistence failed");
        const h = harness({ themeError: error });
        h.click();
        h.update();
        await h.expectHandled();
        h.expectClean();
        expect(h.reported).toEqual([error]);
        expect(h.applied).toEqual(["dark"]);
        expect(h.animations).toEqual([]);
    });

    test("an unavailable pseudo-element animation cleans up without rejecting its ready chain or repeating the update", async () => {
        const h = harness({ animateError: new DOMException("Transition pseudo-element is no longer available", "InvalidStateError") });
        h.click(); h.update(); h.ready.resolve();
        await Promise.resolve();
        h.expectClean();
        h.finished.resolve();
        await h.expectHandled();
        expect(h.animations).toHaveLength(1);
        expect(h.applied).toEqual(["dark"]);
        expect(h.root.classList.contains("dark")).toBe(true);
        expect(h.reported).toEqual([]);
    });

    test("without View Transition support applies the theme directly exactly once", () => {
        const h = harness({ noApi: true });
        h.click();
        expect(h.applied).toEqual(["dark"]);
        expect(h.root.classList.contains("dark")).toBe(true);
        expect(h.animations).toEqual([]);
        h.expectClean();
    });

    test("without View Transition support a genuine callback failure still propagates", () => {
        const error = new Error("Theme persistence failed");
        const h = harness({ noApi: true, themeError: error });
        expect(h.click).toThrow(error);
        expect(h.applied).toEqual(["dark"]);
        h.expectClean();
    });

    for (const invokeBeforeStartError of [false, true]) {
        test(`synchronous transition failure cleans up and propagates without retrying the callback (applied=${invokeBeforeStartError})`, () => {
            const error = new Error("Transition setup failed");
            const h = harness({ startError: error, invokeBeforeStartError });
            expect(h.click).toThrow(error);
            h.expectClean();
            expect(h.applied).toEqual(invokeBeforeStartError ? ["dark"] : []);
        });
    }
});
