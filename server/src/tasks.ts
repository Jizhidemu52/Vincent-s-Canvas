import { randomUUID } from "node:crypto";
import { singleImageTaskParameters } from "./image-task-policy";
import { BillingError, reserveCredits, settleReservation, type PriceSnapshot } from "./billing";
import type { Cache, Database } from "./db";
import { withTransaction } from "./db-transaction";
import { preflightStoredVideoTask } from "./stored-video-preflight";
import { resolveToolExecution, type ToolConfiguration } from "./tool-configuration";
import { removeQueuedTask, scheduleQueuedTask } from "./task-queue";

export type TaskPriority = "normal" | "priority" | "urgent";
export type QueueTaskAction = "pause" | "resume" | "cancel";
export type TaskInput = {
  creditsEnabled?: boolean;
  /** Server-only admission policy, never accepted from the request body. */
  maxInflightTasks?: number;
  requestId: string;
  userId: string;
  departmentId: string | null;
  projectId: string;
  operationType: string;
  toolKey?: string;
  /** Trusted, server-resolved batch snapshot; never parsed from a request body. */
  toolConfiguration?: ToolConfiguration & { modelConfigId: string };
  priceSnapshot?: PriceSnapshot;
  modelConfigId?: string | null;
  prompt: string;
  parameters?: Record<string, unknown>;
  sourceUrls: string[];
  priority: TaskPriority;
  batchId?: string | null;
};
export type BatchTaskCounts = {
  total: number;
  success: number;
  failed: number;
  cancelled: number;
  paused: number;
  waiting: number;
  processing: number;
};

const priorityBand: Record<TaskPriority, number> = {
  urgent: 0,
  priority: 1,
  normal: 2,
};
export const TASK_LEASE_SECONDS = 180;

export function canAutomaticallyRetryTask(operationType: string, submissionStartedAt: string | null, attempts: number) {
  // Only video pre-submission preparation is automatically retried. Async images
  // with a persisted ID recover by polling that ID, never by repeating this work.
  return operationType === "video_generation" && !submissionStartedAt && attempts < 3;
}

export function queueScore(priority: TaskPriority, timestamp = Date.now()) {
  return priorityBand[priority] * 1_000_000_000_000_000 + timestamp;
}

/**
 * Redis is an acceleration layer, not the task source of truth. Rebuild its
 * waiting members from Postgres after a worker restart, and return only
 * expired known-upstream leases to parked polling, and safe pre-submit work to
 * waiting. Other interrupted work is paused because its outcome is unknown.
 */
export async function restoreWaitingTasksToQueue(db: Database, cache: Cache) {
  await db.query(
    `UPDATE tasks
        SET status=CASE WHEN upstream_task_id IS NOT NULL THEN 'processing'
              WHEN upstream_submission_started_at IS NULL AND (operation_type='video_generation' OR attempts=0) THEN 'waiting' ELSE 'paused' END,
            failure_reason=CASE WHEN upstream_task_id IS NOT NULL OR (upstream_submission_started_at IS NULL AND (operation_type='video_generation' OR attempts=0)) THEN failure_reason
              ELSE '执行中断，原上游提交状态待核实；已暂停，不能直接恢复或自动重新生成' END,
            execution_token=NULL,lease_expires_at=NULL,updated_at=now()
      WHERE status='processing' AND (execution_token IS NOT NULL OR upstream_task_id IS NULL)
        AND (lease_expires_at IS NULL OR lease_expires_at <= now())`,
  );
  const pending = await db.query<{ id: string; priority: TaskPriority; queued_at: string; available_at: string }>(
    `SELECT id,priority,queued_at,available_at FROM tasks WHERE status='waiting'
       OR (status='processing' AND execution_token IS NULL AND upstream_task_id IS NOT NULL) ORDER BY queued_at,id`,
  );
  for (let offset = 0; offset < pending.rows.length; offset += 64) {
    await Promise.all(pending.rows.slice(offset, offset + 64).map((task) =>
      scheduleQueuedTask(cache, task.id, queueScore(task.priority, new Date(task.queued_at).getTime()), new Date(task.available_at).getTime()),
    ));
  }
  return pending.rows.length;
}

