import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";

const requireModule = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL("../src/components/layout/personal-session-actions.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}
async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

function sessionActions() {
    const state = {
        user: { id: "designer-a", displayName: "设计师甲", username: "designer-a" } as { id: string; displayName: string; username: string } | null,
        status: "authenticated",
        clearSession: async () => { calls.push("logout"); await logout(); },
    };
    const canvas = { cloudStatus: "synced", cloudError: "" };
    const features = { authenticationEnabled: true, oaLoginEnabled: false };
    const calls: string[] = [];
    const errors: string[] = [];
    const values: boolean[][] = [[], []];
    let instance = 0;
    let cursor = 0;
    let flush = async () => {};
    let logout = async () => { state.user = null; state.status = "guest"; };
    const module = { exports: {} as any };
    const mocks: Record<string, unknown> = {
        react: { ...React, useState(initial: boolean) {
            const currentInstance = instance; const index = cursor++;
            if (!(index in values[currentInstance])) values[currentInstance][index] = initial;
            return [values[currentInstance][index], (value: boolean) => { values[currentInstance][index] = value; }];
        } },
        antd: { App: { useApp: () => ({ message: { error: (value: string) => errors.push(value) } }) } },
        "react-router-dom": { useNavigate: () => (path: string, options: { replace: boolean }) => calls.push(`navigate:${path}:${options.replace}`) },
        "@/lib/deployment-features": { deploymentFeatures: features },
        "@/stores/use-user-store": { useUserStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) },
        "@/stores/canvas/use-canvas-store": {
            useCanvasStore: { getState: () => canvas },
            flushCanvasCloudPersistence: async () => { calls.push("flush"); await flush(); },
        },
    };
    new Function("require", "module", "exports", code)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : requireModule(name), module, module.exports);
    return {
        state, canvas, features, calls, errors,
        setFlush(value: typeof flush) { flush = value; },
        setLogout(value: typeof logout) { logout = value; },
        render(index = 0) {
            instance = index; cursor = 0;
            const tree = module.exports.PersonalSessionActions({ onSignedOut: () => calls.push("close") });
            return { tree, elements: elements(tree), button: elements(tree).find(element => element.type === "button") };
        },
    };
}

test("personal password sessions show the name and action; OA, trial, guests and unresolved sessions do not", () => {
    const h = sessionActions();
    expect(h.render().button?.props["aria-label"]).toBe("退出登录");
    expect(h.render().elements.some(element => element.props.title === "设计师甲")).toBe(true);
    h.state.user!.displayName = "";
    expect(h.render().elements.some(element => element.props.title === "designer-a")).toBe(true);
    h.features.authenticationEnabled = false;
    expect(h.render().tree).toBeNull();
    h.features.authenticationEnabled = true; h.features.oaLoginEnabled = true;
    expect(h.render().tree).toBeNull();
    h.features.oaLoginEnabled = false;
    for (const status of ["guest", "idle", "loading"]) { h.state.status = status; expect(h.render().tree).toBeNull(); }
    h.state.status = "authenticated"; h.state.user = null;
    expect(h.render().tree).toBeNull();
});

test("logout waits for a save even while the previous status is synced, then closes and replaces the login route", async () => {
    const h = sessionActions(); const pending = Promise.withResolvers<void>();
    h.setFlush(() => pending.promise);
    const operation = h.render().button!.props.onClick();
    expect(h.calls).toEqual(["flush"]);
    expect(h.render().button!.props.disabled).toBe(true);
    pending.resolve(); await operation;
    expect(h.calls).toEqual(["flush", "logout", "close", "navigate:/login:true"]);
    expect(h.state.status).toBe("guest");
    expect(h.errors).toEqual([]);
});

test("a thrown save error keeps the identity and permits a later retry without closing or navigation", async () => {
    const h = sessionActions(); h.setFlush(async () => { throw new Error("本机保存失败"); });
    await h.render().button!.props.onClick();
    expect(h.calls).toEqual(["flush"]);
    expect(h.errors).toEqual(["本机保存失败"]);
    expect(h.state.user?.id).toBe("designer-a");
    expect(h.render().button!.props.disabled).toBe(false);
    h.setFlush(async () => {}); await h.render().button!.props.onClick();
    expect(h.calls).toEqual(["flush", "flush", "logout", "close", "navigate:/login:true"]);
});

test("recorded cloud failures or incomplete saves block logout even when flush resolves", async () => {
    for (const cloudStatus of ["error", "local-error", "pending", "syncing", "loading"]) {
        const h = sessionActions(); h.canvas.cloudStatus = cloudStatus;
        h.canvas.cloudError = cloudStatus.includes("error") ? "同步失败" : "";
        await h.render().button!.props.onClick();
        expect(h.calls).toEqual(["flush"]);
        expect(h.state.status).toBe("authenticated");
        expect(h.state.user?.id).toBe("designer-a");
        expect(h.errors).toEqual([h.canvas.cloudError || "画布尚未保存完成，请稍后重试退出登录。"]);
        expect(h.render().button!.props.disabled).toBe(false);
    }
});

test("server logout failure does not close the drawer, navigate or clear the identity", async () => {
    const h = sessionActions(); h.setLogout(async () => { throw new Error("退出请求失败"); });
    await h.render().button!.props.onClick();
    expect(h.calls).toEqual(["flush", "logout"]);
    expect(h.errors).toEqual(["退出请求失败"]);
    expect(h.state.user?.id).toBe("designer-a");
    expect(h.render().button!.props.disabled).toBe(false);
});

test("duplicate clicks across both navigation instances share one save and logout request", async () => {
    const h = sessionActions(); const pending = Promise.withResolvers<void>();
    h.setLogout(() => pending.promise.then(() => { h.state.user = null; h.state.status = "guest"; }));
    const desktop = h.render(); const mobile = h.render(1);
    const operation = desktop.button!.props.onClick();
    await desktop.button!.props.onClick(); await mobile.button!.props.onClick(); await settle();
    expect(h.calls).toEqual(["flush", "logout"]);
    pending.resolve(); await operation;
    expect(h.calls).toEqual(["flush", "logout", "close", "navigate:/login:true"]);
});

test("an identity change during saving or logout does not log out or navigate the newer identity", async () => {
    for (const stage of ["save", "logout"]) {
        const h = sessionActions(); const pending = Promise.withResolvers<void>();
        if (stage === "save") h.setFlush(() => pending.promise);
        else h.setLogout(() => pending.promise);
        const operation = h.render().button!.props.onClick(); await settle();
        h.state.user = { id: "designer-b", displayName: "设计师乙", username: "designer-b" };
        pending.resolve(); await operation;
        expect(h.calls).toEqual(stage === "save" ? ["flush"] : ["flush", "logout"]);
        expect(h.state.user.id).toBe("designer-b");
        expect(h.errors).toEqual([]);
    }
});

test("desktop footer and mobile drawer mount the same guarded personal account action", () => {
    const desktop = readFileSync(new URL("../src/components/layout/app-top-nav.tsx", import.meta.url), "utf8");
    const mobile = readFileSync(new URL("../src/components/layout/mobile-nav-drawer.tsx", import.meta.url), "utf8");
    expect(desktop).toContain("<PersonalSessionActions />");
    expect(mobile).toContain("<PersonalSessionActions onSignedOut={onClose} />");
});
