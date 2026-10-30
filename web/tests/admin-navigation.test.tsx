import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { navigationTools, navigationModuleKey, navigationToolBilling } from "@/constant/navigation-tools";
import { isAdminRole } from "@/stores/use-user-store";
import { i18nHarness } from "./helpers/i18n-harness";

const requireModule = createRequire(import.meta.url);
const compiled = new Map<string, string>();
function component(path: string, dependencies: Record<string, unknown>) {
    let code = compiled.get(path);
    if (!code) {
        code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
        }).outputText;
        compiled.set(path, code);
    }
    const module = { exports: {} as Record<string, React.ComponentType<any>> };
    const load = (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name);
    new Function("require", "module", "exports", code)(load, module, module.exports);
    return module.exports;
}

type Role = "super_admin" | "department_admin" | "designer" | undefined;
function navigation(surface: "desktop" | "mobile", role: Role, rolePortalsEnabled: boolean) {
    const user = role ? { role, groupId: "test-group" } : null;
    const deploymentFeatures = { authenticationEnabled: true, oaLoginEnabled: false, creditsEnabled: false, rolePortalsEnabled };
    const bindings = { tools: [], status: "success", estimate: () => ({ configured: false }) };
    const canvas = { hydrated: true, createProject: () => "unused", projects: [] };
    const useCanvasStore = Object.assign((select: (state: typeof canvas) => unknown) => select(canvas), { getState: () => canvas });
    const dependencies: Record<string, unknown> = {
        "@/lib/i18n": i18nHarness,
        "./language-switch": { LanguageSwitch: () => null },
        "@/components/layout/language-switch": { LanguageSwitch: () => null },
        "@/hooks/use-navigation-preferences": { useNavigationPreferences: () => ({ pinned: [], collapsed: [], togglePin() {}, toggleGroup() {} }) },
        "@/lib/usage-navigation": { usageBoardForLocation: () => "home" },
        "@/components/layout/inchoice-brand": { InchoiceBrand: () => null },
        "react-router-dom": { Link: ({ to, children, ...rest }: any) => <a href={to} {...rest}>{children}</a>, useLocation: () => ({ pathname: "/", search: "" }), useNavigate: () => () => undefined },
        "antd": { Drawer: ({ open, children }: any) => open ? <div>{children}</div> : null },
        "@/components/layout/frequent-navigation": { FrequentNavigation: () => null, UsageCollectionNotice: () => null },
        "@/components/layout/personal-session-actions": { PersonalSessionActions: () => null },
        "@/components/ui/animated-theme-toggler": { AnimatedThemeToggler: ({ children }: any) => <button>{children}</button> },
        "@/constant/navigation-tools": { navigationTools, navigationModuleKey, navigationToolBilling },
        "@/hooks/use-can-manage-config": { useCanManageConfig: () => role === "super_admin" },
        "@/lib/deployment-features": { deploymentFeatures },
        "@/lib/standalone-edition": { standaloneEdition: false },
        "@/lib/project-title": { nextProjectTitle: () => "unused" },
        "@/stores/canvas/use-canvas-store": { useCanvasStore },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: any) => select(bindings) },
        "@/stores/use-theme-store": { useThemeStore: (select: any) => select({ theme: "light", setTheme: () => undefined }) },
        "@/stores/use-user-store": { isAdminRole, useUserStore: (select: any) => select({ user }) },
        "@/stores/use-module-store": { useModuleStore: (select: any) => select({ flags: {} }), useModuleEnabled: () => true, isModuleAvailable: () => true },
    };
    dependencies["./frequent-navigation"] = dependencies["@/components/layout/frequent-navigation"];
    dependencies["@/components/layout/navigation-menu"] = component("../src/components/layout/navigation-menu.tsx", dependencies);
    dependencies["@/components/layout/navigation-footer"] = component("../src/components/layout/navigation-footer.tsx", dependencies);
    const { MobileNavDrawer } = component("../src/components/layout/mobile-nav-drawer.tsx", dependencies);
    dependencies["@/components/layout/mobile-nav-drawer"] = { MobileNavDrawer };
    const Element = surface === "mobile" ? MobileNavDrawer! : component("../src/components/layout/app-top-nav.tsx", dependencies).AppTopNav!;
    return renderToStaticMarkup(<Element open onClose={() => undefined} />);
}

describe("administrator maintenance navigation", () => {
    for (const surface of ["desktop", "mobile"] as const) {
        for (const rolePortalsEnabled of [false, true]) {
            for (const role of ["super_admin", "department_admin", "designer", undefined] as const) {
                test(`${surface}: role=${role ?? "guest"}, optional portals=${rolePortalsEnabled}`, () => {
                    const markup = navigation(surface, role, rolePortalsEnabled);
                    expect(markup.includes('href="/admin"')).toBe(isAdminRole(role));
                    expect(markup.includes("后台管理")).toBe(isAdminRole(role));
                    expect(markup.includes('href="/team"')).toBe(Boolean(role) && rolePortalsEnabled);
                    if (!rolePortalsEnabled) expect(markup.includes("API 设置")).toBe(false);
                });
            }
        }
    }
});
