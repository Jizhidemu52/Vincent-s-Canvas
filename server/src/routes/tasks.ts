import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { Cache, Database } from "../db";
import { requireRole } from "../rbac";
import {
  BillingError,
  enqueueTask,
  recalculateBatch,
  transitionBatchTasks,
  transitionTask,
  type QueueTaskAction,
} from "../tasks";
import type { AuthenticatedRequest } from "../types";
import { assertModuleEnabled, moduleForOperation } from "../module-flags";

const base = z.object({
  requestId: z.string().min(8).max(200),
  projectId: z.string().min(1).max(200),
  operationType: z.string().min(1).max(80),
  modelConfigId: z.string().uuid().nullish(),
  prompt: z.string().max(20_000).default(""),
  parameters: z.record(z.string(), z.unknown()).default({}),
  priority: z.enum(["normal", "priority", "urgent"]).default("normal"),
});
const singleSchema = base.extend({
  sourceUrls: z.array(z.string().max(2_000)).max(20).default([]),
});
const batchSchema = base.extend({
  items: z
    .array(
      z.object({
        sourceUrls: z.array(z.string().max(2_000)).min(1).max(20),
      }),
    )
    .min(1)
    .max(200),
});
const actionSchema = z.enum(["pause", "resume", "cancel"]);

const taskSelect = `t.id,t.request_id AS "requestId",t.batch_id AS "batchId",t.user_id AS "userId",u.display_name AS "userName",t.project_id AS "projectId",t.operation_type AS "operationType",t.prompt,t.parameters,t.source_urls AS "sourceUrls",t.result_urls AS "resultUrls",t.priority,t.status,t.credits,t.rmb_cost::float8 AS "rmbCost",t.failure_reason AS "failureReason",t.attempts,t.queued_at AS "queuedAt",t.started_at AS "startedAt",t.completed_at AS "completedAt"`;
const batchSelect = `b.id,b.request_id AS "requestId",b.user_id AS "userId",u.display_name AS "userName",b.department_id AS "departmentId",b.project_id AS "projectId",b.operation_type AS "operationType",m.name AS "modelName",b.priority,b.status,b.total_items AS "totalItems",b.completed_items AS "completedItems",b.failed_items AS "failedItems",stats.waiting_items AS "waitingItems",stats.processing_items AS "processingItems",stats.paused_items AS "pausedItems",stats.cancelled_items AS "cancelledItems",stats.planned_credits AS "plannedCredits",stats.consumed_credits AS "consumedCredits",stats.consumed_rmb_cost AS "consumedRmbCost",b.created_at AS "createdAt",b.updated_at AS "updatedAt"`;
const batchStatsJoin = `LEFT JOIN LATERAL (SELECT
  COUNT(*) FILTER (WHERE t.status='waiting')::int AS waiting_items,
  COUNT(*) FILTER (WHERE t.status='processing')::int AS processing_items,
  COUNT(*) FILTER (WHERE t.status='paused')::int AS paused_items,
  COUNT(*) FILTER (WHERE t.status='cancelled')::int AS cancelled_items,
  COALESCE(SUM(t.credits),0)::int AS planned_credits,
  COALESCE(SUM(t.credits) FILTER (WHERE t.status='success'),0)::int AS consumed_credits,
  COALESCE(SUM(t.rmb_cost) FILTER (WHERE t.status='success'),0)::float8 AS consumed_rmb_cost
  FROM tasks t WHERE t.batch_id=b.id) stats ON true`;

