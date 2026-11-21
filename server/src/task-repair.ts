import type { Database, Cache } from "./db";
import { scheduleQueuedTask } from "./task-queue";
import { workflowPollWindow } from "./task-poll-window";
import { queueScore, type TaskPriority } from "./tasks";
import { ImageResultProcessingError } from "./image-result-processing";

import type { TaskPausedKind as PausedKind } from "../../shared/task-repair";
export type { TaskPausedKind as PausedKind } from "../../shared/task-repair";
export type PauseDecision = { kind: PausedKind; code: string };
type RepairOptions = { maxAttempts: number; taskId?: string; ownerId?: string };

export function classifyResultFailure(error: unknown, partialLayers = false): PauseDecision {
  for (let depth = 0, cause = error; cause instanceof Error && depth < 8; depth++, cause = cause.cause) {
    if (cause instanceof ImageResultProcessingError) {
      if (cause.code === "IMAGE_RESULT_PROCESSING_TIMEOUT") return { kind: "result_repair", code: cause.code };
      return { kind: "needs_review", code: cause.code };
    }
    const code = "code" in cause ? cause.code : cause.name;
    if (code === "ENOSPC" || /no space left on device/i.test(cause.message)) return { kind: "result_repair", code: "STORAGE_ENOSPC" };
    if (code === "InvalidRequest" && /length/i.test(cause.message) || /content[- ]length|specified size.*actual size/i.test(cause.message))
      return { kind: "result_repair", code: "STORAGE_LENGTH_MISMATCH" };
    if (code === "RESULT_DOWNLOAD_FAILED") return { kind: "result_repair", code };
    if (/hash 不一致|结果清单类型无效|超过.*上限|GIF 实际帧数|GIF 结果格式/.test(cause.message)) return { kind: "needs_review", code: "RESULT_OUTPUT_INVALID" };
  }
  return { kind: "result_repair", code: partialLayers ? "LAYER_PARTIAL_SAVE" : "RESULT_STORAGE_FAILED" };
}

export async function pauseOwnedTask(db: Database, task: { id: string; execution_token: string }, decision: PauseDecision, reason: string, maxAttempts = 3) {
  return db.query(`UPDATE tasks SET status='paused', failure_reason=$3, repair_error_code=$5,
    paused_kind=CASE WHEN $4::text IN ('result_repair','awaiting_query') AND
      (nullif(btrim(upstream_task_id),'') IS NULL OR repair_attempts >= $6) THEN 'needs_review' ELSE $4 END,
    next_repair_at=CASE WHEN $4 IN ('result_repair','awaiting_query') AND nullif(btrim(upstream_task_id),'') IS NOT NULL AND repair_attempts < $6
      THEN now()+make_interval(secs => CASE repair_attempts WHEN 0 THEN 60 WHEN 1 THEN 300 ELSE 900 END) END,
    lease_expires_at=NULL,updated_at=now()
    WHERE id=$1 AND execution_token=$2 AND status='processing'
      AND ($5 <> 'TASK_EXECUTION_LOST' OR lease_expires_at>clock_timestamp()) RETURNING id`,
    [task.id, task.execution_token, reason, decision.kind, decision.code, maxAttempts]);
}

export async function requeueRepairs(db: Database, cache: Pick<Cache, "eval">, options: RepairOptions) {
  const { rows } = await db.query<{ id: string; priority: TaskPriority; queued_at: string; available_at: string }>(
    `WITH due AS (
      SELECT id FROM tasks WHERE status='paused' AND paused_kind IN ('result_repair','awaiting_query')
        AND nullif(btrim(upstream_task_id),'') IS NOT NULL AND (lease_expires_at IS NULL OR lease_expires_at<=now())
        AND execution_token IS NULL AND repair_attempts < $1
        AND (($2::uuid IS NULL AND next_repair_at<=now()) OR (id=$2 AND user_id=$3::uuid))
      ORDER BY next_repair_at,id LIMIT 20 FOR UPDATE SKIP LOCKED
    ) UPDATE tasks t SET status='waiting',repair_attempts=repair_attempts+1,next_repair_at=NULL,
      available_at=now(),poll_deadline_at=now()+CASE WHEN upstream_workflow_context IS NOT NULL
        THEN ${workflowPollWindow} ELSE interval '10 minutes' END,updated_at=now()
      FROM due WHERE t.id=due.id RETURNING t.id,t.priority,t.queued_at,t.available_at`,
    [options.maxAttempts, options.taskId ?? null, options.ownerId ?? null]);
  for (const row of rows) await scheduleQueuedTask(cache, row.id, queueScore(row.priority, new Date(row.queued_at).getTime()), new Date(row.available_at).getTime());
  return rows.length;
}