export async function enqueueTask(
  db: Database,
  cache: Cache,
  input: TaskInput,
) {
  input.parameters = singleImageTaskParameters(input.operationType, input.parameters);
  const taskId = randomUUID();
  const task = await withTransaction(db, async (client) => {
    // Count and admission must share one per-user transaction lock. In particular,
    // a parallel batch cannot make every item observe the same remaining slot.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('user-inflight-quota'),hashtext($1))", [input.userId]);
    const findExisting = async () => {
      const existing = await client.query<{
        id: string; requestId: string; status: string; credits: number; rmbCost: number;
        priority: TaskPriority; availableAt: string; queuedAt: string;
      }>(
        `SELECT id,request_id AS "requestId",status,priority,available_at AS "availableAt",queued_at AS "queuedAt",credits,rmb_cost::float8 AS "rmbCost" FROM tasks WHERE request_id=$1 AND user_id=$2`,
        [input.requestId, input.userId],
      );
      const original = existing.rows[0];
      return original ? {
        task: original, shouldQueue: original.status === "waiting", queuePriority: original.priority,
        queueAvailableAt: new Date(original.availableAt).getTime(), queueTimestamp: new Date(original.queuedAt).getTime(),
      } : null;
    };
    const existing = await findExisting();
    if (existing) return existing;
    const maxInflightTasks = input.maxInflightTasks ?? 100;
    if (!Number.isInteger(maxInflightTasks) || maxInflightTasks < 1 || maxInflightTasks > 1000) {
      throw new Error("Invalid server-side in-flight task limit");
    }
    const active = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM tasks WHERE user_id=$1 AND status IN ('waiting','processing','paused')", [input.userId],
    );
    if (active.rows[0]!.count >= maxInflightTasks) {
      throw new BillingError("USER_TASK_LIMIT_REACHED", `在途任务已达到 ${maxInflightTasks} 个上限，请等待任务完成或取消未提交的任务`);
    }
    const inserted = await client.query<{ id: string; queuedAt: string; availableAt: string }>(
      `INSERT INTO tasks(id,request_id,batch_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,priority,credits,rmb_cost)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,0)
           ON CONFLICT(request_id) DO NOTHING RETURNING id,queued_at AS "queuedAt",available_at AS "availableAt"`,
      [
        taskId,
        input.requestId,
        input.batchId ?? null,
        input.userId,
        input.departmentId,
        input.projectId,
        input.operationType,
        // The authoritative binding is validated below, before assigning the FK.
        null,
        input.prompt,
        input.parameters ?? {},
        JSON.stringify(input.sourceUrls),
        input.priority,
      ],
    );
    if (!inserted.rows[0]) {
      const duplicate = await findExisting();
      if (!duplicate) throw new BillingError("DUPLICATE_REQUEST", "请求编号已被其他账号占用");
      return duplicate;
    }
    const execution = input.toolConfiguration ?? await resolveToolExecution(client, input);
    input.modelConfigId = execution.modelConfigId;
    input.toolKey = execution.toolKey;
    input.parameters = { ...input.parameters, tool: execution.toolKey };
    await client.query("UPDATE tasks SET model_config_id=$1,tool_key=$2,parameters=$3 WHERE id=$4", [input.modelConfigId, input.toolKey, input.parameters, taskId]);
    if (input.operationType === "video_generation") {
      const checked = await preflightStoredVideoTask(client, input);
      input.parameters = { ...input.parameters, ...checked.normalized };
      await client.query("UPDATE tasks SET parameters=$1 WHERE id=$2", [input.parameters, taskId]);
    }
    const reservation = await reserveCredits(db, {
      requestId: input.requestId,
      userId: input.userId,
      operationType: input.operationType,
      modelConfigId: input.modelConfigId,
      toolConfiguration: execution,
      priceSnapshot: input.priceSnapshot,
      quantity: 1,
      creditsEnabled: input.creditsEnabled,
    }, client);
    await client.query(
      "UPDATE tasks SET credits=$1,rmb_cost=$2,updated_at=now() WHERE id=$3",
      [reservation.credits, reservation.rmbCost, taskId],
    );
    return {
      task: {
        id: taskId,
        requestId: input.requestId,
        status: "waiting",
        toolKey: execution.toolKey,
        modelConfigId: execution.modelConfigId,
        credits: reservation.credits,
        rmbCost: reservation.rmbCost,
      },
      shouldQueue: true,
      queuePriority: input.priority,
      queueAvailableAt: new Date(inserted.rows[0].availableAt).getTime(),
      queueTimestamp: new Date(inserted.rows[0].queuedAt).getTime(),
    };
  });
  if (task.shouldQueue) {
    await scheduleQueuedTask(cache, task.task.id, queueScore(task.queuePriority, task.queueTimestamp), task.queueAvailableAt);
  }
  return task.task;
}

