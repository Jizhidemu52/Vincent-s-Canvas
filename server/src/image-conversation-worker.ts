import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ClarifyPlan, ContextManifest, PlannerPlan, SettingsSnapshot, TurnError } from "../../shared/image-conversation-contracts";
import { contextManifestSchema, plannerPlanSchema, settingsSnapshotSchema } from "../../shared/image-conversation-schemas";
import type { Database } from "./db";
import { withTransaction } from "./db-transaction";
import {
  appendConversationEvent, appendConversationMessage, assertOwnedImage, readConversation, readVersion, safeCounter, turnSnapshot,
  type ConversationRow, type TurnRow,
} from "./image-conversation-store";
import { enqueueTaskInTransaction, lockTaskAdmission, type EnqueuedTaskResult, type PreparedTaskEnqueue } from "./tasks";

export type ConversationExecution = { conversation: ConversationRow; turn: TurnRow };
export type PreparedConversationPlanner = {
  manifest: ContextManifest;
  run: () => Promise<PlannerPlan>;
};
export type PreparedConversationImage = {
  task: PreparedTaskEnqueue;
  settings: SettingsSnapshot;
  manifest: ContextManifest;
  validate: (client: PoolClient) => Promise<void>;
};
export type ImageConversationWorkerDependencies = {
  preparePlanner: (execution: ConversationExecution, updateManifest: (manifest: ContextManifest) => Promise<void>) => Promise<PreparedConversationPlanner>;
  prepareImage: (execution: ConversationExecution) => Promise<PreparedConversationImage | { clarification: ClarifyPlan }>;
  resolveRestore: (execution: ConversationExecution) => Promise<string>;
  publishTask: (task: EnqueuedTaskResult) => Promise<unknown>;
  wake: (conversationId: string) => void;
  classifyError?: (error: unknown) => TurnError | undefined;
  leaseMs?: number;
  heartbeatMs?: number;
};
type Fence = { ownerId: string; conversationId: string; turnId: string; token: string; epoch: number };

