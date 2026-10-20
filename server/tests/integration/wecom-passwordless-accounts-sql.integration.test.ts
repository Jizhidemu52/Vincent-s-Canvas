import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler } from "express";
import type { AppConfig } from "../../src/config";
import type { Cache, Database } from "../../src/db";
import { createAccountsRouter } from "../../src/routes/accounts";
import { createAuthRouter } from "../../src/routes/auth";
import { createSessionToken, hashPassword, hashToken, verifyPassword } from "../../src/security";
import { requireAccountReady, sessionMiddleware } from "../../src/session";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
const initialPassword = "FixturePassword2026";
const config = {
    AUTH_ENABLED: "true", OA_LOGIN_ENABLED: "false", CREDITS_ENABLED: "false", NODE_ENV: "test",
    SESSION_COOKIE_NAME: "passwordless_fixture", SESSION_TTL_SECONDS: 600,
    WECOM_CORP_ID: "fixture-corp", WECOM_AGENT_ID: "fixture-agent", WECOM_SECRET: "fixture-secret",
    WECOM_CALLBACK_URL: "https://fixture.invalid/api/auth/wecom/callback",
} as AppConfig;
const disabledConfigurations = [
    { name: "legacy-one-argument", config: undefined },
    { name: "authentication-disabled", config: { ...config, AUTH_ENABLED: "false" } as AppConfig },
    { name: "oa-enabled", config: { ...config, OA_LOGIN_ENABLED: "true" } as AppConfig },
    ...(["WECOM_CORP_ID", "WECOM_AGENT_ID", "WECOM_SECRET", "WECOM_CALLBACK_URL"] as const)
        .map(field => ({ name: `missing-${field}`, config: { ...config, [field]: "" } as AppConfig })),
];