export async function recalculateBatch(db: Database, batchId: string) {
  const result = await db.query<BatchTaskCounts>(
    `SELECT COUNT(*)::int total,
        COUNT(*) FILTER (WHERE status='success')::int success,COUNT(*) FILTER (WHERE status='failed')::int failed,
        COUNT(*) FILTER (WHERE status='cancelled')::int cancelled,COUNT(*) FILTER (WHERE status='paused')::int paused,
        COUNT(*) FILTER (WHERE status='waiting')::int waiting,COUNT(*) FILTER (WHERE status='processing')::int processing
        FROM tasks WHERE batch_id=$1`,
    [batchId],
  );
  const counts = result.rows[0]!;
  const status = deriveBatchStatus(counts);
  await db.query(
    "UPDATE batch_tasks SET status=$1,completed_items=$2,failed_items=$3,updated_at=now() WHERE id=$4",
    [status, counts.success, counts.failed, batchId],
  );
}

export function deriveBatchStatus(counts: BatchTaskCounts) {
  if (counts.processing > 0) return "processing";
  if (counts.waiting > 0)
    return counts.success + counts.failed + counts.cancelled + counts.paused > 0
      ? "processing"
      : "waiting";
  if (counts.paused > 0) return "paused";
  if (counts.total > 0 && counts.success === counts.total) return "success";
  if (counts.total > 0 && counts.cancelled === counts.total) return "cancelled";
  if (counts.total > 0 && counts.failed === counts.total) return "failed";
  return "partial";
}

