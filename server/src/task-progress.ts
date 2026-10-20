import type { Cache, Database } from "./db";
import { DELAYED_QUEUE, READY_QUEUE } from "./task-queue";

const MAX_QUEUE_CANDIDATES = 1_000;
const MIN_SAMPLES = 3;
const TERMINAL = new Set(["success", "failed", "cancelled"]);

export type TaskProgress = {
  taskId: string;
  status: string;
  runtime: "worker" | "demo";
  phase: "waiting" | "delayed" | "processing" | "preparing" | "paused" | "complete";
  /** One-based position among this model's currently runnable, not-yet-submitted tasks. */
  queuePosition: number | null;
  estimatedWaitSeconds: number | null;
  estimatedRemainingSeconds: number | null;
  sampleCount: number;
  estimateReason: string | null;
  retryAfterSeconds: number | null;
};

type ProgressTask = {
  id: string;
  status: string;
  modelConfigId: string | null;
  operationType: string;
  startedMs: number | null;
  submitted: boolean;
  slotOccupied: boolean;
};
type OwnedTask = ProgressTask & { nowMs: number; concurrency: number };
type QueueMember = { id: string; score: number; due: number };
type ProgressSnapshot = { tasks: ProgressTask[]; samples: number[] };

// Read actual queue scores, including due delayed entries awaiting the next
// promotion. Never promote/remove work; the ID list is bounded.
const queueSnapshotScript = `
local result = {}
for _, id in ipairs(ARGV) do
  local score = redis.call('ZSCORE', KEYS[1], id)
  if score then
    table.insert(result, {id=id, score=score, due=0})
  else
    local due = redis.call('ZSCORE', KEYS[2], id)
    local delayedScore = due and redis.call('HGET', KEYS[3], id)
    if delayedScore then
      table.insert(result, {id=id, score=delayedScore, due=tonumber(due)})
    end
  end
end
return cjson.encode(result)`;

const occupiedSlot = `(t.model_slot_token IS NOT NULL AND t.status NOT IN ('success','failed','cancelled')
    AND (t.model_slot_expires_at>now() OR t.upstream_submission_started_at IS NOT NULL
      OR (t.status='paused' AND t.attempts>0 AND t.operation_type<>'video_generation')))`;
const taskProjection = `t.id,t.status,t.model_config_id AS "modelConfigId",t.operation_type AS "operationType",
  (extract(epoch FROM COALESCE(t.upstream_submission_started_at,t.started_at))*1000)::float8 AS "startedMs",
  (t.upstream_submission_started_at IS NOT NULL OR t.upstream_task_id IS NOT NULL) AS submitted,
  ${occupiedSlot} AS "slotOccupied"`;

