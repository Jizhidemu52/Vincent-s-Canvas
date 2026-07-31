import { Router } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { Database } from "../db";
import { requireRole } from "../rbac";
import type { AuthenticatedRequest } from "../types";

const syncSchema = z.object({
    externalId: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(200),
});

const memberSchema = z.object({
    userId: z.string().uuid(),
    role: z.enum(["editor", "member"]).default("member"),
});

const viewportSchema = z.object({
    x: z.number(),
    y: z.number(),
    scale: z.number(),
});

const canvasSnapshotSchema = z.object({
    id: z.string(),
    name: z.string(),
    nodes: z.array(z.unknown()),
    connections: z.array(z.unknown()),
    chatSessions: z.array(z.unknown()),
    activeChatId: z.string().nullable(),
    backgroundMode: z.enum(["dots", "lines", "blank"]),
    showImageInfo: z.boolean(),
    viewport: viewportSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
});

const canvasSaveSchema = z.object({
    revision: z.number().int().min(0),
    snapshot: canvasSnapshotSchema,
});

type VisibleProject = {
    id: string;
    ownerUserId: string;
    departmentId: string | null;
};

type CanvasSnapshotRow = {
    snapshot: unknown;
    revision: number;
    updatedAt: string;
};

const canvasStorageKeyPattern = /^(image|video|audio|file|video-reference|audio-reference):/;
const embeddedCanvasMediaPattern = /^data:(image|video|audio)\//i;

export async function findVisibleProject(db: Database, projectId: string, userId: string) {
    const result = await db.query<VisibleProject>(
        `SELECT p.id,p.owner_user_id AS "ownerUserId",p.department_id AS "departmentId"
         FROM projects p
         WHERE p.id=$1 AND (
            p.owner_user_id=$2 OR EXISTS(
                SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.user_id=$2
            )
         )
         LIMIT 1`,
        [projectId, userId],
    );
    return result.rows[0] ?? null;
}

function collectCanvasStorageKeys(value: unknown, keys = new Set<string>()) {
    if (typeof value === "string") {
        if (canvasStorageKeyPattern.test(value)) keys.add(value);
        return keys;
    }
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && canvasStorageKeyPattern.test(value.storageKey)) {
        keys.add(value.storageKey);
    }
    for (const item of Object.values(value)) {
        if (Array.isArray(item)) item.forEach((child) => collectCanvasStorageKeys(child, keys));
        else collectCanvasStorageKeys(item, keys);
    }
    return keys;
}

function hasEmbeddedCanvasMedia(value: unknown): boolean {
    if (typeof value === "string") return embeddedCanvasMediaPattern.test(value);
    if (!value || typeof value !== "object") return false;
    return Object.values(value).some((item) => Array.isArray(item)
        ? item.some((child) => hasEmbeddedCanvasMedia(child))
        : hasEmbeddedCanvasMedia(item));
}

async function validateCanvasReferences(db: Database, snapshot: z.infer<typeof canvasSnapshotSchema>, actor: AuthenticatedRequest["auth"]) {
    const keys = [...collectCanvasStorageKeys(snapshot)];
    if (!keys.length) return true;
    const values: unknown[] = [keys, actor.id, actor.departmentId];
    const leaderScope = actor.role !== "super_admin" && actor.groupRole === "leader"
        ? (values.push(actor.groupId), ` OR EXISTS(
            SELECT 1 FROM group_memberships gm
            WHERE gm.group_id=$4 AND gm.user_id=a.owner_user_id
              AND gm.effective_at<=a.created_at AND (gm.ended_at IS NULL OR gm.ended_at>a.created_at)
        )`)
        : "";
    const adminScope = actor.role === "department_admin" ? " OR a.department_id=$3" : "";
    const accessScope = actor.role === "super_admin"
        ? "TRUE"
        : `(
            a.owner_user_id=$2 OR a.visibility_scope='company'
            OR (a.department_id=$3 AND $3::uuid IS NOT NULL AND EXISTS(
                SELECT 1 FROM asset_shares s WHERE s.asset_id=a.id AND s.department_id=$3
            ))
            OR EXISTS(SELECT 1 FROM asset_shares s WHERE s.asset_id=a.id AND s.user_id=$2)
            OR EXISTS(
                SELECT 1 FROM asset_shares s
                JOIN project_members pm ON pm.project_id=s.project_id
                WHERE s.asset_id=a.id AND pm.user_id=$2
            )
            ${adminScope}${leaderScope}
        )`;
    const result = await db.query<{ count: number }>(
        `WITH refs(key) AS (SELECT unnest($1::text[]))
         SELECT count(*)::int AS count
         FROM refs r
         WHERE EXISTS(
            SELECT 1 FROM assets a
            WHERE a.deleted_at IS NULL AND a.status='ready'
              AND (
                a.id::text=r.key OR a.client_reference_id=r.key OR a.object_key=r.key
                OR a.metadata->>'storageKey'=r.key
              )
              AND ${accessScope}
         )`,
        values,
    );
    return Number(result.rows[0]?.count ?? 0) === keys.length;
}

