import { z } from "zod";
import type { Database } from "./db";
import type { UsageRollupJob, UsageRollupRequest } from "../../shared/usage-analytics-v2";
import { UsageError } from "./usage-analytics";
import { classifyUsageFailure } from "./usage-failure-reasons";
import { loadUsageV2SourceData, USAGE_V2_METRIC_VERSION, type Fact } from "./usage-analytics-v2";
import { usageDay, usageDays, usageDayStart, type UsageQueryClient } from "./usage-rollup-reader";

const MAX_BYTES = 32 * 1024 * 1024;
const validDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "日期无效");
export const usageRollupRequestSchema = z.object({ fromDay: validDay, toDay: validDay, idempotencyKey: z.string().uuid() }).strict()
  .refine(value => value.toDay >= value.fromDay && Date.parse(value.toDay) - Date.parse(value.fromDay) < 31 * 86400000, "每次刷新最多31个北京时间日期");

type JobRow = {
  id: string; status: UsageRollupJob["status"]; from_day: string | Date; to_day: string | Date;
  completed_days: (string | Date)[]; created_at: string | Date; updated_at: string | Date;
  completed_at: string | Date | null; failure_code: string | null;
};
// PostgreSQL DATE parsing varies with Node's local TZ. Keep Beijing calendar
// dates as text, never round-trip them through a local-midnight JS Date.
const jobColumns = "id,status,from_day::text,to_day::text,ARRAY(SELECT value::text FROM unnest(completed_days) value) AS completed_days,created_at,updated_at,completed_at,failure_code";
const dateOnly = (value: string | Date) => typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
const iso = (value: string | Date) => new Date(value).toISOString();
function presentJob(row: JobRow): UsageRollupJob {
  return { jobId: row.id, status: row.status, fromDay: dateOnly(row.from_day), toDay: dateOnly(row.to_day), completedDays: row.completed_days.map(dateOnly), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), completedAt: row.completed_at ? iso(row.completed_at) : null, failureCode: row.failure_code };
}

/** Enqueue only; a timed-out/repeated HTTP request cannot duplicate a job. */
export async function queueUsageRollup(db: Database, input: UsageRollupRequest, actorUserId: string): Promise<UsageRollupJob> {
  const request = usageRollupRequestSchema.parse(input);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const today = (await client.query<{ today: string }>("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS today")).rows[0]!.today;
    if (request.toDay > today) throw new UsageError("USAGE_ROLLUP_RANGE_INVALID", "只能刷新今天或更早的北京时间日期", 400);
    await client.query("INSERT INTO usage_rollup_jobs(idempotency_key,from_day,to_day,actor_user_id) VALUES($1,$2,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING", [request.idempotencyKey, request.fromDay, request.toDay, actorUserId]);
    const row = (await client.query<JobRow>(`SELECT ${jobColumns} FROM usage_rollup_jobs WHERE idempotency_key=$1`, [request.idempotencyKey])).rows[0]!;
    if (dateOnly(row.from_day) !== request.fromDay || dateOnly(row.to_day) !== request.toDay) throw new UsageError("USAGE_ROLLUP_KEY_CONFLICT", "该幂等键已用于不同日期范围；未新建刷新", 409);
    await client.query("COMMIT");
    return presentJob(row);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}
export async function getUsageRollupJob(db: Database, id: string): Promise<UsageRollupJob> {
  const row = (await db.query<JobRow>(`SELECT ${jobColumns} FROM usage_rollup_jobs WHERE id=$1`, [id])).rows[0];
  if (!row) throw new UsageError("USAGE_ROLLUP_JOB_NOT_FOUND", "刷新任务不存在", 404);
  return presentJob(row);
}

