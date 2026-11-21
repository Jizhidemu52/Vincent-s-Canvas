import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX } from "../../shared/generation-error";
import { singleImageTaskParameters } from "./image-task-policy";
import { BillingError, reserveCredits, settleReservation, type PriceSnapshot } from "./billing";
import type { Cache, Database } from "./db";
import { withTransaction } from "./db-transaction";
import { preflightStoredVideoTask, validateStoredVideoPreflightSnapshot } from "./stored-video-preflight";
import { resolveToolExecution, type ToolConfiguration } from "./tool-configuration";
import { removeQueuedTask, scheduleQueuedTask } from "./task-queue";
import type { PromptInput } from "../../shared/prompt-contracts";
import { fenceBatchAdmission, type BatchAdmissionToken } from "./batch-admission";
import { QUICK_IMAGE_SNAPSHOT, type QuickImageSnapshot } from "./quick-image-tools";
import { prepareConfiguredQuickImageTask } from "./quick-image-configuration";
import { preflightStoredQuickImageTask, validateStoredQuickImageSnapshot } from "./stored-quick-image-preflight";
import { preflightStoredSeedream55Task, validateStoredSeedream55Snapshot } from "./stored-seedream55-preflight";
import { layerStudioTaskOptions } from "../../shared/layer-studio-options";
import { seedream55TaskOptions } from "../../shared/seedream55-options";
import { layerStudioCostEstimate, loadLayerStudioPriceSnapshot } from "./layer-studio-billing";

export type TaskPriority = "normal" | "priority" | "urgent";
export type QueueTaskAction = "pause" | "resume" | "cancel";
export type TaskInput = {
  [QUICK_IMAGE_SNAPSHOT]?: QuickImageSnapshot;
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
  /** Trusted source preflight completed before prompt compilation; never accepted from HTTP. */
  videoPreflightResult?: Awaited<ReturnType<typeof preflightStoredVideoTask>>;
  /** Trusted original-byte preflight before prompt compilation; never accepted from HTTP. */
  seedreamPreflightResult?: Awaited<ReturnType<typeof preflightStoredSeedream55Task>>;
  priceSnapshot?: PriceSnapshot;
  modelConfigId?: string | null;
  prompt: string;
  userInput?: PromptInput;
  promptCompilationId?: string;
  optimized?: boolean;
  parameters?: Record<string, unknown>;
  sourceUrls: string[];
  priority: TaskPriority;
  batchId?: string | null;
  /** Server-only fenced batch owner; never accepted from task request JSON. */
  batchAdmission?: BatchAdmissionToken;
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
            paused_kind=CASE WHEN upstream_task_id IS NULL AND upstream_submission_started_at IS NOT NULL THEN 'submission_unknown'
              WHEN upstream_task_id IS NULL AND attempts>0 AND operation_type<>'video_generation' THEN 'needs_review' ELSE paused_kind END,
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

export type EnqueuedTask = {
  id: string; requestId: string; status: string; credits: number; rmbCost: number;
  toolKey?: string; modelConfigId?: string | null;
};
export type EnqueuedTaskResult = {
  task: EnqueuedTask;
  shouldQueue: boolean;
  queuePriority: TaskPriority;
  queueAvailableAt: number;
  queueTimestamp: number;
};
export type PreparedTaskEnqueue = Readonly<{
  db: Database;
  taskId: string;
  input: TaskInput;
  execution?: ToolConfiguration & { modelConfigId: string };
  quickImage?: Awaited<ReturnType<typeof preflightStoredQuickImageTask>>;
  layer?: Awaited<ReturnType<typeof preflightStoredSeedream55Task>>;
  video?: Awaited<ReturnType<typeof preflightStoredVideoTask>>;
}>;

function freezeTaskData<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeTaskData(item);
    Object.freeze(value);
  }
  return value;
}

async function findEnqueuedTask(db: Pick<Database, "query">, input: TaskInput): Promise<EnqueuedTaskResult | null> {
  const existing = await db.query<EnqueuedTask & { priority: TaskPriority; availableAt: string; queuedAt: string }>(
    `SELECT id,request_id AS "requestId",status,priority,available_at AS "availableAt",queued_at AS "queuedAt",
       tool_key AS "toolKey",model_config_id AS "modelConfigId",credits,rmb_cost::float8 AS "rmbCost"
       FROM tasks WHERE request_id=$1 AND user_id=$2`, [input.requestId, input.userId],
  );
  const original = existing.rows[0];
  return original ? {
    task: original, shouldQueue: original.status === "waiting", queuePriority: original.priority,
    queueAvailableAt: new Date(original.availableAt).getTime(), queueTimestamp: new Date(original.queuedAt).getTime(),
  } : null;
}

