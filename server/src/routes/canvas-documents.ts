import { Router } from "express";
import { CanvasDocumentError, assertCanvasOwner, missingCanvasDocument, parseCanvasDocumentWrite } from "../canvas-document";
import type { Database } from "../db";
import type { AuthenticatedRequest } from "../types";
import { accessClause } from "./assets";

const columns = `external_id AS id,revision::double precision AS revision,deleted,document,updated_at AS "updatedAt"`;

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
            const result = await db.query(`SELECT ${columns} FROM canvas_documents WHERE owner_user_id=$1 ORDER BY updated_at DESC,external_id`, [actor.id]);
            response.json({ documents: result.rows });
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
                if (new Set(accessible.rows.map(row => row.id)).size !== assetIds.length) throw new CanvasDocumentError("CANVAS_ASSET_FORBIDDEN", "画布包含不存在或无权读取的素材", 403);
            }
            const json = document === null ? null : JSON.stringify(document);
            // Both branches are atomic CAS writes. A tombstone can never become live again.
            const result = baseRevision === 0
                ? await db.query(`INSERT INTO canvas_documents(owner_user_id,external_id,revision,deleted,document)
                    VALUES($1,$2,1,$3,$4::jsonb) ON CONFLICT(owner_user_id,external_id) DO NOTHING RETURNING ${columns}`, [actor.id, id, document === null, json])
                : await db.query(`UPDATE canvas_documents SET revision=revision+1,deleted=$4,document=$5::jsonb,updated_at=now()
                    WHERE owner_user_id=$1 AND external_id=$2 AND revision=$3 AND (NOT deleted OR $4=true) RETURNING ${columns}`, [actor.id, id, baseRevision, document === null, json]);
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
