import { randomUUID } from "node:crypto";
import express, { Router, type Response } from "express";
import { z } from "zod";

import {
  AssetEventError,
  listAssetEvents,
  recordAssetEvent,
  reverseAssetEvent,
  type AssetEventType,
} from "../asset-events";
import { writeAudit } from "../audit";
import type { Database } from "../db";
import { ObjectStorage } from "../object-storage";
import { requireRole } from "../rbac";
import type { AuthenticatedRequest, SessionUser } from "../types";

const createSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  byteSize: z.number().int().min(1).max(100 * 1024 * 1024),
  kind: z.enum(["image", "video", "text", "other"]).default("image"),
  projectId: z.string().uuid().nullish(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const shareSchema = z.object({ scope: z.enum(["department", "project", "user"]), targetId: z.string().uuid() });
const eventSchema = z.object({
  eventType: z.enum([
    "asset.candidate_added", "asset.project_added", "asset.edited", "asset.reused",
    "asset.downloaded", "asset.exported", "asset.adopted", "asset.delivered",
    "asset.pending", "asset.rejected",
  ]),
  idempotencyKey: z.string().trim().min(8).max(160),
  projectId: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).superRefine((input, context) => {
  if (input.eventType === "asset.project_added" && !input.projectId) context.addIssue({ code: "custom", path: ["projectId"], message: "加入正式项目时必须选择项目" });
});
const receiptSchema = z.object({ idempotencyKey: z.string().trim().min(8).max(160), filename: z.string().trim().max(255).optional() });
const visibilitySchema = z.object({ visibility: z.enum(["private", "company"]) });
const reverseSchema = z.object({ idempotencyKey: z.string().trim().min(8).max(160), reason: z.string().trim().min(2).max(500) });

const assetSelect = `a.id,a.owner_user_id AS "ownerUserId",u.display_name AS "ownerName",a.department_id AS "departmentId",d.name AS "departmentName",a.project_id AS "projectId",p.name AS "projectName",a.task_id AS "taskId",a.filename,a.mime_type AS "mimeType",a.byte_size::int AS "byteSize",a.kind,a.source,a.operation_type AS "operationType",a.prompt,m.name AS "modelName",a.status,a.visibility_scope AS "visibilityScope",a.metadata,a.deleted_at AS "deletedAt",a.created_at AS "createdAt"`;

function accessClause(actor: SessionUser, alias = "a") {
  if (actor.role === "super_admin") return { sql: "TRUE", values: [] as unknown[] };
  const values: unknown[] = [actor.id, actor.departmentId];
  return {
    sql: `(${alias}.owner_user_id=$1 OR ${alias}.visibility_scope='company' OR (${alias}.department_id=$2 AND $2::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM asset_shares s WHERE s.asset_id=${alias}.id AND s.department_id=$2)) OR EXISTS(SELECT 1 FROM asset_shares s JOIN project_members pm ON pm.project_id=s.project_id WHERE s.asset_id=${alias}.id AND pm.user_id=$1) OR EXISTS(SELECT 1 FROM asset_shares s WHERE s.asset_id=${alias}.id AND s.user_id=$1)${actor.role === "department_admin" ? ` OR ${alias}.department_id=$2` : ""})`,
    values,
  };
}

async function withProjections(db: Database, rows: Array<Record<string, unknown>>) {
  const projections = await listAssetEvents(db, rows.map((row) => String(row.id)));
  return rows.map((row) => ({
    ...row,
    ...(projections.get(String(row.id))?.projection ?? {
      resultStatus: "unused", usabilityScore: 0, downloadCount: 0, firstDownloadedAt: null, eventCount: 0,
    }),
  }));
}

function sendAssetEventError(response: Response, error: unknown) {
  if (!(error instanceof AssetEventError)) return false;
  response.status(error.status).json({ error: error.code, message: error.message });
  return true;
}

export function createAssetsRouter(db: Database, storage: ObjectStorage) {
  const router = Router();

  router.get("/", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const access = accessClause(actor);
      const result = await db.query(
        `SELECT ${assetSelect} FROM assets a JOIN users u ON u.id=a.owner_user_id LEFT JOIN departments d ON d.id=a.department_id LEFT JOIN projects p ON p.id=a.project_id LEFT JOIN model_configs m ON m.id=a.model_config_id WHERE a.deleted_at IS NULL AND ${access.sql} ORDER BY a.created_at DESC LIMIT 2000`,
        access.values,
      );
      response.json({ assets: await withProjections(db, result.rows) });
    } catch (error) { next(error); }
  });

  router.post("/upload-request", async (request, response, next) => {
    try {
      const input = createSchema.parse(request.body);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      if (!storage.configured) {
        response.status(503).json({ error: "STORAGE_NOT_CONFIGURED", message: "公司对象存储尚未配置" });
        return;
      }
      const id = randomUUID();
      const safe = input.filename.replace(/[^A-Za-z0-9._-]/g, "_");
      const key = `users/${actor.id}/${id}/${safe}`;
      await db.query(
        `INSERT INTO assets(id,owner_user_id,department_id,project_id,object_key,filename,mime_type,byte_size,kind,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, actor.id, actor.departmentId, input.projectId ?? null, key, input.filename, input.mimeType, input.byteSize, input.kind, JSON.stringify(input.metadata)],
      );
      response.status(201).json({ assetId: id, uploadUrl: `/api/assets/${id}/upload` });
    } catch (error) { next(error); }
  });

  router.put("/:id/upload", express.raw({ type: "*/*", limit: "100mb" }), async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const result = await db.query<{ object_key: string; mime_type: string; byte_size: number }>(
        "SELECT object_key,mime_type,byte_size FROM assets WHERE id=$1 AND owner_user_id=$2 AND status='pending'",
        [request.params.id, actor.id],
      );
      const asset = result.rows[0];
      if (!asset) {
        response.status(404).json({ error: "NOT_FOUND", message: "待上传素材不存在" });
        return;
      }
      const body = request.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length !== Number(asset.byte_size)) {
        response.status(400).json({ error: "SIZE_MISMATCH", message: "上传文件大小与申请不一致" });
        return;
      }
      await storage.put(asset.object_key, body, asset.mime_type);
      await db.query("UPDATE assets SET status='ready',updated_at=now() WHERE id=$1", [request.params.id]);
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.get("/:id/content", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const access = accessClause(actor);
      const values = [request.params.id, ...access.values];
      const shifted = access.sql.replace(/\$(\d+)/g, (_, number) => `$${Number(number) + 1}`);
      const result = await db.query<{ object_key: string; mime_type: string; filename: string }>(
        `SELECT object_key,mime_type,filename FROM assets a WHERE a.id=$1 AND a.status='ready' AND a.deleted_at IS NULL AND ${shifted}`,
        values,
      );
      const asset = result.rows[0];
      if (!asset) { response.status(404).end(); return; }
      const object = await storage.get(asset.object_key);
      response.type(asset.mime_type);
      response.setHeader("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(asset.filename)}`);
      if (object.ContentLength) response.setHeader("content-length", String(object.ContentLength));
      const bytes = await object.Body?.transformToByteArray();
      response.send(Buffer.from(bytes ?? []));
    } catch (error) { next(error); }
  });

  router.get("/:id/events", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const access = accessClause(actor);
      const shifted = access.sql.replace(/\$(\d+)/g, (_, number) => `$${Number(number) + 1}`);
      const allowed = await db.query(`SELECT a.id FROM assets a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${shifted}`, [request.params.id, ...access.values]);
      if (!allowed.rows[0]) { response.status(404).json({ error: "NOT_FOUND", message: "素材不存在或无权访问" }); return; }
      const result = await listAssetEvents(db, [request.params.id]);
      response.json(result.get(request.params.id) ?? { events: [], projection: { resultStatus: "unused", usabilityScore: 0, downloadCount: 0, firstDownloadedAt: null, eventCount: 0 } });
    } catch (error) { next(error); }
  });

  router.post("/:id/events", async (request, response, next) => {
    try {
      const input = eventSchema.parse(request.body);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const eventId = await recordAssetEvent(db, { assetId: request.params.id, actor, ...input });
      const projected = await listAssetEvents(db, [request.params.id]);
      if (["asset.adopted", "asset.delivered", "asset.pending", "asset.rejected"].includes(input.eventType)) {
        await writeAudit(db, { actor, action: input.eventType, targetType: "asset", targetId: request.params.id, departmentId: actor.departmentId, result: "success", detail: { eventId, idempotencyKey: input.idempotencyKey }, ip: request.ip });
      }
      response.status(201).json({ eventId, projection: projected.get(request.params.id)!.projection });
    } catch (error) { if (!sendAssetEventError(response, error)) next(error); }
  });

  router.post("/:id/download-receipts", async (request, response, next) => {
    try {
      const input = receiptSchema.parse(request.body);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const eventId = await recordAssetEvent(db, {
        assetId: request.params.id,
        actor,
        eventType: "asset.downloaded",
        idempotencyKey: input.idempotencyKey,
        metadata: { filename: input.filename ?? null, channel: "browser-local-save" },
      });
      const projected = await listAssetEvents(db, [request.params.id]);
      response.status(201).json({ eventId, projection: projected.get(request.params.id)!.projection });
    } catch (error) { if (!sendAssetEventError(response, error)) next(error); }
  });

  router.patch("/:id/visibility", async (request, response, next) => {
    try {
      const input = visibilitySchema.parse(request.body);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const result = await db.query<{ owner_user_id: string; department_id: string | null }>("SELECT owner_user_id,department_id FROM assets WHERE id=$1 AND deleted_at IS NULL", [request.params.id]);
      const asset = result.rows[0];
      const adminCanManage = actor.role === "super_admin" || (actor.role === "department_admin" && actor.departmentId === asset?.department_id);
      if (!asset || (input.visibility === "company" ? !adminCanManage : actor.id !== asset.owner_user_id && !adminCanManage)) {
        response.status(403).json({ error: "FORBIDDEN", message: "无权修改素材共享范围" });
        return;
      }
      await db.query("UPDATE assets SET visibility_scope=$1,updated_at=now() WHERE id=$2", [input.visibility, request.params.id]);
      await writeAudit(db, { actor, action: "asset.visibility_changed", targetType: "asset", targetId: request.params.id, departmentId: asset.department_id, result: "success", detail: input, ip: request.ip });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.delete("/:id", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const scope = actor.role === "super_admin" ? "" : actor.role === "department_admin" ? "AND department_id=$2" : "AND owner_user_id=$2";
      const value = actor.role === "department_admin" ? actor.departmentId : actor.id;
      const result = await db.query<{ id: string; owner_user_id: string; department_id: string | null }>(
        `UPDATE assets SET deleted_at=now(),purge_after=now()+interval '30 days',updated_at=now() WHERE id=$1 AND deleted_at IS NULL ${scope} RETURNING id,owner_user_id,department_id`,
        scope ? [request.params.id, value] : [request.params.id],
      );
      if (!result.rows[0]) { response.status(404).end(); return; }
      await writeAudit(db, { actor, action: "asset.deleted", targetType: "asset", targetId: request.params.id, departmentId: result.rows[0].department_id, result: "success", ip: request.ip });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.post("/:id/share", async (request, response, next) => {
    try {
      const input = shareSchema.parse(request.body);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const owned = await db.query<{ department_id: string | null }>("SELECT department_id FROM assets WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL", [request.params.id, actor.id]);
      if (!owned.rows[0]) { response.status(403).json({ error: "FORBIDDEN", message: "只有素材所有者可以主动共享" }); return; }
      if (input.scope === "department" && input.targetId !== actor.departmentId) { response.status(403).json({ error: "FORBIDDEN", message: "只能共享到本人所在部门" }); return; }
      const columns = { department: ["department_id", input.targetId], project: ["project_id", input.targetId], user: ["user_id", input.targetId] } as const;
      const [column, value] = columns[input.scope];
      await db.query(`INSERT INTO asset_shares(asset_id,scope,${column},created_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [request.params.id, input.scope, value, actor.id]);
      await writeAudit(db, { actor, action: "asset.shared", targetType: "asset", targetId: request.params.id, departmentId: owned.rows[0].department_id, result: "success", detail: input, ip: request.ip });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.delete("/:id/share", async (request, response, next) => {
    try {
      const input = shareSchema.parse(request.body);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const owned = await db.query<{ department_id: string | null }>("SELECT department_id FROM assets WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL", [request.params.id, actor.id]);
      if (!owned.rows[0]) { response.status(403).json({ error: "FORBIDDEN", message: "只有素材所有者可以取消共享" }); return; }
      const columns = { department: "department_id", project: "project_id", user: "user_id" } as const;
      await db.query(`DELETE FROM asset_shares WHERE asset_id=$1 AND scope=$2 AND ${columns[input.scope]}=$3`, [request.params.id, input.scope, input.targetId]);
      await writeAudit(db, { actor, action: "asset.unshared", targetType: "asset", targetId: request.params.id, departmentId: owned.rows[0].department_id, result: "success", detail: input, ip: request.ip });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  return router;
}

export function createAdminAssetsRouter(db: Database) {
  const router = Router();
  router.use(requireRole("super_admin", "department_admin"));
  router.get("/", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const values: unknown[] = [];
      const where = actor.role === "department_admin" ? (values.push(actor.departmentId), "WHERE a.department_id=$1") : "";
      const result = await db.query(`SELECT ${assetSelect} FROM assets a JOIN users u ON u.id=a.owner_user_id LEFT JOIN departments d ON d.id=a.department_id LEFT JOIN projects p ON p.id=a.project_id LEFT JOIN model_configs m ON m.id=a.model_config_id ${where} ORDER BY a.created_at DESC LIMIT 5000`, values);
      response.json({ assets: await withProjections(db, result.rows) });
    } catch (error) { next(error); }
  });
  router.post("/:assetId/events/:eventId/reverse", async (request, response, next) => {
    try {
      const input = reverseSchema.parse(request.body);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const reverseEventId = await reverseAssetEvent(db, actor, request.params.assetId, request.params.eventId, input.idempotencyKey, input.reason);
      const projected = await listAssetEvents(db, [request.params.assetId]);
      await writeAudit(db, { actor, action: "asset.event_reversed", targetType: "asset", targetId: request.params.assetId, departmentId: actor.departmentId, result: "success", detail: { sourceEventId: request.params.eventId, reverseEventId, reason: input.reason }, ip: request.ip });
      response.status(201).json({ eventId: reverseEventId, projection: projected.get(request.params.assetId)?.projection });
    } catch (error) { if (!sendAssetEventError(response, error)) next(error); }
  });
  return router;
}
