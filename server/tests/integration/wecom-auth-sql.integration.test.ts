import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler } from "express";
import type { AppConfig } from "../../src/config";
import type { Cache, Database } from "../../src/db";
import { createAuthRouter } from "../../src/routes/auth";
import { createSessionToken, hashPassword, hashToken } from "../../src/security";
import { requireAccountReady, sessionMiddleware } from "../../src/session";

const runtime = process.env.PGLITE_RUNTIME_PATH;
const integration = runtime ? describe : describe.skip;
const config = {
    AUTH_ENABLED: "true", OA_LOGIN_ENABLED: "false", CREDITS_ENABLED: "false", NODE_ENV: "test",
    SESSION_COOKIE_NAME: "wecom_sql_fixture", SESSION_TTL_SECONDS: 28800,
    WECOM_CORP_ID: "ww-fixture", WECOM_AGENT_ID: "1000002", WECOM_SECRET: "fixture-secret",
    WECOM_CALLBACK_URL: "https://fixture.invalid/api/auth/wecom/callback",
} as AppConfig;

// Real routes and SQL on disposable local storage. No production credentials,
// DATABASE_URL, shared accounts, or real WeCom requests are used.
integration("WeCom callback in isolated PostgreSQL", () => {
    let database: any;
    let db: Database;
    let server: ReturnType<ReturnType<typeof express>["listen"]>;
    let origin: string;
    let restoreFetch: (() => void) | undefined;
    let afterIdentityRead: (() => Promise<void>) | undefined;
    const values = new Map<string, string>();
    const cache = {
        get: async (key: string) => values.get(key) ?? null,
        set: async (key: string, value: string) => { values.set(key, value); return "OK"; },
        del: async (key: string) => Number(values.delete(key)),
        incr: async () => 1, expire: async () => 1,
    } as unknown as Cache;

    beforeAll(async () => {
        const requireRuntime = createRequire(resolve(runtime!, "package.json"));
        const { PGlite } = requireRuntime("@electric-sql/pglite");
        const { pgcrypto } = requireRuntime("@electric-sql/pglite/contrib/pgcrypto");
        const { citext } = requireRuntime("@electric-sql/pglite/contrib/citext");
        database = new PGlite({ extensions: { pgcrypto, citext } });
        await database.waitReady;
        const migrations = fileURLToPath(new URL("../../src/migrations/", import.meta.url));
        for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
            await database.exec(await readFile(resolve(migrations, name), "utf8"));
        }
        await database.exec("ALTER TYPE user_status ADD VALUE IF NOT EXISTS 'deleted'");
        const query = async (sql: string, parameters: unknown[] = []) => {
            const result = await database.query(sql, parameters);
            if (afterIdentityRead && sql.includes("LEFT JOIN external_identities")) {
                const pause = afterIdentityRead; afterIdentityRead = undefined; await pause();
            }
            return { ...result, rowCount: result.affectedRows ?? result.rows.length };
        };
        db = { query, connect: async () => ({ query, release() {} }) } as unknown as Database;
        const app = express().use(express.json()).use(cookieParser());
        app.use("/api/auth", createAuthRouter(db, cache, config));
        app.get("/creation", sessionMiddleware(db, cache, config), requireAccountReady, (_request, response) => response.json({ ready: true }));
        app.get("/oa-creation", sessionMiddleware(db, cache, { ...config, OA_LOGIN_ENABLED: "true" }), requireAccountReady, (_request, response) => response.json({ ready: true }));
        app.use(((error, _request, response, _next) => response.status(500).json({ error: error.name, message: error.message })) as ErrorRequestHandler);
        server = app.listen(0, "127.0.0.1");
        await new Promise<void>(done => server.once("listening", done));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const originalFetch = globalThis.fetch;
        const upstream = spyOn(globalThis, "fetch").mockImplementation(((input: any, init?: any) => {
            const url = new URL(String(input));
            if (url.origin === "https://qyapi.weixin.qq.com") {
                return Promise.resolve(Response.json(url.pathname.endsWith("/gettoken")
                    ? { errcode: 0, access_token: "fixture-token" }
                    : { errcode: 0, userid: url.searchParams.get("code") }));
            }
            return originalFetch(input, init);
        }) as typeof fetch);
        restoreFetch = () => upstream.mockRestore();
    }, 30000);

    afterAll(async () => {
        restoreFetch?.();
        if (server) await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
        await database?.close();
    });

    async function actor(options: { role?: string; status?: string; isGuest?: boolean; mustChangePassword?: boolean; employeeNo?: string } = {}) {
        const id = randomUUID();
        const employeeNo = options.employeeNo ?? `employee-${id}`;
        const passwordHash = options.isGuest ? null : await hashPassword("WecomFixture2026");
        await db.query(`INSERT INTO users(id,username,display_name,employee_no,password_hash,role,status,is_guest,must_change_password)
            VALUES($1,$2::text,$2::text,$3,$4,$5,$6,$7,$8)`,
            [id, `wecom-${id}`, employeeNo, passwordHash, options.role ?? "designer", options.status ?? "active", options.isGuest ?? false, options.mustChangePassword ?? false]);
        return { id, employeeNo, passwordHash };
    }

    async function start() {
        const response = await fetch(`${origin}/api/auth/wecom/start?portal=designer`);
        expect(response.status).toBe(200);
        const { authorizationUrl } = await response.json();
        const state = new URL(authorizationUrl).searchParams.get("state")!;
        const cookie = response.headers.getSetCookie().find(value => value.startsWith(`${config.SESSION_COOKIE_NAME}_wecom_state=`))!.split(";", 1)[0]!;
        return { state, cookie };
    }

    async function callback(subject: string, login?: Awaited<ReturnType<typeof start>>) {
        login ??= await start();
        return fetch(`${origin}/api/auth/wecom/callback?code=${encodeURIComponent(subject)}&state=${login.state}`, {
            redirect: "manual", headers: { cookie: login.cookie },
        });
    }

    async function counts(id: string) {
        return (await db.query("SELECT (SELECT count(*)::int FROM sessions WHERE user_id=$1) AS sessions, (SELECT count(*)::int FROM external_identities WHERE user_id=$1) AS identities", [id])).rows[0];
    }

    test("employee number maps to the same account while WeCom alone bypasses the unchanged local password requirement", async () => {
        const user = await actor({ mustChangePassword: true });
        const login = await start();
        const response = await callback(user.employeeNo, login);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/");
        expect(await counts(user.id)).toEqual({ sessions: 1, identities: 1 });
        expect((await db.query("SELECT password_hash,must_change_password FROM users WHERE id=$1", [user.id])).rows[0])
            .toEqual({ password_hash: user.passwordHash, must_change_password: true });
        expect((await db.query("SELECT user_id,subject FROM external_identities WHERE provider='wecom' AND user_id=$1", [user.id])).rows[0])
            .toEqual({ user_id: user.id, subject: user.employeeNo });
        expect((await db.query("SELECT auth_provider FROM sessions WHERE user_id=$1", [user.id])).rows[0].auth_provider).toBe("wecom");
        const cookie = response.headers.getSetCookie().find(value => value.startsWith(`${config.SESSION_COOKIE_NAME}=`))!.split(";", 1)[0]!;
        const headers = { cookie };
        expect(await fetch(`${origin}/api/auth/session`, { headers }).then(result => result.json()))
            .toMatchObject({ user: { id: user.id, mustChangePassword: false } });
        expect((await fetch(`${origin}/creation`, { headers })).status).toBe(200);
        expect((await fetch(`${origin}/oa-creation`, { headers })).status).toBe(401);
        expect((await callback(user.employeeNo, login)).status).toBe(400);
        expect(await counts(user.id)).toEqual({ sessions: 1, identities: 1 });
        const local = await fetch(`${origin}/api/auth/login`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ identifier: user.employeeNo, password: "WecomFixture2026", portal: "designer" }),
        });
        expect(local.status).toBe(200);
        expect(await local.json()).toMatchObject({ user: { id: user.id, mustChangePassword: true } });
        const localCookie = local.headers.getSetCookie().find(value => value.startsWith(`${config.SESSION_COOKIE_NAME}=`))!.split(";", 1)[0]!;
        const protectedLocal = await fetch(`${origin}/creation`, { headers: { cookie: localCookie } });
        expect(protectedLocal.status).toBe(403);
        expect(await protectedLocal.json()).toMatchObject({ error: "PASSWORD_CHANGE_REQUIRED" });
        expect((await db.query("SELECT password_hash,must_change_password FROM users WHERE id=$1", [user.id])).rows[0])
            .toEqual({ password_hash: user.passwordHash, must_change_password: true });
        expect((await db.query("SELECT auth_provider FROM sessions WHERE user_id=$1 ORDER BY auth_provider", [user.id])).rows.map(row => row.auth_provider))
            .toEqual(["local", "wecom"]);
    });

    test("old local sessions are not reclassified from the existence of a WeCom identity", async () => {
        const user = await actor({ mustChangePassword: true });
        await db.query("INSERT INTO external_identities(user_id,provider,subject) VALUES($1,'wecom',$2)", [user.id, user.employeeNo]);
        const session = createSessionToken();
        await db.query("INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
            [session.id, user.id, hashToken(session.token)]);
        const headers = { cookie: `${config.SESSION_COOKIE_NAME}=${session.token}` };
        expect(await fetch(`${origin}/api/auth/session`, { headers }).then(result => result.json()))
            .toMatchObject({ user: { id: user.id, mustChangePassword: true } });
        expect((await fetch(`${origin}/creation`, { headers })).status).toBe(403);
        expect((await db.query("SELECT auth_provider FROM sessions WHERE id=$1", [session.id])).rows[0].auth_provider).toBe("local");
    });

    test("a WeCom session becomes invalid after elevation, disablement, deletion, expiry or revocation", async () => {
        for (const change of [
            "UPDATE users SET role='super_admin' WHERE id=$1",
            "UPDATE users SET role='department_admin' WHERE id=$1",
            "UPDATE users SET status='disabled' WHERE id=$1",
            "UPDATE users SET deleted_at=now() WHERE id=$1",
            "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
            "UPDATE sessions SET revoked_at=now() WHERE user_id=$1",
        ]) {
            const user = await actor({ mustChangePassword: true });
            const response = await callback(user.employeeNo);
            expect(response.status).toBe(302);
            const cookie = response.headers.getSetCookie().find(value => value.startsWith(`${config.SESSION_COOKIE_NAME}=`))!.split(";", 1)[0]!;
            const headers = { cookie };
            expect((await fetch(`${origin}/creation`, { headers })).status).toBe(200);
            if (change.includes("department_admin")) {
                const departmentId = randomUUID();
                await db.query("INSERT INTO departments(id,name,code) VALUES($1,$2::text,$2::text)", [departmentId, `department-${departmentId}`]);
                await db.query("UPDATE users SET department_id=$1 WHERE id=$2", [departmentId, user.id]);
            }
            await db.query(change, [user.id]);
            const denied = await fetch(`${origin}/creation`, { headers });
            expect(denied.status).toBe(401);
            expect(await denied.json()).toMatchObject({ error: "SESSION_EXPIRED" });
            expect(denied.headers.getSetCookie().some(value => value.startsWith(`${config.SESSION_COOKIE_NAME}=;`))).toBe(true);
        }
    });

    test("an existing external identity remains bound to its own personal account", async () => {
        const user = await actor();
        const subject = `wecom-subject-${randomUUID()}`;
        await db.query("INSERT INTO external_identities(user_id,provider,subject) VALUES($1,'wecom',$2)", [user.id, subject]);
        const response = await callback(subject);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/");
        expect(await counts(user.id)).toEqual({ sessions: 1, identities: 1 });
    });

    test("ineligible accounts cannot receive a binding or session", async () => {
        for (const options of [{ status: "disabled" }, { status: "deleted" }, { isGuest: true }, { role: "super_admin" }]) {
            const user = await actor(options);
            expect((await callback(user.employeeNo)).status).toBe(403);
            expect(await counts(user.id)).toEqual({ sessions: 0, identities: 0 });
            expect((await db.query("SELECT password_hash FROM users WHERE id=$1", [user.id])).rows[0].password_hash).toBe(user.passwordHash);
        }
    });

    test("a disable or delete after identity lookup cancels the login before binding", async () => {
        for (const status of ["disabled", "deleted"]) {
            const user = await actor();
            afterIdentityRead = async () => { await db.query("UPDATE users SET status=$1 WHERE id=$2", [status, user.id]); };
            expect((await callback(user.employeeNo)).status).toBe(403);
            expect(await counts(user.id)).toEqual({ sessions: 0, identities: 0 });
        }
    });

    test("active tombstones are rejected both before and after WeCom identity lookup", async () => {
        for (const deleteDuringLogin of [false, true]) {
            const user = await actor();
            const remove = async () => { await db.query("UPDATE users SET deleted_at=now() WHERE id=$1", [user.id]); };
            if (deleteDuringLogin) afterIdentityRead = remove;
            else await remove();
            expect((await callback(user.employeeNo)).status).toBe(403);
            expect(await counts(user.id)).toEqual({ sessions: 0, identities: 0 });
        }
    });

    test("037 independently extends the 031 schema while preserving old local sessions and rejecting unknown providers", async () => {
        const requireRuntime = createRequire(resolve(runtime!, "package.json"));
        const { PGlite } = requireRuntime("@electric-sql/pglite");
        const { pgcrypto } = requireRuntime("@electric-sql/pglite/contrib/pgcrypto");
        const { citext } = requireRuntime("@electric-sql/pglite/contrib/citext");
        const baseline = new PGlite({ extensions: { pgcrypto, citext } });
        try {
            await baseline.waitReady;
            const migrations = fileURLToPath(new URL("../../src/migrations/", import.meta.url));
            for (const name of (await readdir(migrations)).filter(name => /^\d{3}.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 31).sort()) {
                await baseline.exec(await readFile(resolve(migrations, name), "utf8"));
            }
            const userId = randomUUID();
            const oldSessionId = randomUUID();
            await baseline.query("INSERT INTO users(id,username,display_name,password_hash,must_change_password) VALUES($1,'old-designer','Old Designer','unchanged-password-hash',true)", [userId]);
            await baseline.query("INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,'old-token-hash',now()+interval '1 hour')", [oldSessionId, userId]);
            await baseline.exec(await readFile(resolve(migrations, "037_wecom_session_provider.sql"), "utf8"));
            expect((await baseline.query("SELECT auth_provider FROM sessions WHERE id=$1", [oldSessionId])).rows[0]).toEqual({ auth_provider: "local" });
            expect((await baseline.query("SELECT password_hash,must_change_password FROM users WHERE id=$1", [userId])).rows[0])
                .toEqual({ password_hash: "unchanged-password-hash", must_change_password: true });
            for (const provider of ["local", "oa", "wecom"]) {
                await baseline.query("INSERT INTO sessions(id,user_id,token_hash,expires_at,auth_provider) VALUES($1,$2,$3,now()+interval '1 hour',$4)",
                    [randomUUID(), userId, `${provider}-token-hash`, provider]);
            }
            await expect(baseline.query("INSERT INTO sessions(id,user_id,token_hash,expires_at,auth_provider) VALUES($1,$2,'forged-token-hash',now()+interval '1 hour','forged')",
                [randomUUID(), userId])).rejects.toMatchObject({ code: "23514" });
            expect((await baseline.query("SELECT count(*)::int AS count FROM sessions")).rows[0].count).toBe(4);
        } finally { await baseline.close(); }
    }, 30000);
});
