import { createHash } from "node:crypto";
import { MIMEType } from "node:util";
import { z } from "zod";

const timestamp = z.string().datetime({ offset: true });
const taskStatuses = new Set(["processing", "success", "failed", "paused"]);

/** One-time, explicitly supplied snapshot of a stopped/quiescent legacy demo process. */
export function readDemoRecovery(snapshot: unknown) {
  const data = objectRecord(snapshot, "本地恢复文件");
  if (!Array.isArray(data.assets) || !Array.isArray(data.tasks)) throw new Error("本地恢复文件的 assets 和 tasks 必须为数组");
  const assetIds = new Set<string>();
  const taskIds = new Set<string>();
  const requestIds = new Set<string>();

  const assets = data.assets.map((value): Record<string, unknown> & { bytes: Uint8Array } => {
    const asset = objectRecord(value, "素材记录");
    const id = uniqueId(asset.id, assetIds, "素材 ID");
    if (!nonemptyString(asset.ownerUserId) || !nonemptyString(asset.filename) || !validMimeType(asset.mimeType) || !timestamp.safeParse(asset.createdAt).success) {
      throw new Error(`本地恢复文件的素材「${id}」所有者、文件名、类型或创建时间无效`);
    }
    if (asset.base64 === "") throw new Error(`本地恢复文件包含空素材「${id}」`);
    if (typeof asset.base64 !== "string") throw new Error(`素材「${id}」缺少有效的 base64 原始字节`);
    const decoded = Buffer.from(asset.base64, "base64");
    if (!decoded.byteLength) throw new Error(`本地恢复文件包含空素材「${id}」`);
    // Buffer's decoder is permissive; round-tripping also rejects whitespace, missing padding and noncanonical padding bits.
    if (decoded.toString("base64") !== asset.base64) throw new Error(`素材「${id}」的 base64 编码不规范或已损坏`);
    if (asset.byteSize !== undefined && (!Number.isSafeInteger(asset.byteSize) || asset.byteSize !== decoded.byteLength)) {
      throw new Error(`素材「${id}」的 byteSize 与原始字节长度不一致`);
    }
    if (asset.sha256 !== undefined) {
      if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(asset.sha256) || createHash("sha256").update(decoded).digest("hex") !== asset.sha256.toLowerCase()) {
        throw new Error(`素材「${id}」的 SHA-256 校验失败`);
      }
    }
    const { base64: _base64, ...fields } = asset;
    return { ...fields, bytes: new Uint8Array(decoded) };
  });

  const tasks = data.tasks.map((value) => {
    const task = objectRecord(value, "任务记录");
    const id = uniqueId(task.id, taskIds, "任务 ID");
    uniqueId(task.requestId, requestIds, "任务 requestId");
    if (!nonemptyString(task.ownerUserId) || !timestamp.safeParse(task.createdAt).success || typeof task.status !== "string" || !taskStatuses.has(task.status) || !Array.isArray(task.resultUrls) || !task.resultUrls.every((url) => typeof url === "string")) {
      throw new Error(`本地恢复文件的任务「${id}」所有者、状态、创建时间或结果地址无效`);
    }
    if (task.status === "processing") throw new Error("尚有执行中的任务，请等待结束后重新导出恢复文件");
    return task;
  });
  return { assets, tasks };
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须为有效对象`);
  return value as Record<string, unknown>;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueId(value: unknown, used: Set<string>, label: string): string {
  if (!nonemptyString(value)) throw new Error(`${label}必须为非空字符串`);
  if (used.has(value)) throw new Error(`本地恢复文件包含重复的${label}「${value}」`);
  used.add(value);
  return value;
}

function validMimeType(value: unknown): value is string {
  if (!nonemptyString(value)) return false;
  try { new MIMEType(value); return true; }
  catch { return false; }
}