async function assertTaskCapacity(db: Pick<Database, "query">, input: TaskInput) {
  if (input[QUICK_IMAGE_SNAPSHOT] && (await db.query("SELECT id FROM tasks WHERE request_id=$1", [input.requestId])).rows[0]) {
    throw new BillingError("DUPLICATE_REQUEST", "请求编号已被其他账号占用");
  }
  const maxInflightTasks = input.maxInflightTasks ?? 100;
  if (!Number.isInteger(maxInflightTasks) || maxInflightTasks < 1 || maxInflightTasks > 1000) {
    throw new Error("Invalid server-side in-flight task limit");
  }
  const active = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM tasks WHERE user_id=$1 AND status IN ('waiting','processing','paused')", [input.userId],
  );
  if (active.rows[0]!.count >= maxInflightTasks) {
    throw new BillingError("USER_TASK_LIMIT_REACHED", `在途任务已达到 ${maxInflightTasks} 个上限，请等待任务完成或取消未提交的任务`);
  }
}

async function isSeedreamExecution(db: Pick<Database, "query">, execution: ToolConfiguration & { modelConfigId: string }) {
  const model = (await db.query<{ modelId: string; protocol: string; workflowConfigId: string | null }>(
    `SELECT m.model_id AS "modelId",p.protocol,m.workflow_config_id AS "workflowConfigId"
      FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1`, [execution.modelConfigId])).rows[0];
  return model?.modelId === "seedream-5-5" && model.protocol === "apimart" && !model.workflowConfigId;
}

/** Acquire before conversation, turn, task and fee locks in a shared transaction. */
export async function lockTaskAdmission(client: PoolClient, userId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('user-inflight-quota'),hashtext($1))", [userId]);
}

export async function prepareTaskEnqueue(
  db: Database,
  input: TaskInput,
  videoPreflight = preflightStoredVideoTask,
  quickImagePreflight = preflightStoredQuickImageTask,
  layerStudioPreflight = preflightStoredSeedream55Task,
): Promise<PreparedTaskEnqueue> {
  input = { ...structuredClone(input), ...(input[QUICK_IMAGE_SNAPSHOT] ? { [QUICK_IMAGE_SNAPSHOT]: structuredClone(input[QUICK_IMAGE_SNAPSHOT]) } : {}) };
  const isLayerStudio = (input.toolKey ?? input.parameters?.tool) === "layer-studio";
  if (isLayerStudio) {
    if (input.operationType !== "image_generation" || input.userInput || input.batchId) throw new BillingError("INVALID_LAYER_TASK", "图层工具仅支持独立图片任务");
    try { layerStudioTaskOptions(input.parameters ?? {}, input.prompt, input.sourceUrls.length); }
    catch (error) { throw new BillingError("INVALID_LAYER_PARAMETERS", error instanceof Error ? error.message : "图层参数无效"); }
  }
  input = await prepareConfiguredQuickImageTask(db, input);
  input.parameters = singleImageTaskParameters(input.operationType, input.parameters);
  const taskId = randomUUID();
  if (await findEnqueuedTask(db, input)) return Object.freeze({ db, taskId, input: freezeTaskData(input) });
  try {
    await assertTaskCapacity(db, input);
  } catch (error) {
    if (error instanceof BillingError && ["USER_TASK_LIMIT_REACHED", "DUPLICATE_REQUEST"].includes(error.code)
      && await findEnqueuedTask(db, input)) return Object.freeze({ db, taskId, input: freezeTaskData(input) });
    throw error;
  }
  const execution = input.toolConfiguration ?? await resolveToolExecution(db, input);
  const isSeedream55 = await isSeedreamExecution(db, execution);
  if (isLayerStudio && (!isSeedream55 || execution.toolKey !== "layer-studio")) throw new BillingError("INVALID_LAYER_TASK", "图层工具配置不匹配");
  if (isSeedream55 && !isLayerStudio) {
    if (!["image_generation", "inpaint", "upscale", "batch_image", "seamless_stitch"].includes(input.operationType)) throw new BillingError("INVALID_IMAGE_TASK", "豆包生图仅支持图片生成或编辑任务");
    try { seedream55TaskOptions({ ...input.parameters, tool: execution.toolKey }, input.prompt, input.sourceUrls.length); }
    catch (error) { throw new BillingError("INVALID_IMAGE_PARAMETERS", error instanceof Error ? error.message : "图片参数无效"); }
  }
  const quickImage = input[QUICK_IMAGE_SNAPSHOT] ? await quickImagePreflight(db, input) : undefined;
  const layer = isSeedream55 ? input.seedreamPreflightResult ?? await layerStudioPreflight(db,
    { ...input, toolKey: execution.toolKey, parameters: { ...input.parameters, tool: execution.toolKey } }) : undefined;
  const video = input.operationType === "video_generation" ? input.videoPreflightResult && input.toolConfiguration
    ? input.videoPreflightResult : await videoPreflight(db,
      { ...input, modelConfigId: execution.modelConfigId, parameters: { ...input.parameters, tool: execution.toolKey } }) : undefined;
  if (input[QUICK_IMAGE_SNAPSHOT]) freezeTaskData(input[QUICK_IMAGE_SNAPSHOT]);
  return Object.freeze({ db, taskId, input: freezeTaskData(input), execution: freezeTaskData(execution),
    quickImage: freezeTaskData(quickImage), layer: freezeTaskData(layer), video: freezeTaskData(video) });
}

