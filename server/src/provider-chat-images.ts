import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Cache, Database } from "./db";
import { validateAssetUpload } from "./asset-delivery";
import { probeMediaBytes } from "./media-probe";
import { normalizeProviderImageOrigin, ProviderImageAccessError, PROVIDER_IMAGE_PATH } from "./provider-image-access";
import { PromptOptimizationError } from "./prompt-safety";
import type { ChatCompletionInput } from "./routes/chat";

const ttlSeconds = 240; // Covers the single 180s request, never a conversation lifetime.
const maxImageBytes = 4 * 1024 * 1024;
const maxRequestBytes = 12 * 1024 * 1024;
const tokenPattern = /^[a-f0-9]{64}$/;
const key = (token: string) => `provider-chat-images:${token}`;
const previewSchema = z.object({ mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  base64: z.string().min(1).max(Math.ceil(maxImageBytes / 3) * 4), sha256: z.string().regex(/^[a-f0-9]{64}$/), length: z.number().int().positive().max(maxImageBytes) });
const grantSchema = z.object({ userId: z.string().uuid(), expiresAt: z.number().int().positive(), images: z.array(previewSchema).min(1).max(32) });

export function supportsProviderChatImages(model: { protocol: string; model_id: string }) {
  return ["openai", "custom", "openai-chat"].includes(model.protocol)
    || model.protocol === "apimart" && model.model_id !== "claude-sonnet-5-5";
}

/** Exposes only the exact submitted preview bytes, not arbitrary employee assets.
 * The server owns each random request subject; clients cannot issue or extend it.
 * No durable asset, public bucket, supplier upload or image regeneration is used.
 */
export class ProviderChatImageAccess {
  private origin: string;
  constructor(private db: Pick<Database, "query">, private cache: Pick<Cache, "get" | "set" | "del">, origin?: string) {
    this.origin = normalizeProviderImageOrigin(origin);
  }

  private async activeUser(userId: string) {
    if (!z.string().uuid().safeParse(userId).success) throw new ProviderImageAccessError(404);
    const result = await this.db.query("SELECT id FROM users WHERE id=$1 AND status='active' AND deleted_at IS NULL", [userId])
      .catch(() => { throw new ProviderImageAccessError(503); });
    if (!result.rows.length) throw new ProviderImageAccessError(404);
  }

  async run<T>(userId: string, input: ChatCompletionInput, invoke: (input: ChatCompletionInput) => Promise<T>): Promise<T> {
    const parts = input.input.flatMap(item => "role" in item && Array.isArray(item.content) ? item.content.filter(part => part.type === "input_image") : []);
    if (!parts.length) return invoke(input);
    if (!this.origin) throw new PromptOptimizationError("PROVIDER_IMAGE_ORIGIN_REQUIRED", "服务端未配置参考图片访问域名，尚未发送识图请求。", 503);
    if (parts.length > 32) throw new PromptOptimizationError("CHAT_REFERENCE_LIMIT", "单次识图预览不能超过 32 张。", 400);
    const images: z.infer<typeof previewSchema>[] = [];
    let total = 0;
    // Validate all images before creating any remotely readable request.
    for (const part of parts) {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url);
      if (!match || match[2]!.length > Math.ceil(maxImageBytes / 3) * 4) throw new PromptOptimizationError("CHAT_REFERENCE_INVALID", "识图仅接受当前请求中有效的图片预览，请重新选择图片。", 400);
      const bytes = Buffer.from(match[2]!, "base64");
      total += bytes.length;
      if (!bytes.length || bytes.length > maxImageBytes || total > maxRequestBytes || bytes.toString("base64") !== match[2]) throw new PromptOptimizationError("CHAT_REFERENCE_INVALID", "识图预览无效或超过大小限制，未发送模型请求。", 400);
      try {
        const mime = await validateAssetUpload(bytes, match[1]!);
        if (mime !== match[1]) throw new Error();
        const meta = await probeMediaBytes(bytes, mime);
        if (!meta.width || !meta.height || meta.width > 8192 || meta.height > 8192 || meta.width * meta.height > 18_000_000) throw new Error();
      } catch { throw new PromptOptimizationError("CHAT_REFERENCE_INVALID", "识图预览不是可读取的图片或超出尺寸限制，未发送模型请求。", 400); }
      images.push(previewSchema.parse({ mime: match[1], base64: match[2], sha256: createHash("sha256").update(bytes).digest("hex"), length: bytes.length }));
    }
    await this.activeUser(userId);
    const token = randomBytes(32).toString("hex");
    const grant = grantSchema.parse({ userId, expiresAt: Date.now() + ttlSeconds * 1000, images });
    try { await this.cache.set(key(token), JSON.stringify(grant), { EX: ttlSeconds }); }
    catch { throw new PromptOptimizationError("PROVIDER_IMAGE_UNAVAILABLE", "参考图片临时授权未建立，尚未发送模型请求。", 503); }
    let index = 0;
    const prepared: ChatCompletionInput = { ...input, input: input.input.map(item => "role" in item && Array.isArray(item.content)
      ? { ...item, content: item.content.map(part => part.type === "input_image" ? { ...part, image_url: `${this.origin}${PROVIDER_IMAGE_PATH}/${token}/preview/${index++}` } : part) } : item) };
    try { return await invoke(prepared); }
    finally {
      // Redis outages make reads fail closed. An unconfirmed cleanup still has
      // the independent short TTL, and never causes a second provider request.
      await this.cache.del(key(token)).catch(() => undefined);
    }
  }

  async resolve(token: string, index: string) {
    if (!this.origin || !tokenPattern.test(token) || !/^(?:0|[1-9]\d?)$/.test(index)) throw new ProviderImageAccessError(404);
    const raw = await this.cache.get(key(token)).catch(() => { throw new ProviderImageAccessError(503); });
    let grant: z.infer<typeof grantSchema>;
    try { grant = grantSchema.parse(JSON.parse(raw || "null")); } catch { throw new ProviderImageAccessError(404); }
    const preview = grant.images[Number(index)];
    if (grant.expiresAt <= Date.now() || !preview) throw new ProviderImageAccessError(404);
    await this.activeUser(grant.userId);
    // Re-read just before delivery so completion during the DB check closes access.
    if (await this.cache.get(key(token)).catch(() => { throw new ProviderImageAccessError(503); }) !== raw) throw new ProviderImageAccessError(404);
    const bytes = Buffer.from(preview.base64, "base64");
    if (bytes.length !== preview.length || createHash("sha256").update(bytes).digest("hex") !== preview.sha256) throw new ProviderImageAccessError(404);
    return { bytes, mime: preview.mime, sha256: preview.sha256 };
  }
}

export function createProviderChatImagesRouter(access: ProviderChatImageAccess) {
  const router = Router();
  router.get("/:token/preview/:index", async (request, response) => {
    response.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    try {
      const { token, index } = request.params;
      if (typeof token !== "string" || typeof index !== "string") throw new ProviderImageAccessError(404);
      const preview = await access.resolve(token, index);
      response.set({ "Content-Type": preview.mime, "Content-Length": String(preview.bytes.length), "Content-Disposition": "inline; filename=preview", ETag: `"${preview.sha256}"` });
      response.status(200).end(request.method === "HEAD" ? undefined : preview.bytes);
    } catch (error) { response.status(error instanceof ProviderImageAccessError ? error.status : 503).end(); }
  });
  return router;
}
