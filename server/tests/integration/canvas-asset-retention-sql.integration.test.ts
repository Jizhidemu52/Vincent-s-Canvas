import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type ErrorRequestHandler } from "express";
import type { ObjectStorage } from "../../src/object-storage";
import { createAssetsRouter } from "../../src/routes/assets";
import { createCanvasDocumentsRouter } from "../../src/routes/canvas-documents";
import type { AuthenticatedRequest, SessionUser } from "../../src/types";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const image = (id: string) => ({
    id, type: "image", title: "原图", position: { x: 0, y: 0 }, width: 400, height: 300,
    metadata: { content: `/api/assets/${id}/content` },
});
const documentFor = (id: string, assets: string[] = []) => ({
    id, title: "设计稿", createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z",
    nodes: assets.map(image), connections: [], chatSessions: [], activeChatId: null,
    backgroundMode: "dots", showImageInfo: true, viewport: { x: 0, y: 0, k: 1 },
});

async function withFixture(run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
    const fixture = await createFixture();
    try { await run(fixture); } finally { await fixture.close(); }
}

async function createFixture() {
    const postgres = await createIsolatedPostgres();
    const owner = randomUUID(), other = randomUUID();
    const assets = { deleted: randomUUID(), revoked: randomUUID(), purged: randomUUID(), failed: randomUUID(), history: randomUUID(), ready: randomUUID(), private: randomUUID() };
    let server: ReturnType<express.Express["listen"]> | undefined;
    let storageReads = 0;
    try {
        await postgres.db.query("INSERT INTO users(id,username,display_name) VALUES($1,'retained-owner','Owner'),($2,'retained-other','Other')", [owner, other]);
        for (const [name, id] of Object.entries(assets)) {
            await postgres.db.query(`INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,status,visibility_scope)
                VALUES($1,$2,$3,'original.png','image/png',512,'ready',$4)`,
            [id, name === "revoked" || name === "private" ? other : owner, `retained/${name}.png`, name === "revoked" ? "company" : "private"]);
        }
        const app = express().use(express.json({ limit: "20mb" }));
        app.use((request, _response, next) => {
            (request as AuthenticatedRequest).auth = {
                id: request.get("test-actor") || owner, role: "designer", departmentId: null, groupRole: null, groupId: null,
            } as SessionUser;
            next();
        });
        app.use("/api/canvas-documents", createCanvasDocumentsRouter(postgres.db));
        app.use("/api/assets", createAssetsRouter(postgres.db, {
            configured: true,
            head: async () => { storageReads++; throw new Error("Unavailable assets must not reach storage"); },
            get: async () => { storageReads++; throw new Error("Unavailable assets must not reach storage"); },
        } as unknown as ObjectStorage));
        app.use(((error, _request, response, _next) => response.status(500).json({ message: String(error) })) as ErrorRequestHandler);
        server = app.listen(0, "127.0.0.1");
        await new Promise<void>(resolve => server!.once("listening", resolve));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const api = async (method: string, id: string, body?: unknown, employee = owner) => {
            const response = await fetch(`${origin}/api/canvas-documents/${encodeURIComponent(id)}`, {
                method, headers: { "content-type": "application/json", "X-Canvas-Owner-Id": employee, "test-actor": employee },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: response.status, body: await response.json() };
        };
        return {
            ...postgres, owner, other, assets, origin, api, storageReads: () => storageReads,
            put: (id: string, baseRevision: number, document: unknown, employee = owner) => api("PUT", id, { baseRevision, document }, employee),
            close: async () => {
                server!.closeAllConnections();
                await new Promise<void>(resolve => server!.close(() => resolve()));
                await postgres.close();
            },
        };
    } catch (error) {
        if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
        await postgres.close();
        throw error;
    }
}

sqlTest("existing canvas references survive deletion, revoked sharing and unavailable history without restoring media access", async () => {
    await withFixture(async ({ db, assets, owner, origin, put, api, storageReads }) => {
        const source = {
            ...documentFor("retained-media", [assets.deleted, assets.revoked, assets.purged, assets.failed]),
            history: { format: "canvas-history-delta-v1", past: [{ set: { nodes: [image(assets.history)] } }], future: [] },
        };
        expect((await put(source.id, 0, source)).status).toBe(200);
        await db.query("UPDATE assets SET deleted_at=now(),purge_after=now()+interval '30 days' WHERE id=ANY($1::uuid[])", [[assets.deleted, assets.history]]);
        await db.query("UPDATE assets SET visibility_scope='private' WHERE id=$1", [assets.revoked]);
        await db.query("UPDATE assets SET status='failed' WHERE id=$1", [assets.failed]);
        await db.query("DELETE FROM assets WHERE id=$1", [assets.purged]);
        const stateSql = "SELECT id,status,deleted_at::text,purge_after::text,visibility_scope,object_key FROM assets ORDER BY id";
        const before = (await db.query(stateSql)).rows;
        const changed = { ...source, title: "删除旧素材后继续编辑", nodes: [...source.nodes, image(assets.ready)] };
        const saved = await put(source.id, 1, changed);
        expect(saved.status).toBe(200);
        expect(saved.body.document).toMatchObject({ revision: 2, deleted: false });
        expect(saved.body.document).not.toHaveProperty("document");
        expect((await api("GET", source.id)).body.document.document).toEqual(changed);
        expect((await db.query(stateSql)).rows).toEqual(before);
        for (const asset of [assets.deleted, assets.revoked, assets.purged, assets.failed, assets.history]) {
            const response = await fetch(`${origin}/api/assets/${asset}/content`, { headers: { "test-actor": owner } });
            expect(response.status).toBe(404);
        }
        expect(storageReads()).toBe(0);
    });
}, 60_000);

sqlTest("retained IDs cannot authorize new assets or move unavailable references across canvases or employees", async () => {
    await withFixture(async ({ db, assets, other, put, api }) => {
        const source = documentFor("source", [assets.deleted]);
        expect((await put(source.id, 0, source)).status).toBe(200);
        expect((await put("target", 0, documentFor("target"))).status).toBe(200);
        expect((await put(source.id, 0, documentFor(source.id), other)).status).toBe(200);
        await db.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [assets.deleted]);

        const attempts = [
            put("new-copy", 0, documentFor("new-copy", [assets.deleted])),
            put("target", 1, documentFor("target", [assets.deleted])),
            put(source.id, 1, source, other),
            put(source.id, 1, { ...source, extra: { assetId: assets.private } }),
            put(source.id, 1, { ...source, history: { past: [{ set: { nodes: [image(assets.private)] } }], future: [] } }),
            put(source.id, 1, { ...source, extra: { assetId: randomUUID() } }),
        ];
        for (const attempt of attempts) {
            const denied = await attempt;
            expect(denied.status).toBe(403);
            expect(denied.body.error).toBe("CANVAS_ASSET_FORBIDDEN");
        }
        expect((await api("GET", source.id)).body.document).toMatchObject({ revision: 1, document: source });
        expect((await api("GET", "target")).body.document).toMatchObject({ revision: 1, document: documentFor("target") });
        expect((await api("GET", source.id, undefined, other)).body.document).toMatchObject({ revision: 1, document: documentFor(source.id) });
        expect((await put(source.id, 1, documentFor(source.id))).status).toBe(200);
        // Once removed from the current cloud document, an old ID is no longer retained.
        expect((await put(source.id, 2, source)).status).toBe(403);
        const stale = await put(source.id, 1, source);
        expect(stale.status).toBe(409);
        expect(stale.body.document).toMatchObject({ revision: 2, document: documentFor(source.id) });
    });
}, 60_000);

