import type { Database } from "./db";

export const moduleKeys = [
  "detail-enhance", "image-edit", "angle-control", "seamless-stitch", "image",
  "video", "prompts", "assets", "gpt-chat", "canvas", "team",
] as const;
export type ModuleKey = (typeof moduleKeys)[number];

export function moduleForOperation(operationType: string, parameters: Record<string, unknown> = {}): ModuleKey | null {
  if (operationType === "image_generation") return "image";
  if (operationType === "upscale") return "detail-enhance";
  if (operationType === "seamless_stitch") return "seamless-stitch";
  if (operationType === "video_generation" || operationType === "audio_generation") return "video";
  if (operationType === "batch_image") return "canvas";
  if (operationType === "inpaint") return parameters.tool === "angle-control" ? "angle-control" : "image-edit";
  return null;
}

export async function isModuleEnabled(db: Database, key: ModuleKey) {
  const result = await db.query<{ enabled: boolean }>("SELECT enabled FROM module_flags WHERE module_key=$1", [key]);
  return result.rows[0]?.enabled === true;
}

export class ModuleDisabledError extends Error {
  readonly code = "MODULE_DISABLED";
  readonly status = 403;
  constructor(public readonly moduleKey: ModuleKey) { super("该功能模块已由超级管理员关闭"); }
}

export async function assertModuleEnabled(db: Database, key: ModuleKey | null) {
  if (key && !(await isModuleEnabled(db, key))) throw new ModuleDisabledError(key);
}
