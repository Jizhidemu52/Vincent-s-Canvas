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

function loginPage(options: { href?: string; methods?: () => Promise<unknown>; start?: () => Promise<unknown>; login?: () => Promise<unknown>; returnTo?: string } = {}) {
    const source = new URL("../src/pages/login/index.tsx", import.meta.url);
    const requireModule = createRequire(source);
    const code = ts.transpileModule(readFileSync(source, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const values: any[] = [], effects: Array<() => (() => void) | void> = [], assignments: string[] = [], replacements: string[] = [];
    let cursor = 0, mounted = false, reloads = 0, methodCalls = 0;
    const startCalls: string[] = [];
    const passwordCalls: unknown[][] = [], notices: unknown[] = [];
    const url = new URL(options.href || "http://ordinary.example/login");
    const dependencies: Record<string, unknown> = {
        "@/lib/i18n": i18nHarness,
        "@/components/layout/inchoice-brand": { InchoiceBrand: () => null },
        "@/components/layout/language-switch": { LanguageSwitch: () => null },
        "@/lib/login-return": { currentLoginReturn: () => options.returnTo || "/" },
        react: {
            ...React,
            useState(initial: unknown) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], (value: unknown) => { values[index] = value; }]; },
            useRef(initial: unknown) { const index = cursor++; return values[index] ||= { current: initial }; },
            useEffect(effect: () => (() => void) | void) { if (!mounted) effects.push(effect); },
        },
        antd: { App: { useApp: () => ({ message: { error: (value: unknown) => notices.push(value), warning: (value: unknown) => notices.push(value) } }) }, Button: "Button", Input: Object.assign(function Input() {}, { Password: "Password" }) },
        "lucide-react": new Proxy({}, { get: (_, key) => String(key) }),
        "@/stores/use-user-store": { useUserStore: (select: Function) => select({ loginWithPassword: async (...args: unknown[]) => { passwordCalls.push(args); return options.login ? options.login() : { mustChangePassword: false }; } }) },
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
        assignments, replacements, startCalls, passwordCalls, notices, get reloads() { return reloads; }, get methodCalls() { return methodCalls; },
        render() { cursor = 0; const tree = elements(module.exports.default()); mounted = true; return tree; },
        mountEffects() { return effects.map(effect => effect()); },
    };
}

test("personal login validates each required field inline without submitting or showing a toast", async () => {
    const page = loginPage();
    page.render().find(element => element.type === "form")!.props.onSubmit({ preventDefault() {} });
    await settle();
    let tree = page.render();
    for (const field of ["identifier", "password"]) {
        const input = tree.find(element => element.props.id === `personal-login-${field}`)!;
        expect(input.props.status).toBe("error");
        expect(input.props["aria-invalid"]).toBe(true);
        const error = tree.find(element => element.props.id === input.props["aria-describedby"])!;
        expect(error.props.role).toBe("alert");
        expect(error.props.children).toBe(field === "identifier" ? "请输入个人账号" : "请输入密码");
    }
    expect(page.passwordCalls).toEqual([]);
    expect(page.notices).toEqual([]);
    tree.find(element => element.props.id === "personal-login-identifier")!.props.onChange({ target: { value: "   " } });
    tree = page.render();
    expect(tree.find(element => element.props.id === "personal-login-identifier-error")).toBeUndefined();
    expect(tree.find(element => element.props.id === "personal-login-password-error")).toBeTruthy();
    tree.find(element => element.type === "form")!.props.onSubmit({ preventDefault() {} });
    await settle();
    expect(page.render().find(element => element.props.id === "personal-login-identifier-error")).toBeTruthy();
    expect(page.passwordCalls).toEqual([]);
});

test("personal login preserves server errors inline, clears on edit and permits a successful retry", async () => {
    let attempts = 0;
    const page = loginPage({ returnTo: "/canvas/saved", login: async () => {
        if (++attempts === 1) throw new Error("账号已锁定，请联系管理员");
        return { mustChangePassword: true };
    } });
    let tree = page.render();
    tree.find(element => element.props.id === "personal-login-identifier")!.props.onChange({ target: { value: " designer " } });
    tree.find(element => element.props.id === "personal-login-password")!.props.onChange({ target: { value: " original password " } });
    page.render().find(element => element.type === "form")!.props.onSubmit({ preventDefault() {} });
    await settle();
    tree = page.render();
    expect(tree.find(element => element.props.role === "alert")!.props.children).toBe("账号已锁定，请联系管理员");
    expect(page.passwordCalls).toEqual([["designer", " original password ", "designer"]]);
    expect(page.assignments).toEqual([]);
    expect(page.notices).toEqual([]);
    tree.find(element => element.props.id === "personal-login-password")!.props.onChange({ target: { value: "corrected" } });
    tree = page.render();
    expect(tree.filter(element => element.props.role === "alert")).toEqual([]);
    tree.find(element => element.type === "form")!.props.onSubmit({ preventDefault() {} });
    await settle();
    expect(page.passwordCalls).toEqual([["designer", " original password ", "designer"], ["designer", "corrected", "designer"]]);
    expect(page.assignments).toEqual(["/change-password?returnTo=%2Fcanvas%2Fsaved"]);
});

test("pending personal login remains single-flight and retains the original return destination", async () => {
    const pending = Promise.withResolvers<{ mustChangePassword: boolean }>();
    const page = loginPage({ returnTo: "/creative?tool=sketch", login: () => pending.promise });
    let tree = page.render();
    tree.find(element => element.props.id === "personal-login-identifier")!.props.onChange({ target: { value: "designer" } });
    tree.find(element => element.props.id === "personal-login-password")!.props.onChange({ target: { value: "password" } });
    const submit = page.render().find(element => element.type === "form")!.props.onSubmit;
    submit({ preventDefault() {} });
    submit({ preventDefault() {} });
    tree = page.render();
    expect(tree.find(element => element.props.id === "personal-login-identifier")!.props.disabled).toBe(true);
    expect(tree.find(element => element.props.children === "登录工作台")!.props.loading).toBe(true);
    expect(page.passwordCalls).toHaveLength(1);
    pending.resolve({ mustChangePassword: false });
    await settle();
    expect(page.assignments).toEqual(["/creative?tool=sketch"]);
});

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