sqlTest("retained-reference saves keep atomic CAS conflicts and cannot resurrect a deleted canvas", async () => {
    await withFixture(async ({ db, assets, put, api }) => {
        const source = documentFor("concurrent", [assets.deleted]);
        expect((await put(source.id, 0, source)).status).toBe(200);
        await db.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [assets.deleted]);
        const versions = ["device-a", "device-b"].map(title => ({ ...source, title }));
        const concurrent = await Promise.all(versions.map(document => put(source.id, 1, document)));
        expect(concurrent.map(result => result.status).sort()).toEqual([200, 409]);
        const winner = concurrent.findIndex(result => result.status === 200);
        expect(concurrent.find(result => result.status === 409)!.body).toMatchObject({
            error: "CANVAS_REVISION_CONFLICT", document: { revision: 2, document: versions[winner] },
        });
        expect((await api("GET", source.id)).body.document.document).toEqual(versions[winner]);
        const deleted = await put(source.id, 2, null);
        expect(deleted.status).toBe(200);
        expect(deleted.body.document).toMatchObject({ revision: 3, deleted: true });
        for (const revision of [0, 1, 2, 3]) {
            const resurrection = await put(source.id, revision, source);
            expect(resurrection.status).toBe(409);
            expect(resurrection.body.document).toMatchObject({ revision: 3, deleted: true, document: null });
        }
        expect((await api("GET", source.id)).body.document).toMatchObject({ revision: 3, deleted: true, document: null });
    });
}, 60_000);