async function lockedExecution(client: PoolClient, fence: Pick<Fence, "ownerId" | "conversationId" | "turnId">): Promise<ConversationExecution> {
  await lockTaskAdmission(client, fence.ownerId);
  const conversation = await readConversation(client, fence.ownerId, fence.conversationId, true);
  const result = await client.query<TurnRow>("SELECT * FROM image_conversation_turns WHERE conversation_id=$1 AND id=$2 FOR UPDATE", [fence.conversationId, fence.turnId]);
  if (!result.rows[0]) throw new Error("Conversation turn missing");
  return { conversation, turn: result.rows[0] };
}
async function currentFence(client: PoolClient, fence: Fence) {
  const current = await lockedExecution(client, fence);
  const valid = await client.query("SELECT id FROM image_conversation_turns WHERE id=$1 AND state='planning' AND execution_epoch=$2 AND planner_lease_token=$3 AND planner_lease_expires_at>now()", [fence.turnId, fence.epoch, fence.token]);
  return valid.rows.length ? current : null;
}
async function writeTurnEvent(client: PoolClient, execution: ConversationExecution, type: "turn.updated" | "turn.failed" | "plan.ready" | "turn.completed" | "task.queued") {
  await appendConversationEvent(client, execution.conversation, execution.turn.id, type,
    { stateRevision: safeCounter(execution.conversation.state_revision), turn: turnSnapshot(execution.turn) });
}
async function failExecution(client: PoolClient, execution: ConversationExecution, error: TurnError, plannerUnknown = false) {
  const changed = await client.query<TurnRow>(`UPDATE image_conversation_turns SET state='failed',last_error=$2,
    planner_status=CASE WHEN $3 THEN 'unknown' WHEN planner_status='succeeded' THEN planner_status ELSE 'failed' END,
    execution_epoch=execution_epoch+1,planner_lease_token=NULL,planner_lease_expires_at=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
  [execution.turn.id, JSON.stringify(error), plannerUnknown]);
  execution.turn = changed.rows[0];
  await appendConversationMessage(client, execution.conversation, { turnId: execution.turn.id, role: "assistant", kind: "status", text: error.message, attachments: [] });
  await writeTurnEvent(client, execution, "turn.failed");
}
const unknownPlanner: TurnError = { code: "PLANNER_OUTCOME_UNKNOWN", message: "本轮理解请求已开始，但结果未能确认；不会自动重发。原请求费用另行核查，你可以发送新的独立需求。", retryable: false };

async function claimTurn(db: Database, turnId: string, leaseMs: number) {
  const identity = (await db.query<{ owner_user_id: string; conversation_id: string }>("SELECT owner_user_id,conversation_id FROM image_conversation_turns WHERE id=$1", [turnId])).rows[0];
  if (!identity) return null;
  const token = randomUUID();
  return withTransaction(db, async client => {
    const execution = await lockedExecution(client, { ownerId: identity.owner_user_id, conversationId: identity.conversation_id, turnId });
    if (execution.turn.state !== "accepted" || execution.turn.task_id) return null;
    if (execution.turn.planner_dispatch_started_at && !execution.turn.plan) {
      await failExecution(client, execution, unknownPlanner, true);
      return null;
    }
    const claimed = await client.query<TurnRow>(`UPDATE image_conversation_turns SET state='planning',execution_epoch=execution_epoch+1,
      planner_lease_token=$2,planner_lease_expires_at=now()+$3*interval '1 millisecond',updated_at=now() WHERE id=$1 RETURNING *`, [turnId, token, leaseMs]);
    execution.turn = claimed.rows[0];
    await writeTurnEvent(client, execution, "turn.updated");
    return { execution, fence: { ownerId: identity.owner_user_id, conversationId: identity.conversation_id, turnId, token, epoch: safeCounter(execution.turn.execution_epoch) } };
  });
}

export async function recoverExpiredConversationPlanning(db: Database, wake: (conversationId: string) => void, limit = 100) {
  const candidates = await db.query<{ id: string; conversation_id: string; owner_user_id: string }>(`SELECT id,conversation_id,owner_user_id FROM image_conversation_turns
    WHERE state='planning' AND (planner_lease_expires_at IS NULL OR planner_lease_expires_at<=now()) ORDER BY updated_at,id LIMIT $1`, [limit]);
  let recovered = 0;
  for (const row of candidates.rows) {
    const changed = await withTransaction(db, async client => {
      const execution = await lockedExecution(client, { ownerId: row.owner_user_id, conversationId: row.conversation_id, turnId: row.id });
      const expired = await client.query("SELECT id FROM image_conversation_turns WHERE id=$1 AND state='planning' AND (planner_lease_expires_at IS NULL OR planner_lease_expires_at<=now())", [row.id]);
      if (!expired.rows.length) return false;
      if (execution.turn.planner_dispatch_started_at && !execution.turn.plan) await failExecution(client, execution, unknownPlanner, true);
      else {
        const reset = await client.query<TurnRow>(`UPDATE image_conversation_turns SET state='accepted',execution_epoch=execution_epoch+1,
          planner_lease_token=NULL,planner_lease_expires_at=NULL,updated_at=now() WHERE id=$1 RETURNING *`, [row.id]);
        execution.turn = reset.rows[0];
        await writeTurnEvent(client, execution, "turn.updated");
      }
      return true;
    });
    if (changed) { recovered++; wake(row.conversation_id); }
  }
  return recovered;
}

export async function processImageConversationTurn(db: Database, turnId: string, dependencies: ImageConversationWorkerDependencies) {
  const leaseMs = dependencies.leaseMs ?? 90_000;
  const claimed = await claimTurn(db, turnId, leaseMs);
  if (!claimed) return false;
  const { fence } = claimed;
  let execution = claimed.execution;
  let dispatchStarted = false;
  let responseReceived = false;
  let planPersisted = Boolean(execution.turn.plan);
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void db.query(`UPDATE image_conversation_turns SET planner_lease_expires_at=now()+$4*interval '1 millisecond'
      WHERE id=$1 AND state='planning' AND execution_epoch=$2 AND planner_lease_token=$3 AND planner_lease_expires_at>now()`,
    [fence.turnId, fence.epoch, fence.token, leaseMs]).catch(() => undefined).finally(() => { heartbeatBusy = false; });
  }, dependencies.heartbeatMs ?? 20_000);
  heartbeat.unref();
  dependencies.wake(fence.conversationId);
  try {
    if (!execution.turn.plan) {
      const prepared = await dependencies.preparePlanner(execution, async manifest => {
        const parsed = contextManifestSchema.parse(manifest);
        await withTransaction(db, async client => {
          const current = await currentFence(client, fence);
          if (!current || current.turn.planner_status !== "in_flight") throw new Error("Conversation planner fence changed");
          await client.query("UPDATE image_conversation_turns SET context_manifest=$2,updated_at=now() WHERE id=$1", [turnId, JSON.stringify(parsed)]);
        });
      });
      const manifest = contextManifestSchema.parse(prepared.manifest);
      const marked = await withTransaction(db, async client => {
        const current = await currentFence(client, fence);
        if (!current || current.turn.planner_dispatch_started_at || current.turn.plan) return null;
        const updated = await client.query<TurnRow>(`UPDATE image_conversation_turns SET planner_status='in_flight',planner_request_id=$2,
          planner_dispatch_started_at=now(),context_manifest=$3,updated_at=now() WHERE id=$1 RETURNING *`,
        [turnId, `ic:${turnId}:planner:1`, JSON.stringify(manifest)]);
        return { ...current, turn: updated.rows[0] };
      });
      if (!marked) return false;
      dispatchStarted = true;
      const result = await prepared.run();
      responseReceived = true;
      const plan = plannerPlanSchema.parse(result);
      const saved = await withTransaction(db, async client => {
        const current = await currentFence(client, fence);
        if (!current) return null;
        const updated = await client.query<TurnRow>("UPDATE image_conversation_turns SET plan=$2,intent=$3,planner_status='succeeded',updated_at=now() WHERE id=$1 RETURNING *", [turnId, JSON.stringify(plan), plan.action]);
        current.turn = updated.rows[0];
        await writeTurnEvent(client, current, "plan.ready");
        return current;
      });
      if (!saved) return false;
      execution = saved;
      planPersisted = true;
      dependencies.wake(fence.conversationId);
    }
    const plan = plannerPlanSchema.parse(execution.turn.plan);
    if (plan.action === "discuss" || plan.action === "clarify" || plan.action === "restore") {
      const restoreId = plan.action === "restore" ? await dependencies.resolveRestore(execution) : null;
      await withTransaction(db, async client => {
        const current = await currentFence(client, fence);
        if (!current) return;
        if (restoreId) {
          const version = await readVersion(client, current.conversation.id, restoreId);
          await assertOwnedImage(client, current.conversation.owner_user_id, version.asset_id);
          const updated = await client.query<{ state_revision: string }>("UPDATE image_conversations SET active_version_id=$2,state_revision=state_revision+1,updated_at=now() WHERE id=$1 RETURNING state_revision", [current.conversation.id, restoreId]);
          current.conversation.active_version_id = restoreId;
          current.conversation.state_revision = updated.rows[0].state_revision;
          await appendConversationEvent(client, current.conversation, turnId, "active.changed", { stateRevision: safeCounter(current.conversation.state_revision), activeVersionId: restoreId, reason: "restore" });
        }
        const updated = await client.query<TurnRow>("UPDATE image_conversation_turns SET state='completed',base_version_id=$2,planner_lease_token=NULL,planner_lease_expires_at=NULL,updated_at=now() WHERE id=$1 RETURNING *", [turnId, restoreId]);
        current.turn = updated.rows[0];
        await appendConversationMessage(client, current.conversation, { turnId, role: "assistant", kind: "text", text: plan.action === "clarify" ? plan.question : plan.assistantText, attachments: [] });
        await writeTurnEvent(client, current, "turn.completed");
      });
    } else {
      const prepared = await dependencies.prepareImage(execution);
      if ("clarification" in prepared) {
        const clarified = plannerPlanSchema.parse(prepared.clarification);
        if (clarified.action !== "clarify") throw new Error("Invalid clarification");
        await withTransaction(db, async client => {
          const current = await currentFence(client, fence);
          if (!current) return;
          const updated = await client.query<TurnRow>(`UPDATE image_conversation_turns SET state='completed',intent='clarify',plan=$2,
            planner_lease_token=NULL,planner_lease_expires_at=NULL,updated_at=now() WHERE id=$1 RETURNING *`, [turnId, JSON.stringify(clarified)]);
          current.turn = updated.rows[0];
          await appendConversationMessage(client, current.conversation, { turnId, role: "assistant", kind: "text", text: clarified.question, attachments: [] });
          await writeTurnEvent(client, current, "turn.completed");
        });
        return true;
      }
      const settings = settingsSnapshotSchema.parse(prepared.settings);
      const manifest = contextManifestSchema.parse(prepared.manifest);
      if (prepared.task.input.requestId !== `ic:${turnId}:image:1` || prepared.task.input.userId !== fence.ownerId
        || prepared.task.input.modelConfigId !== settings.effective.modelConfigId
        || (execution.conversation.canvas_external_id ?? "") !== prepared.task.input.projectId) throw new Error("Invalid conversation task binding");
      const queued = await withTransaction(db, async client => {
        const current = await currentFence(client, fence);
        if (!current || current.turn.task_id) return null;
        await prepared.validate(client);
        const task = await enqueueTaskInTransaction(client, prepared.task);
        const updated = await client.query<TurnRow>(`UPDATE image_conversation_turns SET state='queued',task_id=$2,task_request_id=$3,settings_snapshot=$4,
          base_version_id=$5,context_manifest=$6,planner_lease_token=NULL,planner_lease_expires_at=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
        [turnId, task.task.id, task.task.requestId, JSON.stringify(settings), manifest.baseVersionId, JSON.stringify(manifest)]);
        current.turn = updated.rows[0];
        await appendConversationEvent(client, current.conversation, turnId, "settings.resolved", { stateRevision: safeCounter(current.conversation.state_revision), turnId, settingsSnapshot: settings });
        await writeTurnEvent(client, current, "task.queued");
        return task;
      });
      if (queued) await dependencies.publishTask(queued).catch(() => undefined);
    }
    return true;
  } catch (error) {
    const classified = dependencies.classifyError?.(error);
    const unknown = dispatchStarted && !responseReceived && !planPersisted && (!classified || classified.code === "PLANNER_OUTCOME_UNKNOWN");
    const reason = unknown ? unknownPlanner
      : classified ?? { code: planPersisted ? "PLAN_INVALID" : "PLANNER_FAILED", message: "本轮需求处理未完成，尚未创建图片任务。请检查原轮次状态后再操作。", retryable: false } satisfies TurnError;
    await withTransaction(db, async client => {
      const current = await currentFence(client, fence);
      if (current && !current.turn.task_id) await failExecution(client, current, reason, unknown);
    });
    return false;
  } finally {
    clearInterval(heartbeat);
    dependencies.wake(fence.conversationId);
  }
}

