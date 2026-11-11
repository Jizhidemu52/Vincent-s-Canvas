import { z } from "zod";
import { isPublicHttpUrl } from "./apimart-upload";
import type { Database } from "./db";
import { withTransaction } from "./db-transaction";
import { TaskExecutionLost } from "./model-concurrency";
import { supportedVideoModelIds } from "./video-models";

export type ApiMartVideoReceiptIdentity = {
  taskId: string; userId: string; modelConfigId: string; modelId: string; upstreamTaskId: string;
};
export type ApiMartVideoCompletedResult = { status: "completed"; upstreamTaskId: string; url: string; costUsd?: number };

const identitySchema = z.object({
  taskId: z.string().uuid(), userId: z.string().uuid(), modelConfigId: z.string().uuid(),
  modelId: z.enum(supportedVideoModelIds),
  upstreamTaskId: z.string().min(1).max(500).refine(value => value === value.trim()),
});
const resultUrl = z.string().min(1).max(16_384).refine(value => value === value.trim() && isPublicHttpUrl(value));
const receiptBase = identitySchema.extend({
  schema: z.literal("canvas.video-provider-receipt"), version: z.literal(1), kind: z.literal("apimart-video"),
  status: z.literal("completed"), url: resultUrl, currency: z.literal("USD"),
});
const receiptSchema = z.discriminatedUnion("costStatus", [
  receiptBase.extend({ costStatus: z.literal("known"), costUsd: z.number().finite().nonnegative() }).strict(),
  receiptBase.extend({ costStatus: z.literal("unknown"), costUsd: z.never().optional() }).strict(),
]);
const completedResultSchema = z.object({
  status: z.literal("completed"), upstreamTaskId: identitySchema.shape.upstreamTaskId,
  url: resultUrl, costUsd: z.number().finite().nonnegative().optional(),
}).strict();
export type ApiMartVideoReceipt = z.infer<typeof receiptSchema>;

export class VideoProviderReceiptError extends Error {
  constructor(readonly code: "VIDEO_PROVIDER_RECEIPT_INVALID" | "VIDEO_PROVIDER_RECEIPT_IDENTITY_MISMATCH" | "VIDEO_PROVIDER_RECEIPT_CONFLICT") {
    super(code === "VIDEO_PROVIDER_RECEIPT_IDENTITY_MISMATCH" ? "视频上游收据与当前任务身份不一致，已停止恢复，不会重新生成"
      : code === "VIDEO_PROVIDER_RECEIPT_CONFLICT" ? "视频上游收据与已保存结果冲突，已保留原收据，不会重新生成"
        : "视频上游收据格式无效，已停止保存或恢复，不会重新生成");
    this.name = "VideoProviderReceiptError";
  }
}

function parseIdentity(identity: ApiMartVideoReceiptIdentity) {
  const parsed = identitySchema.safeParse(identity);
  if (!parsed.success) throw new VideoProviderReceiptError("VIDEO_PROVIDER_RECEIPT_INVALID");
  return parsed.data;
}

/** Private Worker-only document. Never project its URL/cost into public result_document. */
export function readApiMartVideoReceipt(document: unknown, identity: ApiMartVideoReceiptIdentity): ApiMartVideoReceipt | null {
  if (document === null || document === undefined) return null;
  const expected = parseIdentity(identity);
  const parsed = receiptSchema.safeParse(document);
  if (!parsed.success) throw new VideoProviderReceiptError("VIDEO_PROVIDER_RECEIPT_INVALID");
  const receipt = parsed.data;
  for (const key of ["taskId", "userId", "modelConfigId", "modelId", "upstreamTaskId"] as const) {
    if (receipt[key] !== expected[key]) throw new VideoProviderReceiptError("VIDEO_PROVIDER_RECEIPT_IDENTITY_MISMATCH");
  }
  return receipt;
}

const receiptFence = `t.id=$1 AND t.user_id=$2 AND t.model_config_id=$3 AND t.upstream_task_id=$5
  AND t.execution_token=$6 AND t.status='processing' AND t.lease_expires_at>clock_timestamp()
  AND t.operation_type='video_generation'
  AND EXISTS (SELECT 1 FROM model_configs m JOIN providers p ON p.id=m.provider_id
    WHERE m.id=t.model_config_id AND m.model_id=$4 AND p.protocol='apimart')`;

/** Persist completion before downloading. This helper never submits, polls, bills or exposes a result. */
export async function saveApiMartVideoReceipt(db: Database, input: ApiMartVideoReceiptIdentity & { executionToken: string }, result: ApiMartVideoCompletedResult): Promise<ApiMartVideoReceipt> {
  const identity = parseIdentity(input), token = z.string().uuid().safeParse(input.executionToken);
  const completed = completedResultSchema.safeParse(result);
  if (!token.success || !completed.success) throw new VideoProviderReceiptError("VIDEO_PROVIDER_RECEIPT_INVALID");
  if (completed.data.upstreamTaskId !== identity.upstreamTaskId) throw new VideoProviderReceiptError("VIDEO_PROVIDER_RECEIPT_IDENTITY_MISMATCH");
  const incoming = receiptSchema.parse({ ...identity, schema: "canvas.video-provider-receipt", version: 1, kind: "apimart-video",
    status: "completed", url: completed.data.url, currency: "USD",
    ...(completed.data.costUsd === undefined ? { costStatus: "unknown" } : { costStatus: "known", costUsd: completed.data.costUsd }),
  });
  const values = [identity.taskId, identity.userId, identity.modelConfigId, identity.modelId, identity.upstreamTaskId, token.data];
  return withTransaction(db, async client => {
    const found = await client.query<{ document: unknown }>(
      `SELECT t.upstream_result_document AS document FROM tasks t WHERE ${receiptFence} FOR UPDATE OF t`, values,
    );
    if (!found.rows[0]) throw new TaskExecutionLost("视频上游收据保存权已改变，未写入结果");
    const previous = found.rows[0].document;
    const existing = readApiMartVideoReceipt(previous, identity);
    if (existing && (existing.url !== incoming.url || existing.costStatus === "known" && incoming.costStatus === "known" && existing.costUsd !== incoming.costUsd)) {
      throw new VideoProviderReceiptError("VIDEO_PROVIDER_RECEIPT_CONFLICT");
    }
    // Final known cost is immutable; a later response lacking cost cannot erase it.
    const receipt = existing && (existing.costStatus === "known" || incoming.costStatus === "unknown") ? existing : incoming;
    const saved = await client.query<{ document: unknown }>(
      `UPDATE tasks t SET upstream_result_document=$7::jsonb,updated_at=now()
       WHERE ${receiptFence} AND t.upstream_result_document IS NOT DISTINCT FROM $8::jsonb
       RETURNING t.upstream_result_document AS document`,
      [...values, JSON.stringify(receipt), previous === null || previous === undefined ? null : JSON.stringify(previous)],
    );
    if (!saved.rows[0]) throw new TaskExecutionLost("视频上游收据写入时执行权已改变，未覆盖原结果");
    return readApiMartVideoReceipt(saved.rows[0].document, identity)!;
  });
}
