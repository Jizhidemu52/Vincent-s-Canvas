import { Router } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { Database } from "../db";
import { designDirections } from "../design-direction";
import { isGroupLeader } from "../group-scope";
import { assertModuleEnabled } from "../module-flags";
import { getPerformanceDashboard } from "../performance";
import type { AuthenticatedRequest } from "../types";

const querySchema = z.object({
  preset: z.enum(["today", "week", "month", "custom"]).default("month"),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  departmentId: z.string().uuid().optional(), groupId: z.string().uuid().optional(), userId: z.string().uuid().optional(),
}).superRefine((value, context) => {
  if (value.preset === "custom" && (!value.from || !value.to)) context.addIssue({ code: "custom", message: "自定义时间必须包含开始和结束时间" });
  if (value.from && value.to && new Date(value.from) >= new Date(value.to)) context.addIssue({ code: "custom", path: ["from"], message: "开始时间必须早于结束时间" });
  if (value.from && value.to && new Date(value.to).getTime() - new Date(value.from).getTime() > 366 * 86_400_000) context.addIssue({ code: "custom", path: ["to"], message: "单次查询最多 366 天" });
});

const directionSchema = z.object({
  primaryDirection: z.enum(designDirections),
  secondaryDirections: z.array(z.enum(designDirections)).max(designDirections.length).default([]),
  adminTags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
});

const deadlineSchema = z.object({
  targetType: z.enum(["project", "task"]),
  targetId: z.string().uuid(),
  deadlineAt: z.string().datetime({ offset: true }).nullable(),
});

export function createPerformanceRouter(db: Database) {
  const router = Router();
  router.use(async (request, response, next) => {
    const actor = (request as unknown as AuthenticatedRequest).auth;
    if (!isGroupLeader(actor) && actor.role !== "super_admin" && actor.role !== "department_admin") {
      response.status(403).json({ error: "FORBIDDEN", message: "只有管理员和小组组长可以查看设计效能" }); return;
    }
    try { await assertModuleEnabled(db, "performance"); next(); } catch (error) { next(error); }
  });
  router.get("/", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const query = querySchema.parse(request.query);
      const range = resolveRange(query.preset, query.from, query.to);
      response.json(await getPerformanceDashboard(db, actor, { ...range, departmentId: query.departmentId, groupId: query.groupId, userId: query.userId }));
    } catch (error) { next(error); }
  });
  router.patch("/assets/:id/direction", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const input = directionSchema.parse(request.body);
      const scope = actor.role === "super_admin" ? { sql: "", values: [] as unknown[] }
        : actor.role === "department_admin" ? { sql: "AND a.department_id=$2", values: [actor.departmentId] }
          : { sql: "AND EXISTS (SELECT 1 FROM asset_events e WHERE e.asset_id=a.id AND e.event_type='asset.generated' AND e.group_id=$2)", values: [actor.groupId] };
      const result = await db.query<{ id: string; departmentId: string | null }>(
        `UPDATE assets a SET primary_direction=$1,secondary_directions=$${scope.values.length + 2},
          admin_direction_tags=$${scope.values.length + 3},direction_rule_version='admin-v1',
          direction_evidence=jsonb_build_object('source','admin_tag','actorId',$${scope.values.length + 4}::text),updated_at=now()
         WHERE a.id=$${scope.values.length + 5} ${scope.sql}
         RETURNING a.id,a.department_id AS "departmentId"`,
        [input.primaryDirection, ...scope.values, JSON.stringify(input.secondaryDirections.filter((item) => item !== input.primaryDirection)), JSON.stringify(input.adminTags), actor.id, request.params.id],
      );
      if (!result.rows[0]) { response.status(404).json({ error: "NOT_FOUND", message: "成果不存在或不在可管理范围内" }); return; }
      await writeAudit(db, { actor, action: "performance.direction_updated", targetType: "asset", targetId: request.params.id,
        departmentId: result.rows[0].departmentId, result: "success", detail: input, ip: request.ip });
      response.json({ direction: input });
    } catch (error) { next(error); }
  });
  router.patch("/deadline", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const input = deadlineSchema.parse(request.body);
      const table = input.targetType === "project" ? "projects" : "tasks";
      const ownerColumn = input.targetType === "project" ? "target.owner_user_id" : "target.user_id";
      const occurrenceColumn = input.targetType === "project" ? "target.created_at" : "target.queued_at";
      const values: unknown[] = [input.deadlineAt, input.targetId];
      let scope = "";
      if (actor.role === "department_admin") { values.push(actor.departmentId); scope = "AND target.department_id=$3"; }
      if (actor.role === "designer") {
        values.push(actor.groupId);
        scope = `AND EXISTS (SELECT 1 FROM group_memberships gm WHERE gm.user_id=${ownerColumn} AND gm.group_id=$3
          AND gm.effective_at<=${occurrenceColumn} AND (gm.ended_at IS NULL OR gm.ended_at>${occurrenceColumn}))`;
      }
      const result = await db.query<{ id: string; departmentId: string | null }>(`UPDATE ${table} AS target SET deadline_at=$1,updated_at=now() WHERE target.id=$2 ${scope} RETURNING target.id,target.department_id AS "departmentId"`, values);
      if (!result.rows[0]) { response.status(404).json({ error: "NOT_FOUND", message: "项目或任务不存在或不在可管理范围内" }); return; }
      await writeAudit(db, { actor, action: "performance.deadline_updated", targetType: input.targetType, targetId: input.targetId,
        departmentId: result.rows[0].departmentId, result: "success", detail: { deadlineAt: input.deadlineAt }, ip: request.ip });
      response.json({ deadline: input });
    } catch (error) { next(error); }
  });
  return router;
}

export function resolveRange(preset: "today" | "week" | "month" | "custom", from?: string, to?: string) {
  if (preset === "custom") return { from: from!, to: to! };
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const dayStart = new Date(`${parts}T00:00:00+08:00`);
  const end = new Date(dayStart.getTime() + 86_400_000);
  if (preset === "today") return { from: dayStart.toISOString(), to: end.toISOString() };
  if (preset === "week") {
    const dayName = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short" }).format(now);
    const weekday = dayName === "Sun" ? 7 : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(dayName) + 1;
    return { from: new Date(dayStart.getTime() - (weekday - 1) * 86_400_000).toISOString(), to: end.toISOString() };
  }
  return { from: new Date(`${parts.slice(0, 7)}-01T00:00:00+08:00`).toISOString(), to: end.toISOString() };
}
