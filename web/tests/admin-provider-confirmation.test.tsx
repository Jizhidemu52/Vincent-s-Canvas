import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";
import * as providerApi from "../src/services/api/model-configuration";
import { i18nHarness } from "./helpers/i18n-harness";
import { displayHooksHarness } from "./helpers/display-hooks-harness";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

const provider = { id: "11111111-1111-4111-8111-111111111111", name: "共用测试服务", protocol: "openai", baseUrl: "https://provider.example.test/v1", enabled: true, hasCredentials: true, createdAt: "now", updatedAt: "now" };

function harness(confirm: (options: any) => Promise<boolean> = async () => true) {
    const path = new URL("../src/pages/admin/components/api-provider-panel.tsx", import.meta.url);
    const requireModule = createRequire(path);
    const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const state: any[] = [], effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [], queued: Array<() => void> = [];
    const confirmations: any[] = [], requests: Array<{ path: string; method: string; body: any }> = [];
    const form = { fields: {} as Record<string, unknown>, setFieldsValue(values: Record<string, unknown>) { Object.assign(this.fields, values); }, resetFields() { this.fields = {}; } };
    let cursor = 0;
    const equal = (first: unknown[], second?: unknown[]) => Boolean(second && first.length === second.length && first.every((value, index) => Object.is(value, second[index])));
    globalThis.fetch = (async (path: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method || "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ path: String(path), method, body });
        return Response.json(method === "GET" ? { providers: [provider] } : { provider: { ...provider, ...body } });
    }) as typeof fetch;
    const mocks: Record<string, any> = {
        "@/lib/i18n": i18nHarness,
        "@/hooks/use-display-text": displayHooksHarness,
        react: { ...React,
            useState(initial: any) { const index = cursor++; if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial; return [state[index], (next: any) => { state[index] = typeof next === "function" ? next(state[index]) : next; }]; },
            useRef(initial: unknown) { const index = cursor++; return state[index] ||= { current: initial }; },
            useEffect(effect: () => (() => void) | undefined, deps: unknown[]) { const index = cursor++; if (!equal(deps, effects[index]?.deps)) queued.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; }); },
        },
        antd: new Proxy({
            App: { useApp: () => ({ message: { success() {}, error() {} }, modal: { confirm: (options: any) => { confirmations.push(options); return confirm(options); } } }) },
            Form: Object.assign(function Form() {}, { Item: "FormItem", useForm: () => [form], useWatch: (name: string) => form.fields[name] }),
            Input: { Password: "Password" }, Typography: { Title: "Title" },
        }, { get: (target, key) => key in target ? target[key as keyof typeof target] : String(key) }),
        "@/hooks/use-unsaved-guard": { useUnsavedGuard: () => ({ confirmDiscard: async () => true }) },
        "@/services/api/model-configuration": providerApi,
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : requireModule(name), module, module.exports);
    const render = () => { cursor = 0; const tree = elements(module.exports.ApiProviderPanel({ isAdmin: true })); for (const effect of queued.splice(0)) effect(); return tree; };
    return {
        requests, confirmations, form, render,
        async settle() { let tree = render(); for (let index = 0; index < 20; index++) { await Promise.resolve(); tree = render(); } return tree; },
        writes: () => requests.filter(request => request.method !== "GET"),
        dispose() { effects.forEach(effect => effect.cleanup?.()); },
    };
}

test.each([
    [{ enabled: false }, "停用服务"],
    [{ protocol: "anthropic" }, "更改调用协议"],
    [{ baseUrl: "https://other.example.test/v1" }, "更改接口地址"],
    [{ apiKey: "test-secret-value-never-in-confirmation" }, "替换服务端凭据"],
] as const)("cancelling a high-impact provider change sends no write request: %j", async (change, label) => {
    const panel = harness(async () => false);
    try {
        const form = (await panel.settle()).find(element => element.props.onFinish)!;
        await form.props.onFinish({ ...provider, ...change });
        expect(panel.confirmations).toHaveLength(1);
        expect(panel.confirmations[0].title).toContain(provider.name);
        expect(panel.confirmations[0].content).toContain(label);
        expect(panel.confirmations[0].content).toContain("所有绑定此服务的模型及使用这些模型的板块");
        expect(JSON.stringify(panel.confirmations)).not.toContain("test-secret-value-never-in-confirmation");
        expect(panel.writes()).toEqual([]);
        expect(panel.render().find(element => element.props.onFinish)!.props.disabled).toBe(false);
        expect(panel.form.fields.enabled).toBe(true);
    } finally { panel.dispose(); }
});

test("a pending confirmation blocks duplicate submissions and a confirmed provider change writes exactly once", async () => {
    let resolve!: (value: boolean) => void;
    const panel = harness(() => new Promise<boolean>(done => { resolve = done; }));
    try {
        const form = (await panel.settle()).find(element => element.props.onFinish)!;
        const first = form.props.onFinish({ ...provider, enabled: false });
        await form.props.onFinish({ ...provider, enabled: false });
        expect(panel.confirmations).toHaveLength(1);
        expect(panel.writes()).toEqual([]);
        expect(panel.render().find(element => element.props.onFinish)!.props.disabled).toBe(true);
        resolve(true);
        await first;
        expect(panel.writes()).toEqual([{ path: `/api/admin/model-configuration/providers/${provider.id}`, method: "PATCH", body: { name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl, enabled: false } }]);
    } finally { panel.dispose(); }
});

test("a name-only edit keeps the existing credentials and does not add a dangerous-operation confirmation", async () => {
    const panel = harness();
    try {
        const form = (await panel.settle()).find(element => element.props.onFinish)!;
        await form.props.onFinish({ ...provider, name: "新的显示名称", apiKey: "" });
        expect(panel.confirmations).toEqual([]);
        expect(panel.writes()).toHaveLength(1);
        expect(panel.writes()[0].body).toEqual({ name: "新的显示名称", protocol: provider.protocol, baseUrl: provider.baseUrl, enabled: provider.enabled });
    } finally { panel.dispose(); }
});

test("a newly created provider is not mistaken for a change to a shared service", async () => {
    const panel = harness();
    try {
        let tree = await panel.settle();
        await tree.find(element => element.type === "Button" && element.props.children === "新增")!.props.onClick();
        tree = panel.render();
        await tree.find(element => element.props.onFinish)!.props.onFinish({ ...provider, name: "新服务", apiKey: "test-new-key" });
        expect(panel.confirmations).toEqual([]);
        expect(panel.writes()).toHaveLength(1);
        expect(panel.writes()[0]).toMatchObject({ path: "/api/admin/model-configuration/providers", method: "POST", body: { name: "新服务", credentials: { apiKey: "test-new-key" } } });
    } finally { panel.dispose(); }
});
