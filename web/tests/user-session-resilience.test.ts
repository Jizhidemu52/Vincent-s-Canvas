import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { create } from "zustand";
import ts from "typescript";
import { isWorkspaceRole } from "../../shared/workspace-access";

function transpile(path: string) {
    return ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
}
const apiCode = transpile("../src/services/api/auth.ts");
const storeCode = transpile("../src/stores/use-user-store.ts");
const employee = (id: string) => ({ id, status: "active", role: "designer", username: id, avatarUrl: "" });
const response = (id: string) => Response.json({ user: employee(id) });

// Run real API + store in isolated module instances, without global mocks leaking to other suites.
function session() {
    const requests: { path: string; resolve: (value: Response) => void; reject: (error: Error) => void }[] = [];
    const broadcasts: Array<string | null> = [];
    const api: any = {};
    new Function("exports", "fetch", apiCode)(api, (path: string) => {
        const pending = Promise.withResolvers<Response>();
        requests.push({ path, ...pending });
        return pending.promise;
    });
    const exports: any = {};
    new Function("exports", "require", storeCode)(exports, (name: string) => name === "zustand" ? { create } : name === "../../../shared/workspace-access" ? { isWorkspaceRole } : name === "@/lib/workspace-session-events" ? { broadcastWorkspaceIdentity(owner: string | null) { broadcasts.push(owner); } } : api);
    const store = exports.useUserStore;
    return { requests, broadcasts, store, api, state: () => store.getState() };
}

test("super-admin password login broadcasts its own personal owner without making a department workspace", async () => {
    for (const role of ["super_admin", "department_admin"]) {
        const s = session();
        const login = s.state().loginWithPassword("admin", "FixtureOnly2026", "admin");
        s.requests[0].resolve(Response.json({ user: { ...employee("admin"), role } }));
        await login;
        expect(s.broadcasts).toEqual([role === "super_admin" ? "admin" : null]);
    }
});

test("known identity survives network and 5xx outages without losing its working session", async () => {
    for (const status of [null, 500, 503]) {
        const s = session(); s.state().updateUser(employee("a"));
        const knownUser = s.state().user;
        const task = s.state().hydrateSession();
        if (status === null) s.requests[0].reject(new TypeError("Failed to fetch"));
        else s.requests[0].resolve(Response.json({ message: "unavailable" }, { status }));
        await task;
        expect(s.state().user).toBe(knownUser);
        expect(s.state().status).toBe("authenticated");
    }
});

test("401 locks the known local draft while 403 revokes the identity", async () => {
    for (const status of [401, 403]) {
        const s = session(); s.state().updateUser(employee("a"));
        const task = s.state().hydrateSession();
        s.requests[0].resolve(Response.json({}, { status })); await task;
        if (status === 401) { expect(s.state().user.id).toBe("a"); expect(s.state().status).toBe("expired"); }
        else { expect(s.state().user).toBeNull(); expect(s.state().status).toBe("guest"); }
    }
});

test("first-load network failure never invents an identity and malformed success is rejected", async () => {
    for (const malformed of [false, true]) {
        const s = session(); const task = s.state().hydrateSession();
        if (malformed) s.requests[0].resolve(Response.json({ user: {} }));
        else s.requests[0].reject(new TypeError("offline"));
        await task; expect(s.state().user).toBeNull(); expect(s.state().status).toBe("guest");
    }
});

test("an explicit invalid OA token rejects the old identity and late hydration", async () => {
    const s = session(); s.state().updateUser(employee("a"));
    const hydration = s.state().hydrateSession();
    const exchange = s.state().exchangeOaToken("invalid");
    expect(s.state().user).toBeNull();
    s.requests[1].resolve(Response.json({}, { status: 401 })); await exchange;
    s.requests[0].resolve(response("a")); await hydration;
    expect(s.state().user).toBeNull();
    await s.state().hydrateSession(); expect(s.requests).toHaveLength(2);
});

test("new OA identity wins against old hydration success or unauthorized failure", async () => {
    for (const unauthorized of [false, true]) {
        const s = session(); s.state().updateUser(employee("a"));
        const old = s.state().hydrateSession(); const next = s.state().exchangeOaToken("b");
        s.requests[1].resolve(response("b")); await next;
        s.requests[0].resolve(unauthorized ? Response.json({}, { status: 401 }) : response("a")); await old;
        expect(s.state().user.id).toBe("b");
    }
});

test("two concurrent OA exchanges cannot overwrite the newest identity", async () => {
    const s = session(); const a = s.state().exchangeOaToken("a"); const b = s.state().exchangeOaToken("b");
    s.requests[1].resolve(response("b")); await b;
    s.requests[0].resolve(response("a")); await a;
    expect(s.state().user.id).toBe("b");
});

test("new password login and explicit logout invalidate pending hydration", async () => {
    for (const logout of [false, true]) {
        const s = session(); s.state().updateUser(employee("a"));
        const old = s.state().hydrateSession();
        const newer = logout ? s.state().clearSession() : s.state().loginWithPassword("b", "password", "designer");
        s.requests[1].resolve(logout ? new Response(null, { status: 204 }) : response("b")); await newer;
        s.requests[0].resolve(response("a")); await old;
        expect(s.state().user?.id || null).toBe(logout ? null : "b");
    }
});

