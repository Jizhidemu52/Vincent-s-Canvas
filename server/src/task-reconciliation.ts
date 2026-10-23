import { z } from "zod";
import type { PoolClient } from "pg";
import { writeAudit } from "./audit";
import { settleReservation } from "./billing";
import type { Cache, Database } from "./db";
import { withTransaction } from "./db-transaction";
import { removeQueuedTask, scheduleQueuedTask } from "./task-queue";
import { queueScore, recalculateBatch, type TaskPriority } from "./tasks";
import type { SessionUser } from "./types";

export const CHAT_RECONCILIATION_MINUTES = 30;
const recoverableOperations = ["image_generation", "inpaint", "upscale", "remove_background", "batch_image", "seamless_stitch", "video_generation"];
const evidence = {
    reason: z.string().trim().min(2).max(1000),
    evidenceReference: z.string().trim().min(3).max(1000),
};
export const taskReconciliationSchema = z.discriminatedUnion("decision", [
    z.object({ ...evidence, decision: z.literal("confirmed_failed") }).strict(),
    z.object({ ...evidence, decision: z.literal("confirmed_not_submitted") }).strict(),
    z.object({ ...evidence, decision: z.literal("confirmed_success"), resultAssetIds: z.array(z.string().uuid()).min(1).max(20).optional() }).strict(),
    z.object({ ...evidence, decision: z.literal("attach_upstream"), upstreamTaskId: z.string().trim().min(1).max(500).regex(/^[^\s\u0000-\u001f\u007f]+$/) }).strict(),
]);
export const chatReconciliationSchema = z.object({
    ...evidence,
    requestId: z.string().trim().min(1).max(300),
    action: z.enum(["capture", "release"]),
}).strict();
type TaskDecision = z.infer<typeof taskReconciliationSchema>;
type ChatDecision = z.infer<typeof chatReconciliationSchema>;
type AuditActor = { actor: SessionUser; ip?: string };
type TaskRow = {
    id: string; request_id: string; user_id: string; department_id: string | null;
    batch_id: string | null; status: string; priority: TaskPriority; operation_type: string;
    model_config_id: string | null; protocol: string | null; workflow_config_id: string | null;
    upstream_task_id: string | null; model_slot_token: string | null; queued_at: string;
    result_urls: unknown; execution_active: boolean;
};

