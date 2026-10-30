import { i18nHarness } from "./helpers/i18n-harness";
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type DependencyList, type EffectCallback, type ReactElement } from "react";
import ts from "typescript";

import {
    FeaturedModelConfigurationError, getFeaturedModelConfiguration, saveFeaturedModelConfiguration,
    type FeaturedModelCandidate, type FeaturedModelConfiguration,
} from "@/services/api/model-configuration";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const candidate = (index: number): FeaturedModelCandidate => ({
    id: `model-${index}`, modelId: `private-protocol-model-${index}`, name: `Mark image ${index}`, providerId: "mark-provider", providerName: "Mark",
    capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0, concurrencyLimit: 2,
    protocol: "apimart", enabled: index !== 6, providerEnabled: true, hasCredentials: index !== 4, isFeatured: index < 3, displayOrder: index,
});
const configuration = (ids = ["model-2", "model-0", "model-1"]): FeaturedModelConfiguration => ({
    models: Array.from({ length: 7 }, (_, index) => candidate(index)), featuredModelIds: ids, maxFeatured: 5,
});

test("featured API reads and writes only its dedicated endpoint and ordered config IDs, including empty selection", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ path: String(input), init });
        return Response.json(configuration());
    }) as typeof fetch;
    const controller = new AbortController();
    await getFeaturedModelConfiguration(controller.signal);
    await saveFeaturedModelConfiguration(["model-4", "model-1"], controller.signal);
    await saveFeaturedModelConfiguration([]);
    expect(calls.map(call => call.path)).toEqual(Array(3).fill("/api/admin/model-configuration/featured-models"));
    expect(calls.every(call => call.init?.credentials === "include" && call.init.cache === "no-store")).toBe(true);
    expect(calls[0]!.init?.method).toBeUndefined();
    expect(calls[0]!.init?.signal).toBe(controller.signal);
    expect(calls[1]!.init?.method).toBe("PUT");
    expect(calls[1]!.init?.signal).toBe(controller.signal);
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ modelConfigIds: ["model-4", "model-1"] });
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ modelConfigIds: [] });
});

test("featured errors are actionable without disclosing arbitrary response or network text", async () => {
    for (const [status, code, expected] of [[401, "", "登录已失效"], [403, "", "超级管理员"], [404, "", "最新正式后台"], [400, "INVALID_FEATURED_MODEL", "已停用"], [400, "VALIDATION_ERROR", "最多选择 5 个"], [500, "", "稍后重试"]] as const) {
        globalThis.fetch = (async () => Response.json({ error: code, message: "private-secret", msg: "private-secret" }, { status })) as typeof fetch;
        try { await getFeaturedModelConfiguration(); throw new Error("should reject"); }
        catch (error) {
            expect(error).toBeInstanceOf(FeaturedModelConfigurationError);
            expect((error as Error).message).toContain(expected);
            expect((error as Error).message).not.toContain("private-secret");
        }
    }
    globalThis.fetch = (async () => { throw new Error("private-secret"); }) as typeof fetch;
    await expect(getFeaturedModelConfiguration()).rejects.toThrow("请检查网络后重试");
    const abort = new DOMException("aborted", "AbortError");
    globalThis.fetch = (async () => { throw abort; }) as typeof fetch;
    await expect(getFeaturedModelConfiguration()).rejects.toBe(abort);
});

test("invalid featured response is not accepted as an editable configuration", async () => {
    for (const value of [
        { ...configuration(), maxFeatured: 6 },
        { ...configuration(), featuredModelIds: ["model-0", "model-0"] },
        { ...configuration(), featuredModelIds: Array.from({ length: 6 }, (_, index) => `model-${index}`) },
        { ...configuration(), models: [{ ...candidate(0), protocol: "openai" }] },
        { ...configuration(), models: [{ ...candidate(0), providerEnabled: undefined }] },
    ]) {
        globalThis.fetch = (async () => Response.json(value)) as typeof fetch;
        await expect(getFeaturedModelConfiguration()).rejects.toThrow("响应无效");
    }
});