export async function enqueueTaskInTransaction(client: PoolClient, prepared: PreparedTaskEnqueue): Promise<EnqueuedTaskResult> {
  const { db, taskId, input } = prepared;
  if (input.batchAdmission) {
    if (!input.batchId) throw new Error("Batch admission token requires a batch ID");
    await fenceBatchAdmission(client, input.batchId, input.userId, input.batchAdmission);
  }
  await lockTaskAdmission(client, input.userId);
  const existing = await findEnqueuedTask(client, input);
  if (existing) return existing;
  await assertTaskCapacity(client, input);
  if (!prepared.execution) throw new BillingError("TASK_PREPARATION_STALE", "原任务已不存在，请重新提交");
  const execution = input.toolConfiguration ?? await resolveToolExecution(client, input);
  if (prepared.execution.modelConfigId !== execution.modelConfigId || prepared.execution.toolKey !== execution.toolKey) {
    throw new BillingError("TOOL_MODEL_CHANGED", "图片模型已变化，请重新提交；尚未扣费");
  }
  const isSeedream55 = await isSeedreamExecution(client, execution);
  const isLayerStudio = (input.toolKey ?? input.parameters?.tool) === "layer-studio";
  if (prepared.layer && !isSeedream55) throw new BillingError("TOOL_MODEL_CHANGED", "图片模型已变化，请重新提交；尚未扣费");
  if (isLayerStudio && (!isSeedream55 || execution.toolKey !== "layer-studio")) throw new BillingError("INVALID_LAYER_TASK", "图层工具配置不匹配");
  const inserted = await client.query<{ id: string; queuedAt: string; availableAt: string }>(
    `INSERT INTO tasks(id,request_id,batch_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,priority,credits,rmb_cost,user_input,prompt_compilation_id,prompt_optimized)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,0,$13,$14,$15)
         ON CONFLICT(request_id) DO NOTHING RETURNING id,queued_at AS "queuedAt",available_at AS "availableAt"`,
    [
      taskId,
      input.requestId,
      input.batchId ?? null,
      input.userId,
      input.departmentId,
      input.projectId,
      input.operationType,
      null,
      input.prompt,
      input.parameters ?? {},
      JSON.stringify(input.sourceUrls),
      input.priority,
      input.userInput ? JSON.stringify(input.userInput) : null,
      input.promptCompilationId ?? null,
      input.optimized === true,
    ],
  );
  if (!inserted.rows[0]) {
    const duplicate = await findEnqueuedTask(client, input);
    if (!duplicate) throw new BillingError("DUPLICATE_REQUEST", "请求编号已被其他账号占用");
    return duplicate;
  }
  let priceSnapshot = input.priceSnapshot;
  if (isSeedream55) {
    if (!prepared.layer) throw new BillingError("INVALID_IMAGE_TASK", "图片原件预检状态丢失");
    await validateStoredSeedream55Snapshot(client, input, prepared.layer);
    const originalPrice = input.batchId ? input.priceSnapshot : undefined;
    if (originalPrice?.layerStudioCost) {
      if (originalPrice.modelId !== execution.modelConfigId || originalPrice.operationType !== input.operationType || originalPrice.toolKey !== execution.toolKey) {
        throw new BillingError("PRICE_SNAPSHOT_MISMATCH", "批次原始模型或操作费用快照不匹配，尚未扣费");
      }
      const cost = layerStudioCostEstimate({ ...input.parameters, tool: execution.toolKey }, input.sourceUrls.length, originalPrice.layerStudioCost);
      priceSnapshot = { ...originalPrice, imageCost: undefined, layerStudioCost: cost, totalRmb: cost.estimatedPrecharge };
    } else {
      priceSnapshot = await loadLayerStudioPriceSnapshot(client, { operationType: input.operationType, modelConfigId: execution.modelConfigId, toolConfiguration: execution, parameters: input.parameters ?? {}, sourceCount: input.sourceUrls.length, creditsEnabled: input.creditsEnabled });
    }
  }
  if (input[QUICK_IMAGE_SNAPSHOT] && !prepared.quickImage) throw new BillingError("INVALID_IMAGE_TASK", "图片原件预检状态丢失");
  if (prepared.quickImage) await validateStoredQuickImageSnapshot(client, input, prepared.quickImage);
  let parameters = { ...input.parameters, tool: execution.toolKey };
  if (input.operationType === "video_generation") {
    if (!prepared.video) throw new BillingError("INVALID_VIDEO_INPUT", "视频预检状态丢失");
    await validateStoredVideoPreflightSnapshot(client, { ...input, modelConfigId: execution.modelConfigId }, prepared.video.snapshot);
    parameters = { ...parameters, ...prepared.video.normalized };
  }
  await client.query("UPDATE tasks SET model_config_id=$1,tool_key=$2,parameters=$3 WHERE id=$4", [execution.modelConfigId, execution.toolKey, parameters, taskId]);
  const reservation = await reserveCredits(db, {
    requestId: input.requestId,
    userId: input.userId,
    operationType: input.operationType,
    modelConfigId: execution.modelConfigId,
    toolConfiguration: execution,
    priceSnapshot,
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
}

export async function publishEnqueuedTask(cache: Cache, result: EnqueuedTaskResult): Promise<{ queuePending: boolean }> {
  if (!result.shouldQueue) return { queuePending: false };
  try {
    await scheduleQueuedTask(cache, result.task.id, queueScore(result.queuePriority, result.queueTimestamp), result.queueAvailableAt);
    return { queuePending: false };
  } catch {
    return { queuePending: true };
  }
}

export async function enqueueTask(
  db: Database,
  cache: Cache,
  input: TaskInput,
  videoPreflight = preflightStoredVideoTask,
  quickImagePreflight = preflightStoredQuickImageTask,
  layerStudioPreflight = preflightStoredSeedream55Task,
) {
  const prepared = await prepareTaskEnqueue(db, input, videoPreflight, quickImagePreflight, layerStudioPreflight);
  const result = await withTransaction(db, client => enqueueTaskInTransaction(client, prepared));
  const delivery = await publishEnqueuedTask(cache, result);
  return { ...result.task, ...delivery };
}

export async function recalculateBatch(db: Database, batchId: string) {
  const result = await db.query<BatchTaskCounts>(
    `SELECT (counts.total+missing.items)::int total,counts.success,(counts.failed+missing.items)::int failed,
        counts.cancelled,counts.paused,counts.waiting,counts.processing
      FROM (SELECT COUNT(*)::int total,
        COUNT(*) FILTER (WHERE status='success')::int success,COUNT(*) FILTER (WHERE status='failed')::int failed,
        COUNT(*) FILTER (WHERE status='cancelled')::int cancelled,COUNT(*) FILTER (WHERE status='paused')::int paused,
        COUNT(*) FILTER (WHERE status='waiting')::int waiting,COUNT(*) FILTER (WHERE status='processing')::int processing
        FROM tasks WHERE batch_id=$1) counts
      LEFT JOIN batch_tasks b ON b.id=$1
      CROSS JOIN LATERAL (SELECT CASE WHEN b.admission_status<>'admitting'
        THEN GREATEST(b.total_items-counts.total,0) ELSE 0 END AS items) missing`,
    [batchId],
  );
  const counts = result.rows[0]!;
  const status = deriveBatchStatus(counts);
  await db.query(
    "UPDATE batch_tasks SET status=$1,completed_items=$2,failed_items=$3,updated_at=now() WHERE id=$4 AND (status,completed_items,failed_items) IS DISTINCT FROM ($1,$2,$3)",
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

export type CancelledTask = {
  id: string; request_id: string; batch_id: string | null; status: string;
  operation_type: string; attempts: number; upstream_task_id: string | null;
  upstream_submission_started_at: string | null; model_config_id: string | null; model_slot_token: string | null;
};

async function cancelTaskWithPolicy(db: Database, client: PoolClient, taskId: string, ownerId: string | null, allowVideoPreparationRetry: boolean): Promise<CancelledTask | null> {
  const current = await client.query<CancelledTask>(
    `SELECT id,request_id,batch_id,status,operation_type,attempts,upstream_task_id,upstream_submission_started_at,model_config_id,model_slot_token
     FROM tasks WHERE id=$1 AND status IN ('waiting','paused')${ownerId === null ? "" : " AND user_id=$2"} FOR UPDATE`, ownerId === null ? [taskId] : [taskId, ownerId],
  );
  const task = current.rows[0];
  if (!task || task.upstream_task_id || task.upstream_submission_started_at
    || (task.attempts > 0 && !(allowVideoPreparationRetry && task.operation_type === "video_generation"))) return null;
  const changed = await client.query(
    `UPDATE tasks SET status='cancelled',completed_at=now(),execution_token=NULL,lease_expires_at=NULL,
      model_slot_token=NULL,model_slot_expires_at=NULL,updated_at=now()
     WHERE id=$1 AND status=$2 AND upstream_task_id IS NULL AND upstream_submission_started_at IS NULL
       AND ${allowVideoPreparationRetry ? "(operation_type='video_generation' OR attempts=0)" : "attempts=0"} RETURNING id`, [taskId, task.status],
  );
  if (!changed.rows[0]) return null;
  const settlement = await settleReservation(db, task.request_id, "release", undefined, client);
  if (settlement.status !== "released") throw new BillingError("INVALID_TASK_STATE", "已结算任务不能取消或退费");
  return task;
}

export async function cancelTaskInTransaction(db: Database, client: PoolClient, taskId: string, ownerId: string): Promise<CancelledTask | null> {
  await lockTaskAdmission(client, ownerId);
  return cancelTaskWithPolicy(db, client, taskId, ownerId, false);
}

export async function transitionTask(
  db: Database,
  cache: Cache,
  taskId: string,
  action: QueueTaskAction,
  recalculate = true,
) {
  if (action === "cancel") {
    const task = await withTransaction(db, client => cancelTaskWithPolicy(db, client, taskId, null, true));
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
    failure_reason: string | null;
  }>(
    "SELECT id,request_id,batch_id,status,priority,queued_at,operation_type,attempts,upstream_task_id,upstream_submission_started_at,failure_reason FROM tasks WHERE id=$1 AND status IN ('waiting','paused')",
    [taskId],
  );
  const task = current.rows[0];
  if (
    !task ||
    (action === "pause" && task.status !== "waiting") ||
    (action === "resume" && (task.status !== "paused" || task.failure_reason?.startsWith(`${IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX}：`)
      || (!task.upstream_task_id && (task.upstream_submission_started_at || (task.operation_type !== "video_generation" && task.attempts > 0)))))
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
      `UPDATE tasks SET status='waiting',available_at=now(),execution_token=NULL,lease_expires_at=NULL,
       poll_deadline_at=CASE WHEN upstream_task_id IS NOT NULL THEN now()+CASE
         WHEN upstream_workflow_context IS NOT NULL THEN
           CASE WHEN upstream_workflow_context->>'timeoutSeconds' ~ '^[0-9]{1,4}$'
             THEN LEAST(7200,GREATEST(30,(upstream_workflow_context->>'timeoutSeconds')::int)) ELSE 600 END * interval '1 second'
         WHEN operation_type='video_generation' THEN interval '20 minutes' ELSE interval '15 minutes' END
       ELSE poll_deadline_at END,updated_at=now() WHERE id=$1 AND status='paused'
       AND paused_kind IS NULL AND COALESCE(failure_reason,'') NOT LIKE $2
       AND (upstream_task_id IS NOT NULL OR (upstream_submission_started_at IS NULL AND (operation_type='video_generation' OR attempts=0))) RETURNING id`,
      [taskId, `${IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX}：%`],
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