/** Owner authorization happens before any shared-queue or historical lookup. */
export async function readTaskProgress(db: Database, cache: Cache, taskId: string, ownerId: string): Promise<TaskProgress | null> {
  const owned = await db.query<OwnedTask>(
    `SELECT ${taskProjection},(extract(epoch FROM now())*1000)::float8 AS "nowMs",
      GREATEST(1,COALESCE(m.concurrency_limit,5))::int AS concurrency
     FROM tasks t LEFT JOIN model_configs m ON m.id=t.model_config_id WHERE t.id=$1 AND t.user_id=$2`,
    [taskId, ownerId],
  );
  const task = owned.rows[0];
  if (!task) return null;
  const progress = emptyProgress(task, "worker");
  if (TERMINAL.has(task.status) || task.status === "paused") return progress;
  if (!task.modelConfigId) return { ...progress, estimateReason: "model_unavailable" };
  const result = await db.query<ProgressSnapshot>(
    `SELECT
      COALESCE((SELECT jsonb_agg(candidate) FROM (
        SELECT ${taskProjection} FROM tasks t
        WHERE t.model_config_id=$1::uuid
          AND (t.status IN ('waiting','processing') OR (t.status='paused' AND ${occupiedSlot}))
        ORDER BY t.id LIMIT $3
      ) candidate),'[]'::jsonb) AS tasks,
      COALESCE((SELECT jsonb_agg(duration) FROM (
        SELECT extract(epoch FROM (completed_at-COALESCE(upstream_submission_started_at,started_at)))::float8 AS duration
        FROM tasks WHERE model_config_id=$1::uuid AND operation_type=$2
          AND status='success' AND attempts=1 AND completed_at>now()-interval '7 days' AND completed_at<=now()
          AND completed_at>COALESCE(upstream_submission_started_at,started_at)
        ORDER BY completed_at DESC,id DESC LIMIT 30
      ) recent),'[]'::jsonb) AS samples`,
    [task.modelConfigId, task.operationType, MAX_QUEUE_CANDIDATES + 1],
  );
  const snapshot = result.rows[0]!;
  if (snapshot.tasks.length > MAX_QUEUE_CANDIDATES) return { ...progress, estimateReason: "queue_too_large" };
  // Completion/pause can race this request.
  const current = snapshot.tasks.find(row => row.id === taskId);
  if (!current) return { ...progress, estimateReason: "queue_changing" };
  let members: QueueMember[] = [];
  if (current.status === "waiting" && !current.submitted && !current.slotOccupied) {
    try {
      const ids = snapshot.tasks.filter(row => row.status === "waiting" && !row.submitted && !row.slotOccupied).map(row => row.id);
      const encoded = await cache.eval(queueSnapshotScript, {
        keys: [READY_QUEUE, DELAYED_QUEUE, "tasks:delayed:priority"], arguments: ids,
      });
      const parsed: unknown = JSON.parse(String(encoded));
      // Redis cjson encodes an empty Lua table as {}.
      // Keep scores as strings through Lua/cjson: its 14-digit numeric encoding
      // would erase millisecond FIFO ordering in the priority score bands.
      members = Array.isArray(parsed) ? parsed.map(row => ({ id: row.id, score: Number(row.score), due: Number(row.due) })) : [];
    } catch {
      return { ...progress, estimateReason: "queue_unavailable" };
    }
  }
  return calculateTaskProgress({ ...task, ...current }, snapshot, members);
}

function emptyProgress(task: Pick<ProgressTask, "id" | "status" | "submitted" | "slotOccupied">, runtime: TaskProgress["runtime"]): TaskProgress {
  return {
    taskId: task.id, status: task.status, runtime,
    phase: TERMINAL.has(task.status) ? "complete" : task.status === "paused" ? "paused"
      : task.submitted || task.slotOccupied ? "processing" : task.status === "waiting" ? "waiting" : "preparing",
    queuePosition: null, estimatedWaitSeconds: null, estimatedRemainingSeconds: null,
    sampleCount: 0, estimateReason: null, retryAfterSeconds: null,
  };
}

