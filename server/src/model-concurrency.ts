import { randomUUID } from "node:crypto";
import type { Cache, Database } from "./db";
import { withTransaction } from "./db-transaction";

export const MODEL_LEASE_SECONDS = 180;
export class TaskExecutionLost extends Error {}
export type TaskLease = { taskId: string; executionToken: string; modelConfigId: string | null; slotToken: string };

const modelKey = (id: string | null) => `model:${id ?? "none"}:leases`;
const member = (lease: Pick<TaskLease, "taskId" | "slotToken">) => `${lease.taskId}:${lease.slotToken}`;

// Admissions are serialized by a transaction-scoped model lock. Rebuilding the
// sorted set from durable reservations makes Redis flush/restart safe as well.
// Unknown submitted work is intentionally retained until its outcome is known.
const acquireScript = `
redis.call('DEL', KEYS[1])
local snapshot = cjson.decode(ARGV[5])
for _, entry in ipairs(snapshot) do redis.call('ZADD', KEYS[1], entry.expires, entry.member) end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if not redis.call('ZSCORE', KEYS[1], ARGV[2]) and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2])
redis.call('EXPIRE', KEYS[1], 360)
return 1`;

const renewScript = `
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('EXPIRE', KEYS[1], 360)
return 1`;

export async function acquireModelLease(db: Database, cache: Cache, input: Omit<TaskLease, "slotToken"> & { limit: number }): Promise<TaskLease | null> {
  return withTransaction(db, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('model-concurrency'),hashtext($1))", [input.modelConfigId ?? "none"]);
    const current = await client.query<{ model_slot_token: string | null; clock_ms: number }>(
      `SELECT model_slot_token, floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS clock_ms
       FROM tasks WHERE id=$1 AND execution_token=$2 AND status='processing' FOR UPDATE`,
      [input.taskId, input.executionToken],
    );
    if (!current.rows[0]) throw new TaskExecutionLost("任务执行权已改变");
    const now = current.rows[0].clock_ms;
    const slotToken = current.rows[0].model_slot_token ?? randomUUID();
    const lease: TaskLease = { ...input, slotToken };
    const active = await client.query<{ id: string; model_slot_token: string; expires_ms: number }>(
      `SELECT id,model_slot_token,
          GREATEST(extract(epoch FROM model_slot_expires_at)*1000,$2::float8)::float8 AS expires_ms
       FROM tasks WHERE model_config_id IS NOT DISTINCT FROM $1::uuid AND model_slot_token IS NOT NULL
         AND status NOT IN ('success','failed','cancelled')
         AND (model_slot_expires_at>clock_timestamp() OR upstream_submission_started_at IS NOT NULL
              OR (status='paused' AND attempts>0 AND operation_type<>'video_generation'))`,
      [input.modelConfigId, now + MODEL_LEASE_SECONDS * 1000],
    );
    const accepted = await cache.eval(acquireScript, { keys: [modelKey(input.modelConfigId)], arguments: [
      String(now), member(lease), String(now + MODEL_LEASE_SECONDS * 1000), String(Math.max(1, input.limit)),
      JSON.stringify(active.rows.map(row => ({ member: member({ taskId: row.id, slotToken: row.model_slot_token }), expires: row.expires_ms }))),
    ] });
    if (Number(accepted) !== 1) return null;
    await client.query(
      `UPDATE tasks SET model_slot_token=$1,model_slot_expires_at=clock_timestamp()+($2::int * interval '1 second')
       WHERE id=$3 AND execution_token=$4`, [slotToken, MODEL_LEASE_SECONDS, input.taskId, input.executionToken],
    );
    return lease;
  });
}

export async function renewTaskLease(db: Database, cache: Cache, lease: TaskLease, executionLeaseSeconds: number) {
  const renewed = await db.query<{ expires_ms: number }>(
    `UPDATE tasks SET lease_expires_at=clock_timestamp()+($1::int * interval '1 second'),
        model_slot_expires_at=clock_timestamp()+($2::int * interval '1 second'),updated_at=now()
     WHERE id=$3 AND execution_token=$4 AND model_slot_token=$5 AND status='processing'
     RETURNING (extract(epoch FROM model_slot_expires_at)*1000)::float8 AS expires_ms`,
    [executionLeaseSeconds, MODEL_LEASE_SECONDS, lease.taskId, lease.executionToken, lease.slotToken],
  );
  if (!renewed.rows[0]) throw new TaskExecutionLost("任务执行租约已失效");
  // An absent Redis member after cache loss is rebuilt during the next admission;
  // the durable reservation remains authoritative and blocks oversubscription.
  try {
    await cache.eval(renewScript, { keys: [modelKey(lease.modelConfigId)], arguments: [member(lease), String(renewed.rows[0].expires_ms)] });
  } catch {
    // Postgres already renewed/fenced ownership. A cache outage must not turn a
    // live paid request into an ambiguous paused task; admissions rebuild Redis.
    console.warn(JSON.stringify({ event: "worker.lease_cache_refresh_failed", taskId: lease.taskId }));
  }
}

export async function releaseModelLease(db: Database, cache: Cache, lease: TaskLease) {
  const released = await db.query(
    `UPDATE tasks SET model_slot_token=NULL,model_slot_expires_at=NULL WHERE id=$1 AND model_slot_token=$2
     AND execution_token=$3 RETURNING id`,
    [lease.taskId, lease.slotToken, lease.executionToken],
  );
  if (released.rows[0]) await cache.zRem(modelKey(lease.modelConfigId), member(lease));
}

export function startTaskLeaseHeartbeat(db: Database, cache: Cache, lease: TaskLease, seconds: number) {
  let stopped = false, inFlight: Promise<void> | null = null, lost: Error | null = null;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = renewTaskLease(db, cache, lease, seconds).catch(error => {
      lost = error instanceof Error ? error : new Error("任务续租失败");
      console.error(`Unable to renew task lease ${lease.taskId}`, error);
    }).finally(() => { inFlight = null; });
  }, Math.floor(Math.min(seconds, MODEL_LEASE_SECONDS) * 1000 / 3));
  return {
    assertOwned() { if (lost) throw lost; },
    async stop() { stopped = true; clearInterval(timer); await inFlight; },
  };
}
