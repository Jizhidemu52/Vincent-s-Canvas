import { randomUUID } from "node:crypto";
import { BillingError, reserveCredits, settleReservation } from "./billing";
import type { Cache, Database } from "./db";

export type TaskPriority = "normal" | "priority" | "urgent";
export type TaskInput = { requestId: string; userId: string; departmentId: string | null; projectId: string; operationType: string; modelConfigId?: string | null; prompt: string; sourceUrls: string[]; priority: TaskPriority; batchId?: string | null };

const priorityBand: Record<TaskPriority, number> = { urgent: 0, priority: 1, normal: 2 };
export function queueScore(priority: TaskPriority, timestamp = Date.now()) { return priorityBand[priority] * 1_000_000_000_000_000 + timestamp; }

export async function enqueueTask(db: Database, cache: Cache, input: TaskInput) {
    const reservation = await reserveCredits(db, { requestId: input.requestId, userId: input.userId, operationType: input.operationType, modelConfigId: input.modelConfigId, quantity: 1 });
    const taskId = randomUUID();
    try {
        await db.query(`INSERT INTO tasks(id,request_id,batch_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,source_urls,priority,credits,rmb_cost)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [taskId, input.requestId, input.batchId ?? null, input.userId, input.departmentId, input.projectId, input.operationType, input.modelConfigId ?? null, input.prompt, JSON.stringify(input.sourceUrls), input.priority, reservation.credits, reservation.rmbCost]);
        await cache.zAdd("tasks:queue", { score: queueScore(input.priority), value: taskId });
        return { id: taskId, requestId: input.requestId, status: "waiting", credits: reservation.credits, rmbCost: reservation.rmbCost };
    } catch (error) {
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
