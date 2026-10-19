import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import { create } from "zustand";
import ts from "typescript";

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const element = node as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

function pageHarness(path: string, dependencies: Record<string, unknown>) {
    const url = new URL(path, import.meta.url);
    const requireModule = createRequire(url);
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const values: any[] = [], assignments: string[] = [], navigations: string[] = [], errors: string[] = [];
    let cursor = 0;
    const mocks: Record<string, unknown> = {
        react: { ...React, useEffect: () => undefined, useState(initial: any) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], (value: any) => { values[index] = value; }]; }, useRef(initial: unknown) { const index = cursor++; return values[index] ||= { current: initial }; } },
        antd: { App: { useApp: () => ({ message: { success() {}, error: (value: string) => errors.push(value), warning: (value: string) => errors.push(value) } }) }, Button: "Button", Input: Object.assign(function Input() {}, { Password: "Password" }), Form: Object.assign(function Form() {}, { Item: "FormItem" }) },
        "lucide-react": new Proxy({}, { get: (_, key) => String(key) }),
        "react-router-dom": { useNavigate: () => (path: string) => navigations.push(path) },
        "@/lib/deployment-features": { deploymentFeatures: { authenticationEnabled: true, oaLoginEnabled: false } },
        ...dependencies,
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", "window", code)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : requireModule(name), module, module.exports, { location: { assign: (path: string) => assignments.push(path) } });
    return { assignments, navigations, errors, render() { cursor = 0; return elements(module.exports.default()); } };
}
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

test("personal login sends the designer portal once and reloads only after confirmed identity", async () => {
    let resolve!: (user: { mustChangePassword: boolean }) => void;
    const calls: unknown[][] = [];
    const pending = new Promise<{ mustChangePassword: boolean }>(done => { resolve = done; });
    const page = pageHarness("../src/pages/login/index.tsx", {
        "@/stores/use-user-store": { useUserStore: (select: Function) => select({ loginWithPassword: (...args: unknown[]) => { calls.push(args); return pending; } }) },
    });
    let tree = page.render();
    tree.find(element => element.props.id === "personal-login-identifier")!.props.onChange({ target: { value: " person-a " } });
    tree.find(element => element.props.id === "personal-login-password")!.props.onChange({ target: { value: "temporary-test-password" } });
    const submit = page.render().find(element => element.type === "form")!.props.onSubmit;
    submit({ preventDefault() {} }); submit({ preventDefault() {} });
    expect(calls).toEqual([["person-a", "temporary-test-password", "designer"]]);
    expect(page.assignments).toEqual([]);
    resolve({ mustChangePassword: true }); await settle();
    expect(page.assignments).toEqual(["/change-password"]);
    expect(page.navigations).toEqual([]);
});

test("failed personal login never navigates or loads a workspace", async () => {
    const page = pageHarness("../src/pages/login/index.tsx", {
        "@/stores/use-user-store": { useUserStore: (select: Function) => select({ loginWithPassword: async () => { throw new Error("账号或密码错误"); } }) },
    });
    const tree = page.render();
    tree.find(element => element.props.id === "personal-login-identifier")!.props.onChange({ target: { value: "person" } });
    tree.find(element => element.props.id === "personal-login-password")!.props.onChange({ target: { value: "wrong" } });
    page.render().find(element => element.type === "form")!.props.onSubmit({ preventDefault() {} });
    await settle();
    expect(page.assignments).toEqual([]); expect(page.navigations).toEqual([]);
    expect(page.errors).toEqual(["账号或密码错误"]);
});

test("administrator password login starts a new page rather than reusing designer stores", async () => {
    const page = pageHarness("../src/pages/admin/login.tsx", {
        "@/stores/use-user-store": { isAdminRole: (role: string) => role === "super_admin", useUserStore: (select: Function) => select({ loginWithPassword: async () => ({ role: "super_admin", mustChangePassword: false }) }) },
    });
    const tree = page.render();
    tree.find(element => element.props.autoComplete === "username")!.props.onChange({ target: { value: "admin" } });
    tree.find(element => element.props.autoComplete === "current-password")!.props.onChange({ target: { value: "admin-test-password" } });
    await page.render().find(element => element.type === "Button" && element.props.children === "登录后台")!.props.onClick();
    expect(page.assignments).toEqual(["/admin"]); expect(page.navigations).toEqual([]);
});

test("password change confirms the updated session and bootstraps either account role afresh", async () => {
    for (const role of ["designer", "super_admin"]) {
        const updates: unknown[] = [];
        const page = pageHarness("../src/pages/change-password/index.tsx", {
            "@/services/api/auth": { changeOwnPassword: async () => undefined, getCurrentSession: async () => ({ user: { id: "verified", role, mustChangePassword: false } }) },
            "@/stores/use-user-store": { isAdminRole: (value: string) => value === "super_admin", useUserStore: (select: Function) => select({ updateUser: (user: unknown) => updates.push(user) }) },
        });
        await page.render().find(element => element.props.onFinish)!.props.onFinish({ currentPassword: "old-password", newPassword: "new-password-123", confirmPassword: "new-password-123" });
        expect(updates).toEqual([{ id: "verified", role, mustChangePassword: false }]);
        expect(page.assignments).toEqual([role === "super_admin" ? "/admin" : "/"]);
        expect(page.navigations).toEqual([]);
    }
});

test("password identities do not initialize OA analytics storage or collection", () => {
    const source = new URL("../src/stores/use-usage-store.ts", import.meta.url);
    const code = ts.transpileModule(readFileSync(source, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    let subscription!: (state: unknown) => void;
    let storageCalls = 0;
    const dependencies: Record<string, unknown> = {
        zustand: { create },
        localforage: { createInstance() { storageCalls++; throw new Error("password mode must not initialize analytics storage"); } },
        "@/lib/storage-access": {}, "@/lib/usage-session": {}, "@/services/api/usage-client": {},
        "@/stores/use-user-store": { useUserStore: { subscribe: (listener: (state: unknown) => void) => { subscription = listener; } } },
        "@/lib/deployment-features": { deploymentFeatures: { authenticationEnabled: true, oaLoginEnabled: false } },
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name], module, module.exports);
    subscription({ status: "authenticated", user: { id: "password-a", status: "active" } });
    subscription({ status: "authenticated", user: { id: "password-b", status: "active" } });
    expect(storageCalls).toBe(0);
    expect(module.exports.useUsageStore.getState()).toEqual({ owner: null, counts: {}, storageUnavailable: false });
});