/** The persisted payload is an explicit allowlist, not a copy of task JSON. */
function persistedFact(fact: Fact) {
  const payload = {
    id: fact.id, user_id: fact.user_id, kind: fact.kind, board_key: fact.board_key,
    model_config_id: fact.model_config_id, operation_type: fact.operation_type,
    action: fact.action, control_key: fact.control_key, status: fact.status,
    occurred_at: iso(fact.occurred_at), started_at: fact.started_at ? iso(fact.started_at) : null,
    completed_at: fact.completed_at ? iso(fact.completed_at) : null,
    parameters: fact.parameters, result_urls: [], booked: fact.booked,
    failure_reason: null, failure_category: classifyUsageFailure(fact.status, fact.failure_reason),
    attempts: fact.attempts, optimized: fact.optimized, compilation_id: fact.compilation_id,
    batch_linked: fact.batch_linked ?? null, source_count: fact.source_count ?? null,
    total_ms: fact.total_ms, wait_ms: fact.wait_ms, run_ms: fact.run_ms,
    outputs: (fact.outputs ?? []).map((output, index) => ({
      // Identity is needed only within this task's already-deduplicated outputs.
      // Never persist an external URL embedded in the live fallback identity.
      key: `${fact.id}:${index}`, linked: output.linked,
      events: [...new Map(output.events.map(event => [`${event.type}:${event.evidence}`, event])).values()],
    })),
  };
  return { day: usageDay(fact.occurred_at), kind: fact.kind, fact_id: fact.id, user_id: fact.user_id,
    event_department_id: fact.event_department_id ?? null, board_key: fact.board_key,
    model_config_id: fact.model_config_id, operation_type: fact.operation_type,
    occurred_at: iso(fact.occurred_at), payload };
}

async function rebuildDay(db: Database, client: UsageQueryClient, day: string) {
  const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const scope = { from: usageDayStart(day), to: usageDayStart(nextDay), timezone: "Asia/Shanghai" as const, compare: "none" as const, departmentBasis: "at_event" as const };
  const data = await loadUsageV2SourceData(db, scope, client);
  const rows = data.facts.map(persistedFact);
  const bytes = rows.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row.payload)), 0);
  if (bytes > MAX_BYTES) throw new UsageError("USAGE_SCOPE_TOO_LARGE", "单日精确事实超过32MiB刷新预算；未覆盖原日快照", 422);
  await client.query("DELETE FROM usage_daily_facts WHERE day=$1", [day]);
  if (rows.length) await client.query(`INSERT INTO usage_daily_facts(day,kind,fact_id,user_id,event_department_id,board_key,model_config_id,operation_type,occurred_at,payload)
    SELECT day,kind,fact_id,user_id,event_department_id,board_key,model_config_id,operation_type,occurred_at,payload
    FROM jsonb_to_recordset($1::jsonb) AS r(day date,kind text,fact_id text,user_id uuid,event_department_id uuid,board_key text,model_config_id uuid,operation_type text,occurred_at timestamptz,payload jsonb)`, [JSON.stringify(rows)]);
  await client.query(`INSERT INTO usage_daily_snapshots(day,metric_version,computed_at,fact_count,fact_bytes) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(day) DO UPDATE SET metric_version=EXCLUDED.metric_version,computed_at=EXCLUDED.computed_at,fact_count=EXCLUDED.fact_count,fact_bytes=EXCLUDED.fact_bytes`, [day, USAGE_V2_METRIC_VERSION, data.asOf, rows.length, bytes]);
  // A future-dated existing receipt must become effective without requiring
  // another source write. Keep its cohort dirty only when that cutoff arrives.
  const future = (await client.query<{ next_at: string | Date | null }>(`SELECT min(e.occurred_at) AS next_at FROM asset_events e
    WHERE e.occurred_at>$1::timestamptz AND (e.task_id IN(SELECT id FROM tasks WHERE queued_at>=$2::timestamptz AND queued_at<$3::timestamptz)
      OR e.asset_id IN(SELECT a.id FROM assets a JOIN tasks t ON t.id=a.task_id WHERE t.queued_at>=$2::timestamptz AND t.queued_at<$3::timestamptz))`, [data.asOf, scope.from, scope.to])).rows[0]?.next_at;
  // Do not lock the dirty row during expensive source reads. If a concurrent
  // source transaction changed the row after this repeatable-read snapshot,
  // PostgreSQL rejects this DELETE with 40001; the entire day is deferred.
  // A concurrently inserted dirty row invisible to this snapshot stays queued.
  await client.query("DELETE FROM usage_dirty_days WHERE day=$1", [day]);
  if (future) await client.query("INSERT INTO usage_dirty_days(day,ready_after) VALUES($1,$2) ON CONFLICT(day) DO UPDATE SET ready_after=LEAST(usage_dirty_days.ready_after,EXCLUDED.ready_after)", [day, future]);
}

