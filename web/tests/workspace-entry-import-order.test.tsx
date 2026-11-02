import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React, { type ReactElement } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { isWorkspaceRole } from "../../shared/workspace-access";
import { i18nHarness } from "./helpers/i18n-harness";

// Keep the entry module intact, replacing import() with a controllable asynchronous
// module boundary. This observes execution order instead of matching source text.
const code = ts.transpileModule(readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    transformers: { before: [context => source => {
        const visit: ts.Visitor = node => {
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                return ts.factory.createCallExpression(ts.factory.createIdentifier("importModule"), undefined, node.arguments);
            }
            return ts.visitEachChild(node, visit, context);
        };
        return ts.visitNode(source, visit) as ts.SourceFile;
    }] },
}).outputText;
const drainCode = ts.transpileModule(readFileSync(new URL("../src/lib/workspace-identity-drain.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
}).outputText;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

async function flushMicrotasks() {
    for (let index = 0; index < 12; index++) await Promise.resolve();
}

type Entry = "workspace" | "maintenance" | "maintenance-login" | "password-login" | "password-change" | "oa-required";
const providersPath = "@/components/layout/app-providers";
const routerPath = "@/router";
const adminPath = "@/pages/admin/login-entry";
const loginPath = "@/pages/login/login-entry";
const passwordPath = "@/pages/change-password/entry";

function harness(owner: string | null = "employee-a", oaMode = true, role = "designer") {
    const events: string[] = [];
    const renders: ReactElement[] = [];
    const features = deferred<boolean>();
    const entry = deferred<Entry>();
    const dynamicImports: string[] = [];
    const modules = new Map<string, ReturnType<typeof deferred<unknown>>>();
    let startup!: Promise<void>;
    let userChanged: ((state: { user: { id: string; role: string } | null }) => void) | undefined;
    let identityChanged: ((owner: string | null) => void) | undefined;
    const CompanyOaEntry = () => null;
    const ServiceUnavailable = () => null;
    const AdminLoginEntry = () => null;
    const PasswordLoginEntry = () => null;
    const PasswordChangeEntry = () => null;
    const AppProviders = () => null;
    const RouterProvider = () => null;
    const drain = {} as typeof import("@/lib/workspace-identity-drain");
    new Function("exports", drainCode)(drain);
    const allowReload = { current: false };
    let gateEffectCleanup: (() => void) | undefined;
    let confirmDiscard = false;
    const windowListeners = new Map<string, (event: any) => void>();
    const state = {
        user: owner ? { id: owner, role } : null,
        invalidateSession: () => { events.push("invalidate"); state.user = null; userChanged?.(state); },
    };
    const dependencies: Record<string, unknown> = {
        "@/lib/i18n": { ...i18nHarness, initializeUiLocale: async () => undefined },
        "../../shared/workspace-access": { isWorkspaceRole },
        react: { ...React, useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(), useRef: () => allowReload,
            useEffect: (effect: () => (() => void)) => { gateEffectCleanup?.(); gateEffectCleanup = effect(); } },
        "react/jsx-runtime": jsxRuntime,
        "react-dom/client": { createRoot: () => ({ render: (element: ReactElement) => { renders.push(element); } }) },
        "react-router-dom": { RouterProvider },
        "antd/dist/reset.css": {},
        "./styles/globals.css": {},
        "@/components/auth/service-unavailable": { ServiceUnavailable },
        "@/components/auth/company-oa-entry": { CompanyOaEntry },
        "@/lib/deployment-features": {
            deploymentFeatures: { oaLoginEnabled: oaMode, authenticationEnabled: true },
            loadDeploymentFeatures: () => {
                events.push("features");
                return { then: (run: (loaded: boolean) => Promise<void>) => { startup = features.promise.then(run); return startup; } };
            },
        },
        "@/lib/oa-login": { consumeOaLoginToken: () => { events.push("consume-token"); return "test-token"; } },
        "@/lib/workspace-entry": { prepareWorkspaceEntry: (token: string | null, pathname: string) => {
            events.push(`prepare:${token}:${pathname}`);
            return entry.promise;
        } },
        "@/lib/workspace-session-events": { subscribeWorkspaceIdentity: (listener: typeof identityChanged) => { identityChanged = listener; } },
        "@/lib/workspace-identity-drain": drain,
        "@/stores/use-user-store": { useUserStore: {
            getState: () => state,
            subscribe: (listener: typeof userChanged) => { userChanged = listener; },
        } },
    };
    const module = { exports: {} };
    const { IdentityChangedWorkspace } = new Function("require", "module", "exports", "window", "document", "importModule", `${code}\nreturn { IdentityChangedWorkspace };`)(
        (name: string) => {
            if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected static dependency: ${name}`);
            return dependencies[name];
        },
        module, module.exports,
        { location: { pathname: "/canvas/test", reload: () => { events.push("reload"); } }, history: {},
            confirm: () => { events.push("confirm"); return confirmDiscard; },
            addEventListener: (name: string, listener: (event: any) => void) => windowListeners.set(name, listener),
            removeEventListener: (name: string) => windowListeners.delete(name) },
        { getElementById: () => ({}), body: { style: {} } },
        (name: string) => {
            dynamicImports.push(name);
            const loading = deferred<unknown>();
            modules.set(name, loading);
            return loading.promise;
        },
    );
    return {
        events, renders, features, entry, dynamicImports, drain, IdentityChangedWorkspace,
        renderIdentityGate: () => IdentityChangedWorkspace() as ReactElement,
        confirmDiscard: (confirmed: boolean) => { confirmDiscard = confirmed; },
        beforeUnload: () => { let blocked = false; windowListeners.get("beforeunload")?.({ preventDefault: () => { blocked = true; } }); return blocked; },
        done: () => startup,
        CompanyOaEntry, ServiceUnavailable, AdminLoginEntry, PasswordLoginEntry, PasswordChangeEntry, AppProviders, RouterProvider,
        resolveImport: (name: string) => {
            const loading = modules.get(name);
            if (!loading) throw new Error(`Module was not requested: ${name}`);
            loading.resolve(name === providersPath ? { AppProviders } : name === routerPath ? { router: { state: { location: { pathname: "/canvas/test" } }, subscribe: () => () => undefined } }
                : { default: name === loginPath ? PasswordLoginEntry : name === passwordPath ? PasswordChangeEntry : AdminLoginEntry });
        },
        changeUser: (id: string) => { state.user = { id, role: "designer" }; userChanged?.(state); },
        broadcast: (id: string | null) => identityChanged?.(id),
    };
}

describe("workspace entry dynamic import boundary", () => {
    test("super-admin maintenance bootstrap retains its personal owner across same-owner broadcasts", async () => {
        const h = harness("admin-owner", true, "super_admin");
        h.features.resolve(true); h.entry.resolve("maintenance");
        await flushMicrotasks(); h.resolveImport(providersPath); h.resolveImport(routerPath); await h.done();
        h.broadcast("admin-owner"); expect(h.events).not.toContain("invalidate");
        h.broadcast("employee-b"); expect(h.events).toContain("invalidate");
    });
    test("credentials are consumed first and parallel workspace imports wait for completed authentication", async () => {
        const h = harness();
        expect(h.events).toEqual(["consume-token", "features"]);
        expect(h.dynamicImports).toEqual([]);
        h.features.resolve(true);
        await flushMicrotasks();
        expect(h.events).toEqual(["consume-token", "features", "prepare:test-token:/canvas/test"]);
        expect(h.dynamicImports).toEqual([]);

        h.entry.resolve("workspace");
        await flushMicrotasks();
        // Both imports start without waiting for either module to resolve.
        expect(h.dynamicImports).toEqual([providersPath, routerPath]);
        expect(h.renders).toHaveLength(1);
        h.resolveImport(routerPath);
        await flushMicrotasks();
        expect(h.renders).toHaveLength(1);
        h.resolveImport(providersPath);
        await h.done();
        expect(h.renders).toHaveLength(2);
        const mounted = h.renders.at(-1)!;
        expect(mounted.type).toBe(React.StrictMode);
        const providers = (mounted.props as { children: ReactElement }).children;
        expect(providers.type).toBe(h.AppProviders);
        expect((providers.props as { children: ReactElement }).children.type).toBe(h.RouterProvider);
    });

    test("an unavailable deployment never prepares authentication or imports the workspace", async () => {
        const h = harness();
        h.features.resolve(false);
        await h.done();
        expect(h.events).toEqual(["consume-token", "features"]);
        expect(h.dynamicImports).toEqual([]);
        expect(h.renders.at(-1)?.type).toBe(h.ServiceUnavailable);
    });

    test("an OA-required result renders the gate without importing workspace singletons", async () => {
        const h = harness();
        h.features.resolve(true);
        h.entry.resolve("oa-required");
        await h.done();
        expect(h.dynamicImports).toEqual([]);
        expect(h.renders.at(-1)?.type).toBe(h.CompanyOaEntry);
    });

    test("maintenance login imports only its dedicated entry after authentication preparation", async () => {
        const h = harness();
        h.features.resolve(true);
        await flushMicrotasks();
        expect(h.dynamicImports).toEqual([]);
        h.entry.resolve("maintenance-login");
        await flushMicrotasks();
        expect(h.dynamicImports).toEqual([adminPath]);
        h.resolveImport(adminPath);
        await h.done();
        expect(h.renders.at(-1)?.type).toBe(h.AdminLoginEntry);
    });

    test("an owner change during parallel imports never mounts the previous employee workspace", async () => {
        const h = harness();
        h.features.resolve(true);
        h.entry.resolve("workspace");
        await flushMicrotasks();
        expect(h.dynamicImports).toEqual([providersPath, routerPath]);
        h.changeUser("employee-b");
        expect(h.renders.at(-1)?.type).toBe(h.IdentityChangedWorkspace);
        h.resolveImport(providersPath);
        h.resolveImport(routerPath);
        await h.done();
        expect(h.renders.at(-1)?.type).toBe(h.IdentityChangedWorkspace);
        expect(h.renders.some(element => element.type === React.StrictMode)).toBe(false);
    });

    test("an unauthenticated password account imports only the login page, never router or business stores", async () => {
        const h = harness(null, false);
        h.features.resolve(true); h.entry.resolve("password-login");
        await flushMicrotasks();
        expect(h.dynamicImports).toEqual([loginPath]);
        h.resolveImport(loginPath); await h.done();
        expect(h.renders.at(-1)?.type).toBe(h.PasswordLoginEntry);
    });

    test("first-login password change has its own entry without initializing personal caches", async () => {
        const h = harness("password-user", false);
        h.features.resolve(true); h.entry.resolve("password-change");
        await flushMicrotasks();
        expect(h.dynamicImports).toEqual([passwordPath]);
        h.resolveImport(passwordPath); await h.done();
        expect(h.renders.at(-1)?.type).toBe(h.PasswordChangeEntry);
    });

    test("password identity changes during imports pause without reloading or mounting either account's workspace", async () => {
        const h = harness("password-a", false);
        h.features.resolve(true); h.entry.resolve("workspace");
        await flushMicrotasks(); h.changeUser("password-b");
        h.resolveImport(providersPath); h.resolveImport(routerPath); await h.done();
        expect(h.events).not.toContain("reload");
        expect(h.renders.at(-1)?.type).toBe(h.IdentityChangedWorkspace);
        expect(h.renders.some(element => element.type === React.StrictMode)).toBe(false);
    });

    test("a transient return to the first identity during imports cannot reopen the invalidated workspace", async () => {
        const h = harness("employee-a", false);
        h.features.resolve(true); h.entry.resolve("workspace");
        await flushMicrotasks(); h.changeUser("employee-b"); h.changeUser("employee-a");
        h.resolveImport(providersPath); h.resolveImport(routerPath); await h.done();
        expect(h.renders.at(-1)?.type).toBe(h.IdentityChangedWorkspace);
        expect(h.renders.some(element => element.type === React.StrictMode)).toBe(false);
        expect(h.events).not.toContain("reload");
    });

    test("mounted OA and password workspaces unmount, wait for the old drain and reload only on an explicit click", async () => {
        for (const oa of [true, false]) {
            const h = harness("employee-a", oa);
            const pending = deferred<void>();
            h.drain.registerWorkspaceIdentityDrain(() => pending.promise);
            h.features.resolve(true); h.entry.resolve("workspace");
            await flushMicrotasks(); h.resolveImport(providersPath); h.resolveImport(routerPath); await h.done();
            h.broadcast(null);
            expect(h.renders.at(-1)?.type).toBe(h.IdentityChangedWorkspace);
            let gate = h.renderIdentityGate();
            let button = elements(gate).find(element => element.type === "button")!;
            expect((button.props as any).disabled).toBe(true);
            (button.props as any).onClick();
            expect(h.beforeUnload()).toBe(true);
            expect(h.events).not.toContain("reload");
            pending.resolve(); await flushMicrotasks();
            gate = h.renderIdentityGate(); button = elements(gate).find(element => element.type === "button")!;
            expect((button.props as any).disabled).toBe(false);
            expect(text(gate)).toContain("页面不会自动刷新");
            if (oa) expect(text(gate)).toContain("公司 OA");
            expect(h.events).not.toContain("reload");
            (button.props as any).onClick();
            expect(h.events.filter(event => event === "reload")).toHaveLength(1);
        }
    });

    test("a failed old-partition drain warns, preserves the page on cancel and requires explicit discard confirmation", async () => {
        const h = harness("employee-a", false);
        h.drain.registerWorkspaceIdentityDrain(() => Promise.reject(new Error("disk failed")));
        h.features.resolve(true); h.entry.resolve("workspace");
        await flushMicrotasks(); h.resolveImport(providersPath); h.resolveImport(routerPath); await h.done();
        h.changeUser("employee-b"); await flushMicrotasks();
        const gate = h.renderIdentityGate();
        const button = elements(gate).find(element => element.type === "button")!;
        expect(text(gate)).toContain("旧账号草稿未确认保存");
        expect(h.beforeUnload()).toBe(true);
        (button.props as any).onClick();
        expect(h.events).toContain("confirm"); expect(h.events).not.toContain("reload");
        expect(h.beforeUnload()).toBe(true);
        h.confirmDiscard(true); (button.props as any).onClick();
        expect(h.events.filter(event => event === "reload")).toHaveLength(1);
        expect(h.beforeUnload()).toBe(false);
    });
});

function elements(node: unknown): ReactElement[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    return [node, ...elements((node.props as { children?: unknown }).children)];
}
function text(node: unknown): string {
    if (Array.isArray(node)) return node.map(text).join("");
    if (React.isValidElement(node)) return text((node.props as { children?: unknown }).children);
    return typeof node === "string" ? node : "";
}