async function readCanvasSnapshot(db: Database, projectId: string) {
    const result = await db.query<CanvasSnapshotRow>(
        `SELECT snapshot,revision,updated_at AS "updatedAt"
         FROM project_canvas_snapshots
         WHERE project_id=$1`,
        [projectId],
    );
    return result.rows[0] ?? null;
}

function sendProjectNotFound(response: { status: (code: number) => { json: (body: unknown) => unknown } }) {
    response.status(404).json({ error: "NOT_FOUND", message: "项目不存在或无权访问" });
}

function canvasResponse(row: CanvasSnapshotRow | null) {
    return row ? { snapshot: row.snapshot, revision: row.revision, updatedAt: row.updatedAt } : null;
}

export function createProjectsRouter(db: Database) {
    const router = Router();

    router.get("/", async (request, response, next) => {
        try {
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const result = await db.query(
                `SELECT DISTINCT p.id,p.external_id AS "externalId",p.name,p.status,
                    p.created_at AS "createdAt",p.updated_at AS "updatedAt"
                 FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id
                 WHERE p.owner_user_id=$1 OR pm.user_id=$1
                 ORDER BY p.updated_at DESC`,
                [actor.id],
            );
            response.json({ projects: result.rows });
        } catch (error) {
            next(error);
        }
    });

    router.post("/sync", async (request, response, next) => {
        try {
            const input = syncSchema.parse(request.body);
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const result = await db.query(
                `INSERT INTO projects(external_id,name,owner_user_id,department_id)
                 VALUES($1,$2,$3,$4)
                 ON CONFLICT(owner_user_id,external_id)
                 DO UPDATE SET name=EXCLUDED.name,updated_at=now()
                 RETURNING id,external_id AS "externalId",name,status`,
                [input.externalId, input.name, actor.id, actor.departmentId],
            );
            await db.query(
                "INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING",
                [result.rows[0].id, actor.id],
            );
            response.json({ project: result.rows[0] });
        } catch (error) {
            next(error);
        }
    });

    router.get("/:id/canvas", async (request, response, next) => {
        try {
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const project = await findVisibleProject(db, request.params.id, actor.id);
            if (!project) {
                sendProjectNotFound(response);
                return;
            }
            response.json({ canvas: canvasResponse(await readCanvasSnapshot(db, project.id)) });
        } catch (error) {
            next(error);
        }
    });

    router.put("/:id/canvas", async (request, response, next) => {
        try {
            const input = canvasSaveSchema.parse(request.body);
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const project = await findVisibleProject(db, request.params.id, actor.id);
            if (!project) {
                sendProjectNotFound(response);
                return;
            }
            if (hasEmbeddedCanvasMedia(input.snapshot)) {
                response.status(400).json({ error: "CANVAS_EMBEDDED_MEDIA", message: "画布快照不能包含内嵌媒体数据" });
                return;
            }
            if (!(await validateCanvasReferences(db, input.snapshot, actor))) {
                response.status(403).json({ error: "CANVAS_REFERENCE_FORBIDDEN", message: "画布引用的素材不存在或无权访问" });
                return;
            }

            const client = await db.connect();
            try {
                await client.query("BEGIN");
                const snapshotJson = JSON.stringify(input.snapshot);
                const saved = input.revision === 0
                    ? await client.query<CanvasSnapshotRow>(
                        `INSERT INTO project_canvas_snapshots(project_id,owner_user_id,revision,snapshot)
                         SELECT $1,$2,1,$3::jsonb
                         WHERE $4::int=0
                         ON CONFLICT(project_id) DO NOTHING
                         RETURNING snapshot,revision,updated_at AS "updatedAt"`,
                        [project.id, project.ownerUserId, snapshotJson, input.revision],
                    )
                    : await client.query<CanvasSnapshotRow>(
                        `UPDATE project_canvas_snapshots
                         SET snapshot=$3::jsonb,revision=revision+1,updated_at=now()
                         WHERE project_id=$1 AND revision=$2
                         RETURNING snapshot,revision,updated_at AS "updatedAt"`,
                        [project.id, input.revision, snapshotJson],
                    );
                const row = saved.rows[0];
                if (!row) {
                    await client.query("ROLLBACK");
                    response.status(409).json({
                        error: "CANVAS_CONFLICT",
                        canvas: canvasResponse(await readCanvasSnapshot(db, project.id)),
                    });
                    return;
                }
                await writeAudit(client, {
                    actor,
                    action: "project.canvas_saved",
                    targetType: "project",
                    targetId: project.id,
                    departmentId: project.departmentId,
                    result: "success",
                    detail: { revision: row.revision, nodeCount: input.snapshot.nodes.length },
                    ip: request.ip,
                });
                await client.query("COMMIT");
                response.json({ canvas: canvasResponse(row) });
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            next(error);
        }
    });

    router.post("/:id/members", async (request, response, next) => {
        try {
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const input = memberSchema.parse(request.body);
            const owned = await db.query("SELECT id FROM projects WHERE id=$1 AND owner_user_id=$2", [request.params.id, actor.id]);
            if (!owned.rows[0]) {
                response.status(403).json({ error: "FORBIDDEN", message: "只有项目所有者可以添加成员" });
                return;
            }

            const targetValues: unknown[] = [input.userId];
            const departmentScope = actor.role === "super_admin"
                ? ""
                : (targetValues.push(actor.departmentId), "AND department_id IS NOT DISTINCT FROM $2::uuid");
            const target = await db.query(
                `SELECT id FROM users WHERE id=$1 AND status='active' ${departmentScope}`,
                targetValues,
            );
            if (!target.rows[0]) {
                response.status(403).json({ error: "INVALID_PROJECT_MEMBER", message: "只能添加本部门的有效账号" });
                return;
            }

            await db.query(
                `INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)
                 ON CONFLICT(project_id,user_id) DO UPDATE SET role=EXCLUDED.role`,
                [request.params.id, input.userId, input.role],
            );
            await writeAudit(db, {
                actor,
                action: "project.member_added",
                targetType: "project",
                targetId: request.params.id,
                departmentId: actor.departmentId,
                result: "success",
                detail: { userId: input.userId, role: input.role },
                ip: request.ip,
            });
            response.status(204).end();
        } catch (error) {
            next(error);
        }
    });

    return router;
}

export function createAdminProjectsRouter(db: Database) {
    const router = Router();
    router.use(requireRole("super_admin", "department_admin"));
    router.get("/", async (request, response, next) => {
        try {
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const values: unknown[] = [];
            const where = actor.role === "department_admin"
                ? (values.push(actor.departmentId), "WHERE p.department_id=$1")
                : "";
            const result = await db.query(
                `SELECT p.id,p.external_id AS "externalId",p.name,u.display_name AS "ownerName",
                    d.name AS "departmentName",p.status,
                    (SELECT COUNT(*)::int FROM tasks t
                     WHERE t.user_id=p.owner_user_id AND t.project_id=p.external_id) AS "taskCount",
                    (SELECT COUNT(*)::int FROM assets a
                     WHERE a.owner_user_id=p.owner_user_id AND a.project_external_id=p.external_id
                       AND a.deleted_at IS NULL) AS "assetCount",
                    (SELECT COALESCE(SUM(h.credits),0)::int FROM generation_history h
                     WHERE h.user_id=p.owner_user_id AND h.project_id=p.external_id) AS credits,
                    p.updated_at AS "updatedAt"
                 FROM projects p JOIN users u ON u.id=p.owner_user_id
                 LEFT JOIN departments d ON d.id=p.department_id
                 ${where} ORDER BY p.updated_at DESC`,
                values,
            );
            response.json({ projects: result.rows });
        } catch (error) {
            next(error);
        }
    });
    return router;
}
