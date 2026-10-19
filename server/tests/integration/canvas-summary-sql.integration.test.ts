import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import express, { type ErrorRequestHandler } from "express";
import { createCanvasDocumentsRouter } from "../../src/routes/canvas-documents";
import type { AuthenticatedRequest, SessionUser } from "../../src/types";
import { compactHistoryAssetId, expectedCanvasSummary, largeCanvasDocument } from "../canvas-document-fixtures";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const actor = (id: string) => ({ id, role: "designer", departmentId: null, groupRole: null, groupId: null }) as SessionUser;

sqlTest("migrations 032-036 create their actual SQL schema and 034 backfills live documents and tombstones", async () => {
    // The shared fixture executes every shipped migration in order on a fresh
    // PostgreSQL WASM database; it never reads DATABASE_URL or application config.
    const fixture = await createIsolatedPostgres();
    const owner = randomUUID();
    const image = randomUUID();
    const document = largeCanvasDocument("before-summary-migration", image, 12);
    try {
        const columns = await fixture.db.query<{ table_name: string; column_name: string }>(
            "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('users','assets','tasks','canvas_documents')",
        );
        const names = columns.rows.map(row => `${row.table_name}.${row.column_name}`);
        for (const name of [
            "users.deleted_at", "assets.thumbnail_256_key", "assets.thumbnail_1024_key",
            "tasks.available_at", "tasks.execution_token", "tasks.model_slot_token", "tasks.model_slot_expires_at", "tasks.poll_deadline_at",
            "canvas_documents.title", "canvas_documents.document_created_at", "canvas_documents.document_updated_at",
            "canvas_documents.node_count", "canvas_documents.connection_count", "canvas_documents.cover_url",
        ]) expect(names).toContain(name);
        const indexes = await fixture.db.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname='public'");
        for (const name of [
            "assets_task_idx", "credit_reservations_user_status_idx", "batch_tasks_user_time_idx", "assets_company_time_idx",
            "tasks_user_cursor_idx", "tasks_cursor_idx", "history_user_cursor_idx", "history_cursor_idx",
            "assets_cursor_idx", "assets_owner_cursor_idx", "assets_department_cursor_idx", "assets_project_cursor_idx",
            "tasks_waiting_available_idx", "tasks_model_slot_idx", "tasks_poll_available_idx",
        ]) expect(indexes.rows.map(row => row.indexname)).toContain(name);

        // Recreate only the pre-034 shape inside this disposable memory database,
        // so the real migration is also exercised with existing graph data.
        await fixture.db.query(`ALTER TABLE canvas_documents DROP COLUMN title, DROP COLUMN document_created_at,
            DROP COLUMN document_updated_at, DROP COLUMN node_count, DROP COLUMN connection_count, DROP COLUMN cover_url`);
        await fixture.db.query("INSERT INTO users(id,username,display_name) VALUES($1,'summary-migration-owner','Summary owner')", [owner]);
        await fixture.db.query(`INSERT INTO canvas_documents(owner_user_id,external_id,revision,deleted,document)
            VALUES($1,$2,7,false,$3::jsonb),($1,'deleted-before-summary',4,true,NULL)`, [owner, document.id, JSON.stringify(document)]);
        const migration = await readFile(new URL("../../src/migrations/034_canvas_document_summaries.sql", import.meta.url), "utf8");
        // A DO block executes the shipped DDL and UPDATE unchanged in one call.
        await fixture.db.query(`DO $canvas_summary_migration$ BEGIN\n${migration}\nEND $canvas_summary_migration$`);
        const rows = await fixture.db.query(`SELECT external_id,revision::int,deleted,document,title,document_created_at,
            document_updated_at,node_count,connection_count,cover_url FROM canvas_documents ORDER BY external_id`);
        expect(rows.rows.find(row => row.external_id === document.id)).toEqual({
            external_id: document.id, revision: 7, deleted: false, document, title: document.title,
            document_created_at: document.createdAt, document_updated_at: document.updatedAt,
            node_count: 12, connection_count: 11, cover_url: `/api/assets/${image}/content`,
        });
        expect(rows.rows.find(row => row.external_id === "deleted-before-summary")).toEqual({
            external_id: "deleted-before-summary", revision: 4, deleted: true, document: null, title: "",
            document_created_at: null, document_updated_at: null, node_count: 0, connection_count: 0, cover_url: null,
        });
        await expect(fixture.db.query("UPDATE canvas_documents SET node_count=-1 WHERE external_id=$1", [document.id])).rejects.toThrow();
    } finally { await fixture.close(); }
}, 60_000);