test("auth API exposes response status and marks transport failures separately", async () => {
    const s = session();
    const unauthorized = s.api.getCurrentSession().catch((error: unknown) => error);
    s.requests[0].resolve(Response.json({}, { status: 401 }));
    expect((await unauthorized).status).toBe(401);
    const offline = s.api.getCurrentSession().catch((error: unknown) => error);
    s.requests[1].reject(new TypeError("offline"));
    const error = await offline;
    expect(error).toBeInstanceOf(s.api.AuthRequestError); expect(error.status).toBeNull();
});

test("logout reaches the server before identity-clearing subscribers can reload the page", async () => {
    const s = session(); s.state().updateUser({ ...employee("admin"), role: "super_admin" });
    const known = s.state().user;
    let serverConfirmed = false;
    const restarts: boolean[] = [];
    s.store.subscribe((state: any) => { if (!state.user) restarts.push(serverConfirmed); });
    const logout = s.state().clearSession();
    expect(s.requests.map(request => request.path)).toEqual(["/api/auth/logout"]);
    expect(s.state().user).toBe(known);
    expect(restarts).toEqual([]); expect(s.broadcasts).toEqual([]);
    await s.state().hydrateSession();
    expect(s.requests).toHaveLength(1);
    serverConfirmed = true;
    s.requests[0].resolve(new Response(null, { status: 204 })); await logout;
    expect(s.broadcasts).toEqual([null]); expect(restarts).toEqual([true]);
    expect(s.state()).toMatchObject({ user: null, status: "guest" });
});

test("failed logout does not claim success or restart, and session verification can resume", async () => {
    const s = session(); s.state().updateUser(employee("a"));
    const known = s.state().user;
    const logout = s.state().clearSession();
    s.requests[0].reject(new TypeError("offline"));
    await expect(logout).rejects.toThrow("暂时无法连接认证服务");
    expect(s.state().user).toBe(known); expect(s.broadcasts).toEqual([]);
    const verification = s.state().hydrateSession();
    expect(s.requests[1].path).toBe("/api/auth/session");
    s.requests[1].resolve(Response.json({}, { status: 401 })); await verification;
    expect(s.state().user).toBe(known); expect(s.state().status).toBe("expired");
});

test("late logout acknowledgement cannot clear a newer verified identity", async () => {
    const s = session(); s.state().updateUser(employee("a"));
    const logout = s.state().clearSession();
    s.state().updateUser(employee("b"));
    s.requests[0].resolve(new Response(null, { status: 204 })); await logout;
    expect(s.state().user.id).toBe("b"); expect(s.broadcasts).toEqual([]);
});

test("logout clears the local identity when the server confirms the session already expired", async () => {
    const s = session(); s.state().updateUser(employee("expired"));
    const logout = s.state().clearSession();
    s.requests[0].resolve(Response.json({ error: "SESSION_EXPIRED", message: "登录已失效，请重新登录" }, { status: 401 }));
    await logout;
    expect(s.state()).toMatchObject({ user: null, status: "guest" });
    expect(s.broadcasts).toEqual([null]);
});

test("same-owner reauthentication restores access without clearing local identity", async () => {
    const s = session(); s.state().updateUser(employee("a"));
    const cleared: unknown[] = []; s.store.subscribe((state: any) => { if (!state.user) cleared.push(state); });
    s.state().expireSession(); expect(s.state().status).toBe("expired");
    const resume = s.state().reauthenticate("fixture");
    expect(s.state().status).toBe("expired");
    await s.state().hydrateSession(); expect(s.requests).toHaveLength(1);
    s.requests[0].resolve(response("a")); await resume;
    expect(s.state().status).toBe("authenticated"); expect(cleared).toEqual([]);
});

test("failed reauthentication stays locked and a different returned account discards authority", async () => {
    const s = session(); s.state().updateUser(employee("a")); s.state().expireSession();
    const failed = s.state().reauthenticate("wrong");
    s.requests[0].resolve(Response.json({}, { status: 401 }));
    await expect(failed).rejects.toThrow();
    expect(s.state()).toMatchObject({ status: "expired", user: { id: "a" } });
    const mismatch = s.state().reauthenticate("fixture");
    s.requests[1].resolve(response("b"));
    await expect(mismatch).rejects.toThrow("登录账号已变化");
    expect(s.state()).toMatchObject({ status: "guest", user: null });
});

test("late reauthentication cannot replace a new explicit identity", async () => {
    const s = session(); s.state().updateUser(employee("a")); s.state().expireSession();
    const resume = s.state().reauthenticate("fixture"); s.state().updateUser(employee("b"));
    s.requests[0].resolve(response("a")); await expect(resume).rejects.toThrow("新的身份操作");
    expect(s.state().user.id).toBe("b");
});
