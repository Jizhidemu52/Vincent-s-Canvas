import { expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { Database as Sqlite } from "bun:sqlite";
import type { Database } from "../src/db";
import type { AuthenticatedRequest, SessionUser } from "../src/types";
import { assertCanvasOwner, CanvasDocumentError, parseCanvasDocumentWrite } from "../src/canvas-document";
import { createCanvasDocumentsRouter } from "../src/routes/canvas-documents";
import { createAssetsRouter } from "../src/routes/assets";
import type { ObjectStorage } from "../src/object-storage";

const assetId = "11111111-2222-4333-8444-555555555555";
function project() {
    return {
        id: "canvas-1", title: "完整画布", createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-17T00:00:00Z",
        nodes: [
            { id: "image-1", type: "image", title: "图片", position: { x: -400, y: 150 }, width: 360, height: 240, metadata: { content: `/api/assets/${assetId}/content`, prompt: "保留编辑提示词" } },
            { id: "text-1", type: "text", title: "文本", position: { x: 20, y: 0 }, width: 200, height: 100, metadata: { content: "blob: 是浏览器临时URL；data: 也可出现在文本中" } },
        ],
        connections: [{ id: "edge-1", fromNodeId: "image-1", toNodeId: "text-1" }],
        chatSessions: [{ id: "chat-1", title: "编辑记录", createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-17T00:00:00Z", messages: [{ id: "m1", role: "user", text: "保留这张图，并解释 data: URL", detail: { custom: true } }] }],
        activeChatId: "chat-1", backgroundMode: "dots", showImageInfo: true, viewport: { x: 0, y: 2, k: 0.75 },
    };
}

test("cloud document preserves positions, connections, edits, chat and free text while collecting server assets", () => {
    const document = project();
    const parsed = parseCanvasDocumentWrite("canvas-1", { baseRevision: 0, document });
    expect(parsed.document).toEqual(document);
    expect(parsed.assetIds).toEqual([assetId]);
    expect(parseCanvasDocumentWrite("canvas-1", { baseRevision: 2, document: null })).toEqual({ baseRevision: 2, document: null, assetIds: [] });
});

test("document validation rejects missing structure, mismatched id and broken graph", () => {
    for (const body of [
        { baseRevision: -1, document: null }, { baseRevision: 1.2, document: null }, { baseRevision: 0 },
        { baseRevision: 0, document: { id: "canvas-1", title: "incomplete" } },
        { baseRevision: 0, document: { ...project(), id: "other" } },
        { baseRevision: 0, document: { ...project(), viewport: { x: 0, y: 0, k: 0 } } },
        { baseRevision: 0, document: { ...project(), connections: [{ id: "x", fromNodeId: "missing", toNodeId: "text-1" }] } },
    ]) expect(() => parseCanvasDocumentWrite("canvas-1", body)).toThrow(CanvasDocumentError);
});

test("media validation rejects nested local resources but not textual prompts", () => {
    for (const extra of [
        { url: "blob:local" }, { dataUrl: "data:image/png;base64,AAA" }, { metadata: { storageKey: "image:file:local" } },
        { candidates: [{ url: "image:file:tmp" }] }, { references: ["blob:legacy"] },
        { manualImageReferences: [{ type: "image/png", content: "data:image/png;base64,AAA" }] },
        { url: "/api/assets/not-a-uuid/content" },
    ]) expect(() => parseCanvasDocumentWrite("canvas-1", { baseRevision: 0, document: { ...project(), extra } })).toThrow(CanvasDocumentError);
    const localNode = project();
    localNode.nodes[0]!.metadata.content = "blob:local-node";
    expect(() => parseCanvasDocumentWrite("canvas-1", { baseRevision: 0, document: localNode })).toThrow(CanvasDocumentError);
});

test("document size is capped and owner must exactly match the current session", () => {
    expect(() => parseCanvasDocumentWrite("canvas-1", { baseRevision: 0, document: { ...project(), extra: "x".repeat(20 * 1024 * 1024) } })).toThrow(CanvasDocumentError);
    for (const header of [undefined, "employee-b", ["employee-a"], " employee-a"]) expect(() => assertCanvasOwner(header, "employee-a")).toThrow(CanvasDocumentError);
    expect(() => assertCanvasOwner("employee-a", "employee-a")).not.toThrow();
});

const actor = (id: string) => ({ id, role: "designer", departmentId: null, groupRole: null, groupId: null }) as SessionUser;

test("upload project association requires ownership or explicit membership before any asset is created", async () => {
    const foreignProject = "11111111-1111-4111-8111-111111111111";
    const ownProject = "22222222-2222-4222-8222-222222222222";
    const writes: unknown[][] = [];
    const db = { query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("FROM projects")) {
            expect(sql).toContain("owner_user_id=$2");
            expect(sql).toContain("project_members");
            expect(params[1]).toBe("employee-a");
            return { rows: params[0] === ownProject ? [{ id: ownProject }] : [] };
        }
        if (sql.startsWith("INSERT INTO assets")) writes.push(params);
        return { rows: [] };
    } } as unknown as Database;
    const app = express().use(express.json());
    app.use((req, _res, next) => { (req as AuthenticatedRequest).auth = actor("employee-a"); next(); });
    app.use("/assets", createAssetsRouter(db, { configured: true } as ObjectStorage));
    await serve(app, async origin => {
        const upload = (projectId: string) => fetch(`${origin}/assets/upload-request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: "original.png", mimeType: "image/png", byteSize: 4, projectId }) });
        expect((await upload(foreignProject)).status).toBe(403);
        expect(writes).toHaveLength(0);
        expect((await upload(ownProject)).status).toBe(201);
        expect(writes).toHaveLength(1);
        expect(writes[0]?.[1]).toBe("employee-a");
        expect(writes[0]?.[3]).toBe(ownProject);
    });
});

test("formal original-media HTTP keeps bytes unchanged and rejects another employee before storage reads or writes", async () => {
    const records = new Map<string, { owner: string; object_key: string; mime_type: string; byte_size: number; filename: string; ready: boolean }>();
    const objects = new Map<string, Uint8Array>();
    let storageReads = 0;
    const db = { query: async (sql: string, values: any[] = []) => {
        if (sql.startsWith("INSERT INTO assets")) {
            records.set(values[0], { owner: values[1], object_key: values[4], filename: values[5], mime_type: values[6], byte_size: values[7], ready: false });
            return { rows: [] };
        }
        const record = records.get(values[0]);
        if (sql.startsWith("UPDATE assets SET status='ready'")) { if (record) record.ready = true; return { rows: [] }; }
        if (sql.includes("status='pending'")) {
            expect(sql).toContain("owner_user_id=$2");
            return { rows: record && !record.ready && record.owner === values[1] ? [record] : [] };
        }
        if (sql.includes("FROM assets a")) {
            expect(sql).toContain("a.owner_user_id=$2");
            expect(sql).toContain("a.status='ready'");
            return { rows: record?.ready && record.owner === values[1] ? [record] : [] };
        }
        throw new Error("Unexpected SQL in original-media test");
    } } as unknown as Database;
    const storage = {
        configured: true,
        put: async (key: string, bytes: Uint8Array) => { objects.set(key, new Uint8Array(bytes)); },
        get: async (key: string) => { storageReads++; const bytes = objects.get(key)!; return { ContentLength: bytes.byteLength, Body: { transformToByteArray: async () => bytes } }; },
    } as unknown as ObjectStorage;
    const app = express().use(express.json());
    app.use((req, _res, next) => { (req as AuthenticatedRequest).auth = actor(req.get("test-actor") || "employee-a"); next(); });
    app.use("/assets", createAssetsRouter(db, storage));
    await serve(app, async origin => {
        const original = new Uint8Array([137, 80, 78, 71, 0, 255, 1, 2, 3]);
        const reserved = await fetch(`${origin}/assets/upload-request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: "原图.png", mimeType: "image/png", byteSize: original.byteLength }) });
        const { assetId: id } = await reserved.json();
        const upload = (employee: string) => fetch(`${origin}/assets/${id}/upload`, { method: "PUT", headers: { "content-type": "image/png", "test-actor": employee }, body: original });
        expect((await upload("employee-b")).status).toBe(404);
        expect(objects.size).toBe(0);
        expect((await upload("employee-a")).status).toBe(204);
        const foreign = await fetch(`${origin}/assets/${id}/content`, { headers: { "test-actor": "employee-b" } });
        expect(foreign.status).toBe(404);
        expect(storageReads).toBe(0);
        const own = await fetch(`${origin}/assets/${id}/content`);
        expect(own.status).toBe(200);
        expect(own.headers.get("cache-control")).toContain("no-store");
        expect(await own.bytes()).toEqual(original);
        expect([...objects.keys()][0]).toStartWith("users/employee-a/");
    });
});
async function serve(app: express.Express, run: (origin: string) => Promise<void>) {
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

// Execute the real CAS statements against SQLite after removing PG-only casts.
// This verifies write predicates and owner scoping; it is not a PostgreSQL migration test.
function databaseFixture() {
    const sqlite = new Sqlite(":memory:");
    sqlite.run("CREATE TABLE canvas_documents(owner_user_id TEXT,external_id TEXT,revision INTEGER,deleted INTEGER,document TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(owner_user_id,external_id))");
    let assetsAllowed = true;
    const db = { query: async (sql: string, parameters: unknown[] = []) => {
        if (sql.includes("FROM assets a")) {
            expect(sql).toContain("a.owner_user_id=$2");
            expect(sql).toContain("a.status='ready'");
            expect(sql).toContain("a.deleted_at IS NULL");
            expect(parameters[1]).toBe("employee-a");
            return { rows: assetsAllowed ? [{ id: assetId }] : [] };
        }
        const statement = sql.replace(/::double precision|::jsonb/g, "").replace(/now\(\)/g, "CURRENT_TIMESTAMP").replace(/\$(\d+)/g, "?$1");
        const values = parameters.map(value => typeof value === "boolean" ? Number(value) : value) as any[];
        const rows = sqlite.query(statement).all(...values) as Array<Record<string, any>>;
        return { rows: rows.map(row => ({ ...row, deleted: Boolean(row.deleted), document: row.document === null ? null : JSON.parse(row.document) })) };
    } } as unknown as Database;
    return { db, sqlite, denyAssets: () => { assetsAllowed = false; } };
}

test("canvas API isolates employees, CAS-conflicts concurrent stale writes and never resurrects tombstones", async () => {
    const fixture = databaseFixture();
    const app = express().use(express.json());
    app.use((req, _res, next) => { (req as AuthenticatedRequest).auth = actor(req.get("test-actor") || "employee-a"); next(); });
    app.use("/api/canvas-documents", createCanvasDocumentsRouter(fixture.db));
    try { await serve(app, async origin => {
        const api = async (method: string, id = "", body?: unknown, employee = "employee-a", owner = employee) => {
            const response = await fetch(`${origin}/api/canvas-documents${id ? `/${id}` : ""}`, { method, headers: { "content-type": "application/json", "X-Canvas-Owner-Id": owner, "test-actor": employee }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            return { status: response.status, body: await response.json() };
        };
        const document = project();
        expect((await api("GET", "", undefined, "employee-a", "employee-b")).status).toBe(403);
        expect((await api("PUT", "canvas-1", { baseRevision: 0, document }, "employee-b", "employee-a")).status).toBe(403);
        const first = await api("PUT", "canvas-1", { baseRevision: 0, document });
        expect(first.status).toBe(200);
        expect(first.body.document).toMatchObject({ id: "canvas-1", revision: 1, deleted: false, document });
        expect((await api("GET")).body.documents[0].document).toEqual(document);
        expect((await api("GET", "", undefined, "employee-b")).body.documents).toEqual([]);
        const concurrent = await Promise.all([api("PUT", "canvas-1", { baseRevision: 1, document: { ...document, title: "device-a" } }), api("PUT", "canvas-1", { baseRevision: 1, document: { ...document, title: "device-b" } })]);
        expect(concurrent.map(result => result.status).sort()).toEqual([200, 409]);
        expect(concurrent.find(result => result.status === 409)?.body.document.revision).toBe(2);
        expect((await api("PUT", "canvas-1", { baseRevision: 2, document: null })).body.document).toMatchObject({ revision: 3, deleted: true, document: null });
        for (const revision of [0, 1, 3]) expect((await api("PUT", "canvas-1", { baseRevision: revision, document })).status).toBe(409);
        const missing = await api("PUT", "missing", { baseRevision: 9, document: null });
        expect(missing.status).toBe(409);
        expect(missing.body.document).toEqual({ id: "missing", revision: 0, deleted: true, document: null, updatedAt: "1970-01-01T00:00:00.000Z" });
        const other = await api("PUT", "canvas-1", { baseRevision: 0, document: { ...document, nodes: [], connections: [] } }, "employee-b");
        expect(other.status).toBe(200);
        expect(other.body.document.revision).toBe(1);
        expect((await api("GET")).body.documents[0].deleted).toBe(true);
    }); } finally { fixture.sqlite.close(); }
});

test("canvas API refuses guessed or unreadable server asset ids before writing", async () => {
    const fixture = databaseFixture(); fixture.denyAssets();
    const app = express().use(express.json());
    app.use((req, _res, next) => { (req as AuthenticatedRequest).auth = actor("employee-a"); next(); });
    app.use("/api/canvas-documents", createCanvasDocumentsRouter(fixture.db));
    try { await serve(app, async origin => {
        const response = await fetch(`${origin}/api/canvas-documents/canvas-1`, { method: "PUT", headers: { "content-type": "application/json", "X-Canvas-Owner-Id": "employee-a" }, body: JSON.stringify({ baseRevision: 0, document: project() }) });
        expect(response.status).toBe(403);
        expect((await response.json()).error).toBe("CANVAS_ASSET_FORBIDDEN");
        expect(fixture.sqlite.query("SELECT count(*) AS n FROM canvas_documents").get()).toEqual({ n: 0 });
    }); } finally { fixture.sqlite.close(); }
});

test("optional canvas upload owner guard blocks cookie changes before upload or database writes", async () => {
    const db = { query: async () => { throw new Error("Must not access database"); } } as unknown as Database;
    const storage = { configured: true, put: async () => { throw new Error("Must not upload"); } } as unknown as ObjectStorage;
    const app = express().use(express.json());
    app.use((req, _res, next) => { (req as AuthenticatedRequest).auth = actor("employee-b"); next(); });
    app.use("/assets", createAssetsRouter(db, storage));
    await serve(app, async origin => {
        const headers = { "X-Canvas-Owner-Id": "employee-a" };
        expect((await fetch(`${origin}/assets/upload-request`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ filename: "image.png", mimeType: "image/png", byteSize: 3 }) })).status).toBe(403);
        expect((await fetch(`${origin}/assets/${assetId}/upload`, { method: "PUT", headers: { ...headers, "content-type": "application/octet-stream" }, body: "123" })).status).toBe(403);
    });
});
