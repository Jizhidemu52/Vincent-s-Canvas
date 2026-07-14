import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { Database } from "../db";
import { withTransaction } from "../db-transaction";
import { canManageGroup, isGroupLeader } from "../group-scope";
import { assertModuleEnabled } from "../module-flags";
import {
  promptSnapshotSchema,
  PromptTemplateError,
  resolveCurrentPromptPricing,
  type PromptSnapshot,
} from "../prompt-templates";
import type { AuthenticatedRequest, SessionUser } from "../types";

const listSchema = z.object({
  scope: z.enum(["personal", "team", "public"]).default("personal"),
  query: z.string().trim().max(200).default(""),
  category: z.string().trim().max(80).optional(),
  tag: z.string().trim().max(40).optional(),
  favorite: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  sort: z.enum(["updated", "recent", "used"]).default("updated"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
  groupId: z.string().uuid().optional(),
});
const reviewSchema = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(1_000).default("") });
const requestSchema = z.object({ requestId: z.string().trim().min(8).max(160) });
const resolveSchema = requestSchema.extend({ mode: z.enum(["fill", "fill_and_generate"]).default("fill") });
const favoriteSchema = z.object({ favorite: z.boolean() });
const publicCreateSchema = promptSnapshotSchema;

type Queryable = Database | PoolClient;
type TemplateRow = {
  id: string; scope: "personal" | "team" | "public"; ownerUserId: string | null; groupId: string | null;
  departmentId: string | null; currentVersionId: string; status: string; createdBy: string;
  version: number; title: string; prompt: string; targetTool: PromptSnapshot["targetTool"];
  modelConfigId: string | null; modelSnapshot: Record<string, unknown>; parameters: Record<string, unknown>;
  category: string; tags: string[]; notes: string; sourceTaskId: string | null; sourceAssetId: string | null;
  createdAt: string; updatedAt: string; favorite: boolean; useCount: number; lastUsedAt: string | null;
  referenceAssetIds: string[];
};

const templateSelect = `t.id,t.scope,t.owner_user_id AS "ownerUserId",t.group_id AS "groupId",
  t.department_id AS "departmentId",t.current_version_id AS "currentVersionId",t.status,t.created_by AS "createdBy",
  v.version,v.title,v.prompt,v.target_tool AS "targetTool",v.model_config_id AS "modelConfigId",
  v.model_snapshot AS "modelSnapshot",v.parameters,v.category,v.tags,v.notes,
  v.source_task_id AS "sourceTaskId",v.source_asset_id AS "sourceAssetId",
  t.created_at AS "createdAt",t.updated_at AS "updatedAt",coalesce(s.favorite,false) AS favorite,
  coalesce(s.use_count,0) AS "useCount",s.last_used_at AS "lastUsedAt",
  coalesce((SELECT array_agg(r.asset_id ORDER BY r.position) FROM prompt_template_reference_assets r WHERE r.version_id=v.id),'{}'::uuid[]) AS "referenceAssetIds"`;

