import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

function harness() {
    const pending = Promise.withResolvers<any>();
    const cleanups: Array<() => void> = [], calls: Array<{ action: string; args: unknown[]; context?: any }> = [], errors: string[] = [];
    let loads = 0, ownerId = "employee-a";
    const options = { projectId: "canvas-a", designProjectIdRef: { current: "canvas-a" }, runtime: {}, dialogs: {} };
    const message = { error: (text: string) => errors.push(text) };
    const dependencies: Record<string, unknown> = {
        react: { useCallback: (fn: Function) => fn, useMemo: (fn: Function) => fn(), useRef: (current: unknown) => ({ current }), useEffect: (fn: Function) => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); } },
        antd: { App: { useApp: () => ({ message }) } },
        "@/lib/i18n": { uiText: (text: string) => text },
        "@/stores/canvas/canvas-graph-store": { useCanvasGraphStore: (select: Function) => select({ setField() {} }) },
        "@/stores/use-config-store": { useEffectiveConfig: () => ({ model: "fixture" }) },
        "@/stores/use-user-store": { useUserStore: { getState: () => ({ user: { id: ownerId } }) } },
    };
    const source = readFileSync(new URL("../src/pages/canvas/use-canvas-image-actions.ts", import.meta.url), "utf8")
        .replaceAll('await import("./canvas-image-actions-runtime")', "await loadRuntime()");
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: {} as { useCanvasImageActions: Function } };
    new Function("require", "module", "exports", "loadRuntime", code)((name: string) => dependencies[name], module, module.exports, () => { loads++; return pending.promise; });
    const actions = module.exports.useCanvasImageActions(options);
    const resolve = () => pending.resolve({
        createCanvasImageActionsRuntime: (context: unknown) => new Proxy({}, { get: (_target, action) => async (...args: unknown[]) => { calls.push({ action: String(action), args, context }); } }),
        runCanvasLocalImageOperation: async ({ task }: { task: (signal: AbortSignal) => Promise<void> }) => { calls.push({ action: "local", args: [] }); await task(new AbortController().signal); return true; },
    });
    return { actions, calls, errors, pending, resolve, loads: () => loads, switchOwner: () => { ownerId = "employee-b"; }, switchProject: () => { options.designProjectIdRef.current = "canvas-b"; }, unmount: () => cleanups.forEach(cleanup => cleanup()) };
}

test("image actions do not load on first render and dispatch only the clicked operation after loading", async () => {
    const app = harness();
    expect(app.loads()).toBe(0);
    const node = { id: "original" }, crop = { x: 0, y: 0, width: 1, height: 1 };
    const operation = app.actions.cropImageNode(node, crop);
    expect(app.loads()).toBe(1); expect(app.calls).toEqual([]);
    app.resolve(); await operation;
    expect(app.calls).toHaveLength(1);
    expect(app.calls[0]).toMatchObject({ action: "cropImageNode", args: [node, crop] });
    expect(app.calls[0]!.context.isCurrent()).toBe(true);
});

test("a delayed image-action load cannot edit or submit after a project, employee or mounted scope changes", async () => {
    for (const change of ["switchProject", "switchOwner", "unmount"] as const) {
        const app = harness(); const operation = app.actions.generateAngleNode({ id: "source" }, { yaw: 90 });
        app[change](); app.resolve(); await operation;
        expect(app.calls).toEqual([]); expect(app.errors).toEqual([]);
    }
});

test("a stale manual image save rejects instead of reporting a successful save", async () => {
    const app = harness(); const operation = app.actions.saveManualImageEdit({ storageKey: "edited" });
    app.switchOwner(); app.resolve();
    await expect(operation).rejects.toThrow("账号已切换");
    expect(app.calls).toEqual([]);
});

test("local clipboard/image processing is also lazy and does not start after leaving the canvas", async () => {
    const app = harness(); let ran = false;
    const operation = app.actions.runLocalImageOperation("paste", "粘贴", async () => { ran = true; });
    expect(app.loads()).toBe(1); app.unmount(); app.resolve();
    expect(await operation).toBe(false); expect(ran).toBe(false);
});

test("failed image module loads give feedback without creating nodes or starting work", async () => {
    const app = harness(); const operation = app.actions.splitImageNode({ id: "source" }, { rows: 2, columns: 2 });
    app.pending.reject(new Error("offline")); await operation;
    expect(app.errors).toEqual(["加载失败，请重试"]); expect(app.calls).toEqual([]);
});
