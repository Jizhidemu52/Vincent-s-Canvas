import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { createCanvasProjectMetadataSync } from "@/lib/canvas/canvas-project-metadata-sync";

const source = new URL("../src/components/layout/client-root-init.tsx", import.meta.url);
const requireModule = createRequire(source);
const code = ts.transpileModule(readFileSync(source, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const settle = () => new Promise<void>(done => setTimeout(done, 0));

function mountHarness() {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    let interval: (() => void) | undefined;
    const listeners = new Map<string, () => void>();
    const document = { visibilityState: "visible", addEventListener: (name: string, callback: () => void) => listeners.set(name, callback), removeEventListener: (name: string) => listeners.delete(name) };
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
        setInterval: (callback: () => void, delay: number) => { expect(delay).toBe(10_000); interval = callback; return 1; },
        clearInterval: () => { interval = undefined; },
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: document });
    const calls = { identity: 0, models: 0, modules: 0, projects: [] as Array<{ owner: string; id: string; title: string }> };
    let hydration: Promise<void> = Promise.resolve();
    const state = { status: "authenticated", user: { id: "employee-a", role: "designer" }, hydrateSession: async () => { calls.identity++; await hydration; } };
    const canvas = { hydrated: true, projects: [{ id: "same-project", title: "初稿" }] };
    const effects: Array<() => void | (() => void)> = [];
    const module = { exports: {} as any };
    const dependencies: Record<string, unknown> = {
        react: { useEffect: (effect: () => void | (() => void)) => effects.push(effect) },
        "@/stores/use-user-store": { useUserStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) },
        "@/stores/canvas/use-canvas-store": { useCanvasStore: { getState: () => canvas } },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (selector: (value: unknown) => unknown) => selector({ refresh: async () => { calls.models++; } }) },
        "@/stores/use-module-store": { useModuleStore: (selector: (value: unknown) => unknown) => selector({ refresh: async () => { calls.modules++; } }) },
        "@/lib/deployment-features": { deploymentFeatures: { oaLoginEnabled: true } },
        "@/lib/canvas/canvas-project-metadata-sync": { createCanvasProjectMetadataSync },
        "@/services/api/projects": { syncProjectMetadata: async (owner: string, project: { id: string; title: string }) => { calls.projects.push({ owner, ...project }); } },
    };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name] || requireModule(name), module, module.exports);
    let cleanups: Array<() => void> = [];
    const mount = () => {
        effects.length = 0;
        module.exports.ClientRootInit({ children: null });
        cleanups = effects.map(effect => effect()).filter((cleanup): cleanup is () => void => typeof cleanup === "function");
    };
    const unmount = () => { cleanups.splice(0).forEach(cleanup => cleanup()); };
    mount();
    return {
        calls, state, canvas, document, mount, unmount,
        refresh: () => interval?.(),
        visibility: () => listeners.get("visibilitychange")?.(),
        setHydration: (promise: Promise<void>) => { hydration = promise; },
        close() {
            unmount();
            if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
            if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else Reflect.deleteProperty(globalThis, "document");
        },
    };
}

test("root refresh retains identity/model/module polling but skips unchanged and hidden project metadata", async () => {
    const harness = mountHarness();
    try {
        await settle();
        expect(harness.calls.projects).toHaveLength(1);
        harness.refresh(); await settle();
        expect(harness.calls.projects).toHaveLength(1);
        expect([harness.calls.identity, harness.calls.models, harness.calls.modules]).toEqual([2, 2, 2]);
        harness.document.visibilityState = "hidden";
        harness.canvas.projects = [{ id: "same-project", title: "已改名" }];
        harness.refresh(); await settle();
        expect(harness.calls.projects).toHaveLength(1);
        expect([harness.calls.identity, harness.calls.models, harness.calls.modules]).toEqual([3, 3, 3]);
        harness.document.visibilityState = "visible";
        harness.visibility(); await settle();
        expect(harness.calls.projects.at(-1)).toEqual({ owner: "employee-a", id: "same-project", title: "已改名" });
        expect(harness.calls.projects).toHaveLength(2);
    } finally { harness.close(); }
});

test("late identity hydration cannot sync an old workspace and a new owner starts with a fresh cache", async () => {
    const harness = mountHarness();
    try {
        await settle();
        let release!: () => void;
        harness.setHydration(new Promise<void>(done => { release = done; }));
        harness.refresh();
        harness.state.user = { id: "employee-b", role: "designer" };
        release(); await settle();
        expect(harness.calls.projects).toEqual([{ owner: "employee-a", id: "same-project", title: "初稿" }]);
        harness.unmount(); harness.mount(); await settle();
        expect(harness.calls.projects).toEqual([
            { owner: "employee-a", id: "same-project", title: "初稿" },
            { owner: "employee-b", id: "same-project", title: "初稿" },
        ]);
    } finally { harness.close(); }
});