export function createTasksRouter(db: Database, cache: Cache) {
  const router = Router();

  router.post("/", async (request, response, next) => {
    try {
      const input = singleSchema.parse(request.body);
      await assertModuleEnabled(db, moduleForOperation(input.operationType, input.parameters));
      const actor = (request as unknown as AuthenticatedRequest).auth;
      if (input.priority === "urgent" && actor.role !== "super_admin") {
        response.status(403).json({
          error: "FORBIDDEN",
          message: "仅超级管理员可提交紧急任务",
        });
        return;
      }
      if (input.priority === "priority" && actor.role === "designer") {
        response
          .status(403)
          .json({ error: "FORBIDDEN", message: "设计师只能提交普通任务" });
        return;
      }
      response.status(201).json({
        task: await enqueueTask(db, cache, {
          ...input,
          userId: actor.id,
          departmentId: actor.departmentId,
        }),
      });
    } catch (error) {
      if (error instanceof BillingError) {
        response
          .status(400)
          .json({ error: error.code, message: error.message });
        return;
      }
      next(error);
    }
  });

  router.post("/batch", async (request, response, next) => {
    try {
      const input = batchSchema.parse(request.body);
      await assertModuleEnabled(db, moduleForOperation(input.operationType, input.parameters));
      const actor = (request as unknown as AuthenticatedRequest).auth;
      if (input.priority !== "normal" && actor.role === "designer") {
        response
          .status(403)
          .json({ error: "FORBIDDEN", message: "设计师只能提交普通任务" });
        return;
      }
      const batchId = randomUUID();
      await db.query(
        `INSERT INTO batch_tasks(id,request_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,priority,total_items)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          batchId,
          input.requestId,
          actor.id,
          actor.departmentId,
          input.projectId,
          input.operationType,
          input.modelConfigId ?? null,
          input.prompt,
          input.priority,
          input.items.length,
        ],
      );
      const tasks = [];
      const failures = [];
      for (const [index, item] of input.items.entries()) {
        try {
          const task = await enqueueTask(db, cache, {
            ...input,
            requestId: `${input.requestId}:${index}`,
            sourceUrls: item.sourceUrls,
            userId: actor.id,
            departmentId: actor.departmentId,
            batchId,
          });
          tasks.push({ ...task, itemIndex: index });
        } catch (error) {
          const reason =
            error instanceof Error ? error.message : "任务创建失败";
          const itemRequestId = `${input.requestId}:${index}`;
          const existing = await db.query<{ id: string }>(
            "SELECT id FROM tasks WHERE request_id=$1",
            [itemRequestId],
          );
          const failedId = existing.rows[0]?.id ?? randomUUID();
          if (existing.rows[0]) {
            await db.query(
              "UPDATE tasks SET status='failed',credits=0,rmb_cost=0,failure_reason=$1,completed_at=now(),updated_at=now() WHERE id=$2",
              [reason, failedId],
            );
          } else {
            await db.query(
              `INSERT INTO tasks(id,request_id,batch_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,priority,status,credits,rmb_cost,failure_reason,completed_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'failed',0,0,$13,now())`,
              [
                failedId,
                itemRequestId,
                batchId,
                actor.id,
                actor.departmentId,
                input.projectId,
                input.operationType,
                input.modelConfigId ?? null,
                input.prompt,
                input.parameters,
                JSON.stringify(item.sourceUrls),
                input.priority,
                reason,
              ],
            );
          }
          await db.query(
            `INSERT INTO generation_history(task_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status,failure_reason)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]',0,0,'failed',$10)
             ON CONFLICT(task_id) DO UPDATE SET status='failed',failure_reason=EXCLUDED.failure_reason,credits=0,rmb_cost=0`,
            [
              failedId,
              actor.id,
              actor.departmentId,
              input.projectId,
              input.operationType,
              input.modelConfigId ?? null,
              input.prompt,
              input.parameters,
              JSON.stringify(item.sourceUrls),
              reason,
            ],
          );
          failures.push({ index, reason });
        }
      }
      await recalculateBatch(db, batchId);
      response.status(201).json({ batchId, tasks, failures });
    } catch (error) {
      next(error);
    }
  });

  router.get("/", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const result = await db.query(
        `SELECT ${taskSelect} FROM tasks t JOIN users u ON u.id=t.user_id WHERE t.user_id=$1 ORDER BY t.queued_at DESC LIMIT 500`,
        [actor.id],
      );
      response.json({ tasks: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/batches", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const result = await db.query(
        `SELECT ${batchSelect} FROM batch_tasks b JOIN users u ON u.id=b.user_id LEFT JOIN model_configs m ON m.id=b.model_config_id ${batchStatsJoin} WHERE b.user_id=$1 ORDER BY b.created_at DESC LIMIT 500`,
        [actor.id],
      );
      response.json({ batches: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.post("/batches/:id/:action", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const action = actionSchema.parse(request.params.action);
      const batch = await db.query<{ id: string }>(
        "SELECT id FROM batch_tasks WHERE id=$1 AND user_id=$2",
        [request.params.id, actor.id],
      );
      if (!batch.rows[0]) {
        response
          .status(404)
          .json({ error: "NOT_FOUND", message: "批量任务不存在" });
        return;
      }
      const changed = await transitionBatchTasks(
        db,
        cache,
        request.params.id,
        action,
      );
      if (!changed) {
        response.status(409).json({
          error: "INVALID_BATCH_STATE",
          message: "当前批量任务没有可执行该操作的图片",
        });
        return;
      }
      await writeAudit(db, {
        actor,
        action: `batch.${pastTense(action)}`,
        targetType: "batch_task",
        targetId: request.params.id,
        departmentId: actor.departmentId,
        result: "success",
        detail: { changed },
        ip: request.ip,
      });
      response.json({ changed });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/:action", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const action = actionSchema.parse(request.params.action);
      const owned = await db.query<{ id: string }>(
        "SELECT id FROM tasks WHERE id=$1 AND user_id=$2",
        [request.params.id, actor.id],
      );
      if (!owned.rows[0]) {
        response
          .status(404)
          .json({ error: "NOT_FOUND", message: "任务不存在" });
        return;
      }
      const changed = await transitionTask(
        db,
        cache,
        request.params.id,
        action,
      );
      if (!changed) {
        response.status(409).json({
          error: "INVALID_TASK_STATE",
          message: "当前任务状态不能执行该操作",
        });
        return;
      }
      await writeAudit(db, {
        actor,
        action: `task.${pastTense(action)}`,
        targetType: "task",
        targetId: request.params.id,
        departmentId: actor.departmentId,
        result: "success",
        ip: request.ip,
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id/mock-image", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const scope =
        actor.role === "super_admin"
          ? ""
          : actor.role === "department_admin"
            ? "AND department_id=$2"
            : "AND user_id=$2";
      const value =
        actor.role === "department_admin" ? actor.departmentId : actor.id;
      const task = await db.query<{ id: string }>(
        `SELECT id FROM tasks WHERE id=$1 ${scope}`,
        scope ? [request.params.id, value] : [request.params.id],
      );
      if (!task.rows[0]) {
        response.status(404).end();
        return;
      }
      response.type("image/svg+xml").send(mockSvg(request.params.id));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function createAdminTasksRouter(db: Database, cache: Cache) {
  const router = Router();
  router.use(requireRole("super_admin", "department_admin"));

  router.get("/", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const values: unknown[] = [];
      const scope =
        actor.role === "department_admin"
          ? (values.push(actor.departmentId), "WHERE t.department_id=$1")
          : "";
      const result = await db.query(
        `SELECT ${taskSelect} FROM tasks t JOIN users u ON u.id=t.user_id ${scope} ORDER BY t.queued_at DESC LIMIT 1000`,
        values,
      );
      response.json({ tasks: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/batches", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const values: unknown[] = [];
      const scope =
        actor.role === "department_admin"
          ? (values.push(actor.departmentId), "WHERE b.department_id=$1")
          : "";
      const result = await db.query(
        `SELECT ${batchSelect} FROM batch_tasks b JOIN users u ON u.id=b.user_id LEFT JOIN model_configs m ON m.id=b.model_config_id ${batchStatsJoin} ${scope} ORDER BY b.created_at DESC LIMIT 1000`,
        values,
      );
      response.json({ batches: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.post("/batches/:id/:action", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const action = actionSchema.parse(request.params.action);
      const values: unknown[] = [request.params.id];
      const scope =
        actor.role === "department_admin"
          ? (values.push(actor.departmentId), "AND department_id=$2")
          : "";
      const batch = await db.query<{
        id: string;
        department_id: string | null;
      }>(
        `SELECT id,department_id FROM batch_tasks WHERE id=$1 ${scope}`,
        values,
      );
      if (!batch.rows[0]) {
        response
          .status(404)
          .json({ error: "NOT_FOUND", message: "批量任务不存在" });
        return;
      }
      const changed = await transitionBatchTasks(
        db,
        cache,
        request.params.id,
        action,
      );
      if (!changed) {
        response.status(409).json({
          error: "INVALID_BATCH_STATE",
          message: "当前批量任务没有可执行该操作的图片",
        });
        return;
      }
      await writeAudit(db, {
        actor,
        action: `batch.admin_${pastTense(action)}`,
        targetType: "batch_task",
        targetId: request.params.id,
        departmentId: batch.rows[0].department_id,
        result: "success",
        detail: { changed },
        ip: request.ip,
      });
      response.json({ changed });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/:action", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const action = actionSchema.parse(request.params.action);
      const values: unknown[] = [request.params.id];
      const scope =
        actor.role === "department_admin"
          ? (values.push(actor.departmentId), "AND department_id=$2")
          : "";
      const task = await db.query<{
        id: string;
        department_id: string | null;
      }>(`SELECT id,department_id FROM tasks WHERE id=$1 ${scope}`, values);
      if (!task.rows[0]) {
        response
          .status(404)
          .json({ error: "NOT_FOUND", message: "任务不存在" });
        return;
      }
      const changed = await transitionTask(
        db,
        cache,
        request.params.id,
        action,
      );
      if (!changed) {
        response.status(409).json({
          error: "INVALID_TASK_STATE",
          message: "当前任务状态不能执行该操作",
        });
        return;
      }
      await writeAudit(db, {
        actor,
        action: `task.admin_${pastTense(action)}`,
        targetType: "task",
        targetId: request.params.id,
        departmentId: task.rows[0].department_id,
        result: "success",
        ip: request.ip,
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function pastTense(action: QueueTaskAction) {
  return action === "pause"
    ? "paused"
    : action === "resume"
      ? "resumed"
      : "cancelled";
}

function mockSvg(id: string) {
  const hue = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="hsl(${hue} 65% 46%)"/><circle cx="512" cy="440" r="260" fill="hsl(${(hue + 45) % 360} 75% 70%)"/><path d="M180 820L410 560l150 150 110-120 174 230z" fill="white" opacity=".85"/><text x="512" y="940" text-anchor="middle" font-family="sans-serif" font-size="38" fill="white">Wireless Canvas QA ${id.slice(0, 8)}</text></svg>`;
}
