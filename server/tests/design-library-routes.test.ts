import { expect, test } from "bun:test";
import cookieParser from "cookie-parser";
import express from "express";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "../src/config";
import type { Cache, Database } from "../src/db";
import { createDesignLibraryRouter, designLibraryBodyErrors, designLibraryBoundary } from "../src/routes/design-library";
import { requireAccountReady, sessionMiddleware } from "../src/session";
import { requireSameOrigin } from "../src/http-security";
import { hashToken } from "../src/security";
import type { DesignLibraryActor, DesignLibraryEntry } from "../src/design-library";
import { administrator, employee, libraryFixture, png, publishInput, uuid } from "./design-library-fixtures";

function httpFixture(enabled = true) {
    const h = libraryFixture();
    const author = h.actor(employee(1)); const viewer = h.actor(employee(2)); const admin = h.actor(administrator(3));
    h.source(uuid(10), author);
    const sessions = new Map<string, Record<string, unknown>>();
    const addSession = (token: string, actor: DesignLibraryActor, authProvider: "local" | "oa", guest = false) => {
        const row = { id: actor.id, username: actor.id, display_name: actor.name, role: actor.role, status: "active", department_id: actor.departmentId, department_name: actor.departmentName,
            session_id: uuid(200 + sessions.size), auth_provider: authProvider, is_guest: guest, must_change_password: false, group_id: null, group_name: null, group_role: null };
        sessions.set(hashToken(token), row);
    };
    addSession("author-oa", author, "oa"); addSession("viewer-oa", viewer, "oa"); addSession("admin-local", admin, "local");
    addSession("designer-local", viewer, "local"); addSession("guest-oa", viewer, "oa", true); addSession("admin-oa", admin, "oa");
    let authQueries = 0;
    const authDb = { query: async (sql: string, values: unknown[]) => {
        authQueries++;
        if (sql.includes("FROM credit_policy")) return { rows: [{ creditsEnabled: false, updatedAt: null }] };
        if (!sql.includes("FROM sessions s")) throw new Error("Authentication must never create a guest or write the database");
        const row = sql.includes("s.token_hash=$1") ? sessions.get(String(values[0])) : [...sessions.values()].find(value => value.session_id === values[0]);
        return { rows: row ? [row] : [] };
    } } as unknown as Database;
    const cache = { get: async () => null, set: async () => "OK", del: async () => 1 } as unknown as Cache;
    const config = { OA_LOGIN_ENABLED: enabled ? "true" : "false", SESSION_COOKIE_NAME: "session", SESSION_TTL_SECONDS: 28800, NODE_ENV: "test" } as AppConfig;
    const app = express();
    app.use(["/api/design-library", "/api/admin/design-library"], designLibraryBoundary(enabled), express.json({ limit: "128kb" }), designLibraryBodyErrors);
    app.use(cookieParser(), requireSameOrigin);
    app.use("/api/design-library", sessionMiddleware(authDb, cache, config), requireAccountReady, createDesignLibraryRouter(h.service));
    app.use("/api/admin/design-library", sessionMiddleware(authDb, cache, config, { allowGuest: false }), requireAccountReady, createDesignLibraryRouter(h.service, { admin: true }));
    app.use((_request, response) => response.status(404).json({ error: "NOT_FOUND", message: "接口不存在" }));
    return { ...h, app, author, viewer, admin, authQueries: () => authQueries };
}

async function serve(app: express.Express, run: (origin: string) => Promise<void>) {
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test("formal OA-off library boundary rejects before session creation, including spoofed actor headers", async () => {
    const h = httpFixture(false);
    try {
        await serve(h.app, async origin => {
            for (const path of ["/api/design-library", "/api/admin/design-library"]) {
                const response = await fetch(origin + path, { headers: { "x-test-actor": h.author.id, "X-Canvas-Owner-Id": h.author.id } });
                expect(response.status).toBe(403);
                expect(await response.json()).toMatchObject({ code: 403, error: "OA_REQUIRED" });
                expect(response.headers.get("set-cookie")).toBeNull();
                expect(response.headers.get("cache-control")).toBe("private, no-store");
            }
        });
        expect(h.authQueries()).toBe(0);
        expect(h.writes).toEqual([]);
    } finally { h.close(); }
});

test("formal routes use actual OA session middleware, strict administrator roles and owner-bound mutations", async () => {
    const h = httpFixture();
    try {
        await serve(h.app, async origin => {
            for (const token of ["", "designer-local", "admin-local", "guest-oa", "admin-oa"]) {
                const response = await fetch(`${origin}/api/design-library`, { headers: token ? { cookie: `session=${token}` } : {} });
                expect(response.status).toBe(401);
                expect(await response.json()).toMatchObject({ code: 401 });
            }
            for (const token of ["author-oa", "designer-local"]) {
                const response = await fetch(`${origin}/api/admin/design-library`, { headers: { cookie: `session=${token}` } });
                expect(response.status).toBe(403);
            }
            const headers = { cookie: "session=author-oa", "content-type": "application/json" };
            for (const extra of [{}, { "X-Canvas-Owner-Id": h.viewer.id }] as Record<string, string>[]) {
                expect((await fetch(`${origin}/api/design-library`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(publishInput([uuid(10)])) })).status).toBe(403);
            }
            const crossSite = await fetch(`${origin}/api/design-library`, { method: "POST", headers: { ...headers, "X-Canvas-Owner-Id": h.author.id, origin: "https://untrusted.test" }, body: JSON.stringify(publishInput([uuid(10)])) });
            expect(crossSite.status).toBe(403); expect(await crossSite.json()).toMatchObject({ code: 403, error: "INVALID_ORIGIN" });
            expect(h.writes).toHaveLength(0);
            expect((await fetch(`${origin}/api/design-library`, { headers })).status).toBe(200);
            const success = await fetch(`${origin}/api/design-library`, { method: "POST", headers: { ...headers, "X-Canvas-Owner-Id": h.author.id }, body: JSON.stringify(publishInput([uuid(10)])) });
            expect(success.status).toBe(200);
            expect(await success.json()).toMatchObject({ code: 0, data: { entry: { author: { id: h.author.id, name: h.author.name }, images: [{ mimeType: "image/png" }] } }, msg: "" });
        });
    } finally { h.close(); }
});