export function startImageConversationWorker(db: Database, dependencies: ImageConversationWorkerDependencies, options: {
  pollMs?: number; projectTasks: () => Promise<unknown>; onError?: (error: unknown) => void;
}) {
  let stopped = false;
  let running: Promise<void> | null = null;
  const processing = new Map<string, Promise<unknown>>();
  let requested = false;
  const run = () => {
    if (stopped) return;
    if (running) { requested = true; return; }
    running = (async () => {
      await recoverExpiredConversationPlanning(db, dependencies.wake);
      await options.projectTasks();
      const accepted = await db.query<{ id: string }>("SELECT id FROM image_conversation_turns WHERE state='accepted' ORDER BY created_at,id LIMIT 8");
      for (const row of accepted.rows) {
        if (stopped || processing.size >= 4) break;
        if (processing.has(row.id)) continue;
        const operation = processImageConversationTurn(db, row.id, dependencies)
          .catch(error => options.onError?.(error)).finally(() => { processing.delete(row.id); });
        processing.set(row.id, operation);
      }
    })().catch(error => options.onError?.(error)).finally(() => {
      running = null;
      if (requested) { requested = false; queueMicrotask(run); }
    });
  };
  const timer = setInterval(run, options.pollMs ?? 3_000);
  timer.unref();
  run();
  return { wake: run, async stop() { stopped = true; clearInterval(timer); await running; await Promise.all(processing.values()); } };
}
