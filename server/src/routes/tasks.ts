import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { taskSubmissionSchema as singleSchema, batchSubmissionSchema as batchSchema } from "../../../shared/task-contracts";

import { writeAudit } from "../audit";
import type { Cache, Database } from "../db";
import { makeCursorPage, parseCursorPage } from "../cursor-pagination";
import { requireRole } from "../rbac";
import {
  BillingError,
  enqueueTask,
  queueScore,
  recalculateBatch,
  transitionBatchTasks,
  transitionTask,
  type QueueTaskAction,
  type TaskPriority,
} from "../tasks";
import type { AuthenticatedRequest } from "../types";
import { resolveToolExecution } from "../tool-configuration";
import { loadTaskPriceSnapshot } from "../billing";
import { preflightStoredVideoTask } from "../stored-video-preflight";
import { readTaskProgress } from "../task-progress";
import { scheduleQueuedTask } from "../task-queue";
import { requiredPromptScene } from "../../../shared/prompt-contracts";
import type { PromptCompiler } from "../prompt-compiler";
import { preparePromptTaskInput } from "../prompt-task-input";
import { PromptOptimizationError } from "../prompt-safety";
import { promptHash } from "../prompt-recipe-store";
import { withTransaction } from "../db-transaction";
import { claimBatchAdmission, fenceBatchAdmission, findBatchForSubmission, finishBatchAdmission, readBatchAdmission, recordBatchAdmissionFailure, type BatchAdmissionToken } from "../batch-admission";

const actionSchema = z.enum(["pause", "resume", "cancel"]);

const taskSelect = `t.id,t.tool_key AS "toolKey",t.model_config_id AS "modelConfigId",t.request_id AS "requestId",t.batch_id AS "batchId",t.user_id AS "userId",u.display_name AS "userName",t.project_id AS "projectId",t.operation_type AS "operationType",t.prompt,t.parameters,t.source_urls AS "sourceUrls",t.result_urls AS "resultUrls",t.priority,t.status,t.credits,t.rmb_cost::float8 AS "rmbCost",t.failure_reason AS "failureReason",t.attempts,t.upstream_task_id AS "upstreamTaskId",t.upstream_submission_started_at AS "submissionStartedAt",t.queued_at AS "queuedAt",t.started_at AS "startedAt",t.completed_at AS "completedAt",t.user_input AS "userInput",t.prompt_optimized AS optimized`;
const taskSummarySelect = `t.id,t.tool_key AS "toolKey",t.model_config_id AS "modelConfigId",t.request_id AS "requestId",t.batch_id AS "batchId",t.user_id AS "userId",u.display_name AS "userName",t.project_id AS "projectId",t.operation_type AS "operationType",left(t.prompt,240) AS prompt,t.result_urls AS "resultUrls",t.priority,t.status,t.credits,t.rmb_cost::float8 AS "rmbCost",t.failure_reason AS "failureReason",t.attempts,t.upstream_task_id AS "upstreamTaskId",t.upstream_submission_started_at AS "submissionStartedAt",t.queued_at AS "queuedAt",t.started_at AS "startedAt",t.completed_at AS "completedAt"`;
const batchSelect = `b.id,b.tool_key AS "toolKey",b.model_config_id AS "modelConfigId",b.request_id AS "requestId",b.user_id AS "userId",u.display_name AS "userName",b.department_id AS "departmentId",b.project_id AS "projectId",b.operation_type AS "operationType",m.name AS "modelName",b.priority,b.status,b.total_items AS "totalItems",b.completed_items AS "completedItems",b.failed_items AS "failedItems",stats.waiting_items AS "waitingItems",stats.processing_items AS "processingItems",stats.paused_items AS "pausedItems",stats.cancelled_items AS "cancelledItems",stats.planned_credits AS "plannedCredits",stats.consumed_credits AS "consumedCredits",stats.consumed_rmb_cost AS "consumedRmbCost",b.created_at AS "createdAt",b.updated_at AS "updatedAt"`;
const batchStatsJoin = `LEFT JOIN LATERAL (SELECT
  COUNT(*) FILTER (WHERE t.status='waiting')::int AS waiting_items,
  COUNT(*) FILTER (WHERE t.status='processing')::int AS processing_items,
  COUNT(*) FILTER (WHERE t.status='paused')::int AS paused_items,
  COUNT(*) FILTER (WHERE t.status='cancelled')::int AS cancelled_items,
  COALESCE(SUM(t.credits),0)::int AS planned_credits,
  COALESCE(SUM(t.credits) FILTER (WHERE t.status='success'),0)::int AS consumed_credits,
  COALESCE(SUM(t.rmb_cost) FILTER (WHERE t.status='success'),0)::float8 AS consumed_rmb_cost
  FROM tasks t WHERE t.batch_id=b.id) stats ON true`;

