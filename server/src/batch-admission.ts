import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { BillingError } from "./billing";
import type { Database } from "./db";
import { withTransaction } from "./db-transaction";
import { PromptOptimizationError } from "./prompt-safety";

export type BatchAdmissionToken = { token: string };
export type BatchAdmissionFailure = {
  index: number;
  reason: string;
  code: string;
  admitted: boolean;
};
export type BatchAdmissionRow = {
  id: string;
  userId: string;
  requestId: string;
  prompt: string;
  totalItems: number;
  inputHash: string | null;
  admissionStatus: "admitting" | "complete" | "interrupted";
  admissionToken: string | null;
  failures: BatchAdmissionFailure[];
};
const select = `id,user_id AS "userId",request_id AS "requestId",prompt,total_items AS "totalItems",
  admission_input_hash AS "inputHash",admission_status AS "admissionStatus",admission_token AS "admissionToken",admission_failures AS failures`;
const lease = "interval '30 seconds'";
export const interruptedBatchAdmission = () =>
  new PromptOptimizationError(
    "BATCH_SUBMISSION_INTERRUPTED",
    "批次受理已中断；仅保留已保存任务，未受理项不会自动重新提交",
    409,
  );

export async function findBatchForSubmission(
  db: Database,
  requestId: string,
  userId: string,
  inputHash: string,
) {
  const row = (
    await db.query<BatchAdmissionRow>(
      `SELECT ${select} FROM batch_tasks WHERE request_id=$1`,
      [requestId],
    )
  ).rows[0];
  if (!row) return null;
  if (row.userId !== userId)
    throw new BillingError("DUPLICATE_REQUEST", "请求编号已被其他账号占用");
  if (row.inputHash !== inputHash)
    throw new PromptOptimizationError(
      "BATCH_REQUEST_CHANGED",
      "同一批次编号的输入已改变或属于旧批次；请查询原批次，或使用新编号提交",
      409,
    );
  return row;
}

export async function claimBatchAdmission(
  db: Database,
  input: {
    requestId: string;
    userId: string;
    departmentId: string | null;
    projectId: string;
    operationType: string;
    modelConfigId: string;
    prompt: string;
    priority: string;
    totalItems: number;
    toolKey: string;
    inputHash: string;
  },
) {
  const id = randomUUID(),
    token = randomUUID();
  const result = await db.query<BatchAdmissionRow>(
    `INSERT INTO batch_tasks(id,request_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,priority,total_items,tool_key,
      admission_input_hash,admission_status,admission_token,admission_lease_expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'admitting',$13,clock_timestamp()+${lease})
     ON CONFLICT(request_id) DO NOTHING RETURNING ${select}`,
    [
      id,
      input.requestId,
      input.userId,
      input.departmentId,
      input.projectId,
      input.operationType,
      input.modelConfigId,
      input.prompt,
      input.priority,
      input.totalItems,
      input.toolKey,
      input.inputHash,
      token,
    ],
  );
  const row = result.rows[0];
  if (row) return { batch: row, token: { token }, claimed: true as const };
  return {
    batch: (await findBatchForSubmission(
      db,
      input.requestId,
      input.userId,
      input.inputHash,
    ))!,
    token: null,
    claimed: false as const,
  };
}

/** Runs inside enqueue's existing SQL transaction: no extra connection or provider I/O. */
export async function fenceBatchAdmission(
  client: Pick<PoolClient, "query">,
  batchId: string,
  userId: string,
  owner: BatchAdmissionToken,
) {
  const changed = await client.query(
    `UPDATE batch_tasks SET admission_lease_expires_at=clock_timestamp()+${lease}
     WHERE id=$1 AND user_id=$2 AND admission_status='admitting' AND admission_token=$3
       AND admission_lease_expires_at>clock_timestamp() RETURNING id`,
    [batchId, userId, owner.token],
  );
  if (!changed.rows[0]) throw interruptedBatchAdmission();
}

export async function recordBatchAdmissionFailure(
  db: Pick<Database, "query">,
  batchId: string,
  owner: BatchAdmissionToken,
  failure: BatchAdmissionFailure,
) {
  await db.query(
    `UPDATE batch_tasks SET admission_failures=admission_failures || $3::jsonb
     WHERE id=$1 AND admission_token=$2 AND admission_status='admitting'`,
    [batchId, owner.token, JSON.stringify([failure])],
  );
}

export async function finishBatchAdmission(
  db: Database,
  batchId: string,
  owner: BatchAdmissionToken,
  interrupted = false,
) {
  await db.query(
    `UPDATE batch_tasks SET admission_status=CASE WHEN $3 OR admission_lease_expires_at<=clock_timestamp() THEN 'interrupted' ELSE 'complete' END,
      admission_token=NULL,admission_lease_expires_at=NULL,updated_at=now()
     WHERE id=$1 AND admission_token=$2 AND admission_status='admitting'`,
    [batchId, owner.token, interrupted],
  );
}

/** Query-only recovery: lock against any in-flight task INSERT/hold, then close expired admission. */
export async function readBatchAdmission(
  db: Database,
  requestId: string,
  userId: string,
) {
  return withTransaction(db, async (client) => {
    const row = (
      await client.query<BatchAdmissionRow>(
        `SELECT ${select} FROM batch_tasks WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
        [requestId, userId],
      )
    ).rows[0];
    if (!row) return null;
    if (row.admissionStatus === "admitting") {
      const expired = await client.query<BatchAdmissionRow>(
        `UPDATE batch_tasks SET admission_status='interrupted',admission_token=NULL,admission_lease_expires_at=NULL,updated_at=now()
         WHERE id=$1 AND admission_status='admitting' AND admission_lease_expires_at<=clock_timestamp() RETURNING ${select}`,
        [row.id],
      );
      return expired.rows[0] ?? row;
    }
    return row;
  });
}