export function createPromptTemplatesRouter(db: Database) {
  const router = Router();
  router.use(async (request, _response, next) => {
    try { await assertModuleEnabled(db, "prompts"); next(); } catch (error) { next(error); }
  });

  router.get("/", async (request, response, next) => {
    try {
      const actor = auth(request);
      const input = listSchema.parse(request.query);
      const { sql: scopeSql, values } = listScope(actor, input.scope, input.groupId);
      const clauses = [scopeSql, "t.deleted_at IS NULL", "t.status='active'", "t.current_version_id IS NOT NULL"];
      if (input.query) { values.push(`%${input.query}%`); clauses.push(`(v.title ILIKE $${values.length} OR v.prompt ILIKE $${values.length} OR v.category ILIKE $${values.length})`); }
      if (input.category) { values.push(input.category); clauses.push(`v.category=$${values.length}`); }
      if (input.tag) { values.push(input.tag); clauses.push(`$${values.length}=ANY(v.tags)`); }
      if (input.favorite !== undefined) { values.push(input.favorite); clauses.push(`coalesce(s.favorite,false)=$${values.length}`); }
      const order = input.sort === "recent" ? "s.last_used_at DESC NULLS LAST,t.updated_at DESC" : input.sort === "used" ? "coalesce(s.use_count,0) DESC,t.updated_at DESC" : "t.updated_at DESC";
      const countValues = [...values];
      const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM prompt_templates t JOIN prompt_template_versions v ON v.id=t.current_version_id LEFT JOIN prompt_template_user_stats s ON s.template_id=t.id AND s.user_id=$1 WHERE ${clauses.join(" AND ")}`, countValues);
      values.push(input.pageSize, (input.page - 1) * input.pageSize);
      const rows = await db.query<TemplateRow>(`SELECT ${templateSelect} FROM prompt_templates t JOIN prompt_template_versions v ON v.id=t.current_version_id LEFT JOIN prompt_template_user_stats s ON s.template_id=t.id AND s.user_id=$1 WHERE ${clauses.join(" AND ")} ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
      response.json({ templates: rows.rows, total: count.rows[0]?.total ?? 0, page: input.page, pageSize: input.pageSize });
    } catch (error) { next(error); }
  });

  router.post("/", async (request, response, next) => {
    try {
      const actor = auth(request); const snapshot = promptSnapshotSchema.parse(request.body);
      const template = await createPersonalTemplate(db, actor, snapshot);
      await writeAudit(db, { actor, action: "prompt.personal_created", targetType: "prompt_template", targetId: template.id, departmentId: actor.departmentId, result: "success", ip: request.ip });
      response.status(201).json({ template });
    } catch (error) { next(error); }
  });

  router.post("/from-task/:taskId", async (request, response, next) => {
    try {
      const actor = auth(request);
      const result = await db.query<{ id: string; prompt: string; operationType: string; modelConfigId: string | null; parameters: Record<string, unknown> }>(
        `SELECT id,prompt,operation_type AS "operationType",model_config_id AS "modelConfigId",parameters FROM tasks WHERE id=$1 AND user_id=$2 AND status='success'`, [request.params.taskId, actor.id],
      );
      const task = result.rows[0];
      if (!task) throw notFound();
      const assets = await db.query<{ id: string }>("SELECT id FROM assets WHERE task_id=$1 AND owner_user_id=$2 AND deleted_at IS NULL ORDER BY created_at LIMIT 20", [task.id, actor.id]);
      const snapshot = promptSnapshotSchema.parse({ title: titleFromPrompt(task.prompt), prompt: task.prompt, targetTool: toolFromOperation(task.operationType, task.parameters), modelConfigId: task.modelConfigId, parameters: task.parameters, referenceAssetIds: assets.rows.map((item) => item.id), sourceTaskId: task.id });
      const template = await createPersonalTemplate(db, actor, snapshot);
      await writeAudit(db, { actor, action: "prompt.saved_from_task", targetType: "prompt_template", targetId: template.id, departmentId: actor.departmentId, result: "success", detail: { taskId: task.id }, ip: request.ip });
      response.status(201).json({ template });
    } catch (error) { next(error); }
  });

  router.post("/from-asset/:assetId", async (request, response, next) => {
    try {
      const actor = auth(request);
      const result = await db.query<{ id: string; prompt: string; operationType: string | null; modelConfigId: string | null; metadata: Record<string, unknown> }>(
        `SELECT id,coalesce(prompt,'') AS prompt,operation_type AS "operationType",model_config_id AS "modelConfigId",metadata FROM assets WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL AND status='ready'`, [request.params.assetId, actor.id],
      );
      const asset = result.rows[0];
      if (!asset?.prompt.trim()) throw new PromptTemplateError("PROMPT_UNAVAILABLE", "该素材没有可保存的提示词", 400);
      const snapshot = promptSnapshotSchema.parse({ title: titleFromPrompt(asset.prompt), prompt: asset.prompt, targetTool: toolFromOperation(asset.operationType ?? "image_generation", asset.metadata), modelConfigId: asset.modelConfigId, parameters: asset.metadata, referenceAssetIds: [asset.id], sourceAssetId: asset.id });
      const template = await createPersonalTemplate(db, actor, snapshot);
      await writeAudit(db, { actor, action: "prompt.saved_from_asset", targetType: "prompt_template", targetId: template.id, departmentId: actor.departmentId, result: "success", detail: { assetId: asset.id }, ip: request.ip });
      response.status(201).json({ template });
    } catch (error) { next(error); }
  });

  router.patch("/:id", async (request, response, next) => {
    try {
      const actor = auth(request); const snapshot = promptSnapshotSchema.parse(request.body);
      const template = await withTransaction(db, async (client) => {
        const current = await client.query<{ id: string }>("SELECT id FROM prompt_templates WHERE id=$1 AND scope='personal' AND owner_user_id=$2 AND deleted_at IS NULL FOR UPDATE", [request.params.id, actor.id]);
        if (!current.rows[0]) throw notFound();
        await assertAccessibleReferences(client, actor, snapshot.referenceAssetIds);
        const versionId = await insertVersion(client, request.params.id, actor.id, snapshot);
        await client.query("UPDATE prompt_templates SET current_version_id=$1,updated_at=now() WHERE id=$2", [versionId, request.params.id]);
        return loadTemplate(client, actor, request.params.id);
      });
      await writeAudit(db, { actor, action: "prompt.personal_updated", targetType: "prompt_template", targetId: request.params.id, departmentId: actor.departmentId, result: "success", ip: request.ip });
      response.json({ template });
    } catch (error) { next(error); }
  });

  router.post("/:id/copy", async (request, response, next) => {
    try {
      const actor = auth(request); const source = await loadTemplate(db, actor, request.params.id);
      const snapshot = snapshotFromRow(source, `${source.title} 副本`);
      const template = await createPersonalTemplate(db, actor, snapshot);
      await writeAudit(db, { actor, action: "prompt.copied", targetType: "prompt_template", targetId: template.id, departmentId: actor.departmentId, result: "success", detail: { sourceTemplateId: source.id }, ip: request.ip });
      response.status(201).json({ template });
    } catch (error) { next(error); }
  });

  router.delete("/:id", async (request, response, next) => {
    try {
      const actor = auth(request);
      const result = await db.query("UPDATE prompt_templates SET deleted_at=now(),status='archived',updated_at=now() WHERE id=$1 AND scope='personal' AND owner_user_id=$2 AND deleted_at IS NULL RETURNING id", [request.params.id, actor.id]);
      if (!result.rows[0]) throw notFound();
      await writeAudit(db, { actor, action: "prompt.personal_deleted", targetType: "prompt_template", targetId: request.params.id, departmentId: actor.departmentId, result: "success", ip: request.ip });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.put("/:id/favorite", async (request, response, next) => {
    try {
      const actor = auth(request); const input = favoriteSchema.parse(request.body);
      await loadTemplate(db, actor, request.params.id);
      await db.query(`INSERT INTO prompt_template_user_stats(template_id,user_id,favorite) VALUES($1,$2,$3)
        ON CONFLICT(template_id,user_id) DO UPDATE SET favorite=EXCLUDED.favorite,updated_at=now()`, [request.params.id, actor.id, input.favorite]);
      response.json({ favorite: input.favorite });
    } catch (error) { next(error); }
  });

  router.post("/:id/submit", async (request, response, next) => {
    try {
      const actor = auth(request); const input = requestSchema.parse(request.body);
      if (actor.role !== "designer" || !actor.groupId || !actor.departmentId) throw new PromptTemplateError("GROUP_REQUIRED", "加入小组后才能提交团队模板", 400);
      const source = await loadTemplate(db, actor, request.params.id);
      if (source.scope !== "personal" || source.ownerUserId !== actor.id) throw notFound();
      await assertPublishableReferences(db, source.currentVersionId, "team", actor.departmentId);
      const inserted = await db.query(`INSERT INTO prompt_template_submissions(request_id,source_template_id,source_version_id,submitted_by,target_group_id,target_department_id)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(submitted_by,request_id) DO NOTHING RETURNING id,status,created_at AS "createdAt"`, [input.requestId, source.id, source.currentVersionId, actor.id, actor.groupId, actor.departmentId]);
      const submission = inserted.rows[0] ?? (await db.query(`SELECT id,status,created_at AS "createdAt" FROM prompt_template_submissions WHERE submitted_by=$1 AND request_id=$2`, [actor.id, input.requestId])).rows[0];
      await writeAudit(db, { actor, action: "prompt.team_submitted", targetType: "prompt_submission", targetId: submission.id, departmentId: actor.departmentId, result: "success", detail: { templateId: source.id, versionId: source.currentVersionId, groupId: actor.groupId, duplicate: !inserted.rows[0] }, ip: request.ip });
      response.status(inserted.rows[0] ? 201 : 200).json({ submission: { ...submission, duplicate: !inserted.rows[0] } });
    } catch (error) { next(error); }
  });

  router.get("/review/submissions", async (request, response, next) => {
    try {
      const actor = auth(request); const values: unknown[] = [];
      let scope = "";
      if (actor.role === "department_admin") { values.push(actor.departmentId); scope = "WHERE ps.target_department_id=$1"; }
      else if (isGroupLeader(actor)) { values.push(actor.groupId); scope = "WHERE ps.target_group_id=$1"; }
      else if (actor.role === "designer") { values.push(actor.id); scope = "WHERE ps.submitted_by=$1"; }
      const result = await db.query(`SELECT ps.id,ps.status,ps.review_note AS "reviewNote",ps.created_at AS "createdAt",ps.reviewed_at AS "reviewedAt",
        ps.source_template_id AS "sourceTemplateId",ps.source_version_id AS "sourceVersionId",ps.target_group_id AS "targetGroupId",
        u.display_name AS "submitterName",v.title,v.prompt FROM prompt_template_submissions ps JOIN users u ON u.id=ps.submitted_by
        JOIN prompt_template_versions v ON v.id=ps.source_version_id ${scope} ORDER BY ps.created_at DESC LIMIT 500`, values);
      response.json({ submissions: result.rows });
    } catch (error) { next(error); }
  });

  router.post("/review/submissions/:id", async (request, response, next) => {
    try {
      const actor = auth(request); const input = reviewSchema.parse(request.body);
      const submission = await withTransaction(db, async (client) => {
        const locked = await client.query<{ id: string; status: string; sourceTemplateId: string; sourceVersionId: string; targetGroupId: string; targetDepartmentId: string }>(
          `SELECT id,status,source_template_id AS "sourceTemplateId",source_version_id AS "sourceVersionId",target_group_id AS "targetGroupId",target_department_id AS "targetDepartmentId"
             FROM prompt_template_submissions WHERE id=$1 FOR UPDATE`, [request.params.id],
        );
        const row = locked.rows[0];
        if (!row) throw notFound();
        if (!(await canManageGroup(client, actor, row.targetGroupId))) throw new PromptTemplateError("FORBIDDEN", "无权审核该小组的模板", 403);
        if (row.status !== "pending") throw new PromptTemplateError("SUBMISSION_ALREADY_REVIEWED", "该提交已经审核", 409);
        let publication: { templateId: string; versionId: string } | null = null;
        if (input.decision === "approve") publication = await publishVersion(client, row.sourceTemplateId, row.sourceVersionId, actor.id, "team", row.targetGroupId, row.targetDepartmentId);
        await client.query(`UPDATE prompt_template_submissions SET status=$1,reviewer_user_id=$2,review_note=$3,reviewed_at=now(),published_template_id=$4,published_version_id=$5 WHERE id=$6`,
          [input.decision === "approve" ? "approved" : "rejected", actor.id, input.note, publication?.templateId ?? null, publication?.versionId ?? null, row.id]);
        return { ...row, status: input.decision === "approve" ? "approved" : "rejected", publication };
      });
      await writeAudit(db, { actor, action: `prompt.team_${submission.status}`, targetType: "prompt_submission", targetId: submission.id, departmentId: submission.targetDepartmentId, result: "success", detail: { note: input.note, groupId: submission.targetGroupId, publication: submission.publication }, ip: request.ip });
      response.json({ submission });
    } catch (error) { next(error); }
  });

  router.post("/:id/promote-public", async (request, response, next) => {
    try {
      const actor = auth(request); if (actor.role !== "super_admin") throw new PromptTemplateError("FORBIDDEN", "只有超级管理员可以发布公共模板", 403);
      const input = requestSchema.parse(request.body); const source = await loadTemplate(db, actor, request.params.id);
      if (source.scope !== "team") throw new PromptTemplateError("INVALID_SCOPE", "只有团队模板可以提升为公共模板", 400);
      await assertPublishableReferences(db, source.currentVersionId, "public", null);
      const publication = await withTransaction(db, async (client) => {
        const existing = await client.query<{ templateId: string; versionId: string }>(`SELECT published_template_id AS "templateId",published_version_id AS "versionId" FROM prompt_publication_requests WHERE actor_user_id=$1 AND request_id=$2`, [actor.id, input.requestId]);
        if (existing.rows[0]) return { ...existing.rows[0], duplicate: true };
        const published = await publishVersion(client, source.id, source.currentVersionId, actor.id, "public", null, null);
        await client.query(`INSERT INTO prompt_publication_requests(request_id,actor_user_id,source_template_id,source_version_id,published_template_id,published_version_id) VALUES($1,$2,$3,$4,$5,$6)`, [input.requestId, actor.id, source.id, source.currentVersionId, published.templateId, published.versionId]);
        return { ...published, duplicate: false };
      });
      await writeAudit(db, { actor, action: "prompt.public_published", targetType: "prompt_template", targetId: publication.templateId, result: "success", detail: { requestId: input.requestId, sourceTemplateId: source.id, versionId: publication.versionId }, ip: request.ip });
      response.status(publication.duplicate ? 200 : 201).json({ publication });
    } catch (error) { next(error); }
  });

  router.post("/:id/resolve", async (request, response, next) => {
    try {
      const actor = auth(request); const input = resolveSchema.parse(request.body); const template = await loadTemplate(db, actor, request.params.id);
      const pricing = await resolveCurrentPromptPricing(db, { historicalModelConfigId: template.modelConfigId, targetTool: template.targetTool, parameters: template.parameters });
      const rawToken = randomBytes(32).toString("base64url"); const tokenHash = hashToken(rawToken);
      const result = await withTransaction(db, async (client) => {
        const existing = await client.query<{ id: string }>("SELECT id FROM prompt_template_usage_events WHERE user_id=$1 AND request_id=$2", [actor.id, input.requestId]);
        if (!existing.rows[0]) {
          await client.query(`INSERT INTO prompt_template_usage_events(request_id,template_id,version_id,user_id,mode,resolved_model_config_id) VALUES($1,$2,$3,$4,$5,$6)`, [input.requestId, template.id, template.currentVersionId, actor.id, input.mode, pricing.selectedModel?.id ?? null]);
          await client.query(`INSERT INTO prompt_template_user_stats(template_id,user_id,use_count,last_used_at) VALUES($1,$2,1,now())
            ON CONFLICT(template_id,user_id) DO UPDATE SET use_count=prompt_template_user_stats.use_count+1,last_used_at=now(),updated_at=now()`, [template.id, actor.id]);
        }
        await client.query(`INSERT INTO prompt_reuse_tokens(token_hash,user_id,template_id,version_id,mode,resolved_model_config_id,resolution,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')`, [tokenHash, actor.id, template.id, template.currentVersionId, input.mode, pricing.selectedModel?.id ?? null, JSON.stringify(pricing)]);
        return { duplicate: Boolean(existing.rows[0]) };
      });
      await writeAudit(db, { actor, action: "prompt.reused", targetType: "prompt_template", targetId: template.id, departmentId: actor.departmentId, result: "success", detail: { mode: input.mode, modelChanged: pricing.modelChanged, duplicate: result.duplicate }, ip: request.ip });
      response.json({ reuseToken: rawToken, expiresInSeconds: 600, mode: input.mode, pricing });
    } catch (error) { next(error); }
  });

  router.get("/reuse/:token", async (request, response, next) => {
    try {
      const actor = auth(request); const tokenHash = hashToken(request.params.token);
      const token = await db.query<{ id: string; templateId: string; versionId: string; mode: string; resolution: Record<string, unknown> }>(
        `UPDATE prompt_reuse_tokens SET consumed_at=coalesce(consumed_at,now()) WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()
          RETURNING id,template_id AS "templateId",version_id AS "versionId",mode,resolution`, [tokenHash, actor.id],
      );
      if (!token.rows[0]) throw new PromptTemplateError("REUSE_TOKEN_INVALID", "复用链接已失效，请重新点击模板", 404);
      const template = await loadTemplate(db, actor, token.rows[0].templateId, token.rows[0].versionId);
      const accessible = await accessibleReferences(db, actor, template.referenceAssetIds);
      response.json({ template: { ...template, referenceAssetIds: accessible }, mode: token.rows[0].mode, pricing: token.rows[0].resolution, warnings: accessible.length === template.referenceAssetIds.length ? [] : ["部分参考图已删除或当前无权访问"] });
    } catch (error) { next(error); }
  });

  return router;
}

export function createAdminPromptTemplatesRouter(db: Database) {
  const router = Router();
  router.use(async (request, response, next) => {
    const actor = auth(request);
    if (actor.role === "designer") { response.status(403).json({ error: "FORBIDDEN", message: "管理员接口不可用" }); return; }
    try { await assertModuleEnabled(db, "prompts"); next(); } catch (error) { next(error); }
  });
  router.get("/:id/audit-view", async (request, response, next) => {
    try {
      const actor = auth(request);
      const values: unknown[] = [request.params.id];
      const scope = actor.role === "super_admin" ? "" : (values.push(actor.departmentId), "AND t.department_id=$2");
      const result = await db.query<TemplateRow>(`SELECT ${templateSelect} FROM prompt_templates t JOIN prompt_template_versions v ON v.id=t.current_version_id LEFT JOIN prompt_template_user_stats s ON s.template_id=t.id AND s.user_id=$${values.length + 1} WHERE t.id=$1 AND t.scope='personal' ${scope}`, [...values, actor.id]);
      if (!result.rows[0]) throw notFound();
      await writeAudit(db, { actor, action: "prompt.personal_audit_viewed", targetType: "prompt_template", targetId: request.params.id, departmentId: result.rows[0].departmentId, result: "success", ip: request.ip });
      response.json({ template: result.rows[0] });
    } catch (error) { next(error); }
  });
  router.post("/public", async (request, response, next) => {
    try {
      const actor = auth(request); if (actor.role !== "super_admin") throw new PromptTemplateError("FORBIDDEN", "只有超级管理员可以创建公共模板", 403);
      const snapshot = publicCreateSchema.parse(request.body); await assertPublishableAssetIds(db, snapshot.referenceAssetIds, "public", null);
      const template = await withTransaction(db, async (client) => createScopedTemplate(client, actor.id, snapshot, "public", null, null, null));
      await writeAudit(db, { actor, action: "prompt.public_created", targetType: "prompt_template", targetId: template.id, result: "success", ip: request.ip });
      response.status(201).json({ template });
    } catch (error) { next(error); }
  });
  router.patch("/public/:id", async (request, response, next) => {
    try {
      const actor = auth(request); if (actor.role !== "super_admin") throw new PromptTemplateError("FORBIDDEN", "只有超级管理员可以修改公共模板", 403);
      const snapshot = promptSnapshotSchema.parse(request.body); await assertPublishableAssetIds(db, snapshot.referenceAssetIds, "public", null);
      const template = await withTransaction(db, async (client) => {
        const current = await client.query("SELECT id FROM prompt_templates WHERE id=$1 AND scope='public' AND deleted_at IS NULL FOR UPDATE", [request.params.id]);
        if (!current.rows[0]) throw notFound();
        const versionId = await insertVersion(client, request.params.id, actor.id, snapshot);
        await client.query("UPDATE prompt_templates SET current_version_id=$1,status='active',updated_at=now() WHERE id=$2", [versionId, request.params.id]);
        return { id: request.params.id, currentVersionId: versionId };
      });
      await writeAudit(db, { actor, action: "prompt.public_updated", targetType: "prompt_template", targetId: template.id, result: "success", detail: { versionId: template.currentVersionId }, ip: request.ip });
      response.json({ template });
    } catch (error) { next(error); }
  });
  router.post("/:id/archive", async (request, response, next) => {
    try {
      const actor = auth(request);
      const values: unknown[] = [request.params.id];
      let scope = "AND scope IN ('team','public')";
      if (actor.role === "department_admin") { values.push(actor.departmentId); scope = "AND scope='team' AND department_id=$2"; }
      else if (actor.role !== "super_admin") throw new PromptTemplateError("FORBIDDEN", "无权下架该模板", 403);
      const result = await db.query<{ id: string; departmentId: string | null }>(`UPDATE prompt_templates SET status='archived',updated_at=now() WHERE id=$1 AND deleted_at IS NULL ${scope} RETURNING id,department_id AS "departmentId"`, values);
      if (!result.rows[0]) throw notFound();
      await writeAudit(db, { actor, action: "prompt.shared_archived", targetType: "prompt_template", targetId: request.params.id, departmentId: result.rows[0].departmentId, result: "success", ip: request.ip });
      response.json({ status: "archived" });
    } catch (error) { next(error); }
  });
  return router;
}

function auth(request: Express.Request) { return (request as unknown as AuthenticatedRequest).auth; }

function listScope(actor: SessionUser, scope: "personal" | "team" | "public", requestedGroupId?: string) {
  const values: unknown[] = [actor.id];
  if (scope === "personal") { values.push(actor.id); return { sql: "t.scope='personal' AND t.owner_user_id=$2", values }; }
  if (scope === "public") return { sql: "t.scope='public'", values };
  if (actor.role === "super_admin") {
    if (requestedGroupId) { values.push(requestedGroupId); return { sql: "t.scope='team' AND t.group_id=$2", values }; }
    return { sql: "t.scope='team'", values };
  }
  if (actor.role === "department_admin") {
    values.push(actor.departmentId); let sql = "t.scope='team' AND t.department_id=$2";
    if (requestedGroupId) { values.push(requestedGroupId); sql += " AND t.group_id=$3"; }
    return { sql, values };
  }
  values.push(actor.groupId); return { sql: "t.scope='team' AND t.group_id=$2 AND $2::uuid IS NOT NULL", values };
}

async function createPersonalTemplate(db: Database, actor: SessionUser, snapshot: PromptSnapshot) {
  return withTransaction(db, async (client) => {
    await assertAccessibleReferences(client, actor, snapshot.referenceAssetIds);
    return createScopedTemplate(client, actor.id, snapshot, "personal", actor.id, null, actor.departmentId);
  });
}

async function createScopedTemplate(client: PoolClient, actorId: string, snapshot: PromptSnapshot, scope: "personal" | "team" | "public", ownerId: string | null, groupId: string | null, departmentId: string | null, sourceTemplateId: string | null = null) {
  const row = await client.query<{ id: string }>(`INSERT INTO prompt_templates(scope,owner_user_id,group_id,department_id,source_template_id,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [scope, ownerId, groupId, departmentId, sourceTemplateId, actorId]);
  const versionId = await insertVersion(client, row.rows[0]!.id, actorId, snapshot);
  await client.query("UPDATE prompt_templates SET current_version_id=$1 WHERE id=$2", [versionId, row.rows[0]!.id]);
  return { id: row.rows[0]!.id, currentVersionId: versionId };
}

async function insertVersion(client: Queryable, templateId: string, actorId: string, snapshot: PromptSnapshot) {
  const modelSnapshot = snapshot.modelConfigId ? await client.query(`SELECT id,name,model_id AS "modelId",capabilities FROM model_configs WHERE id=$1`, [snapshot.modelConfigId]) : { rows: [] };
  if (snapshot.modelConfigId && !modelSnapshot.rows[0]) throw new PromptTemplateError("MODEL_NOT_FOUND", "所选模型不存在", 400);
  const version = await client.query<{ id: string }>(`INSERT INTO prompt_template_versions(template_id,version,title,prompt,target_tool,model_config_id,model_snapshot,parameters,category,tags,notes,source_task_id,source_asset_id,created_by)
    SELECT $1,coalesce(max(version),0)+1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13 FROM prompt_template_versions WHERE template_id=$1 RETURNING id`,
    [templateId, snapshot.title, snapshot.prompt, snapshot.targetTool, snapshot.modelConfigId ?? null, JSON.stringify(modelSnapshot.rows[0] ?? {}), JSON.stringify(snapshot.parameters), snapshot.category, snapshot.tags, snapshot.notes, snapshot.sourceTaskId ?? null, snapshot.sourceAssetId ?? null, actorId]);
  for (const [position, assetId] of snapshot.referenceAssetIds.entries()) await client.query("INSERT INTO prompt_template_reference_assets(version_id,asset_id,position) VALUES($1,$2,$3)", [version.rows[0]!.id, assetId, position]);
  return version.rows[0]!.id;
}

async function loadTemplate(db: Queryable, actor: SessionUser, id: string, versionId?: string) {
  const values: unknown[] = [actor.id, id];
  const access = templateAccess(actor, values);
  if (versionId) values.push(versionId);
  const versionJoin = versionId ? `JOIN prompt_template_versions v ON v.template_id=t.id AND v.id=$${values.length}` : "JOIN prompt_template_versions v ON v.id=t.current_version_id";
  const result = await db.query<TemplateRow>(`SELECT ${templateSelect} FROM prompt_templates t ${versionJoin} LEFT JOIN prompt_template_user_stats s ON s.template_id=t.id AND s.user_id=$1 WHERE t.id=$2 AND t.deleted_at IS NULL AND (${access})`, values);
  if (!result.rows[0]) throw notFound();
  return result.rows[0];
}

function templateAccess(actor: SessionUser, values: unknown[]) {
  const personal = "(t.scope='personal' AND t.owner_user_id=$1)";
  const publicScope = "t.scope='public'";
  if (actor.role === "super_admin") return `${personal} OR t.scope='team' OR ${publicScope}`;
  if (actor.role === "department_admin") { values.push(actor.departmentId); return `${personal} OR (t.scope='team' AND t.department_id=$${values.length}) OR ${publicScope}`; }
  values.push(actor.groupId); return `${personal} OR (t.scope='team' AND t.group_id=$${values.length} AND $${values.length}::uuid IS NOT NULL) OR ${publicScope}`;
}

async function publishVersion(client: PoolClient, sourceTemplateId: string, sourceVersionId: string, actorId: string, scope: "team" | "public", groupId: string | null, departmentId: string | null) {
  await client.query("SELECT id FROM prompt_templates WHERE id=$1 FOR UPDATE", [sourceTemplateId]);
  const existing = await client.query<{ id: string }>(`SELECT id FROM prompt_templates WHERE scope=$1 AND source_template_id=$2 AND group_id IS NOT DISTINCT FROM $3::uuid AND deleted_at IS NULL FOR UPDATE`, [scope, sourceTemplateId, groupId]);
  let templateId = existing.rows[0]?.id;
  if (!templateId) {
    const created = await client.query<{ id: string }>(`INSERT INTO prompt_templates(scope,group_id,department_id,source_template_id,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id`, [scope, groupId, departmentId, sourceTemplateId, actorId]);
    templateId = created.rows[0]!.id;
  }
  const version = await client.query<{ id: string }>(`INSERT INTO prompt_template_versions(template_id,version,title,prompt,target_tool,model_config_id,model_snapshot,parameters,category,tags,notes,source_task_id,source_asset_id,created_by)
    SELECT $1,(SELECT coalesce(max(version),0)+1 FROM prompt_template_versions WHERE template_id=$1),title,prompt,target_tool,model_config_id,model_snapshot,parameters,category,tags,notes,source_task_id,source_asset_id,$2 FROM prompt_template_versions WHERE id=$3 RETURNING id`, [templateId, actorId, sourceVersionId]);
  await client.query("INSERT INTO prompt_template_reference_assets(version_id,asset_id,position) SELECT $1,asset_id,position FROM prompt_template_reference_assets WHERE version_id=$2", [version.rows[0]!.id, sourceVersionId]);
  await client.query("UPDATE prompt_templates SET current_version_id=$1,status='active',updated_at=now() WHERE id=$2", [version.rows[0]!.id, templateId]);
  return { templateId, versionId: version.rows[0]!.id };
}

async function assertAccessibleReferences(db: Queryable, actor: SessionUser, ids: string[]) {
  if (!ids.length) return;
  const accessible = await accessibleReferences(db, actor, ids);
  if (accessible.length !== ids.length) throw new PromptTemplateError("REFERENCE_UNAVAILABLE", "部分参考图不存在或当前无权访问", 400);
}

async function accessibleReferences(db: Queryable, actor: SessionUser, ids: string[]) {
  if (!ids.length) return [];
  const values: unknown[] = [ids, actor.id, actor.departmentId];
  let access = `a.owner_user_id=$2 OR a.visibility_scope='company' OR (a.department_id=$3 AND $3::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM asset_shares s WHERE s.asset_id=a.id AND s.department_id=$3)) OR EXISTS(SELECT 1 FROM asset_shares s WHERE s.asset_id=a.id AND s.user_id=$2) OR EXISTS(SELECT 1 FROM asset_shares s JOIN project_members pm ON pm.project_id=s.project_id WHERE s.asset_id=a.id AND pm.user_id=$2)`;
  if (actor.role === "super_admin") access = "TRUE";
  else if (actor.role === "department_admin") access += " OR a.department_id=$3";
  else if (isGroupLeader(actor)) { values.push(actor.groupId); access += ` OR EXISTS(SELECT 1 FROM group_memberships gm WHERE gm.group_id=$4 AND gm.user_id=a.owner_user_id AND gm.effective_at<=a.created_at AND (gm.ended_at IS NULL OR gm.ended_at>a.created_at))`; }
  const result = await db.query<{ id: string }>(`SELECT a.id FROM assets a WHERE a.id=ANY($1::uuid[]) AND a.deleted_at IS NULL AND a.status='ready' AND (${access})`, values);
  return result.rows.map((item) => item.id);
}

async function assertPublishableReferences(db: Queryable, versionId: string, scope: "team" | "public", departmentId: string | null) {
  const refs = await db.query<{ assetId: string }>("SELECT asset_id AS \"assetId\" FROM prompt_template_reference_assets WHERE version_id=$1", [versionId]);
  return assertPublishableAssetIds(db, refs.rows.map((item) => item.assetId), scope, departmentId);
}

async function assertPublishableAssetIds(db: Queryable, ids: string[], scope: "team" | "public", departmentId: string | null) {
  if (!ids.length) return;
  const result = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM assets a WHERE a.id=ANY($1::uuid[]) AND a.deleted_at IS NULL AND a.status='ready' AND (a.visibility_scope='company' ${scope === "team" ? "OR EXISTS(SELECT 1 FROM asset_shares s WHERE s.asset_id=a.id AND s.department_id=$2::uuid)" : ""})`, scope === "team" ? [ids, departmentId] : [ids]);
  if (result.rows[0]?.count !== ids.length) throw new PromptTemplateError("REFERENCE_NOT_SHARED", scope === "team" ? "提交团队模板前，请先将参考图共享到本部门" : "发布公共模板前，参考图必须设为公司可见", 400);
}

function snapshotFromRow(row: TemplateRow, title = row.title): PromptSnapshot {
  return promptSnapshotSchema.parse({ title, prompt: row.prompt, targetTool: row.targetTool, modelConfigId: row.modelConfigId, parameters: row.parameters, referenceAssetIds: row.referenceAssetIds, category: row.category, tags: row.tags, notes: row.notes, sourceTaskId: row.sourceTaskId, sourceAssetId: row.sourceAssetId });
}

function titleFromPrompt(prompt: string) { return prompt.trim().replace(/\s+/g, " ").slice(0, 60) || "未命名提示词"; }
function toolFromOperation(operation: string, parameters: Record<string, unknown>): PromptSnapshot["targetTool"] {
  if (operation === "upscale") return "detail-enhance";
  if (operation === "batch_image") return "batch-edit";
  if (operation === "seamless_stitch") return "seamless-stitch";
  if (operation === "video_generation") return "video";
  if (operation === "inpaint") return parameters.tool === "angle-control" ? "angle-control" : "image-edit";
  return "image-generation";
}
function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
function notFound() { return new PromptTemplateError("NOT_FOUND", "提示词模板不存在", 404); }