const panelUrl = new URL("../src/pages/admin/components/hot-model-order-panel.tsx", import.meta.url);
const requireModule = createRequire(panelUrl);
const panelCode = ts.transpileModule(readFileSync(panelUrl, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const element = node as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

function harness(options: {
    role?: string;
    load?: (signal?: AbortSignal) => Promise<FeaturedModelConfiguration>;
    save?: (ids: string[], signal?: AbortSignal) => Promise<FeaturedModelConfiguration>;
    refresh?: () => Promise<void>;
} = {}) {
    const state: any[] = [];
    const effects: Array<{ deps?: DependencyList; cleanup?: ReturnType<EffectCallback> }> = [];
    const pending: Array<() => void> = [];
    const equal = (a?: DependencyList, b?: DependencyList) => Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));
    let cursor = 0, reads = 0, refreshes = 0;
    const writes: string[][] = [];
    const signals: AbortSignal[] = [];
    const userState = { user: { id: "operator", role: options.role || "super_admin" } };
    const business = { refresh: async () => { refreshes++; await options.refresh?.(); } };
    const dependencies: Record<string, any> = {
        "@/lib/i18n": i18nHarness,
        "@/hooks/use-unsaved-guard": { useUnsavedGuard: () => ({ confirmDiscard: async () => true }) },
        react: { ...React,
            useState: (initial: any) => { const index = cursor++; if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial; return [state[index], (next: any) => { state[index] = typeof next === "function" ? next(state[index]) : next; }]; },
            useRef: (value: unknown) => { const index = cursor++; return state[index] ||= { current: value }; },
            useCallback: (callback: unknown, deps?: DependencyList) => { const index = cursor++; if (!state[index] || !equal(state[index].deps, deps)) state[index] = { deps, callback }; return state[index].callback; },
            useEffect: (effect: EffectCallback, deps?: DependencyList) => {
                const index = cursor++;
                if (!effects[index] || !equal(effects[index].deps, deps)) pending.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; });
            },
        },
        antd: { Alert: "Alert", Button: "Button", Checkbox: "Checkbox", Empty: "Empty", Tag: "Tag" },
        "lucide-react": new Proxy({}, { get: (_, key) => String(key) }),
        "@/stores/use-user-store": { useUserStore: (select: Function) => select(userState) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select(business) },
        "@/services/api/model-configuration": {
            getFeaturedModelConfiguration: async (signal: AbortSignal) => { reads++; signals.push(signal); return options.load ? options.load(signal) : configuration(); },
            saveFeaturedModelConfiguration: async (ids: string[], signal: AbortSignal) => { writes.push(ids); signals.push(signal); return options.save ? options.save(ids, signal) : configuration(ids); },
        },
    };
    const module = { exports: {} as { HotModelOrderPanel: (props: { isAdmin: boolean }) => ReactElement<any> } };
    new Function("require", "module", "exports", panelCode)((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name), module, module.exports);
    const render = (isAdmin = true) => { cursor = 0; const result = module.exports.HotModelOrderPanel({ isAdmin }); for (const effect of pending.splice(0)) effect(); return elements(result); };
    return {
        userState, writes, signals, render,
        counts: () => ({ reads, refreshes }),
        async settle() { let tree = render(); for (let index = 0; index < 8; index++) { await Promise.resolve(); tree = render(); } return tree; },
        dispose: () => effects.forEach(effect => effect.cleanup?.()),
    };
}
const order = (tree: ReactElement<any>[]) => tree.filter(element => element.props["data-featured-order"]).map(element => element.props["data-featured-order"]);
const checkbox = (tree: ReactElement<any>[], index: number) => tree.find(element => element.type === "Checkbox" && element.props["aria-label"] === `热门模型：Mark image ${index}`)!;
const button = (tree: ReactElement<any>[], label: string) => tree.find(element => element.type === "Button" && (element.props["aria-label"] === label || element.props.children === label))!;

