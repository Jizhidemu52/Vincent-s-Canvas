import { createHash } from "node:crypto";
import { z } from "zod";
import { uuidSchema } from "../../shared/image-conversation-schemas";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const snapshotSchema = z.strictObject({
  version: z.literal(1), turnId: uuidSchema, modelConfigId: uuidSchema, providerId: uuidSchema,
  endpointHash: sha256Schema, inputHash: sha256Schema,
  sources: z.array(z.strictObject({ assetId: uuidSchema, mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    byteSize: z.number().int().positive().max(50 * 1024 * 1024), sha256: sha256Schema })).max(16),
});
export type ConversationTaskSnapshot = z.infer<typeof snapshotSchema>;
type TaskInput = { prompt: string; parameters: Record<string, unknown>; operationType: string; sourceUrls: string[] };
type StoredTask = {
  request_id: string; model_config_id: string | null; model_id: string | null;
  provider_id: string | null; protocol: string | null; base_url: string | null; workflow_config_id: string | null;
  prompt: string; parameters: Record<string, unknown>; operation_type: string; source_urls: string[];
};
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const parameterNames = ["n", "quality", "complexity", "resolution", "size", "background", "output_format"] as const;
const inputHash = (input: TaskInput) => hash(JSON.stringify([input.operationType, input.prompt,
  parameterNames.map(name => [name, input.parameters[name] ?? null]), input.sourceUrls]));

export function createConversationTaskSnapshot(input: TaskInput & {
  turnId: string; modelConfigId: string; providerId: string; baseUrl: string;
  sources: Array<{ assetId: string; bytes: Uint8Array; mimeType: string }>;
}): ConversationTaskSnapshot {
  return snapshotSchema.parse({ version: 1, turnId: input.turnId, modelConfigId: input.modelConfigId,
    providerId: input.providerId, endpointHash: hash(input.baseUrl), inputHash: inputHash(input),
    sources: input.sources.map(source => ({ assetId: source.assetId, mimeType: source.mimeType,
      byteSize: source.bytes.byteLength, sha256: hash(source.bytes) })) });
}

export function validateConversationTaskBinding(task: StoredTask): ConversationTaskSnapshot {
  const parsed = snapshotSchema.safeParse(task.parameters.conversationInput);
  if (!parsed.success) throw new Error("会话图片任务缺少有效的原始输入快照，尚未提交新的生成请求");
  const snapshot = parsed.data;
  if (task.request_id !== `ic:${snapshot.turnId}:image:1` || snapshot.modelConfigId !== task.model_config_id
    || snapshot.providerId !== task.provider_id || task.model_id !== "gpt-image-2.6-flare" || task.protocol !== "apimart"
    || task.workflow_config_id || !task.base_url || snapshot.endpointHash !== hash(task.base_url)
    || !["image_generation", "inpaint"].includes(task.operation_type)
    || snapshot.inputHash !== inputHash({ prompt: task.prompt, parameters: task.parameters,
      operationType: task.operation_type, sourceUrls: task.source_urls })
    || task.parameters.n !== 1 || task.parameters.count !== 1
    || snapshot.sources.length !== task.source_urls.length
    || snapshot.sources.some((source, index) => task.source_urls[index] !== `/api/assets/${source.assetId}/content`)) {
    throw new Error("会话图片任务的模型通道或原始输入已变化；不会替换模型或重新提交生成");
  }
  return snapshot;
}

export function validateConversationTaskSources(task: StoredTask, sources: Array<{ assetId?: string; bytes: Uint8Array; mimeType: string }>) {
  const snapshot = validateConversationTaskBinding(task);
  if (sources.length !== snapshot.sources.length || sources.some((source, index) => {
    const expected = snapshot.sources[index]!;
    return source.assetId !== expected.assetId || source.mimeType !== expected.mimeType
      || source.bytes.byteLength !== expected.byteSize || hash(source.bytes) !== expected.sha256;
  })) throw new Error("会话底图或参考原件与已冻结输入不一致，尚未提交生成");
}
