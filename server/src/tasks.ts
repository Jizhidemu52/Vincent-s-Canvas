import { randomUUID } from "node:crypto";
import { BillingError, reserveCredits, settleReservation } from "./billing";
import type { Cache, Database } from "./db";

export type TaskPriority = "normal" | "priority" | "urgent";
export type QueueTaskAction = "pause" | "resume" | "cancel";
export type TaskInput = {
  requestId: string;
  userId: string;
  departmentId: string | null;
  projectId: string;
  operationType: string;
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
export function queueScore(priority: TaskPriority, timestamp = Date.now()) {
  return priorityBand[priority] * 1_000_000_000_000_000 + timestamp;
}

export async function enqueueTask(
  db: Database,
  cache: Cache,
  input: TaskInput,
) {
  const taskId = randomUUID();
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO tasks(id,request_id,batch_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,priority,credits,rmb_cost)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,0)
         ON CONFLICT(request_id) DO NOTHING RETURNING id`,
    [
      taskId,
      input.requestId,
      input.batchId ?? null,
      input.userId,
      input.departmentId,
      input.projectId,
      input.operationType,
      input.modelConfigId ?? null,
      input.prompt,
      input.parameters ?? {},
      JSON.stringify(input.sourceUrls),
      input.priority,
    ],
  );
  if (!inserted.rows[0]) {
    const existing = await db.query<{
      id: string;
      requestId: string;
      status: string;
      credits: number;
      rmbCost: number;
    }>(
      `SELECT id,request_id AS "requestId",status,credits,rmb_cost::float8 AS "rmbCost" FROM tasks WHERE request_id=$1 AND user_id=$2`,
      [input.requestId, input.userId],
    );
    if (!existing.rows[0])
      throw new BillingError("DUPLICATE_REQUEST", "请求编号已被其他账号占用");
    return existing.rows[0];
  }
  try {
    const reservation = await reserveCredits(db, {
      requestId: input.requestId,
      userId: input.userId,
      operationType: input.operationType,
      modelConfigId: input.modelConfigId,
      quantity: 1,
    });
    await db.query(
      "UPDATE tasks SET credits=$1,rmb_cost=$2,updated_at=now() WHERE id=$3",
      [reservation.credits, reservation.rmbCost, taskId],
    );
    await cache.zAdd("tasks:queue", {
      score: queueScore(input.priority),
      value: taskId,
    });
    return {
      id: taskId,
      requestId: input.requestId,
      status: "waiting",
      credits: reservation.credits,
      rmbCost: reservation.rmbCost,
    };
  } catch (error) {
    await db
      .query("DELETE FROM tasks WHERE id=$1", [taskId])
      .catch(() => undefined);
    await settleReservation(db, input.requestId, "release", input.userId).catch(
      () => undefined,
    );
    throw error;
  }
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
  const current = await db.query<{
    id: string;
    request_id: string;
    batch_id: string | null;
    status: string;
    priority: TaskPriority;
  }>(
    "SELECT id,request_id,batch_id,status,priority FROM tasks WHERE id=$1 AND status IN ('waiting','paused')",
    [taskId],
  );
  const task = current.rows[0];
  if (
    !task ||
    (action === "pause" && task.status !== "waiting") ||
    (action === "resume" && task.status !== "paused")
  )
    return null;

  if (action === "pause") {
    const changed = await db.query(
      "UPDATE tasks SET status='paused',updated_at=now() WHERE id=$1 AND status='waiting' RETURNING id",
      [taskId],
    );
    if (!changed.rows[0]) return null;
    await cache.zRem("tasks:queue", taskId);
  } else if (action === "resume") {
    const changed = await db.query(
      "UPDATE tasks SET status='waiting',queued_at=now(),updated_at=now() WHERE id=$1 AND status='paused' RETURNING id",
      [taskId],
    );
    if (!changed.rows[0]) return null;
    try {
      await cache.zAdd("tasks:queue", {
        score: queueScore(task.priority),
        value: taskId,
      });
    } catch (error) {
      await db
        .query(
          "UPDATE tasks SET status='paused',updated_at=now() WHERE id=$1 AND status='waiting'",
          [taskId],
        )
        .catch(() => undefined);
      throw error;
    }
  } else {
    const changed = await db.query(
      "UPDATE tasks SET status='cancelled',completed_at=now(),updated_at=now() WHERE id=$1 AND status=$2 RETURNING id",
      [taskId, task.status],
    );
    if (!changed.rows[0]) return null;
    try {
      await settleReservation(db, task.request_id, "release");
    } catch (error) {
      await db
        .query(
          "UPDATE tasks SET status=$1,completed_at=NULL,updated_at=now() WHERE id=$2 AND status='cancelled'",
          [task.status, taskId],
        )
        .catch(() => undefined);
      if (task.status === "waiting")
        await cache
          .zAdd("tasks:queue", {
            score: queueScore(task.priority),
            value: taskId,
          })
          .catch(() => undefined);
      throw error;
    }
    await cache.zRem("tasks:queue", taskId);
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
