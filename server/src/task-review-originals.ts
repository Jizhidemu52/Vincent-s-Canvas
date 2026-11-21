import type { Database } from "./db";
import { isReviewValidationFailure } from "../../shared/task-repair";
import { imageResultExtension } from "./image-result-storage";

type ReviewRow = {
  task_id: string; user_id: string; repair_error_code: string | null;
  asset_id: string | null; object_key: string | null; mime_type: string | null; byte_size: string | null;
};

export async function readTaskReviewOriginals(db: Pick<Database, "query">, ownerId: string, taskId: string) {
  const { rows } = await db.query<ReviewRow>(`SELECT t.id AS task_id,t.user_id,t.repair_error_code,
    a.id AS asset_id,a.object_key,a.mime_type,a.byte_size FROM tasks t
    LEFT JOIN assets a ON a.task_id=t.id AND a.owner_user_id=t.user_id AND a.deleted_at IS NULL
      AND a.status='ready' AND a.kind='image' AND a.source IN ('generation','edit') AND a.byte_size>0
      AND a.mime_type IN ('image/png','image/jpeg','image/webp','image/gif')
    WHERE t.id=$1 AND t.user_id=$2 AND t.status='paused' AND t.paused_kind='needs_review'`, [taskId, ownerId]);
  if (!rows.length) return null;
  const originals = rows.flatMap(row => {
    if (!row.asset_id || !row.object_key || !row.mime_type) return [];
    const prefix = `users/${row.user_id}/generated/${row.task_id}/task-${row.task_id}-`;
    if (!row.object_key.startsWith(prefix)) return [];
    const match = /^([1-9]\d*)-provider-original\.(png|jpg|webp|gif)$/.exec(row.object_key.slice(prefix.length));
    const bytes = Number(row.byte_size);
    if (!match || match[2] !== imageResultExtension(row.mime_type) || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(bytes) || bytes <= 0) return [];
    return [{ assetId: row.asset_id, resultIndex: Number(match[1]) - 1, mimeType: row.mime_type, bytes,
      filename: `task-${row.task_id}-${match[1]}-provider-original.${match[2]}` }];
  }).sort((a, b) => a.resultIndex - b.resultIndex || a.assetId.localeCompare(b.assetId));
  return { taskId, originals, ...(isReviewValidationFailure(rows[0]?.repair_error_code) ? {canCheckOriginalSize:true} : {}) };
}
