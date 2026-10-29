import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";
import { i18nHarness } from "./helpers/i18n-harness";

const canonicalLogin = "https://canvas.example:8443/login?scan=1";
const availableMethods = { password: true, wecom: true, wecomLoginUrl: canonicalLogin };
const authorizationUrl = "https://open.work.weixin.qq.com/wwopen/sso/qrConnect?state=test-state";
const settle = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const element = node as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

function loginPage(options: { href?: string; methods?: () => Promise<unknown>; start?: () => Promise<unknown> } = {}) {
    const source = new URL("../src/pages/login/index.tsx", import.meta.url);
    const requireModule = createRequire(source);
    const code = ts.transpileModule(readFileSync(source, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const values: any[] = [], effects: Array<() => (() => void) | void> = [], assignments: string[] = [], replacements: string[] = [];
    let cursor = 0, mounted = false, reloads = 0, methodCalls = 0;
    const startCalls: string[] = [];
    const url = new URL(options.href || "http://ordinary.example/login");
    const dependencies: Record<string, unknown> = {
        "@/lib/i18n": i18nHarness,
        "@/components/layout/inchoice-brand": { InchoiceBrand: () => null },
        "@/components/layout/language-switch": { LanguageSwitch: () => null },
        react: {
            ...React,
            useState(initial: unknown) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], (value: unknown) => { values[index] = value; }]; },
            useRef(initial: unknown) { const index = cursor++; return values[index] ||= { current: initial }; },
            useEffect(effect: () => (() => void) | void) { if (!mounted) effects.push(effect); },
        },
        antd: { App: { useApp: () => ({ message: { error() {}, warning() {} } }) }, Button: "Button", Input: Object.assign(function Input() {}, { Password: "Password" }) },
        "lucide-react": new Proxy({}, { get: (_, key) => String(key) }),
        "@/stores/use-user-store": { useUserStore: (select: Function) => select({ loginWithPassword: async () => ({ mustChangePassword: false }) }) },
        "@/services/api/auth": {
            getAuthMethods: async () => { methodCalls++; return options.methods ? options.methods() : availableMethods; },
            getWeComLoginUrl: async (portal: string) => { startCalls.push(portal); return options.start ? options.start() : { authorizationUrl }; },
        },
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", "window", code)(
        (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name), module, module.exports,
        { location: { href: url.href, search: url.search, origin: url.origin, assign: (path: string) => assignments.push(path), replace: (path: string) => replacements.push(path), reload: () => reloads++ } },
    );
    return {
        assignments, replacements, startCalls, get reloads() { return reloads; }, get methodCalls() { return methodCalls; },
        render() { cursor = 0; const tree = elements(module.exports.default()); mounted = true; return tree; },
        mountEffects() { return effects.map(effect => effect()); },
    };
}

test("only configured WeCom is shown while personal and administrator login remain available", async () => {
    for (const configured of [true, false]) {
        const page = loginPage({ methods: async () => ({ password: true, wecom: configured, wecomLoginUrl: configured ? canonicalLogin : null }) });
        expect(page.render().some(element => element.props.children === "企业微信扫码登录")).toBe(false);
        page.mountEffects(); await settle();
        const tree = page.render();
        expect(tree.some(element => element.props.children === "企业微信扫码登录")).toBe(configured);
        expect(tree.some(element => element.props.children === "登录工作台")).toBe(true);
        expect(tree.some(element => element.props.children === "管理员入口")).toBe(true);
        expect(page.startCalls).toEqual([]);
    }
});

test("ordinary login enters the configured callback origin including its HTTPS port before starting WeCom", async () => {
    const page = loginPage(); page.render(); page.mountEffects(); await settle();
    const button = page.render().find(element => element.props.children === "企业微信扫码登录")!;
    button.props.onClick();
    expect(page.assignments).toEqual([canonicalLogin]);
    expect(page.startCalls).toEqual([]);
});