/** Schedule once per Beijing day after 03:00; source triggers cover arbitrarily old days. */
export async function scheduleUsageRollupMaintenance(db: Database, now = new Date()) {
  const today = usageDay(now), hour = new Date(now.getTime() + 8 * 3600000).getUTCHours();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Initial migration seeds existing history; this bounded scan also covers
    // newly discovered older dates and multi-day downtime without GET writes.
    await client.query(`INSERT INTO usage_dirty_days(day)
      SELECT d.day::date FROM usage_rollup_state state,
        LATERAL generate_series(state.history_from::timestamp,$1::date::timestamp,interval '1 day') d(day)
      LEFT JOIN usage_daily_snapshots s ON s.day=d.day::date
      LEFT JOIN usage_dirty_days dirty ON dirty.day=d.day::date
      WHERE s.day IS NULL AND dirty.day IS NULL ORDER BY d.day LIMIT 31 ON CONFLICT(day) DO NOTHING`, [today]);
    await client.query("INSERT INTO usage_dirty_days(day) SELECT $1::date WHERE NOT EXISTS(SELECT 1 FROM usage_daily_snapshots WHERE day=$1) ON CONFLICT(day) DO NOTHING", [today]);
    await client.query("INSERT INTO usage_dirty_days(day) SELECT day FROM usage_daily_snapshots WHERE metric_version<>$1 ORDER BY day LIMIT 31 ON CONFLICT(day) DO NOTHING", [USAGE_V2_METRIC_VERSION]);
    if (hour >= 3) {
      const due = (await client.query("UPDATE usage_rollup_state SET last_scheduled_day=$1 WHERE singleton=true AND (last_scheduled_day IS NULL OR last_scheduled_day<$1::date) RETURNING singleton", [today])).rows.length;
      if (due) await client.query(`INSERT INTO usage_dirty_days(day)
        SELECT day::date FROM generate_series($1::date-7,$1::date-1,interval '1 day') day
        ON CONFLICT(day) DO UPDATE SET dirty_at=now(),ready_after=now()`, [today]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

type Step = { status: "processed" | "idle" | "deferred" | "failed"; day?: string; jobId?: string; failureCode?: string };
type DayFence = { snapshot_version: string | null; dirty_version: string | null };
// xmin is an opaque row version, not a wall-clock timestamp. It also detects a
// source transaction that began earlier but committed while this day was read.
const dayFenceSql = `SELECT (SELECT xmin::text FROM usage_daily_snapshots WHERE day=$1) AS snapshot_version,
  (SELECT xmin::text FROM usage_dirty_days WHERE day=$1) AS dirty_version`;
/** One day per transaction. Advisory locks serialize workers, not business writes;
 * a conflicting source commit cannot be lost when clearing dirty. */
async function processOneDay(db: Database): Promise<Step> {
  const client = await db.connect();
  let job: JobRow | undefined, day: string | undefined;
  let fence: DayFence | undefined;
  try {
    const deadline = Date.now() + 15000;
    const bounded = { query: async (sql: string, values?: unknown[]) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new UsageError("USAGE_ROLLUP_TIME_BUDGET", "单日刷新超过15秒事务预算；原日快照保持不变", 503);
      await client.query(`SET LOCAL statement_timeout='${remaining}ms'`);
      return client.query(sql, values);
    } } as UsageQueryClient;
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await client.query("SET LOCAL statement_timeout='15000ms'");
    await client.query("SET LOCAL lock_timeout='1000ms'");
    job = (await client.query<JobRow>(`SELECT ${jobColumns} FROM usage_rollup_jobs WHERE status IN('queued','running') ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
    if (job) day = usageDays(dateOnly(job.from_day), dateOnly(job.to_day)).find(value => !job!.completed_days.map(dateOnly).includes(value));
    else day = (await client.query<{ day: string }>("SELECT day::text FROM usage_dirty_days WHERE ready_after<=now() AND failure_code IS NULL AND day<=(now() AT TIME ZONE 'Asia/Shanghai')::date ORDER BY day LIMIT 1")).rows[0]?.day;
    if (!day) { await client.query("COMMIT"); return { status: "idle" }; }
    const lock = (await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('usage-rollup:'||$1::text)) AS locked", [day])).rows[0]!.locked;
    if (!lock) { await client.query("ROLLBACK"); return { status: "deferred" }; }
    fence = (await bounded.query<DayFence>(dayFenceSql, [day])).rows[0];
    await rebuildDay(db, bounded, day);
    if (job) await bounded.query(`UPDATE usage_rollup_jobs SET completed_days=array_append(completed_days,$2::date),
      status=CASE WHEN cardinality(completed_days)+1=to_day-from_day+1 THEN 'completed' ELSE 'running' END,
      completed_at=CASE WHEN cardinality(completed_days)+1=to_day-from_day+1 THEN now() ELSE NULL END,
      failure_code=NULL,updated_at=now() WHERE id=$1`, [job.id, day]);
    await client.query("COMMIT");
    return { status: "processed", day, ...(job ? { jobId: job.id } : {}) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (["40001", "40P01", "55P03"].includes(code)) return { status: "deferred" };
    const failureCode = error instanceof UsageError ? error.code : "USAGE_ROLLUP_COMPUTE_FAILED";
    if (!day || !fence) return { status: "deferred" };
    // ROLLBACK released the original locks. Another worker may have succeeded,
    // or source data may have changed, before this late failure can be saved.
    // Reacquire the same lock order and fence both writes against that progress.
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL statement_timeout='5000ms'");
      await client.query("SET LOCAL lock_timeout='1000ms'");
      if (job) {
        const current = (await client.query<JobRow>(`SELECT ${jobColumns} FROM usage_rollup_jobs WHERE id=$1 FOR UPDATE`, [job.id])).rows[0];
        if (!current || !["queued", "running"].includes(current.status) || current.completed_days.map(dateOnly).includes(day)) {
          await client.query("ROLLBACK"); return { status: "deferred" };
        }
      }
      const lock = (await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('usage-rollup:'||$1::text)) AS locked", [day])).rows[0]!.locked;
      if (!lock) { await client.query("ROLLBACK"); return { status: "deferred" }; }
      const current = (await client.query<DayFence>(dayFenceSql, [day])).rows[0]!;
      if (current.snapshot_version !== fence.snapshot_version || current.dirty_version !== fence.dirty_version) {
        await client.query("ROLLBACK"); return { status: "deferred" };
      }
      // The conditional write also closes a source-write race after the check.
      // A new/updated dirty row wins, so its automatic retry remains enabled.
      const marked = fence.dirty_version === null
        ? await client.query("INSERT INTO usage_dirty_days(day,failure_code,failed_at) VALUES($1,$2,now()) ON CONFLICT(day) DO NOTHING RETURNING day", [day, failureCode])
        : await client.query("UPDATE usage_dirty_days SET failure_code=$2,failed_at=now() WHERE day=$1 AND xmin::text=$3 RETURNING day", [day, failureCode, fence.dirty_version]);
      if (!marked.rows.length) { await client.query("ROLLBACK"); return { status: "deferred" }; }
      if (job) await client.query("UPDATE usage_rollup_jobs SET status='failed',failure_code=$2,updated_at=now() WHERE id=$1", [job.id, failureCode]);
      await client.query("COMMIT");
      return { status: "failed", day, ...(job ? { jobId: job.id } : {}), failureCode };
    } catch (recordError) {
      await client.query("ROLLBACK").catch(() => undefined);
      const recordCode = recordError && typeof recordError === "object" && "code" in recordError ? String(recordError.code) : "";
      if (["40001", "40P01", "55P03"].includes(recordCode)) return { status: "deferred" };
      throw recordError;
    }
  } finally { client.release(); }
}

/** Bounded work per tick; the generation worker retains its normal lifecycle. */
export async function processUsageRollups(db: Database, maxDays = 3): Promise<Step[]> {
  const limit = Math.max(1, Math.min(7, Math.floor(maxDays)));
  const result: Step[] = [];
  for (let index = 0; index < limit; index++) {
    const step = await processOneDay(db);
    result.push(step);
    if (step.status === "idle" || step.status === "deferred") break;
  }
  return result;
}
