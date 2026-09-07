/** Optional local recovery file used when replacing an in-memory demo process. */
export function readDemoRecovery(snapshot: { assets?: unknown[]; tasks?: unknown[] }) {
  const assets = (snapshot.assets || []).map((value) => {
    const asset = value as Record<string, unknown>;
    if (typeof asset.id !== "string" || typeof asset.ownerUserId !== "string" || typeof asset.mimeType !== "string" || typeof asset.base64 !== "string") throw new Error("本地恢复文件的素材记录无效");
    const { base64, ...fields } = asset;
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));
    if (!bytes.byteLength) throw new Error("本地恢复文件包含空素材");
    return { ...fields, bytes };
  });
  const tasks = (snapshot.tasks || []).map((value) => {
    const task = value as Record<string, unknown>;
    if (typeof task.id !== "string" || typeof task.ownerUserId !== "string") throw new Error("本地恢复文件的任务记录无效");
    if (task.status === "processing") throw new Error("尚有执行中的任务，请等待结束后重新导出恢复文件");
    return task;
  });
  return { assets, tasks };
}
