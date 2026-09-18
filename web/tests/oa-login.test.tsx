import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { AuthGate } from "@/components/auth/auth-gate";
import { deploymentFeatures } from "@/lib/deployment-features";
import { consumeOaLoginToken } from "@/lib/oa-login";
import { useUserStore } from "@/stores/use-user-store";

const originalFetch = globalThis.fetch;
const initialFeatures = { ...deploymentFeatures };
const initialUserSnapshot = { ...useUserStore.getInitialState() };
afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.assign(deploymentFeatures, initialFeatures);
    Object.assign(useUserStore.getInitialState(), initialUserSnapshot);
    useUserStore.setState({ user: null, status: "idle" });
});

describe("OA token bootstrap", () => {
    test("removes every token from the URL while preserving path, other parameters and hash", () => {
        const replacements: unknown[][] = [];
        const state = { existing: true };
        const token = consumeOaLoginToken({ href: "https://canvas.example/creative?tool=sketch&token=one%2Btwo#preview" }, {
            state,
            replaceState: (...args) => { replacements.push(args); },
        });
        expect(token).toBe("one+two");
        expect(replacements).toEqual([[state, "", "/creative?tool=sketch#preview"]]);
    });

    test("distinguishes absent tokens from empty or ambiguous explicit tokens", () => {
        const replacements: unknown[][] = [];
        const history = { state: null, replaceState: (...args: unknown[]) => { replacements.push(args); } };
        expect(consumeOaLoginToken({ href: "https://canvas.example/" }, history)).toBeNull();
        expect(replacements).toHaveLength(0);
        expect(consumeOaLoginToken({ href: "https://canvas.example/?token=" }, history)).toBe("");
        expect(consumeOaLoginToken({ href: "https://canvas.example/?token=a&token=b" }, history)).toBe("");
        expect(replacements.every((args) => args[2] === "/")).toBe(true);
    });

    test("failed exchange clears the old user and never falls back to an old session", async () => {
        const calls: string[] = [];
        globalThis.fetch = (async (input) => {
            calls.push(String(input));
            return Response.json({ message: "invalid token" }, { status: 401 });
        }) as typeof fetch;
        useUserStore.setState({ user: { id: "old-user" } as never, status: "authenticated" });
        await useUserStore.getState().exchangeOaToken("rejected");
        await useUserStore.getState().hydrateSession();
        expect(useUserStore.getState().user).toBeNull();
        expect(useUserStore.getState().status).toBe("guest");
        expect(calls).toEqual(["/api/auth/oa/exchange"]);
    });

    test("successful exchange uses POST body and cookie credentials, then permits cookie-only restoration", async () => {
        const calls: Array<{ path: string; init?: RequestInit }> = [];
        globalThis.fetch = (async (input, init) => {
            calls.push({ path: String(input), init });
            return Response.json({ user: { id: "employee-17", displayName: "设计师", role: "designer" } });
        }) as typeof fetch;
        await useUserStore.getState().exchangeOaToken("single-use");
        expect(useUserStore.getState().user?.id).toBe("employee-17");
        expect(useUserStore.getState().status).toBe("authenticated");
        expect(calls[0]).toMatchObject({ path: "/api/auth/oa/exchange", init: {
            method: "POST", body: JSON.stringify({ token: "single-use" }), credentials: "include", referrerPolicy: "no-referrer", cache: "no-store",
        } });
        useUserStore.setState({ user: null, status: "idle" });
        await useUserStore.getState().hydrateSession();
        expect(calls[1].path).toBe("/api/auth/session");
        expect(calls[1].init?.body).toBeUndefined();
        expect(useUserStore.getState().user?.id).toBe("employee-17");
    });

    test("enterprise sessions without identity request company OA re-entry without a QR or password page", () => {
        deploymentFeatures.oaLoginEnabled = true;
        useUserStore.setState({ user: null, status: "guest" });
        // React server rendering reads Zustand's initial snapshot, not current state.
        Object.assign(useUserStore.getInitialState(), useUserStore.getState());
        const html = renderToStaticMarkup(<MemoryRouter><AuthGate><p>工作区内容</p></AuthGate></MemoryRouter>);
        expect(html).toContain("请从公司 OA 重新进入");
        expect(html).toContain("重新检查连接");
        expect(html).not.toMatch(/扫码|密码|token=/);
        expect(html).not.toContain("工作区内容");
    });

    test("OA employees can create without password changes but do not gain admin privileges", () => {
        deploymentFeatures.oaLoginEnabled = true;
        useUserStore.setState({ user: { id: "visitor", role: "designer", mustChangePassword: true } as never, status: "authenticated" });
        Object.assign(useUserStore.getInitialState(), useUserStore.getState());
        const workspace = renderToStaticMarkup(<MemoryRouter><AuthGate><p>工作区内容</p></AuthGate></MemoryRouter>);
        expect(workspace).toContain("工作区内容");
        const admin = renderToStaticMarkup(<MemoryRouter><AuthGate admin><p>管理后台内容</p></AuthGate></MemoryRouter>);
        expect(admin).not.toContain("管理后台内容");
    });
});
