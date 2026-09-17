import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { create } from "zustand";
import ts from "typescript";

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
    const api: any = {};
    new Function("exports", "fetch", apiCode)(api, (path: string) => {
        const pending = Promise.withResolvers<Response>();
        requests.push({ path, ...pending });
        return pending.promise;
    });
    const exports: any = {};
    new Function("exports", "require", storeCode)(exports, (name: string) => name === "zustand" ? { create } : api);
    const store = exports.useUserStore;
    return { requests, store, api, state: () => store.getState() };
}

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

test("401 and 403 invalidate even a known identity", async () => {
    for (const status of [401, 403]) {
        const s = session(); s.state().updateUser(employee("a"));
        const task = s.state().hydrateSession();
        s.requests[0].resolve(Response.json({}, { status })); await task;
        expect(s.state().user).toBeNull(); expect(s.state().status).toBe("guest");
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
