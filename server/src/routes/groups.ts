import { Router } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { Database } from "../db";
import { canManageGroup, isGroupLeader } from "../group-scope";
import { closeActiveGroupCreditPeriods } from "../group-credits";
import { assertModuleEnabled } from "../module-flags";
import { requireRole } from "../rbac";
import type { AuthenticatedRequest, SessionUser } from "../types";

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().min(1).max(50),
  departmentId: z.string().uuid(),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  code: z.string().trim().min(1).max(50).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).refine((value) => Object.keys(value).length > 0);
const membershipSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["member", "leader"]).default("member"),
});

type GroupRow = {
  id: string; name: string; code: string; status: "active" | "disabled";
  departmentId: string; departmentName: string; createdAt: string;
};

const groupSelect = `g.id,g.name,g.code,g.status,g.department_id AS "departmentId",
  d.name AS "departmentName",g.created_at AS "createdAt"`;

export function createGroupsRouter(db: Database) {
  const router = Router();
  router.use(requireRole("super_admin", "department_admin"));

  router.get("/", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const values: unknown[] = [];
      const where = actor.role === "department_admin"
        ? (values.push(actor.departmentId), "WHERE g.department_id=$1")
        : "";
      const groups = await db.query<GroupRow>(
        `SELECT ${groupSelect} FROM designer_groups g JOIN departments d ON d.id=g.department_id
          ${where} ORDER BY d.name,g.name`, values,
      );
      const ids = groups.rows.map((group) => group.id);
      const members = ids.length ? await db.query(
        `SELECT gm.id,gm.group_id AS "groupId",gm.user_id AS "userId",gm.member_role AS role,
                gm.effective_at AS "effectiveAt",u.display_name AS "displayName",u.username,
                u.status,u.department_id AS "departmentId"
           FROM group_memberships gm JOIN users u ON u.id=gm.user_id
          WHERE gm.group_id=ANY($1::uuid[]) AND gm.ended_at IS NULL
          ORDER BY (gm.member_role='leader') DESC,u.display_name`, [ids],
      ) : { rows: [] };
      response.json({
        groups: groups.rows.map((group) => ({
          ...group,
          members: members.rows.filter((member: Record<string, unknown>) => member.groupId === group.id),
        })),
      });
    } catch (error) { next(error); }
  });

  router.post("/", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const input = createSchema.parse(request.body);
      if (actor.role === "department_admin" && actor.departmentId !== input.departmentId) {
        response.status(403).json({ error: "FORBIDDEN", message: "只能在本部门创建小组" }); return;
      }
      const result = await db.query<GroupRow>(
        `WITH inserted AS (
           INSERT INTO designer_groups(name,code,department_id,created_by) VALUES($1,$2,$3,$4)
           RETURNING id,name,code,status,department_id,created_at
         ) SELECT i.id,i.name,i.code,i.status,i.department_id AS "departmentId",
                  d.name AS "departmentName",i.created_at AS "createdAt"
             FROM inserted i JOIN departments d ON d.id=i.department_id`,
        [input.name, input.code, input.departmentId, actor.id],
      );
      const group = result.rows[0]!;
      await writeAudit(db, { actor, action: "group.created", targetType: "group", targetId: group.id, departmentId: group.departmentId, result: "success", detail: { name: group.name, code: group.code }, ip: request.ip });
      response.status(201).json({ group: { ...group, members: [] } });
    } catch (error) { next(error); }
  });

  router.patch("/:id", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const input = updateSchema.parse(request.body);
      if (!(await canManageGroup(db, actor, request.params.id))) {
        response.status(403).json({ error: "FORBIDDEN", message: "无权管理该小组" }); return;
      }
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query<GroupRow>(`SELECT ${groupSelect} FROM designer_groups g JOIN departments d ON d.id=g.department_id WHERE g.id=$1 FOR UPDATE OF g`, [request.params.id]);
        if (!current.rows[0]) { await client.query("ROLLBACK"); response.status(404).json({ error: "NOT_FOUND", message: "小组不存在" }); return; }
        const result = await client.query<GroupRow>(
          `WITH updated AS (
             UPDATE designer_groups SET name=$1,code=$2,status=$3,updated_at=now() WHERE id=$4
             RETURNING id,name,code,status,department_id,created_at
           ) SELECT u.id,u.name,u.code,u.status,u.department_id AS "departmentId",
                    d.name AS "departmentName",u.created_at AS "createdAt"
               FROM updated u JOIN departments d ON d.id=u.department_id`,
          [input.name ?? current.rows[0].name, input.code ?? current.rows[0].code, input.status ?? current.rows[0].status, request.params.id],
        );
        if (input.status === "disabled" && current.rows[0].status !== "disabled") {
          await closeActiveGroupCreditPeriods(client, request.params.id, actor.id);
          await client.query(
            "UPDATE group_memberships SET ended_at=now(),ended_by=$1 WHERE group_id=$2 AND ended_at IS NULL",
            [actor.id, request.params.id],
          );
        }
        await writeAudit(client, { actor, action: "group.updated", targetType: "group", targetId: request.params.id, departmentId: result.rows[0]!.departmentId, result: "success", detail: input, ip: request.ip });
        await client.query("COMMIT");
        response.json({ group: result.rows[0] });
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } catch (error) { next(error); }
  });

  router.post("/:id/members", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const input = membershipSchema.parse(request.body);
      if (!(await canManageGroup(db, actor, request.params.id)) || actor.role === "designer") {
        response.status(403).json({ error: "FORBIDDEN", message: "只有管理员可以调整小组成员" }); return;
      }
      let groupDepartmentId: string | null = null;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const groupResult = await client.query<{ department_id: string; status: string }>("SELECT department_id,status FROM designer_groups WHERE id=$1 FOR UPDATE", [request.params.id]);
        const group = groupResult.rows[0];
        if (!group) { response.status(404).json({ error: "NOT_FOUND", message: "小组不存在" }); await client.query("ROLLBACK"); return; }
        if (group.status !== "active") { response.status(409).json({ error: "GROUP_DISABLED", message: "停用小组不能调整成员" }); await client.query("ROLLBACK"); return; }
        groupDepartmentId = group.department_id;
        const userResult = await client.query<{ department_id: string | null; role: string; status: string }>("SELECT department_id,role,status FROM users WHERE id=$1 FOR UPDATE", [input.userId]);
        const user = userResult.rows[0];
        if (!user || user.role !== "designer" || user.status !== "active" || user.department_id !== group.department_id) {
          response.status(400).json({ error: "INVALID_GROUP_MEMBER", message: "只能添加本部门已启用的设计师" }); await client.query("ROLLBACK"); return;
        }
        const active = await client.query<{ id: string; group_id: string }>("SELECT id,group_id FROM group_memberships WHERE user_id=$1 AND ended_at IS NULL FOR UPDATE", [input.userId]);
        if (active.rows[0] && active.rows[0].group_id !== request.params.id) {
          response.status(409).json({ error: "GROUP_MEMBERSHIP_CONFLICT", message: "该设计师已属于其他小组，请先移出原小组" }); await client.query("ROLLBACK"); return;
        }
        if (input.role === "leader") await client.query("UPDATE group_memberships SET member_role='member' WHERE group_id=$1 AND ended_at IS NULL AND member_role='leader'", [request.params.id]);
        if (active.rows[0]) {
          await client.query("UPDATE group_memberships SET member_role=$1 WHERE id=$2", [input.role, active.rows[0].id]);
        } else {
          await client.query("INSERT INTO group_memberships(group_id,user_id,member_role,created_by) VALUES($1,$2,$3,$4)", [request.params.id, input.userId, input.role, actor.id]);
        }
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      await writeAudit(db, { actor, action: input.role === "leader" ? "group.leader_assigned" : "group.member_added", targetType: "group", targetId: request.params.id, departmentId: groupDepartmentId, result: "success", detail: input, ip: request.ip });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.delete("/:id/members/:userId", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      if (!(await canManageGroup(db, actor, request.params.id)) || actor.role === "designer") {
        response.status(403).json({ error: "FORBIDDEN", message: "只有管理员可以调整小组成员" }); return;
      }
      const result = await db.query<{ id: string; departmentId: string }>(
        `WITH ended AS (
           UPDATE group_memberships SET ended_at=now(),ended_by=$1
            WHERE group_id=$2 AND user_id=$3 AND ended_at IS NULL RETURNING id,group_id
         ) SELECT e.id,g.department_id AS "departmentId" FROM ended e JOIN designer_groups g ON g.id=e.group_id`,
        [actor.id, request.params.id, request.params.userId],
      );
      if (!result.rows[0]) { response.status(404).json({ error: "NOT_FOUND", message: "有效成员关系不存在" }); return; }
      await writeAudit(db, { actor, action: "group.member_removed", targetType: "group", targetId: request.params.id, departmentId: result.rows[0].departmentId, result: "success", detail: { userId: request.params.userId }, ip: request.ip });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.delete("/:id", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      if (!(await canManageGroup(db, actor, request.params.id)) || actor.role === "designer") {
        response.status(403).json({ error: "FORBIDDEN", message: "无权删除该小组" }); return;
      }
      const dependencies = await db.query<{ total: number }>(
        `SELECT (SELECT count(*) FROM group_memberships WHERE group_id=$1)::int +
                (SELECT count(*) FROM asset_events WHERE group_id=$1)::int AS total`, [request.params.id],
      );
      if ((dependencies.rows[0]?.total ?? 0) > 0) {
        response.status(409).json({ error: "GROUP_HAS_HISTORY", message: "该小组已有成员或历史记录，请改为停用" }); return;
      }
      const result = await db.query<{ department_id: string }>("DELETE FROM designer_groups WHERE id=$1 RETURNING department_id", [request.params.id]);
      if (!result.rows[0]) { response.status(404).json({ error: "NOT_FOUND", message: "小组不存在" }); return; }
      await writeAudit(db, { actor, action: "group.deleted", targetType: "group", targetId: request.params.id, departmentId: result.rows[0].department_id, result: "success", ip: request.ip });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  return router;
}

export function createTeamRouter(db: Database) {
  const router = Router();
  router.use(async (request, response, next) => {
    const actor = (request as unknown as AuthenticatedRequest).auth;
    if (!isGroupLeader(actor)) { response.status(403).json({ error: "FORBIDDEN", message: "只有当前小组组长可以访问" }); return; }
    try {
      await assertModuleEnabled(db, "team");
      next();
    } catch (error) { next(error); }
  });

  router.get("/", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const group = await db.query(
        `SELECT g.id,g.name,g.code,d.name AS "departmentName",
                count(gm.user_id)::int AS "memberCount"
           FROM designer_groups g JOIN departments d ON d.id=g.department_id
           LEFT JOIN group_memberships gm ON gm.group_id=g.id AND gm.ended_at IS NULL
          WHERE g.id=$1 AND g.status='active' GROUP BY g.id,d.name`, [actor.groupId],
      );
      const members = await db.query(
        `SELECT u.id,u.display_name AS "displayName",u.username,u.status,
                gm.member_role AS role,gm.effective_at AS "effectiveAt",
                u.credit_balance AS "creditBalance",u.monthly_credit_limit AS "monthlyCreditLimit"
           FROM group_memberships gm JOIN users u ON u.id=gm.user_id
          WHERE gm.group_id=$1 AND gm.ended_at IS NULL ORDER BY (gm.member_role='leader') DESC,u.display_name`, [actor.groupId],
      );
      const summary = await db.query(
        `SELECT count(*)::int AS "taskCount",
                count(*) FILTER (WHERE h.status='success')::int AS "successCount",
                coalesce(sum(h.credits),0)::int AS credits,
                coalesce(sum(h.rmb_cost),0)::float8 AS "rmbCost"
           FROM generation_history h
          WHERE EXISTS(SELECT 1 FROM group_memberships gm WHERE gm.group_id=$1 AND gm.user_id=h.user_id
            AND gm.effective_at<=h.created_at AND (gm.ended_at IS NULL OR gm.ended_at>h.created_at))`, [actor.groupId],
      );
      response.json({ group: group.rows[0], members: members.rows, summary: summary.rows[0] });
    } catch (error) { next(error); }
  });

  router.get("/history", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const result = await db.query(
        `SELECT h.id,h.user_id AS "userId",u.display_name AS "userName",h.operation_type AS "operationType",
                m.name AS "modelName",h.prompt,h.credits,h.rmb_cost::float8 AS "rmbCost",h.status,
                h.failure_reason AS "failureReason",h.created_at AS "createdAt"
           FROM generation_history h JOIN users u ON u.id=h.user_id
           LEFT JOIN model_configs m ON m.id=h.model_config_id
          WHERE EXISTS(SELECT 1 FROM group_memberships gm WHERE gm.group_id=$1 AND gm.user_id=h.user_id
            AND gm.effective_at<=h.created_at AND (gm.ended_at IS NULL OR gm.ended_at>h.created_at))
          ORDER BY h.created_at DESC LIMIT 500`, [actor.groupId],
      );
      response.json({ history: result.rows });
    } catch (error) { next(error); }
  });

  router.get("/history/export", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const result = await db.query<Record<string, unknown>>(
        `SELECT h.created_at AS "createdAt",u.display_name AS "userName",h.operation_type AS "operationType",
                m.name AS "modelName",h.prompt,h.credits,h.rmb_cost::float8 AS "rmbCost",h.status,
                h.failure_reason AS "failureReason"
           FROM generation_history h JOIN users u ON u.id=h.user_id
           LEFT JOIN model_configs m ON m.id=h.model_config_id
          WHERE EXISTS(SELECT 1 FROM group_memberships gm WHERE gm.group_id=$1 AND gm.user_id=h.user_id
            AND gm.effective_at<=h.created_at AND (gm.ended_at IS NULL OR gm.ended_at>h.created_at))
          ORDER BY h.created_at DESC LIMIT 50000`, [actor.groupId],
      );
      const headers = ["时间", "设计师", "功能板块", "模型", "完整提示词", "积分", "人民币成本", "状态", "失败原因"];
      const rows = result.rows.map((row) => [row.createdAt, row.userName, row.operationType, row.modelName, row.prompt, row.credits, row.rmbCost, row.status, row.failureReason]);
      const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
      await writeAudit(db, { actor, action: "team.history_exported", targetType: "group", targetId: actor.groupId ?? undefined, departmentId: actor.departmentId, result: "success", detail: { rowCount: result.rows.length }, ip: request.ip });
      response.setHeader("content-type", "text/csv; charset=utf-8");
      response.setHeader("content-disposition", `attachment; filename="team-history-${Date.now()}.csv"`);
      response.send(`\uFEFF${csv}`);
    } catch (error) { next(error); }
  });

  router.get("/audit", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const result = await db.query(
        `SELECT a.id,a.action,a.target_type AS "targetType",a.target_id AS "targetId",a.result,a.detail,
                a.created_at AS "createdAt",u.display_name AS "actorName"
           FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id
          WHERE a.target_id=$1 OR EXISTS(
            SELECT 1 FROM group_memberships gm WHERE gm.group_id=$1 AND gm.user_id=a.actor_user_id
              AND gm.effective_at<=a.created_at AND (gm.ended_at IS NULL OR gm.ended_at>a.created_at)
          ) ORDER BY a.created_at DESC LIMIT 500`, [actor.groupId],
      );
      response.json({ auditLogs: result.rows });
    } catch (error) { next(error); }
  });

  return router;
}

function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