/** Estimates use observed successful durations, never a model-name constant. */
export function calculateTaskProgress(task: OwnedTask, snapshot: ProgressSnapshot, members: QueueMember[]): TaskProgress {
  const progress = emptyProgress(task, "worker");
  if (progress.phase === "complete" || progress.phase === "paused") return progress;
  const samples = snapshot.samples.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  progress.sampleCount = samples.length;
  const typical = median(samples);
  let ahead: ProgressTask[] = [];
  if (progress.phase === "waiting") {
    const current = members.find(row => row.id === task.id);
    if (!current) return { ...progress, estimateReason: "queue_changing" };
    if (current.due > task.nowMs)
      return { ...progress, phase: "delayed", retryAfterSeconds: Math.ceil((current.due - task.nowMs) / 1000), estimateReason: "delayed" };
    const waiting = new Map(snapshot.tasks.filter(row => row.status === "waiting" && !row.submitted && !row.slotOccupied).map(row => [row.id, row]));
    const ready = members.filter(row => row.due <= task.nowMs && waiting.has(row.id))
      .sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : a.id === b.id ? 0 : 1));
    const index = ready.findIndex(row => row.id === task.id);
    if (index < 0) return { ...progress, estimateReason: "queue_changing" };
    progress.queuePosition = index + 1;
    ahead = ready.slice(0, index).map(row => waiting.get(row.id)!);
    // Future promotions/interrupted queue delivery may change admission order.
    if (members.some(row => row.due > task.nowMs) || members.length !== waiting.size)
      return { ...progress, estimateReason: "queue_changing" };
  }
  if (samples.length < MIN_SAMPLES) return { ...progress, estimateReason: "insufficient_samples" };
  if (progress.phase === "processing") {
    const remaining = observedRemaining(task, typical, task.nowMs);
    return { ...progress, estimatedRemainingSeconds: remaining === null ? null : Math.ceil(remaining), estimateReason: remaining === null ? "duration_exceeded" : null };
  }
  if (progress.phase !== "waiting") return { ...progress, estimateReason: "preparing" };
  const active = snapshot.tasks.filter(row => row.slotOccupied || row.submitted);
  if (active.some(row => row.status === "paused") || active.length > task.concurrency)
    return { ...progress, estimateReason: "unresolved_inflight" };
  if ([...ahead, ...active].some(row => row.operationType !== task.operationType))
    return { ...progress, estimateReason: "mixed_operations" };
  if (snapshot.tasks.some(row => row.status === "processing" && !row.slotOccupied && !row.submitted))
    return { ...progress, estimateReason: "queue_changing" };
  const slots = active.map(row => observedRemaining(row, typical, task.nowMs));
  if (slots.some(value => value === null)) return { ...progress, estimateReason: "duration_exceeded" };
  const available = slots as number[];
  // More free slots than this bounded queue cannot improve its estimate.
  while (available.length < Math.min(task.concurrency, active.length + ahead.length + 1)) available.push(0);
  for (const _row of ahead) {
    const first = available.indexOf(Math.min(...available));
    available[first] += typical;
  }
  const wait = Math.min(...available);
  return { ...progress, estimatedWaitSeconds: Math.ceil(wait), estimatedRemainingSeconds: Math.ceil(wait + typical) };
}

function median(values: number[]) {
  const middle = Math.floor(values.length / 2);
  return values.length ? values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2 : 0;
}

function observedRemaining(task: Pick<ProgressTask, "startedMs">, typical: number, now: number): number | null {
  if (task.startedMs === null || task.startedMs > now) return null;
  const remaining = typical - (now - task.startedMs) / 1000;
  return remaining > 0 ? remaining : null;
}

type DemoProgressTask = {
  id: string; status: string; ownerUserId: string; modelConfigId?: string; operationType: string;
  createdAt: string; submissionStartedAt?: string; updatedAt?: string;
};

/** Demo executes immediately; it has no shared worker queue/concurrency slots. */
export function readDemoTaskProgress(task: DemoProgressTask, tasks: Iterable<DemoProgressTask>, now = Date.now()): TaskProgress {
  const progress = emptyProgress({ ...task, submitted: task.status === "processing", slotOccupied: false }, "demo");
  if (progress.phase !== "processing") return progress;
  if (!task.modelConfigId) return { ...progress, estimateReason: "model_unavailable" };
  // Demo already holds its records in memory; retain only 30 sample references.
  const recent: DemoProgressTask[] = [];
  for (const row of tasks) {
    if (row.ownerUserId !== task.ownerUserId || row.modelConfigId !== task.modelConfigId || row.operationType !== task.operationType
      || row.status !== "success" || !row.submissionStartedAt || !row.updatedAt
      || Date.parse(row.updatedAt) <= now - 7 * 86400_000 || Date.parse(row.updatedAt) > now) continue;
    recent.push(row);
    recent.sort((a, b) => Date.parse(b.updatedAt!) - Date.parse(a.updatedAt!));
    if (recent.length > 30) recent.pop();
  }
  const samples = recent
    .map(row => (Date.parse(row.updatedAt!) - Date.parse(row.submissionStartedAt!)) / 1000)
    .filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  progress.sampleCount = samples.length;
  if (samples.length < MIN_SAMPLES) return { ...progress, estimateReason: "insufficient_samples" };
  const remaining = observedRemaining({ startedMs: task.submissionStartedAt ? Date.parse(task.submissionStartedAt) : null }, median(samples), now);
  return { ...progress, estimatedRemainingSeconds: remaining === null ? null : Math.ceil(remaining), estimateReason: remaining === null ? "duration_exceeded" : null };
}