test("canonical scan entry starts exactly once even when StrictMode replays the mount effect", async () => {
    const page = loginPage({ href: canonicalLogin }); page.render();
    page.mountEffects().forEach(cleanup => cleanup?.());
    page.mountEffects(); await settle(); page.render(); await settle();
    expect(page.startCalls).toEqual(["designer"]);
    expect(page.assignments).toEqual([authorizationUrl]);
    expect(page.replacements).toEqual([]);
});

test("a scan query on the wrong origin redirects to canonical without issuing a state cookie there", async () => {
    const page = loginPage({ href: "https://canvas.example/login?scan=1" });
    page.render(); page.mountEffects(); await settle();
    expect(page.replacements).toEqual([canonicalLogin]);
    expect(page.startCalls).toEqual([]);
    expect(page.assignments).toEqual([]);
});

test("unconfigured scan entry has no fake scan button and can return to password login", async () => {
    const page = loginPage({ href: canonicalLogin, methods: async () => ({ password: true, wecom: false, wecomLoginUrl: null }) });
    page.render(); page.mountEffects(); await settle();
    const tree = page.render();
    expect(tree.some(element => element.props.children === "企业微信扫码登录")).toBe(false);
    expect(tree.some(element => element.props.children === "重试扫码登录")).toBe(false);
    expect(tree.some(element => element.props.role === "alert")).toBe(true);
    tree.find(element => element.props.children === "返回密码登录")!.props.onClick();
    expect(page.replacements).toEqual(["/login"]);
    expect(page.startCalls).toEqual([]);
});

test("scan failure remains on the page with explicit retry instead of an automatic redirect loop", async () => {
    const page = loginPage({ href: canonicalLogin, start: async () => { throw new Error("企业微信暂不可用"); } });
    page.render(); page.mountEffects(); await settle();
    const tree = page.render();
    expect(tree.find(element => element.props.role === "alert")!.props.children).toBe("企业微信暂不可用");
    expect(page.startCalls).toEqual(["designer"]);
    expect(page.assignments).toEqual([]); expect(page.replacements).toEqual([]);
    tree.find(element => element.props.children === "重试扫码登录")!.props.onClick();
    expect(page.reloads).toBe(1);
});

test("method discovery outage does not remove password login or advertise unavailable WeCom", async () => {
    const page = loginPage({ methods: async () => { throw new Error("offline"); } });
    page.render(); page.mountEffects(); await settle();
    const tree = page.render();
    expect(tree.some(element => element.props.children === "企业微信扫码登录")).toBe(false);
    expect(tree.some(element => element.props.children === "登录工作台")).toBe(true);
    expect(page.startCalls).toEqual([]);
});

test("leaving the scan page while start is pending never navigates the abandoned page", async () => {
    const pending = Promise.withResolvers<{ authorizationUrl: string }>();
    const page = loginPage({ href: canonicalLogin, start: () => pending.promise });
    page.render(); const cleanups = page.mountEffects(); await settle();
    expect(page.startCalls).toEqual(["designer"]);
    expect(page.render().some(element => element.props.children === "正在打开企业微信扫码登录")).toBe(true);
    cleanups.forEach(cleanup => cleanup?.()); pending.resolve({ authorizationUrl }); await settle();
    expect(page.assignments).toEqual([]);
});

test("WeCom API requests preserve cookie credentials, disable caches and use the real authorizationUrl contract", async () => {
    const source = new URL("../src/services/api/auth.ts", import.meta.url);
    const code = ts.transpileModule(readFileSync(source, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const requests: Array<{ path: string; init: RequestInit }> = [];
    const api: any = {};
    new Function("exports", "fetch", code)(api, async (path: string, init: RequestInit) => {
        requests.push({ path, init });
        return Response.json(path.endsWith("/methods") ? availableMethods : { authorizationUrl });
    });
    expect(await api.getAuthMethods()).toEqual(availableMethods);
    expect(await api.getWeComLoginUrl("designer")).toEqual({ authorizationUrl });
    expect(requests.map(request => request.path)).toEqual(["/api/auth/methods", "/api/auth/wecom/start?portal=designer"]);
    for (const { init } of requests) expect(init).toMatchObject({ credentials: "include", cache: "no-store" });
});
