import { Router } from "express";
import { CanvasDocumentError, assertCanvasOwner, canvasDocumentMetadata, missingCanvasDocument, parseCanvasDocumentWrite, type CanvasDocumentEnvelope } from "../canvas-document";
import type { Database } from "../db";
import type { AuthenticatedRequest } from "../types";
import { accessClause } from "./assets";

const columns = `external_id AS id,revision::double precision AS revision,deleted,document,updated_at AS "updatedAt"`;
const acknowledgementColumns = `external_id AS id,revision::double precision AS revision,deleted,updated_at AS "updatedAt"`;
// Project listing never sends graph/history JSON to the API process or browser.
const summaryColumns = `external_id AS id,revision::double precision AS revision,deleted,updated_at AS "updatedAt",
    CASE WHEN deleted THEN NULL ELSE jsonb_build_object(
        'id',external_id,'title',title,'createdAt',document_created_at,'updatedAt',document_updated_at,
        'nodeCount',node_count,'connectionCount',connection_count,
        'persistenceConflict',persistence_conflict,
        'cover',CASE WHEN cover_url IS NULL THEN NULL ELSE jsonb_build_object('content',cover_url) END
    ) END AS summary`;

export function createCanvasDocumentsRouter(db: Database) {
    const router = Router();
    router.use((request, response, next) => {
        try {
            assertCanvasOwner(request.get("X-Canvas-Owner-Id"), (request as AuthenticatedRequest).auth.id);
            response.set("Cache-Control", "no-store");
            next();
        } catch (error) {
            if (error instanceof CanvasDocumentError) response.status(error.status).json({ error: error.code, message: error.message });
            else next(error);
        }
    });
    router.get("/", async (request, response, next) => {
        try {
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const result = await db.query<{ summary: Record<string, unknown> | null }>(`SELECT ${summaryColumns} FROM canvas_documents WHERE owner_user_id=$1 ORDER BY updated_at DESC,external_id`, [actor.id]);
            response.json({ documents: result.rows.map(row => {
                if (!row.summary || row.summary.persistenceConflict !== null) return row;
                const { persistenceConflict: _emptyConflict, ...summary } = row.summary;
                return { ...row, summary };
            }) });
        } catch (error) { next(error); }
    });
    router.get("/:id", async (request, response, next) => {
        try {
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const id = String(request.params.id);
            const result = await db.query(`SELECT ${columns} FROM canvas_documents WHERE owner_user_id=$1 AND external_id=$2`, [actor.id, id]);
            response.json({ document: result.rows[0] ?? missingCanvasDocument(id) });
        } catch (error) { next(error); }
    });
    router.put("/:id", async (request, response, next) => {
        try {
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const id = String(request.params.id);
            const { baseRevision, document, assetIds } = parseCanvasDocumentWrite(id, request.body);
            if (assetIds.length) {
                const access = accessClause(actor);
                const shifted = access.sql.replace(/\$(\d+)/g, (_, number) => `$${Number(number) + 1}`);
                const accessible = await db.query<{ id: string }>(`SELECT a.id FROM assets a WHERE a.id=ANY($1::uuid[]) AND a.status='ready' AND a.deleted_at IS NULL AND ${shifted}`, [assetIds, ...access.values]);
                const accessibleIds = new Set(accessible.rows.map(row => row.id));
                const unavailableIds = assetIds.filter(assetId => !accessibleIds.has(assetId));
                if (unavailableIds.length) {
                    const current = (await db.query<CanvasDocumentEnvelope>(`SELECT ${columns} FROM canvas_documents WHERE owner_user_id=$1 AND external_id=$2`, [actor.id, id])).rows[0];
                    if ((current?.revision ?? 0) !== baseRevision || current?.deleted) {
                        response.status(409).json({ error: "CANVAS_REVISION_CONFLICT", message: "云端画布已有更新，请保留本地改动并重新同步", document: current ?? missingCanvasDocument(id) });
                        return;
                    }
                    // Deletion or revoked sharing must not freeze an existing canvas.
                    // Only this owner's exact base document can retain stale IDs; the
                    // final CAS still prevents races, and media reads keep their ACL.
                    const retainedIds = new Set(current ? parseCanvasDocumentWrite(id, { baseRevision, document: current.document }).assetIds : []);
                    if (unavailableIds.some(assetId => !retainedIds.has(assetId))) throw new CanvasDocumentError("CANVAS_ASSET_FORBIDDEN", "画布包含不存在或无权读取的素材", 403);
                }
            }
            const json = document === null ? null : JSON.stringify(document);
            const metadata = canvasDocumentMetadata(document);
            const conflict = document?.persistenceConflict;
            const summaryValues = [metadata.title, metadata.createdAt, metadata.updatedAt, metadata.nodeCount, metadata.connectionCount, metadata.coverUrl, conflict == null ? null : JSON.stringify(conflict)];
            // Both branches are atomic CAS writes. A tombstone can never become live again.
            const result = baseRevision === 0
                ? await db.query(`INSERT INTO canvas_documents(owner_user_id,external_id,revision,deleted,document,title,document_created_at,document_updated_at,node_count,connection_count,cover_url,persistence_conflict)
                    VALUES($1,$2,1,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(owner_user_id,external_id) DO NOTHING RETURNING ${acknowledgementColumns}`, [actor.id, id, document === null, json, ...summaryValues])
                : await db.query(`UPDATE canvas_documents SET revision=revision+1,deleted=$4,document=$5::jsonb,updated_at=now(),
                    title=$6,document_created_at=$7,document_updated_at=$8,node_count=$9,connection_count=$10,cover_url=$11,persistence_conflict=$12::jsonb
                    WHERE owner_user_id=$1 AND external_id=$2 AND revision=$3 AND (NOT deleted OR $4=true) RETURNING ${acknowledgementColumns}`, [actor.id, id, baseRevision, document === null, json, ...summaryValues]);
            if (!result.rows[0]) {
                const current = await db.query(`SELECT ${columns} FROM canvas_documents WHERE owner_user_id=$1 AND external_id=$2`, [actor.id, id]);
                response.status(409).json({ error: "CANVAS_REVISION_CONFLICT", message: "云端画布已有更新，请保留本地改动并重新同步", document: current.rows[0] ?? missingCanvasDocument(id) });
                return;
            }
            response.json({ document: result.rows[0] });
        } catch (error) {
            if (error instanceof CanvasDocumentError) response.status(error.status).json({ error: error.code, message: error.message });
            else next(error);
        }
    });
    return router;
}
