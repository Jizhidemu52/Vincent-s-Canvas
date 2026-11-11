import type { Database } from "./db";
import type { ObjectStorage } from "./object-storage";
import type { LayerStudioResultDocument } from "../../shared/layer-studio";
import { assertSeedream55ManifestLimit, type Seedream55Manifest } from "./seedream55-image";
import { downloadLayerOriginal, hashLayerOriginal, persistLayerOriginals } from "./seedream55-storage";
import { readBoundedImage } from "./seedream55-reference";
import { readSourceAssetObject } from "./asset-object-error";
import { TaskExecutionLost } from "./model-concurrency";
import { randomUUID } from "node:crypto";
import { recordAssetEvent } from "./asset-events";
import { scheduleAssetThumbnails } from "./asset-thumbnails";

type Task = { id: string; user_id: string; department_id: string | null; project_id: string; model_config_id: string | null; prompt: string; execution_token: string; parameters: Record<string, unknown> };
type StoredOriginal = { id: string; mime_type: string; byte_size: number; content_sha256: string; metadata: { layerStudio?: { index: number; width: number; height: number; sha256: string } } };

export async function storeSeedream55TaskResults(db: Database, storage: ObjectStorage, task: Task, manifest: Seedream55Manifest, document?: LayerStudioResultDocument | null, runtime: { download?: typeof downloadLayerOriginal } = {}) {
  assertSeedream55ManifestLimit(manifest, task.parameters);
  if (!storage.configured) throw new Error("公司对象存储尚未配置，不能保存图层原件");
  const key = (index: number) => `users/${task.user_id}/generated/${task.id}/layer-${index}.original`;
  const assertOwned = async () => {
    const result = await db.query("SELECT id FROM tasks WHERE id=$1 AND user_id=$2 AND execution_token=$3 AND status='processing' AND lease_expires_at>now()", [task.id, task.user_id, task.execution_token]);
    if (!result.rows.length) throw new TaskExecutionLost("图层任务执行权已改变");
  };
  const result = await persistLayerOriginals({
    taskId: task.id, manifest, document,
    findSaved: async index => {
      await assertOwned();
      const found = (await db.query<StoredOriginal>(`SELECT id,mime_type,byte_size::int,content_sha256,metadata FROM assets
        WHERE object_key=$1 AND owner_user_id=$2 AND task_id=$3 AND status='ready' AND deleted_at IS NULL`, [key(index), task.user_id, task.id])).rows[0];
      if (!found) return null;
      const metadata = found.metadata.layerStudio;
      if (!metadata || metadata.index !== index || !found.content_sha256 || metadata.sha256 !== found.content_sha256) throw new Error("已保存图层缺少可核对的原件记录");
      const object = await readSourceAssetObject(storage, key(index));
      const bytes = await readBoundedImage(object.Body!.transformToWebStream(), 64 * 1024 * 1024, found.byte_size);
      if (hashLayerOriginal(bytes) !== found.content_sha256) throw new Error("已保存图层 hash 不一致，拒绝复用");
      await recordAssetEvent(db, { assetId: found.id, actor: null, eventType: "asset.generated", idempotencyKey: `task:${task.id}:asset:${found.id}:generated`, metadata: { resultIndex: index, operationType: "image_generation" } });
      return { assetId: found.id, contentUrl: `/api/assets/${found.id}/content`, bytes, mimeType: found.mime_type, sha256: found.content_sha256, width: metadata.width, height: metadata.height };
    },
    download: runtime.download ?? downloadLayerOriginal,
    save: async (index, original, item) => {
      await assertOwned();
      try { await storage.put(key(index), original.bytes, original.mimeType, { ifNoneMatch: "*" }); }
      catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status !== 412 && (error as { name?: string }).name !== "PreconditionFailed") throw error;
        // A crash after S3 PUT but before SQL insert must reuse identical bytes,
        // never overwrite a pre-existing object with a later provider download.
        const existing = await readSourceAssetObject(storage, key(index));
        const bytes = await readBoundedImage(existing.Body!.transformToWebStream(), 64 * 1024 * 1024, original.bytes.length);
        if (hashLayerOriginal(bytes) !== original.sha256) throw new Error("同任务图层原件已存在但 hash 不一致，拒绝覆盖");
      }
      const id = randomUUID();
      const metadata = { layerStudio: { ...item, width: original.width, height: original.height, sha256: original.sha256 }, originalPreserved: true };
      const inserted = await db.query<{ id: string }>(`INSERT INTO assets(id,owner_user_id,department_id,project_external_id,task_id,object_key,filename,mime_type,byte_size,kind,source,operation_type,prompt,model_config_id,status,content_sha256,metadata)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,'image','generation','image_generation',$10,$11,'ready',$12,$13::jsonb
        FROM tasks WHERE id=$5 AND user_id=$2 AND execution_token=$14 AND status='processing' AND lease_expires_at>now()
        ON CONFLICT(object_key) DO NOTHING RETURNING id`,
        [id, task.user_id, task.department_id, task.project_id, task.id, key(index), `layer-${index + 1}.${original.mimeType === "image/jpeg" ? "jpg" : "png"}`, original.mimeType, original.bytes.length, task.prompt, task.model_config_id, original.sha256, JSON.stringify(metadata), task.execution_token]);
      if (!inserted.rows.length) throw new TaskExecutionLost("图层原件记录未写入；保留已保存原件等待恢复核对");
      await recordAssetEvent(db, { assetId: id, actor: null, eventType: "asset.generated", idempotencyKey: `task:${task.id}:asset:${id}:generated`, metadata: { resultIndex: index, operationType: "image_generation" } });
      scheduleAssetThumbnails(db, storage, id);
      return { assetId: id, contentUrl: `/api/assets/${id}/content` };
    },
    checkpoint: async current => {
      const urls = current.items.filter(item => item.state === "saved").map(item => item.contentUrl!);
      const updated = await db.query(`UPDATE tasks SET result_document=$1::jsonb,result_urls=$2::jsonb,updated_at=now()
        WHERE id=$3 AND user_id=$4 AND execution_token=$5 AND status='processing' AND lease_expires_at>now() RETURNING id`, [JSON.stringify(current), JSON.stringify(urls), task.id, task.user_id, task.execution_token]);
      if (!updated.rows.length) throw new TaskExecutionLost("图层保存进度写入权已改变");
    },
  });
  return result;
}
