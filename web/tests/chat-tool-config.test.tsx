import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type DependencyList, type EffectCallback, type ReactElement } from "react";
import ts from "typescript";
import { defaultConfig } from "@/stores/use-config-store";
import { imageModelProfile } from "@/lib/image-model-settings";
import type { BusinessConfig } from "@/services/api/business-config";

const pageUrl = new URL("../src/pages/chat/index.tsx", import.meta.url);
const requireModule = createRequire(pageUrl);
const code = ts.transpileModule(readFileSync(pageUrl, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const element = node as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

function chatPageHarness(initial: BusinessConfig) {
    type State = BusinessConfig & { status: "ready" | "loading" | "error"; error: string | null; refresh: () => Promise<void> };
    let refreshes = 0;
    let directModelReads = 0;
    let business: State = { ...initial, status: "ready", error: null, refresh: async () => { refreshes++; } };
    const values: any[] = [];
    const effects: Array<{ deps?: DependencyList; cleanup?: ReturnType<EffectCallback> }> = [];
    const pending: Array<() => void> = [];
    let cursor = 0;
    const equal = (a?: DependencyList, b?: DependencyList) => Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));
    const useState = (initialValue: any) => {
        const index = cursor++;
        if (!(index in values)) values[index] = typeof initialValue === "function" ? initialValue() : initialValue;
        return [values[index], (next: any) => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
    };
    const useMemo = (factory: () => unknown, deps?: DependencyList) => {
        const index = cursor++;
        if (!values[index] || !equal(values[index].deps, deps)) values[index] = { deps, value: factory() };
        return values[index].value;
    };
    const userState = { user: { id: "designer", role: "designer", status: "active" } };
    const app = { message: { error() {}, warning() {}, success() {} }, modal: { confirm() {} } };
    const config = { ...defaultConfig, imageModel: "old-image" };
    const deps: Record<string, any> = {
        react: { ...React, useState, useMemo, useCallback: (callback: unknown, dependencies?: DependencyList) => useMemo(() => callback, dependencies),
            useRef: (value: unknown) => { const index = cursor++; return values[index] ||= { current: value }; },
            useEffect: (effect: EffectCallback, dependencies?: DependencyList) => {
                const index = cursor++;
                if (!effects[index] || !equal(effects[index].deps, dependencies)) pending.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps: dependencies, cleanup: effect() }; });
            } },
        antd: { App: { useApp: () => app }, Button: "Button", Tooltip: "Tooltip" },
        "lucide-react": new Proxy({}, { get: (_, name) => String(name) }),
        "react-router-dom": { useNavigate: () => () => undefined },
        "@/lib/deployment-features": { deploymentFeatures: { oaLoginEnabled: true, creditsEnabled: false } },
        "@/lib/deferred-persist-queue": { createDeferredPersistQueue: () => ({ schedule() {}, flush() {}, clear() {} }) },
        "./chat-session-storage": { chatSessionStorage: { load: async () => [{ id: "session", title: "new", messages: [], updatedAt: "now" }], save: async () => undefined } },
        "@/stores/use-user-store": { useUserStore: Object.assign((select: Function) => select(userState), { getState: () => userState }) },
        "@/stores/use-config-store": { useConfigStore: (select: Function) => select({ updateConfig() {} }), useEffectiveConfig: () => config },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select?: Function) => select ? select(business) : business },
        "@/stores/use-module-store": { useModuleEnabled: () => true },
        "@/lib/image-model-settings": { useImageModelProfile: (model: string) => imageModelProfile(model, business.models, "designer") },
        "@/stores/canvas/use-canvas-store": { useCanvasStore: { getState: () => ({ hydrated: true, projects: [] }) }, flushCanvasPersistence: async () => undefined },
    };
    const module = { exports: {} as { default: () => ReactElement<any> } };
    new Function("require", "module", "exports", "window", "fetch", code)(
        (name: string) => Object.hasOwn(deps, name) ? deps[name] : requireModule(name), module, module.exports,
        { matchMedia: () => ({ matches: true }), addEventListener() {}, removeEventListener() {} },
        async () => { directModelReads++; throw new Error("Chat must use the shared model snapshot"); },
    );
    const render = () => { cursor = 0; const root = module.exports.default(); for (const effect of pending.splice(0)) effect(); return root; };
    return {
        set: (patch: Partial<State>) => { business = { ...business, ...patch }; },
        async settle() { let root = render(); for (let index = 0; index < 4; index++) { await Promise.resolve(); root = render(); } return elements(root); },
        dispose: () => effects.forEach(effect => effect.cleanup?.()),
        counts: () => ({ refreshes, directModelReads }),
    };
}

const model = (id: string, capability: string) => ({ id, modelId: id, name: id, capabilities: [capability], creditCost: 0, rmbCost: 0 });
const tool = (toolKey: string, modelConfigId: string) => ({ toolKey, modelConfigId, enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 });
const select = (tree: ReactElement<any>[], label: string) => tree.find(element => element.type === "select" && element.props["aria-label"] === label)!;

test("the mounted chat page follows newly added bound chat and anonymous image models from one shared snapshot", async () => {
    const page = chatPageHarness({ models: [model("old-chat", "chat"), model("old-image", "generate")], tools: [], prices: [] });
    try {
        const initial = await page.settle();
        expect(select(initial, "对话模型").props.value).toBe("old-chat");
        page.set({ models: [model("new-chat", "chat"), { ...model("opaque-image", "generate"), imageParameterProfile: "standard-flex-plus", modelIdentityHidden: true }], tools: [tool("gpt-chat", "new-chat"), tool("gpt-chat-image", "opaque-image")] });
        const refreshed = await page.settle();
        const chat = select(refreshed, "对话模型");
        expect(chat.props.value).toBe("new-chat");
        expect(chat.props.disabled).toBe(false);
        expect(elements(chat).filter(element => element.type === "option").map(element => element.props.value)).toEqual(["new-chat"]);
        const quality = select(refreshed, "图片清晰度");
        expect(quality.props.disabled).toBe(false);
        expect(elements(quality).some(element => element.type === "option" && element.props.value === "xhigh")).toBe(true);
        expect(page.counts()).toEqual({ refreshes: 0, directModelReads: 0 });
    } finally { page.dispose(); }
});

test("chat disables stale models on shared loading/error and retry refreshes the same store", async () => {
    const page = chatPageHarness({ models: [model("chat", "chat"), model("image", "generate")], tools: [], prices: [] });
    try {
        await page.settle();
        for (const status of ["loading", "error"] as const) {
            page.set({ status, error: status === "error" ? "同步失败" : null });
            const tree = await page.settle();
            expect(select(tree, "对话模型").props.disabled).toBe(true);
            expect(select(tree, "图片清晰度").props.disabled).toBe(true);
            if (status === "error") tree.find(element => element.type === "Button" && element.props.children === "重试加载")!.props.onClick();
        }
        expect(page.counts()).toEqual({ refreshes: 1, directModelReads: 0 });
    } finally { page.dispose(); }
});