test("only verified super admins load or edit featured models", async () => {
    for (const role of ["designer", "department_admin"]) {
        const panel = harness({ role });
        try { expect((await panel.settle())[0]!.props.title).toBe("仅超级管理员可配置热门模型"); expect(panel.counts().reads).toBe(0); }
        finally { panel.dispose(); }
    }
    const panel = harness();
    try { expect(panel.render(false)[0]!.props.title).toBe("仅超级管理员可配置热门模型"); expect(panel.counts().reads).toBe(0); }
    finally { panel.dispose(); }
});

test("selected order is exact, at most five, and disabled models cannot be added", async () => {
    const panel = harness();
    try {
        let tree = await panel.settle();
        expect(order(tree)).toEqual(["model-2", "model-0", "model-1"]);
        expect(button(tree, "保存热门模型").props.disabled).toBe(true);
        expect(checkbox(tree, 6).props.disabled).toBe(true);
        checkbox(tree, 6).props.onChange({ target: { checked: true } });
        expect(order(panel.render())).not.toContain("model-6");
        expect(checkbox(tree, 4).props.disabled).toBe(false);
        checkbox(tree, 4).props.onChange({ target: { checked: true } });
        checkbox(tree, 3).props.onChange({ target: { checked: true } });
        checkbox(tree, 5).props.onChange({ target: { checked: true } });
        tree = panel.render();
        expect(order(tree)).toEqual(["model-2", "model-0", "model-1", "model-4", "model-3"]);
        expect(checkbox(tree, 5).props.disabled).toBe(true);
        button(tree, "上移 Mark image 4").props.onClick();
        tree = panel.render();
        expect(order(tree)).toEqual(["model-2", "model-0", "model-4", "model-1", "model-3"]);
        button(tree, "下移 Mark image 2").props.onClick();
        tree = panel.render();
        expect(order(tree)).toEqual(["model-0", "model-2", "model-4", "model-1", "model-3"]);
        button(tree, "移除 Mark image 4").props.onClick();
        expect(order(panel.render())).toEqual(["model-0", "model-2", "model-1", "model-3"]);
        expect(panel.writes).toEqual([]);
    } finally { panel.dispose(); }
});

test("ordered save guards double clicks and refreshes only public business configuration", async () => {
    let finish!: (value: FeaturedModelConfiguration) => void;
    const panel = harness({ save: () => new Promise(resolve => { finish = resolve; }) });
    try {
        let tree = await panel.settle();
        button(tree, "上移 Mark image 0").props.onClick();
        tree = panel.render();
        const submit = button(tree, "保存热门模型").props.onClick;
        const first = submit();
        await submit();
        expect(panel.writes).toEqual([["model-0", "model-2", "model-1"]]);
        const during = panel.render();
        expect(button(during, "保存热门模型").props.loading).toBe(true);
        expect(checkbox(during, 3).props.disabled).toBe(true);
        checkbox(tree, 4).props.onChange({ target: { checked: true } });
        expect(order(panel.render())).toEqual(["model-0", "model-2", "model-1"]);
        finish(configuration(panel.writes[0]));
        await first;
        tree = await panel.settle();
        expect(panel.counts()).toEqual({ reads: 1, refreshes: 1 });
        expect(button(tree, "保存热门模型").props.disabled).toBe(true);
        expect(tree.some(element => element.type === "Alert" && element.props.type === "success")).toBe(true);
    } finally { panel.dispose(); }
});

test("empty selection is saved exactly, stays empty on reload, and never auto-fills", async () => {
    let saved = configuration();
    const panel = harness({ load: async () => saved, save: async ids => saved = configuration(ids) });
    try {
        let tree = await panel.settle();
        for (const index of [2, 0, 1]) { button(tree, `移除 Mark image ${index}`).props.onClick(); tree = panel.render(); }
        expect(order(tree)).toEqual([]);
        await button(tree, "保存热门模型").props.onClick();
        expect(panel.writes).toEqual([[]]);
        tree = await panel.settle();
        await button(tree, "重新加载").props.onClick();
        expect(order(await panel.settle())).toEqual([]);
        expect(panel.counts().reads).toBe(2);
    } finally { panel.dispose(); }
});

