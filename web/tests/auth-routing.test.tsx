import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";

import { shouldBypassStandaloneAuthGate } from "@/lib/standalone-access";
import { isAdminRole, type LocalUser } from "@/stores/use-user-store";

const requireModule = createRequire(import.meta.url);
const compiled = new Map<string, string>();
const Navigate = () => null;
const AuthBoundary = () => null;
type Features = { authenticationEnabled: boolean; creditsEnabled: boolean; rolePortalsEnabled: boolean };
type Route = { path?: string; element?: ReactElement<any>; children?: Route[] };

// Execute the real TSX module with only its browser/session boundaries replaced.
// This tests registered routes and redirect destinations without a DOM or global mocks.
function evaluateModule(path: string, dependencies: Record<string, unknown>) {
    let code = compiled.get(path);
    if (!code) {
        code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
        }).outputText;
        compiled.set(path, code);
    }
    const module = { exports: {} as Record<string, any> };
    const load = (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name);
    new Function("require", "module", "exports", code)(load, module, module.exports);
    return module.exports;
}

function registeredRoutes(features: Features, standalone = false): Route[] {
    const { router } = evaluateModule("../src/router.tsx", {
        "react-router-dom": { createBrowserRouter: (routes: Route[]) => ({ routes }), Navigate, Outlet: () => null },
        "@/layouts/user-layout": { default: () => null },
        "@/components/auth/auth-gate": { AuthGate: AuthBoundary },
        "@/components/auth/module-gate": { ModuleGate: () => null },
        "@/lib/standalone-edition": { standaloneEdition: standalone },
        "@/lib/deployment-features": { deploymentFeatures: features },
    });
    return router.routes[0].children;
}

function gateResult(features: Features, user: LocalUser | null, admin: boolean) {
    const state = { user, status: user ? "authenticated" : "guest", hydrateSession: async () => undefined };
    const { AuthGate } = evaluateModule("../src/components/auth/auth-gate.tsx", {
        react: { ...React, useEffect: () => undefined },
        "react-router-dom": { Navigate, useLocation: () => ({ pathname: admin ? "/admin" : "/canvas/test", search: "" }) },
        "@/stores/use-user-store": { isAdminRole, useUserStore: (selector: (value: typeof state) => unknown) => selector(state) },
        "@/lib/standalone-edition": { standaloneEdition: false },
        "@/lib/standalone-access": { shouldBypassStandaloneAuthGate },
        "@/lib/deployment-features": { deploymentFeatures: features },
    });
    return AuthGate({ admin, children: "protected content" }) as ReactElement<any>;
}

const visitor: LocalUser = {
    id: "visitor", username: "guest-visitor", displayName: "访客", role: "designer", status: "active",
    email: null, employeeNo: null, departmentId: null, departmentName: null,
    groupId: null, groupName: null, groupRole: null, mustChangePassword: false, mfaEnabled: false,
    creditBalance: 0, creditLimit: 0, monthlyCreditLimit: 0, temporaryCreditAdjustment: 0,
    creditPeriodStart: "2026-09-01", creditResetAt: "2026-10-01", avatarUrl: "",
};

describe("optional authentication route wiring", () => {
    for (const authenticationEnabled of [true, false]) {
        for (const creditsEnabled of [true, false]) {
            for (const rolePortalsEnabled of [true, false]) {
                const features = { authenticationEnabled, creditsEnabled, rolePortalsEnabled };
                test(`retains protected maintenance access with auth=${authenticationEnabled}, credits=${creditsEnabled}, portals=${rolePortalsEnabled}`, () => {
                    const routes = registeredRoutes(features);
                    const login = routes.find((route) => route.path === "/admin/login");
                    expect(login).toBeDefined();
                    expect(login!.element!.type).not.toBe(Navigate);
                    const password = routes.find((route) => route.path === "/change-password");
                    expect(password?.element?.type).toBe(AuthBoundary);
                    expect(routes.find((route) => route.path === "/admin")?.element?.props.admin).toBe(true);
                    const publicLogin = routes.find((route) => route.path === "/login")?.element;
                    if (authenticationEnabled) expect(publicLogin?.type).not.toBe(Navigate);
                    else expect(publicLogin?.props.to).toBe("/");
                });
            }
        }
    }

    test("does not add server account routes to the standalone edition", () => {
        const routes = registeredRoutes({ authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false }, true);
        expect(routes.some((route) => route.path === "/admin" || route.path === "/admin/login" || route.path === "/change-password")).toBe(false);
    });

    test("keeps anonymous workspaces usable without allowing guests into administration", () => {
        const features = { authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false };
        expect(gateResult(features, visitor, false).props.children).toBe("protected content");
        expect(gateResult(features, visitor, true).props.to).toBe("/");
        const loginRedirect = gateResult(features, null, true);
        expect(loginRedirect.type).toBe(Navigate);
        expect(loginRedirect.props.to).toBe("/admin/login");
    });

    test("requires a real administrator to finish the first-login password change even in anonymous mode", () => {
        const features = { authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false };
        const administrator = { ...visitor, id: "administrator", role: "super_admin" as const };
        expect(gateResult(features, administrator, true).props.children).toBe("protected content");
        expect(gateResult(features, { ...administrator, mustChangePassword: true }, true).props.to).toBe("/change-password");
    });
});