test("formal HTTP serves independent original bytes and admin-prefixed previews after withdrawal and takedown", async () => {
    const h = httpFixture();
    try {
        await serve(h.app, async origin => {
            const request = (path: string, token: string, body?: unknown, ownerId?: string) => fetch(origin + path, {
                method: body === undefined ? "GET" : "POST", headers: { cookie: `session=${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(ownerId ? { "X-Canvas-Owner-Id": ownerId } : {}) },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const entry = (await (await request("/api/design-library", "author-oa", publishInput([uuid(10)]), h.author.id)).json() as { data: { entry: DesignLibraryEntry } }).data.entry;
            const base = `/api/design-library/${entry.id}`;
            const image = entry.images[0]!;
            expect((await request(`${base}/stats`, "viewer-oa")).status).toBe(403);
            const preview = await request(image.contentUrl, "viewer-oa");
            expect(preview.status).toBe(200); expect(preview.headers.get("x-content-type-options")).toBe("nosniff");
            expect(preview.headers.get("cache-control")).toBe("private, no-cache, must-revalidate"); expect(await preview.bytes()).toEqual(png);
            const downloadPath = `${base}/images/${image.id}/download`;
            expect((await request(downloadPath, "viewer-oa", { requestId: "download-http" })).status).toBe(403);
            const download = await request(downloadPath, "viewer-oa", { requestId: "download-http" }, h.viewer.id);
            expect(download.status).toBe(200); expect(download.headers.get("content-disposition")).toStartWith("attachment;");
            expect(await download.bytes()).toEqual(png);
            expect((await (await request(`${base}/stats`, "author-oa")).json() as any).data.totals.download).toEqual({ count: 0, people: 0 });
            expect(await (await request(`${base}/events`, "viewer-oa", { action: "download", imageId: image.id, requestId: "download-http" }, h.viewer.id)).json()).toEqual({ code: 0, data: { recorded: true }, msg: "" });
            expect((await request(`${base}/withdraw`, "author-oa", {}, h.author.id)).status).toBe(200);
            expect((await request(image.contentUrl, "viewer-oa")).status).toBe(404);
            expect(await (await request(image.contentUrl, "author-oa")).bytes()).toEqual(png);
            const adminBase = `/api/admin/design-library/${entry.id}`;
            const managed = (await (await request(adminBase, "admin-local")).json() as { data: { entry: DesignLibraryEntry } }).data.entry;
            expect(managed.images[0]?.contentUrl).toBe(`${adminBase}/images/${image.id}/content`);
            expect(await (await request(managed.images[0]!.contentUrl, "admin-local")).bytes()).toEqual(png);
            expect((await request(`${adminBase}/moderate`, "admin-local", { reason: "请勿公开此客户资料" }, h.admin.id)).status).toBe(200);
            expect(await (await request(managed.images[0]!.contentUrl, "admin-local")).bytes()).toEqual(png);
            expect(await (await request(image.contentUrl, "author-oa")).bytes()).toEqual(png);
            expect((await request(downloadPath, "viewer-oa", { requestId: "another-download" }, h.viewer.id)).status).toBe(409);
            const stats = (await (await request(`${adminBase}/stats`, "admin-local")).json() as any).data;
            expect(stats.totals.download).toEqual({ count: 1, people: 1 });
            expect(stats.activity[0]?.actor).toEqual({ id: h.viewer.id, name: h.viewer.name, departmentName: h.viewer.departmentName });
        });
    } finally { h.close(); }
});

test("formal JSON errors and payload limits retain the new response envelope", async () => {
    const h = httpFixture();
    try {
        await serve(h.app, async origin => {
            const headers = { cookie: "session=author-oa", "X-Canvas-Owner-Id": h.author.id, "content-type": "application/json" };
            for (const [body, status] of [["{", 400], [JSON.stringify({ thought: "x".repeat(140000) }), 413]] as const) {
                const response = await fetch(`${origin}/api/design-library`, { method: "POST", headers, body });
                expect(response.status).toBe(status);
                expect(await response.json()).toMatchObject({ code: status });
                expect(response.headers.get("cache-control")).toBe("private, no-store");
            }
            expect(h.writes).toHaveLength(0);
        });
    } finally { h.close(); }
});