test("save errors preserve the draft; a public refresh failure does not misreport the committed write", async () => {
    let fail = true;
    const panel = harness({ save: async ids => { if (fail) throw new Error("所选模型已停用"); return configuration(ids); }, refresh: async () => { throw new Error("no public access"); } });
    try {
        let tree = await panel.settle();
        checkbox(tree, 3).props.onChange({ target: { checked: true } });
        tree = panel.render();
        await button(tree, "保存热门模型").props.onClick();
        tree = await panel.settle();
        expect(order(tree)).toEqual(["model-2", "model-0", "model-1", "model-3"]);
        expect(tree.some(element => element.props.title === "热门模型保存失败")).toBe(true);
        expect(button(tree, "保存热门模型").props.disabled).toBe(false);
        expect(panel.counts().refreshes).toBe(0);
        fail = false;
        await button(tree, "保存热门模型").props.onClick();
        tree = await panel.settle();
        expect(button(tree, "保存热门模型").props.disabled).toBe(true);
        expect(tree.some(element => String(element.props.title).includes("已保存，但当前页面同步失败"))).toBe(true);
        expect(panel.counts().refreshes).toBe(1);
    } finally { panel.dispose(); }
});

test("load failure blocks writes and permits retry without stale configuration", async () => {
    let fail = true;
    const panel = harness({ load: async () => { if (fail) throw new Error("请检查网络后重试"); return configuration(); } });
    try {
        let tree = await panel.settle();
        expect(tree.some(element => element.props.title === "热门模型加载失败")).toBe(true);
        expect(button(tree, "保存热门模型").props.disabled).toBe(true);
        await button(tree, "保存热门模型").props.onClick();
        expect(panel.writes).toEqual([]);
        fail = false;
        await button(tree, "重新加载").props.onClick();
        tree = await panel.settle();
        expect(order(tree)).toEqual(["model-2", "model-0", "model-1"]);
        expect(tree.some(element => element.props.title === "热门模型加载失败")).toBe(false);
    } finally { panel.dispose(); }
});

test("unavailable retained selection must be removed, and provider disabled cannot be selected", async () => {
    const data = configuration(["model-6", "missing-model"]);
    data.models[5]!.providerEnabled = false;
    const panel = harness({ load: async () => data });
    try {
        let tree = await panel.settle();
        expect(checkbox(tree, 5).props.disabled).toBe(true);
        expect(checkbox(tree, 6).props.disabled).toBe(false);
        expect(tree.some(element => element.props.title === "请先移除不可用或已停用的模型，再保存。")).toBe(true);
        button(tree, "移除 已不可用的模型").props.onClick();
        tree = panel.render();
        expect(button(tree, "保存热门模型").props.disabled).toBe(true);
        button(tree, "移除 Mark image 6").props.onClick();
        expect(button(panel.render(), "保存热门模型").props.disabled).toBe(false);
    } finally { panel.dispose(); }
});

test("identity changes abort an in-flight request and discard its late result", async () => {
    let finish!: (value: FeaturedModelConfiguration) => void;
    const panel = harness({ load: () => new Promise(resolve => { finish = resolve; }) });
    try {
        await panel.settle();
        expect(panel.signals[0]!.aborted).toBe(false);
        panel.userState.user = { id: "other", role: "designer" };
        let tree = await panel.settle();
        expect(panel.signals[0]!.aborted).toBe(true);
        finish(configuration());
        tree = await panel.settle();
        expect(tree[0]!.props.title).toBe("仅超级管理员可配置热门模型");
        expect(panel.counts().reads).toBe(1);
        expect(order(tree)).toEqual([]);
    } finally { panel.dispose(); }
});
