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
import { hashPassword } from "../../src/security";

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

    test("employee number maps to the same personal account without changing its password or onboarding", async () => {
        const user = await actor({ mustChangePassword: true });
        const login = await start();
        const response = await callback(user.employeeNo, login);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/change-password");
        expect(await counts(user.id)).toEqual({ sessions: 1, identities: 1 });
        expect((await db.query("SELECT password_hash,must_change_password FROM users WHERE id=$1", [user.id])).rows[0])
            .toEqual({ password_hash: user.passwordHash, must_change_password: true });
        expect((await db.query("SELECT user_id,subject FROM external_identities WHERE provider='wecom' AND user_id=$1", [user.id])).rows[0])
            .toEqual({ user_id: user.id, subject: user.employeeNo });
        expect((await db.query("SELECT auth_provider FROM sessions WHERE user_id=$1", [user.id])).rows[0].auth_provider).toBe("local");
        expect((await callback(user.employeeNo, login)).status).toBe(400);
        expect(await counts(user.id)).toEqual({ sessions: 1, identities: 1 });
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
});