sqlTest("formal PostgreSQL canvas routes preserve complete detail while ACKs and metadata summaries remain compact and owner-scoped", async () => {
    const fixture = await createIsolatedPostgres();
    const owner = randomUUID(), other = randomUUID(), image = randomUUID();
    const document = largeCanvasDocument("canvas-summary-sql", image, 12);
    let server: ReturnType<express.Express["listen"]> | undefined;
    try {
        await fixture.db.query("INSERT INTO users(id,username,display_name) VALUES($1,'summary-owner','Owner'),($2,'summary-other','Other owner')", [owner, other]);
        await fixture.db.query(`INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,status,visibility_scope)
            VALUES($1,$3,'summary/original.png','original.png','image/png',512,'ready','private'),
                  ($2,$3,'summary/history.png','history.png','image/png',512,'ready','private')`, [image, compactHistoryAssetId, owner]);
        const app = express().use(express.json({ limit: "20mb" }));
        app.use((request, _response, next) => {
            (request as AuthenticatedRequest).auth = actor(request.get("test-actor") || owner);
            next();
        });
        app.use("/api/canvas-documents", createCanvasDocumentsRouter(fixture.db));
        app.use(((error, _request, response, _next) => {
            response.status(error.status || 500).json({ error: error.code, message: error.message });
        }) as ErrorRequestHandler);
        server = app.listen(0, "127.0.0.1");
        await new Promise<void>(done => server!.once("listening", done));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/canvas-documents`;
        const api = async (method: string, id = "", body?: unknown, employee = owner, ownerHeader = employee) => {
            const response = await fetch(`${origin}${id ? `/${encodeURIComponent(id)}` : ""}`, {
                method, headers: { "content-type": "application/json", "X-Canvas-Owner-Id": ownerHeader, "test-actor": employee },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            const text = await response.text();
            return { status: response.status, headers: response.headers, text, body: JSON.parse(text) };
        };

        const first = await api("PUT", document.id, { baseRevision: 0, document });
        expect(first.status).toBe(200);
        expect(first.headers.get("cache-control")).toBe("no-store");
        expect(first.body.document).toMatchObject({ id: document.id, revision: 1, deleted: false });
        expect(Object.keys(first.body.document).sort()).toEqual(["deleted", "id", "revision", "updatedAt"]);
        expect(Buffer.byteLength(first.text)).toBeLessThan(256);
        expect(first.text).not.toContain("PRIVATE-");

        fixture.statements.length = 0;
        const listed = await api("GET");
        expect(listed.status).toBe(200);
        expect(listed.body.documents).toEqual([{ ...first.body.document, summary: expectedCanvasSummary(document) }]);
        expect(listed.headers.get("cache-control")).toBe("no-store");
        expect(listed.text).not.toContain("PRIVATE-");
        expect(listed.text).not.toContain("canvas-history-delta-v1");
        expect(fixture.statements).toHaveLength(1);
        expect(fixture.statements[0]).toContain("jsonb_build_object");
        expect(fixture.statements[0]).not.toMatch(/\bdocument\b|jsonb_array/i);
        const detail = await api("GET", document.id);
        expect(detail.status).toBe(200);
        expect(detail.body.document).toEqual({ ...first.body.document, document });

        const updated = { ...largeCanvasDocument(document.id, compactHistoryAssetId, 8), title: "修改后的完整画布", updatedAt: "2026-10-19T00:00:00.000Z" };
        const changed = await api("PUT", document.id, { baseRevision: 1, document: updated });
        expect(changed.status).toBe(200);
        expect(changed.body.document.revision).toBe(2);
        expect(changed.body.document).not.toHaveProperty("document");
        expect((await api("GET")).body.documents).toEqual([{ ...changed.body.document, summary: expectedCanvasSummary(updated) }]);
        expect((await api("GET", document.id)).body.document.document).toEqual(updated);
        const persisted = await fixture.db.query("SELECT title,node_count,connection_count,cover_url FROM canvas_documents WHERE owner_user_id=$1 AND external_id=$2", [owner, document.id]);
        expect(persisted.rows).toEqual([{ title: updated.title, node_count: 8, connection_count: 7, cover_url: `/api/assets/${compactHistoryAssetId}/content` }]);

        fixture.statements.length = 0;
        expect((await api("GET", document.id, undefined, other, owner)).status).toBe(403);
        expect((await api("PUT", document.id, { baseRevision: 2, document: updated }, other, owner)).status).toBe(403);
        expect(fixture.statements).toHaveLength(0);
        expect((await api("GET", "", undefined, other)).body.documents).toEqual([]);
        expect((await api("GET", document.id, undefined, other)).body.document).toMatchObject({ revision: 0, deleted: true, document: null });
        const forbiddenAsset = await api("PUT", document.id, { baseRevision: 0, document: updated }, other);
        expect(forbiddenAsset.status).toBe(403);
        expect(forbiddenAsset.body.error).toBe("CANVAS_ASSET_FORBIDDEN");
        const noAssets = { ...updated, nodes: [], connections: [], groups: [], chatSessions: [], activeChatId: null, history: { past: [], future: [] } };
        expect((await api("PUT", document.id, { baseRevision: 2, document: noAssets }, other)).status).toBe(409);
        expect((await api("GET", document.id)).body.document).toEqual({ ...changed.body.document, document: updated });

        const candidates = [{ ...updated, title: "并发版本 A" }, { ...updated, title: "并发版本 B" }];
        const concurrent = await Promise.all(candidates.map(candidate => api("PUT", document.id, { baseRevision: 2, document: candidate })));
        expect(concurrent.map(result => result.status).sort()).toEqual([200, 409]);
        const winnerIndex = concurrent.findIndex(result => result.status === 200);
        const winner = concurrent[winnerIndex]!;
        const conflict = concurrent.find(result => result.status === 409)!;
        expect(winner.body.document).not.toHaveProperty("document");
        expect(conflict.body).toMatchObject({ error: "CANVAS_REVISION_CONFLICT", document: { revision: 3, document: candidates[winnerIndex] } });
        expect((await api("GET", document.id)).body.document).toEqual({ ...winner.body.document, document: candidates[winnerIndex] });
        expect((await api("GET")).body.documents[0].summary.title).toBe(candidates[winnerIndex]!.title);

        const deleted = await api("PUT", document.id, { baseRevision: 3, document: null });
        expect(deleted.status).toBe(200);
        expect(deleted.body.document).toMatchObject({ revision: 4, deleted: true });
        expect(deleted.body.document).not.toHaveProperty("document");
        expect((await api("GET")).body.documents).toEqual([{ ...deleted.body.document, summary: null }]);
        expect((await api("GET", document.id)).body.document).toEqual({ ...deleted.body.document, document: null });
        expect((await fixture.db.query("SELECT title,node_count,connection_count,cover_url FROM canvas_documents WHERE owner_user_id=$1 AND external_id=$2", [owner, document.id])).rows)
            .toEqual([{ title: "", node_count: 0, connection_count: 0, cover_url: null }]);
        for (const revision of [0, 3, 4]) {
            expect((await api("PUT", document.id, { baseRevision: revision, document: updated })).status).toBe(409);
        }
        const otherDocument = await api("PUT", document.id, { baseRevision: 0, document: noAssets }, other);
        expect(otherDocument.status).toBe(200);
        expect(otherDocument.body.document).toMatchObject({ revision: 1, deleted: false });
        expect((await api("GET", document.id)).body.document).toEqual({ ...deleted.body.document, document: null });
        expect((await api("GET", document.id, undefined, other)).body.document.document).toEqual(noAssets);
    } finally {
        if (server) await new Promise<void>(done => { server!.close(() => done()); server!.closeAllConnections(); });
        await fixture.close();
    }
}, 60_000);
