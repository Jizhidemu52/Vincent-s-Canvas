import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import type { Database } from "./db";
import type { AppConfig } from "./config";
import type { SessionUser } from "./types";
import { ObjectStorage } from "./object-storage";
import { accessClause } from "./routes/assets";
import { requestChatCompletion, CHAT_COMPLETION_PROTOCOLS } from "./routes/chat";
import { resolveToolExecution } from "./tool-configuration";
import { decryptSecret } from "./security";
import { createAssetThumbnailBytes } from "./asset-thumbnails";
import { PromptCompiler, type PromptActor, type PromptCompilerRuntime, type PromptSource } from "./prompt-compiler";
import { PromptOptimizationError } from "./prompt-safety";
import { postgresPromptRecipeStore } from "./prompt-recipe-postgres";
import { promptHash } from "./prompt-recipe-store";

export async function promptSourceFromBytes(bytes: Uint8Array, declaredMime: string): Promise<PromptSource> {
  if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw new PromptOptimizationError("PROMPT_REFERENCE_INVALID", "优化参考图必须小于 50 MiB");
  const actual = await fileTypeFromBuffer(bytes);
  if (!actual || !["image/png", "image/jpeg", "image/webp"].includes(actual.mime) || actual.mime !== declaredMime) throw new PromptOptimizationError("PROMPT_REFERENCE_INVALID", "优化参考图格式无效，请重新上传 PNG、JPEG 或 WebP");
  const preview = (await createAssetThumbnailBytes(bytes, [1024]))[1024];
  if (preview.length > 1.5 * 1024 * 1024) throw new PromptOptimizationError("PROMPT_REFERENCE_INVALID", "优化参考图预览过大，请减少图片复杂度");
  return { bytes, mimeType: actual.mime, previewDataUrl: `data:image/webp;base64,${preview.toString("base64")}` };
}

export function createPostgresPromptCompiler(db: Database, config: AppConfig, storage = new ObjectStorage(config)) {
  const store = postgresPromptRecipeStore(db);
  const runtime: PromptCompilerRuntime = {
    resolveTarget: async (actor, request, options) => {
      const operationType = request.promptInput.scene === "batch-optimize" ? "batch_image" : request.promptInput.mode === "generate" ? "image_generation" : "inpaint";
      const execution = await resolveToolExecution(db, { operationType, toolKey: request.toolKey, modelConfigId: request.modelConfigId }, { allowModelOverride: actor.role === "super_admin" && options?.adminTest === true });
      const row = (await db.query<{ id: string; modelId: string; protocol: string; providerId: string; updatedAt: string; workflowConfigId: string | null; providerUpdatedAt: string }>(
        `SELECT m.id,m.model_id AS "modelId",p.protocol,p.id AS "providerId",m.updated_at::text AS "updatedAt",p.updated_at::text AS "providerUpdatedAt",m.workflow_config_id AS "workflowConfigId"
         FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1`, [execution.modelConfigId])).rows[0]!;
      return { ...row, fingerprint: promptHash({ ...row, configurationVersion: execution.configurationVersion }) };
    },
    resolveOptimizer: async id => {
      const row = (await db.query<{ id: string; model_id: string; base_url: string; protocol: string; encrypted_credentials: string | null; rmbCost: number; updatedAt: string; providerUpdatedAt: string }>(
        `SELECT m.id,m.model_id,p.base_url,p.protocol,p.encrypted_credentials,m.rmb_cost::float8 AS "rmbCost",m.updated_at::text AS "updatedAt",p.updated_at::text AS "providerUpdatedAt"
         FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.id::text=$1 AND m.enabled=true AND p.enabled=true AND 'chat'=ANY(m.capabilities)`, [id])).rows[0];
      if (!row || !(CHAT_COMPLETION_PROTOCOLS as readonly string[]).includes(row.protocol)) throw new PromptOptimizationError("PROMPT_MODEL_UNAVAILABLE", "配方绑定的扩写模型不可用，未提交生成", 503);
      if (!row.encrypted_credentials || !config.PROVIDER_ENCRYPTION_KEY) throw new PromptOptimizationError("PROMPT_MODEL_NOT_CONFIGURED", "扩写模型的服务端凭据未配置，未提交生成", 503);
      const credentials = JSON.parse(decryptSecret(row.encrypted_credentials, config.PROVIDER_ENCRYPTION_KEY)) as Record<string, string>;
      return { id: row.id, modelId: row.model_id, fingerprint: promptHash({ id: row.id, modelId: row.model_id, protocol: row.protocol, baseUrl: row.base_url, updatedAt: row.updatedAt, providerUpdatedAt: row.providerUpdatedAt }), estimatedRmbCost: row.rmbCost > 0 ? row.rmbCost : null,
        invoke: (system, content) => requestChatCompletion(row, credentials, { privateProfile: true, input: [{ role: "system", content: system }, { role: "user", content }], tools: [], claude: { thinking: false, stream: false, maxTokens: 4096 }, gemini: { maxOutputTokens: 4096 } }),
      };
    },
    readSource: async (actor: PromptActor, url) => {
      const id = url.match(/^\/api\/assets\/([0-9a-f-]{36})\/content$/i)?.[1];
      if (!id) throw new PromptOptimizationError("PROMPT_REFERENCE_INVALID", "优化仅接受当前站点中有权访问的参考素材");
      const access = accessClause(actor as SessionUser);
      const row = (await db.query<{ objectKey: string; mimeType: string; byteSize: number }>(
        `SELECT a.object_key AS "objectKey",a.mime_type AS "mimeType",a.byte_size AS "byteSize" FROM assets a
         WHERE (${access.sql}) AND a.id=$${access.values.length + 1} AND a.status='ready' AND a.deleted_at IS NULL AND a.kind='image'`, [...access.values, id])).rows[0];
      if (!row || Number(row.byteSize) > 50 * 1024 * 1024) throw new PromptOptimizationError("PROMPT_REFERENCE_FORBIDDEN", "参考图不存在、超出大小限制或无权访问", 403);
      const object = await storage.get(row.objectKey);
      if (!object.Body) throw new PromptOptimizationError("PROMPT_REFERENCE_INVALID", "无法读取参考图");
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of object.Body.transformToWebStream()) {
        length += chunk.byteLength;
        if (length > 50 * 1024 * 1024) throw new PromptOptimizationError("PROMPT_REFERENCE_INVALID", "参考图内容超过 50 MiB");
        chunks.push(chunk);
      }
      return promptSourceFromBytes(Buffer.concat(chunks), row.mimeType);
    },
  };
  return new PromptCompiler(store, runtime);
}

/** Stable non-secret model identity for the SQLite runtime's configured models. */
export function promptRuntimeModelFingerprint(model: Record<string, unknown>, provider: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify({ id: model.id, modelId: model.modelId, enabled: model.enabled, protocol: provider.protocol, baseUrl: provider.baseUrl, providerId: provider.id, providerEnabled: provider.enabled })).digest("hex");
}