export class ReconciliationError extends Error {
    constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
function requireSuperAdmin(actor: SessionUser) {
    if (actor.role !== "super_admin") throw new ReconciliationError("FORBIDDEN", "只有超级管理员可以核查结算", 403);
}
const desiredTaskStatus = (decision: TaskDecision["decision"]) => decision === "confirmed_success" ? "success"
    : decision === "confirmed_not_submitted" ? "cancelled" : decision === "confirmed_failed" ? "failed" : "processing";

export async function listTaskReconciliation(db: Database, actor: SessionUser, limit = 100) {
    requireSuperAdmin(actor);
    const tasks = await db.query(
        `SELECT t.id,t.request_id AS "requestId",t.user_id AS "userId",u.display_name AS "displayName",
                t.operation_type AS "operationType",t.model_config_id AS "modelConfigId",m.name AS "modelName",
                p.protocol,m.workflow_config_id AS "workflowConfigId",t.status,t.credits,r.status AS "billingStatus",
                t.upstream_task_id AS "upstreamTaskId",t.upstream_submission_started_at AS "upstreamSubmissionStartedAt",
                t.failure_reason AS "failureReason",t.result_urls AS "resultUrls",t.queued_at AS "queuedAt",t.updated_at AS "updatedAt",
                COALESCE(p.protocol='apimart' AND m.workflow_config_id IS NULL AND t.operation_type=ANY($2::text[]),false) AS "canAttachUpstream"
           FROM tasks t JOIN users u ON u.id=t.user_id
           LEFT JOIN model_configs m ON m.id=t.model_config_id LEFT JOIN providers p ON p.id=m.provider_id
           LEFT JOIN credit_reservations r ON r.request_id=t.request_id
          WHERE t.status='paused' AND (t.lease_expires_at IS NULL OR t.lease_expires_at<=now())
            AND (t.attempts>0 OR t.upstream_task_id IS NOT NULL OR t.upstream_submission_started_at IS NOT NULL)
          ORDER BY t.updated_at,t.id LIMIT $1`, [limit, recoverableOperations],
    );
    const chats = await db.query(
        `SELECT r.id,r.request_id AS "requestId",r.user_id AS "userId",u.display_name AS "displayName",
                r.model_config_id AS "modelConfigId",m.name AS "modelName",r.credits,r.created_at AS "createdAt"
           FROM credit_reservations r JOIN users u ON u.id=r.user_id LEFT JOIN model_configs m ON m.id=r.model_config_id
          WHERE r.operation_type='chat' AND r.status='held' AND r.created_at<=now()-($2::int*interval '1 minute')
            AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.request_id=r.request_id)
          ORDER BY r.created_at,r.id LIMIT $1`, [limit, CHAT_RECONCILIATION_MINUTES],
    );
    return { tasks: tasks.rows, chats: chats.rows, minimumChatAgeMinutes: CHAT_RECONCILIATION_MINUTES };
}

async function checkedResultUrls(client: PoolClient, task: TaskRow, provided?: string[]) {
    const existing = Array.isArray(task.result_urls) ? task.result_urls : [];
    const ids = provided ?? existing.map(value => {
        const match = typeof value === "string" ? /^\/api\/assets\/([a-f0-9-]{36})\/content$/i.exec(value) : null;
        if (!match || !z.string().uuid().safeParse(match[1]).success) {
            throw new ReconciliationError("UNTRUSTED_TASK_RESULT", "已有结果不是可验证的内部素材，请提供原员工的有效素材编号");
        }
        return match[1]!;
    });
    if (!ids.length) throw new ReconciliationError("TASK_RESULT_REQUIRED", "成功结案必须有可交付结果素材");
    if (new Set(ids).size !== ids.length) throw new ReconciliationError("INVALID_TASK_RESULT", "结果素材编号不能重复");
    const result = await client.query<{ id: string; owner_user_id: string; status: string; deleted_at: string | null; kind: string; mime_type: string; byte_size: string | number; object_key: string }>(
        `SELECT id,owner_user_id,status,deleted_at,kind,mime_type,byte_size,object_key FROM assets
          WHERE id=ANY($1::uuid[]) FOR SHARE`, [ids],
    );
    const expected = task.operation_type === "video_generation" ? "video" : task.operation_type === "audio_generation" ? "audio" : "image";
    if (result.rows.length !== ids.length || result.rows.some(asset => asset.owner_user_id !== task.user_id
        || asset.status !== "ready" || asset.deleted_at !== null || Number(asset.byte_size) <= 0 || !asset.object_key
        || asset.kind !== (expected === "audio" ? "other" : expected) || !asset.mime_type.startsWith(`${expected}/`))) {
        throw new ReconciliationError("INVALID_TASK_RESULT", "结果素材必须属于原员工、已就绪且媒体类型与任务一致");
    }
    return ids.map(id => `/api/assets/${id}/content`);
}

async function updateBatch(client: PoolClient, batchId: string | null) {
    if (!batchId) return;
    await client.query("SELECT id FROM batch_tasks WHERE id=$1 FOR UPDATE", [batchId]);
    await recalculateBatch(client as unknown as Database, batchId);
}

export async function reconcileTask(db: Database, cache: Cache, taskId: string, input: TaskDecision & AuditActor) {
    requireSuperAdmin(input.actor);
    // Validate at the domain boundary too: callers cannot bypass evidence checks.
    const decision = taskReconciliationSchema.parse(Object.fromEntries(Object.entries(input).filter(([key]) => key !== "actor" && key !== "ip")));
    const committed = await withTransaction(db, async client => {
        // Match Worker finalization lock order: task -> reservation -> wallets.
        // Never acquire the model admission advisory lock after this task lock.
        const selected = await client.query<TaskRow>(
            `SELECT t.id,t.request_id,t.user_id,t.department_id,t.batch_id,t.status,t.priority,t.operation_type,
                    t.model_config_id,p.protocol,m.workflow_config_id,t.upstream_task_id,t.model_slot_token,t.queued_at,t.result_urls,
                    COALESCE(t.lease_expires_at>now(),false) AS execution_active
               FROM tasks t LEFT JOIN model_configs m ON m.id=t.model_config_id LEFT JOIN providers p ON p.id=m.provider_id
              WHERE t.id=$1 FOR UPDATE OF t`, [taskId],
        );
        const task = selected.rows[0];
        if (!task) throw new ReconciliationError("TASK_NOT_FOUND", "任务不存在", 404);
        const prior = await client.query<{ detail: { decision?: string; upstreamTaskId?: string } }>(
            "SELECT detail FROM audit_logs WHERE action='task.reconciled' AND target_type='task' AND target_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [task.id],
        );
        const previous = prior.rows[0]?.detail;
        const repeatedAttachment = decision.decision === "attach_upstream" && previous?.decision === "attach_upstream"
            && previous.upstreamTaskId === decision.upstreamTaskId && task.upstream_task_id === decision.upstreamTaskId;
        const repeatedTerminal = decision.decision !== "attach_upstream" && previous?.decision === decision.decision && task.status === desiredTaskStatus(decision.decision);
        if (repeatedTerminal || (repeatedAttachment && task.status !== "paused")) {
            return { task, duplicate: true, shouldQueue: repeatedAttachment && task.status === "processing" && !task.execution_active, slotToRemove: null as string | null };
        }
        // status='paused' fences Worker writes. An expired stale token is safe to
        // clear under this row lock; a still-live lease is never reconciled.
        if (task.status !== "paused" || task.execution_active) throw new ReconciliationError("TASK_NOT_RECONCILABLE", "仅能核查已暂停且没有活跃执行租约的任务");
        const reservation = await client.query<{ status: string; user_id: string }>(
            "SELECT status,user_id FROM credit_reservations WHERE request_id=$1 FOR UPDATE", [task.request_id],
        );
        if (!reservation.rows[0] || reservation.rows[0].user_id !== task.user_id) throw new ReconciliationError("TASK_RESERVATION_MISMATCH", "任务预占记录缺失或归属不一致，不能自动结案");
        let resultUrls = Array.isArray(task.result_urls) ? task.result_urls as string[] : [];
        if (decision.decision === "attach_upstream") {
            if (task.protocol !== "apimart" || task.workflow_config_id || !recoverableOperations.includes(task.operation_type)) {
                throw new ReconciliationError("UPSTREAM_ATTACH_UNSUPPORTED", "仅 APIMart 图片或视频的非工作流任务支持关联原上游任务");
            }
            if (task.upstream_task_id && task.upstream_task_id !== decision.upstreamTaskId) throw new ReconciliationError("UPSTREAM_ID_CONFLICT", "已有上游任务编号不能被替换");
            if (reservation.rows[0].status !== "held") throw new ReconciliationError("RESERVATION_ALREADY_SETTLED", "积分已结算，不能恢复上游任务");
            await client.query(
                `UPDATE tasks SET upstream_task_id=$2,upstream_submission_started_at=COALESCE(upstream_submission_started_at,now()),
                    status='processing',execution_token=NULL,lease_expires_at=NULL,available_at=now(),failure_reason=NULL,
                    poll_deadline_at=CASE WHEN operation_type='video_generation' THEN now()+interval '20 minutes' ELSE poll_deadline_at END,updated_at=now()
                  WHERE id=$1`, [task.id, decision.upstreamTaskId],
            );
            task.upstream_task_id = decision.upstreamTaskId;
        } else {
            const outcome = decision.decision === "confirmed_success" ? "capture" : "release";
            const settled = outcome === "capture" ? "captured" : "released";
            if (reservation.rows[0].status !== "held" && reservation.rows[0].status !== settled) {
                throw new ReconciliationError("RESERVATION_ALREADY_SETTLED", "积分已按相反结论结算，不能反转");
            }
            if (decision.decision === "confirmed_success") resultUrls = await checkedResultUrls(client, task, decision.resultAssetIds);
            else resultUrls = [];
            await settleReservation(db, task.request_id, outcome, input.actor.id, client);
            await client.query(
                `UPDATE tasks SET status=$2,result_urls=$3,failure_reason=$4,execution_token=NULL,lease_expires_at=NULL,
                    model_slot_token=NULL,model_slot_expires_at=NULL,completed_at=now(),updated_at=now() WHERE id=$1`,
                [task.id, desiredTaskStatus(decision.decision), JSON.stringify(resultUrls), decision.decision === "confirmed_success" ? null : decision.reason],
            );
            await client.query(
                `INSERT INTO generation_history(task_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status,failure_reason)
                 SELECT id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,
                        CASE WHEN status='success' THEN credits ELSE 0 END,CASE WHEN status='success' THEN rmb_cost ELSE 0 END,
                        CASE WHEN status='success' THEN 'success' ELSE 'failed' END,failure_reason FROM tasks WHERE id=$1
                 ON CONFLICT(task_id) DO UPDATE SET result_urls=EXCLUDED.result_urls,credits=EXCLUDED.credits,rmb_cost=EXCLUDED.rmb_cost,status=EXCLUDED.status,failure_reason=EXCLUDED.failure_reason`, [task.id],
            );
        }
        await writeAudit(client, {
            actor: input.actor, action: "task.reconciled", targetType: "task", targetId: task.id,
            departmentId: task.department_id, result: "success", ip: input.ip,
            detail: { ...decision, previousStatus: task.status, requestId: task.request_id, resultUrls },
        });
        await updateBatch(client, task.batch_id);
        task.status = desiredTaskStatus(decision.decision);
        task.result_urls = resultUrls;
        return { task, duplicate: false, shouldQueue: decision.decision === "attach_upstream", slotToRemove: decision.decision === "attach_upstream" ? null : task.model_slot_token };
    });
    // SQL is authoritative. Redis failures never undo a committed settlement or
    // erase an attached upstream identity; normal queue recovery rediscovers it.
    let queuePending = false;
    try {
        if (committed.shouldQueue) await scheduleQueuedTask(cache, taskId, queueScore(committed.task.priority, new Date(committed.task.queued_at).getTime()));
        else if (committed.task.status !== "processing") await removeQueuedTask(cache, taskId);
        if (committed.slotToRemove) await cache.zRem(`model:${committed.task.model_config_id ?? "none"}:leases`, `${taskId}:${committed.slotToRemove}`);
    } catch {
        queuePending = true;
        console.warn(JSON.stringify({ event: "task.reconciliation_cache_pending", taskId }));
    }
    return { id: taskId, status: committed.task.status, decision: decision.decision, duplicate: committed.duplicate,
        resultUrls: committed.task.result_urls as string[], upstreamTaskId: committed.task.upstream_task_id, queuePending };
}

export async function reconcileChatReservation(db: Database, input: ChatDecision & AuditActor) {
    requireSuperAdmin(input.actor);
    const decision = chatReconciliationSchema.parse(Object.fromEntries(Object.entries(input).filter(([key]) => key !== "actor" && key !== "ip")));
    return withTransaction(db, async client => {
        const selected = await client.query<{ id: string; status: string; operation_type: string; department_id: string | null; old_enough: boolean }>(
            `SELECT id,status,operation_type,department_id,created_at<=now()-($2::int*interval '1 minute') AS old_enough
               FROM credit_reservations WHERE request_id=$1 FOR UPDATE`, [decision.requestId, CHAT_RECONCILIATION_MINUTES],
        );
        const reservation = selected.rows[0];
        if (!reservation) throw new ReconciliationError("RESERVATION_NOT_FOUND", "聊天预占记录不存在", 404);
        if (reservation.operation_type !== "chat" || (await client.query("SELECT id FROM tasks WHERE request_id=$1", [decision.requestId])).rows.length) {
            throw new ReconciliationError("NOT_ORPHAN_CHAT_RESERVATION", "只能核查不关联生成任务的聊天预占");
        }
        const desired = decision.action === "capture" ? "captured" : "released";
        if (reservation.status !== "held") {
            const prior = await client.query<{ detail: { action?: string } }>(
                "SELECT detail FROM audit_logs WHERE action='chat.reservation_reconciled' AND target_type='credit_reservation' AND target_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [reservation.id],
            );
            if (reservation.status === desired && prior.rows[0]?.detail.action === decision.action) return { requestId: decision.requestId, status: desired, duplicate: true };
            throw new ReconciliationError("RESERVATION_ALREADY_SETTLED", "聊天预占已结算，不能更改结论");
        }
        if (!reservation.old_enough) throw new ReconciliationError("CHAT_RECONCILIATION_TOO_EARLY", "聊天请求未满 30 分钟，可能仍在执行，暂不能人工结算");
        await settleReservation(db, decision.requestId, decision.action, input.actor.id, client);
        await writeAudit(client, {
            actor: input.actor, action: "chat.reservation_reconciled", targetType: "credit_reservation", targetId: reservation.id,
            departmentId: reservation.department_id, result: "success", detail: { ...decision }, ip: input.ip,
        });
        return { requestId: decision.requestId, status: desired, duplicate: false };
    });
}
