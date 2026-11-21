import { createHash } from "node:crypto";
import { z } from "zod";
import { isReviewValidationFailure } from "../../shared/task-repair";
import { preflightApiMartImageRequest } from "./apimart-image";
import { readSourceAssetObject } from "./asset-object-error";
import { loadTaskPriceSnapshot } from "./billing";
import { loadConfig } from "./config";
import type { Database } from "./db";
import { inspectEditImage, prepareImageEditInput } from "./image-edit-input";
import { ObjectStorage } from "./object-storage";
import { prepareConfiguredQuickImageTask } from "./quick-image-configuration";
import { resolveToolExecution, ToolConfigurationError } from "./tool-configuration";
import type { TaskInput } from "./tasks";

const MAX_FILE = 50 * 1024 * 1024;
const reference = z.object({
  url: z.string(),
  type: z.string(),
  bytes: z.number().int().positive().max(MAX_FILE),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const archiveSchema = z
  .object({
    version: z.literal(1),
    ownerId: z.string(),
    modelConfigId: z.string(),
    modelId: z.string(),
    references: z.array(reference).min(1).max(32),
    config: z.record(z.string(), z.unknown()),
    parameters: z.record(z.string(), z.unknown()),
  })
  .passthrough();

function unavailable(message: string): never {
  throw new ToolConfigurationError("ORIGINAL_SIZE_UNAVAILABLE", message, 409);
}
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
type Snapshot = {
  id: string;
  projectId: string;
  toolKey: string;
  modelConfigId: string;
  modelId: string;
  modelName: string;
  providerId: string;
  protocol: string;
  workflowId: string | null;
  operationType: string;
  pausedKind: string;
  status: string;
  repairErrorCode: string | null;
  prompt: string;
  userInput: TaskInput["userInput"];
  optimized: boolean;
  parameters: Record<string, unknown>;
  sourceUrls: string[];
};

async function readFile(key: string, length: number): Promise<Uint8Array> {
  const object = await readSourceAssetObject(new ObjectStorage(loadConfig()), key);
  const reader = object.Body!.transformToWebStream().getReader();
  try {
    if (object.ContentLength !== length) unavailable("原输入大小已变化，未提交重出。");
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > length) unavailable("原输入超过记录大小，未提交重出。");
      parts.push(item.value);
    }
    return Buffer.concat(parts, size);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function prepareOriginalSizeReissue(
  db: Pick<Database, "query">,
  taskId: string,
  actor: { id: string; departmentId: string | null },
  creditsEnabled: boolean,
  read = readFile,
) {
  const original = (
    await db.query<Snapshot>(
      `SELECT t.id,t.project_id AS "projectId",t.tool_key AS "toolKey",t.operation_type AS "operationType",t.status,
        t.paused_kind AS "pausedKind",t.repair_error_code AS "repairErrorCode",t.model_config_id AS "modelConfigId",m.model_id AS "modelId",m.name AS "modelName",m.provider_id AS "providerId",p.protocol,m.workflow_config_id AS "workflowId",
        t.prompt,t.parameters,t.source_urls AS "sourceUrls",t.user_input AS "userInput",t.prompt_optimized AS optimized FROM tasks t LEFT JOIN model_configs m ON m.id=t.model_config_id LEFT JOIN providers p ON p.id=m.provider_id WHERE t.id=$1 AND t.user_id=$2`,
      [taskId, actor.id],
    )
  ).rows[0];
  if (!original) throw new ToolConfigurationError("NOT_FOUND", "未找到该任务", 404);
  if (
    original.status !== "paused" ||
    original.pausedKind !== "needs_review" ||
    !isReviewValidationFailure(original.repairErrorCode)
  )
    unavailable("只有已出图且校验未通过的任务可重出；提交未知时请查询原单。");
  if (!["inpaint", "image_generation"].includes(original.operationType) || original.protocol !== "apimart" || original.workflowId)
    unavailable("原任务的生成接口不能核实精确像素尺寸，未提交重出。");
  const parsed = archiveSchema.safeParse(original.parameters.inputArchive);
  const archive = parsed.success ? parsed.data : null;
  let references = archive?.references;
  if (
    !references &&
    original.parameters.quickImageAction &&
    original.parameters.inputArchive === undefined &&
    original.sourceUrls.length === 1
  ) {
    const url = original.sourceUrls[0]!;
    const id = /^\/api\/assets\/([0-9a-f-]{36})\/content$/i.exec(url)?.[1];
    if (z.string().uuid().safeParse(id).success) {
      const asset = (
        await db.query<{ type: string; bytes: string; sha256: string | null }>(
          `SELECT mime_type AS type,byte_size AS bytes,content_sha256 AS sha256 FROM assets WHERE id=$1 AND owner_user_id=$2 AND status='ready' AND deleted_at IS NULL`,
          [id, actor.id],
        )
      ).rows[0];
      const verified = asset && reference.safeParse({ ...asset, bytes: Number(asset.bytes), url });
      if (verified?.success) references = [verified.data];
    }
  }
  if (!references) unavailable("缺少可核对的原始参考图或内容指纹，无法核实原尺寸。");
  if (
    (archive &&
      (archive.ownerId !== actor.id ||
        archive.modelConfigId !== original.modelConfigId ||
        archive.modelId !== original.modelId)) ||
    original.sourceUrls.length !== references.length ||
    references.reduce((n, r) => n + r.bytes, 0) > 128 * 1024 * 1024
  )
    unavailable("原模型或输入归档无法核实，未提交重出。");
  const sources = [];
  for (const [index, ref] of references.entries()) {
    const asset = /^\/api\/assets\/([0-9a-f-]{36})\/content$/i.exec(ref.url)?.[1];
    if (!asset || !z.string().uuid().safeParse(asset).success || ref.url !== original.sourceUrls[index])
      unavailable("参考图归档顺序不一致，未提交重出。");
    const row = (
      await db.query<{ key: string; mime: string; bytes: string }>(
        `SELECT object_key AS key,mime_type AS mime,byte_size AS bytes FROM assets WHERE id=$1 AND owner_user_id=$2 AND status='ready' AND kind='image' AND deleted_at IS NULL`,
        [asset, actor.id],
      )
    ).rows[0];
    if (!row || Number(row.bytes) !== ref.bytes || row.mime !== ref.type) unavailable("原始参考图已变化或不可访问，未提交重出。");
    const bytes = await read(row.key, ref.bytes);
    if (bytes.length !== ref.bytes || digest(bytes) !== ref.sha256) unavailable("参考图内容与原任务不一致，未提交重出。");
    sources.push({ bytes, mimeType: row.mime });
  }
  const edit = await prepareImageEditInput(sources, original.parameters, {
    modelId: original.modelId,
    protocol: original.protocol,
    operationType: original.operationType,
  });
  const base = edit.references[0];
  if (!base) unavailable("缺少可核实的原输入底图。");
  const { width, height } = await inspectEditImage(base, "original").catch(() =>
    unavailable("无法可靠解码原始底图的方向或像素尺寸，未提交重出。"),
  );
  const size = `${width}x${height}`;
  const params: Record<string, unknown> = {
    ...original.parameters,
    size,
    n: 1,
    ...(archive
      ? {
          inputArchive: {
            ...archive,
            config: { ...archive.config, size, count: "1" },
            parameters: { ...archive.parameters, size, n: 1 },
          },
        }
      : {}),
  };
  const input = await prepareConfiguredQuickImageTask(db, {
    requestId: `review-size:${taskId}`,
    userId: actor.id,
    departmentId: actor.departmentId,
    priority: "normal" as const,
    creditsEnabled,
    projectId: original.projectId,
    toolKey: original.toolKey,
    modelConfigId: original.modelConfigId,
    operationType: original.operationType,
    prompt: original.prompt,
    userInput: original.userInput,
    optimized: original.optimized,
    sourceUrls: original.sourceUrls,
    parameters: params,
  });
  const execution = await resolveToolExecution(db, input);
  if (execution.modelConfigId !== original.modelConfigId || input.prompt !== original.prompt)
    unavailable("原工具的模型或提示词已变化，未提交重出。");
  if (original.parameters.quickImageAction) {
    const previous = original.parameters.quickImage as { recipeVersion?: number; configurationVersion?: number } | undefined;
    const current = input.parameters.quickImage as typeof previous;
    if (
      !previous ||
      !current ||
      previous.recipeVersion !== current.recipeVersion ||
      previous.configurationVersion !== current.configurationVersion
    )
      unavailable("原工具的处理配方已变更，未提交重出。");
  }
  input.parameters = {
    ...input.parameters,
    size,
    originalSizeReplay: {
      size,
      modelId: original.modelId,
      providerId: original.providerId,
      hashes: references.map((r) => r.sha256),
    },
  };
  let payload;
  try {
    payload = preflightApiMartImageRequest({
      modelId: original.modelId,
      prompt: input.prompt,
      parameters: input.parameters,
      sourceImages: edit.references,
      maskImage: edit.mask,
      markupImage: edit.markup,
    }).payload;
  } catch {
    unavailable(`原模型不能用现有参考图和参数按 ${size} 重出，未提交任务。`);
  }
  if (payload.size !== size) unavailable(`原模型不能按 ${size} 精确指定输出尺寸，未提交任务。`);
  const price = await loadTaskPriceSnapshot(db, {
    operationType: input.operationType,
    modelConfigId: execution.modelConfigId,
    toolConfiguration: execution,
    quantity: 1,
    creditsEnabled,
  });
  const quote = {
    taskId,
    width,
    height,
    modelName: original.modelName,
    credits: price.totalCredits,
    estimatedRmb: price.totalRmb,
  };
  const confirmation = digest(
    JSON.stringify([quote, execution.configurationVersion, original.modelConfigId, original.prompt, input.parameters, price]),
  );
  return { quote: { ...quote, confirmation }, input: { ...input, priceSnapshot: price, originalSizeSourceId: taskId } };
}