export async function transitionTask(
  db: Database,
  cache: Cache,
  taskId: string,
  action: QueueTaskAction,
  recalculate = true,
) {
  if (action === "cancel") {
    const task = await withTransaction(db, async client => {
      const current = await client.query<{
        id: string; request_id: string; batch_id: string | null; status: string;
        operation_type: string; attempts: number; upstream_task_id: string | null;
        upstream_submission_started_at: string | null; model_config_id: string | null; model_slot_token: string | null;
      }>(
        `SELECT id,request_id,batch_id,status,operation_type,attempts,upstream_task_id,upstream_submission_started_at,model_config_id,model_slot_token
         FROM tasks WHERE id=$1 AND status IN ('waiting','paused') FOR UPDATE`, [taskId],
      );
      const currentTask = current.rows[0];
      // Lock the task before inspecting the submission boundary, so a worker
      // cannot claim it between validation and settlement. Unknown work stays held.
      if (!currentTask || currentTask.upstream_task_id || currentTask.upstream_submission_started_at
        || (currentTask.operation_type !== "video_generation" && currentTask.attempts > 0)) return null;
      const changed = await client.query(
        `UPDATE tasks SET status='cancelled',completed_at=now(),execution_token=NULL,lease_expires_at=NULL,
          model_slot_token=NULL,model_slot_expires_at=NULL,updated_at=now()
         WHERE id=$1 AND status=$2 AND upstream_task_id IS NULL AND upstream_submission_started_at IS NULL
           AND (operation_type='video_generation' OR attempts=0) RETURNING id`, [taskId, currentTask.status],
      );
      if (!changed.rows[0]) return null;
      const settlement = await settleReservation(db, currentTask.request_id, "release", undefined, client);
      if (settlement.status !== "released") throw new BillingError("INVALID_TASK_STATE", "已结算任务不能取消或退费");
      return currentTask;
    });
    if (!task) return null;
    // A stale cache member is safe: the worker checks the durable task status.
    // Cache failure must never roll back or report failure for a committed refund.
    await removeQueuedTask(cache, taskId).catch(() => undefined);
    if (task.model_slot_token) await cache.zRem(`model:${task.model_config_id ?? "none"}:leases`, `${taskId}:${task.model_slot_token}`).catch(() => undefined);
    if (recalculate && task.batch_id) await recalculateBatch(db, task.batch_id);
    return { id: task.id, batchId: task.batch_id, previousStatus: task.status, action };
  }
  const current = await db.query<{
    id: string;
    request_id: string;
    batch_id: string | null;
    status: string;
    priority: TaskPriority;
    queued_at: string;
    operation_type: string;
    attempts: number;
    upstream_task_id: string | null;
    upstream_submission_started_at: string | null;
  }>(
    "SELECT id,request_id,batch_id,status,priority,queued_at,operation_type,attempts,upstream_task_id,upstream_submission_started_at FROM tasks WHERE id=$1 AND status IN ('waiting','paused')",
    [taskId],
  );
  const task = current.rows[0];
  if (
    !task ||
    (action === "pause" && task.status !== "waiting") ||
    (action === "resume" && (task.status !== "paused" || (!task.upstream_task_id && (task.upstream_submission_started_at || (task.operation_type !== "video_generation" && task.attempts > 0)))))
  )
    return null;

  if (action === "pause") {
    const changed = await db.query(
      "UPDATE tasks SET status='paused',updated_at=now() WHERE id=$1 AND status='waiting' RETURNING id",
      [taskId],
    );
    if (!changed.rows[0]) return null;
    await removeQueuedTask(cache, taskId);
  } else if (action === "resume") {
    const changed = await db.query(
      "UPDATE tasks SET status='waiting',available_at=now(),execution_token=NULL,lease_expires_at=NULL,poll_deadline_at=CASE WHEN operation_type='video_generation' AND upstream_task_id IS NOT NULL THEN now()+interval '20 minutes' ELSE poll_deadline_at END,updated_at=now() WHERE id=$1 AND status='paused' AND (upstream_task_id IS NOT NULL OR (upstream_submission_started_at IS NULL AND (operation_type='video_generation' OR attempts=0))) RETURNING id",
      [taskId],
    );
    if (!changed.rows[0]) return null;
    try {
      await scheduleQueuedTask(cache, taskId, queueScore(task.priority, new Date(task.queued_at).getTime()));
    } catch (error) {
      await db
        .query(
          "UPDATE tasks SET status='paused',updated_at=now() WHERE id=$1 AND status='waiting'",
          [taskId],
        )
        .catch(() => undefined);
      throw error;
    }
  }

  if (recalculate && task.batch_id) await recalculateBatch(db, task.batch_id);
  return {
    id: task.id,
    batchId: task.batch_id,
    previousStatus: task.status,
    action,
  };
}

export async function transitionBatchTasks(
  db: Database,
  cache: Cache,
  batchId: string,
  action: QueueTaskAction,
) {
  const statuses =
    action === "pause"
      ? ["waiting"]
      : action === "resume"
        ? ["paused"]
        : ["waiting", "paused"];
  const tasks = await db.query<{ id: string }>(
    "SELECT id FROM tasks WHERE batch_id=$1 AND status=ANY($2::text[]) ORDER BY queued_at,id",
    [batchId, statuses],
  );
  let changed = 0;
  for (const task of tasks.rows) {
    if (await transitionTask(db, cache, task.id, action, false)) changed += 1;
  }
  await recalculateBatch(db, batchId);
  return changed;
}

export { BillingError };