export function createTasksRouter(db: Database, cache: Cache, creditPolicy: boolean | (() => Promise<boolean>) = true, videoPreflight = preflightStoredVideoTask, options: { maxInflightTasks?: number; promptCompiler?: PromptCompiler } = {}) {
  const router = Router();
  const prepare = async <T extends ReturnType<typeof singleSchema.parse>>(actor: AuthenticatedRequest["auth"], input: T) => {
    if (!input.promptInput && !requiredPromptScene(input.toolKey ?? String(input.parameters.tool ?? ""))) return { ...input, optimized: false };
    if (!options.promptCompiler) throw new PromptOptimizationError("PROMPT_UNAVAILABLE", "提示词优化尚未配置，未提交生成", 503);
    const active = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM tasks WHERE user_id=$1 AND status IN ('waiting','processing','paused')", [actor.id]);
    if (Number(active.rows[0]?.count) >= (options.maxInflightTasks ?? 100)) throw new BillingError("USER_TASK_LIMIT_REACHED", "在途任务已达到上限，请等待任务完成或取消未提交的任务");
    const prior = actor.role === "super_admin" && input.promptInput?.compilationId ? await options.promptCompiler.store.getCompilation(input.promptInput.compilationId, actor.id) : null;
    const execution = await resolveToolExecution(db, input, { allowModelOverride: prior?.adminTest === true });
    return preparePromptTaskInput(options.promptCompiler, actor, { ...input, modelConfigId: execution.modelConfigId, toolKey: execution.toolKey, toolConfiguration: execution });
  };
  const existingBatchResult = async (requestId: string, userId: string) => {
    const batch = await readBatchAdmission(db, requestId, userId);
    if (!batch) return null;
    if (batch.admissionStatus !== "admitting") await recalculateBatch(db, batch.id);
    const tasks = (await db.query<Record<string, unknown> & { requestId: string }>(`SELECT ${taskSelect} FROM tasks t JOIN users u ON u.id=t.user_id WHERE t.batch_id=$1 AND t.user_id=$2 ORDER BY t.queued_at,t.id`, [batch.id, userId])).rows;
    const items = tasks.map(task => ({ ...task, itemIndex: Number(task.requestId.slice(requestId.length + 1)) }));
    const failures = batch.failures.map(({ admitted: _admitted, ...failure }) => failure);
    if (batch.admissionStatus !== "admitting") for (let index = 0; index < batch.totalItems; index++) {
      if (!items.some(task => task.itemIndex === index) && !failures.some(failure => failure.index === index)) {
        failures.push({ index, reason: "批次受理已中断，此项没有已保存任务；不会自动重新提交", code: "BATCH_SUBMISSION_INTERRUPTED" });
      }
    }
    return { batchId: batch.id, prompt: batch.prompt, optimized: tasks.some(task => task.optimized === true), failures: failures.sort((a, b) => a.index - b.index), totalItems: batch.totalItems, submissionComplete: batch.admissionStatus !== "admitting",
      tasks: items.filter(task => !batch.failures.some(failure => failure.index === task.itemIndex && !failure.admitted)) };
  };

  router.post("/preflight", async (request, response, next) => {
    try {
      const input = singleSchema.parse(request.body);
      if (input.operationType !== "video_generation") {
        response.status(400).json({ error: "UNSUPPORTED_OPERATION", message: "此预检入口仅支持视频任务" });
        return;
      }
      const execution = await resolveToolExecution(db, input);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const preflight = await videoPreflight(db, { ...input, modelConfigId: execution.modelConfigId, userId: actor.id });
      response.json({ ok: true, requestId: input.requestId, normalized: preflight.normalized });
    } catch (error) {
      if (error instanceof BillingError) { response.status(400).json({ error: error.code, message: error.message }); return; }
      next(error);
    }
  });

  router.post("/:id/recover", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const result = await db.query<{ id: string; requestId: string; status: string; operationType: string; upstreamTaskId: string | null; submissionStartedAt: string | null; attempts: number; priority: TaskPriority; queuedAt: string; availableAt: string }>(
        `SELECT ${taskSelect},t.available_at AS "availableAt" FROM tasks t JOIN users u ON u.id=t.user_id WHERE t.id=$1 AND t.user_id=$2`,
        [request.params.id, actor.id],
      );
      const task = result.rows[0];
      if (!task) {
        response.status(404).json({ error: "NOT_FOUND", message: "任务不存在" });
        return;
      }
      const canPollOriginalTask = Boolean(task.upstreamTaskId);
      let recovered = false;
      if (task.status === "waiting" && ((!task.submissionStartedAt && task.attempts === 0) || canPollOriginalTask)) {
        await scheduleQueuedTask(cache, task.id, queueScore(task.priority, new Date(task.queuedAt).getTime()), new Date(task.availableAt).getTime());
        recovered = true;
      } else if (task.status === "paused" && canPollOriginalTask) {
        recovered = Boolean(await transitionTask(db, cache, task.id, "resume", false));
        if (recovered) task.status = "waiting";
      }
      response.json({ task, recovered, message: recovered ? "已恢复原任务，未创建新任务或重新扣费" : task.status === "processing" ? "原任务仍在处理中，未重复提交" : "已读取原任务状态；此状态不会自动重新生成" });
    } catch (error) { next(error); }
  });

  router.post("/", async (request, response, next) => {
    try {
      const creditsEnabled = typeof creditPolicy === "function" ? await creditPolicy() : creditPolicy;
      const input = singleSchema.parse(request.body);
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
      if (options.promptCompiler) {
        const existing = (await db.query(`SELECT ${taskSelect} FROM tasks t JOIN users u ON u.id=t.user_id WHERE t.request_id=$1 AND t.user_id=$2`, [input.requestId, actor.id])).rows[0];
        if (existing) { response.status(200).json({ task: existing }); return; }
      }
      const prepared = await prepare(actor, input);
      const task = await enqueueTask(db, cache, {
          ...prepared,
          creditsEnabled,
          maxInflightTasks: options.maxInflightTasks,
          userId: actor.id,
          departmentId: actor.departmentId,
        });
      response.status(201).json({ task: { ...task, prompt: prepared.prompt, userInput: "userInput" in prepared ? prepared.userInput : null, optimized: prepared.optimized } });
    } catch (error) {
      if (error instanceof BillingError) {
        response
          .status(error.code === "USER_TASK_LIMIT_REACHED" ? 429 : 400)
          .json({ error: error.code, message: error.message });
        return;
      }
      next(error);
    }
  });

  router.post("/batch", async (request, response, next) => {
    let admission: { id: string; owner: BatchAdmissionToken } | undefined;
    try {
      const creditsEnabled = typeof creditPolicy === "function" ? await creditPolicy() : creditPolicy;
      const input = batchSchema.parse(request.body);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      if (input.priority !== "normal" && actor.role === "designer") {
        response.status(403).json({ error: "FORBIDDEN", message: "设计师只能提交普通任务" });
        return;
      }
      if (input.priority === "urgent" && actor.role !== "super_admin") { response.status(403).json({ error: "FORBIDDEN", message: "仅超级管理员可提交紧急任务" }); return; }
      const inputHash = promptHash(input);
      const existing = await findBatchForSubmission(db, input.requestId, actor.id, inputHash);
      if (existing) { response.status(options.promptCompiler ? 200 : 201).json(await existingBatchResult(input.requestId, actor.id)); return; }
      // Fail global per-item request collisions before invoking the optimizer.
      const collision = await db.query("SELECT id FROM tasks WHERE request_id=ANY($1::text[]) LIMIT 1", [input.items.map((_, index) => `${input.requestId}:${index}`)]);
      if (collision.rows[0]) throw new BillingError("DUPLICATE_REQUEST", "请求编号已被其他任务占用");
      if (input.promptInput && input.promptInput.scene !== "batch-optimize") throw new PromptOptimizationError("PROMPT_RECIPE_MISMATCH", "批处理仅支持批量优化配方");
      const execution = await resolveToolExecution(db, input);
      input.toolKey = execution.toolKey;
      input.modelConfigId = execution.modelConfigId;
      input.parameters = { ...input.parameters, tool: execution.toolKey };
      const priceSnapshot = await loadTaskPriceSnapshot(db, { ...input, toolConfiguration: execution, quantity: 1, creditsEnabled });
      // One representative input, one compilation. All items receive the same trusted result.
      const prepared = await prepare(actor, { ...input, sourceUrls: input.items[0]!.sourceUrls });
      input.prompt = prepared.prompt;
      input.parameters = prepared.parameters;
      const claimed = await claimBatchAdmission(db, { ...input, userId: actor.id, departmentId: actor.departmentId, totalItems: input.items.length, modelConfigId: execution.modelConfigId, toolKey: execution.toolKey, inputHash });
      if (!claimed.claimed) { response.status(options.promptCompiler ? 200 : 201).json(await existingBatchResult(input.requestId, actor.id)); return; }
      const batchId = claimed.batch.id;
      admission = { id: batchId, owner: claimed.token };
      for (const [index, item] of input.items.entries()) {
        try {
          await enqueueTask(db, cache, {
            ...prepared,
            toolConfiguration: execution,
            priceSnapshot,
            creditsEnabled,
            maxInflightTasks: options.maxInflightTasks,
            requestId: `${input.requestId}:${index}`,
            sourceUrls: item.sourceUrls,
            userId: actor.id,
            departmentId: actor.departmentId,
            batchId,
            batchAdmission: admission.owner,
          });
        } catch (error) {
          if (error instanceof PromptOptimizationError && error.code === "BATCH_SUBMISSION_INTERRUPTED") throw error;
          const reason =
            error instanceof Error ? error.message : "任务创建失败";
          const code = error instanceof BillingError ? error.code : "TASK_CREATION_FAILED";
          const itemRequestId = `${input.requestId}:${index}`;
          const existing = await db.query<{ id: string; userId: string; batchId: string | null; requestId: string; status: string; credits: number; rmbCost: number }>(
            `SELECT id,user_id AS "userId",batch_id AS "batchId",request_id AS "requestId",status,credits,rmb_cost::float8 AS "rmbCost" FROM tasks WHERE request_id=$1`,
            [itemRequestId],
          );
          const committed = existing.rows[0];
          if (committed) {
            if (committed.userId !== actor.id || committed.batchId !== batchId) {
              throw new BillingError("DUPLICATE_REQUEST", "请求编号已被其他任务占用");
            }
            // Queue delivery happens after SQL commits. Preserve the admitted
            // task and its hold. Worker reconciliation or explicit task recovery
            // may restore queue membership; batch GET/POST never replay admission.
            await recordBatchAdmissionFailure(db, batchId, admission.owner, { index, reason, code, admitted: true });
            continue;
          }
          // An unknown database/process failure does not prove the next item was safely rejected.
          // Close admission and let GET report missing indexes; never continue the whole batch.
          if (!(error instanceof BillingError)) throw error;
          const failedId = randomUUID();
          await withTransaction(db, async (client) => {
            await fenceBatchAdmission(
              client,
              batchId,
              actor.id,
              admission!.owner,
            );
            const failed = await client.query<{ id: string }>(
              `INSERT INTO tasks(id,request_id,batch_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,priority,status,credits,rmb_cost,failure_reason,completed_at,tool_key)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'failed',0,0,$13,now(),$14)
               ON CONFLICT(request_id) DO NOTHING RETURNING id`,
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
                execution.toolKey,
              ],
            );
            if (!failed.rows[0])
              throw new BillingError(
                "DUPLICATE_REQUEST",
                "请求编号已被其他任务占用",
              );
            await client.query(
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
            await recordBatchAdmissionFailure(
              client,
              batchId,
              admission!.owner,
              { index, reason, code, admitted: false },
            );
          });
        }
      }
      await finishBatchAdmission(db, batchId, admission.owner);
      response.status(201).json({ ...(await existingBatchResult(input.requestId, actor.id)), prompt: prepared.prompt, optimized: prepared.optimized });
    } catch (error) {
      if (admission) {
        const owned = admission;
        await finishBatchAdmission(db, owned.id, owned.owner, true).then(() => recalculateBatch(db, owned.id)).catch(() => undefined);
      }
      if (error instanceof BillingError) {
        response.status(400).json({ error: error.code, message: error.message });
        return;
      }
      next(error);
    }
  });

  router.get("/batches/by-request/:requestId", async (request, response, next) => {
    response.set("Cache-Control", "private, no-store");
    try {
      const result = await existingBatchResult(String(request.params.requestId), (request as unknown as AuthenticatedRequest).auth.id);
      if (!result) { response.status(404).json({ error: "NOT_FOUND", message: "批次不存在" }); return; }
      response.json(result);
    } catch (error) { next(error); }
  });

  router.get("/", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const page = await readTaskPage(db, request.query, ["t.user_id=$1"], [actor.id]);
      response.json({ tasks: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch (error) {
      next(error);
    }
  });

  router.get("/batches", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const page = await readBatchPage(db, request.query, ["b.user_id=$1"], [actor.id]);
      response.json({ batches: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch (error) {
      next(error);
    }
  });

  router.get("/by-request/:requestId", async (request, response, next) => {
    response.set("Cache-Control", "private, no-store");
    try {
      const requestId = singleSchema.shape.requestId.parse(request.params.requestId);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const result = await db.query(
        `SELECT ${taskSelect} FROM tasks t JOIN users u ON u.id=t.user_id WHERE t.request_id=$1 AND t.user_id=$2`,
        [requestId, actor.id],
      );
      if (!result.rows[0]) {
        response.status(404).json({ error: "NOT_FOUND", message: "任务不存在或无权访问" });
        return;
      }
      response.json({ task: result.rows[0] });
    } catch (error) { next(error); }
  });

  router.get("/:id/progress", async (request, response, next) => {
    response.set("Cache-Control", "private, no-store");
    try {
      const id = z.string().uuid().parse(request.params.id);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const progress = await readTaskProgress(db, cache, id, actor.id);
      if (!progress) {
        response.status(404).json({ error: "NOT_FOUND", message: "任务不存在或无权访问" });
        return;
      }
      response.json({ progress });
    } catch (error) { next(error); }
  });

  router.get("/:id", async (request, response, next) => {
    try {
      const id = z.string().uuid().parse(request.params.id);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const result = await db.query(
        `SELECT ${taskSelect} FROM tasks t JOIN users u ON u.id=t.user_id WHERE t.id=$1 AND t.user_id=$2`,
        [id, actor.id],
      );
      if (!result.rows[0]) {
        response.status(404).json({ error: "NOT_FOUND", message: "任务不存在或无权访问" });
        return;
      }
      response.json({ task: result.rows[0] });
    } catch (error) { next(error); }
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
      const clauses =
        actor.role === "department_admin"
          ? (values.push(actor.departmentId), ["t.department_id=$1"])
          : [];
      const page = await readTaskPage(db, request.query, clauses, values);
      response.json({ tasks: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch (error) {
      next(error);
    }
  });

  router.get("/batches", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const values: unknown[] = [];
      const clauses =
        actor.role === "department_admin"
          ? (values.push(actor.departmentId), ["b.department_id=$1"])
          : [];
      const page = await readBatchPage(db, request.query, clauses, values);
      response.json({ batches: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const id = z.string().uuid().parse(request.params.id);
      const values: unknown[] = [id];
      const scope = actor.role === "department_admin" ? (values.push(actor.departmentId), "AND t.department_id=$2") : "";
      const result = await db.query(`SELECT ${taskSelect} FROM tasks t JOIN users u ON u.id=t.user_id WHERE t.id=$1 ${scope}`, values);
      if (!result.rows[0]) { response.status(404).json({ error: "NOT_FOUND", message: "任务不存在或无权访问" }); return; }
      response.json({ task: result.rows[0] });
    } catch (error) { next(error); }
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

function appendCursor(clauses: string[], values: unknown[], column: string, idColumn: string, cursor: { createdAt: string; id: string } | null) {
  if (!cursor) return;
  values.push(cursor.createdAt, z.string().uuid().parse(cursor.id));
  clauses.push(`(${column},${idColumn})<($${values.length - 1}::timestamptz,$${values.length}::uuid)`);
}

async function readTaskPage(db: Database, query: unknown, clauses: string[], values: unknown[]) {
  const page = parseCursorPage(query);
  const filters = z.object({ ids: z.string().max(7500).optional(), operationType: z.string().min(1).max(80).optional() }).parse(query);
  const ids = filters.ids ? z.array(z.string().uuid()).min(1).max(200).parse(filters.ids.split(",")) : null;
  if (ids) { values.push(ids); clauses.push(`t.id=ANY($${values.length}::uuid[])`); }
  if (filters.operationType) { values.push(filters.operationType); clauses.push(`t.operation_type=$${values.length}`); }
  if (!ids) appendCursor(clauses, values, "t.queued_at", "t.id", page.cursor);
  const limit = ids?.length ?? page.limit;
  values.push(limit + 1);
  const result = await db.query(`SELECT ${ids ? taskSelect : taskSummarySelect},to_char(t.queued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt" FROM tasks t JOIN users u ON u.id=t.user_id ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY t.queued_at DESC,t.id DESC LIMIT $${values.length}`, values);
  const output = makeCursorPage(result.rows, limit, (row) => ({ createdAt: row.cursorCreatedAt as string, id: row.id as string }));
  return { ...output, items: output.items.map(({ cursorCreatedAt: _cursor, ...row }) => row) };
}

async function readBatchPage(db: Database, query: unknown, clauses: string[], values: unknown[]) {
  const { cursor, limit } = parseCursorPage(query);
  appendCursor(clauses, values, "b.created_at", "b.id", cursor);
  values.push(limit + 1);
  const result = await db.query(`SELECT ${batchSelect},to_char(b.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt" FROM batch_tasks b JOIN users u ON u.id=b.user_id LEFT JOIN model_configs m ON m.id=b.model_config_id ${batchStatsJoin} ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY b.created_at DESC,b.id DESC LIMIT $${values.length}`, values);
  const output = makeCursorPage(result.rows, limit, (row) => ({ createdAt: row.cursorCreatedAt as string, id: row.id as string }));
  return { ...output, items: output.items.map(({ cursorCreatedAt: _cursor, ...row }) => row) };
}

function mockSvg(id: string) {
  const hue = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="hsl(${hue} 65% 46%)"/><circle cx="512" cy="440" r="260" fill="hsl(${(hue + 45) % 360} 75% 70%)"/><path d="M180 820L410 560l150 150 110-120 174 230z" fill="white" opacity=".85"/><text x="512" y="940" text-anchor="middle" font-family="sans-serif" font-size="38" fill="white">Wireless Canvas QA ${id.slice(0, 8)}</text></svg>`;
}