// Disposable local PostgreSQL only. No application config, production URL,
// directory data, or real WeCom calls are loaded.
integration("WeCom-only account creation in isolated PostgreSQL", () => {
    let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
    let db: Database;
    let origin: string;
    let server: ReturnType<ReturnType<typeof express>["listen"]>;
    let adminCookie: string;
    const departmentId = randomUUID();
    const cached = new Map<string, string>();
    const cache = {
        get: async (key: string) => cached.get(key) ?? null,
        set: async (key: string, value: string) => { cached.set(key, value); return "OK"; },
        del: async (key: string) => Number(cached.delete(key)),
        incr: async () => 1, expire: async () => 1,
    } as unknown as Cache;

    beforeAll(async () => {
        fixture = await createIsolatedPostgres();
        db = fixture.db;
        await db.query("INSERT INTO departments(id,name,code) VALUES($1,'Fixture department','fixture')", [departmentId]);
        const adminId = randomUUID();
        await db.query("INSERT INTO users(id,username,display_name,password_hash,role,must_change_password) VALUES($1,'fixture-admin','Fixture admin',$2,'super_admin',false)",
            [adminId, await hashPassword(initialPassword)]);
        const adminSession = createSessionToken();
        await db.query("INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
            [adminSession.id, adminId, hashToken(adminSession.token)]);
        adminCookie = `${config.SESSION_COOKIE_NAME}=${adminSession.token}`;
        const app = express().use(express.json()).use(cookieParser());
        app.use("/api/auth", createAuthRouter(db, cache, config));
        const requireAdmin = sessionMiddleware(db, cache, config, { allowGuest: false });
        app.use("/accounts/enabled", requireAdmin, requireAccountReady, createAccountsRouter(db, config));
        for (const deployment of disabledConfigurations) {
            app.use(`/accounts/${deployment.name}`, requireAdmin, requireAccountReady,
                deployment.config ? createAccountsRouter(db, deployment.config) : createAccountsRouter(db));
        }
        app.get("/creation", sessionMiddleware(db, cache, config), requireAccountReady, (_request, response) => response.json({ ready: true }));
        app.use(((error, _request, response, _next) => response.status(error.name === "ZodError" ? 400 : 500).json({ error: error.name, message: error.message })) as ErrorRequestHandler);
        server = app.listen(0, "127.0.0.1");
        await new Promise<void>(done => server.once("listening", done));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    }, 30000);

    afterAll(async () => {
        if (server) await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
        await fixture?.close();
    });

    function account(overrides: Record<string, unknown> = {}) {
        const key = randomUUID();
        return {
            username: `fixture-${key}`, displayName: "Fixture designer", employeeNo: `employee-${key}`,
            departmentId, role: "designer", creditBalance: 0, creditLimit: 0, ...overrides,
        };
    }
    const post = (path: string, body: unknown, cookie = adminCookie) => fetch(`${origin}${path}`, {
        method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
    });
    const stored = async (username: string) => (await db.query("SELECT id,employee_no,password_hash,must_change_password,role FROM users WHERE username=$1", [username])).rows[0];
    const creation = (body: unknown, deployment = "enabled") => post(`/accounts/${deployment}`, body);
    const bulk = (accounts: unknown[], deployment = "enabled") => post(`/accounts/${deployment}/bulk`, { accounts });

    test.each([undefined, ""])("eligible designers may create an account with password=%s without a local credential", async password => {
        const input = account({ password });
        const response = await creation(input);
        expect(response.status).toBe(201);
        expect(await response.json()).toMatchObject({ user: { mustChangePassword: false } });
        expect(await stored(input.username)).toMatchObject({
            employee_no: input.employeeNo, password_hash: null, must_change_password: false, role: "designer",
        });
    });

    test("bulk creation mixes omitted, empty and explicit strong passwords without weakening local accounts", async () => {
        const omitted = account();
        const empty = account({ password: "" });
        const local = account({ password: initialPassword });
        const response = await bulk([omitted, empty, local]);
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({ created: 3, failures: [] });
        for (const input of [omitted, empty]) {
            expect(await stored(input.username)).toMatchObject({ password_hash: null, must_change_password: false });
        }
        const localRow = await stored(local.username);
        expect(localRow.must_change_password).toBe(true);
        expect(await verifyPassword(localRow.password_hash, initialPassword)).toBe(true);
    });

    test.each(disabledConfigurations)("the $name deployment keeps password creation mandatory", async deployment => {
        for (const password of [undefined, ""]) {
            const missing = account({ password });
            const response = await creation(missing, deployment.name);
            expect(response.status).toBe(400);
            expect(await stored(missing.username)).toBeUndefined();
            const batch = await bulk([missing], deployment.name);
            expect(batch.status).toBe(207);
            expect(await batch.json()).toMatchObject({ created: 0, failures: [{ index: 0 }] });
            expect(await stored(missing.username)).toBeUndefined();
        }
        const local = account({ password: initialPassword });
        expect((await creation(local, deployment.name)).status).toBe(201);
        const row = await stored(local.username);
        expect(row.must_change_password).toBe(true);
        expect(await verifyPassword(row.password_hash, initialPassword)).toBe(true);
    });

    test.each([
        { name: "missing employee number", fields: { employeeNo: undefined } },
        { name: "null employee number", fields: { employeeNo: null } },
        { name: "department administrator", fields: { role: "department_admin" } },
    ])("$name cannot omit a password even with WeCom configured", async item => {
        for (const password of [undefined, ""]) {
            const input = account({ ...item.fields, password });
            expect((await creation(input)).status).toBe(400);
            expect((await bulk([input])).status).toBe(207);
            expect(await stored(input.username)).toBeUndefined();
        }
        const local = account({ ...item.fields, password: initialPassword });
        expect((await creation(local)).status).toBe(201);
        const row = await stored(local.username);
        expect(row.must_change_password).toBe(true);
        expect(await verifyPassword(row.password_hash, initialPassword)).toBe(true);
    });

    test.each(["short", "onlyletterspassword", "123456789012", "            ", `${"a".repeat(200)}1`])(
        "a supplied weak password is rejected rather than silently discarded: %s", async password => {
            const input = account({ password });
            const response = await creation(input);
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ error: "WEAK_PASSWORD" });
            const batch = await bulk([input]);
            expect(batch.status).toBe(207);
            expect(await batch.json()).toMatchObject({ created: 0, failures: [{ index: 0 }] });
            expect(await stored(input.username)).toBeUndefined();
        },
    );

    test("null password and blank employee number do not become passwordless credentials", async () => {
        for (const fields of [{ password: null }, { employeeNo: "" }, { employeeNo: "   " }]) {
            const input = account(fields);
            expect((await creation(input)).status).toBe(400);
            expect((await bulk([input])).status).toBe(400);
            expect(await stored(input.username)).toBeUndefined();
        }
    });

    test("bulk partial success and duplicate detection never clear an existing user's password", async () => {
        const existing = account({ password: initialPassword });
        expect((await creation(existing)).status).toBe(201);
        const before = await stored(existing.username);
        const added = account();
        const weak = account({ password: "weak" });
        const response = await bulk([{ ...existing, password: "", displayName: "Do not replace" }, added, weak]);
        expect(response.status).toBe(207);
        expect(await response.json()).toMatchObject({ created: 1, failures: [{ index: 0 }, { index: 2 }] });
        expect(await stored(existing.username)).toEqual(before);
        expect(await stored(added.username)).toMatchObject({ password_hash: null, must_change_password: false });
        expect(await stored(weak.username)).toBeUndefined();
    });

    test("a NULL-password account rejects local login but can use verified WeCom without changing stored credentials", async () => {
        const input = account();
        expect((await creation(input)).status).toBe(201);
        for (const password of [initialPassword, "any-other-password"]) {
            const denied = await post("/api/auth/login", { identifier: input.username, password, portal: "designer" }, "");
            expect(denied.status).toBe(401);
            expect(await denied.json()).toMatchObject({ error: "INVALID_CREDENTIALS" });
            expect(denied.headers.getSetCookie()).toHaveLength(0);
        }
        const before = await stored(input.username);
        expect((await db.query("SELECT id FROM sessions WHERE user_id=$1", [before.id])).rows).toHaveLength(0);
        const originalFetch = globalThis.fetch;
        const upstream = spyOn(globalThis, "fetch").mockImplementation(((target: any, init?: any) => {
            const url = new URL(String(target));
            if (url.origin === "https://qyapi.weixin.qq.com") {
                return Promise.resolve(Response.json(url.pathname.endsWith("/gettoken")
                    ? { errcode: 0, access_token: "fixture-token" }
                    : { errcode: 0, userid: input.employeeNo }));
            }
            if (url.origin !== origin) throw new Error("External network forbidden in passwordless fixture");
            return originalFetch(target, init);
        }) as typeof fetch);
        try {
            const started = await fetch(`${origin}/api/auth/wecom/start?portal=designer`);
            expect(started.status).toBe(200);
            const { authorizationUrl } = await started.json();
            const state = new URL(authorizationUrl).searchParams.get("state")!;
            const stateCookie = started.headers.getSetCookie().find(value => value.startsWith(`${config.SESSION_COOKIE_NAME}_wecom_state=`))!.split(";", 1)[0]!;
            const response = await fetch(`${origin}/api/auth/wecom/callback?code=fixture-code&state=${state}`, {
                redirect: "manual", headers: { cookie: stateCookie },
            });
            expect(response.status).toBe(302);
            expect(response.headers.get("location")).toBe("/");
            const cookie = response.headers.getSetCookie().find(value => value.startsWith(`${config.SESSION_COOKIE_NAME}=`))!.split(";", 1)[0]!;
            expect((await fetch(`${origin}/creation`, { headers: { cookie } })).status).toBe(200);
            expect((await fetch(`${origin}/accounts/enabled`, { headers: { cookie } })).status).toBe(403);
            expect(await stored(input.username)).toEqual(before);
            expect((await db.query("SELECT auth_provider FROM sessions WHERE user_id=$1", [before.id])).rows).toEqual([{ auth_provider: "wecom" }]);
        } finally { upstream.mockRestore(); }
    });
});
