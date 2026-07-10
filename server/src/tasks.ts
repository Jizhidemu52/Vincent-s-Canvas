import { randomUUID } from "node:crypto";
import { BillingError, reserveCredits, settleReservation } from "./billing";
import type { Cache, Database } from "./db";

export type TaskPriority = "normal" | "priority" | "urgent";
export type TaskInput = { requestId: string; userId: string; departmentId: string | null; projectId: string; operationType: string; modelConfigId?: string | null; prompt: string; parameters?: Record<string, unknown>; sourceUrls: string[]; priority: TaskPriority; batchId?: string | null };

const priorityBand: Record<TaskPriority, number> = { urgent: 0, priority: 1, normal: 2 };
export function queueScore(priority: TaskPriority, timestamp = Date.now()) { return priorityBand[priority] * 1_000_000_000_000_000 + timestamp; }

export async function enqueueTask(db: Database, cache: Cache, input: TaskInput) {
    const taskId = randomUUID();
    const inserted = await db.query<{ id: string }>(
        `INSERT INTO tasks(id,request_id,batch_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,priority,credits,rmb_cost)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,0)
         ON CONFLICT(request_id) DO NOTHING RETURNING id`,
        [taskId, input.requestId, input.batchId ?? null, input.userId, input.departmentId, input.projectId, input.operationType, input.modelConfigId ?? null, input.prompt, input.parameters ?? {}, JSON.stringify(input.sourceUrls), input.priority],
    );
    if (!inserted.rows[0]) {
        const existing = await db.query<{ id: string; requestId: string; status: string; credits: number; rmbCost: number }>(
            `SELECT id,request_id AS "requestId",status,credits,rmb_cost::float8 AS "rmbCost" FROM tasks WHERE request_id=$1 AND user_id=$2`,
            [input.requestId, input.userId],
        );
        if (!existing.rows[0]) throw new BillingError("DUPLICATE_REQUEST", "请求编号已被其他账号占用");
        return existing.rows[0];
    }
    try {
        const reservation = await reserveCredits(db, { requestId: input.requestId, userId: input.userId, operationType: input.operationType, modelConfigId: input.modelConfigId, quantity: 1 });
        await db.query("UPDATE tasks SET credits=$1,rmb_cost=$2,updated_at=now() WHERE id=$3", [reservation.credits, reservation.rmbCost, taskId]);
        await cache.zAdd("tasks:queue", { score: queueScore(input.priority), value: taskId });
        return { id: taskId, requestId: input.requestId, status: "waiting", credits: reservation.credits, rmbCost: reservation.rmbCost };
    } catch (error) {
        await db.query("DELETE FROM tasks WHERE id=$1", [taskId]).catch(() => undefined);
        await settleReservation(db, input.requestId, "release", input.userId).catch(() => undefined);
        throw error;
    }
}

export async function recalculateBatch(db: Database, batchId: string) {
    const result = await db.query<{ total: number; completed: number; failed: number; processing: number }>(`SELECT COUNT(*)::int total,
        COUNT(*) FILTER (WHERE status='success')::int completed,COUNT(*) FILTER (WHERE status IN ('failed','cancelled'))::int failed,
        COUNT(*) FILTER (WHERE status IN ('waiting','processing'))::int processing FROM tasks WHERE batch_id=$1`, [batchId]);
    const counts = result.rows[0]!;
    const status = counts.processing > 0 ? (counts.completed + counts.failed > 0 ? "processing" : "waiting") : counts.failed === 0 ? "success" : counts.completed === 0 ? "failed" : "partial";
    await db.query("UPDATE batch_tasks SET status=$1,completed_items=$2,failed_items=$3,updated_at=now() WHERE id=$4", [status, counts.completed, counts.failed, batchId]);
}

export { BillingError };
