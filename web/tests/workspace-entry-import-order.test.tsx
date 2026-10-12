import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React, { type ReactElement } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

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

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

async function flushMicrotasks() {
    for (let index = 0; index < 12; index++) await Promise.resolve();
}

type Entry = "workspace" | "maintenance" | "maintenance-login" | "oa-required";
const providersPath = "@/components/layout/app-providers";
const routerPath = "@/router";
const adminPath = "@/pages/admin/login-entry";

function harness(owner: string | null = "employee-a") {
    const events: string[] = [];
    const renders: ReactElement[] = [];
    const features = deferred<boolean>();
    const entry = deferred<Entry>();
    const dynamicImports: string[] = [];
    const modules = new Map<string, ReturnType<typeof deferred<unknown>>>();
    let startup!: Promise<void>;
    let userChanged: ((state: { user: { id: string; role: string } | null }) => void) | undefined;
    const CompanyOaEntry = () => null;
    const ServiceUnavailable = () => null;
    const AdminLoginEntry = () => null;
    const AppProviders = () => null;
    const RouterProvider = () => null;
    const state = {
        user: owner ? { id: owner, role: "designer" } : null,
        invalidateSession: () => { events.push("invalidate"); state.user = null; },
    };
    const dependencies: Record<string, unknown> = {
        react: React,
        "react/jsx-runtime": jsxRuntime,
        "react-dom/client": { createRoot: () => ({ render: (element: ReactElement) => { renders.push(element); } }) },
        "react-router-dom": { RouterProvider },
        "antd/dist/reset.css": {},
        "./styles/globals.css": {},
        "@/components/auth/service-unavailable": { ServiceUnavailable },
        "@/components/auth/company-oa-entry": { CompanyOaEntry },
        "@/lib/deployment-features": {
            deploymentFeatures: { oaLoginEnabled: Boolean(owner) },
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
        "@/lib/workspace-session-events": { subscribeWorkspaceIdentity: () => undefined },
        "@/stores/use-user-store": { useUserStore: {
            getState: () => state,
            subscribe: (listener: typeof userChanged) => { userChanged = listener; },
        } },
    };
    const module = { exports: {} };
    new Function("require", "module", "exports", "window", "document", "importModule", code)(
        (name: string) => {
            if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected static dependency: ${name}`);
            return dependencies[name];
        },
        module, module.exports,
        { location: { pathname: "/canvas/test", reload: () => { events.push("reload"); } }, history: {} },
        { getElementById: () => ({}), body: { style: {} } },
        (name: string) => {
            dynamicImports.push(name);
            const loading = deferred<unknown>();
            modules.set(name, loading);
            return loading.promise;
        },
    );
    return {
        events, renders, features, entry, dynamicImports,
        done: () => startup,
        CompanyOaEntry, ServiceUnavailable, AdminLoginEntry, AppProviders, RouterProvider,
        resolveImport: (name: string) => {
            const loading = modules.get(name);
            if (!loading) throw new Error(`Module was not requested: ${name}`);
            loading.resolve(name === providersPath ? { AppProviders } : name === routerPath ? { router: "test-router" } : { default: AdminLoginEntry });
        },
        changeUser: (id: string) => { state.user = { id, role: "designer" }; userChanged?.(state); },
    };
}

describe("workspace entry dynamic import boundary", () => {
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
        expect(h.renders.at(-1)?.type).toBe(h.CompanyOaEntry);
        h.resolveImport(providersPath);
        h.resolveImport(routerPath);
        await h.done();
        expect(h.renders.at(-1)?.type).toBe(h.CompanyOaEntry);
        expect(h.renders.some(element => element.type === React.StrictMode)).toBe(false);
    });
});
