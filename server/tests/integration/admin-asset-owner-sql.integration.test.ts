import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { createAdminAssetsRouter } from "../../src/routes/assets";
import type { AuthenticatedRequest, SessionUser } from "../../src/types";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;

async function fixture() {
    const postgres = await createIsolatedPostgres();
    const department = randomUUID(), otherDepartment = randomUUID();
    const recent = randomUUID(), older = randomUUID(), foreign = randomUUID();
    const deletedOnly = randomUUID(), variantOnly = randomUUID(), empty = randomUUID();
    await postgres.db.query("INSERT INTO departments(id,name,code) VALUES($1,'Owner department','asset-owner-a'),($2,'Other department','asset-owner-b')", [department, otherDepartment]);
    await postgres.db.query(`INSERT INTO users(id,username,display_name,department_id) VALUES
        ($1,'owner-recent','A Recent',$7),($2,'owner-older','B Older',$7),($3,'owner-foreign','C Foreign',$8),
        ($4,'owner-deleted-assets','D Deleted only',$7),($5,'owner-variant-assets','E Variant only',$7),($6,'owner-no-assets','F No assets',$7)`,
        [recent, older, foreign, deletedOnly, variantOnly, empty, department, otherDepartment]);
    for (const [owner, count, createdAt] of [[recent, 60, "2026-10-19T12:00:00Z"], [older, 65, "2026-10-18T12:00:00.000001Z"], [foreign, 1, "2026-10-17T12:00:00Z"]] as const) {
        await postgres.db.query(`INSERT INTO assets(owner_user_id,department_id,object_key,filename,mime_type,byte_size,status,kind,created_at,metadata)
            SELECT $1::uuid,$2::uuid,'owner-filter/'||$1::uuid::text||'/'||n,'owner-'||n||'.png','image/png',100,'ready','image',$3::timestamptz,
                '{"imageName":"款式","imageVersion":7,"note":"detail only","content":"full content"}'::jsonb
            FROM generate_series(1,$4::int) n`, [owner, owner === foreign ? otherDepartment : department, createdAt, count]);
    }
    await postgres.db.query(`INSERT INTO assets(owner_user_id,department_id,object_key,filename,mime_type,byte_size,status,deleted_at,metadata)
        VALUES($1,$3,'owner-filter/deleted','deleted.png','image/png',100,'ready',now(),'{}'),
              ($2,$3,'owner-filter/variant','original.png','image/png',100,'ready',NULL,'{"imageResult":{"version":1,"role":"provider-original"}}')`,
        [deletedOnly, variantOnly, department]);
    const app = express();
    app.use((request, _response, next) => {
        (request as AuthenticatedRequest).auth = { id: recent, role: request.get("test-role") || "super_admin",
            departmentId: request.get("test-department") === "none" ? null : request.get("test-department") || department } as SessionUser;
        next();
    });
    app.use("/api/admin/assets", createAdminAssetsRouter(postgres.db));
    app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
        response.status(error.name === "ZodError" ? 400 : 500).json({ message: error.message });
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/assets`;
    return { ...postgres, url, recent, older, foreign, department, otherDepartment, close: async () => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await postgres.close();
    } };
}

sqlTest("admin asset owner options include designers beyond the first page and owner filtering paginates all their assets", async () => {
    const state = await fixture();
    try {
        const first = await (await fetch(state.url)).json();
        expect(first.assets).toHaveLength(60);
        expect(first.assets.every((asset: { ownerUserId: string }) => asset.ownerUserId === state.recent)).toBe(true);
        const optionsResponse = await fetch(`${state.url}/owners`);
        expect(optionsResponse.status).toBe(200);
        expect(optionsResponse.headers.get("cache-control")).toBe("private, no-store");
        expect(await optionsResponse.json()).toEqual({ owners: [
            { value: state.recent, label: "A Recent" }, { value: state.older, label: "B Older" }, { value: state.foreign, label: "C Foreign" },
        ] });

        const page1 = await (await fetch(`${state.url}?ownerUserId=${state.older}`)).json();
        expect(page1.assets).toHaveLength(60);
        expect(page1.assets.every((asset: { ownerUserId: string }) => asset.ownerUserId === state.older)).toBe(true);
        expect(page1.hasMore).toBe(true);
        expect(page1.assets[0].metadata).toEqual({ imageName: "款式", imageVersion: 7 });
        expect(page1.assets[0].prompt).toBeNull();
        const page2 = await (await fetch(`${state.url}?ownerUserId=${state.older}&cursor=${encodeURIComponent(page1.nextCursor)}`)).json();
        expect(page2.assets).toHaveLength(5);
        expect(page2.assets.every((asset: { ownerUserId: string }) => asset.ownerUserId === state.older)).toBe(true);
        expect(page2.hasMore).toBe(false);
        expect(page2.nextCursor).toBeNull();
        expect(new Set([...page1.assets, ...page2.assets].map((asset: { id: string }) => asset.id)).size).toBe(65);
        expect((await fetch(`${state.url}?ownerUserId=not-a-uuid`)).status).toBe(400);
    } finally { await state.close(); }
}, 60_000);

sqlTest("admin asset owners and owner filters remain department-scoped and ordinary users cannot query either endpoint", async () => {
    const state = await fixture();
    try {
        const headers = { "test-role": "department_admin" };
        const options = await fetch(`${state.url}/owners`, { headers });
        expect(options.status).toBe(200);
        expect(await options.json()).toEqual({ owners: [
            { value: state.recent, label: "A Recent" }, { value: state.older, label: "B Older" },
        ] });
        const allowed = await fetch(`${state.url}?ownerUserId=${state.older}`, { headers });
        expect(allowed.status).toBe(200);
        expect((await allowed.json()).assets).toHaveLength(60);
        const forbidden = await fetch(`${state.url}?ownerUserId=${state.foreign}`, { headers });
        expect(forbidden.status).toBe(403);
        expect((await forbidden.json()).error).toBe("FORBIDDEN");
        expect(await (await fetch(`${state.url}/owners`, { headers: { ...headers, "test-department": "none" } })).json()).toEqual({ owners: [] });
        expect((await fetch(`${state.url}?ownerUserId=${state.older}`, { headers: { ...headers, "test-department": "none" } })).status).toBe(403);
        state.statements.length = 0;
        expect((await fetch(`${state.url}/owners`, { headers: { "test-role": "designer" } })).status).toBe(403);
        expect((await fetch(`${state.url}?ownerUserId=${state.older}`, { headers: { "test-role": "designer" } })).status).toBe(403);
        expect(state.statements).toHaveLength(0);
    } finally { await state.close(); }
}, 60_000);
